// Outreach Command Centre, phases 3-6: templates, sequences, campaigns, approval, the send queue (email),
// follow-ups, replies and the Resend delivery webhook.
// Everything runs on demand from the admin page (no background worker): "Run cycle" prepares due messages, then sends
// approved ones within the configured limits. Every send re-checks permission at the moment of sending.
'use strict';
const express = require('express');
const crypto = require('crypto');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');
const D = require('./dedupe');
const C = require('./consent');
const AI = require('./ai');
const Core = require('./outreachCore');
const Mail = require('./email');
const P = require('./places');
const { signToken } = require('./optout');

const SITE = 'https://trygethome.online';
const CAMPAIGN_STATUS = ['draft', 'active', 'paused', 'stopped', 'completed'];
const PROSPECT_TYPES = ['independent_agent', 'established_agency', 'commercial_agent', 'residential_agent', 'property_consultant'];
const clip = (v, n) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; };
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'outreach';
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// Verifies a Resend/Svix webhook signature. secret looks like "whsec_<base64>". Returns true/false.
function verifySvix(secret, headers, rawBody, toleranceSec) {
  try {
    const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = headers['svix-signature'];
    if (!secret || !id || !ts || !sigs) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > (toleranceSec || 300)) return false;
    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', key).update(id + '.' + ts + '.' + rawBody).digest('base64');
    return String(sigs).split(' ').some((part) => { const v = part.split(',')[1]; if (!v) return false; const a = Buffer.from(v), b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b); });
  } catch (e) { return false; }
}

