// Module 6 — AI report HTTP handlers.
import multer from 'multer';

import aiPipeline from '../services/ai/ai.pipeline.js';
import pdfService from '../services/pdf.service.js';
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
    const result = await aiPipeline.processAIReport(caseId, emergencyCase.patient_id || null, {
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

export default { uploadMiddleware, generateReport, getReport, getReportPdf };
