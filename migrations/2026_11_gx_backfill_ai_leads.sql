-- One-off backfill of existing ai_leads into gx_leads. Run AFTER 2026_11_gx_leads.sql.
-- Safe to re-run (unique index on source_detail->>'ai_lead_id').
-- Every column below is one that upsertAiLead() in index.js writes. If any is missing in your
-- table the statement errors and nothing is inserted, so run it separately from the table migrations.
-- The lead's SA becomes the owner directly: sa_id is service_agents.id, the same id staff_sessions
-- uses as staff_id. (No profiles lookup: SAs/GHAs are not rows in profiles.)
INSERT INTO gx_leads (source, name, email, phone, requirements, segment, status, owner_type, owner_id,
                      notes, consent_basis, source_detail, created_at, updated_at)
SELECT 'ai_chat',
       a.customer_name, a.customer_email, a.customer_phone,
       COALESCE(a.requirements, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
         'budget_max',                a.budget_max,
         'preferred_location',        a.preferred_location,
         'property_type',             a.property_type,
         'bedrooms',                  a.bedrooms,
         'purpose',                   a.purpose,
         'preferred_inspection_date', a.preferred_inspection_date,
         'preferred_inspection_time', a.preferred_inspection_time)),
       CASE a.purpose WHEN 'rent' THEN 'renter' WHEN 'shortlet' THEN 'shortlet' ELSE 'buyer' END,
       CASE upper(COALESCE(a.status, 'NEW'))
         WHEN 'CONTACTED'            THEN 'contacted'
         WHEN 'QUALIFIED'            THEN 'qualified'
         WHEN 'INTERESTED'           THEN 'qualified'
         WHEN 'INSPECTION_REQUESTED' THEN 'inspection_booked'
         WHEN 'INSPECTION_SCHEDULED' THEN 'inspection_booked'
         WHEN 'CLOSED'               THEN 'converted'
         WHEN 'LOST'                 THEN 'dead'
         ELSE 'new' END,
       CASE WHEN a.sa_id IS NOT NULL THEN 'SA' END,
       a.sa_id,
       a.ai_summary,
       'user_submitted',
       jsonb_strip_nulls(jsonb_build_object('ai_lead_id', a.id, 'conversation_id', a.conversation_id,
                          'property_id', a.property_id, 'agent_id', a.agent_id)),
       a.created_at, COALESCE(a.updated_at, a.created_at)
FROM ai_leads a
ON CONFLICT DO NOTHING;
