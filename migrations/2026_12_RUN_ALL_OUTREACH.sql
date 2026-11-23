-- Outreach Command Centre: run this whole script ONCE in the Supabase SQL editor.
-- Prerequisite: the 2026_11 growth scripts have already been run.
-- Outreach Command Centre, Phase 1: database + CRM core.
-- Extends the existing gx_prospects / gx_recruit_campaigns / gx_suppressions tables (no parallel outreach_* set).
-- Run AFTER all 2026_11_gx_*.sql migrations. Idempotent. RLS on, no policies (backend service key only).
-- Nothing here is read by existing production features except the widened CHECK constraints on gx_prospects.

-- ===== 1. Extend gx_prospects =====
ALTER TABLE gx_prospects
  ADD COLUMN IF NOT EXISTS contact_person      TEXT,
  ADD COLUMN IF NOT EXISTS category            TEXT,
  ADD COLUMN IF NOT EXISTS website             TEXT,
  ADD COLUMN IF NOT EXISTS website_domain      TEXT,          -- lower-cased host without www (dedupe key)
  ADD COLUMN IF NOT EXISTS source_url          TEXT,          -- where this business was first found
  ADD COLUMN IF NOT EXISTS name_key            TEXT,          -- normalised business name (dedupe key)
  ADD COLUMN IF NOT EXISTS discovered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS email_permission    TEXT NOT NULL DEFAULT 'none',      -- explicit consent only; legitimate interest is evaluated at send time
  ADD COLUMN IF NOT EXISTS whatsapp_permission TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS email_attempts      INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_attempts   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_contacted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qualified_at        TIMESTAMPTZ;

ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_category_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_category_check
  CHECK (category IS NULL OR category IN ('independent_agent','established_agency','commercial_agent','residential_agent','property_consultant','other'));
ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_verification_status_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_verification_status_check
  CHECK (verification_status IN ('unverified','partially_verified','verified','invalid'));
ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_email_permission_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_email_permission_check CHECK (email_permission IN ('none','granted','withdrawn'));
ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_whatsapp_permission_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_whatsapp_permission_check CHECK (whatsapp_permission IN ('none','granted','withdrawn'));

-- Pipeline: Discovered(new) > Qualified > Permission Obtained > Campaign Ready > Contacted > Interested > Registered(applied/approved) > Subscribed
-- Legacy values (new, applied, approved) are kept so existing staff screens and stage sync keep working.
ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_stage_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_stage_check
  CHECK (stage IN ('new','qualified','permission_obtained','campaign_ready','contacted','interested','applied','approved','subscribed','lost'));

ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_source_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_source_check
  CHECK (source IN ('manual','csv_import','referral','walk_in','social','event','website','osm','website_crawl','provider'));

ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_consent_basis_check;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_consent_basis_check
  CHECK (consent_basis IN ('public_business_listing','prospect_requested','existing_relationship','referred_by_agent','legitimate_interest_b2b'));

-- Discovered businesses may have only a website or source URL (no phone/email yet).
ALTER TABLE gx_prospects DROP CONSTRAINT IF EXISTS gx_prospects_has_contact;
ALTER TABLE gx_prospects ADD CONSTRAINT gx_prospects_has_contact
  CHECK (phone IS NOT NULL OR email IS NOT NULL OR website IS NOT NULL OR source_url IS NOT NULL);

CREATE INDEX IF NOT EXISTS gx_prospects_domain_idx    ON gx_prospects(website_domain) WHERE website_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_prospects_namekey_idx   ON gx_prospects(name_key, state) WHERE name_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS gx_prospects_category_idx  ON gx_prospects(category);
CREATE INDEX IF NOT EXISTS gx_prospects_discovered_idx ON gx_prospects(discovered_at DESC);

-- ===== 2. Campaigns: pause / resume / stop =====
ALTER TABLE gx_recruit_campaigns
  ADD COLUMN IF NOT EXISTS sequence_id        UUID,
  ADD COLUMN IF NOT EXISTS daily_send_limit   INT,
  ADD COLUMN IF NOT EXISTS approval_required  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS started_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stopped_at         TIMESTAMPTZ;
ALTER TABLE gx_recruit_campaigns DROP CONSTRAINT IF EXISTS gx_recruit_campaigns_status_check;
ALTER TABLE gx_recruit_campaigns ADD CONSTRAINT gx_recruit_campaigns_status_check
  CHECK (status IN ('draft','active','paused','stopped','completed'));

