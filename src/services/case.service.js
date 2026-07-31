// Case orchestration: creating an SOS (and kicking off dispatch), driver
// responses, status transitions, cancellation, missed-call trigger, and
// case/tracking lookups.
import { supabaseAdmin } from '../config/supabase.js';
import dispatchService from './dispatch.service.js';
import mapsService from './maps.service.js';
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import logger from '../middleware/logger.js';

// 1. Create an SOS case and start dispatch in the background.
export async function createSOS({ patientId, lat, lng, accuracy, address, triggerMethod = 'app_sos' }) {
  // Nearest emergency-capable hospital (pre-notification target).
  const { data: hospitals } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('has_emergency_ward', true)
    .eq('is_active', true);
  const nearestHospital = mapsService.findNearestHospital(lat, lng, hospitals || []);

  const { data: created, error } = await supabaseAdmin
    .from('emergency_cases')
    .insert({
      patient_id: patientId,
      patient_lat: lat,
      patient_lng: lng,
      patient_address: address || null,
      hospital_id: nearestHospital?.id || null,
      status: 'pending',
      trigger_method: triggerMethod,
      sos_triggered_at: new Date().toISOString(),
    })
    .select('id, case_number')
    .single();

  if (error) throw new Error(error.message);

  // Run the dispatch loop in the background — return to the patient immediately.
  dispatchService
    .runDispatchCycle(created.id, lat, lng)
    .catch((err) => logger.error(`Dispatch cycle error: ${err.message}`));

  return {
    caseId: created.id,
    caseNumber: created.case_number,
    status: 'searching',
    hospital: nearestHospital
      ? {
          id: nearestHospital.id,
          name: nearestHospital.name,
          lat: nearestHospital.lat,
          lng: nearestHospital.lng,
          distanceText: nearestHospital.distanceText,
        }
      : null,
    message: 'Searching for nearest ambulance...',
  };
}

// 2. Driver accepts/declines a dispatch request (the dispatch loop polls this).
export async function driverRespondToCase({ caseId, driverId, response }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('status')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase || emergencyCase.status !== 'searching') {
    throw new Error('Case no longer active');
  }

  const { data: request } = await supabaseAdmin
    .from('case_driver_requests')
    .select('id, response')
    .eq('case_id', caseId)
    .eq('driver_id', driverId)
    .eq('response', 'pending')
    .maybeSingle();
  if (!request) throw new Error('Request not found or already responded');

  await supabaseAdmin
    .from('case_driver_requests')
    .update({ response, responded_at: new Date().toISOString() })
    .eq('case_id', caseId)
    .eq('driver_id', driverId);

  return {
    success: true,
    message: response === 'accepted' ? 'Response recorded' : 'Request declined',
  };
}

// 3. Driver advances the case through its lifecycle.
export async function updateCaseStatus({ caseId, driverId, status }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, status, driver_id, hospital_id, patient_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.driver_id !== driverId) throw new Error('Not your case');

  const validTransitions = {
    arrived: ['driver_assigned'],
    en_route: ['arrived'],
    completed: ['en_route'],
  };
  if (!validTransitions[status]?.includes(emergencyCase.status)) {
    throw new Error(`Cannot move from ${emergencyCase.status} to ${status}`);
  }

  const now = new Date().toISOString();
  const update = { status };
  if (status === 'arrived') update.driver_arrived_at = now;
  if (status === 'completed') {
    update.completed_at = now;
    update.hospital_arrived_at = now;
  }

  const { data: updated, error } = await supabaseAdmin
    .from('emergency_cases')
    .update(update)
    .eq('id', caseId)
    .select()
    .single();
  if (error) throw new Error(error.message);

  // Free the driver once the trip is complete.
  if (status === 'completed') {
    await supabaseAdmin.from('drivers').update({ is_available: true }).eq('id', driverId);
  }

  const eventByStatus = {
    arrived: EVENTS.EMERGENCY.DRIVER_ARRIVED,
    en_route: EVENTS.EMERGENCY.DRIVER_EN_ROUTE,
    completed: EVENTS.EMERGENCY.CASE_COMPLETED,
  };
  const io = getIO();
  const payload = { caseId, status, timestamp: now };
  io?.to(ROOMS.caseRoom(caseId)).emit(eventByStatus[status], payload);
  if (emergencyCase.hospital_id) {
    io?.to(ROOMS.hospitalRoom(emergencyCase.hospital_id)).emit(
      EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE,
      { ...payload, type: 'status_update' },
    );
  }

  return updated;
}

