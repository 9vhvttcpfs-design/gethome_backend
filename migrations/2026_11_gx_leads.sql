-- Growth Engine: gx_leads, gx_lead_events
-- Additive only. No existing table is altered. Review before running in the Supabase SQL editor.
-- RLS is enabled with NO policies: only the backend (service key) can read/write.

CREATE TABLE IF NOT EXISTS gx_leads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL CHECK (source IN ('ai_chat','signup_form','property_enquiry','whatsapp','manual','csv_import','agent_referral')),
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  referral_code  TEXT,
  landing_page   TEXT,
  session_id     TEXT,                       -- links to gx_attribution / ai_conversations.session_id
  profile_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  name           TEXT,
  email          TEXT,
  phone          TEXT,
  requirements   JSONB NOT NULL DEFAULT '{}',   -- purpose, property_type, bedrooms, state, city, location, budget_max, timeline
  segment        TEXT NOT NULL DEFAULT 'buyer' CHECK (segment IN ('buyer','renter','shortlet','seller','investor','agent_prospect')),
  status         TEXT NOT NULL DEFAULT 'new'   CHECK (status  IN ('new','contacted','qualified','inspection_booked','converted','dead')),
  owner_type     TEXT CHECK (owner_type IN ('SA','GHA','ADMIN')),
  owner_id       UUID,
  next_follow_up TIMESTAMPTZ,
  notes          TEXT,
  -- NDPR: consent and opt-out are first-class. Outreach code must respect do_not_contact.
  consent_basis  TEXT,                       -- 'user_submitted' | 'signup' | 'imported_with_consent'
  do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
  source_detail  JSONB NOT NULL DEFAULT '{}',   -- e.g. {"ai_lead_id": "...", "property_id": "..."}
  converted_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gx_leads_status_idx     ON gx_leads(status);
CREATE INDEX IF NOT EXISTS gx_leads_segment_idx    ON gx_leads(segment);
CREATE INDEX IF NOT EXISTS gx_leads_source_idx     ON gx_leads(source);
CREATE INDEX IF NOT EXISTS gx_leads_owner_idx      ON gx_leads(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS gx_leads_profile_idx    ON gx_leads(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_leads_session_idx    ON gx_leads(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_leads_created_idx    ON gx_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS gx_leads_phone_idx      ON gx_leads(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_leads_email_idx      ON gx_leads(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_leads_follow_up_idx  ON gx_leads(next_follow_up)
  WHERE next_follow_up IS NOT NULL AND status NOT IN ('converted','dead');
-- One gx_lead per originating ai_leads row (makes backfill and live sync idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS gx_leads_ai_lead_uniq ON gx_leads((source_detail->>'ai_lead_id'))
  WHERE source_detail ? 'ai_lead_id';

CREATE OR REPLACE FUNCTION gx_set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS gx_leads_updated_at ON gx_leads;
CREATE TRIGGER gx_leads_updated_at BEFORE UPDATE ON gx_leads
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

CREATE TABLE IF NOT EXISTS gx_lead_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID NOT NULL REFERENCES gx_leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,   -- created | status_changed | note_added | contacted | follow_up_set | assigned | inspection_booked | converted | opted_out
  actor      TEXT,            -- 'system' | 'ai_assistant' | staff/admin id
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_lead_events_lead_idx ON gx_lead_events(lead_id, created_at DESC);

ALTER TABLE gx_leads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_lead_events ENABLE ROW LEVEL SECURITY;
