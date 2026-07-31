// Hospital decisions on an incoming case: accept, redirect to another
// hospital, and the preset quick-message exchange with the driver.
//
// This is the receptionist's real job in v2: See -> Read -> Decide ->
// Communicate. Everything here is the "Decide" and "Communicate" half.
import { supabaseAdmin } from '../config/supabase.js';
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import mapsService from './maps.service.js';
import notificationService from './notification.service.js';
import {
  QUICK_MESSAGES,
  REDIRECT_REASONS,
  PREPARATION_NOTES,
  getMessageByKey,
} from '../constants/quick.messages.js';
import logger from '../middleware/logger.js';

// Emit helper — sockets are optional in tests/scripts, never let them throw.
function emit(room, event, payload) {
  try {
    getIO()?.to(room).emit(event, payload);
  } catch {
    /* socket layer not running */
  }
}

// Look up the assigned driver's FCM token for a case.
async function getDriverPushToken(driverId) {
  if (!driverId) return null;
  const { data } = await supabaseAdmin
    .from('drivers')
    .select('users(fcm_token)')
    .eq('id', driverId)
    .maybeSingle();
  return data?.users?.fcm_token || null;
}

// Append a row to the case's message feed. Best-effort: the log is history,
// never a reason to fail the decision itself.
async function logCaseMessage({ caseId, senderRole, senderUserId, messageKey, messageText }) {
  const { data, error } = await supabaseAdmin
    .from('case_messages')
    .insert({
      case_id: caseId,
      sender_role: senderRole,
      sender_user_id: senderUserId || null,
      message_key: messageKey,
      message_text: messageText,
    })
    .select()
    .single();
  if (error) {
    logger.warn(`case_messages insert failed for ${caseId}: ${error.message}`);
    return null;
  }
  return data;
}

// --- 1. Accept ---------------------------------------------------------------

export async function acceptCase({ caseId, hospitalAdminUserId, hospitalId, preparationNote }) {
  if (preparationNote != null && !PREPARATION_NOTES.includes(preparationNote)) {
    throw new Error('Invalid preparation note');
  }

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, case_number, hospital_id, driver_id, hospital_decision')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.hospital_id !== hospitalId) throw new Error('Case does not belong to your hospital');
  if (emergencyCase.hospital_decision !== 'awaiting_review') throw new Error('Case already decided');

  const timestamp = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('emergency_cases')
    .update({
      hospital_decision: 'accepted',
      decision_at: timestamp,
      decision_by: hospitalAdminUserId,
      preparation_note: preparationNote || null,
    })
    .eq('id', caseId);
  if (error) throw new Error(error.message);

  const { data: hospital } = await supabaseAdmin
    .from('hospitals')
    .select('name')
    .eq('id', hospitalId)
    .maybeSingle();
  const hospitalName = hospital?.name || 'Hospital';

  const payload = {
    caseId,
    decision: 'accepted',
    hospitalName,
    preparationNote: preparationNote || null,
    timestamp,
  };

  // Driver and patient both listen in the case room. The driver room is
  // targeted too so the decision still lands if their app reconnected and has
  // not rejoined the case room yet.
  emit(ROOMS.caseRoom(caseId), EVENTS.DECISION.CASE_ACCEPTED, payload);
  emit(ROOMS.hospitalRoom(hospitalId), EVENTS.DECISION.CASE_ACCEPTED, payload);
  if (emergencyCase.driver_id) {
    emit(ROOMS.driverRoom(emergencyCase.driver_id), EVENTS.DECISION.CASE_ACCEPTED, payload);
  }

  const token = await getDriverPushToken(emergencyCase.driver_id);
  await notificationService.sendDriverDecisionNotification(token, {
    title: 'Hospital accepted',
    body: `${hospitalName} accepted the patient${preparationNote ? ` — ${preparationNote}` : ''}`,
    data: { type: 'case_accepted', caseId },
  });

  await logCaseMessage({
    caseId,
    senderRole: 'hospital',
    senderUserId: hospitalAdminUserId,
    messageKey: 'accepted',
    messageText: `Hospital accepted the patient${preparationNote ? ` — ${preparationNote}` : ''}`,
  });

  logger.info(`Case ${emergencyCase.case_number} accepted by ${hospitalName}`);
  return payload;
}