// 4. Patient cancels before the trip is underway.
export async function cancelSOS({ caseId, patientId, reason = 'false_alarm' }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, status, driver_id, patient_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.patient_id !== patientId) throw new Error('Not your case');

  const cancellable = ['pending', 'searching', 'driver_assigned'];
  if (!cancellable.includes(emergencyCase.status)) {
    throw new Error('Case can no longer be cancelled');
  }

  const io = getIO();

  if (emergencyCase.driver_id) {
    io?.to(ROOMS.driverRoom(emergencyCase.driver_id)).emit(EVENTS.EMERGENCY.CASE_CANCELLED, {
      caseId,
      reason,
    });
    await supabaseAdmin
      .from('drivers')
      .update({ is_available: true })
      .eq('id', emergencyCase.driver_id);
  }

  await supabaseAdmin
    .from('case_driver_requests')
    .update({ response: 'timeout', responded_at: new Date().toISOString() })
    .eq('case_id', caseId)
    .eq('response', 'pending');

  await supabaseAdmin
    .from('emergency_cases')
    .update({ status: 'cancelled', is_false_alert: reason === 'false_alarm' })
    .eq('id', caseId);

  return { success: true };
}

// 5. Missed-call trigger (basic — Module 7 adds normalization + rate limiting).
export async function handleMissedCallSOS({ callerPhone, gatewaySecret }) {
  if (gatewaySecret !== process.env.MISSED_CALL_GATEWAY_SECRET) {
    logger.warn('Missed-call webhook with invalid gateway secret');
    return { success: false, reason: 'unauthorized' };
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, last_known_lat, last_known_lng')
    .eq('phone', callerPhone)
    .eq('role', 'patient')
    .maybeSingle();
  if (!user) return { success: false, reason: 'phone_not_registered' };

  if (user.last_known_lat == null || user.last_known_lng == null) {
    return { success: false, reason: 'no_location_on_file' };
  }

  const result = await createSOS({
    patientId: user.id,
    lat: Number(user.last_known_lat),
    lng: Number(user.last_known_lng),
    triggerMethod: 'missed_call',
  });

  return { success: true, caseId: result.caseId, caseNumber: result.caseNumber };
}

// Module 7 — phone/keyword helpers for the SMS gateway.
const SMS_TRIGGERS = ['sos', 'help', 'emergency', 'ambulance', 'مدد'];

// Normalize Pakistani numbers to the stored 03XXXXXXXXX form.
function normalizePhone(phone) {
  const p = String(phone || '').replace(/[\s-]/g, '');
  if (p.startsWith('+92')) return `0${p.slice(3)}`;
  if (p.startsWith('92') && p.length === 12) return `0${p.slice(2)}`;
  return p;
}

function isSMSTrigger(message) {
  const n = String(message || '').toLowerCase().trim();
  return SMS_TRIGGERS.some((t) => n.startsWith(t));
}

// 5b. SMS-based offline SOS trigger (primary offline path — see [[gateway-decision]]).
// Patient SMSes a keyword (e.g. "SOS") to the gateway number; the forwarder app
// POSTs { callerPhone, messageBody, gatewaySecret } here. Always best-effort.
export async function handleSMSWebhook({ callerPhone, messageBody, gatewaySecret }) {
  const expected = process.env.SMS_GATEWAY_SECRET || process.env.MISSED_CALL_GATEWAY_SECRET;
  if (!expected || gatewaySecret !== expected) {
    logger.warn('SMS webhook with invalid/missing gateway secret');
    return { success: false, reason: 'unauthorized' };
  }

  if (!isSMSTrigger(messageBody)) {
    logger.info(`SMS ignored (no SOS keyword): "${messageBody}"`);
    return { success: false, reason: 'not_a_trigger' };
  }

  const phone = normalizePhone(callerPhone);

  // Ignore the gateway phone messaging itself (common during testing).
  if (
    process.env.GATEWAY_PHONE_NUMBER &&
    phone === normalizePhone(process.env.GATEWAY_PHONE_NUMBER)
  ) {
    logger.info('Gateway self-SMS detected — ignoring');
    return { success: false, reason: 'self_message' };
  }

  const notes = String(messageBody || '').trim().split(/\s+/).slice(1).join(' ') || null;

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, full_name, last_known_lat, last_known_lng, last_location_updated_at')
    .eq('phone', phone)
    .eq('role', 'patient')
    .maybeSingle();
  if (!user) {
    logger.warn(`SMS SOS from unregistered number: ${phone}`);
    return { success: false, reason: 'not_registered' };
  }

  // Rate limit: one offline SOS per number per 5 minutes.
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recent } = await supabaseAdmin
    .from('emergency_cases')
    .select('id')
    .eq('patient_id', user.id)
    .in('trigger_method', ['sms', 'missed_call'])
    .gt('sos_triggered_at', fiveMinAgo)
    .not('status', 'in', '(cancelled,no_driver_found)')
    .limit(1);
  if (recent && recent.length) {
    logger.warn(`Duplicate SMS SOS blocked for ${phone}`);
    return { success: false, reason: 'rate_limited' };
  }

  // Don't open a second case if one is already active.
  const { data: active } = await supabaseAdmin
    .from('emergency_cases')
    .select('id')
    .eq('patient_id', user.id)
    .in('status', ['pending', 'searching', 'driver_assigned', 'en_route', 'arrived'])
    .limit(1);
  if (active && active.length) {
    return { success: false, reason: 'already_active', caseId: active[0].id };
  }

  if (user.last_known_lat == null || user.last_known_lng == null) {
    logger.warn(`SMS SOS but no location on file for user ${user.id}`);
    return { success: false, reason: 'no_location', userId: user.id };
  }
  const stale =
    !!user.last_location_updated_at &&
    new Date(user.last_location_updated_at) < new Date(Date.now() - 24 * 3600 * 1000);
  if (notes) logger.info(`SMS SOS note from ${phone}: "${notes}"`);

  const result = await createSOS({
    patientId: user.id,
    lat: Number(user.last_known_lat),
    lng: Number(user.last_known_lng),
    triggerMethod: 'sms',
  });

  logger.info(`SMS SOS created for ${user.full_name} (${phone}) → case ${result.caseNumber}`);
  return {
    success: true,
    caseId: result.caseId,
    caseNumber: result.caseNumber,
    patientName: user.full_name,
    usedLocation: {
      lat: Number(user.last_known_lat),
      lng: Number(user.last_known_lng),
      updatedAt: user.last_location_updated_at,
      stale,
    },
  };
}

