// Preset one-tap messages exchanged between hospital and driver during a case.
// Free-text chat is deliberately avoided — typing is too slow in an emergency.
// This file is the single source of truth: both frontends fetch these via
// GET /api/decisions/constants rather than hardcoding their own copies.

// `role` is who may SEND the message, and is enforced in decision.service.
export const QUICK_MESSAGES = Object.freeze({
  // --- Hospital → Driver -----------------------------------------------------
  report_reviewed: Object.freeze({
    key: 'report_reviewed',
    text: 'Report reviewed ✓',
    role: 'hospital',
  }),
  gate_1: Object.freeze({
    key: 'gate_1',
    text: 'Bring patient to Emergency Gate 1',
    role: 'hospital',
  }),
  gate_2: Object.freeze({
    key: 'gate_2',
    text: 'Bring patient to Emergency Gate 2',
    role: 'hospital',
  }),
  gate_3: Object.freeze({
    key: 'gate_3',
    text: 'Bring patient to Emergency Gate 3',
    role: 'hospital',
  }),
  icu_preparing: Object.freeze({
    key: 'icu_preparing',
    text: 'ICU is being prepared',
    role: 'hospital',
  }),
  specialist_called: Object.freeze({
    key: 'specialist_called',
    text: 'Specialist has been called',
    role: 'hospital',
  }),
  patient_stable_ok: Object.freeze({
    key: 'patient_stable_ok',
    text: 'Patient stable per report — drive safely',
    role: 'hospital',
  }),

  // --- Driver → Hospital -----------------------------------------------------
  condition_worsening: Object.freeze({
    key: 'condition_worsening',
    text: 'Patient condition is worsening',
    role: 'driver',
  }),
  five_min_away: Object.freeze({
    key: 'five_min_away',
    text: '5 minutes away',
    role: 'driver',
  }),
  arrived_gate: Object.freeze({
    key: 'arrived_gate',
    text: 'Arrived at hospital gate',
    role: 'driver',
  }),
  need_stretcher: Object.freeze({
    key: 'need_stretcher',
    text: 'Need stretcher at entrance',
    role: 'driver',
  }),
});

// Derived from QUICK_MESSAGES so the lists can never drift out of sync with it.
export const HOSPITAL_MESSAGE_KEYS = Object.freeze(
  Object.values(QUICK_MESSAGES)
    .filter((m) => m.role === 'hospital')
    .map((m) => m.key),
);

export const DRIVER_MESSAGE_KEYS = Object.freeze(
  Object.values(QUICK_MESSAGES)
    .filter((m) => m.role === 'driver')
    .map((m) => m.key),
);

// Why a hospital sent a case elsewhere. Validated on redirect.
export const REDIRECT_REASONS = Object.freeze([
  'No ICU bed available',
  'No specialist available',
  'Required equipment unavailable',
  'At full capacity',
  'Not equipped for this emergency type',
]);

// Optional note attached when a hospital accepts a patient.
export const PREPARATION_NOTES = Object.freeze([
  'Emergency ward ready',
  'ICU prepared',
  'OT on standby',
  'Specialist informed',
]);

// Look up a message by key. Returns null for unknown keys so callers can
// reject bad input rather than crash on undefined.
export function getMessageByKey(key) {
  if (!key || typeof key !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(QUICK_MESSAGES, key)
    ? QUICK_MESSAGES[key]
    : null;
}

export default {
  QUICK_MESSAGES,
  HOSPITAL_MESSAGE_KEYS,
  DRIVER_MESSAGE_KEYS,
  REDIRECT_REASONS,
  PREPARATION_NOTES,
  getMessageByKey,
};