// --- 2. Redirect -------------------------------------------------------------

export async function redirectCase({
  caseId,
  hospitalAdminUserId,
  hospitalId,
  newHospitalId,
  reason,
}) {
  if (!REDIRECT_REASONS.includes(reason)) throw new Error('Invalid redirect reason');
  if (newHospitalId === hospitalId) throw new Error('Cannot redirect a case to the same hospital');

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, case_number, hospital_id, driver_id, hospital_decision, patient_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');
  if (emergencyCase.hospital_id !== hospitalId) throw new Error('Case does not belong to your hospital');
  if (emergencyCase.hospital_decision !== 'awaiting_review') throw new Error('Case already decided');

  const { data: newHospital } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, lat, lng, is_active, facility_type')
    .eq('id', newHospitalId)
    .maybeSingle();
  if (!newHospital || !newHospital.is_active) throw new Error('Destination hospital not found');
  // Camps are not valid redirect targets here — low-urgency camp routing is
  // wired separately in Phase 6.
  if (newHospital.facility_type !== 'hospital') throw new Error('Destination must be a hospital');

  const timestamp = new Date().toISOString();

  // Recalculate ETA from the driver's current position to the new hospital.
  let newEtaSeconds = null;
  let newEtaText = null;
  try {
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('current_lat, current_lng')
      .eq('id', emergencyCase.driver_id)
      .maybeSingle();
    if (driver?.current_lat != null && newHospital.lat != null) {
      const eta = await mapsService.getDistanceAndETA(
        Number(driver.current_lat),
        Number(driver.current_lng),
        Number(newHospital.lat),
        Number(newHospital.lng),
      );
      newEtaSeconds = eta.durationSeconds;
      newEtaText = eta.durationText;
    }
  } catch (err) {
    logger.warn(`ETA recalculation after redirect failed: ${err.message}`);
  }

  const update = {
    // The new hospital must make its own decision.
    hospital_decision: 'awaiting_review',
    redirected_from_hospital_id: hospitalId,
    redirect_reason: reason,
    decision_at: timestamp,
    decision_by: hospitalAdminUserId,
    hospital_id: newHospitalId, // THE KEY REASSIGNMENT
  };
  if (newEtaSeconds != null) update.estimated_driver_arrival_seconds = newEtaSeconds;

  const { error } = await supabaseAdmin.from('emergency_cases').update(update).eq('id', caseId);
  if (error) throw new Error(error.message);

  const { data: oldHospital } = await supabaseAdmin
    .from('hospitals')
    .select('name')
    .eq('id', hospitalId)
    .maybeSingle();
  const oldHospitalName = oldHospital?.name || 'Previous hospital';

  const payload = {
    caseId,
    oldHospitalName,
    newHospital: {
      id: newHospital.id,
      name: newHospital.name,
      lat: Number(newHospital.lat),
      lng: Number(newHospital.lng),
    },
    reason,
    newEtaSeconds,
    newEtaText,
    timestamp,
  };

  // Driver + patient.
  emit(ROOMS.caseRoom(caseId), EVENTS.DECISION.CASE_REDIRECTED, payload);
  if (emergencyCase.driver_id) {
    emit(ROOMS.driverRoom(emergencyCase.driver_id), EVENTS.DECISION.CASE_REDIRECTED, payload);
  }

  // The receiving hospital gets the full card AND the existing report, so the
  // case arrives there complete rather than as a bare notification.
  const { data: report } = await supabaseAdmin
    .from('ai_reports')
    .select('pdf_url, resources_needed, urgency_level, emergency_type')
    .eq('case_id', caseId)
    .maybeSingle();

  emit(ROOMS.hospitalRoom(newHospitalId), EVENTS.HOSPITAL.HOSPITAL_NEW_CASE, {
    caseId,
    caseNumber: emergencyCase.case_number,
    type: 'redirected_in',
    redirectedFrom: oldHospitalName,
    reason,
    etaSeconds: newEtaSeconds,
    pdfUrl: report?.pdf_url || null,
    resourcesNeeded: report?.resources_needed || [],
    urgencyLevel: report?.urgency_level || null,
    emergencyType: report?.emergency_type || null,
  });

  emit(ROOMS.hospitalRoom(hospitalId), EVENTS.HOSPITAL.HOSPITAL_CASE_UPDATE, {
    caseId,
    type: 'redirected_away',
    newHospitalName: newHospital.name,
    reason,
  });

  const token = await getDriverPushToken(emergencyCase.driver_id);
  await notificationService.sendDriverDecisionNotification(token, {
    title: 'Redirect',
    body: `Go to ${newHospital.name} instead — ${reason}`,
    data: {
      type: 'case_redirected',
      caseId,
      newHospitalId: newHospital.id,
      newHospitalLat: newHospital.lat,
      newHospitalLng: newHospital.lng,
    },
  });

  await logCaseMessage({
    caseId,
    senderRole: 'hospital',
    senderUserId: hospitalAdminUserId,
    messageKey: 'redirected',
    messageText: `Redirected to ${newHospital.name} — ${reason}`,
  });

  logger.info(
    `Case ${emergencyCase.case_number} redirected ${oldHospitalName} -> ${newHospital.name} (${reason})`,
  );
  return payload;
}

