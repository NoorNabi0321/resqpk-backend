-- Blocking clarification before record generation (FR-13, FR-14, FR-15, NFR-06).
--
-- The clarification answers are INPUTS to the clinical record, not revisions of
-- one. Nothing reaches the receiving hospital until the questions have been
-- answered or deliberately skipped, and exactly one version of the record — and
-- one PDF — is ever produced.
--
-- This replaces an earlier progressive-refinement migration
-- (2026-10-24-report-clarifications.sql, now deleted) which modelled the record
-- as delivered first and refined afterwards. The statements below undo it if it
-- was ever applied, so this file is safe to run either way.

-- 1. The analysis phase has to survive between the questions being asked and
--    the record being written, so what the first phase learned is stored.
alter table ai_reports
  add column if not exists confidence_score numeric,
  add column if not exists clarifications jsonb not null default '[]'::jsonb,
  add column if not exists image_descriptions jsonb not null default '[]'::jsonb,
  add column if not exists clarification_state text not null default 'none',
  add column if not exists clarifications_asked_at timestamptz,
  add column if not exists clarifications_closed_at timestamptz;

-- 2. Undo the progressive-refinement model, if it is present. A record is no
--    longer "first pass" or "partially refined": it is written once, from the
--    inputs and whatever answers were given.
drop index if exists ai_reports_refinement_state_idx;

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'ai_reports_refinement_state_check'
  ) then
    alter table ai_reports drop constraint ai_reports_refinement_state_check;
  end if;
end $$;

alter table ai_reports drop column if exists refinement_state;

-- 3. Where the case is in the question sequence.
--
--    none      — no questions were put (the model offered nothing usable, or the
--                record was generated before this feature existed)
--    awaiting  — questions asked, record deliberately NOT yet generated
--    answered  — every question answered, record generated from the answers
--    skipped   — the sequence was skipped or part-answered, record generated
--                from the inputs plus whatever answers were given
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_reports_clarification_state_check'
  ) then
    alter table ai_reports
      add constraint ai_reports_clarification_state_check
      check (clarification_state in ('none', 'awaiting', 'answered', 'skipped'));
  end if;
end $$;

-- 4. generation_status gains 'awaiting_clarification' — a real, resumable state
--    rather than an absence of progress. A case sits here while the phone is
--    showing the questions, which is the one window in which the hospital has
--    nothing, and it is what lets the app resume the sequence after a restart.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'ai_reports'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%generation_status%'
  loop
    execute format('alter table ai_reports drop constraint %I', c.conname);
  end loop;

  alter table ai_reports
    add constraint ai_reports_generation_status_check
    check (generation_status in (
      'pending', 'processing', 'awaiting_clarification', 'completed', 'failed'
    ));
end $$;

-- Confidence is a 0–1 score for the finished record, surfaced to the reader.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_reports_confidence_score_check'
  ) then
    alter table ai_reports
      add constraint ai_reports_confidence_score_check
      check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));
  end if;
end $$;

-- 5. For the Chapter 5 measurement: how often the questions are answered rather
--    than skipped, and how long the sequence holds delivery up.
create index if not exists ai_reports_clarification_state_idx
  on ai_reports (clarification_state);

comment on column ai_reports.clarifications is
  'Array of {id, field, question, options[], answer, answered_at, skipped_at} — the questions put to the scene and the answers that fed the record generation.';

comment on column ai_reports.image_descriptions is
  'Vision output for each uploaded photo, kept from the analysis phase so record generation does not re-run it after the questions.';

comment on column ai_reports.clarifications_asked_at is
  'When the questions were put. With clarifications_closed_at this gives the delay the blocking sequence costs (NFR-06).';
