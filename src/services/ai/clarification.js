// Blocking clarification (FR-13, FR-14, FR-15).
//
// The model proposes the questions; this module decides what is allowed to be
// asked. Vetting them here, rather than trusting whatever JSON came back, is
// what keeps the sequence to single taps and keeps a malformed question from
// rendering as a dead screen between the describing party and their report.
//
// Note what this file no longer does. Under the earlier progressive design an
// answer was patched into an already-delivered record, so this module also owned
// the rules for writing one into a clinical field. It does not any more: the
// answers go into the prompt and the model writes the record once, with them in
// hand. There is no second version of the truth to reconcile.

/// The fields a question may target. Carried through to the record only as
/// provenance — which part of the report the question was asked about — so a
/// reader can see why it was put.
export const REFINABLE_FIELDS = [
  'consciousness_state',
  'urgency_level',
  'emergency_type',
  'key_observations',
  'medications_mentioned',
  'allergies_active',
];

const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

/// A short id that survives a JSON round trip and reads in a log.
function questionId(index) {
  return `q${index + 1}`;
}

function cleanOption(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  // A tap target, not a sentence. Long options are the model ignoring the
  // instruction, and a truncated one is still answerable.
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/// Turns whatever the model returned into the stored clarification array, or an
/// empty array when it returned nothing usable.
///
/// Every question comes back unanswered, which is the point: the record is not
/// written until these have been answered or skipped.
export function buildClarifications(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const questions = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;

    const question = cleanOption(item.question);
    if (!question) continue;

    // Two questions on the same field waste one of a very small budget.
    const field = REFINABLE_FIELDS.includes(item.field) ? item.field : 'key_observations';
    const key = question.toLowerCase();
    if (seen.has(key)) continue;

    // The English option and the one the person reads are cleaned as a pair and
    // stay a pair through dedup and the cap. They have to: the answer is chosen
    // by position, so a local list that drifted out of step by one would record
    // the answer to a different option than the one that was tapped.
    //
    // The English list is what the record and the hospital see; the local list
    // is the same options in the language the reporter is writing in.
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const rawLocal = Array.isArray(item.options_local) ? item.options_local : [];

    const pairs = [];
    for (let i = 0; i < rawOptions.length && pairs.length < MAX_OPTIONS; i += 1) {
      const english = cleanOption(rawOptions[i]);
      if (!english) continue;
      if (pairs.some((p) => p.english === english)) continue;
      pairs.push({ english, local: cleanOption(rawLocal[i]) });
    }

    // One option is not a choice, and a free-text answer is explicitly out of
    // scope for this sequence.
    if (pairs.length < 2) continue;

    const options = pairs.map((p) => p.english);
    const questionLocal = cleanOption(item.question_local);
    // All or nothing. A half-translated question is worse than an English one,
    // because the gap is where a misread happens.
    const localComplete = questionLocal != null && pairs.every((p) => p.local != null);

    seen.add(key);
    questions.push({
      id: questionId(questions.length),
      field,
      question,
      options,
      question_local: localComplete ? questionLocal : null,
      options_local: localComplete ? pairs.map((p) => p.local) : null,
      answer: null,
      answered_at: null,
      skipped_at: null,
    });

    if (questions.length === MAX_QUESTIONS) break;
  }

  // Fewer than two is not worth holding a report up for. Better to ask nothing
  // and generate straight away than to block an emergency on one token
  // question — the delay is the whole cost of this design, and it has to buy
  // something.
  return questions.length >= MIN_QUESTIONS ? questions : [];
}

/// Where the sequence stands, derived from the questions themselves so the
/// state and the answers can never disagree.
///
/// none      — nothing was asked
/// awaiting  — asked, still open, record deliberately not generated
/// answered  — every question answered
/// skipped   — closed with at least one question unanswered
export function clarificationStateFor(clarifications) {
  if (!Array.isArray(clarifications) || clarifications.length === 0) return 'none';

  const answered = clarifications.filter((c) => c?.answer != null && c.answer !== '');
  if (answered.length === clarifications.length) return 'answered';

  const closed = clarifications.some((c) => c?.skipped_at);
  return closed ? 'skipped' : 'awaiting';
}

/// True once nothing is left to ask, so the record may be generated.
export function isSequenceClosed(clarifications) {
  const state = clarificationStateFor(clarifications);
  return state === 'none' || state === 'answered' || state === 'skipped';
}

export default {
  REFINABLE_FIELDS,
  buildClarifications,
  clarificationStateFor,
  isSequenceClosed,
};
