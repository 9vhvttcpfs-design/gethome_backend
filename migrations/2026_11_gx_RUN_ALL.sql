
-- ===== 2026_11_gx_leads.sql =====
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

-- ===== 2026_11_gx_attribution.sql =====
-- Growth Engine: gx_attribution, gx_spend
-- Additive only. Run AFTER 2026_11_gx_leads.sql. RLS on, no policies (backend service key only).

-- First-touch attribution, one row per anonymous browser session.
CREATE TABLE IF NOT EXISTS gx_attribution (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    TEXT NOT NULL UNIQUE,          -- frontend-generated; same id the AI chat already sends
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  utm_term      TEXT,
  referral_code TEXT,                          -- GHA code from ?ref=
  landing_page  TEXT,
  referrer      TEXT,
  profile_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  lead_id       UUID REFERENCES gx_leads(id) ON DELETE SET NULL,
  linked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_attribution_profile_idx ON gx_attribution(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_attribution_source_idx  ON gx_attribution(utm_source) WHERE utm_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_attribution_ref_idx     ON gx_attribution(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_attribution_created_idx ON gx_attribution(created_at DESC);

-- Marketing spend, entered by admin. Joined to gx_attribution for cost per lead / signup / paying agent.
CREATE TABLE IF NOT EXISTS gx_spend (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       TEXT NOT NULL,                 -- google_ads | meta | twitter | tiktok | influencer | sms | flyers | gha_incentive | other
  campaign_name TEXT,
  utm_campaign  TEXT,                          -- lets spend join to attribution rows
  amount_ngn    NUMERIC(14,2) NOT NULL CHECK (amount_ngn >= 0),
  spend_date    DATE NOT NULL,
  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_spend_channel_idx ON gx_spend(channel);
CREATE INDEX IF NOT EXISTS gx_spend_date_idx    ON gx_spend(spend_date DESC);

ALTER TABLE gx_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_spend       ENABLE ROW LEVEL SECURITY;

-- ===== 2026_11_gx_recruitment.sql =====
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

-- ===== 2026_11_gx_outreach.sql =====
-- Growth Engine Phase 3b: outreach drafts/sends, suppression list, prospect sync timestamp.
-- Additive only. Run AFTER 2026_11_gx_recruitment.sql. RLS on, no policies (backend service key only).

ALTER TABLE gx_prospects ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

-- One row per message generated for a prospect. Email can be sent by the backend; WhatsApp/SMS are
-- drafted for the recruiter to copy and send from their own phone, then confirmed with mark-sent.
CREATE TABLE IF NOT EXISTS gx_outreach (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('email','whatsapp','sms')),
  template     TEXT NOT NULL DEFAULT 'intro',
  subject      TEXT,
  message_text TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft_ready' CHECK (status IN ('draft_ready','sent','sent_manual','failed')),
  provider_id  TEXT,
  error        TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gx_outreach_prospect_idx ON gx_outreach(prospect_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gx_outreach_sent_idx     ON gx_outreach(channel, sent_at) WHERE status = 'sent';

-- Permanent do-not-contact list (normalised phone 234XXXXXXXXXX or lower-cased email).
-- Checked on import and before any outreach, so an opted-out person cannot be re-added later.
CREATE TABLE IF NOT EXISTS gx_suppressions (
  value      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE gx_outreach     ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_suppressions ENABLE ROW LEVEL SECURITY;

-- Maps the AI chat's per-tab session id to the visitor's attribution row.
ALTER TABLE gx_attribution ADD COLUMN IF NOT EXISTS ai_session_id TEXT;
CREATE INDEX IF NOT EXISTS gx_attribution_ai_session_idx ON gx_attribution(ai_session_id) WHERE ai_session_id IS NOT NULL;

-- ===== 2026_11_gx_marketing.sql =====
-- Growth Engine Phase 5: marketing campaigns + content calendar.
-- Additive only. Run AFTER 2026_11_gx_leads.sql (reuses gx_set_updated_at()). RLS on, no policies.

CREATE TABLE IF NOT EXISTS gx_campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  -- Lowercase slug used as utm_campaign on every tracked link, so sessions, signups, leads and spend
  -- can be joined back to this campaign.
  utm_campaign TEXT NOT NULL UNIQUE CHECK (utm_campaign ~ '^[a-z0-9_]{3,40}$'),
  goal         TEXT NOT NULL DEFAULT 'customer_acquisition' CHECK (goal IN ('customer_acquisition','agent_recruitment','brand_awareness')),
  channel      TEXT,                              -- instagram | facebook | x | tiktok | whatsapp | google_ads | youtube | email | other
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
DROP TRIGGER IF EXISTS gx_campaigns_updated_at ON gx_campaigns;
CREATE TRIGGER gx_campaigns_updated_at BEFORE UPDATE ON gx_campaigns
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

CREATE TABLE IF NOT EXISTS gx_content_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID REFERENCES gx_campaigns(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('social_post','video_script','ad_copy','whatsapp_broadcast','email','seo_blurb')),
  platform       TEXT,
  title          TEXT,
  body           TEXT NOT NULL,
  hashtags       TEXT,
  link_url       TEXT,                            -- tracked link included in the copy
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('idea','draft','approved','scheduled','published','rejected')),
  scheduled_for  TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  published_url  TEXT,
  generated_by   TEXT NOT NULL DEFAULT 'human' CHECK (generated_by IN ('human','ai')),
  context        JSONB NOT NULL DEFAULT '{}',     -- the real facts the AI was given (for audit)
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_content_status_idx   ON gx_content_items(status, scheduled_for);
CREATE INDEX IF NOT EXISTS gx_content_campaign_idx ON gx_content_items(campaign_id);
DROP TRIGGER IF EXISTS gx_content_updated_at ON gx_content_items;
CREATE TRIGGER gx_content_updated_at BEFORE UPDATE ON gx_content_items
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

ALTER TABLE gx_campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_content_items  ENABLE ROW LEVEL SECURITY;
