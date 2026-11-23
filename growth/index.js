// GetHome Growth Engine - Phase 1: lead capture, CRM, attribution, spend.
// Mounted from index.js with one line. Uses only gx_* tables (see migrations/2026_11_gx_*.sql).
// Helpers used by existing flows (linkSignup, syncAiLead) swallow their own errors so a
// growth-side failure can never break signup or the AI chat.
const { limiter } = require('../middleware/security');
const createAuth = require('../middleware/auth');

const SEGMENTS = ['buyer', 'renter', 'shortlet', 'seller', 'investor', 'agent_prospect'];
const STATUSES = ['new', 'contacted', 'qualified', 'inspection_booked', 'converted', 'dead'];
const PUBLIC_SOURCES = ['signup_form', 'property_enquiry', 'whatsapp'];
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function clip(v, n) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n || 200) : null;
}
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('234')) return d.length >= 12 && d.length <= 13 ? d : null;
  if (d.startsWith('0') && d.length === 11) return '234' + d.slice(1);
  if (d.length === 10) return '234' + d;
  return d.length >= 8 && d.length <= 15 ? d : null;
}
function validEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

module.exports = function mountGrowth(app, db) {
  const auth = createAuth(db);

  async function event(leadId, type, actor, payload) {
    try {
      await db.from('gx_lead_events').insert([{ lead_id: leadId, event_type: type, actor: actor || 'system', payload: payload || {} }]);
    } catch (e) { /* timeline is best-effort */ }
  }

  async function attributionFor(sessionId) {
    if (!sessionId) return null;
    const { data } = await db.from('gx_attribution').select('*').eq('session_id', sessionId).maybeSingle();
    return data || null;
  }

  // Combined CRM auth: admin sees everything; SA/GHA only leads they own.
  async function requireCrm(req, res, next) {
    try {
      const admin = await auth.getAdmin(req);
      if (admin) { req.crm = { type: 'ADMIN', id: admin.id, actor: admin.email || admin.id }; return next(); }
      const staff = await auth.getStaff(req);
      if (staff && (staff.staff_role === 'SA' || staff.staff_role === 'GHA')) {
        req.crm = { type: staff.staff_role, id: staff.staff_id, actor: staff.staff_role + ':' + staff.staff_id };
        return next();
      }
      return res.status(401).json({ error: 'Unauthorized' });
    } catch (e) { return res.status(500).json({ error: 'Auth check failed' }); }
  }

  function canTouch(crm, lead) {
    return crm.type === 'ADMIN' || (lead.owner_type === crm.type && String(lead.owner_id) === String(crm.id));
  }

  // ---- Public: first-touch attribution (frontend calls this once on first page load) ----
  app.post('/api/growth/attribution', limiter(60 * 1000, 30), async (req, res) => {
    try {
      const b = req.body || {};
      const session_id = clip(b.session_id, 64);
      if (!session_id || session_id.length < 8) return res.status(400).json({ error: 'session_id required' });
      const row = { session_id };
      UTM_KEYS.forEach(k => { row[k] = clip(b[k], 120); });
      const ref = clip(b.referral_code, 40);
      row.referral_code = ref ? ref.toUpperCase() : null;
      row.landing_page = clip(b.landing_page, 500);
      row.referrer = clip(b.referrer, 500);
      // First touch wins: never overwrite an existing session row.
      const { error } = await db.from('gx_attribution').upsert([row], { onConflict: 'session_id', ignoreDuplicates: true });
      if (error) { console.error('gx attribution error:', error.message); return res.json({ ok: false }); }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false }); }
  });

  // ---- Public: lead capture form / "notify me" / property enquiry ----
  app.post('/api/growth/leads', limiter(10 * 60 * 1000, 10), async (req, res) => {
    try {
      const b = req.body || {};
      const phone = normPhone(b.phone);
      const email = validEmail(b.email) ? b.email.trim().toLowerCase() : null;
      if (!phone && !email) return res.status(400).json({ error: 'A valid phone number or email is required.' });
      if (b.consent !== true) return res.status(400).json({ error: 'Consent is required so we can contact you about your request.' });
      const segment = SEGMENTS.includes(b.segment) && b.segment !== 'agent_prospect' ? b.segment : 'buyer';
      const source = PUBLIC_SOURCES.includes(b.source) ? b.source : 'signup_form';
      const r = b.requirements && typeof b.requirements === 'object' ? b.requirements : {};
      const requirements = {
        purpose: clip(r.purpose, 20), property_type: clip(r.property_type, 40),
        bedrooms: Number.isFinite(+r.bedrooms) && r.bedrooms !== null && r.bedrooms !== '' ? +r.bedrooms : null,
        state: clip(r.state, 60), city: clip(r.city, 60), location: clip(r.location, 120),
        budget_max: Number.isFinite(+r.budget_max) && r.budget_max !== null && r.budget_max !== '' ? +r.budget_max : null,
        timeline: clip(r.timeline, 60),
      };
      Object.keys(requirements).forEach(k => requirements[k] === null && delete requirements[k]);

      // De-duplicate: same phone/email in the last 30 days that is still open.
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      let q = db.from('gx_leads').select('id').gte('created_at', since).not('status', 'in', '(converted,dead)').limit(1);
      q = phone && email ? q.or('phone.eq.' + phone + ',email.eq.' + email) : (phone ? q.eq('phone', phone) : q.eq('email', email));
      const { data: dup } = await q;
      if (dup && dup.length) {
        await event(dup[0].id, 'note_added', 'system', { message: 'Repeat enquiry', requirements });
        return res.json({ ok: true });
      }

      const session_id = clip(b.session_id, 64);
      const attr = await attributionFor(session_id);
      const lead = {
        source, segment, name: clip(b.name, 120), email, phone, requirements,
        session_id, consent_basis: 'user_submitted',
        landing_page: attr ? attr.landing_page : null, referral_code: attr ? attr.referral_code : null,
      };
      UTM_KEYS.forEach(k => { lead[k] = attr ? attr[k] : null; });
      const { data, error } = await db.from('gx_leads').insert([lead]).select('id').single();
      if (error) { console.error('gx lead insert error:', error.message); return res.status(500).json({ error: 'Could not save your request. Please try again.' }); }
      await event(data.id, 'created', 'system', { source });
      if (attr && !attr.lead_id) await db.from('gx_attribution').update({ lead_id: data.id }).eq('id', attr.id);
      res.json({ ok: true });
    } catch (e) {
      console.error('gx lead error:', e.message);
      res.status(500).json({ error: 'Could not save your request. Please try again.' });
    }
  });

  // ---- CRM (admin / SA / GHA) ----
  app.get('/api/growth/leads', requireCrm, async (req, res) => {
    try {
      const { status, segment, source, due, q } = req.query;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      let query = db.from('gx_leads').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (req.crm.type !== 'ADMIN') query = query.eq('owner_type', req.crm.type).eq('owner_id', req.crm.id);
      if (STATUSES.includes(status)) query = query.eq('status', status);
      if (SEGMENTS.includes(segment)) query = query.eq('segment', segment);
      if (source) query = query.eq('source', String(source).slice(0, 30));
      if (due === 'true') query = query.lte('next_follow_up', new Date().toISOString()).not('status', 'in', '(converted,dead)');
      if (q) {
        const s = String(q).replace(/[^\w@.+ -]/g, '').slice(0, 60);
        if (s) query = query.or('name.ilike.%' + s + '%,phone.ilike.%' + s + '%,email.ilike.%' + s + '%');
      }
      const { data, count, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      res.json({ leads: data || [], total: count || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function loadLead(req, res) {
    if (!isUuid(req.params.id)) { res.status(400).json({ error: 'Invalid id' }); return null; }
    const { data: lead } = await db.from('gx_leads').select('*').eq('id', req.params.id).maybeSingle();
    if (!lead) { res.status(404).json({ error: 'Not found' }); return null; }
    if (!canTouch(req.crm, lead)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return lead;
  }

  app.get('/api/growth/leads/:id', requireCrm, async (req, res) => {
    try {
      const lead = await loadLead(req, res); if (!lead) return;
      const { data: events } = await db.from('gx_lead_events').select('*').eq('lead_id', lead.id).order('created_at', { ascending: false }).limit(100);
      res.json({ lead, events: events || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/growth/leads/:id', requireCrm, async (req, res) => {
    try {
      const lead = await loadLead(req, res); if (!lead) return;
      const b = req.body || {};
      const upd = {};
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
        upd.status = b.status;
        if (b.status === 'converted' && !lead.converted_at) upd.converted_at = new Date().toISOString();
      }
      if (b.segment !== undefined) {
        if (!SEGMENTS.includes(b.segment)) return res.status(400).json({ error: 'Invalid segment' });
        upd.segment = b.segment;
      }
      if (b.notes !== undefined) upd.notes = clip(b.notes, 4000);
      if (b.next_follow_up !== undefined) {
        if (b.next_follow_up === null) upd.next_follow_up = null;
        else {
          const d = new Date(b.next_follow_up);
          if (isNaN(d)) return res.status(400).json({ error: 'Invalid follow-up date' });
          upd.next_follow_up = d.toISOString();
        }
      }
      if (b.do_not_contact !== undefined) upd.do_not_contact = b.do_not_contact === true;
      if (b.owner_type !== undefined || b.owner_id !== undefined) {
        if (req.crm.type !== 'ADMIN') return res.status(403).json({ error: 'Only admin can reassign leads' });
        if (b.owner_id !== null && !isUuid(b.owner_id)) return res.status(400).json({ error: 'Invalid owner_id' });
        if (b.owner_id !== null && !['SA', 'GHA', 'ADMIN'].includes(b.owner_type)) return res.status(400).json({ error: 'Invalid owner_type' });
        upd.owner_type = b.owner_id === null ? null : b.owner_type;
        upd.owner_id = b.owner_id;
      }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_leads').update(upd).eq('id', lead.id);
      if (error) return res.status(500).json({ error: error.message });
      if (upd.status && upd.status !== lead.status) await event(lead.id, 'status_changed', req.crm.actor, { from: lead.status, to: upd.status });
      if (upd.next_follow_up !== undefined) await event(lead.id, 'follow_up_set', req.crm.actor, { at: upd.next_follow_up });
      if (upd.notes !== undefined && upd.notes !== lead.notes) await event(lead.id, 'note_added', req.crm.actor, {});
      if (upd.owner_id !== undefined) await event(lead.id, 'assigned', req.crm.actor, { owner_type: upd.owner_type, owner_id: upd.owner_id });
      if (upd.do_not_contact === true) await event(lead.id, 'opted_out', req.crm.actor, {});
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Admin: marketing spend (feeds cost per lead / signup in Phase 2) ----
  app.get('/api/growth/spend', auth.requireAdmin, async (req, res) => {
    const { data, error } = await db.from('gx_spend').select('*').order('spend_date', { ascending: false }).limit(500);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  app.post('/api/growth/spend', auth.requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const amount = Number(b.amount_ngn);
      const date = new Date(b.spend_date);
      if (!clip(b.channel, 40)) return res.status(400).json({ error: 'channel required' });
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount_ngn must be a non-negative number' });
      if (isNaN(date)) return res.status(400).json({ error: 'spend_date invalid' });
      const { data, error } = await db.from('gx_spend').insert([{
        channel: clip(b.channel, 40), campaign_name: clip(b.campaign_name, 120), utm_campaign: clip(b.utm_campaign, 120),
        amount_ngn: amount, spend_date: date.toISOString().slice(0, 10), notes: clip(b.notes, 500),
        created_by: req.admin.email || req.admin.id,
      }]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/growth/spend/:id', auth.requireAdmin, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const { error } = await db.from('gx_spend').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // ---- Helpers for existing flows (never throw) ----

  // Link a session's attribution to a newly created profile; mark an earlier lead converted.
  async function linkSignup(sessionId, profileId, info) {
    try {
      sessionId = clip(sessionId, 64);
      if (!sessionId || !profileId) return;
      const attr = await attributionFor(sessionId);
      if (!attr || attr.profile_id) return;
      await db.from('gx_attribution').update({ profile_id: profileId, linked_at: new Date().toISOString() }).eq('id', attr.id);
      if (attr.lead_id) {
        await db.from('gx_leads').update({ profile_id: profileId, status: 'converted', converted_at: new Date().toISOString() })
          .eq('id', attr.lead_id).neq('status', 'converted');
        await event(attr.lead_id, 'converted', 'system', { profile_id: profileId, role: info && info.role });
      }
    } catch (e) { console.error('gx linkSignup error:', e.message); }
  }

  // Mirror an ai_leads row into gx_leads. Insert once, then refresh contact/requirements only,
  // so staff edits to status/owner/notes in the CRM are never overwritten.
  async function syncAiLead(conversationId) {
    try {
      if (!conversationId) return;
      const { data: a } = await db.from('ai_leads').select('*').eq('conversation_id', conversationId).maybeSingle();
      if (!a) return;
      const { data: conv } = await db.from('ai_conversations').select('session_id').eq('id', conversationId).maybeSingle();
      const sessionId = (conv && conv.session_id) || null;
      const reqs = Object.assign({}, a.requirements || {});
      ['budget_max', 'preferred_location', 'property_type', 'bedrooms', 'purpose'].forEach(k => { if (a[k] != null) reqs[k] = a[k]; });
      const contact = { name: a.customer_name || null, email: a.customer_email || null, phone: a.customer_phone || null, requirements: reqs };
      const { data: existing } = await db.from('gx_leads').select('id').eq('source_detail->>ai_lead_id', String(a.id)).maybeSingle();
      if (existing) { await db.from('gx_leads').update(contact).eq('id', existing.id); return; }
      const attr = await attributionFor(sessionId);
      const row = Object.assign({
        source: 'ai_chat',
        segment: a.purpose === 'rent' ? 'renter' : a.purpose === 'shortlet' ? 'shortlet' : 'buyer',
        status: a.status === 'INSPECTION_REQUESTED' ? 'inspection_booked' : 'new',
        owner_type: a.sa_id ? 'SA' : null, owner_id: a.sa_id || null,
        notes: a.ai_summary || null, consent_basis: 'user_submitted', session_id: sessionId,
        landing_page: attr ? attr.landing_page : null, referral_code: attr ? attr.referral_code : null,
        source_detail: { ai_lead_id: a.id, conversation_id: conversationId, property_id: a.property_id || null, agent_id: a.agent_id || null },
      }, contact);
      UTM_KEYS.forEach(k => { row[k] = attr ? attr[k] : null; });
      const { data: created, error } = await db.from('gx_leads').insert([row]).select('id').single();
      if (error) { console.error('gx syncAiLead insert error:', error.message); return; }
      await event(created.id, 'created', 'ai_assistant', { conversation_id: conversationId });
      if (attr && !attr.lead_id) await db.from('gx_attribution').update({ lead_id: created.id }).eq('id', attr.id);
    } catch (e) { console.error('gx syncAiLead error:', e.message); }
  }

  return { linkSignup, syncAiLead };
};