-- ===== 3. Suppression list: reason + who =====
ALTER TABLE gx_suppressions
  ADD COLUMN IF NOT EXISTS reason   TEXT NOT NULL DEFAULT 'opt_out',   -- opt_out | bounce | complaint | admin | legal
  ADD COLUMN IF NOT EXISTS added_by TEXT;

-- ===== 4. Contacts (several per business) =====
CREATE TABLE IF NOT EXISTS gx_prospect_contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('email','phone','whatsapp')),
  value               TEXT NOT NULL,                 -- normalised: lower-case email, or 234XXXXXXXXXX
  label               TEXT,                          -- contact person's name
  role_title          TEXT,
  is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
  is_role_address     BOOLEAN NOT NULL DEFAULT FALSE, -- info@, sales@, etc.
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','format_valid','verified','invalid','bounced')),
  verified_at         TIMESTAMPTZ,
  verification_method TEXT,                          -- format | mx_lookup | manual | reply | delivery
  source_url          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, value)
);
CREATE INDEX IF NOT EXISTS gx_contacts_prospect_idx ON gx_prospect_contacts(prospect_id);

-- ===== 5. Where each prospect came from =====
CREATE TABLE IF NOT EXISTS gx_prospect_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  adapter      TEXT NOT NULL,                        -- osm | website_crawl | csv_import | manual | provider:<name>
  source_url   TEXT,
  job_id       UUID,
  raw          JSONB NOT NULL DEFAULT '{}',          -- exactly what the source returned
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_sources_prospect_idx ON gx_prospect_sources(prospect_id);

-- ===== 6. Consent records: append-only history, per contact and channel =====
CREATE TABLE IF NOT EXISTS gx_consent_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES gx_prospect_contacts(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email','whatsapp','sms','phone')),
  event       TEXT NOT NULL CHECK (event IN ('granted','withdrawn')),
  basis       TEXT NOT NULL CHECK (basis IN ('explicit_opt_in','prospect_requested','existing_relationship','referred_with_consent','imported_attested','withdrawn_by_prospect','withdrawn_by_admin')),
  source      TEXT NOT NULL,                         -- form name / URL / 'admin' / 'reply'
  evidence    TEXT,                                  -- quote, screenshot ref, message id
  recorded_by TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_consent_prospect_idx ON gx_consent_records(prospect_id, channel, occurred_at DESC);

-- The facts of a consent event can never change. Only prospect_id / contact_id may be re-pointed (duplicate merge).
CREATE OR REPLACE FUNCTION gx_consent_no_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel     IS DISTINCT FROM OLD.channel
  OR NEW.event       IS DISTINCT FROM OLD.event
  OR NEW.basis       IS DISTINCT FROM OLD.basis
  OR NEW.source      IS DISTINCT FROM OLD.source
  OR NEW.evidence    IS DISTINCT FROM OLD.evidence
  OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
  OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'gx_consent_records is append-only: record a new event instead';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS gx_consent_immutable ON gx_consent_records;
CREATE TRIGGER gx_consent_immutable BEFORE UPDATE ON gx_consent_records
  FOR EACH ROW EXECUTE FUNCTION gx_consent_no_update();

-- ===== 7. Discovery jobs =====
CREATE TABLE IF NOT EXISTS gx_discovery_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter        TEXT NOT NULL,
  state          TEXT,
  city           TEXT,
  target         TEXT NOT NULL DEFAULT 'agency' CHECK (target IN ('agency','agent','both')),
  params         JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  limit_count    INT NOT NULL DEFAULT 100,
  found_count    INT NOT NULL DEFAULT 0,
  inserted_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  error          TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gx_discovery_jobs_idx ON gx_discovery_jobs(status, created_at DESC);

-- ===== 8. Templates and sequences =====
CREATE TABLE IF NOT EXISTS gx_message_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  prospect_type TEXT CHECK (prospect_type IN ('independent_agent','established_agency','commercial_agent','residential_agent','property_consultant')),
  subject       TEXT,
  body          TEXT NOT NULL,                       -- may contain {{business_name}}, {{contact_name}}, {{city}}, {{state}}, {{link}}
  wa_template_name TEXT,                             -- Meta-approved template name (WhatsApp)
  wa_status     TEXT CHECK (wa_status IN ('draft','pending','approved','rejected')),
  language      TEXT NOT NULL DEFAULT 'en',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS gx_templates_updated_at ON gx_message_templates;
CREATE TRIGGER gx_templates_updated_at BEFORE UPDATE ON gx_message_templates
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

CREATE TABLE IF NOT EXISTS gx_sequences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  steps        JSONB NOT NULL DEFAULT '[]',          -- [{"step":1,"channel":"email","template_id":"...","delay_days":0},{"step":2,...,"delay_days":4}]
  max_attempts INT NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS gx_sequences_updated_at ON gx_sequences;
CREATE TRIGGER gx_sequences_updated_at BEFORE UPDATE ON gx_sequences
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();
ALTER TABLE gx_recruit_campaigns DROP CONSTRAINT IF EXISTS gx_recruit_campaigns_sequence_fk;
ALTER TABLE gx_recruit_campaigns ADD CONSTRAINT gx_recruit_campaigns_sequence_fk FOREIGN KEY (sequence_id) REFERENCES gx_sequences(id) ON DELETE SET NULL;

-- ===== 9. Message queue, replies, provider events =====
CREATE TABLE IF NOT EXISTS gx_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  contact_id          UUID REFERENCES gx_prospect_contacts(id) ON DELETE SET NULL,
  campaign_id         UUID REFERENCES gx_recruit_campaigns(id) ON DELETE SET NULL,
  step                INT NOT NULL DEFAULT 1,
  channel             TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  template_id         UUID REFERENCES gx_message_templates(id) ON DELETE SET NULL,
  subject             TEXT,
  body                TEXT NOT NULL,
  generated_by        TEXT NOT NULL DEFAULT 'template' CHECK (generated_by IN ('template','ai','human')),
  personalization     JSONB NOT NULL DEFAULT '{}',   -- the stored facts used to personalise (audit)
  consent_basis       TEXT,                          -- basis relied on at queue time
  status              TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('draft','pending_approval','approved','queued','sending','sent','delivered','bounced','failed','replied','cancelled')),
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  scheduled_for       TIMESTAMPTZ,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  provider            TEXT,
  provider_message_id TEXT,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  bounce_reason       TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_messages_queue_idx    ON gx_messages(status, scheduled_for);
