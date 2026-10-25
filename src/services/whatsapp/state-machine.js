// The WhatsApp conversation: from "SOS" to a dispatched ambulance.
//
// This is an adapter, not a second system. Once the location is confirmed it
// calls the same createSOS() the mobile app calls, and the dispatch engine
// never learns which channel the case came from.
import { supabaseAdmin } from '../../config/supabase.js';
import caseService from '../case.service.js';
import mapsService from '../maps.service.js';
import logger from '../../middleware/logger.js';
import aiPipeline from '../ai/ai.pipeline.js';
import clarificationService from '../ai/clarification.service.js';
import client from './whatsapp.client.js';
import media from './media.js';
import notifier from './notifier.js';
import { STATES, getSession, saveSession, clearSession } from './session.store.js';
import { detectTrigger, isCancel, isSkip, parseChoice, t } from './messages.js';

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

/** Sends the next outstanding question as a numbered list. */
async function askClarification(phone, language, clarifications, { intro = false } = {}) {
  const copy = t(language);
  const open = (clarifications || []).filter((c) => !c?.answer && !c?.skipped_at);
  if (open.length === 0) return false;

  const total = (clarifications || []).length;
  const index = total - open.length + 1;

  if (intro) await client.sendText(phone, copy.clarifyIntro);
  // Shown in the language they are writing in, falling back to the English the
  // record carries. The option they pick is resolved by position, so what is
  // displayed never has to be matched against what is stored.
  await client.sendText(
    phone,
    copy.clarifyQuestion({
      index,
      total,
      question: open[0].question_local || open[0].question,
      options: open[0].options_local || open[0].options || [],
    }),
  );
  return true;
}

/// The question a reply in AWAITING_CLARIFICATION is answering.
///
/// Read back from the database rather than remembered in the session, because
/// the server-side deadline can close the sequence between the question being
/// sent and the reply arriving. The database is the only thing that knows
/// whether this answer is still wanted.
async function currentQuestion(caseId) {
  try {
    const { clarifications } = await clarificationService.getOpenClarifications(caseId);
    const open = (clarifications || []).filter((c) => !c?.answer && !c?.skipped_at);
    return { all: clarifications || [], question: open[0] || null };
  } catch (err) {
    logger.warn(`Could not read clarifications for ${caseId}: ${err.message}`);
    return { all: [], question: null };
  }
}

/**
 * A voice note, photo or typed description during an active case becomes the
 * AI patient overview — the same pipeline the app uses. This is the point of
 * the whole channel: a bystander who installed nothing gives the hospital a
 * structured clinical summary before the ambulance arrives.
 *
 * Two phases, as in the app. This one analyses what was sent and asks the
 * clarification questions; the answers are what generate the record. Nothing
 * reaches the hospital until the sequence closes — by the last answer, by *0*,
 * or by the server-side deadline.
 */
async function submitClinicalInput(phone, session, { kind, mediaId, text }) {
  const copy = t(session.language);
  const caseId = session.case_id;

  await client.sendText(phone, copy.reportReceived);

  // Detached on purpose: transcription plus the model takes tens of seconds,
  // and this number's queue must stay free for a CANCEL arriving meanwhile.
  void (async () => {
    try {
      const { data: row } = await supabaseAdmin
        .from('emergency_cases')
        .select('patient_id, case_number')
        .eq('id', caseId)
        .maybeSingle();

      const inputs = { inputLanguage: 'auto' };

      if (kind === 'audio' || kind === 'image') {
        const file = await media.downloadMedia(mediaId);
        if (!file) return client.sendText(phone, copy.reportFailed);
        if (kind === 'audio') {
          inputs.voiceNoteBuffer = file.buffer;
          inputs.voiceNoteMimeType = file.mimeType;
        } else {
          inputs.imageBuffers = [{ buffer: file.buffer, mimeType: file.mimeType }];
        }
      } else {
        inputs.userText = text;
      }

      const analysis = await aiPipeline.analyseForClarification(
        caseId,
        row?.patient_id || null,
        inputs,
      );

      if (analysis.awaitingClarification) {
        await saveSession(phone, {
          state: STATES.AWAITING_CLARIFICATION,
          case_id: caseId,
        });
        await askClarification(phone, session.language, analysis.clarifications, {
          intro: true,
        });
        logger.info(
          `WhatsApp ${kind} → ${analysis.clarifications.length} question(s) for ${row?.case_number}`,
        );
        return null;
      }

      // Nothing worth asking — write it now.
      const result = await aiPipeline.generateFinalReport(caseId, {
        analysis: analysis.analysis,
      });
      await notifier.notifyReportReady(caseId, result);
      logger.info(
        `WhatsApp ${kind} → report for ${row?.case_number} `
          + `(${result?.urgencyLevel}, ${result?.generationTimeMs}ms, no questions)`,
      );
      return null;
    } catch (err) {
      logger.error(`WhatsApp report generation failed for ${caseId}: ${err.message}`);
      return client.sendText(phone, copy.reportFailed).catch(() => {});
    }
  })();

  return null;
}