// --- 3. Quick messages -------------------------------------------------------

export async function sendQuickMessage({ caseId, senderUserId, senderRole, messageKey }) {
  const message = getMessageByKey(messageKey);
  if (!message) throw new Error('Unknown message key');
  if (message.role !== senderRole) {
    throw new Error(`This message can only be sent by a ${message.role}`);
  }

  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, hospital_id, driver_id')
    .eq('id', caseId)
    .maybeSingle();
  if (!emergencyCase) throw new Error('Case not found');

  // Authorize: the sender must actually be on this case.
  if (senderRole === 'hospital') {
    const { data: hospital } = await supabaseAdmin
      .from('hospitals')
      .select('id')
      .eq('admin_user_id', senderUserId)
      .maybeSingle();
    if (!hospital || hospital.id !== emergencyCase.hospital_id) {
      throw new Error('Not authorized to message on this case');
    }
  } else {
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('id')
      .eq('user_id', senderUserId)
      .maybeSingle();
    if (!driver || driver.id !== emergencyCase.driver_id) {
      throw new Error('Not authorized to message on this case');
    }
  }

  const { data: row, error } = await supabaseAdmin
    .from('case_messages')
    .insert({
      case_id: caseId,
      sender_role: senderRole,
      sender_user_id: senderUserId,
      message_key: messageKey,
      message_text: message.text,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const payload = {
    caseId,
    senderRole,
    messageKey,
    messageText: message.text,
    timestamp: row.created_at,
  };
  emit(ROOMS.caseRoom(caseId), EVENTS.DECISION.QUICK_MESSAGE, payload);
  if (emergencyCase.hospital_id) {
    emit(ROOMS.hospitalRoom(emergencyCase.hospital_id), EVENTS.DECISION.QUICK_MESSAGE, payload);
  }
  if (emergencyCase.driver_id) {
    emit(ROOMS.driverRoom(emergencyCase.driver_id), EVENTS.DECISION.QUICK_MESSAGE, payload);
  }

  if (senderRole === 'hospital') {
    const token = await getDriverPushToken(emergencyCase.driver_id);
    await notificationService.sendDriverDecisionNotification(token, {
      title: 'Message from hospital',
      body: message.text,
      data: { type: 'quick_message', caseId, messageKey },
    });
  }

  return row;
}

// --- 4. Message history ------------------------------------------------------

export async function getCaseMessages(caseId) {
  const { data, error } = await supabaseAdmin
    .from('case_messages')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export default {
  acceptCase,
  redirectCase,
  sendQuickMessage,
  getCaseMessages,
  QUICK_MESSAGES,
  REDIRECT_REASONS,
  PREPARATION_NOTES,
};