CREATE INDEX IF NOT EXISTS gx_messages_prospect_idx ON gx_messages(prospect_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gx_messages_campaign_idx ON gx_messages(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS gx_messages_provider_uniq ON gx_messages(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
DROP TRIGGER IF EXISTS gx_messages_updated_at ON gx_messages;
CREATE TRIGGER gx_messages_updated_at BEFORE UPDATE ON gx_messages
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

CREATE TABLE IF NOT EXISTS gx_replies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id    UUID REFERENCES gx_prospects(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES gx_prospect_contacts(id) ON DELETE SET NULL,
  message_id     UUID REFERENCES gx_messages(id) ON DELETE SET NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  body           TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  classification TEXT NOT NULL DEFAULT 'unclassified' CHECK (classification IN ('unclassified','interested','not_interested','question','out_of_office','unsubscribe','other')),
  classified_by  TEXT NOT NULL DEFAULT 'none' CHECK (classified_by IN ('none','rules','ai','human')),
  needs_human    BOOLEAN NOT NULL DEFAULT TRUE,
  handled        BOOLEAN NOT NULL DEFAULT FALSE,
  handled_by     TEXT,
  handled_at     TIMESTAMPTZ,
  raw            JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS gx_replies_prospect_idx ON gx_replies(prospect_id, received_at DESC);
CREATE INDEX IF NOT EXISTS gx_replies_open_idx     ON gx_replies(needs_human, handled) WHERE needs_human AND NOT handled;

CREATE TABLE IF NOT EXISTS gx_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       UUID REFERENCES gx_prospects(id) ON DELETE CASCADE,
  message_id        UUID REFERENCES gx_messages(id) ON DELETE SET NULL,
  type              TEXT NOT NULL,                   -- delivered | bounced | complained | failed | read | inbound | stage_changed | consent | job ...
  provider          TEXT,
  provider_event_id TEXT,
  payload           JSONB NOT NULL DEFAULT '{}',
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS gx_events_provider_uniq ON gx_events(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;  -- webhook idempotency
CREATE INDEX IF NOT EXISTS gx_events_prospect_idx ON gx_events(prospect_id, occurred_at DESC);

-- ===== 10. Conversions: prospect -> registered -> approved -> paying, tied to a verified payment =====
CREATE TABLE IF NOT EXISTS gx_conversions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  profile_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  gha_id              UUID,
  sa_id               UUID,
  event               TEXT NOT NULL CHECK (event IN ('registered','approved','subscribed')),
  subscription_amount NUMERIC(14,2),
  payment_reference   TEXT,                          -- Flutterwave tx_ref; must match an earnings row to count as verified
  payment_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  verified_from       TEXT,                          -- gha_earnings | sa_earnings
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS gx_conversions_uniq ON gx_conversions(prospect_id, event, COALESCE(payment_reference, ''));
CREATE INDEX IF NOT EXISTS gx_conversions_gha_idx ON gx_conversions(gha_id) WHERE gha_id IS NOT NULL;

-- ===== 11. Audit log, settings, roles =====
CREATE TABLE IF NOT EXISTS gx_audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor      TEXT NOT NULL,
  actor_role TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    JSONB NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gx_audit_idx ON gx_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS gx_audit_entity_idx ON gx_audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS gx_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GetHome admins (profiles.role = 'admin') are treated as owners automatically. This table only grants
-- narrower access to other signed-in users.
CREATE TABLE IF NOT EXISTS gx_admin_roles (
  user_id    UUID PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin','recruiter','viewer')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO gx_settings (key, value) VALUES
  ('li_b2b_email_enabled',  'false'::jsonb),   -- turn on only after the Legitimate Interest Assessment is signed off
  ('max_email_attempts',    '2'::jsonb),       -- stop after this many unanswered emails
  ('max_whatsapp_attempts', '2'::jsonb),
  ('daily_discovery_limit', '300'::jsonb),
  ('daily_email_limit',     '100'::jsonb),
  ('email_sender_name',     '"GetHome"'::jsonb),
  ('reply_to_email',        '"gethome.realest@gmail.com"'::jsonb),
  ('retention_days_unengaged', '365'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ===== RLS: backend service key only =====
ALTER TABLE gx_prospect_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_prospect_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_consent_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_discovery_jobs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_sequences         ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_replies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_conversions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gx_admin_roles       ENABLE ROW LEVEL SECURITY;

-- ===== part 2: operations =====
-- Outreach Command Centre, phases 2-8: sequence enrolments, template variables, starter templates.
-- Run AFTER 2026_12_gx_outreach_core.sql. Idempotent. RLS on, no policies (backend service key only).

ALTER TABLE gx_message_templates ADD COLUMN IF NOT EXISTS variables TEXT[] NOT NULL DEFAULT '{}';   -- WhatsApp: ordered list matching {{1}}, {{2}} in the approved template

-- One row per prospect per campaign: where they are in the follow-up sequence.
CREATE TABLE IF NOT EXISTS gx_sequence_enrollments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  UUID NOT NULL REFERENCES gx_prospects(id) ON DELETE CASCADE,
  campaign_id  UUID NOT NULL REFERENCES gx_recruit_campaigns(id) ON DELETE CASCADE,
  sequence_id  UUID NOT NULL REFERENCES gx_sequences(id) ON DELETE CASCADE,
  contact_id   UUID REFERENCES gx_prospect_contacts(id) ON DELETE SET NULL,
  current_step INT NOT NULL DEFAULT 1,                -- the step that is next to be sent
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped')),
  stop_reason  TEXT,                                  -- reply | registered | subscribed | opted_out | bounced | admin | max_attempts | consent_changed
  next_send_at TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prospect_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS gx_enrol_due_idx ON gx_sequence_enrollments(status, next_send_at);
DROP TRIGGER IF EXISTS gx_enrol_updated_at ON gx_sequence_enrollments;
CREATE TRIGGER gx_enrol_updated_at BEFORE UPDATE ON gx_sequence_enrollments
  FOR EACH ROW EXECUTE FUNCTION gx_set_updated_at();

ALTER TABLE gx_messages ADD COLUMN IF NOT EXISTS enrollment_id UUID REFERENCES gx_sequence_enrollments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS gx_messages_enrol_idx ON gx_messages(enrollment_id);

ALTER TABLE gx_sequence_enrollments ENABLE ROW LEVEL SECURITY;

-- Extra settings (defaults only; existing values are kept)
INSERT INTO gx_settings (key, value) VALUES
  ('ai_provider',            '"template"'::jsonb),    -- template | anthropic | openai_compatible
  ('email_provider',         '"resend"'::jsonb),      -- resend | smtp
  ('send_spacing_ms',        '700'::jsonb)            -- pause between emails (provider rate limit)
ON CONFLICT (key) DO NOTHING;

-- Starter email templates, one per prospect type, plus a follow-up. Edit them in the dashboard.
-- Placeholders: {{contact_name}} {{business_name}} {{city}} {{state}} {{link}} {{sender_name}}
INSERT INTO gx_message_templates (name, channel, prospect_type, subject, body, created_by)
SELECT v.name, 'email', v.ptype, v.subject, v.body, 'system'
FROM (VALUES
  ('Independent agent - intro', 'independent_agent',
   'List your properties on GetHome',
   E'Hello {{contact_name}},\n\nI am writing from {{sender_name}}. GetHome is a Nigerian property marketplace that connects property seekers with verified real estate agents. We are inviting independent agents{{in_location}} to list their properties on the platform.\n\nVerified agents have their listings shown to people searching for homes, and inspection bookings are handled on the platform.\n\nYou can see how it works and register here: {{link}}\n\nIf you would like to know more, just reply to this email.\n\nKind regards,\n{{sender_name}}'),
  ('Established agency - intro', 'established_agency',
   'Invitation for {{business_name}} to join GetHome',
   E'Hello {{contact_name}},\n\nI am writing from {{sender_name}}. GetHome is a Nigerian property marketplace that connects property seekers with verified real estate agencies and agents. We are inviting established agencies{{in_location}} to list their properties on GetHome, and {{business_name}} came to mind.\n\nAgencies can list properties for seekers to browse, and inspection bookings are handled on the platform.\n\nYou can learn more and register here: {{link}}\n\nIf it would help to talk it through, just reply to this email.\n\nKind regards,\n{{sender_name}}'),
  ('Commercial agent - intro', 'commercial_agent',
   'Reach commercial property seekers on GetHome',
   E'Hello {{contact_name}},\n\nI am writing from {{sender_name}}. GetHome is a Nigerian property marketplace that covers residential and commercial properties, land, rentals and shortlets, and connects seekers with verified agents. We are inviting commercial property agents{{in_location}} to list on the platform.\n\nYou can see how it works and register here: {{link}}\n\nIf you have questions, just reply to this email.\n\nKind regards,\n{{sender_name}}'),
  ('Residential agent - intro', 'residential_agent',
   'List your homes for sale and rent on GetHome',
   E'Hello {{contact_name}},\n\nI am writing from {{sender_name}}. GetHome is a Nigerian property marketplace that connects people looking for homes with verified agents. We are inviting residential agents{{in_location}} to list apartments, houses and land on the platform.\n\nVerified agents have their listings shown to people searching for homes, and inspection bookings are handled on the platform.\n\nYou can see how it works and register here: {{link}}\n\nIf you would like to know more, just reply to this email.\n\nKind regards,\n{{sender_name}}'),
  ('Property consultant - intro', 'property_consultant',
   'GetHome for property consultants',
   E'Hello {{contact_name}},\n\nI am writing from {{sender_name}}. GetHome is a Nigerian property marketplace that connects property seekers with verified agents and consultants. We are inviting property consultants{{in_location}} to list the properties they handle on the platform.\n\nYou can see how it works and register here: {{link}}\n\nIf you have questions, just reply to this email.\n\nKind regards,\n{{sender_name}}'),
  ('Follow-up (all types)', NULL,
   'Following up: GetHome for {{business_name}}',
   E'Hello {{contact_name}},\n\nI am following up on my earlier email about listing properties on GetHome, the Nigerian property marketplace that connects seekers with verified agents and agencies.\n\nIf you would like to see how it works, you can register here: {{link}}\n\nIf this is not relevant to you, no problem. Just reply and tell me, or use the unsubscribe link below, and we will not contact you again.\n\nKind regards,\n{{sender_name}}')
) AS v(name, ptype, subject, body)
WHERE NOT EXISTS (SELECT 1 FROM gx_message_templates t WHERE t.name = v.name);