// 6. Full case detail — the patient, the assigned driver, or the hospital the
// case is currently routed to (v2: the hospital dashboard opens this page).
export async function getCaseDetails(caseId, requestingUser) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select(
      `*,
       patient:patient_id(full_name, phone, medical_profiles(blood_group, gender, date_of_birth, chronic_conditions, allergies)),
       driver:drivers(user_id, vehicle_number, current_lat, current_lng, heading, users(full_name, phone)),
       hospital:hospital_id(name, lat, lng, emergency_phone),
       ai_report:ai_reports(urgency_level, emergency_type, consciousness_state, key_observations, first_aid_suggestion, resources_needed, pdf_url)`,
    )
    .eq('id', caseId)
    .maybeSingle();

  if (!emergencyCase) throw new Error('Case not found');

  // Accept a plain id for older callers as well as the full req.user object.
  const user = typeof requestingUser === 'string' ? { id: requestingUser } : requestingUser || {};

  const isPatient = emergencyCase.patient_id === user.id;
  const isDriver = emergencyCase.driver?.user_id === user.id;
  const isHospitalAdmin =
    user.role === 'hospital_admin' &&
    !!user.hospital_id &&
    emergencyCase.hospital_id === user.hospital_id;

  if (!isPatient && !isDriver && !isHospitalAdmin) {
    throw new Error('Not authorized to view this case');
  }

  return emergencyCase;
}

