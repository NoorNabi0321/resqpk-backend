// Hospital self-registration (PUBLIC, rate limited, lands unapproved).
import facilityRegistration from '../services/facility-registration.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

// POST /api/hospitals/register
export async function registerHospital(req, res) {
  try {
    const data = await facilityRegistration.registerHospital(req.body || {});
    return successResponse(res, data, 'Hospital registered', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export default { registerHospital };
