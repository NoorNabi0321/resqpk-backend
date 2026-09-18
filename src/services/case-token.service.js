// Case-scoped access: how a patient reaches their own emergency without an account.
//
// Three values, three jobs (Plan 1, §5):
//   case_number  RQ-20260918-0001  display only — sequential, therefore guessable
//   access_code  RQ-7K2M-9XQ4      typed or read aloud; unguessable
//   share_token  64 hex characters  lives in a tracking URL
//
// Both the access code and the share token are exchanged for a short-lived JWT
// that authorises exactly one case and nothing else.
import crypto from 'crypto';

import jwt from 'jsonwebtoken';

import config from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';

// Crockford base32: no I, L, O or U, so a code read over a bad phone line
// cannot be misheard as a different valid code.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 4;

const TOKEN_TTL = '24h';
const SHARE_TOKEN_TTL_HOURS = 24;

/** `RQ-7K2M-9XQ4` — 40 bits of entropy. */
export function generateAccessCode() {
  const group = () =>
    Array.from({ length: CODE_GROUP_LEN }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `RQ-${Array.from({ length: CODE_GROUPS }, group).join('-')}`;
}

/** Opaque token for tracking links. Never typed, so length costs nothing. */
export function generateShareToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function shareTokenExpiry() {
  return new Date(Date.now() + SHARE_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
}

/** Accepts `rq7k2m9xq4`, `RQ-7K2M-9XQ4`, or anything between. */
export function normalizeAccessCode(input) {
  const raw = String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  const body = raw.startsWith('RQ') ? raw.slice(2) : raw;
  if (body.length !== CODE_GROUPS * CODE_GROUP_LEN) return null;
  const groups = body.match(new RegExp(`.{1,${CODE_GROUP_LEN}}`, 'g'));
  return `RQ-${groups.join('-')}`;
}

/**
 * The only credential a patient ever holds. Authorises one case: read it, add
 * clinical detail, fetch its PDF, join its socket room. Nothing else.
 */
export function issueCaseToken({ caseId, channel = 'app' }) {
  return jwt.sign({ scope: 'case', case_id: caseId, channel }, config.jwtSecret, {
    expiresIn: TOKEN_TTL,
  });
}

/** Returns the payload for a valid case token, or null for anything else. */
export function verifyCaseToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return payload?.scope === 'case' && payload.case_id ? payload : null;
  } catch {
    return null;
  }
}

/** Public tracking URL handed to WhatsApp users and shared with family. */
export function trackingUrl(shareToken) {
  return `${config.publicWebUrl.replace(/\/$/, '')}/t/${shareToken}`;
}

/**
 * Look up a case by the code the user typed.
 * Callers must rate-limit: guessing is the realistic attack on a short code.
 */
export async function caseFromAccessCode(input) {
  const code = normalizeAccessCode(input);
  if (!code) return null;

  const { data } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, channel, status, case_number, completed_at')
    .eq('access_code', code)
    .maybeSingle();

  return data || null;
}

/** Look up a case by the token embedded in a tracking link, honouring expiry. */
export async function caseFromShareToken(token) {
  if (!token) return null;

  const { data } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, channel, status, case_number, share_token_expires_at')
    .eq('share_token', token)
    .maybeSingle();

  if (!data) return null;
  if (data.share_token_expires_at && new Date(data.share_token_expires_at) < new Date()) {
    return null; // A forwarded link must not work forever.
  }
  return data;
}

export default {
  generateAccessCode,
  generateShareToken,
  shareTokenExpiry,
  normalizeAccessCode,
  issueCaseToken,
  verifyCaseToken,
  trackingUrl,
  caseFromAccessCode,
  caseFromShareToken,
};
