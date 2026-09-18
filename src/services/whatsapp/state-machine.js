// The WhatsApp conversation: from "SOS" to a dispatched ambulance.
//
// This is an adapter, not a second system. Once the location is confirmed it
// calls the same createSOS() the mobile app calls, and the dispatch engine
// never learns which channel the case came from.
import { supabaseAdmin } from '../../config/supabase.js';
import caseService from '../case.service.js';
import mapsService from '../maps.service.js';
import logger from '../../middleware/logger.js';
import client from './whatsapp.client.js';
import { STATES, getSession, saveSession, clearSession } from './session.store.js';
import { detectTrigger, isCancel, t } from './messages.js';

// A phone may raise this many requests per hour. Removing the install barrier
// removed what quietly deterred prank calls.
const MAX_CASES_PER_HOUR = 3;
const ACTIVE_STATUSES = ['pending', 'searching', 'driver_assigned', 'arrived', 'en_route'];

/** WhatsApp gives 923001234567; users.phone is stored as 03001234567. */
export function toLocalPhone(waPhone) {
  const digits = String(waPhone || '').replace(/\D/g, '');
  if (digits.startsWith('92') && digits.length === 12) return `0${digits.slice(2)}`;
  return digits;
}

/** Flatten a WhatsApp message into the few shapes this machine cares about. */
function readInput(message) {
  switch (message.type) {
    case 'text':
      return { kind: 'text', text: (message.text?.body || '').trim() };
    case 'interactive':
      return {
        kind: 'button',
        id:
          message.interactive?.button_reply?.id ||
          message.interactive?.list_reply?.id ||
          '',
        text: message.interactive?.button_reply?.title || '',
      };
    case 'location':
      return {
        kind: 'location',
        lat: Number(message.location?.latitude),
        lng: Number(message.location?.longitude),
        label: message.location?.name || message.location?.address || null,
      };
    case 'audio':
      return { kind: 'audio', mediaId: message.audio?.id };
    case 'image':
      return { kind: 'image', mediaId: message.image?.id };
    default:
      return { kind: 'other', text: '' };
  }
}

/** One active case at a time, and a cap per hour. */
async function checkLimits(phone) {
  const localPhone = toLocalPhone(phone);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

  const { data: active } = await supabaseAdmin
    .from('emergency_cases')
    .select('id')
    .or(`reporter_phone.eq.${phone},reporter_phone.eq.${localPhone}`)
    .in('status', ACTIVE_STATUSES)
    .limit(1);
  if (active?.length) return { allowed: false, reason: 'active' };

  const { data: recent } = await supabaseAdmin
    .from('emergency_cases')
    .select('id')
    .or(`reporter_phone.eq.${phone},reporter_phone.eq.${localPhone}`)
    .gt('sos_triggered_at', hourAgo);
  if ((recent?.length || 0) >= MAX_CASES_PER_HOUR) return { allowed: false, reason: 'rate' };

  return { allowed: true };
}

/** If this number belongs to a registered patient, their profile comes too. */
async function findRegisteredPatient(phone) {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, full_name')
    .eq('phone', toLocalPhone(phone))
    .eq('role', 'patient')
    .maybeSingle();
  return data || null;
}

async function askWho(phone, lang) {
  const copy = t(lang);
  await client.sendButtons(phone, copy.who, [
    { id: 'who_self', title: copy.whoSelf },
    { id: 'who_other', title: copy.whoOther },
  ]);
}

async function askType(phone, lang) {
  const copy = t(lang);
  // WhatsApp allows three reply buttons, so "something else" is the text path.
  await client.sendButtons(phone, copy.type, [
    { id: 'type_accident', title: copy.typeAccident },
    { id: 'type_cardiac', title: copy.typeCardiac },
    { id: 'type_breathing', title: copy.typeBreathing },
  ]);
}

async function askLocation(phone, lang) {
  await client.requestLocation(phone, t(lang).location);
}

async function askConfirm(phone, lang, label) {
  const copy = t(lang);
  await client.sendButtons(phone, copy.confirm(label), [
    { id: 'confirm_yes', title: copy.confirmYes },
    { id: 'confirm_no', title: copy.confirmNo },
  ]);
}

/** Location accepted — hold it and ask for confirmation before dispatching. */
async function acceptLocation(phone, session, lat, lng, label) {
  await saveSession(phone, {
    state: STATES.AWAITING_CONFIRM,
    context: { lat, lng, label: label || null },
  });
  await askConfirm(phone, session.language, label);
}

/** The confirmed step: create the case on the same service the app uses. */
async function dispatchCase(phone, session) {
  const copy = t(session.language);
  const { lat, lng, reportedFor, emergencyType, label } = session.context || {};

  if (lat == null || lng == null) {
    await saveSession(phone, { state: STATES.AWAITING_LOCATION });
    return askLocation(phone, session.language);
  }

  const patient = await findRegisteredPatient(phone);

  const result = await caseService.createSOS({
    patientId: patient?.id || null,
    lat,
    lng,
    address: label || null,
    reporterPhone: phone,
    reporterName: patient?.full_name || session.context?.reporterName || null,
    reportedFor: reportedFor || 'self',
    channel: 'whatsapp',
  });

  await saveSession(phone, {
    state: STATES.DISPATCHING,
    case_id: result.caseId,
    context: { emergencyType: emergencyType || null },
  });

  await client.sendText(phone, copy.searching(result.accessCode, result.trackingUrl));
  // Asked immediately, because the ambulance ride is exactly the window in
  // which a bystander has time to describe what happened.
  await client.sendText(phone, copy.voicePrompt);

  logger.info(
    `WhatsApp SOS → case ${result.caseNumber} (${reportedFor}, ${emergencyType || 'unspecified'})`,
  );
  return result;
}

