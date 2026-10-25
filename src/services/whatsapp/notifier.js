// Pushing case events back into the WhatsApp thread.
//
// The dispatch engine broadcasts over Socket.IO, which a chat user cannot
// listen to. This is the other half of the adapter: the same events, delivered
// as messages. Every function is a no-op for cases that arrived by app or web.
import { supabaseAdmin } from '../../config/supabase.js';
import config from '../../config/env.js';
import logger from '../../middleware/logger.js';
import client from './whatsapp.client.js';
import { STATES, saveSession, clearSession } from './session.store.js';
import { t } from './messages.js';

/** Returns { phone, language } for a WhatsApp case, or null for other channels. */
async function whatsappTarget(caseId) {
  const { data: emergencyCase } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, channel, reporter_phone, share_token')
    .eq('id', caseId)
    .maybeSingle();

  if (!emergencyCase || emergencyCase.channel !== 'whatsapp' || !emergencyCase.reporter_phone) {
    return null;
  }

  const { data: session } = await supabaseAdmin
    .from('wa_sessions')
    .select('language')
    .eq('phone', emergencyCase.reporter_phone)
    .maybeSingle();

  return {
    phone: emergencyCase.reporter_phone,
    language: session?.language || 'en',
    shareToken: emergencyCase.share_token,
  };
}

function trackingLink(shareToken) {
  return `${config.publicWebUrl.replace(/\/$/, '')}/t/${shareToken}`;
}

/** An ambulance accepted: name, vehicle, ETA and a number to call. */
export async function notifyDriverAssigned(caseId, payload = {}) {
  const target = await whatsappTarget(caseId);
  if (!target) return;

  await saveSession(target.phone, { state: STATES.ASSIGNED, case_id: caseId });

  const copy = t(target.language);
  await client.sendText(
    target.phone,
    copy.driverAssigned({
      name: payload.driver?.fullName || 'Ambulance driver',
      vehicle: payload.driver?.vehicleNumber || '—',
      eta: payload.etaText || 'a few minutes',
      phone: payload.driver?.phone || '1122',
      link: trackingLink(target.shareToken),
    }),
  );
}

/** Every ring exhausted. Give them numbers that will answer. */
export async function notifyNoDriver(caseId) {
  const target = await whatsappTarget(caseId);
  if (!target) return;

  await client.sendText(target.phone, t(target.language).noDriver);
  await clearSession(target.phone);
}

/** A hospital has been attached and told to expect the patient. */
export async function notifyHospital(caseId, hospitalName) {
  const target = await whatsappTarget(caseId);
  if (!target || !hospitalName) return;

  await client.sendText(target.phone, t(target.language).hospital(hospitalName));
}

/**
 * The finished clinical report, delivered into the chat.
 *
 * One function for every route that produces one — the questions being
 * answered, the questions being skipped, or the sequence timing out server-side
 * — so the user gets the same message and the same document whichever way their
 * report came to be written. `preamble` is the line that explains why it is
 * arriving now, and is the only part that differs.
 *
 * Also returns the conversation to the assigned state: the questions are over,
 * and a number typed after this is not an answer to anything.
 */
export async function notifyReportReady(caseId, report, { preamble = null } = {}) {
  const target = await whatsappTarget(caseId);
  if (!target || !report) return;

  const copy = t(target.language);
  await saveSession(target.phone, { state: STATES.ASSIGNED, case_id: caseId });

  if (preamble) await client.sendText(target.phone, preamble(copy));

  await client.sendText(
    target.phone,
    copy.reportReady({
      urgency: report.urgencyLevel,
      type: report.emergencyType,
      firstAid: report.firstAidSuggestion,
    }),
  );

  if (report.pdfUrl) {
    const { data: row } = await supabaseAdmin
      .from('emergency_cases')
      .select('case_number')
      .eq('id', caseId)
      .maybeSingle();
    await client.sendDocument(
      target.phone,
      report.pdfUrl,
      `${row?.case_number || 'ResQPK'}-report.pdf`,
      'Patient report — also sent to the hospital',
    );
  }
}

/** Ride milestones, in the words a worried person actually needs. */
export async function notifyStatus(caseId, status, hospitalName = null) {
  const target = await whatsappTarget(caseId);
  if (!target) return;

  const copy = t(target.language);
  const text = {
    arrived: copy.arrived,
    en_route: copy.enRoute(hospitalName),
    completed: copy.completed,
  }[status];

  if (!text) return;
  await client.sendText(target.phone, text);
  if (status === 'completed') await clearSession(target.phone);
}

/** Fire-and-forget wrapper: a chat notification must never break dispatch. */
export function safely(promise, context) {
  return Promise.resolve(promise).catch((err) =>
    logger.warn(`WhatsApp notify failed (${context}): ${err.message}`),
  );
}

export default {
  notifyDriverAssigned,
  notifyNoDriver,
  notifyHospital,
  notifyStatus,
  notifyReportReady,
  safely,
};
