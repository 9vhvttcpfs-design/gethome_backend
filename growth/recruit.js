// GetHome Growth Engine - Phase 3: agent / agency recruitment pipeline.
// Prospect database, campaigns, CSV-style bulk import, stage tracking tied to real registrations,
// subscriptions and GHA/SA ownership, plus an NDPR opt-out. Uses gx_prospects / gx_recruit_campaigns.
'use strict';
const express = require('express');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');

// Pipeline order. qualified / permission_obtained / campaign_ready are managed from the Outreach Command Centre;
// SAs and GHAs can only set the legacy stages below. approved / subscribed come from real accounts.
const STAGES = ['new', 'qualified', 'permission_obtained', 'campaign_ready', 'contacted', 'interested', 'applied', 'approved', 'subscribed', 'lost'];
const STAFF_STAGES = ['new', 'contacted', 'interested', 'applied', 'lost'];
const SOURCES = ['manual', 'csv_import', 'referral', 'walk_in', 'social', 'event', 'website'];
const CONSENT = ['public_business_listing', 'prospect_requested', 'existing_relationship', 'referred_by_agent'];
const CHANNELS = ['whatsapp', 'sms', 'email', 'social', 'field_visit', 'referral', 'event', 'other'];
const MAX_IMPORT = 2000; // body limit for the import route is raised to 2mb in index.js (before the global 100kb parser)

const clip = (v, n) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; };
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('234')) return d.length >= 12 && d.length <= 13 ? d : null;
  if (d.startsWith('0') && d.length === 11) return '234' + d.slice(1);
  if (d.length === 10) return '234' + d;
  return null; // prospects are Nigerian numbers; reject anything we can't normalise
}
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

