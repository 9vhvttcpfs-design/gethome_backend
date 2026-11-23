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
