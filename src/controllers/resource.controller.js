// Hospital resource endpoints: list, update, and the two match queries that
// drive the accept/redirect decision.
import { supabaseAdmin } from '../config/supabase.js';
import resourceService from '../services/resource.service.js';
import { getIO } from '../socket/socket.server.js';
import { ROOMS } from '../socket/socket.events.js';
import { successResponse, errorResponse } from '../utils/response.js';
import logger from '../middleware/logger.js';

const VALID_STATUSES = ['available', 'unavailable', 'limited'];

// Loads a case's AI resources_needed, verifying it belongs to this hospital.
async function getCaseResourceNeeds(caseId, hospitalId) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, hospital_id, driver_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.hospital_id !== hospitalId) {
    throw new Error('Case does not belong to your hospital');
  }

  const { data: report } = await supabaseAdmin
    .from('ai_reports')
    .select('resources_needed')
    .eq('case_id', caseId)
    .maybeSingle();

  return { emergencyCase, resourcesNeeded: report?.resources_needed || [] };
}

// GET /api/resources
export async function listResources(req, res) {
  try {
    const data = await resourceService.getHospitalResources(req.user.hospital_id);
    return successResponse(res, data, 'Hospital resources', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/resources/:canonicalKey
export async function updateResource(req, res) {
  const { status, quantity } = req.body || {};
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return errorResponse(res, `status must be one of: ${VALID_STATUSES.join(', ')}`, 400);
  }
  try {
    const data = await resourceService.updateResource(
      req.user.hospital_id,
      req.params.canonicalKey,
      { status, quantity },
      req.user.id,
    );

    // Keep other open reception screens in sync.
    try {
      getIO()
        ?.to(ROOMS.hospitalRoom(req.user.hospital_id))
        .emit('hospital:resources_updated', {
          hospitalId: req.user.hospital_id,
          canonicalKey: req.params.canonicalKey,
          status: data.status,
          quantity: data.quantity,
          updatedAt: data.updated_at,
        });
    } catch (socketErr) {
      logger.warn(`resources_updated broadcast failed: ${socketErr.message}`);
    }

    return successResponse(res, data, 'Resource updated', 200);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 400;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/resources/match/:caseId
export async function matchCaseResources(req, res) {
  try {
    const { resourcesNeeded } = await getCaseResourceNeeds(req.params.caseId, req.user.hospital_id);
    const data = await resourceService.matchResources(req.user.hospital_id, resourcesNeeded);
    return successResponse(res, data, 'Resource match', 200);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 403;
    return errorResponse(res, err.message, code);
  }
}

// GET /api/resources/alternatives/:caseId
export async function alternativeHospitals(req, res) {
  try {
    const { emergencyCase, resourcesNeeded } = await getCaseResourceNeeds(
      req.params.caseId,
      req.user.hospital_id,
    );

    // Rank alternatives from where the ambulance actually is right now.
    let ambulanceLat = null;
    let ambulanceLng = null;
    if (emergencyCase.driver_id) {
      const { data: driver } = await supabaseAdmin
        .from('drivers')
        .select('current_lat, current_lng')
        .eq('id', emergencyCase.driver_id)
        .maybeSingle();
      ambulanceLat = driver?.current_lat ?? null;
      ambulanceLng = driver?.current_lng ?? null;
    }

    const data = await resourceService.getNearbyAlternativeHospitals(
      req.user.hospital_id,
      ambulanceLat,
      ambulanceLng,
      resourcesNeeded,
    );
    return successResponse(res, data, 'Alternative hospitals', 200);
  } catch (err) {
    const code = err.message.includes('not found') ? 404 : 403;
    return errorResponse(res, err.message, code);
  }
}

export default { listResources, updateResource, matchCaseResources, alternativeHospitals };
