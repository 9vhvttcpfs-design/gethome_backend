-- GHA accompany fee + GHA salary
-- Run once in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- 1. Inspections: record whether the customer asked a GHA to accompany them,
--    and the flat GHA fee that was charged. Only gha_accompanied = true
--    inspections earn the GHA an inspection payment.
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS gha_accompanied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gha_fee_amount  numeric(12,2) NOT NULL DEFAULT 0;

-- 2. Staff payments: track GHA salary paid for the month (cumulative, so a
--    pro-rated salary paid early can be topped up if the GHA later hits target).
ALTER TABLE staff_payments
  ADD COLUMN IF NOT EXISTS salary_amount  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS salary_status  text,
  ADD COLUMN IF NOT EXISTS salary_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS salary_paid_by uuid;

-- 3. Default settings (admin can change all of these in Admin > Settings / Performance).
--    app_settings.setting_key is the upsert conflict target used by the API.
INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('gha_accompany_fee',  '0'),
  ('gha_salary',         '0'),
  ('gha_monthly_target', '25'),
  ('gha_ppa',            '0'),
  ('sa_monthly_target',  '0')
ON CONFLICT (setting_key) DO NOTHING;

-- 4. The old tiered fee setting is no longer read by the API. Optional cleanup:
-- DELETE FROM app_settings WHERE setting_key = 'inspection_fee_tiers';

-- properties.inspection_fee, inspection_fee_set_by and inspection_fee_set_at
-- already exist; existing fees set by SAs/admins are kept as-is.
