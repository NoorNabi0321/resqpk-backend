-- ============================================================================
-- ResQPK — Workstream A migration: cases without accounts
--
-- Purpose: a person in an emergency is never asked to register. A case can be
-- created with no user behind it, and is reached afterwards by an access code
-- or a tokenised link instead of a login.
--
-- Safe to re-run. Additive only: no column is dropped, no data is rewritten.
-- Verified against the live schema on 2026-09-18 (38 existing cases).
-- Run in: Supabase → SQL Editor → New query → Run.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. A case no longer requires a registered user
--
-- patient_id stays for cases raised by signed-in users and for cases claimed
-- later with an access code. It simply becomes optional.
-- ----------------------------------------------------------------------------
ALTER TABLE public.emergency_cases ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE public.ai_reports      ALTER COLUMN patient_id DROP NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. Anonymous reporter details, the access code, and the intake channel
--
-- access_code is the only value a patient types. It must be unguessable:
-- case_number (RQ-20260918-0001) increments daily, so it can never be a
-- credential — anyone could count upwards and read other people's emergencies.
--
-- Existing rows are backfilled automatically by the column defaults:
-- 38 historical cases become channel='app', reported_for='self'.
-- ----------------------------------------------------------------------------
ALTER TABLE public.emergency_cases
  ADD COLUMN IF NOT EXISTS access_code    VARCHAR(16),
  ADD COLUMN IF NOT EXISTS reporter_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS reporter_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reported_for   VARCHAR(10) NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS channel        VARCHAR(20) NOT NULL DEFAULT 'app';

-- Constraints added separately so re-running the script cannot fail on them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_cases_access_code_key') THEN
    ALTER TABLE public.emergency_cases ADD CONSTRAINT emergency_cases_access_code_key
      UNIQUE (access_code);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_cases_reported_for_check') THEN
    ALTER TABLE public.emergency_cases ADD CONSTRAINT emergency_cases_reported_for_check
      CHECK (reported_for IN ('self', 'other'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_cases_channel_check') THEN
    ALTER TABLE public.emergency_cases ADD CONSTRAINT emergency_cases_channel_check
      CHECK (channel IN ('app', 'whatsapp', 'web'));
  END IF;

  -- Either a registered patient or a callback number must exist. A case with
  -- neither cannot be traced back to anyone, and the driver cannot phone ahead.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_cases_reachable_check') THEN
    ALTER TABLE public.emergency_cases ADD CONSTRAINT emergency_cases_reachable_check
      CHECK (patient_id IS NOT NULL OR reporter_phone IS NOT NULL);
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 3. Indexes
--
-- access_code: looked up on every "enter your request code".
-- reporter_phone + time: abuse control — how many SOS this number raised recently.
-- channel: the thesis channel-comparison queries (Table 10).
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cases_access_code
  ON public.emergency_cases(access_code) WHERE access_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cases_reporter_phone_recent
  ON public.emergency_cases(reporter_phone, sos_triggered_at DESC)
  WHERE reporter_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cases_channel
  ON public.emergency_cases(channel);


-- ----------------------------------------------------------------------------
-- 4. WhatsApp conversation state
--
-- The bot is a state machine, not a command handler: a user replying "1" is
-- answering a specific question. Render restarts and redeploys wipe memory, so
-- this cannot live in the Node process — a restart mid-emergency would lose
-- someone's half-finished SOS.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wa_sessions (
  phone            VARCHAR(20) PRIMARY KEY,
  state            VARCHAR(40) NOT NULL DEFAULT 'idle',
  case_id          UUID REFERENCES public.emergency_cases(id) ON DELETE SET NULL,
  context          JSONB NOT NULL DEFAULT '{}'::jsonb,
  language         VARCHAR(10) NOT NULL DEFAULT 'en',
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_sessions_expiry ON public.wa_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_case   ON public.wa_sessions(case_id);

-- The backend reaches Supabase with the service-role key, which bypasses RLS.
-- Enable it anyway so that nothing is readable if an anon key ever touches this
-- table: no policy is created, so no anon/authenticated role can read it.
ALTER TABLE public.wa_sessions ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- Verification — run this after the script and check the output
-- ============================================================================
SELECT
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'emergency_cases' AND column_name = 'patient_id')        AS cases_patient_nullable,
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'ai_reports' AND column_name = 'patient_id')             AS reports_patient_nullable,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_name = 'emergency_cases'
      AND column_name IN ('access_code','reporter_phone','reporter_name','reported_for','channel')) AS new_columns,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_name = 'wa_sessions')                                           AS wa_sessions_exists,
  (SELECT COUNT(*) FROM public.emergency_cases)                                 AS total_cases,
  (SELECT COUNT(*) FROM public.emergency_cases WHERE channel = 'app')           AS backfilled_app_cases;

-- Expected: YES | YES | 5 | 1 | 38 | 38
