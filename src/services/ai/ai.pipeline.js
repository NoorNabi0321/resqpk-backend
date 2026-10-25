// Module 6 — AI pipeline orchestrator, in two phases.
//
// The clinical record is generated once, after the clarification questions have
// been answered or deliberately skipped, and only then delivered to the
// receiving hospital. Nothing provisional leaves this file.
//
//   Phase 1 — analyse   validate → upload → profile → transcribe → vision →
//                       compose questions → persist the analysis → ask
//   Phase 2 — generate   answers → generate record → persist → PDF → deliver
//
// Why it is split. A report written before the questions are answered is a
// document full of inferences presented as findings, and a PDF is read as a
// clinical record whether or not it carries a caveat. Holding it back until the
// answers are in costs the hospital the seconds the questions take, and buys a
// record with no version that was wrong. The skip button bounds that cost: the
// sequence can always be closed in one tap, and phase 2 runs immediately.
import { supabaseAdmin } from '../../config/supabase.js';
import { getIO } from '../../socket/socket.server.js';
import { EVENTS, ROOMS } from '../../socket/socket.events.js';
import logger from '../../middleware/logger.js';

import whisperService from './whisper.service.js';
import gptService from './gpt.service.js';
import { clarificationStateFor } from './clarification.js';
import { normaliseLanguage } from './normalise.js';
import { loadReportPdfContext, CASE_COLUMNS } from './report-pdf-context.js';
import pdfService from '../pdf.service.js';
import * as fileUtils from '../../utils/file.utils.js';

// Columns the blocking-clarification migration adds. Listed so a save can drop
// them and carry on if the SQL has not been run yet.
const CLARIFICATION_COLUMNS = [
  'confidence_score',
  'clarifications',
  'image_descriptions',
  'clarification_state',
  'clarifications_asked_at',
  'clarifications_closed_at',
];

// PostgREST's code for a column it cannot find in the schema cache.
const UNKNOWN_COLUMN = 'PGRST204';

// The analysis phase 2 needs to read back, plus the answers that drive it.
const ANALYSIS_COLUMNS = `id, case_id, patient_id, voice_note_url, input_text, image_urls,
   image_descriptions, input_language, transcribed_text, medical_profile_snapshot,
   clarifications, clarification_state, clarifications_asked_at, generation_status`;

function socketEmit(room, event, payload) {
  try {
    getIO()?.to(room).emit(event, payload);
  } catch {
    /* socket layer is optional in tests and scripts */
  }
}

/// Upserts into ai_reports, surviving a database that has not had the
/// blocking-clarification migration applied yet.
///
/// The deploy order is not ours to control — Render ships the code the moment
/// it is pushed, and the SQL is run by hand afterwards. In that window every
/// report would otherwise be lost at the insert, after the patient has already
/// spoken into the phone. So an unknown column costs the questions and nothing
/// else: the caller sees no clarifications, and generates straight away.
async function saveRow(row, caseId, { select = '*' } = {}) {
  const result = await supabaseAdmin
    .from('ai_reports')
    .upsert(row, { onConflict: 'case_id' })
    .select(select)
    .single();

  const unknownColumn =
    result.error?.code === UNKNOWN_COLUMN &&
    CLARIFICATION_COLUMNS.some((col) => result.error.message?.includes(col));
  if (!unknownColumn) return result;

  logger.error(
    `ai_reports is missing the clarification columns — saving case ${caseId} without them. `
      + `Run migrations/2026-10-25-blocking-clarification.sql. (${result.error.message})`,
  );

  const stripped = { ...row };
  for (const col of CLARIFICATION_COLUMNS) delete stripped[col];
  // 'awaiting_clarification' is added by the same migration, so a schema
  // without the columns will reject the status too.
  if (stripped.generation_status === 'awaiting_clarification') {
    stripped.generation_status = 'processing';
  }

  return supabaseAdmin
    .from('ai_reports')
    .upsert(stripped, { onConflict: 'case_id' })
    .select(select === '*' ? '*' : select)
    .single();
}

// ---------------------------------------------------------------------------
// Phase 1 — analyse the inputs and compose the questions.
// ---------------------------------------------------------------------------

