// Core dispatch engine: finds drivers with an expanding radius, notifies them
// in batches, waits for an accept, and assigns the winner to the case.
import crypto from 'crypto';

import { supabaseAdmin } from '../config/supabase.js';
import config from '../config/env.js';
import mapsService from './maps.service.js';
import notificationService from './notification.service.js'; // filled in B4 (best-effort)
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import logger from '../middleware/logger.js';

const DISPATCH_RADIUS_STEPS = [500, 1000, 2000, 5000]; // meters
const DRIVERS_PER_BATCH = 3;
const DRIVER_RESPONSE_TIMEOUT_MS = 15000; // 15 seconds
const MAX_DISPATCH_ATTEMPTS = DISPATCH_RADIUS_STEPS.length;

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

// 7. Mark a batch's still-pending requests as timed out.
export async function markBatchAsTimeout(caseId, driverBatch) {
  await supabaseAdmin
    .from('case_driver_requests')
    .update({ response: 'timeout', responded_at: new Date().toISOString() })
    .eq('case_id', caseId)
    .in('driver_id', driverBatch.map((d) => d.id))
    .eq('response', 'pending');
}

// 2. Notify up to DRIVERS_PER_BATCH drivers simultaneously.
export async function notifyDriverBatch(caseId, drivers, batchNumber) {
  const io = getIO();
  const batch = drivers.slice(0, DRIVERS_PER_BATCH);

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('case_number, patient_lat, patient_lng, patient:patient_id(full_name)')
    .eq('id', caseId)
    .maybeSingle();

  const patientName = emergencyCase?.patient?.full_name || 'Anonymous Patient';

  for (const driver of batch) {
    await supabaseAdmin.from('case_driver_requests').insert({
      case_id: caseId,
      driver_id: driver.id,
      batch_number: batchNumber,
      distance_meters: driver.distanceMeters,
      response: 'pending',
    });

    const payload = {
      caseId,
      caseNumber: emergencyCase?.case_number,
      patientName,
      patientLat: emergencyCase?.patient_lat,
      patientLng: emergencyCase?.patient_lng,
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
  }

  logger.info(`Notified batch ${batchNumber} (${batch.length} drivers) for case ${caseId}`);
  return batch;
}

// 3. Wait for any driver in the batch to accept (or time out).
export async function waitForDriverResponse(caseId, batch, timeoutMs) {
  const io = getIO();
  const batchIds = batch.map((d) => d.id);

  const acceptedId = await new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const interval = setInterval(async () => {
      const { data } = await supabaseAdmin
        .from('case_driver_requests')
        .select('driver_id, response')
        .eq('case_id', caseId)
        .in('driver_id', batchIds);

      const accepted = (data || []).find((r) => r.response === 'accepted');
      if (accepted) return finish(accepted.driver_id);

      const allDeclined =
        data && data.length === batchIds.length && data.every((r) => r.response === 'declined');
      if (allDeclined) return finish(null);
    }, 2000);
  });

  if (acceptedId) {
    // Cancel the other drivers in this batch.
    const losers = batchIds.filter((id) => id !== acceptedId);
    if (losers.length > 0) {
      await supabaseAdmin
        .from('case_driver_requests')
        .update({ response: 'timeout', responded_at: new Date().toISOString() })
        .eq('case_id', caseId)
        .in('driver_id', losers)
        .eq('response', 'pending');
      losers.forEach((id) => {
        io?.to(ROOMS.driverRoom(id)).emit(EVENTS.EMERGENCY.CASE_CANCELLED, {
          caseId,
          reason: 'taken_by_other',
        });
      });
    }
  }

  return acceptedId;
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
    .select('patient_id, patient_lat, patient_lng, hospital_id, case_number')
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

  const shareToken = crypto.randomBytes(32).toString('hex');
  const shareTokenExpiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

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

  io?.to(ROOMS.patientRoom(emergencyCase.patient_id)).emit(EVENTS.EMERGENCY.DRIVER_ASSIGNED, payload);

  if (emergencyCase.hospital_id) {
    io?.to(ROOMS.hospitalRoom(emergencyCase.hospital_id)).emit(EVENTS.HOSPITAL.HOSPITAL_NEW_CASE, {
      ...payload,
      patientLat: emergencyCase.patient_lat,
      patientLng: emergencyCase.patient_lng,
    });
  }

  logger.info(`Driver ${driverId} assigned to case ${caseId} (ETA ${eta.durationText})`);
  return payload;
}

// 5. The full dispatch loop: expand radius until a driver accepts or all fail.
export async function runDispatchCycle(caseId, patientLat, patientLng) {
  const io = getIO();

  const { data: caseRow } = await supabaseAdmin
    .from('emergency_cases')
    .select('patient_id')
    .eq('id', caseId)
    .maybeSingle();
  const patientId = caseRow?.patient_id;

  await supabaseAdmin.from('emergency_cases').update({ status: 'searching' }).eq('id', caseId);

  for (let attempt = 0; attempt < MAX_DISPATCH_ATTEMPTS; attempt++) {
    const radius = DISPATCH_RADIUS_STEPS[attempt];
    logger.info(`Dispatch attempt ${attempt + 1}: radius ${radius}m for case ${caseId}`);

    const drivers = await findAvailableDrivers(patientLat, patientLng, radius);
    if (drivers.length === 0) {
      logger.info(`No drivers found in ${radius}m radius`);
      continue;
    }

    const alreadyNotified = await getAlreadyNotifiedDriverIds(caseId);
    const freshDrivers = drivers.filter((d) => !alreadyNotified.includes(d.id));
    if (freshDrivers.length === 0) continue;

    const batch = await notifyDriverBatch(caseId, freshDrivers, attempt + 1);
    const acceptingDriverId = await waitForDriverResponse(caseId, batch, DRIVER_RESPONSE_TIMEOUT_MS);

    if (acceptingDriverId) {
      const result = await assignDriver(caseId, acceptingDriverId);
      return { success: true, ...result };
    }

    await markBatchAsTimeout(caseId, batch);
  }

  // No driver found across all radii.
  await supabaseAdmin
    .from('emergency_cases')
    .update({ status: 'no_driver_found' })
    .eq('id', caseId);

  if (patientId) {
    io?.to(ROOMS.patientRoom(patientId)).emit(EVENTS.EMERGENCY.NO_DRIVER_FOUND, {
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

  logger.info(`No driver found for case ${caseId} after ${MAX_DISPATCH_ATTEMPTS} attempts`);
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
  notifyDriverBatch,
  waitForDriverResponse,
  assignDriver,
  runDispatchCycle,
  handoffCase,
  getAlreadyNotifiedDriverIds,
  markBatchAsTimeout,
};
