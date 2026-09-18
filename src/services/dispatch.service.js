// Core dispatch engine: offers the case to the nearest drivers ONE AT A TIME,
// three per search ring, widens the radius when a ring is exhausted, and
// assigns the first driver who accepts.
import { supabaseAdmin } from '../config/supabase.js';
import caseTokenService from './case-token.service.js';
import whatsappNotifier from './whatsapp/notifier.js';
import config from '../config/env.js';
import mapsService from './maps.service.js';
import notificationService from './notification.service.js'; // filled in B4 (best-effort)
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import logger from '../middleware/logger.js';

// Search rings, in meters. Each ring offers the case to at most
// DRIVERS_PER_RING drivers not already asked, nearest first.
const DISPATCH_RADIUS_STEPS = [2000, 5000, 10000, 20000];
const DRIVERS_PER_RING = 3;
// What the driver's request screen counts down from.
const DRIVER_RESPONSE_TIMEOUT_MS = 15000;
// Extra server-side wait, so an accept tapped in the last second — still in
// flight — is not thrown away as a timeout.
const RESPONSE_GRACE_MS = 3000;
const POLL_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Available, verified drivers within radius (closest first).
export async function findAvailableDrivers(patientLat, patientLng, radiusMeters) {
  const { data: drivers, error } = await supabaseAdmin
    .from('drivers')
    .select('id, user_id, vehicle_number, current_lat, current_lng, heading, users(full_name, phone, fcm_token)')
    .eq('is_available', true)
    .eq('is_verified', true)
    .not('current_lat', 'is', null)
    .not('current_lng', 'is', null);

  if (error || !drivers) return [];

  const sorted = mapsService.findNearestDrivers(patientLat, patientLng, drivers, drivers.length);
  return sorted.filter((d) => d.distanceMeters <= radiusMeters);
}

// 6. Driver ids already notified for this case (avoid re-notifying).
export async function getAlreadyNotifiedDriverIds(caseId) {
  const { data } = await supabaseAdmin
    .from('case_driver_requests')
    .select('driver_id')
    .eq('case_id', caseId);
  return (data || []).map((r) => r.driver_id);
}

// 7. Close a request the driver never answered.
export async function markRequestTimedOut(caseId, driverId) {
  await supabaseAdmin
    .from('case_driver_requests')
    .update({ response: 'timeout', responded_at: new Date().toISOString() })
    .eq('case_id', caseId)
    .eq('driver_id', driverId)
    .eq('response', 'pending');
}

// True while the case is still looking for an ambulance. Checked before every
// offer so a patient who cancels stops the search immediately.
async function caseStillSearching(caseId) {
  const { data } = await supabaseAdmin
    .from('emergency_cases')
    .select('status')
    .eq('id', caseId)
    .maybeSingle();
  return data?.status === 'searching';
}

// 2. Offer the case to a single driver.
export async function notifyDriver(caseId, driver, ringNumber, caseInfo) {
  const io = getIO();

  await supabaseAdmin.from('case_driver_requests').insert({
    case_id: caseId,
    driver_id: driver.id,
    batch_number: ringNumber,
    distance_meters: driver.distanceMeters,
    response: 'pending',
  });

  const payload = {
    caseId,
    caseNumber: caseInfo.caseNumber,
    patientName: caseInfo.patientName,
    patientLat: caseInfo.patientLat,
    patientLng: caseInfo.patientLng,
    distanceMeters: driver.distanceMeters,
    distanceText: driver.distanceText,
    urgencyLevel: 'unknown', // AI report not generated yet
    timeoutMs: DRIVER_RESPONSE_TIMEOUT_MS,
  };

  io?.to(ROOMS.driverRoom(driver.id)).emit(EVENTS.EMERGENCY.CASE_CREATED, payload);

  // Best-effort FCM push (works even if the app is backgrounded). Never blocks dispatch.
  try {
    await notificationService?.sendDriverDispatchNotification?.(driver.users?.fcm_token, payload);
  } catch (err) {
    logger.warn(`FCM dispatch notify failed: ${err.message}`);
  }

  logger.info(
    `Offered case ${caseId} to driver ${driver.id} (ring ${ringNumber}, ${driver.distanceText})`,
  );
}