/// Runs the analysis and puts the questions. Delivers nothing.
///
/// Returns `{ awaitingClarification: true, clarifications }` when there are
/// questions to put, or `{ awaitingClarification: false }` when there are none
/// and the caller should go straight to phase 2.
export async function analyseForClarification(caseId, patientId, inputs) {
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

  // STEP 2 — mark processing.
  await supabaseAdmin
    .from('ai_reports')
    .upsert(
      { case_id: caseId, patient_id: patientId, generation_status: 'processing' },
      { onConflict: 'case_id' },
    );
  socketEmit(ROOMS.caseRoom(caseId), 'ai:processing', { caseId });

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
      // The caller's choice goes to the model. It used to be collected in the
      // app and dropped here, leaving the model to guess — and Urdu and Hindi
      // are the same language to an ear, differing only in script, so it
      // guessed Hindi and wrote a live report in Devanagari.
      const chosen = inputLanguage && inputLanguage !== 'auto' ? inputLanguage : null;
      const transcription = await whisperService.transcribeWithRetry(
        voiceNoteBuffer,
        voiceNoteMimeType,
        chosen,
      );
      transcribedText = transcription.text;
      // Trust the caller's own choice over the model's guess. Failing that,
      // the model's answer is a language NAME — "urdu", "english" — and it
      // reaches for Hindi or Punjabi on Urdu speech, so it is mapped before it
      // goes near a column that takes four codes and nothing else.
      // gpt-4o-transcribe does not report a language at all, hence the
      // classifier on the text as the last resort.
      detectedLanguage = normaliseLanguage(
        chosen
          || transcription.detectedLanguage
          || (transcribedText ? await whisperService.detectLanguageFromText(transcribedText) : 'en'),
      );
      logger.info(
        `Transcribed ${transcription.duration ?? '?'}s audio `
          + `(asked for ${chosen || 'auto'}, model said "${transcription.detectedLanguage || 'nothing'}")`
          + ` → ${detectedLanguage}`,
      );
    } else {
      detectedLanguage = normaliseLanguage(detectedLanguage || 'en');
    }

    // STEP 6 — analyze images (parallel, fault-tolerant).
    let imageDescriptions = [];
    if (imageBuffers.length > 0) {
      const results = await Promise.allSettled(
        imageBuffers.map((img) => gptService.analyzeImage(img.buffer, img.mimeType)),
      );
      imageDescriptions = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    }

    // STEP 7 — compose the questions. Never throws: no questions simply means
    // the record is written from the description alone.
    const clarifications = await gptService.generateClarificationQuestions({
      transcribedText,
      userText,
      imageDescriptions,
      medicalProfile,
      detectedLanguage: detectedLanguage || 'en',
    });
    const awaiting = clarifications.length > 0;

    // STEP 8 — persist the analysis, so phase 2 does not re-transcribe or
    // re-run vision after the answers come in. No clinical fields are written
    // here: there is no record yet, and a half-filled row is exactly the
    // provisional artefact this design exists to avoid.
    const { data: saved, error: saveError } = await saveRow(
      {
        case_id: caseId,
        patient_id: patientId,
        voice_note_url: voiceNoteUrl || null,
        input_text: userText || null,
        image_urls: imageUrls,
        image_descriptions: imageDescriptions,
        input_language: detectedLanguage || 'en',
        transcribed_text: transcribedText,
        medical_profile_snapshot: medicalProfile || null,
        clarifications,
        clarification_state: awaiting ? 'awaiting' : 'none',
        clarifications_asked_at: awaiting ? new Date().toISOString() : null,
        generation_status: awaiting ? 'awaiting_clarification' : 'processing',
      },
      caseId,
    );
    if (saveError) {
      logger.error(`Saving the analysis failed for case ${caseId}: ${saveError.message}`);
      throw new Error('The report could not be started. Please try again.');
    }

    // Questions that were not stored must not be put: answering one would write
    // to a column that is not there. Reading it back off the saved row is the
    // only honest test of whether the migration has been applied.
    const stored = saved != null && 'clarifications' in saved;
    if (!awaiting || !stored) {
      if (awaiting && !stored) {
        logger.warn(`Clarifications could not be stored for case ${caseId} — generating directly.`);
      }
      // The analysis row goes back with it. Phase 2 is handed it directly
      // rather than claiming the row, because nothing put this case into
      // 'awaiting_clarification' for a claim to win.
      return { awaitingClarification: false, clarifications: [], analysis: saved };
    }

    socketEmit(ROOMS.caseRoom(caseId), 'ai:clarification_ready', {
      caseId,
      clarifications,
    });

    logger.info(`Case ${caseId} is awaiting ${clarifications.length} clarification answer(s)`);
    return {
      awaitingClarification: true,
      clarifications,
      analysis: saved,
      transcribedText,
      detectedLanguage,
    };
  } catch (error) {
    await markFailed(caseId, patientId, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — generate the record from the inputs and the answers, then deliver.
// ---------------------------------------------------------------------------

/// Claims the case for generation, so two callers cannot both start it.
///
/// Answering the last question and pressing skip can land together — the same
/// tap, a retried request, two devices on one case token. A conditional update
/// is the lock, and it has to be exactly one status wide: whoever moves the row
/// off 'awaiting_clarification' owns the generation, and the loser matches
/// nothing, gets null, and leaves it alone. Widening this to accept
/// 'processing' as well would let both callers through and bill two reports.
async function claimForGeneration(caseId) {
  const { data, error } = await supabaseAdmin
    .from('ai_reports')
    .update({ generation_status: 'processing' })
    .eq('case_id', caseId)
    .eq('generation_status', 'awaiting_clarification')
    .select(ANALYSIS_COLUMNS)
    .maybeSingle();

  if (error) {
    logger.error(`Claiming case ${caseId} for generation failed: ${error.message}`);
    return null;
  }
  return data;
}

/// Writes the clinical record from the stored analysis plus whatever answers
/// were given, renders the PDF, and delivers both to the receiving hospital.
///
/// This is the only place a record is created, and the only place anything is
/// sent to a hospital. Called when the last question is answered, when the
/// sequence is skipped, or straight after phase 1 when there were no questions.
export async function generateFinalReport(caseId, { analysis = null } = {}) {
  const row = analysis || (await claimForGeneration(caseId));
  if (!row) {
    logger.info(`Case ${caseId} is already being generated or is finished — nothing to do.`);
    return null;
  }

  const patientId = row.patient_id || null;
  const clarifications = Array.isArray(row.clarifications) ? row.clarifications : [];
  const clarificationState = clarificationStateFor(clarifications);

  try {
    // STEP 1 — generate the record. The answers go in as confirmed scene
    // observations, so the model writes them into the report rather than this
    // service patching them in afterwards.
    const startTime = Date.now();
    const reportData = await gptService.generateReportWithRetry({
      transcribedText: row.transcribed_text,
      userText: row.input_text,
      imageDescriptions: Array.isArray(row.image_descriptions) ? row.image_descriptions : [],
      medicalProfile: row.medical_profile_snapshot,
      detectedLanguage: row.input_language || 'en',
      clarifications,
    });
    const totalTimeMs = Date.now() - startTime;
    logger.info(
      `Record generated in ${totalTimeMs}ms for case ${caseId} `
        + `(${clarifications.filter((c) => c?.answer).length}/${clarifications.length} answers)`,
    );

    // STEP 2 — persist. Still 'processing': the apps and the dashboard gate
    // their result screen on the status, and the PDF is attached below.
    // Marking the report complete before its PDF exists is what made "View
    // full report" open nothing.
    const { data: savedReport, error: saveError } = await saveRow(
      {
        case_id: caseId,
        patient_id: patientId,
        urgency_level: reportData.urgency_level,
        emergency_type: reportData.emergency_type,
        consciousness_state: reportData.consciousness_state,
        key_observations: reportData.key_observations,
        first_aid_suggestion: reportData.first_aid_suggestion,
        possible_conditions: reportData.possible_conditions,
        // Saved here rather than in the PDF step below: the resource matcher
        // reads this column, so it must persist even if PDF generation fails.
        resources_needed: reportData.resources_needed,
        confidence_score: reportData.confidence_score ?? null,
        clarification_state: clarificationState,
        clarifications_closed_at: new Date().toISOString(),
        raw_gpt_response: reportData.rawGptResponse,
        generation_status: 'processing',
        generation_time_ms: totalTimeMs,
        sent_to_hospital_at: new Date().toISOString(),
      },
      caseId,
    );
    if (saveError) {
      // The detail belongs in the log, not on a phone screen. Someone standing
      // over a casualty cannot act on "violates check constraint
      // ai_reports_input_language_check".
      logger.error(`Saving report failed for case ${caseId}: ${saveError.message}`);
      throw new Error('The report could not be saved. Please try again.');
    }

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
      .select(CASE_COLUMNS)
      .single();
    if (caseUpdateError) {
      logger.error(`Case update after report failed for ${caseId}: ${caseUpdateError.message}`);
    }

    // Who is carrying them and where to — the two facts a receiving ward asks
    // for first. Header material only, so a failure here costs the driver's
    // name on a PDF, not the report.
    const pdfContext = await loadReportPdfContext(caseId, patientId, caseRow).catch((err) => {
      logger.error(`PDF context lookup failed for case ${caseId}: ${err.message}`);
      return null;
    });

    // STEP 3 — render the PDF. The only one this case will ever have.
    //
    // Best-effort: the JSON report is what the system runs on, the PDF is an
    // enhancement for the hospital, so a failure here must never fail the case.
    let pdfResult = null;
    try {
      pdfResult = await pdfService.generateReportPDF(
        {
          ...reportData,
          transcribed_text: row.transcribed_text,
          input_text: row.input_text,
          input_language: row.input_language,
          clarifications,
        },
        pdfContext?.caseData || { id: caseId },
        row.medical_profile_snapshot || null,
        await fetchScenePhoto(row),
      );
    } catch (pdfError) {
      pdfResult = null;
      logger.error(`PDF generation failed for case ${caseId}: ${pdfError.message}`);
    }

    // Completed means finished: the PDF is attached, or it definitively failed
    // and there will not be one. Either way the status and the URL land in a
    // single write, so a client that sees 'completed' sees the final answer.
    const { error: finaliseError } = await supabaseAdmin
      .from('ai_reports')
      .update({
        generation_status: 'completed',
        pdf_url: pdfResult?.signedUrl || null,
        pdf_storage_path: pdfResult?.storagePath || null,
      })
      .eq('case_id', caseId);
    if (finaliseError) {
      logger.error(`Finalising report failed for case ${caseId}: ${finaliseError.message}`);
    }

    // STEP 4 — deliver. One record, one broadcast, nothing to revise.
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
        transcribedText: row.transcribed_text,
        inputLanguage: row.input_language,
        confidenceScore: reportData.confidence_score ?? null,
        clarificationState,
        clarifications,
      },
      pdfUrl: pdfResult?.signedUrl || null,
      resourcesNeeded: reportData.resources_needed || [],
      medicalProfile: row.medical_profile_snapshot
        ? {
            bloodGroup: row.medical_profile_snapshot.blood_group,
            chronicConditions: row.medical_profile_snapshot.chronic_conditions,
            allergies: row.medical_profile_snapshot.allergies,
          }
        : null,
    };
    if (caseRow?.hospital_id) {
      emitToHospital(caseRow.hospital_id, hospitalPayload);
    }

    const readyPayload = {
      caseId,
      firstAidSuggestion: reportData.first_aid_suggestion,
      urgencyLevel: reportData.urgency_level,
      generationTimeMs: totalTimeMs,
    };
    // An anonymous reporter has no personal room — their client watches the
    // case room instead.
    if (patientId) socketEmit(ROOMS.patientRoom(patientId), 'ai:report_ready', readyPayload);
    else socketEmit(ROOMS.caseRoom(caseId), 'ai:report_ready', readyPayload);

    return {
      success: true,
      reportId: savedReport?.id,
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
      detectedLanguage: row.input_language,
      transcribedText: row.transcribed_text,
      confidenceScore: reportData.confidence_score ?? null,
      clarificationState,
      clarifications,
    };
  } catch (error) {
    logger.error(`Record generation failed for case ${caseId}: ${error.message}`);
    await markFailed(caseId, patientId, error.message);
    throw error;
  }
}