/**
 * One numbered reply to a clarification question.
 *
 * A reply that is not a number gets the question again rather than being fed to
 * the model: the sequence is a closed set of options by design, and a sentence
 * typed here would be read as an answer it is not. Someone who wants to say
 * more in words can send *0* and then type, which restarts the analysis with
 * what they wrote.
 */
async function answerClarificationReply(phone, session, input) {
  const copy = t(session.language);
  const caseId = session.case_id;

  // 0, "skip", "bas", "pata nahi" — send the report as it stands.
  if (input.kind === 'text' && isSkip(input.text)) {
    return finishClarification(phone, session, () =>
      clarificationService.skipClarifications(caseId),
    );
  }

  const { question } = await currentQuestion(caseId);
  if (!question) {
    // The deadline closed the sequence, or the report is already written. The
    // notifier has told them; nothing here to answer.
    await saveSession(phone, { state: STATES.ASSIGNED, case_id: caseId });
    return client.sendText(phone, copy.voicePrompt);
  }

  const choice = parseChoice(input.text, question.options.length);
  if (choice == null) {
    return client.sendText(phone, copy.clarifyBadReply(question.options.length));
  }

  return finishClarification(phone, session, () =>
    clarificationService.answerClarification(caseId, {
      questionId: question.id,
      answer: question.options[choice - 1],
    }),
  );
}

/**
 * Runs one clarification write, then either asks the next question or delivers
 * the report the write produced.
 *
 * The write is awaited inline rather than detached, unlike the analysis above:
 * these calls are quick unless they are the one that generates the record, and
 * that one must not race the next inbound message. The per-number queue in
 * handleInbound is what makes that safe.
 */
async function finishClarification(phone, session, write) {
  const copy = t(session.language);
  const caseId = session.case_id;

  let result;
  try {
    result = await write();
  } catch (err) {
    // A 409 means the deadline or another reply got there first, which is not
    // the user's problem — the report either exists or is being written, and
    // the notifier will deliver it.
    if (err.status === 409) {
      await saveSession(phone, { state: STATES.ASSIGNED, case_id: caseId });
      return null;
    }
    logger.error(`WhatsApp clarification failed for ${caseId}: ${err.message}`);
    return client.sendText(phone, copy.reportFailed).catch(() => {});
  }

  // Still questions outstanding — ask the next one.
  if (!result?.report) {
    const asked = await askClarification(phone, session.language, result?.clarifications);
    if (asked) return null;
  }

  if (result?.report) {
    await notifier.notifyReportReady(caseId, result.report, {
      preamble: (c) => c.clarifyWriting,
    });
    logger.info(
      `WhatsApp clarification complete for ${caseId} (${result.clarificationState})`,
    );
    return null;
  }

  // No report and nothing left to ask: the generation failed somewhere it had
  // already been logged. Say so rather than leaving them waiting.
  await saveSession(phone, { state: STATES.ASSIGNED, case_id: caseId });
  return client.sendText(phone, copy.reportFailed).catch(() => {});
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

  // A voice note or photo during an active case feeds the AI patient overview.
  //
  // This holds mid-sequence too: someone who sends more audio rather than
  // answering has given the system better information than any of its questions
  // would have extracted, so the analysis starts again on the new recording and
  // asks whatever is still missing from it. The outstanding questions are
  // replaced, and the case leaves 'awaiting_clarification' while that happens.
  if (input.kind === 'audio' || input.kind === 'image') {
    if (!session.case_id) return client.sendText(phone, copy.unknown);
    return submitClinicalInput(phone, session, { kind: input.kind, mediaId: input.mediaId });
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

    case STATES.AWAITING_CLARIFICATION: {
      if (!session.case_id) return client.sendText(phone, copy.unknown);
      // A location pin mid-sequence is a correction, not an answer.
      if (input.kind === 'location') {
        logger.info(`WhatsApp location update during clarification on ${session.case_id}`);
        return null;
      }
      return answerClarificationReply(phone, session, input);
    }

    case STATES.DISPATCHING:
    case STATES.ASSIGNED:
    default: {
      // A new location mid-case is a correction worth keeping in the log.
      if (input.kind === 'location') {
        logger.info(`WhatsApp location update during case ${session.case_id}`);
        return client.sendText(phone, copy.voicePrompt);
      }
      // Someone typing during an active case is describing the patient, not
      // chatting. Treat it as the text input to the report.
      if (session.case_id && input.kind === 'text' && (input.text || '').length >= 4) {
        return submitClinicalInput(phone, session, { kind: 'text', text: input.text });
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