// 3. Wait for that driver's answer.
// Resolves 'accepted' | 'declined' | 'timeout' | 'cancelled'.
export async function waitForDriverDecision(caseId, driverId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ data: request }, { data: emergencyCase }] = await Promise.all([
      supabaseAdmin
        .from('case_driver_requests')
        .select('response')
        .eq('case_id', caseId)
        .eq('driver_id', driverId)
        .maybeSingle(),
      supabaseAdmin.from('emergency_cases').select('status').eq('id', caseId).maybeSingle(),
    ]);

    if (emergencyCase && emergencyCase.status !== 'searching') return 'cancelled';
    if (request?.response === 'accepted') return 'accepted';
    // A decline moves straight on to the next driver — no waiting it out.
    if (request?.response === 'declined') return 'declined';

    await sleep(POLL_INTERVAL_MS);
  }
  return 'timeout';
}

// 4. Assign the accepting driver to the case.
export async function assignDriver(caseId, driverId) {
  const io = getIO();

  const { data: driver } = await supabaseAdmin
    .from('drivers')
    .select('id, vehicle_number, current_lat, current_lng, users(full_name, phone)')
    .eq('id', driverId)
    .maybeSingle();

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select(
      'patient_id, patient_lat, patient_lng, hospital_id, case_number, share_token, share_token_expires_at',
    )
    .eq('id', caseId)
    .maybeSingle();

  if (!driver || !emergencyCase) {
    throw new Error('Driver or case not found during assignment');
  }

  const eta = await mapsService.getDistanceAndETA(
    Number(driver.current_lat),
    Number(driver.current_lng),
    Number(emergencyCase.patient_lat),
    Number(emergencyCase.patient_lng),
  );

  // The tracking link is issued when the case is created, so by now it may
  // already be on the patient's screen or in a WhatsApp thread. Minting a new
  // one here would silently break the link they are watching.
  const shareToken = emergencyCase.share_token || caseTokenService.generateShareToken();
  const shareTokenExpiresAt =
    emergencyCase.share_token_expires_at || caseTokenService.shareTokenExpiry();

  await supabaseAdmin
    .from('emergency_cases')
    .update({
      driver_id: driverId,
      status: 'driver_assigned',
      driver_assigned_at: new Date().toISOString(),
      estimated_driver_arrival_seconds: eta.durationSeconds,
      share_token: shareToken,
      share_token_expires_at: shareTokenExpiresAt,
    })
    .eq('id', caseId);

  await supabaseAdmin.from('drivers').update({ is_available: false }).eq('id', driverId);

  const payload = {
    id: caseId,
    caseId,
    case_number: emergencyCase.case_number,
    caseNumber: emergencyCase.case_number,
    driver_id: driver.id,
    status: 'driver_assigned',
    driver: {
      id: driver.id,
      fullName: driver.users?.full_name,
      phone: driver.users?.phone,
      vehicleNumber: driver.vehicle_number,
      currentLat: driver.current_lat,
      currentLng: driver.current_lng,
    },
    etaSeconds: eta.durationSeconds,
    etaText: eta.durationText,
    distanceText: eta.distanceText,
    shareToken,
    shareUrl: `${config.frontendUrl}/track/${shareToken}`,
  };

  // An anonymous reporter has no personal room — their app, web page or
  // WhatsApp link watches the case room instead.
  const patientTarget = emergencyCase.patient_id
    ? ROOMS.patientRoom(emergencyCase.patient_id)
    : ROOMS.caseRoom(caseId);
  io?.to(patientTarget).emit(EVENTS.EMERGENCY.DRIVER_ASSIGNED, payload);

  // A chat user cannot listen to a socket, so the same news goes to WhatsApp.
  // No-op for app and web cases.
  whatsappNotifier.safely(
    whatsappNotifier.notifyDriverAssigned(caseId, payload),
    'driver assigned',
  );

  // Hospitals are NOT told here. The patient confirms (or changes) the
  // suggested hospital first, and only that choice reaches a dashboard.

  logger.info(`Driver ${driverId} assigned to case ${caseId} (ETA ${eta.durationText})`);
  return payload;
}