module.exports = function mountRecruit(app, db, helpers) {
  const auth = createAuth(db);
  const router = express.Router();

  async function activity(prospectId, type, actor, payload) {
    try { await db.from('gx_prospect_activity').insert([{ prospect_id: prospectId, activity: type, actor: actor || 'system', payload: payload || {} }]); } catch (e) { /* best effort */ }
  }

  // .in() filters go in the URL, so look values up in chunks.
  async function inChunks(table, col, values, select) {
    let out = [];
    for (let i = 0; i < values.length; i += 150) {
      const { data, error } = await db.from(table).select(select).in(col, values.slice(i, i + 150));
      if (error) throw error;
      out = out.concat(data || []);
    }
    return out;
  }

  async function fetchAll(build) {
    let all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return all;
  }

  // Admin sees everything. SA/GHA only prospects they own.
  async function requireCrm(req, res, next) {
    try {
      const admin = await auth.getAdmin(req);
      if (admin) { req.crm = { type: 'ADMIN', id: admin.id, actor: admin.email || admin.id }; return next(); }
      const staff = await auth.getStaff(req);
      if (staff && (staff.staff_role === 'SA' || staff.staff_role === 'GHA')) {
        req.crm = { type: staff.staff_role, id: staff.staff_id, actor: staff.staff_role + ':' + staff.staff_id };
        return next();
      }
      res.status(401).json({ error: 'Unauthorized' });
    } catch (e) { res.status(500).json({ error: 'Auth check failed' }); }
  }
  const canTouch = (crm, p) => crm.type === 'ADMIN' || (p.owner_type === crm.type && String(p.owner_id) === String(crm.id));

  // Move linked prospects forward from real platform state (never backwards, never out of 'lost').
  async function refreshStages(prospects) {
    const linked = prospects.filter((p) => p.profile_id && p.stage !== 'lost' && p.stage !== 'subscribed');
    if (!linked.length) return;
    const ids = linked.map((p) => p.profile_id);
    const { data: profs } = await db.from('profiles')
      .select('id, status, subscription_tier, subscription_status, subscription_end, is_unlimited, unlimited_expires_at').in('id', ids);
    const byId = {}; (profs || []).forEach((p) => { byId[p.id] = p; });
    const now = new Date();
    for (const p of linked) {
      const prof = byId[p.profile_id]; if (!prof) continue;
      let stage = p.stage; const upd = {};
      const ts = now.toISOString();
      if (helpers.isAgentSubActive(prof, now)) { stage = 'subscribed'; upd.subscribed_at = ts; if (!p.approved_at) upd.approved_at = ts; if (!p.applied_at) upd.applied_at = ts; }
      else if (prof.status === 'approved' && STAGES.indexOf(stage) < STAGES.indexOf('approved')) { stage = 'approved'; upd.approved_at = ts; if (!p.applied_at) upd.applied_at = ts; }
      else if (STAGES.indexOf(stage) < STAGES.indexOf('applied')) { stage = 'applied'; upd.applied_at = ts; }
      if (stage !== p.stage) {
        upd.stage = stage; Object.assign(p, upd);
        await db.from('gx_prospects').update(upd).eq('id', p.id);
        await activity(p.id, 'stage_changed', 'system', { to: stage, reason: 'platform_state' });
      }
    }
    // Lets the UI show "last synced"; tolerated if the column has not been migrated yet.
    try { await db.from('gx_prospects').update({ last_checked_at: now.toISOString() }).in('id', linked.map((p) => p.id)); } catch (e) { /* ignore */ }
  }

  // Permanent suppression: flags existing rows AND remembers the contact, so a later import cannot re-add them.
  async function suppress(phone, email) {
    const vals = [phone, email].filter(Boolean);
    if (vals.length) await db.from('gx_suppressions').upsert(vals.map((v) => ({ value: v })), { onConflict: 'value', ignoreDuplicates: true });
    for (const t of ['gx_prospects', 'gx_leads']) {
      if (phone) await db.from(t).update({ do_not_contact: true }).eq('phone', phone);
      if (email) await db.from(t).update({ do_not_contact: true }).eq('email', email);
    }
  }

  // ---- Public NDPR opt-out ----
  router.post('/opt-out', limiter(10 * 60 * 1000, 10), async (req, res) => {
    try {
      const phone = normPhone(req.body && req.body.phone);
      const email = validEmail(req.body && req.body.email) ? req.body.email.trim().toLowerCase() : null;
      if (!phone && !email) return res.status(400).json({ error: 'Provide a phone number or email.' });
      await suppress(phone, email);
      res.json({ ok: true, message: 'You will not be contacted again.' });
    } catch (e) { res.status(500).json({ error: 'Could not process request.' }); }
  });

  // ---- Campaigns (admin) ----
  router.get('/recruit/campaigns', auth.requireAdmin, async (req, res) => {
    const { data, error } = await db.from('gx_recruit_campaigns').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  router.post('/recruit/campaigns', auth.requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const name = clip(b.name, 120);
      if (!name) return res.status(400).json({ error: 'name required' });
      const budget = b.budget_ngn === undefined || b.budget_ngn === '' ? 0 : Number(b.budget_ngn);
      if (!Number.isFinite(budget) || budget < 0) return res.status(400).json({ error: 'budget_ngn must be a non-negative number' });
      const row = {
        name, channel: CHANNELS.includes(b.channel) ? b.channel : 'other',
        target_type: ['agent', 'agency', 'both'].includes(b.target_type) ? b.target_type : 'both',
        state: clip(b.state, 60), city: clip(b.city, 60), budget_ngn: budget, notes: clip(b.notes, 1000),
        status: ['draft', 'active', 'paused', 'completed'].includes(b.status) ? b.status : 'active',
        created_by: req.admin.email || req.admin.id,
      };
      for (const k of ['start_date', 'end_date']) { if (b[k]) { const d = new Date(b[k]); if (isNaN(d)) return res.status(400).json({ error: k + ' invalid' }); row[k] = d.toISOString().slice(0, 10); } }
      const { data, error } = await db.from('gx_recruit_campaigns').insert([row]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.patch('/recruit/campaigns/:id', auth.requireAdmin, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}; const upd = {};
      if (b.status !== undefined) { if (!['draft', 'active', 'paused', 'completed'].includes(b.status)) return res.status(400).json({ error: 'Invalid status' }); upd.status = b.status; }
      if (b.budget_ngn !== undefined) { const n = Number(b.budget_ngn); if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid budget' }); upd.budget_ngn = n; }
      if (b.notes !== undefined) upd.notes = clip(b.notes, 1000);
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_recruit_campaigns').update(upd).eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Prospects ----
  // Validate + normalise one prospect row. Returns { row } or { error }.
  function buildProspect(b, crm, defaults) {
    const phone = b.phone ? normPhone(b.phone) : null;
    const email = b.email ? (validEmail(String(b.email).trim()) ? String(b.email).trim().toLowerCase() : 'INVALID') : null;
    if (b.phone && !phone) return { error: 'Invalid phone number' };
    if (email === 'INVALID') return { error: 'Invalid email' };
    if (!phone && !email) return { error: 'Phone or email required' };
    const consent = CONSENT.includes(b.consent_basis) ? b.consent_basis : (defaults && defaults.consent_basis);
    if (!consent) return { error: 'consent_basis required (' + CONSENT.join(', ') + ')' };
    const row = {
      type: b.type === 'agency' ? 'agency' : 'agent', name: clip(b.name, 120), agency_name: clip(b.agency_name, 160),
      phone, email, state: clip(b.state, 60), city: clip(b.city, 60),
      source: SOURCES.includes(b.source) ? b.source : ((defaults && defaults.source) || 'manual'),
      campaign_id: isUuid(b.campaign_id) ? b.campaign_id : ((defaults && defaults.campaign_id) || null),
      consent_basis: consent, notes: clip(b.notes, 2000), created_by: crm.actor,
    };
    // Staff own what they add; only admin may assign to someone else.
    if (crm.type === 'ADMIN') {
      if (isUuid(b.owner_id) && ['SA', 'GHA', 'ADMIN'].includes(b.owner_type)) { row.owner_type = b.owner_type; row.owner_id = b.owner_id; }
    } else { row.owner_type = crm.type; row.owner_id = crm.id; }
    return { row };
  }

  router.post('/recruit/prospects', requireCrm, limiter(60 * 1000, 60), async (req, res) => {
    try {
      const built = buildProspect(req.body || {}, req.crm);
      if (built.error) return res.status(400).json({ error: built.error });
      const { row } = built;
      // Already a registered GetHome user?
      if (row.email) { const { data: prof } = await db.from('profiles').select('id').ilike('email', row.email).maybeSingle(); if (prof) { row.profile_id = prof.id; row.stage = 'applied'; row.applied_at = new Date().toISOString(); } }
      const { data, error } = await db.from('gx_prospects').insert([row]).select().single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'A prospect with this phone or email already exists.' });
        return res.status(500).json({ error: error.message });
      }
      await activity(data.id, 'created', req.crm.actor, { source: row.source });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Bulk import. The admin tab parses the CSV in the browser and posts rows as JSON.
  router.post('/recruit/prospects/import', requireCrm, limiter(10 * 60 * 1000, 10), async (req, res) => {
    try {
      const b = req.body || {};
      const rows = Array.isArray(b.rows) ? b.rows : null;
      if (!rows || !rows.length) return res.status(400).json({ error: 'rows array required' });
      if (rows.length > MAX_IMPORT) return res.status(400).json({ error: 'Max ' + MAX_IMPORT + ' rows per import' });
      if (!CONSENT.includes(b.consent_basis)) return res.status(400).json({ error: 'consent_basis required: ' + CONSENT.join(', ') });
      const defaults = { consent_basis: b.consent_basis, source: 'csv_import', campaign_id: isUuid(b.campaign_id) ? b.campaign_id : null };
      const good = []; const errors = []; const seen = new Set();
      rows.forEach((r, i) => {
        const built = buildProspect(r || {}, req.crm, defaults);
        if (built.error) return errors.push({ row: i + 1, error: built.error });
        const k1 = built.row.phone && 'p' + built.row.phone, k2 = built.row.email && 'e' + built.row.email;
        if ((k1 && seen.has(k1)) || (k2 && seen.has(k2))) return errors.push({ row: i + 1, error: 'Duplicate within file' });
        if (k1) seen.add(k1); if (k2) seen.add(k2);
        good.push(built.row);
      });
      // Drop rows already in the database; link ones that are already GetHome users.
      const phones = good.map((g) => g.phone).filter(Boolean), emails = good.map((g) => g.email).filter(Boolean);
      const existing = new Set(), suppressed = new Set();
      (await inChunks('gx_prospects', 'phone', phones, 'phone')).forEach((d) => existing.add('p' + d.phone));
      (await inChunks('gx_prospects', 'email', emails, 'email')).forEach((d) => existing.add('e' + String(d.email).toLowerCase()));
      (await inChunks('gx_suppressions', 'value', phones.concat(emails), 'value')).forEach((d) => suppressed.add(d.value));
      const profByEmail = {};
      (await inChunks('profiles', 'email', emails, 'id, email')).forEach((d) => { profByEmail[String(d.email).toLowerCase()] = d.id; });
      const toInsert = []; let skipped = 0, optedOut = 0;
      good.forEach((g) => {
        if ((g.phone && suppressed.has(g.phone)) || (g.email && suppressed.has(g.email))) { optedOut++; return; }
        if ((g.phone && existing.has('p' + g.phone)) || (g.email && existing.has('e' + g.email))) { skipped++; return; }
        if (g.email && profByEmail[g.email]) { g.profile_id = profByEmail[g.email]; g.stage = 'applied'; g.applied_at = new Date().toISOString(); }
        toInsert.push(g);
      });
      let inserted = 0;
      for (let i = 0; i < toInsert.length; i += 500) {
        const { data, error } = await db.from('gx_prospects').insert(toInsert.slice(i, i + 500)).select('id');
        if (error) return res.status(500).json({ error: error.message, inserted_before_error: inserted });
        inserted += (data || []).length;
        await Promise.all((data || []).map((d) => activity(d.id, 'created', req.crm.actor, { source: 'csv_import' })));
      }
      res.json({ inserted, skipped_existing: skipped, skipped_opted_out: optedOut, rejected: errors.length, errors: errors.slice(0, 50) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/recruit/prospects', requireCrm, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200), offset = Math.max(parseInt(req.query.offset) || 0, 0);
      let q = db.from('gx_prospects').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (req.crm.type !== 'ADMIN') q = q.eq('owner_type', req.crm.type).eq('owner_id', req.crm.id);
      if (STAGES.includes(req.query.stage)) q = q.eq('stage', req.query.stage);
      if (['agent', 'agency'].includes(req.query.type)) q = q.eq('type', req.query.type);
      if (isUuid(req.query.campaign_id)) q = q.eq('campaign_id', req.query.campaign_id);
      if (req.query.state) q = q.ilike('state', String(req.query.state).replace(/[^\w ]/g, '').slice(0, 60));
      if (req.query.due === 'true') q = q.lte('next_follow_up', new Date().toISOString()).not('stage', 'in', '(subscribed,lost)');
      if (req.query.q) { const s = String(req.query.q).replace(/[^\w@.+ -]/g, '').slice(0, 60); if (s) q = q.or('name.ilike.%' + s + '%,agency_name.ilike.%' + s + '%,phone.ilike.%' + s + '%,email.ilike.%' + s + '%'); }
      const { data, count, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      await refreshStages(data || []).catch((e) => console.error('gx refreshStages:', e.message));
      res.json({ prospects: data || [], total: count || 0, synced_at: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function loadProspect(req, res) {
    if (!isUuid(req.params.id)) { res.status(400).json({ error: 'Invalid id' }); return null; }
    const { data: p } = await db.from('gx_prospects').select('*').eq('id', req.params.id).maybeSingle();
    if (!p) { res.status(404).json({ error: 'Not found' }); return null; }
    if (!canTouch(req.crm, p)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return p;
  }

  router.get('/recruit/prospects/:id', requireCrm, async (req, res) => {
    try {
      const p = await loadProspect(req, res); if (!p) return;
      const { data: acts } = await db.from('gx_prospect_activity').select('*').eq('prospect_id', p.id).order('created_at', { ascending: false }).limit(100);
      res.json({ prospect: p, activity: acts || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/recruit/prospects/:id', requireCrm, async (req, res) => {
    try {
      const p = await loadProspect(req, res); if (!p) return;
      const b = req.body || {}; const upd = {};
      if (b.stage !== undefined) {
        if (!STAGES.includes(b.stage) || !STAFF_STAGES.includes(b.stage)) return res.status(400).json({ error: 'Invalid stage' });
        // approved/subscribed reflect real platform state and are set automatically.
        if (['approved', 'subscribed'].includes(b.stage) && b.stage !== p.stage) return res.status(400).json({ error: 'approved and subscribed are set automatically from the agent\'s real account' });
        upd.stage = b.stage;
        if (b.stage === 'contacted' && !p.contacted_at) upd.contacted_at = new Date().toISOString();
        if (b.stage === 'lost') upd.lost_reason = clip(b.lost_reason, 200);
      }
      if (b.notes !== undefined) upd.notes = clip(b.notes, 2000);
      if (b.next_follow_up !== undefined) {
        if (b.next_follow_up === null) upd.next_follow_up = null;
        else { const d = new Date(b.next_follow_up); if (isNaN(d)) return res.status(400).json({ error: 'Invalid follow-up date' }); upd.next_follow_up = d.toISOString(); }
      }
      if (b.do_not_contact !== undefined) upd.do_not_contact = b.do_not_contact === true;
      if (b.campaign_id !== undefined) { if (b.campaign_id !== null && !isUuid(b.campaign_id)) return res.status(400).json({ error: 'Invalid campaign_id' }); upd.campaign_id = b.campaign_id; }
      if (b.owner_id !== undefined || b.owner_type !== undefined) {
        if (req.crm.type !== 'ADMIN') return res.status(403).json({ error: 'Only admin can reassign prospects' });
        if (b.owner_id !== null && (!isUuid(b.owner_id) || !['SA', 'GHA', 'ADMIN'].includes(b.owner_type))) return res.status(400).json({ error: 'Invalid owner' });
        upd.owner_id = b.owner_id; upd.owner_type = b.owner_id === null ? null : b.owner_type;
      }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_prospects').update(upd).eq('id', p.id);
      if (error) return res.status(500).json({ error: error.message });
      if (upd.stage && upd.stage !== p.stage) await activity(p.id, 'stage_changed', req.crm.actor, { from: p.stage, to: upd.stage });
      if (upd.next_follow_up !== undefined) await activity(p.id, 'follow_up_set', req.crm.actor, { at: upd.next_follow_up });
      if (upd.notes !== undefined && upd.notes !== p.notes) await activity(p.id, 'note_added', req.crm.actor, {});
      if (upd.owner_id !== undefined) await activity(p.id, 'assigned', req.crm.actor, { owner_type: upd.owner_type, owner_id: upd.owner_id });
      if (upd.do_not_contact === true) await activity(p.id, 'opted_out', req.crm.actor, {});
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Recruitment performance (admin): per campaign, per owner, per state ----
  router.get('/bi/recruitment', auth.requireAdmin, async (req, res) => {
    try {
      const [prospects, campaigns] = await Promise.all([
        fetchAll(() => db.from('gx_prospects').select('id, type, stage, campaign_id, owner_type, owner_id, state, profile_id, subscribed_at, contacted_at, created_at')),
        fetchAll(() => db.from('gx_recruit_campaigns').select('id, name, channel, budget_ngn, status')),
      ]);
      await refreshStages(prospects).catch(() => {});
      const funnel = (list) => {
        const n = (st) => list.filter((p) => STAGES.indexOf(p.stage) >= STAGES.indexOf(st) && p.stage !== 'lost').length;
        const total = list.length;
        return { prospects: total, contacted: list.filter((p) => p.contacted_at || STAGES.indexOf(p.stage) >= STAGES.indexOf('contacted') && p.stage !== 'lost').length, interested: n('interested'), applied: n('applied'), approved: n('approved'), subscribed: list.filter((p) => p.stage === 'subscribed').length, lost: list.filter((p) => p.stage === 'lost').length };
      };
      const withRates = (f) => Object.assign(f, { contact_to_apply_pct: rate(f.applied, f.contacted), apply_to_subscribe_pct: rate(f.subscribed, f.applied), prospect_to_subscribe_pct: rate(f.subscribed, f.prospects) });
      const campaignRows = campaigns.map((c) => {
        const f = withRates(funnel(prospects.filter((p) => p.campaign_id === c.id)));
        return Object.assign({ id: c.id, name: c.name, channel: c.channel, status: c.status, budget_ngn: Number(c.budget_ngn) || 0, cost_per_subscriber_ngn: f.subscribed > 0 ? Math.round((Number(c.budget_ngn) || 0) / f.subscribed) : null }, f);
      });
      const group = (keyFn) => { const m = {}; prospects.forEach((p) => { const k = keyFn(p); (m[k] = m[k] || []).push(p); }); return Object.keys(m).map((k) => Object.assign({ key: k }, withRates(funnel(m[k])))); };
      res.json({
        overall: withRates(funnel(prospects)),
        by_campaign: campaignRows,
        by_owner: group((p) => p.owner_id ? p.owner_type + ':' + p.owner_id : 'unassigned'),
        by_state: group((p) => p.state || 'unknown'),
        by_type: group((p) => p.type),
        note: 'Stages approved/subscribed come from the prospect\'s real GetHome account once they register with the same email.',
      });
    } catch (e) { console.error('[bi/recruitment]', e.message); res.status(500).json({ error: 'Report failed' }); }
  });

  require('./outreach')({ router, db, requireCrm, canTouch, activity, suppress });
  app.use('/api/growth', router);

  // Called after a real agent registration: link a matching prospect by email/phone.
  return {
    linkProspect: async function (profileId, email, phone) {
      try {
        const e = validEmail(email) ? String(email).trim().toLowerCase() : null, ph = normPhone(phone);
        if (!profileId || (!e && !ph)) return;
        let q = db.from('gx_prospects').select('id, stage').is('profile_id', null).limit(1);
        q = e && ph ? q.or('email.eq.' + e + ',phone.eq.' + ph) : (e ? q.eq('email', e) : q.eq('phone', ph));
        const { data } = await q;
        if (!data || !data.length) return;
        const upd = { profile_id: profileId, applied_at: new Date().toISOString() };
        if (STAGES.indexOf(data[0].stage) < STAGES.indexOf('applied')) upd.stage = 'applied';
        await db.from('gx_prospects').update(upd).eq('id', data[0].id);
        await activity(data[0].id, 'linked_profile', 'system', { profile_id: profileId });
      } catch (err) { console.error('gx linkProspect error:', err.message); }
    },
  };
};
