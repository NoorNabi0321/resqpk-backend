// Module 6 — AI report HTTP handlers.
import multer from 'multer';

import aiPipeline from '../services/ai/ai.pipeline.js';
import { supabaseAdmin } from '../config/supabase.js';
import { successResponse, errorResponse } from '../utils/response.js';

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

  // Verify the case belongs to this patient and is still active.
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, patient_id, status')
    .eq('id', caseId)
    .eq('patient_id', req.user.id)
    .maybeSingle();
  if (!emergencyCase) return errorResponse(res, 'Case not found', 404);
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
    const result = await aiPipeline.processAIReport(caseId, req.user.id, {
      voiceNoteBuffer,
      voiceNoteMimeType,
      userText,
      imageBuffers,
      inputLanguage,
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
  const isOwnerPatient = req.user.role === 'patient' && ec.patient_id === req.user.id;
  const isHospitalAdmin = req.user.role === 'hospital_admin' && ec.hospital_id === req.user.hospital_id;
  if (!isOwnerPatient && !isHospitalAdmin) {
    return errorResponse(res, 'Not authorized to view this report', 403);
  }

  return successResponse(res, report, 'AI report', 200);
}

export default { uploadMiddleware, generateReport, getReport };
