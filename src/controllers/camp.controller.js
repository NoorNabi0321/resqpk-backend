// Medical camp endpoints: public self-registration, patient-facing discovery,
// and the camp admin's own dashboard.
import campService from '../services/camp.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

// POST /api/camps/register (PUBLIC)
export async function registerCamp(req, res) {
  try {
    const data = await campService.registerCamp(req.body || {});
    return successResponse(res, data, 'Camp registered', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/camps/nearby?lat=&lng=&radius=
export async function nearbyCamps(req, res) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return errorResponse(res, 'lat and lng query params are required', 400);
  }
  const radius = Number(req.query.radius);
  try {
    const data = await campService.getNearbyCamps(
      lat,
      lng,
      Number.isFinite(radius) && radius > 0 ? radius : 25,
    );
    return successResponse(res, data, 'Nearby camps', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/camps/dashboard/me — defined before /:id so 'dashboard' isn't an id
export async function campDashboard(req, res) {
  try {
    const data = await campService.getCampDashboardData(req.user.hospital_id);
    return successResponse(res, data, 'Camp dashboard', 200);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 403;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/camps/:id
export async function campDetails(req, res) {
  try {
    const data = await campService.getCampDetails(req.params.id);
    return successResponse(res, data, 'Camp details', 200);
  } catch (err) {
    return errorResponse(res, err.message, 404);
  }
}

export default { registerCamp, nearbyCamps, campDashboard, campDetails };
