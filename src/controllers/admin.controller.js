// ResQPK administration endpoints. super_admin only — enforced on the router.
import adminService from '../services/admin.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

// GET /api/admin/facilities?status=&type=
export async function listFacilities(req, res) {
  try {
    const data = await adminService.listFacilities({
      status: req.query.status || 'pending',
      facilityType: req.query.type || 'all',
    });
    return successResponse(res, { facilities: data, count: data.length }, 'Facilities', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/admin/facilities/pending-count
export async function pendingCount(req, res) {
  try {
    return successResponse(res, { pending: await adminService.countPending() }, 'Pending', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/admin/facilities/:id
export async function getFacility(req, res) {
  try {
    return successResponse(res, await adminService.getFacility(req.params.id), 'Facility', 200);
  } catch (err) {
    return errorResponse(res, err.message, 404);
  }
}

// POST /api/admin/facilities/:id/approve
export async function approveFacility(req, res) {
  try {
    const data = await adminService.approveFacility(req.params.id, req.user.id);
    return successResponse(res, data, 'Facility approved', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/admin/facilities/:id/reject
export async function rejectFacility(req, res) {
  try {
    const data = await adminService.rejectFacility(req.params.id, req.user.id, req.body?.reason);
    return successResponse(res, data, 'Facility rejected', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export default { listFacilities, pendingCount, getFacility, approveFacility, rejectFacility };
