-- Stores every successful Prembly CAC verification keyed by normalized RC number
-- (e.g. RC123456, BN7890), so the result survives even when the check runs before
-- the agency has an account. Agency registration requires a row here.
-- Run once in the Supabase SQL editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS cac_verifications (
  cac_key           text PRIMARY KEY,
  company_name      text NOT NULL,
  company_status    text,
  registration_date text,
  reference         text,
  verified_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cac_verifications ENABLE ROW LEVEL SECURITY; -- service role only