function emitToHospital(hospitalId, payload) {
  socketEmit(ROOMS.hospitalRoom(hospitalId), EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE, payload);
}

/// The scene photo, fetched back out of storage for the PDF.
///
/// Phase 2 runs on a later request than the upload, so the buffer is long gone
/// from memory. Null on any failure: a report without the picture is still the
/// report, and the picture is one section of one page.
async function fetchScenePhoto(row) {
  const url = Array.isArray(row.image_urls) ? row.image_urls[0] : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn(`Scene photo unavailable for the report PDF: ${err.message}`);
    return null;
  }
}

async function markFailed(caseId, patientId, message) {
  logger.error(`AI pipeline failed for case ${caseId}: ${message}`);
  await supabaseAdmin
    .from('ai_reports')
    .upsert(
      {
        case_id: caseId,
        patient_id: patientId,
        generation_status: 'failed',
        error_message: message,
      },
      { onConflict: 'case_id' },
    );
  socketEmit(ROOMS.caseRoom(caseId), 'ai:error', { caseId, error: message });
}

/// The whole pipeline, for callers with no screen to show questions on.
///
/// The WhatsApp channel and any server-side retry land here: they analyse, skip
/// the questions they cannot ask, and generate. The mobile app calls the two
/// phases separately so it can put the questions in between.
export async function processAIReport(caseId, patientId, inputs) {
  const phase1 = await analyseForClarification(caseId, patientId, inputs);
  if (!phase1.awaitingClarification) {
    return generateFinalReport(caseId, { analysis: phase1.analysis });
  }

  // Nobody is going to answer these, so close them out rather than leaving the
  // case parked in 'awaiting_clarification' with the hospital waiting.
  await supabaseAdmin
    .from('ai_reports')
    .update({
      clarifications: phase1.clarifications.map((c) => ({
        ...c,
        skipped_at: new Date().toISOString(),
      })),
    })
    .eq('case_id', caseId);

  return generateFinalReport(caseId);
}

export default { analyseForClarification, generateFinalReport, processAIReport };
