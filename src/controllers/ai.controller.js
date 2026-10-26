// Module 6 — AI report HTTP handlers.
import multer from 'multer';

import aiPipeline from '../services/ai/ai.pipeline.js';
import clarificationService, {
  ClarificationError,
} from '../services/ai/clarification.service.js';
import pdfService from '../services/pdf.service.js';
import { supabaseAdmin } from '../config/supabase.js';
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import { successResponse, errorResponse } from '../utils/response.js';

// Sockets are optional in tests and scripts — never let them throw.
function emit(room, event, payload) {
  try {
    getIO()?.to(room).emit(event, payload);
  } catch {
    /* socket layer not running */
  }
}

// Files stay in RAM (we stream them straight to Whisper/GPT/Storage).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('audio/') || file.mimetype.startsWith('image/');
    if (ok) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

export const uploadMiddleware = upload.fields([
  { name: 'voice_note', maxCount: 1 },
  { name: 'images', maxCount: 4 },
]);

// POST /api/ai/report (patient) — multipart: voice_note, images[], text, language, case_id
export async function generateReport(req, res) {
  const caseId = req.body.case_id;
  if (!caseId) return errorResponse(res, 'case_id is required', 400);

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, patient_id, status')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) return errorResponse(res, 'Case not found', 404);

  // A case token proves access to this case and nothing else; an account holder
  // must own the case. Either way the report is attached to the case's patient,
  // which is null for an anonymous reporter.
  const viaCaseToken = req.caseAccess?.caseId === caseId;
  const isOwner = req.user?.role === 'patient' && emergencyCase.patient_id === req.user.id;
  if (!viaCaseToken && !isOwner) {
    return errorResponse(res, 'Not authorized to add details to this case', 403);
  }
  if (['completed', 'cancelled'].includes(emergencyCase.status)) {
    return errorResponse(res, 'Case is no longer active', 400);
  }

  const voiceNoteBuffer = req.files?.voice_note?.[0]?.buffer || null;
  const voiceNoteMimeType = req.files?.voice_note?.[0]?.mimetype || null;
  const userText = req.body.text || null;
  const inputLanguage = req.body.language || 'auto';
  const imageBuffers = (req.files?.images || []).map((f) => ({
    buffer: f.buffer,
    mimeType: f.mimetype,
  }));

  if (!voiceNoteBuffer && !userText && imageBuffers.length === 0) {
    return errorResponse(res, 'Provide at least one input: voice note, text, or image', 400);
  }

  try {
    // Phase 1: analyse the inputs and compose the questions. Nothing is
    // delivered to the hospital here — the record is written after the answers
    // come in, so there is no provisional version anyone can act on.
    const analysis = await aiPipeline.analyseForClarification(
      caseId,
      emergencyCase.patient_id || null,
      { voiceNoteBuffer, voiceNoteMimeType, userText, imageBuffers, inputLanguage },
    );

    if (analysis.awaitingClarification) {
      return successResponse(
        res,
        {
          caseId,
          generationStatus: 'awaiting_clarification',
          clarificationState: 'awaiting',
          clarifications: analysis.clarifications,
          transcribedText: analysis.transcribedText,
          detectedLanguage: analysis.detectedLanguage,
        },
        'A few questions before the report is written',
        200,
      );
    }

    // No questions worth asking — write the record straight away rather than
    // making an emergency wait on an empty screen.
    const result = await aiPipeline.generateFinalReport(caseId, {
      analysis: analysis.analysis,
    });
    return successResponse(res, result, 'Emergency report generated and sent to hospital', 200);
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
}

// GET /api/ai/report/:caseId — patient (own case) or hospital_admin (their hospital)
export async function getReport(req, res) {
  const { caseId } = req.params;
  const { data: report } = await supabaseAdmin
    .from('ai_reports')
    .select('*, emergency_cases!inner(case_number, patient_id, hospital_id)')
    .eq('case_id', caseId)
    .maybeSingle();

  if (!report) return errorResponse(res, 'Report not found', 404);

  const ec = report.emergency_cases;
  const viaCaseToken = req.caseAccess?.caseId === caseId;
  const isOwnerPatient = req.user?.role === 'patient' && ec.patient_id === req.user.id;
  const isHospitalAdmin =
    req.user?.role === 'hospital_admin' && ec.hospital_id === req.user.hospital_id;
  if (!viaCaseToken && !isOwnerPatient && !isHospitalAdmin) {
    return errorResponse(res, 'Not authorized to view this report', 403);
  }

  return successResponse(res, report, 'AI report', 200);
}

// GET /api/ai/report/:caseId/pdf — fresh signed URL for the stored report PDF.
// Stored URLs expire after 6 hours, so a hospital reopening an old case needs
// a newly minted one rather than the link saved at generation time.
export async function getReportPdf(req, res) {
  const { caseId } = req.params;
  const { data: report } = await supabaseAdmin
    .from('ai_reports')
    .select('pdf_storage_path, emergency_cases!inner(patient_id, hospital_id)')
    .eq('case_id', caseId)
    .maybeSingle();

  if (!report) return errorResponse(res, 'Report not found', 404);

  const ec = report.emergency_cases;
  const viaCaseToken = req.caseAccess?.caseId === caseId;
  const isOwnerPatient = req.user?.role === 'patient' && ec.patient_id === req.user.id;
  const isHospitalAdmin =
    req.user?.role === 'hospital_admin' && ec.hospital_id === req.user.hospital_id;
  if (!viaCaseToken && !isOwnerPatient && !isHospitalAdmin) {
    return errorResponse(res, 'Not authorized to view this report', 403);
  }

  if (!report.pdf_storage_path) {
    return errorResponse(res, 'No PDF available for this report', 404);
  }

  try {
    const pdfUrl = await pdfService.getSignedPdfUrl(report.pdf_storage_path);
    return successResponse(res, { pdfUrl }, 'Report PDF URL', 200);
  } catch (err) {
    return errorResponse(res, `Could not create PDF link: ${err.message}`, 500);
  }
}

// POST /api/ai/report/:caseId/send — push a finished report at the hospital
// again.
//
// The pipeline already sends it the moment it is ready. This exists for the
// moment at the counter where staff say they cannot see it: one tap puts it
// back on their dashboard instead of the attendant re-dictating it.
export async function resendReportToHospital(req, res) {
  const { caseId } = req.params;

  const { data: report } = await supabaseAdmin
    .from('ai_reports')
    .select(
      `id, urgency_level, emergency_type, consciousness_state, key_observations,
       first_aid_suggestion, possible_conditions, resources_needed, transcribed_text,
       input_language, pdf_storage_path, generation_status, clarifications,
       clarification_state, confidence_score,
       emergency_cases!inner(patient_id, hospital_id, case_number)`,
    )
    .eq('case_id', caseId)
    .maybeSingle();

  if (!report) return errorResponse(res, 'Report not found', 404);

  const ec = report.emergency_cases;
  const viaCaseToken = req.caseAccess?.caseId === caseId;
  const isOwnerPatient = req.user?.role === 'patient' && ec.patient_id === req.user.id;
  if (!viaCaseToken && !isOwnerPatient) {
    return errorResponse(res, 'Not authorized to send this report', 403);
  }
  if (report.generation_status !== 'completed') {
    return errorResponse(res, 'The report is not finished yet', 400);
  }
  if (!ec.hospital_id) {
    return errorResponse(res, 'No hospital has been chosen for this case yet', 400);
  }

  try {
    let pdfUrl = null;
    if (report.pdf_storage_path) {
      pdfUrl = await pdfService.getSignedPdfUrl(report.pdf_storage_path);
    }

    emit(ROOMS.hospitalRoom(ec.hospital_id), EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE, {
      caseId,
      type: 'ai_report_ready',
      resent: true,
      report: {
        urgencyLevel: report.urgency_level,
        emergencyType: report.emergency_type,
        consciousnessState: report.consciousness_state,
        keyObservations: report.key_observations,
        firstAidSuggestion: report.first_aid_suggestion,
        possibleConditions: report.possible_conditions,
        transcribedText: report.transcribed_text,
        inputLanguage: report.input_language,
        // The questions that were put before this was written go with it, so a
        // resend lands on the desk as the same document, not a thinner one.
        confidenceScore: report.confidence_score ?? null,
        clarificationState: report.clarification_state ?? 'none',
        clarifications: report.clarifications || [],
      },
      pdfUrl,
      resourcesNeeded: report.resources_needed || [],
    });

    await supabaseAdmin
      .from('ai_reports')
      .update({ sent_to_hospital_at: new Date().toISOString() })
      .eq('id', report.id);

    return successResponse(res, { pdfUrl }, 'Report sent to the hospital', 200);
  } catch (err) {
    return errorResponse(res, err.message, 500);
  }
}

// Only the person describing the patient may answer for the scene. The hospital
// reads the report; it does not get to say whether the patient is breathing.
function assertMayAnswer(req, caseId, emergencyCase) {
  const viaCaseToken = req.caseAccess?.caseId === caseId;
  const isOwnerPatient = req.user?.role === 'patient' && emergencyCase.patient_id === req.user.id;
  if (!viaCaseToken && !isOwnerPatient) {
    throw new ClarificationError('Not authorized to answer for this case', 403);
  }
}

// GET /api/ai/report/:caseId/clarify — the questions still open.
//
// For an app resuming a sequence it was part way through: the phone was locked,
// the app was killed, the patient switched away to make a call. The case is
// parked in 'awaiting_clarification' until the questions are closed or the
// deadline passes, so there is something definite to come back to.
export async function getClarifications(req, res) {
  const { caseId } = req.params;
  try {
    const report = await clarificationService.loadReportForClarification(caseId);
    if (!report) return errorResponse(res, 'Report not found', 404);
    assertMayAnswer(req, caseId, report.emergency_cases);

    const result = await clarificationService.getOpenClarifications(caseId);
    return successResponse(res, result, 'Open questions', 200);
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500);
  }
}

