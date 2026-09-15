// Attaching a destination hospital to an emergency case.
//
// This is the ONLY place a hospital learns about a case. Until it runs,
// emergency_cases.hospital_id is null and the case is invisible to every
// dashboard — deliberately: a receptionist should never see a request that no
// ambulance has accepted yet.
//
// Shared by the patient confirming the suggested hospital, the patient picking
// a different one, and the automatic fallback for a patient who never answered.
import { supabaseAdmin } from '../config/supabase.js';
import mapsService from './maps.service.js';
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import logger from '../middleware/logger.js';

// Same shape as the dashboard's hospital:join snapshot, so a card built from a
// live event is identical to one loaded on page refresh. FK-column embeds
// (patient_id, …) are required: emergency_cases has two FKs to users.
const CASE_EMBED = `*,
   patient:patient_id(full_name, phone, medical_profiles(blood_group, gender, date_of_birth, chronic_conditions, allergies)),
   driver:drivers(id, vehicle_number, current_lat, current_lng, users(full_name, phone)),
   ai_report:ai_reports(urgency_level, emergency_type, consciousness_state, key_observations, first_aid_suggestion, resources_needed, pdf_url)`;

function emit(room, event, payload) {
  try {
    getIO()?.to(room).emit(event, payload);
  } catch {
    /* socket layer not running (scripts/tests) */
  }
}

/** Full case row for a hospital dashboard card. */
export async function buildHospitalCasePayload(caseId) {
  const { data, error } = await supabaseAdmin
    .from('emergency_cases')
    .select(CASE_EMBED)
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Sets the case's destination hospital and tells everyone who needs to know:
 * the patient and driver apps, the hospital that gains the case, and any
 * hospital that loses it.
 */
export async function assignHospitalToCase({ caseId, hospitalId, source = 'patient' }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, case_number, hospital_id, driver_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');

  const { data: hospital } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, lat, lng, is_active, has_emergency_ward')
    .eq('id', hospitalId)
    .maybeSingle();
  if (!hospital || !hospital.is_active) throw new Error('Hospital not found');
  if (!hospital.has_emergency_ward) throw new Error('Hospital has no emergency ward');

  const summary = {
    caseId,
    hospitalId: hospital.id,
    hospitalName: hospital.name,
    hospitalLat: Number(hospital.lat),
    hospitalLng: Number(hospital.lng),
    source,
  };

  const previousHospitalId = emergencyCase.hospital_id;
  // Re-confirming the same hospital must not re-alert its dashboard.
  if (previousHospitalId === hospital.id) return { hospital: summary, unchanged: true };

  const { error } = await supabaseAdmin
    .from('emergency_cases')
    .update({
      hospital_id: hospital.id,
      // The newly chosen hospital has not reviewed anything yet, even if the
      // previous one had already accepted.
      hospital_decision: 'awaiting_review',
      decision_at: null,
      decision_by: null,
      preparation_note: null,
    })
    .eq('id', caseId);
  if (error) throw new Error(error.message);

  // Patient + driver apps: new destination (both already handle this event).
  emit(ROOMS.caseRoom(caseId), EVENTS.EMERGENCY.HOSPITAL_CHANGED, summary);
  if (emergencyCase.driver_id) {
    emit(ROOMS.driverRoom(emergencyCase.driver_id), EVENTS.EMERGENCY.HOSPITAL_CHANGED, summary);
  }

  // The hospital that lost it drops the card.
  if (previousHospitalId) {
    emit(ROOMS.hospitalRoom(previousHospitalId), EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE, {
      caseId,
      type: 'hospital_changed',
      newHospitalName: hospital.name,
    });
  }

  // The hospital that gained it gets a complete card, not a bare id.
  try {
    const casePayload = await buildHospitalCasePayload(caseId);
    emit(ROOMS.hospitalRoom(hospital.id), EVENTS.HOSPITAL.HOSPITAL_NEW_CASE, {
      ...casePayload,
      caseId,
      type: previousHospitalId ? 'hospital_changed_in' : 'hospital_selected',
    });
  } catch (err) {
    logger.warn(`Could not build dashboard payload for ${caseId}: ${err.message}`);
  }

  logger.info(
    `Case ${emergencyCase.case_number} → ${hospital.name} (${source}${
      previousHospitalId ? ', changed' : ''
    })`,
  );
  return { hospital: summary, unchanged: false };
}

/**
 * Nearest emergency hospital to the patient, used when nobody can confirm one.
 * No-op if the case already has a hospital. Returns null if none is available.
 */
export async function autoAssignNearestHospital(caseId) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('patient_lat, patient_lng, hospital_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase || emergencyCase.hospital_id) return null;

  const { data: hospitals } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('has_emergency_ward', true)
    .eq('is_active', true);

  const nearest = mapsService.findNearestHospital(
    Number(emergencyCase.patient_lat),
    Number(emergencyCase.patient_lng),
    hospitals || [],
  );
  if (!nearest) {
    logger.warn(`No emergency hospital available to auto-assign for case ${caseId}`);
    return null;
  }

  return assignHospitalToCase({ caseId, hospitalId: nearest.id, source: 'auto' });
}

export default { buildHospitalCasePayload, assignHospitalToCase, autoAssignNearestHospital };
