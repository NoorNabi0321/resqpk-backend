// Recording a clarification answer, and closing the sequence out (FR-14).
//
// One answer at a time, because that is how the questions are asked: a tap, the
// next question. Nothing is delivered along the way — the answers accumulate on
// the row, and when the last one lands (or the sequence is skipped) the record
// is generated once, from the description and the answers together.
//
// So there is nothing here that writes to a clinical field. An answer is an
// input to generation, not an edit to a record, and the record does not exist
// yet. That is the whole difference from the progressive design this replaced.
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../middleware/logger.js';

import { clarificationStateFor } from './clarification.js';
import { generateFinalReport } from './ai.pipeline.js';

const REPORT_COLUMNS = `id, case_id, patient_id, clarifications, clarification_state,
   generation_status, clarifications_asked_at`;

export class ClarificationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/// Reads the row and the access facts a caller needs to be checked against.
export async function loadReportForClarification(caseId) {
  const { data } = await supabaseAdmin
    .from('ai_reports')
    .select(`${REPORT_COLUMNS}, emergency_cases!inner(patient_id, hospital_id, case_number, status)`)
    .eq('case_id', caseId)
    .maybeSingle();
  return data || null;
}

/// The questions still open on this case, for an app resuming the sequence.
export async function getOpenClarifications(caseId) {
  const row = await loadReportForClarification(caseId);
  if (!row) throw new ClarificationError('Report not found', 404);
  const clarifications = Array.isArray(row.clarifications) ? row.clarifications : [];
  return {
    generationStatus: row.generation_status,
    clarificationState: clarificationStateFor(clarifications),
    clarifications,
  };
}

/// Records one single-tap answer.
///
/// When it is the last one, the record is generated before this returns — the
/// caller is the phone that is about to show the finished report, and making it
/// poll for something we already know is ready would add a round trip to the one
/// moment the hospital is waiting.
///
/// Throws ClarificationError for anything the caller could have got right: an
/// unknown question, an option that was never offered, a question already
/// answered, a sequence that has already closed.
export async function answerClarification(caseId, { questionId, answer }) {
  const row = await loadReportForClarification(caseId);
  if (!row) throw new ClarificationError('Report not found', 404);

  if (row.generation_status === 'completed') {
    throw new ClarificationError('This report has already been written', 409);
  }
  if (row.generation_status === 'failed') {
    throw new ClarificationError('This report failed — start it again', 409);
  }
  if (row.generation_status !== 'awaiting_clarification') {
    // 'processing' means the record is being written right now, by the sweep or
    // by a tap that landed a moment ago. One more answer cannot be taken into
    // account, and pretending otherwise would be a lie about what the hospital
    // is reading.
    throw new ClarificationError('The report is already being written', 409);
  }

  const clarifications = Array.isArray(row.clarifications) ? row.clarifications : [];
  const index = clarifications.findIndex((c) => c?.id === questionId);
  if (index === -1) throw new ClarificationError('No such question on this report', 404);

  const question = clarifications[index];
  if (question.answer != null && question.answer !== '') {
    throw new ClarificationError('That question has already been answered', 409);
  }

  // The answer must be one of the options the question offered. The sequence is
  // single-tap by design, so free text arriving here is a client bug or someone
  // poking the endpoint — either way it is not something to put in front of a
  // model that is about to write a clinical record.
  const chosen = (question.options || []).find(
    (opt) => String(opt).toLowerCase() === String(answer ?? '').trim().toLowerCase(),
  );
  if (!chosen) throw new ClarificationError('That is not one of the offered answers', 400);

  const next = [...clarifications];
  next[index] = { ...question, answer: chosen, answered_at: new Date().toISOString() };

  const state = clarificationStateFor(next);

  // Guarded on the status so this cannot write an answer onto a row the timeout
  // sweep has just claimed for generation.
  const { data: updated, error } = await supabaseAdmin
    .from('ai_reports')
    .update({ clarifications: next, clarification_state: state })
    .eq('id', row.id)
    .eq('generation_status', 'awaiting_clarification')
    .select(REPORT_COLUMNS)
    .maybeSingle();

  if (error) {
    logger.error(`Saving a clarification answer for case ${caseId} failed: ${error.message}`);
    throw new ClarificationError('The answer could not be saved. Please try again.', 500);
  }
  if (!updated) {
    throw new ClarificationError('The report is already being written', 409);
  }

  const remaining = next.filter((c) => !c?.answer && !c?.skipped_at).length;
  logger.info(
    `Case ${caseId}: answered ${question.id}, ${remaining} question(s) left`,
  );

  if (remaining > 0) {
    return { clarificationState: state, clarifications: next, remaining, report: null };
  }

  // Last one in — write the record.
  const report = await generateFinalReport(caseId);
  return { clarificationState: 'answered', clarifications: next, remaining: 0, report };
}

/// Closes the sequence and writes the record from whatever is known.
///
/// This is the deliberate skip, and it is a first-class ending rather than an
/// escape: it is what bounds the delay the blocking design imposes. Someone who
/// cannot answer — because they are doing compressions, because they genuinely
/// do not know — gets the hospital its record in one tap. Answers already given
/// still count; the rest are left as "Not reported", which is honest.
export async function skipClarifications(caseId) {
  const row = await loadReportForClarification(caseId);
  if (!row) throw new ClarificationError('Report not found', 404);

  if (row.generation_status === 'completed') {
    // Not an error worth stopping a screen for: the report they are about to be
    // shown is the one they wanted.
    return { clarificationState: row.clarification_state, alreadyWritten: true, report: null };
  }
  if (row.generation_status !== 'awaiting_clarification') {
    throw new ClarificationError('The report is already being written', 409);
  }

  const clarifications = Array.isArray(row.clarifications) ? row.clarifications : [];
  const now = new Date().toISOString();
  const closed = clarifications.map((c) =>
    c?.answer ? c : { ...c, skipped_at: c?.skipped_at || now },
  );

  const { data: updated, error } = await supabaseAdmin
    .from('ai_reports')
    .update({ clarifications: closed, clarification_state: clarificationStateFor(closed) })
    .eq('id', row.id)
    .eq('generation_status', 'awaiting_clarification')
    .select(REPORT_COLUMNS)
    .maybeSingle();

  if (error) {
    logger.error(`Closing the questions for case ${caseId} failed: ${error.message}`);
    throw new ClarificationError('Could not close the questions. Please try again.', 500);
  }
  if (!updated) {
    throw new ClarificationError('The report is already being written', 409);
  }

  const answered = closed.filter((c) => c?.answer).length;
  logger.info(
    `Case ${caseId}: questions skipped with ${answered} of ${closed.length} answered — generating.`,
  );

  const report = await generateFinalReport(caseId);
  return {
    clarificationState: clarificationStateFor(closed),
    clarifications: closed,
    alreadyWritten: false,
    report,
  };
}

export default {
  answerClarification,
  skipClarifications,
  getOpenClarifications,
  loadReportForClarification,
  ClarificationError,
};
