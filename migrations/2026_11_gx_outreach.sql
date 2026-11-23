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