// POST /api/ai/report/:caseId/clarify — record one single-tap answer (FR-14).
//
// The record has NOT been written yet and the hospital has nothing: that is the
// point of the blocking sequence. Answering the last question writes the record
// and delivers it, so this response carries the finished report when it was the
// final tap.
export async function answerClarification(req, res) {
  const { caseId } = req.params;
  const { questionId, answer } = req.body || {};
  if (!questionId) return errorResponse(res, 'questionId is required', 400);
  if (answer === undefined || answer === null || String(answer).trim() === '') {
    return errorResponse(res, 'answer is required', 400);
  }

  try {
    const report = await clarificationService.loadReportForClarification(caseId);
    if (!report) return errorResponse(res, 'Report not found', 404);
    assertMayAnswer(req, caseId, report.emergency_cases);

    const result = await clarificationService.answerClarification(caseId, {
      questionId,
      answer,
    });
    return successResponse(
      res,
      result,
      result.report ? 'Report generated and sent to hospital' : 'Answer recorded',
      200,
    );
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500);
  }
}

// POST /api/ai/report/:caseId/clarify/skip — stop asking and write the report.
//
// The deliberate skip, and the thing that bounds how long the blocking sequence
// can hold a record back. Answers already given still feed the record; the rest
// stay "Not reported".
export async function skipClarifications(req, res) {
  const { caseId } = req.params;
  try {
    const report = await clarificationService.loadReportForClarification(caseId);
    if (!report) return errorResponse(res, 'Report not found', 404);
    assertMayAnswer(req, caseId, report.emergency_cases);

    const result = await clarificationService.skipClarifications(caseId);
    return successResponse(res, result, 'Report generated and sent to hospital', 200);
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500);
  }
}

// POST /api/ai/report/:caseId/clarify/submit — every answer at once (FR-14).
//
// How the app finishes a sequence: the taps are buffered on the phone and sent
// together, so the deadline cannot close a sequence between two of them and
// start rejecting answers from someone who is visibly still answering. An empty
// list is the skip, and a legitimate ending.
export async function submitClarifications(req, res) {
  const { caseId } = req.params;
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];

  try {
    const report = await clarificationService.loadReportForClarification(caseId);
    if (!report) return errorResponse(res, 'Report not found', 404);
    assertMayAnswer(req, caseId, report.emergency_cases);

    const result = await clarificationService.submitClarifications(caseId, answers);
    return successResponse(res, result, 'Report generated and sent to hospital', 200);
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500);
  }
}

export default {
  uploadMiddleware,
  generateReport,
  getReport,
  getReportPdf,
  resendReportToHospital,
  getClarifications,
  answerClarification,
  skipClarifications,
  submitClarifications,
};
