// Case orchestration: creating an SOS (and kicking off dispatch), driver
// responses, status transitions, cancellation, and case/tracking lookups.
import { supabaseAdmin } from '../config/supabase.js';
import dispatchService from './dispatch.service.js';
import mapsService from './maps.service.js';
import hospitalAssignment from './hospital-assignment.service.js';
import caseTokenService from './case-token.service.js';
import whatsappNotifier from './whatsapp/notifier.js';
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import logger from '../middleware/logger.js';

// 1. Create an SOS case and start dispatch in the background.
//
// No hospital is attached here. A hospital only sees a case once an ambulance
// has accepted AND the patient has confirmed (or changed) the suggested
// hospital — so dashboards never list requests nobody is responding to.
export async function createSOS({
  patientId = null,
  lat,
  lng,
  accuracy,
  address,
  reporterPhone = null,
  reporterName = null,
  reportedFor = 'self',
  channel = 'app',
}) {
  // Nearest emergency-capable hospital — returned only as a suggestion.
  const { data: hospitals } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('has_emergency_ward', true)
    .eq('is_active', true);
  const nearestHospital = mapsService.findNearestHospital(lat, lng, hospitals || []);

  // The tracking link is issued now rather than on driver assignment: a
  // WhatsApp or web reporter needs something to watch while the search runs.
  const shareToken = caseTokenService.generateShareToken();

  let created = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    const { data, error } = await supabaseAdmin
      .from('emergency_cases')
      .insert({
        patient_id: patientId,
        patient_lat: lat,
        patient_lng: lng,
        patient_address: address || null,
        hospital_id: null,
        status: 'pending',
        trigger_method: 'app_sos',
        channel,
        reported_for: reportedFor,
        reporter_phone: reporterPhone,
        reporter_name: reporterName,
        access_code: caseTokenService.generateAccessCode(),
        share_token: shareToken,
        share_token_expires_at: caseTokenService.shareTokenExpiry(),
        sos_triggered_at: new Date().toISOString(),
      })
      .select('id, case_number, access_code')
      .single();

    if (!error) {
      created = data;
      break;
    }
    lastError = error;
    // 23505 is a unique violation: retry with a fresh code. Anything else is a
    // real failure and retrying would only delay the ambulance.
    if (error.code !== '23505') break;
  }

  if (!created) throw new Error(lastError?.message || 'Could not create emergency case');

  // Run the dispatch loop in the background — return to the patient immediately.
  dispatchService
    .runDispatchCycle(created.id, lat, lng)
    .catch((err) => logger.error(`Dispatch cycle error: ${err.message}`));

  return {
    caseId: created.id,
    caseNumber: created.case_number,
    // How an anonymous reporter reaches this case again: the code to type, the
    // token their client holds, and the link to open or forward.
    accessCode: created.access_code,
    caseToken: caseTokenService.issueCaseToken({ caseId: created.id, channel }),
    trackingUrl: caseTokenService.trackingUrl(shareToken),
    channel,
    reportedFor,
    status: 'searching',
    // The patient app builds its tracking map from this response; without the
    // coordinates it placed the patient marker at 0,0.
    patient_lat: lat,
    patient_lng: lng,
    hospital_id: null,
    // Offered to the patient as the default once an ambulance accepts. Kept
    // out of `hospital` so the app never treats it as already chosen.
    suggested_hospital: nearestHospital
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

  // Once the patient is aboard the ambulance needs a destination. If the
  // patient never confirmed one, fall back to the nearest emergency hospital.
  if (status === 'en_route' && !emergencyCase.hospital_id) {
    try {
      await hospitalAssignment.autoAssignNearestHospital(caseId);
    } catch (err) {
      logger.warn(`Auto hospital assignment at pickup failed for ${caseId}: ${err.message}`);
    }
  }

  // Free the driver once the trip is complete.
  if (status === 'completed') {
    await supabaseAdmin.from('drivers').update({ is_available: true }).eq('id', driverId);
  }

  // Ride milestones reach a chat user as messages, not socket events.
  whatsappNotifier.safely(whatsappNotifier.notifyStatus(caseId, status), `status ${status}`);

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
export async function cancelSOS({ caseId, patientId = null, viaCaseToken = false, reason = 'false_alarm' }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, status, driver_id, patient_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  // A case token was already matched against this case id by the middleware,
  // and its holder may have no account to compare against.
  if (!viaCaseToken && emergencyCase.patient_id !== patientId) {
    throw new Error('Not your case');
  }

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

  // A case token already proves access to this one case — that is its entire
  // purpose, and its holder may have no account at all.
  const hasCaseToken = user.caseScopedCaseId === caseId;
  const isPatient = !!user.id && emergencyCase.patient_id === user.id;
  const isDriver = !!user.id && emergencyCase.driver?.user_id === user.id;
  const isHospitalAdmin =
    user.role === 'hospital_admin' &&
    !!user.hospital_id &&
    emergencyCase.hospital_id === user.hospital_id;

  if (!hasCaseToken && !isPatient && !isDriver && !isHospitalAdmin) {
    throw new Error('Not authorized to view this case');
  }

  return emergencyCase;
}

// 6z. Attach an anonymous case to an account, using the code the reporter kept.
//
// This is the only path from "I needed help and had no account" to "this is in
// my history" — the account is offered after the emergency, never before it.
export async function claimCaseByAccessCode({ accessCode, patientId }) {
  const found = await caseTokenService.caseFromAccessCode(accessCode);
  if (!found) throw new Error('No request found for that code');

  const { data: existing } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, patient_id')
    .eq('id', found.id)
    .maybeSingle();

  if (existing?.patient_id && existing.patient_id !== patientId) {
    throw new Error('This request is already linked to another account');
  }

  const { data, error } = await supabaseAdmin
    .from('emergency_cases')
    .update({ patient_id: patientId })
    .eq('id', found.id)
    .select('id, case_number, status')
    .single();
  if (error) throw new Error(error.message);

  // The report carries its own patient_id, which history queries filter on.
  await supabaseAdmin
    .from('ai_reports')
    .update({ patient_id: patientId })
    .eq('case_id', found.id)
    .is('patient_id', null);

  logger.info(`Case ${data.case_number} claimed by user ${patientId}`);
  return { caseId: data.id, caseNumber: data.case_number, status: data.status };
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
export async function getCaseRoute(caseId, requester) {
  // Accepts a plain user id (older callers), a req.user object, or the
  // case-token shape produced by case-auth middleware.
  const user = typeof requester === 'string' ? { id: requester } : requester || {};
  const requestingUserId = user.id;
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

  const hasCaseToken = user.caseScopedCaseId === caseId;
  const isPatient = !!requestingUserId && emergencyCase.patient_id === requestingUserId;
  const isDriver = !!requestingUserId && emergencyCase.driver?.user_id === requestingUserId;
  if (!hasCaseToken && !isPatient && !isDriver) {
    throw new Error('Not authorized to view this case');
  }

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

// 6d. Patient confirms the suggested hospital, or picks a different one.
// Until this runs an app-triggered case has no hospital, so no dashboard shows
// it — see hospital-assignment.service.js.
export async function changeCaseHospital({ caseId, patientId, hospitalId }) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, status, patient_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.patient_id !== patientId) throw new Error('Not your case');

  // A hospital is chosen after an ambulance accepts — never while still
  // searching, which is exactly the request a hospital should not see.
  const changeable = ['driver_assigned', 'arrived', 'en_route'];
  if (!changeable.includes(emergencyCase.status)) {
    throw new Error(
      ['pending', 'searching'].includes(emergencyCase.status)
        ? 'You can choose a hospital once an ambulance has accepted your request'
        : 'Hospital can no longer be changed for this case',
    );
  }

  const result = await hospitalAssignment.assignHospitalToCase({
    caseId,
    hospitalId,
    source: 'patient',
  });
  return { success: true, hospital: result.hospital };
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
  getCaseDetails,
  getMyActiveCase,
  getCaseRoute,
  listNearbyHospitals,
  changeCaseHospital,
  getShareTrackingData,
  claimCaseByAccessCode,
  listHospitalCases,
  updateHospitalBeds,
};
