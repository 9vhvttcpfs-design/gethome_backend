-- Listing verification (GHA / SA proof -> admin confirmation -> immediate payout)
-- Run once in the Supabase SQL editor. Safe to re-run.
-- NOTE: properties.id is assumed to be bigint/integer (the API parses it as an int).
-- If your properties.id is a uuid, change property_id below to uuid.

CREATE TABLE IF NOT EXISTS listing_verifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      bigint NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL,
  staff_type       text NOT NULL CHECK (staff_type IN ('GHA', 'SA')),
  staff_code       text,
  media_urls       jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes            text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  rejection_reason text,
  fee_amount       numeric(12,2) NOT NULL DEFAULT 0,   -- locked in when admin confirms
  payment_status   text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  paid_at          timestamptz,
  paid_by          uuid,
  reviewed_at      timestamptz,
  reviewed_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_verifications_property ON listing_verifications (property_id);
CREATE INDEX IF NOT EXISTS idx_listing_verifications_staff    ON listing_verifications (staff_type, staff_id);
CREATE INDEX IF NOT EXISTS idx_listing_verifications_status   ON listing_verifications (status, created_at DESC);

-- Only one open (pending) verification per listing at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_verifications_one_pending
  ON listing_verifications (property_id) WHERE status = 'pending';

-- Only the API (service role) touches this table.
ALTER TABLE listing_verifications ENABLE ROW LEVEL SECURITY;

-- Default verification fees (admin changes these in Admin > Verifications).
INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('verification_fee_gha', '0'),
  ('verification_fee_sa',  '0')
ON CONFLICT (setting_key) DO NOTHING;

-- properties.gha_verified, gha_verified_at and gha_verified_by already exist and are reused.
-- The storage bucket used for proof uploads is the existing property-media bucket
-- (folder: verifications/<property_id>/).