// 5. The full dispatch loop.
// For each ring: take the (up to) three nearest drivers not yet asked and offer
// the case to them one by one. If none accepts, widen the ring and repeat.
export async function runDispatchCycle(caseId, patientLat, patientLng) {
  const io = getIO();

  const { data: caseRow } = await supabaseAdmin
    .from('emergency_cases')
    .select('patient_id, case_number, patient:patient_id(full_name)')
    .eq('id', caseId)
    .maybeSingle();
  const patientId = caseRow?.patient_id;
  const caseInfo = {
    caseNumber: caseRow?.case_number,
    patientName: caseRow?.patient?.full_name || 'Anonymous Patient',
    patientLat,
    patientLng,
  };

  await supabaseAdmin.from('emergency_cases').update({ status: 'searching' }).eq('id', caseId);

  for (let ring = 0; ring < DISPATCH_RADIUS_STEPS.length; ring++) {
    const radius = DISPATCH_RADIUS_STEPS[ring];

    const drivers = await findAvailableDrivers(patientLat, patientLng, radius);
    const alreadyAsked = await getAlreadyNotifiedDriverIds(caseId);
    const candidates = drivers
      .filter((d) => !alreadyAsked.includes(d.id))
      .slice(0, DRIVERS_PER_RING);

    logger.info(
      `Dispatch ring ${ring + 1} (${radius}m): ${candidates.length} new driver(s) for case ${caseId}`,
    );

    for (const driver of candidates) {
      if (!(await caseStillSearching(caseId))) {
        logger.info(`Dispatch stopped for case ${caseId}: no longer searching`);
        return { success: false, reason: 'cancelled' };
      }

      await notifyDriver(caseId, driver, ring + 1, caseInfo);
      const decision = await waitForDriverDecision(
        caseId,
        driver.id,
        DRIVER_RESPONSE_TIMEOUT_MS + RESPONSE_GRACE_MS,
      );

      if (decision === 'accepted') {
        const result = await assignDriver(caseId, driver.id);
        return { success: true, ...result };
      }
      if (decision === 'cancelled') {
        logger.info(`Dispatch stopped for case ${caseId}: cancelled while waiting`);
        return { success: false, reason: 'cancelled' };
      }
      if (decision === 'timeout') await markRequestTimedOut(caseId, driver.id);
      logger.info(`Driver ${driver.id} ${decision} case ${caseId} — trying next`);
    }
  }

  // A patient who cancelled should not be told "no driver found".
  if (!(await caseStillSearching(caseId))) return { success: false, reason: 'cancelled' };

  // No driver found across all rings.
  await supabaseAdmin
    .from('emergency_cases')
    .update({ status: 'no_driver_found' })
    .eq('id', caseId);

  {
    const target = patientId ? ROOMS.patientRoom(patientId) : ROOMS.caseRoom(caseId);
    io?.to(target).emit(EVENTS.EMERGENCY.NO_DRIVER_FOUND, {
      caseId,
      message: 'No ambulance available. Please call 1122, Edhi (115), or Chhipa (1020).',
      emergencyNumbers: [
        { name: 'Rescue 1122', number: '1122' },
        { name: 'Edhi Foundation', number: '115' },
        { name: 'Chhipa Welfare', number: '1020' },
        { name: 'Police Emergency', number: '15' },
      ],
    });
  }

  whatsappNotifier.safely(whatsappNotifier.notifyNoDriver(caseId), 'no driver found');

  logger.info(`No driver found for case ${caseId} across ${DISPATCH_RADIUS_STEPS.length} rings`);
  return { success: false, reason: 'no_driver_found' };
}

