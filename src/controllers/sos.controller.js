import caseService from '../services/case.service.js';
import {
  sosRequestSchema,
  cancelSOSSchema,
  validate,
} from '../validators/sos.validator.js';
import { successResponse, errorResponse } from '../utils/response.js';

// POST /api/sos/trigger — returns fast; dispatch runs in the background.
//
// No account required. A signed-in patient gets their medical profile attached;
// anyone else supplies a callback number so the driver can phone ahead.
export async function triggerSOS(req, res) {
  const { error, value } = validate(sosRequestSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);

  const patientId = req.user?.role === 'patient' ? req.user.id : null;
  const reporterPhone = value.reporterPhone || (patientId ? req.user.phone : null) || null;

  if (!patientId && !reporterPhone) {
    return errorResponse(
      res,
      'reporterPhone is required so the ambulance crew can call you back',
      400,
    );
  }

  try {
    const data = await caseService.createSOS({
      ...value,
      patientId,
      reporterPhone,
      reporterName: value.reporterName || null,
    });
    return successResponse(res, data, 'SOS triggered', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/sos/cancel — the reporter, whether or not they have an account.
export async function cancelSOS(req, res) {
  const { error, value } = validate(cancelSOSSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);

  // A case token authorises only its own case, so it stands in for ownership.
  if (req.caseAccess && req.caseAccess.caseId !== value.caseId) {
    return errorResponse(res, 'Not authorized to cancel this case', 403);
  }

  try {
    const data = await caseService.cancelSOS({
      caseId: value.caseId,
      patientId: req.caseAccess ? null : req.user?.id,
      viaCaseToken: !!req.caseAccess,
      reason: value.reason,
    });
    return successResponse(res, data, 'SOS cancelled', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

