-- generation_status was varchar(20). 'awaiting_clarification' is 22 characters.
--
-- The previous migration added the value to the CHECK constraint, which made it
-- legal, and never looked at whether the column could hold it. So every report
-- that reached the question stage died on the insert with "value too long for
-- type character varying(20)" — after the audio had been uploaded, transcribed
-- and the questions composed, which is the worst possible moment to lose one.
--
-- Widened to text rather than to a longer varchar. The CHECK constraint below
-- already states exactly which values are legal, so a length cap adds nothing
-- except a second place for a new status to fail, in a way that does not name
-- the column it failed on.
alter table ai_reports drop constraint if exists ai_reports_generation_status_check;

alter table ai_reports alter column generation_status type text;
alter table ai_reports alter column generation_status set default 'pending';

alter table ai_reports
  add constraint ai_reports_generation_status_check
  check (generation_status in (
    'pending', 'processing', 'awaiting_clarification', 'completed', 'failed'
  ));