// 10. Hand the case over to another nearby driver.
// Real ambulances break down and get stuck in traffic; without this the
// patient would keep waiting on a vehicle that cannot reach them.
export async function handoffCase({ caseId, currentDriverId, reason }) {
  const io = getIO();

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, case_number, driver_id, status, patient_id, patient_lat, patient_lng, hospital_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.driver_id !== currentDriverId) throw new Error('Not your case');

  // Once the patient is aboard, swapping vehicles is a physical transfer that
  // cannot be arranged from this screen.
  if (!['driver_assigned', 'arrived'].includes(emergencyCase.status)) {
    throw new Error('Handoff is only possible before the patient is picked up');
  }

  // Nearest available driver to the patient, excluding this one. Radius grows
  // the same way the original dispatch does.
  let replacement = null;
  for (const radius of [2000, 5000, 10000, 20000]) {
    // eslint-disable-next-line no-await-in-loop
    const candidates = await findAvailableDrivers(
      Number(emergencyCase.patient_lat),
      Number(emergencyCase.patient_lng),
      radius,
    );
    replacement = candidates.find((d) => d.id !== currentDriverId) || null;
    if (replacement) break;
  }
  if (!replacement) {
    throw new Error('No other ambulance is available nearby right now');
  }

  const eta = await mapsService.getDistanceAndETA(
    Number(replacement.current_lat),
    Number(replacement.current_lng),
    Number(emergencyCase.patient_lat),
    Number(emergencyCase.patient_lng),
  );

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('emergency_cases')
    .update({
      driver_id: replacement.id,
      status: 'driver_assigned', // the new driver still has to reach the patient
      driver_assigned_at: now,
      driver_arrived_at: null,
      estimated_driver_arrival_seconds: eta.durationSeconds,
    })
    .eq('id', caseId);
  if (error) throw new Error(error.message);

  // Free the old ambulance, reserve the new one.
  await supabaseAdmin.from('drivers').update({ is_available: true }).eq('id', currentDriverId);
  await supabaseAdmin.from('drivers').update({ is_available: false }).eq('id', replacement.id);

  const { data: oldDriver } = await supabaseAdmin
    .from('drivers')
    .select('vehicle_number, users(full_name)')
    .eq('id', currentDriverId)
    .maybeSingle();

  const payload = {
    caseId,
    caseNumber: emergencyCase.case_number,
    reason: reason || null,
    previousDriver: {
      id: currentDriverId,
      fullName: oldDriver?.users?.full_name,
      vehicleNumber: oldDriver?.vehicle_number,
    },
    driver: {
      id: replacement.id,
      fullName: replacement.users?.full_name,
      phone: replacement.users?.phone,
      vehicleNumber: replacement.vehicle_number,
      currentLat: replacement.current_lat,
      currentLng: replacement.current_lng,
    },
    etaSeconds: eta.durationSeconds,
    etaText: eta.durationText,
    timestamp: now,
  };

  // Patient: new driver details + ETA so tracking re-points at the new vehicle.
  io?.to(ROOMS.caseRoom(caseId)).emit(EVENTS.EMERGENCY.DRIVER_CHANGED, payload);
  io?.to(ROOMS.patientRoom(emergencyCase.patient_id)).emit(
    EVENTS.EMERGENCY.DRIVER_CHANGED,
    payload,
  );

  // Old driver: release their navigation screen.
  io?.to(ROOMS.driverRoom(currentDriverId)).emit(EVENTS.EMERGENCY.HANDOFF_RELEASED, {
    caseId,
    newDriverName: replacement.users?.full_name,
  });

  // New driver: this arrives as a normal assignment.
  io?.to(ROOMS.driverRoom(replacement.id)).emit(EVENTS.EMERGENCY.DRIVER_ASSIGNED, payload);

  if (emergencyCase.hospital_id) {
    io?.to(ROOMS.hospitalRoom(emergencyCase.hospital_id)).emit(
      EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE,
      { caseId, type: 'driver_changed', ...payload },
    );
  }

  // Best-effort push to the driver taking over.
  try {
    await notificationService?.sendDriverDispatchNotification?.(replacement.users?.fcm_token, {
      caseId,
      caseNumber: emergencyCase.case_number,
      patientName: 'Patient',
      distanceText: eta.distanceText,
    });
  } catch (err) {
    logger.warn(`FCM handoff notify failed: ${err.message}`);
  }

  // Visible in the case feed on the hospital dashboard.
  try {
    await supabaseAdmin.from('case_messages').insert({
      case_id: caseId,
      sender_role: 'driver',
      message_key: 'handoff',
      message_text: `Ambulance handed over to ${replacement.users?.full_name || 'another driver'}${
        reason ? ` — ${reason}` : ''
      }`,
    });
  } catch {
    // The feed entry is history, never a reason to fail the handoff.
  }

  logger.info(
    `Case ${emergencyCase.case_number} handed off ${currentDriverId} -> ${replacement.id} (ETA ${eta.durationText})`,
  );
  return payload;
}

export default {
  findAvailableDrivers,
  notifyDriver,
  waitForDriverDecision,
  assignDriver,
  runDispatchCycle,
  handoffCase,
  getAlreadyNotifiedDriverIds,
  markRequestTimedOut,
};
