// Module 6 — AI pipeline orchestrator.
// Coordinates: validate → status → upload → profile → transcribe → vision →
// generate report → persist → broadcast, with failure handling throughout.
import { supabaseAdmin } from '../../config/supabase.js';
import { getIO } from '../../socket/socket.server.js';
import { EVENTS, ROOMS } from '../../socket/socket.events.js';
import logger from '../../middleware/logger.js';

import whisperService from './whisper.service.js';
import gptService from './gpt.service.js';
import pdfService from '../pdf.service.js';
import * as fileUtils from '../../utils/file.utils.js';

export async function processAIReport(caseId, patientId, inputs) {
  const {
    voiceNoteBuffer = null,
    voiceNoteMimeType = null,
    userText = null,
    imageBuffers = [],
    inputLanguage = 'auto',
  } = inputs || {};

  // STEP 1 — validate: at least one input.
  if (!voiceNoteBuffer && !userText && (!imageBuffers || imageBuffers.length === 0)) {
    throw new Error('At least one input required');
  }

  const io = (() => {
    try {
      return getIO();
    } catch {
      return null;
    }
  })();
  const emit = (room, event, payload) => {
    try {
      io?.to(room).emit(event, payload);
    } catch {
      /* socket optional */
    }
  };

  // STEP 2 — mark processing.
  await supabaseAdmin
    .from('ai_reports')
    .upsert(
      { case_id: caseId, patient_id: patientId, generation_status: 'processing' },
      { onConflict: 'case_id' },
    );
  emit(ROOMS.caseRoom(caseId), 'ai:processing', { caseId });

  try {
    // STEP 3 — upload media in parallel.
    const uploadPromises = [];
    let voiceIndex = -1;
    if (voiceNoteBuffer) {
      voiceIndex = uploadPromises.length;
      uploadPromises.push(
        fileUtils.uploadToSupabaseStorage(
          voiceNoteBuffer,
          `voice${fileUtils.getExtFromMime(voiceNoteMimeType)}`,
          voiceNoteMimeType,
          `cases/${caseId}/voice`,
        ),
      );
    }
    const imageStart = uploadPromises.length;
    imageBuffers.forEach((img, i) => {
      uploadPromises.push(
        fileUtils.uploadToSupabaseStorage(
          img.buffer,
          `image-${i}${fileUtils.getExtFromMime(img.mimeType)}`,
          img.mimeType,
          `cases/${caseId}/images`,
        ),
      );
    });

    const uploadResults = await Promise.allSettled(uploadPromises);
    uploadResults.forEach((r, i) => {
      if (r.status === 'rejected') logger.warn(`Upload ${i} failed: ${r.reason?.message}`);
    });
    const voiceNoteUrl =
      voiceIndex >= 0 && uploadResults[voiceIndex]?.status === 'fulfilled'
        ? uploadResults[voiceIndex].value.signedUrl
        : null;
    const imageUrls = uploadResults
      .slice(imageStart)
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value.signedUrl);

    // STEP 4 — patient medical profile (optional).
    const { data: medicalProfile } = await supabaseAdmin
      .from('medical_profiles')
      .select('*')
      .eq('user_id', patientId)
      .maybeSingle();

    // STEP 5 — transcribe voice note.
    let transcribedText = null;
    let detectedLanguage = inputLanguage === 'auto' ? null : inputLanguage;
    if (voiceNoteBuffer) {
      const transcription = await whisperService.transcribeWithRetry(
        voiceNoteBuffer,
        voiceNoteMimeType,
      );
      transcribedText = transcription.text;
      detectedLanguage = transcription.detectedLanguage || detectedLanguage || 'en';
      logger.info(`Transcribed ${transcription.duration}s audio in ${detectedLanguage}`);
    }

    // STEP 6 — analyze images (parallel, fault-tolerant).
    let imageDescriptions = [];
    if (imageBuffers.length > 0) {
      const results = await Promise.allSettled(
        imageBuffers.map((img) => gptService.analyzeImage(img.buffer, img.mimeType)),
      );
      imageDescriptions = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    }

    // STEP 7 — generate report.
    const startTime = Date.now();
    const reportData = await gptService.generateReportWithRetry({
      transcribedText,
      userText,
      imageDescriptions,
      medicalProfile,
      detectedLanguage: detectedLanguage || 'en',
    });
    const totalTimeMs = Date.now() - startTime;
    logger.info(`AI report generated in ${totalTimeMs}ms for case ${caseId}`);

    // STEP 8 — persist.
    const { data: savedReport, error: saveError } = await supabaseAdmin
      .from('ai_reports')
      .upsert(
        {
          case_id: caseId,
          patient_id: patientId,
          voice_note_url: voiceNoteUrl || null,
          input_text: userText || null,
          image_urls: imageUrls,
          input_language: detectedLanguage || 'en',
          transcribed_text: transcribedText,
          urgency_level: reportData.urgency_level,
          emergency_type: reportData.emergency_type,
          consciousness_state: reportData.consciousness_state,
          key_observations: reportData.key_observations,
          first_aid_suggestion: reportData.first_aid_suggestion,
          possible_conditions: reportData.possible_conditions,
          // Saved here rather than in the PDF step below: the resource matcher
          // reads this column, so it must persist even if PDF generation fails.
          resources_needed: reportData.resources_needed,
          raw_gpt_response: reportData.rawGptResponse,
          medical_profile_snapshot: medicalProfile || null,
          generation_status: 'completed',
          generation_time_ms: totalTimeMs,
          sent_to_hospital_at: new Date().toISOString(),
        },
        { onConflict: 'case_id' },
      )
      .select()
      .single();
    if (saveError) throw new Error(`Saving report failed: ${saveError.message}`);

    // Plain column list: an embedded join here (patient:users(...)) makes the
    // whole update+select return null, which silently emptied the PDF header
    // and skipped the hospital broadcast below.
    const { data: caseRow, error: caseUpdateError } = await supabaseAdmin
      .from('emergency_cases')
      .update({
        has_ai_report: true,
        urgency_level: reportData.urgency_level,
        emergency_type: reportData.emergency_type,
      })
      .eq('id', caseId)
      .select('id, case_number, patient_address, sos_triggered_at, hospital_id')
      .single();
    if (caseUpdateError) {
      logger.error(`Case update after report failed for ${caseId}: ${caseUpdateError.message}`);
    }

    // The patient's name for the PDF header, fetched separately.
    const { data: patientUser } = await supabaseAdmin
      .from('users')
      .select('full_name')
      .eq('id', patientId)
      .maybeSingle();

    // STEP 8b — generate the PDF report and attach it to the saved row.
    // Best-effort: the JSON report is what the system runs on, the PDF is an
    // enhancement for the hospital, so a failure here must never fail the case.
    let pdfResult = null;
    try {
      const caseWithPatient = {
        id: caseId,
        case_number: caseRow?.case_number,
        patient_name: patientUser?.full_name,
        patient_address: caseRow?.patient_address,
        sos_triggered_at: caseRow?.sos_triggered_at,
      };
      pdfResult = await pdfService.generateReportPDF(
        { ...reportData, transcribed_text: transcribedText, input_language: detectedLanguage },
        caseWithPatient,
        medicalProfile,
      );

      const { error: pdfSaveError } = await supabaseAdmin
        .from('ai_reports')
        .update({
          pdf_url: pdfResult.signedUrl,
          pdf_storage_path: pdfResult.storagePath,
        })
        .eq('case_id', caseId);
      if (pdfSaveError) throw new Error(pdfSaveError.message);
    } catch (pdfError) {
      pdfResult = null;
      logger.error(`PDF generation failed for case ${caseId}: ${pdfError.message}`);
    }

    // STEP 9 — broadcast.
    const hospitalPayload = {
      caseId,
      type: 'ai_report_ready',
      report: {
        urgencyLevel: reportData.urgency_level,
        emergencyType: reportData.emergency_type,
        consciousnessState: reportData.consciousness_state,
        keyObservations: reportData.key_observations,
        firstAidSuggestion: reportData.first_aid_suggestion,
        possibleConditions: reportData.possible_conditions,
        hospitalPreparation: reportData.hospital_preparation,
        medicationsMentioned: reportData.medications_mentioned,
        generationTimeMs: totalTimeMs,
        transcribedText,
        inputLanguage: detectedLanguage,
      },
      pdfUrl: pdfResult?.signedUrl || null,
      resourcesNeeded: reportData.resources_needed || [],
      medicalProfile: medicalProfile
        ? {
            bloodGroup: medicalProfile.blood_group,
            chronicConditions: medicalProfile.chronic_conditions,
            allergies: medicalProfile.allergies,
          }
        : null,
    };
    if (caseRow?.hospital_id) {
      emit(ROOMS.hospitalRoom(caseRow.hospital_id), EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE, hospitalPayload);
    }
    emit(ROOMS.patientRoom(patientId), 'ai:report_ready', {
      caseId,
      firstAidSuggestion: reportData.first_aid_suggestion,
      urgencyLevel: reportData.urgency_level,
      generationTimeMs: totalTimeMs,
    });

    // STEP 10 — return.
    return {
      success: true,
      reportId: savedReport.id,
      caseId,
      // The apps gate their result screen on this; without it a finished
      // report looks unfinished and the input form is shown again.
      generationStatus: 'completed',
      urgencyLevel: reportData.urgency_level,
      emergencyType: reportData.emergency_type,
      consciousnessState: reportData.consciousness_state,
      keyObservations: reportData.key_observations,
      firstAidSuggestion: reportData.first_aid_suggestion,
      possibleConditions: reportData.possible_conditions,
      hospitalPreparation: reportData.hospital_preparation,
      resourcesNeeded: reportData.resources_needed,
      pdfUrl: pdfResult?.signedUrl || null,
      generationTimeMs: totalTimeMs,
      detectedLanguage,
      transcribedText,
    };
  } catch (error) {
    // STEP 11 — failure handling.
    logger.error(`AI pipeline failed for case ${caseId}: ${error.message}`);
    await supabaseAdmin
      .from('ai_reports')
      .upsert(
        { case_id: caseId, patient_id: patientId, generation_status: 'failed', error_message: error.message },
        { onConflict: 'case_id' },
      );
    emit(ROOMS.caseRoom(caseId), 'ai:error', { caseId, error: error.message });
    throw error;
  }
}

export default { processAIReport };
