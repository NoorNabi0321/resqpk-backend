// Per-number conversation state for the WhatsApp bot.
//
// Kept in Postgres, not in memory: Render restarts on every deploy and sleeps
// on the free tier, and a restart mid-conversation would drop someone's
// half-finished SOS. A user replying "1" is answering a specific question, so
// the question has to outlive the process.
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../middleware/logger.js';

// How long a half-finished conversation stays open. Long enough for someone
// fumbling with a location pin, short enough that tomorrow's "1" is not read as
// an answer to today's question.
const SESSION_TTL_MINUTES = 10;

export const STATES = {
  IDLE: 'idle',
  AWAITING_WHO: 'awaiting_who',
  AWAITING_TYPE: 'awaiting_type',
  AWAITING_LOCATION: 'awaiting_location',
  AWAITING_LANDMARK: 'awaiting_landmark',
  AWAITING_CONFIRM: 'awaiting_confirm',
  DISPATCHING: 'dispatching',
  ASSIGNED: 'assigned',
};

function expiryFromNow() {
  return new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();
}

/** The live session for a number, or a fresh idle one if none / expired. */
export async function getSession(phone) {
  const { data } = await supabaseAdmin
    .from('wa_sessions')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (!data) return { phone, state: STATES.IDLE, context: {}, language: 'en', case_id: null };

  const expired = data.expires_at && new Date(data.expires_at) < new Date();
  if (expired && data.state !== STATES.ASSIGNED && data.state !== STATES.DISPATCHING) {
    // An abandoned half-flow must not hold a dispatch open, but a case that is
    // already running stays reachable for status replies.
    return { phone, state: STATES.IDLE, context: {}, language: data.language || 'en', case_id: null };
  }
  return data;
}

/** Upsert the session, merging context rather than replacing it. */
export async function saveSession(phone, patch = {}) {
  const current = await getSession(phone);
  const row = {
    phone,
    state: patch.state ?? current.state,
    case_id: patch.case_id !== undefined ? patch.case_id : current.case_id,
    language: patch.language ?? current.language ?? 'en',
    context: { ...(current.context || {}), ...(patch.context || {}) },
    last_message_at: new Date().toISOString(),
    expires_at: expiryFromNow(),
  };

  const { error } = await supabaseAdmin.from('wa_sessions').upsert(row, { onConflict: 'phone' });
  if (error) logger.error(`wa_session save failed for ${phone}: ${error.message}`);
  return row;
}

/** Back to idle — after completion, cancellation, or an abandoned flow. */
export async function clearSession(phone) {
  const { error } = await supabaseAdmin
    .from('wa_sessions')
    .upsert(
      {
        phone,
        state: STATES.IDLE,
        case_id: null,
        context: {},
        last_message_at: new Date().toISOString(),
        expires_at: expiryFromNow(),
      },
      { onConflict: 'phone' },
    );
  if (error) logger.error(`wa_session clear failed for ${phone}: ${error.message}`);
}

/** The number a case belongs to, for pushing status updates back into chat. */
export async function sessionForCase(caseId) {
  const { data } = await supabaseAdmin
    .from('wa_sessions')
    .select('*')
    .eq('case_id', caseId)
    .maybeSingle();
  return data || null;
}

export default { STATES, getSession, saveSession, clearSession, sessionForCase };
