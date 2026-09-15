import caseService from '../services/case.service.js';
import {
  sosRequestSchema,
  cancelSOSSchema,
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

