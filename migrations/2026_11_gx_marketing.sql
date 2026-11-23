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
