// Everything a language model hands back, forced into what the table accepts.
//
// ai_reports has CHECK constraints on input_language, urgency_level and
// consciousness_state. A model — or Whisper — answering in its own words fails
// the insert, and the insert failing loses the whole report: the transcript,
// the analysis, the PDF, all of it, after the patient has already spoken into
// the phone. So nothing goes near the table unmapped.
//
// Whisper's verbose_json returns the language NAME ("urdu", "english"), never
// the ISO code the column allows, which meant every voice report failed to
// save with "violates check constraint ai_reports_input_language_check".

const LANGUAGES = Object.freeze({
  en: 'en',
  eng: 'en',
  english: 'en',

  ur: 'ur',
  urd: 'ur',
  urdu: 'ur',

  sd: 'sd',
  snd: 'sd',
  sindhi: 'sd',

  roman_ur: 'roman_ur',
  'roman urdu': 'roman_ur',
  romanur: 'roman_ur',

  // Whisper reaches for these on Urdu and Sindhi speech constantly: they share
  // vocabulary, script or both. Filing them as Urdu is far closer to the truth
  // than falling back to English, and it is what the report is written in.
  hi: 'ur',
  hindi: 'ur',
  pa: 'ur',
  panjabi: 'ur',
  punjabi: 'ur',
  fa: 'ur',
  persian: 'ur',
  farsi: 'ur',
  ar: 'ur',
  arabic: 'ur',
  ps: 'ur',
  pashto: 'ur',
  pushto: 'ur',
});

const URGENCY = Object.freeze({
  critical: 'critical',
  severe: 'critical',
  high: 'critical',
  emergency: 'critical',
  immediate: 'critical',

  moderate: 'moderate',
  medium: 'moderate',
  urgent: 'moderate',

  low: 'low',
  mild: 'low',
  minor: 'low',
  stable: 'low',
});

const CONSCIOUSNESS = Object.freeze({
  conscious: 'conscious',
  awake: 'conscious',
  alert: 'conscious',
  responsive: 'conscious',

  'semi-conscious': 'semi-conscious',
  'semi conscious': 'semi-conscious',
  semiconscious: 'semi-conscious',
  drowsy: 'semi-conscious',
  confused: 'semi-conscious',
  'partially conscious': 'semi-conscious',

  unconscious: 'unconscious',
  unresponsive: 'unconscious',
  'not responding': 'unconscious',
});

function lookup(table, value, fallback) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, (m) => m); // keep separators; the tables carry both forms
  if (!key) return fallback;
  return table[key] ?? table[key.replace(/[\s_-]+/g, ' ')] ?? fallback;
}

/// One of: en | ur | sd | roman_ur.
export function normaliseLanguage(value) {
  return lookup(LANGUAGES, value, 'en');
}

/// One of: critical | moderate | low | unknown.
export function normaliseUrgency(value) {
  return lookup(URGENCY, value, 'unknown');
}

/// One of: conscious | semi-conscious | unconscious | unknown.
export function normaliseConsciousness(value) {
  return lookup(CONSCIOUSNESS, value, 'unknown');
}

export default { normaliseLanguage, normaliseUrgency, normaliseConsciousness };
