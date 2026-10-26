-- Proof that the phone showing the questions is still there.
--
-- The deadline exists to catch a device that has stopped, but with the answers
-- now buffered in the app and submitted in one go, nothing touches the server
-- between the questions being put and the sequence ending. A reader who takes
-- four minutes over two questions looked exactly like a dead phone, and was
-- swept — which is how three consecutive test cases were closed without a
-- single answer ever reaching the database.
--
-- The app pings while the question screen is open. The sweep measures from the
-- last of: questions asked, last answer, last ping.
alter table ai_reports
  add column if not exists clarifications_last_seen_at timestamptz;

comment on column ai_reports.clarifications_last_seen_at is
  'Last contact from the client while the questions were open. Liveness only — clarifications_asked_at remains the start of the sequence for the NFR-06 measurement.';