async function cancelFlow(phone, session) {
  const copy = t(session.language);
  if (session.case_id) {
    try {
      await caseService.cancelSOS({
        caseId: session.case_id,
        viaCaseToken: true, // the session itself proves ownership of this case
        reason: 'changed_mind',
      });
    } catch (err) {
      logger.warn(`WhatsApp cancel failed for ${session.case_id}: ${err.message}`);
    }
  }
  await clearSession(phone);
  await client.sendText(phone, copy.cancelled);
}

/** One inbound message, one state transition. */
async function processInbound(message, contact) {
  const phone = message.from;
  const session = await getSession(phone);
  const input = readInput(message);
  const lang = session.language || 'en';
  const copy = t(lang);

  // Cancellation works from any state, in any language.
  if ((input.kind === 'text' && isCancel(input.text)) || input.id === 'confirm_no') {
    return cancelFlow(phone, session);
  }

  // A voice note or photo during an active case feeds the AI report. The
  // pipeline is wired in the next step; for now it is acknowledged, not lost.
  if ((input.kind === 'audio' || input.kind === 'image') && session.case_id) {
    logger.info(`WhatsApp media ${input.mediaId} received for case ${session.case_id}`);
    return client.sendText(phone, 'Received. This will be added to the patient report.');
  }

  switch (session.state) {
    case STATES.IDLE: {
      const triggered = detectTrigger(input.text);
      if (!triggered) return client.sendText(phone, copy.unknown);

      const limits = await checkLimits(phone);
      if (!limits.allowed) return client.sendText(phone, t(triggered).rateLimited);

      await saveSession(phone, {
        state: STATES.AWAITING_WHO,
        language: triggered,
        case_id: null,
        context: { reporterName: contact?.profile?.name || null },
      });
      return askWho(phone, triggered);
    }

    case STATES.AWAITING_WHO: {
      const forOther = input.id === 'who_other' || /other|2|کسی/.test(input.text || '');
      await saveSession(phone, {
        state: STATES.AWAITING_TYPE,
        context: { reportedFor: forOther ? 'other' : 'self' },
      });
      return askType(phone, lang);
    }

    case STATES.AWAITING_TYPE: {
      const type = input.id?.startsWith('type_') ? input.id.slice(5) : 'other';
      await saveSession(phone, {
        state: STATES.AWAITING_LOCATION,
        context: { emergencyType: type },
      });
      return askLocation(phone, lang);
    }

    case STATES.AWAITING_LOCATION: {
      if (input.kind === 'location' && Number.isFinite(input.lat)) {
        return acceptLocation(phone, session, input.lat, input.lng, input.label);
      }
      // They typed instead of tapping — treat it as a landmark straight away
      // rather than repeating the instruction.
      if (input.kind === 'text' && input.text.length >= 3) {
        const place = await mapsService.geocodeAddress(input.text);
        if (place) return acceptLocation(phone, session, place.lat, place.lng, place.label);
        await saveSession(phone, { state: STATES.AWAITING_LANDMARK });
        return client.sendText(phone, copy.landmarkFailed);
      }
      return askLocation(phone, lang);
    }

    case STATES.AWAITING_LANDMARK: {
      if (input.kind === 'location' && Number.isFinite(input.lat)) {
        return acceptLocation(phone, session, input.lat, input.lng, input.label);
      }
      const place = await mapsService.geocodeAddress(input.text);
      if (!place) return client.sendText(phone, copy.landmarkFailed);
      return acceptLocation(phone, session, place.lat, place.lng, place.label);
    }

    case STATES.AWAITING_CONFIRM: {
      const confirmed =
        input.id === 'confirm_yes' || /^(1|yes|haan|ہاں|ok)$/i.test((input.text || '').trim());
      if (!confirmed) return askConfirm(phone, lang, session.context?.label);
      return dispatchCase(phone, session);
    }

    case STATES.DISPATCHING:
    case STATES.ASSIGNED:
    default: {
      // A new location mid-case is a correction worth keeping in the log.
      if (input.kind === 'location') {
        logger.info(`WhatsApp location update during case ${session.case_id}`);
      }
      return client.sendText(phone, copy.voicePrompt);
    }
  }
}

// Meta delivers webhooks concurrently, and a conversation is a state machine
// read from the database. Two messages from the same number arriving a second
// apart — a tapped button and a follow-up text — would both read the old state
// and one transition would be lost. Worse, a confirmation still being processed
// could be overtaken by the next message and dispatch an ambulance after the
// user had already cancelled.
//
// One promise chain per phone number. Different numbers still run in parallel.
const queues = new Map();

/** Entry point: serialised per sender. */
export function handleInbound(message, contact) {
  const phone = message.from;
  const previous = queues.get(phone) || Promise.resolve();

  const next = previous
    .catch(() => {}) // a failed message must not block the next one
    .then(() => processInbound(message, contact));

  queues.set(
    phone,
    next.finally(() => {
      if (queues.get(phone) === next) queues.delete(phone);
    }),
  );

  return next;
}

export default { handleInbound, toLocalPhone };
