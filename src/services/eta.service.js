// ETA service: on each driver location update during an active case, computes
// the ETA to the current target (patient or hospital), persists it, and
// broadcasts to the case + hospital Socket.io rooms.
import mapsService from './maps.service.js';
import { supabaseAdmin } from '../config/supabase.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';

// Main entry — called on every driver location update during an active case.
export async function calculateAndBroadcastETA(io, driverId, driverLat, driverLng, caseId) {
  const { data: emergencyCase, error } = await supabaseAdmin
    .from('emergency_cases')
    .select('patient_lat, patient_lng, hospital_id, status')
    .eq('id', caseId)
    .maybeSingle();

  if (error || !emergencyCase) return null;

  const { status, hospital_id: hospitalId } = emergencyCase;

  // ETA only matters while the driver is actively moving toward a target.
  if (status !== 'driver_assigned' && status !== 'en_route') return null;

  let target;
  let phase;

  if (status === 'driver_assigned') {
    // Heading to the patient.
    target = { lat: Number(emergencyCase.patient_lat), lng: Number(emergencyCase.patient_lng) };
    phase = 'to_patient';
  } else {
    // en_route — patient picked up, heading to hospital.
    if (!hospitalId) return null;
    const { data: hospital } = await supabaseAdmin
      .from('hospitals')
      .select('lat, lng')
      .eq('id', hospitalId)
      .maybeSingle();
    if (!hospital) return null;
    target = { lat: Number(hospital.lat), lng: Number(hospital.lng) };
    phase = 'to_hospital';
  }

  const eta = await mapsService.getDistanceAndETA(driverLat, driverLng, target.lat, target.lng);

  await supabaseAdmin
    .from('emergency_cases')
    .update({ estimated_driver_arrival_seconds: eta.durationSeconds })
    .eq('id', caseId);

  const payload = {
    caseId,
    driverId,
    driverLat,
    driverLng,
    targetLat: target.lat,
    targetLng: target.lng,
    durationSeconds: eta.durationSeconds,
    durationText: eta.durationText,
    distanceMeters: eta.distanceMeters,
    distanceText: eta.distanceText,
    phase,
    timestamp: new Date().toISOString(),
  };

  // Patient (case room) hears the ETA; hospital dashboard hears the ambulance update.
  io.to(ROOMS.caseRoom(caseId)).emit(EVENTS.ETA.ETA_UPDATE, payload);
  if (hospitalId) {
    io.to(ROOMS.hospitalRoom(hospitalId)).emit(EVENTS.HOSPITAL.HOSPITAL_AMBULANCE_UPDATE, payload);
  }

  return payload;
}

// Persists the driver's current location and appends to the history log.
export async function updateDriverLocationInDB(driverId, lat, lng, heading, speed) {
  const nowIso = new Date().toISOString();

  const { data: driver, error } = await supabaseAdmin
    .from('drivers')
    .update({
      current_lat: lat,
      current_lng: lng,
      heading,
      location_updated_at: nowIso,
    })
    .eq('id', driverId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  // Historical log row (analytics).
  await supabaseAdmin.from('driver_locations').insert({
    driver_id: driverId,
    lat,
    lng,
    heading,
    speed_kmh: speed,
    recorded_at: nowIso,
  });

  return driver;
}

// Absolute clock time of arrival from a duration in seconds.
export function calculateArrivalTime(durationSeconds) {
  return new Date(Date.now() + durationSeconds * 1000).toISOString();
}

export default {
  calculateAndBroadcastETA,
  updateDriverLocationInDB,
  calculateArrivalTime,
};
