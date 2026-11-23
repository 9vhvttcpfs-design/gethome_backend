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
