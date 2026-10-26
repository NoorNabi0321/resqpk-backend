// The bound on what the blocking sequence can cost.
//
// Holding the clinical record back until the questions are answered is a
// deliberate trade: the hospital waits a few seconds and gets a record with no
// version that was wrong. The trade only holds while someone is actually
// answering. A phone that dies on the third question, an app killed by the OS,
// a reporter who puts the phone down to do chest compressions — in every one of
// those the case would sit in 'awaiting_clarification' and the ward would get
// nothing at all, which is strictly worse than the design this replaced.
//
// So the sequence has a deadline. Past it the questions are marked skipped and
// the record is generated from the description alone, exactly as a deliberate
// skip would. The reporter is never blamed for it and never has to know.
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../middleware/logger.js';

import { generateFinalReport } from './ai.pipeline.js';
import notifier from '../whatsapp/notifier.js';

/// How long the sequence may go QUIET before the record is written anyway.
///
/// This is an inactivity timeout, not a total budget, and the distinction is
/// the whole point. The first version measured from the moment the questions
/// were put, which cut people off mid-sequence for the crime of reading: a
/// ninety-second allowance for three questions sounds generous until someone
/// spends forty seconds on the first one. Every tap now restarts the clock, so
/// a person who is engaged is never cut off, however long they take, while a
/// phone that has genuinely stopped is still detected promptly.
///
/// Three minutes of silence in the app. WhatsApp gets five: every question is a
/// round trip through Meta, the reply has to be read and typed, and the
/// keyboard may be in the wrong script. Both are bounded, and both are a
/// fraction of a ten to twenty minute ambulance journey.
export const CLARIFICATION_DEADLINE_MS = 300 * 1000;
export const WHATSAPP_DEADLINE_MS = 300 * 1000;

function deadlineFor(channel) {
  return channel === 'whatsapp' ? WHATSAPP_DEADLINE_MS : CLARIFICATION_DEADLINE_MS;
}

/// The shortest deadline, so one query can find every candidate and the
/// per-channel comparison can be made per row.
const SHORTEST_DEADLINE_MS = Math.min(CLARIFICATION_DEADLINE_MS, WHATSAPP_DEADLINE_MS);

/// The last sign that someone is still there: the questions being put, or the
/// most recent answer, whichever is later.
///
/// Read off the answers themselves rather than tracked in a column of its own,
/// so it cannot drift out of step with them — and so clarifications_asked_at
/// keeps meaning what the Chapter 5 measurement needs it to mean: when the
/// sequence started, not when it was last touched.
function lastActivityAt(row) {
  const stamps = [Date.parse(row.clarifications_asked_at)];
  // The app buffers its answers and sends them in one go, so between the
  // questions appearing and the sequence ending the only thing that reaches the
  // server is this ping. Without it, someone reading carefully is
  // indistinguishable from a phone that has stopped.
  if (row.clarifications_last_seen_at) stamps.push(Date.parse(row.clarifications_last_seen_at));
  for (const c of Array.isArray(row.clarifications) ? row.clarifications : []) {
    if (c?.answered_at) stamps.push(Date.parse(c.answered_at));
  }
  const valid = stamps.filter(Number.isFinite);
  // No usable timestamp at all: treat it as long overdue rather than letting it
  // sit in 'awaiting_clarification' forever with the hospital waiting.
  return valid.length ? Math.max(...valid) : 0;
}

/// Generates the records for every sequence that ran out of time.
///
/// Returns how many were closed out. Each is generated independently: one
/// failure must not hold up the others, because each is a different patient.
export async function reapAbandonedClarifications() {
  const cutoff = new Date(Date.now() - SHORTEST_DEADLINE_MS).toISOString();

  const { data: candidates, error } = await supabaseAdmin
    .from('ai_reports')
    .select(
      'case_id, clarifications, clarifications_asked_at, clarifications_last_seen_at, '
        + 'emergency_cases!inner(channel)',
    )
    .eq('generation_status', 'awaiting_clarification')
    .lt('clarifications_asked_at', cutoff);

  if (error) {
    logger.error(`Clarification sweep failed: ${error.message}`);
    return { generated: 0, failed: 0 };
  }
  if (!candidates || candidates.length === 0) return { generated: 0, failed: 0 };

  // The query found everything whose questions were put longer ago than the
  // shortest deadline, which is a safe lower bound because nothing can have
  // been answered before it was asked. Each row is now measured properly: its
  // own channel's deadline, against its own last sign of life.
  const stalled = candidates.filter((row) => {
    const quietFor = Date.now() - lastActivityAt(row);
    return quietFor >= deadlineFor(row.emergency_cases?.channel);
  });
  if (stalled.length === 0) return { generated: 0, failed: 0 };

  let generated = 0;
  let failed = 0;

  for (const row of stalled) {
    const now = new Date().toISOString();
    const clarifications = (Array.isArray(row.clarifications) ? row.clarifications : []).map((c) =>
      c?.answer ? c : { ...c, skipped_at: c?.skipped_at || now },
    );

    // Mark the questions closed first. If generation then fails, the sweep will
    // not try to re-skip them, and the answers that were given are preserved.
    const { error: closeError } = await supabaseAdmin
      .from('ai_reports')
      .update({ clarifications })
      .eq('case_id', row.case_id)
      .eq('generation_status', 'awaiting_clarification');
    if (closeError) {
      logger.error(`Could not close questions for case ${row.case_id}: ${closeError.message}`);
      failed += 1;
      continue;
    }

    const answered = clarifications.filter((c) => c?.answer).length;
    const channel = row.emergency_cases?.channel;
    logger.warn(
      `Clarification sequence for case ${row.case_id} went quiet for `
        + `${Math.round(deadlineFor(channel) / 1000)}s (${channel || 'app'}) with ${answered} of `
        + `${clarifications.length} answered — generating the record without the rest.`,
    );

    try {
      // generateFinalReport claims the row off 'awaiting_clarification', so a
      // reporter who answers in the same instant as this sweep cannot cause two
      // records: whichever lands first wins and the other is a no-op.
      const result = await generateFinalReport(row.case_id);
      if (!result) continue;
      generated += 1;

      // A chat user has no socket and no app to notice this, so the report has
      // to be pushed into the thread, with the line that explains why it is
      // arriving without them having finished. No-op for every other channel.
      await notifier
        .notifyReportReady(row.case_id, result, { preamble: (c) => c.clarifyTimedOut })
        .catch((err) =>
          logger.warn(`Could not deliver the timed-out report to chat: ${err.message}`),
        );
    } catch (err) {
      failed += 1;
      logger.error(`Timed-out record generation failed for ${row.case_id}: ${err.message}`);
    }
  }

  return { generated, failed };
}

export const clarificationTimeoutInternals = {
  CLARIFICATION_DEADLINE_MS,
  WHATSAPP_DEADLINE_MS,
  deadlineFor,
};

export default {
  reapAbandonedClarifications,
  CLARIFICATION_DEADLINE_MS,
  WHATSAPP_DEADLINE_MS,
};
