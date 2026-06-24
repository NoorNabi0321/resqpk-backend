import caseService from '../services/case.service.js';
import {
  sosRequestSchema,
  cancelSOSSchema,
  missedCallSOSSchema,
  validate,
} from '../validators/sos.validator.js';
import { successResponse, errorResponse } from '../utils/response.js';

// POST /api/sos/trigger (patient) — returns fast; dispatch runs in background.
export async function triggerSOS(req, res) {
  const { error, value } = validate(sosRequestSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await caseService.createSOS({ patientId: req.user.id, ...value });
    return successResponse(res, data, 'SOS triggered', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/sos/cancel (patient)
export async function cancelSOS(req, res) {
  const { error, value } = validate(cancelSOSSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await caseService.cancelSOS({
      caseId: value.caseId,
      patientId: req.user.id,
      reason: value.reason,
    });
    return successResponse(res, data, 'SOS cancelled', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/sos/missed-call-webhook (public — Android gateway).
// Always responds 200 so the gateway never retries.
export async function handleMissedCallWebhook(req, res) {
  const { error, value } = validate(missedCallSOSSchema, req.body);
  if (error) {
    return successResponse(res, { success: false, reason: 'invalid_request' }, 'Received', 200);
  }
  try {
    const data = await caseService.handleMissedCallSOS(value);
    return successResponse(res, data, 'Received', 200);
  } catch {
    return successResponse(res, { success: false, reason: 'error' }, 'Received', 200);
  }
}
