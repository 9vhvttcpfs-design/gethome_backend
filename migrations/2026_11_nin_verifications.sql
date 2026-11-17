-- Stores every successful Prembly NIN verification keyed by NIN, so the result is
-- kept even when the check runs before the agent has an account (signup flow).
-- agent-register requires a row here before it creates the account.
-- Run once in the Supabase SQL editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS nin_verifications (
  nin           text PRIMARY KEY,
  verified_name text NOT NULL,
  dob           text,
  gender        text,
  phone         text,
  reference     text,
  verified_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nin_verifications ENABLE ROW LEVEL SECURITY; -- service role only
