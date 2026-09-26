// The preset quick-message exchange between a ward and the ambulance
// bringing someone in.
//
// The receptionist's job here is See -> Read -> Prepare. It used to include
// Decide — accept the patient or send them elsewhere — and that has gone: an
// ambulance already on its way is coming whatever the dashboard says, and the
// useful thing a ward can do with the notice is have the bay ready.
import { supabaseAdmin } from '../config/supabase.js';
import { getIO } from '../socket/socket.server.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';
import mapsService from './maps.service.js';
import notificationService from './notification.service.js';
import {
  QUICK_MESSAGES,
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

// --- Quick messages ---------------------------------------------------------
//
// Accept and redirect used to live here. The hospital no longer decides
// whether to take a patient: an ambulance that is coming is coming, and a ward
// that has been told what is arriving and when can have the trolley and the
// blood ready. Deciding in an app, minutes out, against resource figures
// nobody was updating, was never the reliable half of that.

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

// --- Message history ---------------------------------------------------------

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
  sendQuickMessage,
  getCaseMessages,
  QUICK_MESSAGES,
};