module.exports = function mountMessaging(app, db, deps) {
  deps = deps || {};
  const now = () => (deps.now ? deps.now() : new Date());
  const sleep = deps.sleep || sleepReal;
  const auth = createAuth(db);
  const router = express.Router();
  const read = auth.requireRole('viewer'), edit = auth.requireRole('recruiter'), manage = auth.requireRole('admin');
  const actorOf = (req) => (req.admin && (req.admin.email || req.admin.id)) || 'unknown';
  const audit = async (req, action, entity, id, details) => { try { await db.from('gx_audit_log').insert([{ actor: actorOf(req), actor_role: req.adminRole, action, entity, entity_id: id ? String(id) : null, details: details || {}, ip: req.ip }]); } catch (e) { /* best effort */ } };
  const fail = (res, e, tag) => { console.error('[outreach/' + tag + ']', e.message || e); return res.status(500).json({ error: 'Request failed' }); };
  const startOfDay = () => { const d = now(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

  // ---------- templates (admin) ----------
  router.get('/outreach/templates', read, async (req, res) => {
    const { data, error } = await db.from('gx_message_templates').select('*').order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  router.post('/outreach/templates', manage, async (req, res) => {
    try {
      const b = req.body || {};
      if (!['email', 'whatsapp'].includes(b.channel)) return res.status(400).json({ error: 'channel must be email or whatsapp' });
      const name = clip(b.name, 120), body = clip(b.body, 5000);
      if (!name || !body) return res.status(400).json({ error: 'name and body required' });
      if (b.channel === 'email' && !clip(b.subject, 200)) return res.status(400).json({ error: 'subject required for email' });
      const row = { name, channel: b.channel, prospect_type: PROSPECT_TYPES.includes(b.prospect_type) ? b.prospect_type : null, subject: clip(b.subject, 200), body, wa_template_name: clip(b.wa_template_name, 100), wa_status: b.channel === 'whatsapp' ? 'draft' : null, variables: Array.isArray(b.variables) ? b.variables.map((v) => String(v).slice(0, 40)).slice(0, 10) : [], created_by: actorOf(req) };
      const { data, error } = await db.from('gx_message_templates').insert([row]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'template.create', 'template', data.id, { name });
      res.json(data);
    } catch (e) { fail(res, e, 'template-create'); }
  });
  router.patch('/outreach/templates/:id', manage, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}, upd = {};
      if (b.name !== undefined) upd.name = clip(b.name, 120);
      if (b.subject !== undefined) upd.subject = clip(b.subject, 200);
      if (b.body !== undefined) { upd.body = clip(b.body, 5000); if (!upd.body) return res.status(400).json({ error: 'body cannot be empty' }); }
      if (b.is_active !== undefined) upd.is_active = b.is_active === true;
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_message_templates').update(upd).eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'template.update', 'template', req.params.id, { fields: Object.keys(upd) });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'template-update'); }
  });

  // ---------- sequences (admin): initial + up to two follow-ups ----------
  function validateSteps(steps) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 3) return 'A sequence has 1 to 3 steps (an invitation and at most two follow-ups)';
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!['email', 'whatsapp'].includes(s.channel)) return 'Step ' + (i + 1) + ': channel must be email or whatsapp';
      if (!isUuid(s.template_id)) return 'Step ' + (i + 1) + ': choose a template';
      const d = Number(s.delay_days); if (!Number.isFinite(d) || d < (i === 0 ? 0 : 1) || d > 30) return 'Step ' + (i + 1) + ': delay must be ' + (i === 0 ? '0' : '1') + ' to 30 days';
    }
    return null;
  }
  router.get('/outreach/sequences', read, async (req, res) => {
    const { data, error } = await db.from('gx_sequences').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  router.post('/outreach/sequences', manage, async (req, res) => {
    try {
      const b = req.body || {};
      const name = clip(b.name, 120); if (!name) return res.status(400).json({ error: 'name required' });
      const why = validateSteps(b.steps); if (why) return res.status(400).json({ error: why });
      const settings = await C.getSettings(db);
      const steps = b.steps.map((s, i) => ({ step: i + 1, channel: s.channel, template_id: s.template_id, delay_days: Number(s.delay_days) }));
      const max = Math.min(steps.length, Number(settings.max_email_attempts) || 2);
      const { data, error } = await db.from('gx_sequences').insert([{ name, steps, max_attempts: Math.max(1, Math.min(max, 5)), created_by: actorOf(req) }]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'sequence.create', 'sequence', data.id, { name, steps: steps.length });
      res.json(data);
    } catch (e) { fail(res, e, 'sequence-create'); }
  });

  // ---------- campaigns ----------
  router.get('/outreach/campaigns', read, async (req, res) => {
    try {
      const { data: camps } = await db.from('gx_recruit_campaigns').select('*').order('created_at', { ascending: false }).limit(100);
      const out = [];
      for (const c of camps || []) {
        const { data: en } = await db.from('gx_sequence_enrollments').select('status').eq('campaign_id', c.id);
        const { data: ms } = await db.from('gx_messages').select('status').eq('campaign_id', c.id);
        const tally = (arr, k) => (arr || []).reduce((m, r) => { m[r[k]] = (m[r[k]] || 0) + 1; return m; }, {});
        out.push(Object.assign({}, c, { enrollments: tally(en, 'status'), messages: tally(ms, 'status') }));
      }
      res.json(out);
    } catch (e) { fail(res, e, 'campaign-list'); }
  });

  router.post('/outreach/campaigns', manage, async (req, res) => {
    try {
      const b = req.body || {};
      const name = clip(b.name, 120); if (!name) return res.status(400).json({ error: 'name required' });
      if (!isUuid(b.sequence_id)) return res.status(400).json({ error: 'Choose a sequence' });
      const lim = b.daily_send_limit === undefined || b.daily_send_limit === '' ? null : Number(b.daily_send_limit);
      if (lim !== null && (!Number.isInteger(lim) || lim < 1 || lim > 500)) return res.status(400).json({ error: 'daily_send_limit must be 1-500' });
      const row = { name, channel: 'email', target_type: ['agent', 'agency', 'both'].includes(b.target_type) ? b.target_type : 'both', state: clip(b.state, 60), city: clip(b.city, 60), sequence_id: b.sequence_id, daily_send_limit: lim, approval_required: b.approval_required !== false, status: 'draft', created_by: actorOf(req) };
      const { data, error } = await db.from('gx_recruit_campaigns').insert([row]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'campaign.create', 'campaign', data.id, { name });
      res.json(data);
    } catch (e) { fail(res, e, 'campaign-create'); }
  });

  // pause / resume / stop. Stopping cancels everything not yet sent and ends every follow-up sequence.
  router.patch('/outreach/campaigns/:id', manage, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}, upd = {};
      const { data: c } = await db.from('gx_recruit_campaigns').select('*').eq('id', req.params.id).maybeSingle();
      if (!c) return res.status(404).json({ error: 'Not found' });
      if (b.status !== undefined) {
        if (!CAMPAIGN_STATUS.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
        if (c.status === 'stopped') return res.status(409).json({ error: 'A stopped campaign cannot be restarted. Create a new campaign.' });
        upd.status = b.status;
        if (b.status === 'active' && !c.started_at) upd.started_at = now().toISOString();
        if (b.status === 'stopped') upd.stopped_at = now().toISOString();
      }
      if (b.approval_required !== undefined) upd.approval_required = b.approval_required === true;
      if (b.daily_send_limit !== undefined) { const n = b.daily_send_limit === null ? null : Number(b.daily_send_limit); if (n !== null && (!Number.isInteger(n) || n < 1 || n > 500)) return res.status(400).json({ error: 'daily_send_limit must be 1-500' }); upd.daily_send_limit = n; }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      await db.from('gx_recruit_campaigns').update(upd).eq('id', c.id);
      if (upd.status === 'stopped') {
        await db.from('gx_sequence_enrollments').update({ status: 'stopped', stop_reason: 'admin', next_send_at: null }).eq('campaign_id', c.id).eq('status', 'active');
        await db.from('gx_messages').update({ status: 'cancelled', last_error: 'campaign stopped' }).eq('campaign_id', c.id).in('status', Core.PENDING);
      }
      await audit(req, 'campaign.' + (upd.status || 'update'), 'campaign', c.id, upd);
      res.json({ success: true });
    } catch (e) { fail(res, e, 'campaign-update'); }
  });

  // Enrol prospects. Each one must pass the permission gate for the first step's channel, or it is skipped with the reason.
  router.post('/outreach/campaigns/:id/enroll', manage, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: c } = await db.from('gx_recruit_campaigns').select('*').eq('id', req.params.id).maybeSingle();
      if (!c) return res.status(404).json({ error: 'Not found' });
      if (!['draft', 'active', 'paused'].includes(c.status)) return res.status(409).json({ error: 'Campaign is ' + c.status });
      const { data: seq } = await db.from('gx_sequences').select('*').eq('id', c.sequence_id).maybeSingle();
      if (!seq || !(seq.steps || []).length) return res.status(400).json({ error: 'Campaign has no sequence' });
      const channel = seq.steps[0].channel;
      const b = req.body || {};
      let prospects = [];
      if (Array.isArray(b.prospect_ids) && b.prospect_ids.length) {
        const ids = b.prospect_ids.filter(isUuid).slice(0, 200); const { data } = await db.from('gx_prospects').select('*').in('id', ids); prospects = data || [];
      } else {
        let q = db.from('gx_prospects').select('*').eq('do_not_contact', false).order('last_contacted_at', { ascending: true, nullsFirst: true }).limit(1000);
        if (clip(b.state, 60)) q = q.or(P.stateFilter(b.state));
        if (clip(b.category, 40)) q = q.eq('category', String(b.category));
        const { data } = await q; prospects = data || [];
      }
      const settings = await C.getSettings(db);
      const skipped = {}; let enrolled = 0;
      const want = Math.min(parseInt(b.limit) || 100, 200);
      const { data: already } = await db.from('gx_sequence_enrollments').select('prospect_id').eq('campaign_id', c.id);
      const inCampaign = new Set((already || []).map((e) => e.prospect_id));
      for (const p of prospects) {
        if (enrolled >= want) break;
        if (inCampaign.has(p.id)) { skipped.already_enrolled = (skipped.already_enrolled || 0) + 1; continue; }
        const { data: contacts } = await db.from('gx_prospect_contacts').select('*').eq('prospect_id', p.id);
        const pool = (contacts || []).filter((x) => (channel === 'email' ? x.channel === 'email' : x.channel !== 'email')).sort((a, b2) => (b2.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
        let chosen = null, lastReason = pool.length ? null : 'no_contact';
        for (const ct of pool) { const g = await C.evaluateSend(db, p, ct, channel, settings); if (g.ok) { chosen = ct; break; } lastReason = g.reason; }
        if (!chosen) { skipped[lastReason] = (skipped[lastReason] || 0) + 1; continue; }
        const { error } = await db.from('gx_sequence_enrollments').insert([{ prospect_id: p.id, campaign_id: c.id, sequence_id: seq.id, contact_id: chosen.id, current_step: 1, status: 'active', next_send_at: now().toISOString(), created_by: actorOf(req) }]);
        if (error) { skipped[error.code === '23505' ? 'already_enrolled' : 'error'] = (skipped[error.code === '23505' ? 'already_enrolled' : 'error'] || 0) + 1; continue; }
        const upd = { campaign_id: c.id }; if (['new', 'qualified', 'permission_obtained'].includes(p.stage)) upd.stage = 'campaign_ready';
        await db.from('gx_prospects').update(upd).eq('id', p.id);
        enrolled++;
      }
      await audit(req, 'campaign.enroll', 'campaign', c.id, { enrolled, skipped });
      res.json({ enrolled, skipped });
    } catch (e) { fail(res, e, 'enroll'); }
  });

  // ---------- message preparation ----------
  async function prepareCampaign(c, limit) {
    const { data: seq } = await db.from('gx_sequences').select('*').eq('id', c.sequence_id).maybeSingle();
    if (!seq) return { prepared: 0, stopped: 0 };
    const settings = await C.getSettings(db);
    const { data: due } = await db.from('gx_sequence_enrollments').select('*').eq('campaign_id', c.id).eq('status', 'active').lte('next_send_at', now().toISOString()).limit(limit || 100);
    let prepared = 0, stopped = 0;
    for (const en of due || []) {
      const { data: existing } = await db.from('gx_messages').select('id').eq('enrollment_id', en.id).eq('step', en.current_step).not('status', 'in', '(cancelled,failed)').limit(1);
      if (existing && existing.length) continue;
      const step = (seq.steps || []).find((s) => s.step === en.current_step);
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', en.prospect_id).maybeSingle();
      const { data: ct } = en.contact_id ? await db.from('gx_prospect_contacts').select('*').eq('id', en.contact_id).maybeSingle() : { data: null };
      if (!step || !p) { await db.from('gx_sequence_enrollments').update({ status: 'stopped', stop_reason: 'admin' }).eq('id', en.id); stopped++; continue; }
      const gate = await C.evaluateSend(db, p, ct, step.channel, settings, { followUp: en.current_step > 1 });
      if (!gate.ok) { await Core.stopForProspect(db, p.id, Core.STOP_REASON[gate.reason] || 'admin'); stopped++; continue; }
      const { data: tpl } = await db.from('gx_message_templates').select('*').eq('id', step.template_id).maybeSingle();
      if (!tpl) { await db.from('gx_sequence_enrollments').update({ status: 'stopped', stop_reason: 'admin' }).eq('id', en.id); stopped++; continue; }
      let ghaCode = null;
      if (p.owner_type === 'GHA' && p.owner_id) { const { data: g } = await db.from('gha_agents').select('gha_code').eq('id', p.owner_id).maybeSingle(); ghaCode = g && g.gha_code; }
      const qs = new URLSearchParams({ utm_source: 'recruit', utm_medium: step.channel, utm_campaign: slug(c.name) });
      if (ghaCode) qs.set('ref', ghaCode);
      const link = SITE + '/?' + qs.toString();
      let out;
      if (step.channel === 'whatsapp') {
        // WhatsApp marketing goes out as a Meta-approved template with positional variables; never AI-rewritten.
        if (tpl.wa_status !== 'approved') continue;   // wait until Meta approves the template
        const vars = AI.mergeVars(p, ct, settings, link);
        out = { subject: null, body: AI.merge(tpl.body, vars), generated_by: 'template', facts: AI.factsFor(p, ct), provider: 'template', ai_rejected: null, wa_variables: (tpl.variables || []).map((k) => vars[k] || '') };
      } else out = await AI.personalize({ prospect: p, contact: ct, template: tpl, settings, link, generate: deps.aiGenerate });
      const { error } = await db.from('gx_messages').insert([{
        prospect_id: p.id, contact_id: ct ? ct.id : null, campaign_id: c.id, enrollment_id: en.id, step: en.current_step, channel: step.channel, template_id: tpl.id,
        subject: out.subject, body: out.body, generated_by: out.generated_by, personalization: { facts: out.facts, provider: out.provider, ai_rejected: out.ai_rejected, wa_variables: out.wa_variables }, consent_basis: gate.basis,
        status: c.approval_required ? 'pending_approval' : 'approved', scheduled_for: en.next_send_at, created_by: 'campaign',
      }]);
      if (!error) prepared++;
    }
    return { prepared, stopped };
  }

  router.post('/outreach/campaigns/:id/prepare', manage, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: c } = await db.from('gx_recruit_campaigns').select('*').eq('id', req.params.id).maybeSingle();
      if (!c) return res.status(404).json({ error: 'Not found' });
      if (c.status !== 'active') return res.status(409).json({ error: 'Campaign is ' + c.status + '. Messages are only prepared for active campaigns.' });
      const r = await prepareCampaign(c, 100);
      await audit(req, 'campaign.prepare', 'campaign', c.id, r);
      res.json(r);
    } catch (e) { fail(res, e, 'prepare'); }
  });

  // ---------- review and approval ----------
  router.get('/outreach/messages', read, async (req, res) => {
    try {
      let q = db.from('gx_messages').select('*').order('created_at', { ascending: false }).limit(Math.min(parseInt(req.query.limit) || 50, 200));
      if (req.query.status) q = q.eq('status', String(req.query.status).slice(0, 30));
      if (isUuid(req.query.campaign_id)) q = q.eq('campaign_id', req.query.campaign_id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      const ids = [...new Set((data || []).map((m) => m.prospect_id))];
      const { data: ps } = ids.length ? await db.from('gx_prospects').select('id, name, city, state').in('id', ids) : { data: [] };
      const by = {}; (ps || []).forEach((p) => { by[p.id] = p; });
      const cids = [...new Set((data || []).map((m) => m.contact_id).filter(Boolean))];
      const { data: cs } = cids.length ? await db.from('gx_prospect_contacts').select('id, value').in('id', cids) : { data: [] };
      const cb = {}; (cs || []).forEach((c) => { cb[c.id] = c.value; });
      res.json((data || []).map((m) => Object.assign({}, m, { prospect: by[m.prospect_id] || null, to: cb[m.contact_id] || null })));
    } catch (e) { fail(res, e, 'messages'); }
  });

  async function approveOne(req, id, edits) {
    const { data: m } = await db.from('gx_messages').select('*').eq('id', id).maybeSingle();
    if (!m) return { ok: false, error: 'Not found' };
    if (m.status !== 'pending_approval') return { ok: false, error: 'Message is ' + m.status };
    const upd = { status: 'approved', approved_by: actorOf(req), approved_at: now().toISOString() };
    if (edits && edits.body !== undefined) { const b = clip(edits.body, 8000); if (!b) return { ok: false, error: 'Body cannot be empty' }; upd.body = b; upd.generated_by = 'human'; }
    if (edits && edits.subject !== undefined) { upd.subject = clip(edits.subject, 200); }
    if (edits && edits.image_url !== undefined) {
      const u = edits.image_url ? Mail.httpsUrl(String(edits.image_url)) : null;
      if (edits.image_url && !u) return { ok: false, error: 'image_url must be a public https:// link' };
      upd.personalization = Object.assign({}, m.personalization || {}, { image_url: u });
    }
    await db.from('gx_messages').update(upd).eq('id', id);
    return { ok: true };
  }
  router.post('/outreach/messages/:id/approve', manage, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await approveOne(req, req.params.id, req.body);
    if (!r.ok) return res.status(r.error === 'Not found' ? 404 : 409).json({ error: r.error });
    await audit(req, 'message.approve', 'message', req.params.id, { edited: !!(req.body && (req.body.body || req.body.subject)) });
    res.json({ success: true });
  });
  router.post('/outreach/messages/approve-bulk', manage, async (req, res) => {
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).filter(isUuid).slice(0, 200);
    let approved = 0; for (const id of ids) if ((await approveOne(req, id)).ok) approved++;
    await audit(req, 'message.approve_bulk', 'message', null, { approved });
    res.json({ approved });
  });
  // Rejecting a message also ends that prospect's sequence, otherwise the same message would simply be prepared again.
  router.post('/outreach/messages/:id/reject', manage, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const { data: m } = await db.from('gx_messages').select('*').eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'Not found' });
    if (!Core.PENDING.includes(m.status)) return res.status(409).json({ error: 'Message is ' + m.status });
    await db.from('gx_messages').update({ status: 'cancelled', last_error: 'rejected by ' + actorOf(req) }).eq('id', m.id);
    await Core.stopForProspect(db, m.prospect_id, 'admin');
    await audit(req, 'message.reject', 'message', m.id, {});
    res.json({ success: true });
  });

  // ---------- the send queue ----------
  function emailFooter(settings, unsub) {
    const wa = D.normPhone(settings.outreach_whatsapp_number);
    return '\n\n--\n' + (settings.email_sender_name || 'GetHome') + ', GetHome Realestate Ltd (trygethome.online)' + (wa ? '\nWhatsApp: https://wa.me/' + wa : '') + '\nYou are receiving this because your business contact details are publicly listed or you asked to hear from us. To stop receiving messages from us, use this link: ' + unsub;
  }
  const baseUrl = (req) => (process.env.API_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');

  async function processQueue(req, opts) {
    const settings = await C.getSettings(db);
    const sendEmailFn = deps.sendEmail || ((m) => Mail.send(settings.email_provider || 'resend', m));
    const out = { sent: 0, blocked: 0, failed: 0, deferred: 0, skipped_paused: 0, stopped_reason: null, last_error: null };
    const provider = settings.email_provider || 'resend';
    if (!deps.sendEmail && !Mail.configured(provider)) {
      out.stopped_reason = 'email_not_configured'; out.last_error = 'Email provider "' + provider + '" is not configured on the server';
      out.remaining_today = Number(settings.daily_email_limit) || 0; return out;
    }
    const dailyCap = Number(settings.daily_email_limit); const spacing = Number(settings.send_spacing_ms) || 700;
    const { data: sentToday } = await db.from('gx_messages').select('id, campaign_id').eq('channel', 'email').gte('sent_at', startOfDay());
    let sentCount = (sentToday || []).length; const perCampaign = {};
    (sentToday || []).forEach((m) => { perCampaign[m.campaign_id] = (perCampaign[m.campaign_id] || 0) + 1; });
    // Read more than will be sent: messages of paused campaigns stay in the queue and must not block the ones behind them.
    const max = Math.min(opts.max || 20, 50);
    let qq = db.from('gx_messages').select('*').eq('status', 'approved').eq('channel', 'email').lte('scheduled_for', now().toISOString()).order('scheduled_for', { ascending: true }).limit(500);
    if (opts.ids) qq = qq.in('id', opts.ids.slice(0, 100));
    const { data: queue } = await qq;
    const t0 = Date.now();
    let failuresInARow = 0;
    for (const m of queue || []) {
      if (out.sent + out.failed >= max) { out.stopped_reason = 'batch_full'; break; }
      if (failuresInARow >= 3) { out.stopped_reason = 'provider_error'; break; }
      if (Date.now() - t0 > (opts.budgetMs || 45000)) { out.stopped_reason = 'time_budget'; break; }
      if (sentCount >= dailyCap) { out.stopped_reason = 'daily_limit'; break; }
      const { data: c } = m.campaign_id ? await db.from('gx_recruit_campaigns').select('*').eq('id', m.campaign_id).maybeSingle() : { data: null };
      if (c && c.status === 'stopped') { await db.from('gx_messages').update({ status: 'cancelled', last_error: 'campaign stopped' }).eq('id', m.id); out.blocked++; continue; }
      if (c && c.status !== 'active') { out.skipped_paused++; continue; }
      if (c && c.daily_send_limit && (perCampaign[c.id] || 0) >= c.daily_send_limit) { out.deferred++; continue; }
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', m.prospect_id).maybeSingle();
      const { data: ct } = m.contact_id ? await db.from('gx_prospect_contacts').select('*').eq('id', m.contact_id).maybeSingle() : { data: null };
      const gate = p ? await C.evaluateSend(db, p, ct, 'email', settings, { followUp: !!m.enrollment_id && m.step > 1 }) : { ok: false, reason: 'no_contact' };
      if (!gate.ok) { // permission changed since approval
        await db.from('gx_messages').update({ status: 'cancelled', last_error: 'blocked at send time: ' + gate.reason }).eq('id', m.id);
        if (p) await Core.stopForProspect(db, p.id, Core.STOP_REASON[gate.reason] || 'admin');
        out.blocked++; continue;
      }
      const unsub = baseUrl(req) + '/api/growth/opt-out/' + signToken(p.id);
      const text = m.body + emailFooter(settings, unsub);
      const html = Mail.wrapHtml({
        body: m.body, logoUrl: settings.email_logo_url, imageUrl: m.personalization && m.personalization.image_url,
        footerHtml: Mail.esc(settings.email_sender_name || 'GetHome') + ', GetHome Realestate Ltd (trygethome.online)<br>' + (D.normPhone(settings.outreach_whatsapp_number) ? 'WhatsApp: <a href="https://wa.me/' + D.normPhone(settings.outreach_whatsapp_number) + '">+' + D.normPhone(settings.outreach_whatsapp_number) + '</a><br>' : '') + 'You are receiving this because your business contact details are publicly listed or you asked to hear from us. <a href="' + Mail.esc(unsub) + '">Stop receiving messages from us</a>.',
      });
      await db.from('gx_messages').update({ status: 'sending', attempts: (m.attempts || 0) + 1 }).eq('id', m.id);
      try {
        const r = await sendEmailFn({ from: Mail.fromAddress(settings.email_sender_name), to: ct.value, subject: m.subject, text, html, replyTo: settings.reply_to_email, headers: { 'List-Unsubscribe': '<' + unsub + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
        const ts = now().toISOString();
        await db.from('gx_messages').update({ status: 'sent', sent_at: ts, provider: r.provider || 'resend', provider_message_id: r.id || null, last_error: null }).eq('id', m.id);
        const upd = { email_attempts: (p.email_attempts || 0) + 1, last_contacted_at: ts }; if (!p.contacted_at) upd.contacted_at = ts;
        if (['new', 'qualified', 'permission_obtained', 'campaign_ready'].includes(p.stage)) upd.stage = 'contacted';
        await db.from('gx_prospects').update(upd).eq('id', p.id);
        await db.from('gx_events').insert([{ prospect_id: p.id, message_id: m.id, type: 'sent', provider: r.provider || 'resend', payload: {}, occurred_at: ts }]);
        // advance the sequence
        if (m.enrollment_id) {
          const { data: en } = await db.from('gx_sequence_enrollments').select('*').eq('id', m.enrollment_id).maybeSingle();
          const { data: seq } = en ? await db.from('gx_sequences').select('*').eq('id', en.sequence_id).maybeSingle() : { data: null };
          const nextStep = seq && (seq.steps || []).find((s) => s.step === en.current_step + 1);
          const maxAttempts = Math.min(seq ? seq.max_attempts : 2, Number(settings.max_email_attempts) || 2);
          if (en && nextStep && en.current_step < maxAttempts) await db.from('gx_sequence_enrollments').update({ current_step: nextStep.step, next_send_at: new Date(now().getTime() + nextStep.delay_days * 86400000).toISOString() }).eq('id', en.id);
          else if (en) await db.from('gx_sequence_enrollments').update({ status: 'completed', next_send_at: null }).eq('id', en.id);
        }
        sentCount++; perCampaign[m.campaign_id] = (perCampaign[m.campaign_id] || 0) + 1; out.sent++; failuresInARow = 0;
      } catch (e) {
        const attempts = (m.attempts || 0) + 1;
        if (e.retryable !== false && attempts < 3) await db.from('gx_messages').update({ status: 'approved', last_error: String(e.message).slice(0, 300), scheduled_for: new Date(now().getTime() + attempts * 5 * 60000).toISOString() }).eq('id', m.id);
        else { await db.from('gx_messages').update({ status: 'failed', last_error: String(e.message).slice(0, 300) }).eq('id', m.id); if (m.enrollment_id) await db.from('gx_sequence_enrollments').update({ status: 'stopped', stop_reason: 'send_failed' }).eq('id', m.enrollment_id); }
        out.failed++; failuresInARow++; out.last_error = String(e.message).slice(0, 300);
      }
      if (spacing > 0) await sleep(spacing);
    }
    out.remaining_today = Math.max(0, dailyCap - sentCount);
    return out;
  }

  router.post('/outreach/queue/process', manage, limiter(60 * 1000, 10), async (req, res) => {
    try { const r = await processQueue(req, { max: parseInt(req.body && req.body.max) || 20 }); await audit(req, 'queue.process', 'queue', null, r); res.json(r); } catch (e) { fail(res, e, 'queue'); }
  });
  // One click: prepare due follow-ups for every active campaign, then send what is approved.
  router.post('/outreach/run-cycle', manage, limiter(60 * 1000, 6), async (req, res) => {
    try {
      const { data: camps } = await db.from('gx_recruit_campaigns').select('*').eq('status', 'active');
      let prepared = 0, stopped = 0;
      for (const c of camps || []) { const r = await prepareCampaign(c, 100); prepared += r.prepared; stopped += r.stopped; }
      const sent = await processQueue(req, { max: parseInt(req.body && req.body.max) || 20 });
      await audit(req, 'cycle.run', 'queue', null, { prepared, stopped, sent });
      res.json({ prepared, sequences_stopped: stopped, sending: sent });
    } catch (e) { fail(res, e, 'cycle'); }
  });

  // ---------- bulk email ----------
  // One subject + body (with {{contact_name}} etc.) to many prospects at once. Every prospect matching the filters is
  // looked at, never-emailed first, until the requested number can be emailed. Only the send gate (consent.js) blocks
  // anyone: people emailed before are included unless the sender asks to leave out recent ones.
  // mode "send" queues as approved and sends straight away; "review" puts the messages in Pending approval;
  // dry_run only counts. Anything not sent in this request stays approved for the next sending pass.
  async function emailContacts(p, contacts) {
    if (contacts.length) return contacts.sort((a, b2) => (b2.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
    // Older prospects hold their address only on the prospect row.
    const value = D.normEmail(p.email);
    if (!value) return [];
    const row = { prospect_id: p.id, channel: 'email', value, is_primary: true, is_role_address: D.isRoleAddress(value), verification_status: 'format_valid', verification_method: 'format' };
    const { data, error } = await db.from('gx_prospect_contacts').insert([row]).select().single();
    return error ? [] : [data];
  }

  router.post('/outreach/bulk-send', manage, limiter(60 * 1000, 10), async (req, res) => {
    try {
      const b = req.body || {};
      const dry = b.dry_run === true, review = b.mode === 'review';
      const subject = clip(b.subject, 200), body = clip(b.body, 5000);
      if (!dry && (!subject || !body)) return res.status(400).json({ error: 'subject and body are required' });
      let imageUrl = null;
      if (b.image_url) { imageUrl = Mail.httpsUrl(String(b.image_url)); if (!imageUrl) return res.status(400).json({ error: 'image_url must be a public https:// link' }); }
      const settings = await C.getSettings(db);
      const cap = Math.min(Math.max(parseInt(b.limit) || 100, 1), 500);
      const skipDays = Math.min(Math.max(parseInt(b.skip_recent_days) || 0, 0), 365);
      const recentCutoff = skipDays ? new Date(now().getTime() - skipDays * 86400000).toISOString() : null;
      const ids = Array.isArray(b.prospect_ids) && b.prospect_ids.length ? b.prospect_ids.filter(isUuid).slice(0, 500) : null;

      // Read the whole matching list first, so that updates made while queuing cannot shift the pages.
      const all = [];
      for (let from = 0; from < 20000; from += 1000) {
        let q = db.from('gx_prospects').select('*').eq('do_not_contact', false).order('last_contacted_at', { ascending: true, nullsFirst: true }).order('id', { ascending: true }).range(from, from + 999);
        if (ids) q = q.in('id', ids);
        else {
          if (clip(b.state, 60)) q = q.or(P.stateFilter(b.state));
          if (clip(b.category, 40)) q = q.eq('category', String(b.category));
        }
        const { data, error } = await q;
        if (error) throw error;
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }

      const skipped = {}; const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
      const campaignTag = slug(clip(b.campaign_tag, 40) || 'bulk_email');
      const addresses = new Set(), queuedIds = [];
      let eligible = 0, looked = 0, timedOut = false;
      const t0 = Date.now();
      for (let i = 0; i < all.length && eligible < cap && !timedOut; i += 100) {
        const page = all.slice(i, i + 100);
        const { data: rows } = await db.from('gx_prospect_contacts').select('*').eq('channel', 'email').in('prospect_id', page.map((p) => p.id));
        const byProspect = {}; (rows || []).forEach((c) => { (byProspect[c.prospect_id] = byProspect[c.prospect_id] || []).push(c); });
        for (const p of page) {
          if (eligible >= cap) break;
          if (Date.now() - t0 > 40000) { timedOut = true; break; }
          looked++;
          if (!byProspect[p.id] && !D.normEmail(p.email)) { skip('no_email'); continue; }
          if (recentCutoff && p.last_contacted_at && new Date(p.last_contacted_at) >= new Date(recentCutoff)) { skip('emailed_recently'); continue; }
          const pool = dry && !byProspect[p.id] ? [{ channel: 'email', value: D.normEmail(p.email), verification_status: 'format_valid' }] : await emailContacts(p, byProspect[p.id] || []);
          let ct = null, why = pool.length ? null : 'no_email';
          for (const x of pool) { const g = await C.evaluateSend(db, p, x, 'email', settings); if (g.ok) { ct = x; break; } why = g.reason; }
          if (!ct) { skip(why); continue; }
          if (addresses.has(ct.value)) { skip('same_address_twice'); continue; }
          addresses.add(ct.value);
          if (dry) { eligible++; continue; }
          let ghaCode = null;
          if (p.owner_type === 'GHA' && p.owner_id) { const { data: g } = await db.from('gha_agents').select('gha_code').eq('id', p.owner_id).maybeSingle(); ghaCode = g && g.gha_code; }
          const qs = new URLSearchParams({ utm_source: 'recruit', utm_medium: 'email', utm_campaign: campaignTag }); if (ghaCode) qs.set('ref', ghaCode);
          const vars = AI.mergeVars(p, ct, settings, SITE + '/?' + qs.toString());
          // A newer bulk email replaces an older one that never went out, so nobody receives two at once.
          await db.from('gx_messages').update({ status: 'cancelled', last_error: 'replaced by a newer bulk email' }).eq('prospect_id', p.id).eq('created_by', 'bulk_send').in('status', ['pending_approval', 'approved']);
          const { data: msg, error } = await db.from('gx_messages').insert([{
            prospect_id: p.id, contact_id: ct.id, campaign_id: null, step: 1, channel: 'email', subject: AI.merge(subject, vars), body: AI.merge(body, vars),
            generated_by: 'human', personalization: { image_url: imageUrl, bulk: true }, consent_basis: 'b2b_unsubscribe_link',
            status: review ? 'pending_approval' : 'approved', approved_by: review ? null : actorOf(req), approved_at: review ? null : now().toISOString(), scheduled_for: now().toISOString(), created_by: 'bulk_send',
          }]).select().single();
          if (error) { console.error('[outreach/bulk-send] insert:', error.message); skip('could_not_save'); continue; }
          eligible++; queuedIds.push(msg.id);
        }
      }
      if (dry) return res.json({ dry_run: true, matched: all.length, checked: looked, eligible, skipped });
      const sending = !review && queuedIds.length ? await processQueue(req, { ids: queuedIds, max: 50, budgetMs: 40000 }) : null;
      await audit(req, 'bulk.send', 'queue', null, { mode: review ? 'review' : 'send', queued: queuedIds.length, skipped, sent: sending && sending.sent });
      res.json({
        matched: all.length, checked: looked, queued: queuedIds.length, mode: review ? 'review' : 'send', skipped, sending,
        note: review ? 'Saved under Pending approval. Nothing is sent until you approve it.' : 'Anything not yet sent stays approved and goes out on the next sending pass, within your daily email limit.',
      });
    } catch (e) { fail(res, e, 'bulk-send'); }
  });

  // ---------- replies ----------
  router.get('/outreach/replies', read, async (req, res) => {
    try {
      let q = db.from('gx_replies').select('*').order('received_at', { ascending: false }).limit(100);
      if (req.query.open === 'true') q = q.eq('needs_human', true).eq('handled', false);
      const { data } = await q;
      const ids = [...new Set((data || []).map((r) => r.prospect_id).filter(Boolean))];
      const { data: ps } = ids.length ? await db.from('gx_prospects').select('id, name, city, state').in('id', ids) : { data: [] };
      const by = {}; (ps || []).forEach((p) => { by[p.id] = p; });
      res.json((data || []).map((r) => Object.assign({}, r, { prospect: by[r.prospect_id] || null })));
    } catch (e) { fail(res, e, 'replies'); }
  });
  // Replies to emails land in the reply-to inbox. Log one here (or let the inbound webhook do it) so it is classified,
  // stops further sending and shows up for a person to answer.
  router.post('/outreach/replies', edit, async (req, res) => {
    try {
      const b = req.body || {};
      const email = D.normEmail(b.email), phone = D.normPhone(b.phone);
      let pid = isUuid(b.prospect_id) ? b.prospect_id : null, contact = null;
      if (!pid && email) { const { data } = await db.from('gx_prospect_contacts').select('*').eq('channel', 'email').eq('value', email).maybeSingle(); if (data) { contact = data; pid = data.prospect_id; } }
      if (!pid && phone) { const { data } = await db.from('gx_prospect_contacts').select('*').in('channel', ['phone', 'whatsapp']).eq('value', phone).maybeSingle(); if (data) { contact = data; pid = data.prospect_id; } }
      if (!pid) return res.status(404).json({ error: 'No prospect found for that sender' });
      if (!clip(b.body, 5000)) return res.status(400).json({ error: 'The reply text is required' });
      const { data: lastMsg } = await db.from('gx_messages').select('id').eq('prospect_id', pid).in('status', ['sent', 'delivered']).order('created_at', { ascending: false }).limit(1);
      const r = await Core.processReply(db, { prospect_id: pid, contact_id: contact ? contact.id : null, message_id: lastMsg && lastMsg[0] ? lastMsg[0].id : null, channel: b.channel === 'whatsapp' ? 'whatsapp' : 'email', body: b.body });
      await audit(req, 'reply.log', 'prospect', pid, { classification: r.classification });
      res.json({ classification: r.classification, reply: r.reply });
    } catch (e) { fail(res, e, 'reply-log'); }
  });
  router.patch('/outreach/replies/:id', edit, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}, upd = {};
      if (b.classification !== undefined) { if (!['interested', 'not_interested', 'question', 'out_of_office', 'unsubscribe', 'other'].includes(b.classification)) return res.status(400).json({ error: 'Invalid classification' }); upd.classification = b.classification; upd.classified_by = 'human'; }
      if (b.handled === true) { upd.handled = true; upd.handled_by = actorOf(req); upd.handled_at = now().toISOString(); upd.needs_human = false; }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      await db.from('gx_replies').update(upd).eq('id', req.params.id);
      await audit(req, 'reply.update', 'reply', req.params.id, upd);
      res.json({ success: true });
    } catch (e) { fail(res, e, 'reply-update'); }
  });

  // ---------- Resend webhook: delivery, bounce, complaint, inbound ----------
  // Needs RESEND_WEBHOOK_SECRET. The raw body parser is mounted in index.js before the JSON parser.
  router.post('/webhooks/resend', async (req, res) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    if (!verifySvix(secret, req.headers, raw)) return res.status(401).json({ error: 'Invalid signature' });
    try {
      const ev = JSON.parse(raw); const d = ev.data || {}; const evId = req.headers['svix-id'];
      const { error: dup } = await db.from('gx_events').insert([{ type: String(ev.type || 'unknown').replace(/^email\./, ''), provider: 'resend', provider_event_id: evId, payload: { type: ev.type }, occurred_at: now().toISOString() }]);
      if (dup && dup.code === '23505') return res.json({ ok: true, duplicate: true });   // already handled (idempotent)
      const toEmail = D.normEmail(Array.isArray(d.to) ? d.to[0] : d.to);
      const { data: m } = d.email_id ? await db.from('gx_messages').select('*').eq('provider', 'resend').eq('provider_message_id', d.email_id).maybeSingle() : { data: null };
      const setContact = async (status, method) => { if (m && m.contact_id) await db.from('gx_prospect_contacts').update({ verification_status: status, verification_method: method, verified_at: status === 'verified' ? now().toISOString() : null }).eq('id', m.contact_id); };
      if (ev.type === 'email.delivered' && m) {
        await db.from('gx_messages').update({ status: m.status === 'sent' ? 'delivered' : m.status, delivered_at: now().toISOString() }).eq('id', m.id);
        await setContact('verified', 'delivery');
      } else if (ev.type === 'email.bounced' && m) {
        await db.from('gx_messages').update({ status: 'bounced', bounced_at: now().toISOString(), bounce_reason: String((d.bounce && d.bounce.message) || 'bounced').slice(0, 300) }).eq('id', m.id);
        await setContact('bounced', 'delivery');
        await Core.suppressValues(db, [toEmail], 'bounce', 'resend');
        await Core.stopForProspect(db, m.prospect_id, 'bounced');
      } else if (ev.type === 'email.complained' && m) {
        await Core.suppressValues(db, [toEmail], 'complaint', 'resend');
        await Core.stopForProspect(db, m.prospect_id, 'opted_out');
      } else if (ev.type === 'email.received') {
        const from = D.normEmail(String(d.from || '').replace(/^.*<|>.*$/g, ''));
        const { data: ct } = from ? await db.from('gx_prospect_contacts').select('*').eq('channel', 'email').eq('value', from).maybeSingle() : { data: null };
        if (ct) await Core.processReply(db, { prospect_id: ct.prospect_id, contact_id: ct.id, channel: 'email', body: d.text || d.subject || '', raw: { subject: d.subject } });
      }
      res.json({ ok: true });
    } catch (e) { console.error('[webhook/resend]', e.message); res.status(500).json({ error: 'Webhook failed' }); }
  });

  app.use('/api/growth', router);
  return { prepareCampaign, processQueue };
};
module.exports.verifySvix = verifySvix;
