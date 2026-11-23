-- Growth Engine Phase 3: agent / agency recruitment pipeline.
-- Additive only. Run AFTER 2026_11_gx_leads.sql (reuses gx_set_updated_at()).
-- RLS on, no policies: backend service key only.

CREATE TABLE IF NOT EXISTS gx_recruit_campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  channel      TEXT,                          -- whatsapp | sms | email | social | field_visit | referral | event | other
  target_type  TEXT CHECK (target_type IN ('agent','agency','both')) DEFAULT 'both',
  state        TEXT,
  city         TEXT,
  budget_ngn   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (budget_ngn >= 0),
  start_date   DATE,
  end_date     DATE,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','completed')),
  notes        TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS gx_recruit_campaigns_updated_at ON gx_recruit_campaigns;
CREATE TRIGGER gx_recruit_campaigns_updated_at BEFORE UPDATE ON gx_recruit_campaigns
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

CREATE TABLE IF NOT EXISTS gx_prospects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL DEFAULT 'agent' CHECK (type IN ('agent','agency')),
  name            TEXT,
  agency_name     TEXT,
  phone           TEXT,                       -- normalised 234XXXXXXXXXX
  email           TEXT,                       -- lower-cased
  state           TEXT,
  city            TEXT,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv_import','referral','walk_in','social','event','website')),
  campaign_id     UUID REFERENCES gx_recruit_campaigns(id) ON DELETE SET NULL,
  owner_type      TEXT CHECK (owner_type IN ('SA','GHA','ADMIN')),
  owner_id        UUID,
  stage           TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','interested','applied','approved','subscribed','lost')),
  lost_reason     TEXT,
  next_follow_up  TIMESTAMPTZ,
  notes           TEXT,
  -- NDPR: how we obtained the contact, and the opt-out flag outreach must respect.
  consent_basis   TEXT NOT NULL CHECK (consent_basis IN ('public_business_listing','prospect_requested','existing_relationship','referred_by_agent')),
  do_not_contact  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Set automatically when the prospect registers on GetHome.
  profile_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  contacted_at    TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  subscribed_at   TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gx_prospects_has_contact CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS gx_prospects_phone_uniq ON gx_prospects(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gx_prospects_email_uniq ON gx_prospects(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_prospects_stage_idx    ON gx_prospects(stage);
CREATE INDEX IF NOT EXISTS gx_prospects_campaign_idx ON gx_prospects(campaign_id);
CREATE INDEX IF NOT EXISTS gx_prospects_owner_idx    ON gx_prospects(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS gx_prospects_profile_idx  ON gx_prospects(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_prospects_state_idx    ON gx_prospects(state, city);
CREATE INDEX IF NOT EXISTS gx_prospects_follow_idx   ON gx_prospects(next_follow_up)
  WHERE next_follow_up IS NOT NULL AND stage NOT IN ('subscribed','lost');
DROP TRIGGER IF EXISTS gx_prospects_updated_at ON gx_prospects;
CREATE TRIGGER gx_prospects_updated_at BEFORE UPDATE ON gx_prospects
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

CREATE TABLE IF NOT EXISTS gx_prospect_activity (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  activity     TEXT NOT NULL,   -- created | stage_changed | note_added | contacted | follow_up_set | assigned | opted_out | linked_profile
  actor        TEXT,
  payload      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_prospect_activity_idx ON gx_prospect_activity(prospect_id, created_at DESC);

ALTER TABLE gx_recruit_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_prospects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_prospect_activity ENABLE ROW LEVEL SECURITY;
