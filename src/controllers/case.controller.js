import caseService from '../services/case.service.js';
import { driverRespondSchema, updateCaseStatusSchema, validate } from '../validators/sos.validator.js';
import { successResponse, errorResponse } from '../utils/response.js';

// POST /api/cases/respond (driver)
export async function driverRespond(req, res) {
  const { error, value } = validate(driverRespondSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await caseService.driverRespondToCase({
      caseId: value.caseId,
      driverId: req.user.driver_id,
      response: value.response,
    });
    return successResponse(res, data, 'Response recorded', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/cases/status (driver)
export async function updateStatus(req, res) {
  const { error, value } = validate(updateCaseStatusSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await caseService.updateCaseStatus({
      caseId: value.caseId,
      driverId: req.user.driver_id,
      status: value.status,
    });
    return successResponse(res, data, 'Status updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/cases/:id (patient or assigned driver)
export async function getCaseDetails(req, res) {
  try {
    const data = await caseService.getCaseDetails(req.params.id, req.user.id);
    return successResponse(res, data, 'Case details', 200);
  } catch (err) {
    const code = err.message.includes('authorized') ? 403 : 404;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/cases (hospital admin — full case list for the dashboard)
export async function listCases(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const data = await caseService.listHospitalCases({
      hospitalId: req.user.hospital_id,
      date: req.query.date,
      status: req.query.status || 'all',
      limit,
      offset,
    });
    return successResponse(res, data, 'Cases', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/cases/beds (hospital admin — REST fallback for bed updates)
export async function updateBeds(req, res) {
  const { bedType, availableCount, reservedCount } = req.body || {};
  if (!bedType || availableCount == null || reservedCount == null) {
    return errorResponse(res, 'bedType, availableCount and reservedCount are required', 400);
  }
  try {
    const data = await caseService.updateHospitalBeds({
      hospitalId: req.user.hospital_id,
      userId: req.user.id,
      bedType,
      availableCount: Number(availableCount),
      reservedCount: Number(reservedCount),
    });
    return successResponse(res, data, 'Bed status updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/cases/track/:token (public — family tracking)
export async function getShareTracking(req, res) {
  try {
    const data = await caseService.getShareTrackingData(req.params.token);
    return successResponse(res, data, 'Tracking data', 200);
  } catch (err) {
    return errorResponse(res, err.message, 404);
  }
}
