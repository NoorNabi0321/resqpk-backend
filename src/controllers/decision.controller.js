// Accept / redirect / quick-message endpoints, plus the shared presets that
// both frontends read so message text lives in exactly one place.
import { supabaseAdmin } from '../config/supabase.js';
import decisionService from '../services/decision.service.js';
import {
  QUICK_MESSAGES,
} from '../constants/quick.messages.js';
import { successResponse, errorResponse } from '../utils/response.js';

// POST /api/decisions/accept
export async function sendMessage(req, res) {
  const { caseId, messageKey } = req.body || {};
  if (!caseId || !messageKey) {
    return errorResponse(res, 'caseId and messageKey are required', 400);
  }
  const senderRole = req.user.role === 'hospital_admin' ? 'hospital' : 'driver';
  try {
    const data = await decisionService.sendQuickMessage({
      caseId,
      senderUserId: req.user.id,
      senderRole,
      messageKey,
    });
    return successResponse(res, data, 'Message sent', 201);
  } catch (err) {
    const code = err.message.includes('not found')
      ? 404
      : err.message.includes('authorized')
        ? 403
        : 400;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/decisions/messages/:caseId — hospital admin or the assigned driver
export async function listMessages(req, res) {
  const { caseId } = req.params;
  try {
    const { data: emergencyCase } = await supabaseAdmin
      .from('emergency_cases')
      .select('id, hospital_id, patient_id, driver:drivers(user_id)')
      .eq('id', caseId)
      .maybeSingle();
    if (!emergencyCase) return errorResponse(res, 'Case not found', 404);

    const isDriver = emergencyCase.driver?.user_id === req.user.id;
    const isPatient = emergencyCase.patient_id === req.user.id;
    const isHospital =
      req.user.role === 'hospital_admin' && emergencyCase.hospital_id === req.user.hospital_id;
    if (!isDriver && !isHospital && !isPatient) {
      return errorResponse(res, 'Not authorized to view this case', 403);
    }

    const data = await decisionService.getCaseMessages(caseId);
    return successResponse(res, data, 'Case messages', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/decisions/constants — single source of truth for both frontends
export async function getConstants(req, res) {
  return successResponse(
    res,
    {
      quickMessages: QUICK_MESSAGES,
    },
    'Decision constants',
    200,
  );
}

export default { sendMessage, listMessages, getConstants };
