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

/// How long the questions may hold the record back, per channel.
///
/// In the app a question is a tap on a full-screen button: four of them take
/// well under a minute, even badly, even one-handed. Ninety seconds is generous
/// enough that nobody answering in good faith is cut off.
///
/// WhatsApp is not that. Every question is a round trip through Meta's
/// infrastructure, the reply has to be read and typed, and the keyboard may be
/// in the wrong script. Holding WhatsApp to the app's deadline would time out
/// people who were answering properly — so it gets four minutes. Still bounded,
/// and still a fraction of a ten to twenty minute ambulance journey.
export const CLARIFICATION_DEADLINE_MS = 90 * 1000;
export const WHATSAPP_DEADLINE_MS = 240 * 1000;

function deadlineFor(channel) {
  return channel === 'whatsapp' ? WHATSAPP_DEADLINE_MS : CLARIFICATION_DEADLINE_MS;
}

/// The shortest deadline, so one query can find every candidate and the
/// per-channel comparison can be made per row.
const SHORTEST_DEADLINE_MS = Math.min(CLARIFICATION_DEADLINE_MS, WHATSAPP_DEADLINE_MS);

/// Generates the records for every sequence that ran out of time.
///
/// Returns how many were closed out. Each is generated independently: one
/// failure must not hold up the others, because each is a different patient.
export async function reapAbandonedClarifications() {
  const cutoff = new Date(Date.now() - SHORTEST_DEADLINE_MS).toISOString();

  const { data: candidates, error } = await supabaseAdmin
    .from('ai_reports')
    .select('case_id, clarifications, clarifications_asked_at, emergency_cases!inner(channel)')
    .eq('generation_status', 'awaiting_clarification')
    .lt('clarifications_asked_at', cutoff);

  if (error) {
    logger.error(`Clarification sweep failed: ${error.message}`);
    return { generated: 0, failed: 0 };
  }
  if (!candidates || candidates.length === 0) return { generated: 0, failed: 0 };

  // The query found everything past the shortest deadline; each row is now
  // measured against its own channel's.
  const stalled = candidates.filter((row) => {
    const asked = new Date(row.clarifications_asked_at).getTime();
    if (!Number.isFinite(asked)) return true; // no timestamp — it has waited long enough
    return Date.now() - asked >= deadlineFor(row.emergency_cases?.channel);
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
      `Clarification sequence for case ${row.case_id} timed out after `
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
