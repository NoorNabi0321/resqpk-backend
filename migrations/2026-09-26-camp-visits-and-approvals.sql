-- Medical camps: their own patient records, and a real approval queue.
--
-- Two things that did not exist.
--
-- 1. A camp had nowhere to write down who it saw. A free eye camp seeing two
--    hundred people in a week left no record of any of them, so nobody could
--    be called back about a reading that needed following up.
--
-- 2. is_approved existed but nothing could set it. Four camps have been
--    sitting unapproved since July because approving one meant editing the
--    database by hand. The super_admin role is already in the users CHECK
--    constraint and in requireRole; it just had nothing to do.

-- 1. Approval trail ----------------------------------------------------------
--
-- is_approved stays the gate patients are filtered on. These say who opened it
-- and when, and let a refusal be told apart from a decision not yet made:
--   pending  = is_approved false and rejected_at null
--   rejected = rejected_at is not null
--   approved = is_approved true
alter table hospitals
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references users(id),
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists submitted_at timestamptz default now();

-- Everything already live was approved before this existed; say so rather than
-- leaving rows that look like they were never looked at.
update hospitals
set approved_at = coalesce(approved_at, created_at)
where is_approved = true and approved_at is null;

create index if not exists idx_hospitals_pending
  on hospitals (facility_type, is_approved)
  where is_approved = false;

-- 2. Camp patient records ----------------------------------------------------
--
-- Deliberately standalone: a walk-in at a free camp has no ResQPK account and
-- is not going to make one at the desk. phone is the only thread back to them
-- and it is optional, because plenty will not give it.
create table if not exists camp_visits (
  id uuid primary key default uuid_generate_v4(),

  -- The camp that saw them. Cascade: if a camp is deleted its records go with
  -- it rather than being orphaned into an unowned pile of medical data.
  camp_id uuid not null references hospitals(id) on delete cascade,

  -- Date rather than timestamp: a camp reports by day, and the desk should not
  -- have to think about time zones. Defaulted in Pakistan time, not UTC, or a
  -- visit at 3am PKT lands on yesterday.
  visited_on date not null default ((now() at time zone 'Asia/Karachi')::date),

  patient_name text not null,
  age integer check (age is null or (age >= 0 and age <= 130)),
  gender text check (gender is null or gender in ('male', 'female', 'other')),
  phone text,

  -- Which of the camp's own services_offered this person actually received.
  services_given text[] not null default '{}',

  -- Readings as written, not as parsed. "120/80", "14.2 mmol" and "high" are
  -- all things a volunteer will write, and refusing them loses the record.
  blood_pressure text,
  blood_sugar text,
  findings text,

  -- The one field that has to be searchable: who needs to be seen again.
  needs_followup boolean not null default false,
  followup_note text,

  recorded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The two questions a camp asks its own records: what happened today, and who
-- still needs chasing.
create index if not exists idx_camp_visits_camp_date
  on camp_visits (camp_id, visited_on desc);
create index if not exists idx_camp_visits_followup
  on camp_visits (camp_id, needs_followup)
  where needs_followup = true;

create trigger update_camp_visits_updated_at
  before update on camp_visits
  for each row execute function update_updated_at_column();

-- Row level security is on so that a leaked anon key cannot read the table.
-- It is not the real protection: the API talks through the service role, which
-- bypasses this, and scopes every read and write to the caller's own camp_id.
-- This is the second lock, not the first.
alter table camp_visits enable row level security;

comment on table camp_visits is
  'Patients seen at a medical camp. Camp-scoped: never read across camps, '
  'never exposed to hospitals or the patient app.';
