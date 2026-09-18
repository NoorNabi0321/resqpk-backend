import caseService from '../services/case.service.js';
import dispatchService from '../services/dispatch.service.js';
import caseTokenService from '../services/case-token.service.js';
import {
  driverRespondSchema,
  updateCaseStatusSchema,
  accessCodeSchema,
  validate,
} from '../validators/sos.validator.js';
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

// GET /api/cases/active/me — the caller's in-progress case, or null
export async function getMyActiveCase(req, res) {
  try {
    const data = await caseService.getMyActiveCase(req.user);
    return successResponse(res, data, data ? 'Active case' : 'No active case', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/cases/handoff (driver) — pass the case to another nearby ambulance
export async function handoffCase(req, res) {
  const { caseId, reason } = req.body || {};
  if (!caseId) return errorResponse(res, 'caseId is required', 400);
  try {
    const data = await dispatchService.handoffCase({
      caseId,
      currentDriverId: req.user.driver_id,
      reason: reason || null,
    });
    return successResponse(res, data, 'Case handed over', 200);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 400;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/cases/:id (patient or assigned driver)
export async function getCaseDetails(req, res) {
  try {
    const data = await caseService.getCaseDetails(req.params.id, req.user);
    return successResponse(res, data, 'Case details', 200);
  } catch (err) {
    const code = err.message.includes('authorized') ? 403 : 404;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/cases/:id/route (patient or assigned driver — road geometry for the current leg)
export async function getCaseRoute(req, res) {
  try {
    // Pass the whole principal, not just an id: a case-token holder has no user
    // id, and the service authorises on the scoped case id instead.
    const data = await caseService.getCaseRoute(req.params.id, req.user);
    return successResponse(res, data, 'Case route', 200);
  } catch (err) {
    const code = err.message.includes('authorized') ? 403 : 404;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/hospitals/nearby?lat=&lng= (any authenticated user)
export async function nearbyHospitals(req, res) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return errorResponse(res, 'lat and lng query params are required', 400);
  }
  try {
    const data = await caseService.listNearbyHospitals({ lat, lng });
    return successResponse(res, data, 'Nearby hospitals', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/cases/:id/hospital (patient — change destination hospital)
export async function changeHospital(req, res) {
  const { hospitalId } = req.body || {};
  if (!hospitalId) return errorResponse(res, 'hospitalId is required', 400);
  try {
    const data = await caseService.changeCaseHospital({
      caseId: req.params.id,
      patientId: req.user.id,
      hospitalId,
    });
    return successResponse(res, data, 'Hospital updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
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

// GET /api/cases/track/:token (public — tracking link, no account)
//
// Returns the tracking snapshot plus a case token, so the web page can then
// open a socket and fetch the route without ever asking anyone to sign in.
export async function getShareTracking(req, res) {
  try {
    const data = await caseService.getShareTrackingData(req.params.token);
    const found = await caseTokenService.caseFromShareToken(req.params.token);
    if (!found) return errorResponse(res, 'This tracking link has expired', 404);

    return successResponse(
      res,
      {
        ...data,
        caseId: found.id,
        caseToken: caseTokenService.issueCaseToken({
          caseId: found.id,
          channel: found.channel,
        }),
      },
      'Tracking data',
      200,
    );
  } catch (err) {
    return errorResponse(res, err.message, 404);
  }
}

// POST /api/cases/lookup (public, rate-limited) — access code → case token.
export async function lookupByAccessCode(req, res) {
  const { error, value } = validate(accessCodeSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);

  try {
    const found = await caseTokenService.caseFromAccessCode(value.accessCode);
    // One message for "wrong format", "no such code" and "expired": anything
    // more specific helps someone guessing codes.
    if (!found) return errorResponse(res, 'No request found for that code', 404);

    return successResponse(
      res,
      {
        caseId: found.id,
        caseNumber: found.case_number,
        status: found.status,
        caseToken: caseTokenService.issueCaseToken({
          caseId: found.id,
          channel: found.channel,
        }),
      },
      'Request found',
      200,
    );
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/cases/claim (patient) — attach an anonymous case to this account.
export async function claimCase(req, res) {
  const { error, value } = validate(accessCodeSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);

  try {
    const data = await caseService.claimCaseByAccessCode({
      accessCode: value.accessCode,
      patientId: req.user.id,
    });
    return successResponse(res, data, 'Request added to your account', 200);
  } catch (err) {
    const code = err.message.includes('already linked') ? 409 : 404;
    return errorResponse(res, err.message, code);
  }
}