// 6a. The caller's currently-running case, if any. Lets the apps resume where
// the user left off instead of restarting at the home screen after a restart.
export async function getMyActiveCase(user) {
  const activeStatuses = ['pending', 'searching', 'driver_assigned', 'arrived', 'en_route'];

  let query = supabaseAdmin
    .from('emergency_cases')
    .select(
      `*,
       patient:patient_id(full_name, phone, medical_profiles(blood_group, gender, date_of_birth, chronic_conditions, allergies)),
       driver:drivers(user_id, vehicle_number, current_lat, current_lng, heading, users(full_name, phone)),
       hospital:hospital_id(name, lat, lng, emergency_phone),
       ai_report:ai_reports(urgency_level, emergency_type, consciousness_state, key_observations, first_aid_suggestion, resources_needed, pdf_url)`,
    )
    .in('status', activeStatuses)
    .order('sos_triggered_at', { ascending: false })
    .limit(1);

  if (user.role === 'driver') {
    if (!user.driver_id) return null;
    // A driver only has work to resume once they are actually assigned.
    query = query
      .eq('driver_id', user.driver_id)
      .in('status', ['driver_assigned', 'arrived', 'en_route']);
  } else {
    query = query.eq('patient_id', user.id);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// 6b. Road-following route for the case's current leg (patient or driver).
// driver_assigned  → driver's live position → patient (pickup leg)
// arrived          → patient → hospital (preview of the drop-off leg)
// en_route         → driver's live position → hospital (drop-off leg)
export async function getCaseRoute(caseId, requestingUserId) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select(
      `id, status, patient_id, patient_lat, patient_lng,
       driver:drivers(user_id, current_lat, current_lng),
       hospital:hospital_id(id, name, lat, lng)`,
    )
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');

  const isPatient = emergencyCase.patient_id === requestingUserId;
  const isDriver = emergencyCase.driver?.user_id === requestingUserId;
  if (!isPatient && !isDriver) throw new Error('Not authorized to view this case');

  const patient = { lat: Number(emergencyCase.patient_lat), lng: Number(emergencyCase.patient_lng) };
  const driver =
    emergencyCase.driver?.current_lat != null
      ? { lat: Number(emergencyCase.driver.current_lat), lng: Number(emergencyCase.driver.current_lng) }
      : null;
  const hospital =
    emergencyCase.hospital?.lat != null
      ? { lat: Number(emergencyCase.hospital.lat), lng: Number(emergencyCase.hospital.lng) }
      : null;

  let leg;
  let origin;
  let destination;
  switch (emergencyCase.status) {
    case 'driver_assigned':
      leg = 'pickup';
      origin = driver;
      destination = patient;
      break;
    case 'arrived':
      leg = 'dropoff';
      origin = patient;
      destination = hospital;
      break;
    case 'en_route':
      leg = 'dropoff';
      origin = driver || patient;
      destination = hospital;
      break;
    default:
      return { leg: null, coordinates: [] };
  }
  if (!origin || !destination) return { leg, coordinates: [] };

  const { routes } = await mapsService.getDirectionsRoute(
    origin.lat,
    origin.lng,
    destination.lat,
    destination.lng,
  );
  const route = routes[0];
  return {
    leg,
    origin,
    destination,
    coordinates: route?.coordinates || [],
    durationSeconds: route?.durationSeconds ?? null,
    distanceMeters: route?.distanceMeters ?? null,
  };
}

// 6c. Emergency-capable hospitals nearest to a point (for "change hospital").
export async function listNearbyHospitals({ lat, lng }) {
  const { data: hospitals, error } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, short_name, address, lat, lng, emergency_phone, has_emergency_ward, is_active')
    .eq('is_active', true)
    .eq('has_emergency_ward', true);
  if (error) throw new Error(error.message);

  return (hospitals || [])
    .filter((h) => h.lat != null && h.lng != null)
    .map((h) => {
      const distanceMeters = Math.round(
        mapsService.haversineDistance(Number(lat), Number(lng), Number(h.lat), Number(h.lng)),
      );
      return { ...h, distanceMeters, distanceText: `${(distanceMeters / 1000).toFixed(1)} km` };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

// 6d. Patient changes the destination hospital while the case is active.
export async function changeCaseHospital({ caseId, patientId, hospitalId }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, status, patient_id, driver_id, hospital_id, case_number')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.patient_id !== patientId) throw new Error('Not your case');

  const changeable = ['pending', 'searching', 'driver_assigned', 'arrived', 'en_route'];
  if (!changeable.includes(emergencyCase.status)) {
    throw new Error('Hospital can no longer be changed for this case');
  }

  const { data: hospital } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, lat, lng, is_active, has_emergency_ward')
    .eq('id', hospitalId)
    .maybeSingle();
  if (!hospital || !hospital.is_active) throw new Error('Hospital not found');
  if (!hospital.has_emergency_ward) throw new Error('Hospital has no emergency ward');

  const { error } = await supabaseAdmin
    .from('emergency_cases')
    .update({ hospital_id: hospitalId })
    .eq('id', caseId);
  if (error) throw new Error(error.message);

  // Notify everyone tracking this case (patient app + driver app), the hospital
  // that lost the case, and the hospital that gained it.
  const io = getIO();
  const payload = {
    caseId,
    hospitalId: hospital.id,
    hospitalName: hospital.name,
    hospitalLat: Number(hospital.lat),
    hospitalLng: Number(hospital.lng),
  };
  io?.to(ROOMS.caseRoom(caseId)).emit(EVENTS.EMERGENCY.HOSPITAL_CHANGED, payload);
  if (emergencyCase.driver_id) {
    io?.to(ROOMS.driverRoom(emergencyCase.driver_id)).emit(
      EVENTS.EMERGENCY.HOSPITAL_CHANGED,
      payload,
    );
  }
  if (emergencyCase.hospital_id && emergencyCase.hospital_id !== hospitalId) {
    io?.to(ROOMS.hospitalRoom(emergencyCase.hospital_id)).emit(EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE, {
      caseId,
      type: 'hospital_changed',
      transferredTo: hospital.name,
    });
  }
  io?.to(ROOMS.hospitalRoom(hospitalId)).emit(EVENTS.HOSPITAL.HOSPITAL_NEW_CASE, {
    caseId,
    caseNumber: emergencyCase.case_number,
    type: 'hospital_changed',
  });

  logger.info(`Case ${emergencyCase.case_number} hospital changed to ${hospital.name}`);
  return { success: true, hospital: payload };
}

// 7. Public family tracking (no auth — by share token).
export async function getShareTrackingData(shareToken) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select(
      `status, patient_lat, patient_lng, estimated_driver_arrival_seconds, share_token_expires_at,
       driver:drivers(current_lat, current_lng, heading),
       hospital:hospital_id(name, lat, lng)`,
    )
    .eq('share_token', shareToken)
    .maybeSingle();

  if (
    !emergencyCase ||
    !emergencyCase.share_token_expires_at ||
    new Date(emergencyCase.share_token_expires_at) < new Date()
  ) {
    throw new Error('Tracking link expired or invalid');
  }

  return {
    status: emergencyCase.status,
    patientLocation: { lat: emergencyCase.patient_lat, lng: emergencyCase.patient_lng },
    driverLocation: emergencyCase.driver
      ? {
          lat: emergencyCase.driver.current_lat,
          lng: emergencyCase.driver.current_lng,
          heading: emergencyCase.driver.heading,
        }
      : null,
    hospitalName: emergencyCase.hospital?.name || null,
    hospitalLocation: emergencyCase.hospital
      ? { lat: emergencyCase.hospital.lat, lng: emergencyCase.hospital.lng }
      : null,
    etaSeconds: emergencyCase.estimated_driver_arrival_seconds,
    expiresAt: emergencyCase.share_token_expires_at,
  };
}

// Full case list for a hospital admin's dashboard (Module 5 Cases view).
async function listHospitalCases({ hospitalId, date, status = 'all', limit = 20, offset = 0 }) {
  if (!hospitalId) throw new Error('No hospital associated with this account');

  // Pakistan is UTC+5 (no DST). Resolve the target day's UTC boundaries.
  const day = date || new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+05:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  let query = supabaseAdmin
    .from('emergency_cases')
    .select(
      `*,
       patient:patient_id(full_name, phone, medical_profiles(blood_group, gender, date_of_birth, chronic_conditions, allergies)),
       driver:drivers(vehicle_number, current_lat, current_lng, users(full_name, phone)),
       ai_report:ai_reports(urgency_level, emergency_type, consciousness_state, key_observations, first_aid_suggestion)`,
      { count: 'exact' },
    )
    .eq('hospital_id', hospitalId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('sos_triggered_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // 'active' groups the in-progress statuses; otherwise filter on the exact value.
  if (status === 'active') {
    query = query.in('status', ['driver_assigned', 'en_route', 'arrived']);
  } else if (status && status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return {
    cases: data || [],
    total: count || 0,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
  };
}

const VALID_BED_TYPES = ['general', 'icu', 'trauma', 'pediatric', 'maternity'];

// REST fallback for updating bed availability (socket is the primary path).
async function updateHospitalBeds({ hospitalId, userId, bedType, availableCount, reservedCount }) {
  if (!hospitalId) throw new Error('No hospital associated with this account');
  if (!VALID_BED_TYPES.includes(bedType)) throw new Error('Invalid bed type');

  const { data, error } = await supabaseAdmin
    .from('hospital_beds')
    .upsert(
      {
        hospital_id: hospitalId,
        bed_type: bedType,
        available_count: availableCount,
        reserved_count: reservedCount,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'hospital_id,bed_type' },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);

  // Broadcast to the hospital dashboard room so connected clients stay in sync.
  try {
    getIO()
      .to(ROOMS.hospitalRoom(hospitalId))
      .emit(EVENTS.HOSPITAL.BED_STATUS_CHANGED, {
        hospitalId,
        bedType,
        availableCount,
        reservedCount,
        updatedAt: data.updated_at,
      });
  } catch {
    // Socket server may not be initialised in some contexts — ignore.
  }

  return data;
}

export default {
  createSOS,
  driverRespondToCase,
  updateCaseStatus,
  cancelSOS,
  handleMissedCallSOS,
  handleSMSWebhook,
  getCaseDetails,
  getMyActiveCase,
  getCaseRoute,
  listNearbyHospitals,
  changeCaseHospital,
  getShareTrackingData,
  listHospitalCases,
  updateHospitalBeds,
};
