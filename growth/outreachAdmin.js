// Outreach Command Centre - Phase 1 admin API: prospects, contacts, consent, suppression, settings,
// pipeline, duplicates/merge, export, retention, roles and the audit log.
// Roles: viewer (read) < recruiter (edit prospects) < admin (consent, settings, suppression, export, merge) < owner (roles, retention).
'use strict';
const express = require('express');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');
const D = require('./dedupe');
const C = require('./consent');

const STAGES = ['new', 'qualified', 'permission_obtained', 'campaign_ready', 'contacted', 'interested', 'applied', 'approved', 'subscribed', 'lost'];
const CATEGORIES = ['independent_agent', 'established_agency', 'commercial_agent', 'residential_agent', 'property_consultant', 'other'];
const SOURCES = ['manual', 'csv_import', 'referral', 'walk_in', 'social', 'event', 'website', 'osm', 'website_crawl', 'provider'];
const CONSENT_BASIS_GRANT = ['explicit_opt_in', 'prospect_requested', 'existing_relationship', 'referred_with_consent', 'imported_attested'];
const CONSENT_BASIS_WITHDRAW = ['withdrawn_by_prospect', 'withdrawn_by_admin'];
const PROSPECT_CONSENT = ['public_business_listing', 'prospect_requested', 'existing_relationship', 'referred_by_agent', 'legitimate_interest_b2b'];
const SETTING_RULES = {
  li_b2b_email_enabled: (v) => typeof v === 'boolean',
  max_email_attempts: (v) => Number.isInteger(v) && v >= 1 && v <= 5,
  max_whatsapp_attempts: (v) => Number.isInteger(v) && v >= 1 && v <= 5,
  daily_discovery_limit: (v) => Number.isInteger(v) && v >= 1 && v <= 1000,
  daily_email_limit: (v) => Number.isInteger(v) && v >= 0 && v <= 500,
  email_sender_name: (v) => typeof v === 'string' && v.trim().length >= 2 && v.length <= 60,
  reply_to_email: (v) => D.normEmail(v) !== null,
  retention_days_unengaged: (v) => Number.isInteger(v) && v >= 30 && v <= 3650,
  outreach_whatsapp_number: (v) => D.normPhone(v) !== null,
  ai_provider: (v) => ['template', 'anthropic', 'openai_compatible'].includes(v),
  email_provider: (v) => ['resend', 'smtp'].includes(v),
  send_spacing_ms: (v) => Number.isInteger(v) && v >= 0 && v <= 5000,
  daily_whatsapp_limit: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
};

const clip = (v, n) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; };
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

module.exports = function mountOutreachAdmin(app, db) {
  const auth = createAuth(db);
  const router = express.Router();
  const read = auth.requireRole('viewer'), edit = auth.requireRole('recruiter'), manage = auth.requireRole('admin'), owner = auth.requireRole('owner');

  async function audit(req, action, entity, entityId, details) {
    try {
      await db.from('gx_audit_log').insert([{
        actor: (req.admin && (req.admin.email || req.admin.id)) || 'unknown', actor_role: req.adminRole || null,
        action, entity: entity || null, entity_id: entityId ? String(entityId) : null, details: details || {}, ip: req.ip || null,
      }]);
    } catch (e) { console.error('audit log failed:', e.message); }
  }
  const actorOf = (req) => (req.admin && (req.admin.email || req.admin.id)) || 'unknown';
  async function activity(prospectId, type, actor, payload) {
    try { await db.from('gx_prospect_activity').insert([{ prospect_id: prospectId, activity: type, actor, payload: payload || {} }]); } catch (e) { /* best effort */ }
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
  const fail = (res, e, tag) => { console.error('[outreach/' + tag + ']', e.message || e); return res.status(500).json({ error: 'Request failed' }); };

  // Effective email permission for display: explicit consent, or B2B legitimate interest when enabled.
  function effectiveEmail(p, contacts, settings) {
    if (p.email_permission === 'granted') return 'consent';
    if (p.email_permission === 'withdrawn' || p.do_not_contact) return 'none';
    const hasEmail = (contacts || []).some((c) => c.channel === 'email' && c.verification_status !== 'invalid' && c.verification_status !== 'bounced');
    return settings.li_b2b_email_enabled && hasEmail && (p.source_url || (contacts || []).some((c) => c.source_url)) ? 'legitimate_interest' : 'none';
  }

  // ---- Prospects: list ----
  router.get('/outreach/prospects', read, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200), offset = Math.max(parseInt(req.query.offset) || 0, 0);
      let q = db.from('gx_prospects').select('*', { count: 'exact' }).order('discovered_at', { ascending: false }).range(offset, offset + limit - 1);
      const f = req.query;
      if (STAGES.includes(f.stage)) q = q.eq('stage', f.stage);
      if (CATEGORIES.includes(f.category)) q = q.eq('category', f.category);
      if (['unverified', 'partially_verified', 'verified', 'invalid'].includes(f.verification_status)) q = q.eq('verification_status', f.verification_status);
      if (['none', 'granted', 'withdrawn'].includes(f.email_permission)) q = q.eq('email_permission', f.email_permission);
      if (SOURCES.includes(f.source)) q = q.eq('source', f.source);
      if (isUuid(f.campaign_id)) q = q.eq('campaign_id', f.campaign_id);
      if (f.state) q = q.ilike('state', String(f.state).replace(/[^\w ]/g, '').slice(0, 60));
      if (f.city) q = q.ilike('city', String(f.city).replace(/[^\w ]/g, '').slice(0, 60));
      if (f.q) { const s = String(f.q).replace(/[^\w@.+ -]/g, '').slice(0, 60); if (s) q = q.or('name.ilike.%' + s + '%,contact_person.ilike.%' + s + '%,website_domain.ilike.%' + s + '%,email.ilike.%' + s + '%,phone.ilike.%' + s + '%'); }
      const { data, count, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      const ids = (data || []).map((p) => p.id);
      const contacts = ids.length ? (await db.from('gx_prospect_contacts').select('*').in('prospect_id', ids)).data || [] : [];
      const settings = await C.getSettings(db);
      const by = {}; contacts.forEach((c) => { (by[c.prospect_id] = by[c.prospect_id] || []).push(c); });
      res.json({
        total: count || 0,
        prospects: (data || []).map((p) => Object.assign({}, p, { contacts: by[p.id] || [], effective_email_permission: effectiveEmail(p, by[p.id], settings) })),
      });
    } catch (e) { fail(res, e, 'list'); }
  });

  // ---- Prospects: detail ----
  router.get('/outreach/prospects/:id', read, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', req.params.id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Not found' });
      const [contacts, sources, consent, messages, replies, acts] = await Promise.all([
        db.from('gx_prospect_contacts').select('*').eq('prospect_id', p.id).order('is_primary', { ascending: false }),
        db.from('gx_prospect_sources').select('*').eq('prospect_id', p.id).order('retrieved_at', { ascending: false }),
        db.from('gx_consent_records').select('*').eq('prospect_id', p.id).order('occurred_at', { ascending: false }),
        db.from('gx_messages').select('id, channel, step, status, subject, sent_at, delivered_at, bounced_at, created_at').eq('prospect_id', p.id).order('created_at', { ascending: false }).limit(50),
        db.from('gx_replies').select('*').eq('prospect_id', p.id).order('received_at', { ascending: false }).limit(50),
        db.from('gx_prospect_activity').select('*').eq('prospect_id', p.id).order('created_at', { ascending: false }).limit(50),
      ]);
      const settings = await C.getSettings(db);
      res.json({
        prospect: Object.assign({}, p, { effective_email_permission: effectiveEmail(p, contacts.data, settings) }),
        contacts: contacts.data || [], sources: sources.data || [], consent: consent.data || [],
        messages: messages.data || [], replies: replies.data || [], activity: acts.data || [],
      });
    } catch (e) { fail(res, e, 'detail'); }
  });

  // ---- Prospects: why can / can't we message this one? ----
  router.get('/outreach/prospects/:id/can-send', read, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const channel = req.query.channel === 'whatsapp' ? 'whatsapp' : 'email';
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', req.params.id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Not found' });
      const { data: contacts } = await db.from('gx_prospect_contacts').select('*').eq('prospect_id', p.id);
      const wanted = (contacts || []).filter((c) => (channel === 'email' ? c.channel === 'email' : c.channel !== 'email'));
      if (!wanted.length) return res.json({ channel, ok: false, results: [{ reason: 'no_contact' }] });
      const settings = await C.getSettings(db);
      const results = [];
      for (const c of wanted) results.push(Object.assign({ contact_id: c.id, value: c.value }, await C.evaluateSend(db, p, c, channel, settings)));
      res.json({ channel, ok: results.some((r) => r.ok), results });
    } catch (e) { fail(res, e, 'can-send'); }
  });

  // ---- Prospects: create (with duplicate check) ----
  function buildContacts(list) {
    const out = [], errors = [];
    (Array.isArray(list) ? list : []).forEach((c, i) => {
      const ch = c && (c.channel === 'whatsapp' ? 'whatsapp' : (c.channel === 'phone' ? 'phone' : (c.channel === 'email' ? 'email' : null)));
      if (!ch) return errors.push({ index: i, error: 'channel must be email, phone or whatsapp' });
      const value = ch === 'email' ? D.normEmail(c.value) : D.normPhone(c.value);
      if (!value) return errors.push({ index: i, error: 'invalid ' + ch + ' value' });
      out.push({ channel: ch, value, label: clip(c.label, 120), role_title: clip(c.role_title, 80), source_url: D.cleanUrl(c.source_url),
        is_role_address: ch === 'email' && D.isRoleAddress(value), verification_status: 'format_valid', verification_method: 'format' });
    });
    return { out, errors };
  }

  router.post('/outreach/prospects', edit, limiter(60 * 1000, 60), async (req, res) => {
    try {
      const b = req.body || {};
      const name = clip(b.business_name || b.name, 160);
      if (!name) return res.status(400).json({ error: 'business_name required' });
      const { out: contacts, errors } = buildContacts(b.contacts);
      if (errors.length) return res.status(400).json({ error: 'Invalid contacts', details: errors });
      const website = D.cleanUrl(b.website), sourceUrl = D.cleanUrl(b.source_url);
      if (!contacts.length && !website && !sourceUrl) return res.status(400).json({ error: 'Provide at least one contact, a website or a source URL' });
      const category = CATEGORIES.includes(b.category) ? b.category : null;
      const row = {
        name, contact_person: clip(b.contact_person, 120), category, type: category === 'independent_agent' ? 'agent' : 'agency',
        state: clip(b.state, 60), city: clip(b.city, 60), website, website_domain: D.domainOf(website), source_url: sourceUrl,
        name_key: D.nameKey(name), source: SOURCES.includes(b.source) ? b.source : 'manual',
        consent_basis: PROSPECT_CONSENT.includes(b.consent_basis) ? b.consent_basis : 'public_business_listing',
        notes: clip(b.notes, 2000), campaign_id: isUuid(b.campaign_id) ? b.campaign_id : null, created_by: actorOf(req),
        phone: (contacts.find((c) => c.channel !== 'email') || {}).value || null, email: (contacts.find((c) => c.channel === 'email') || {}).value || null,
      };
      const dups = await D.findDuplicates(db, { emails: contacts.filter((c) => c.channel === 'email').map((c) => c.value), phones: contacts.filter((c) => c.channel !== 'email').map((c) => c.value), domain: row.website_domain, nameKey: row.name_key, state: row.state, city: row.city });
      if (dups.length) return res.status(409).json({ error: 'This looks like an existing prospect', duplicates: dups });
      const { data: p, error } = await db.from('gx_prospects').insert([row]).select().single();
      if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'A prospect with this phone or email already exists' : error.message });
      if (contacts.length) {
        const first = {};
        const rows = contacts.map((c) => { const key = c.channel === 'email' ? 'email' : 'phone'; const primary = !first[key]; first[key] = true; return Object.assign({}, c, { prospect_id: p.id, is_primary: primary }); });
        const { error: cErr } = await db.from('gx_prospect_contacts').insert(rows);
        if (cErr) { await db.from('gx_prospects').delete().eq('id', p.id); return res.status(cErr.code === '23505' ? 409 : 500).json({ error: cErr.code === '23505' ? 'One of these contacts already belongs to another prospect' : cErr.message }); }
      }
      await db.from('gx_prospect_sources').insert([{ prospect_id: p.id, adapter: row.source, source_url: sourceUrl, raw: { entered_by: actorOf(req) } }]);
      await activity(p.id, 'created', actorOf(req), { source: row.source });
      await audit(req, 'prospect.create', 'prospect', p.id, { name });
      res.json(p);
    } catch (e) { fail(res, e, 'create'); }
  });

  // ---- Prospects: update, with pipeline rules ----
  router.patch('/outreach/prospects/:id', edit, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', req.params.id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Not found' });
      const b = req.body || {}, upd = {};
      if (b.contact_person !== undefined) upd.contact_person = clip(b.contact_person, 120);
      if (b.category !== undefined) { if (b.category !== null && !CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'Invalid category' }); upd.category = b.category; }
      if (b.state !== undefined) upd.state = clip(b.state, 60);
      if (b.city !== undefined) upd.city = clip(b.city, 60);
      if (b.notes !== undefined) upd.notes = clip(b.notes, 2000);
      if (b.website !== undefined) { upd.website = D.cleanUrl(b.website); upd.website_domain = D.domainOf(upd.website); }
      if (b.source_url !== undefined) upd.source_url = D.cleanUrl(b.source_url);
      if (b.campaign_id !== undefined) { if (b.campaign_id !== null && !isUuid(b.campaign_id)) return res.status(400).json({ error: 'Invalid campaign_id' }); upd.campaign_id = b.campaign_id; }
      if (b.verification_status !== undefined) { if (!['unverified', 'partially_verified', 'verified', 'invalid'].includes(b.verification_status)) return res.status(400).json({ error: 'Invalid verification_status' }); upd.verification_status = b.verification_status; }
      if (b.next_follow_up !== undefined) { if (b.next_follow_up === null) upd.next_follow_up = null; else { const d = new Date(b.next_follow_up); if (isNaN(d)) return res.status(400).json({ error: 'Invalid follow-up date' }); upd.next_follow_up = d.toISOString(); } }
      if ((b.owner_type !== undefined || b.owner_id !== undefined)) {
        if (b.owner_id !== null && (!isUuid(b.owner_id) || !['SA', 'GHA', 'ADMIN'].includes(b.owner_type))) return res.status(400).json({ error: 'Invalid owner' });
        upd.owner_id = b.owner_id; upd.owner_type = b.owner_id === null ? null : b.owner_type;
      }

      if (b.stage !== undefined && b.stage !== p.stage) {
        const to = b.stage;
        if (!STAGES.includes(to)) return res.status(400).json({ error: 'Invalid stage' });
        if (['applied', 'approved', 'subscribed'].includes(to)) return res.status(400).json({ error: 'Registered, approved and subscribed are set automatically from the agent\'s real GetHome account' });
        if (['applied', 'approved', 'subscribed'].includes(p.stage) && to !== 'lost') return res.status(400).json({ error: 'This prospect already has a GetHome account; its stage follows the account' });
        const { data: contacts } = await db.from('gx_prospect_contacts').select('*').eq('prospect_id', p.id);
        if (to === 'qualified' && !(p.name && ((contacts || []).length || p.website || p.source_url))) return res.status(400).json({ error: 'A qualified prospect needs a name and at least one contact, website or source URL' });
        if (to === 'permission_obtained') {
          const e = await C.latestConsent(db, p.id, 'email'), w = await C.latestConsent(db, p.id, 'whatsapp');
          const ok = (e && e.event === 'granted') || (w && w.event === 'granted');
          if (!ok) return res.status(400).json({ error: 'No consent record found. Record consent first (Consent tab).' });
        }
        if (to === 'campaign_ready') {
          const campaignId = upd.campaign_id !== undefined ? upd.campaign_id : p.campaign_id;
          if (!campaignId) return res.status(400).json({ error: 'Assign a campaign first' });
          const settings = await C.getSettings(db);
          let anyOk = false;
          for (const c of contacts || []) { for (const ch of (c.channel === 'email' ? ['email'] : ['whatsapp'])) { if ((await C.evaluateSend(db, p, c, ch, settings)).ok) anyOk = true; } }
          if (!anyOk) return res.status(400).json({ error: 'No contact currently passes the permission check. Use "Why can\'t I send?" on this prospect.' });
        }
        upd.stage = to;
        if (to === 'qualified' && !p.qualified_at) upd.qualified_at = new Date().toISOString();
        if (to === 'contacted' && !p.contacted_at) upd.contacted_at = new Date().toISOString();
        if (to === 'lost') upd.lost_reason = clip(b.lost_reason, 200);
      }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_prospects').update(upd).eq('id', p.id);
      if (error) return res.status(500).json({ error: error.message });
      if (upd.stage) { await activity(p.id, 'stage_changed', actorOf(req), { from: p.stage, to: upd.stage }); await audit(req, 'prospect.stage', 'prospect', p.id, { from: p.stage, to: upd.stage }); }
      else await audit(req, 'prospect.update', 'prospect', p.id, { fields: Object.keys(upd) });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'update'); }
  });

  // ---- Contacts ----
  router.post('/outreach/prospects/:id/contacts', edit, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { out, errors } = buildContacts([req.body]);
      if (errors.length) return res.status(400).json({ error: errors[0].error });
      const { data: p } = await db.from('gx_prospects').select('id').eq('id', req.params.id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Not found' });
      const { data: existing } = await db.from('gx_prospect_contacts').select('id').eq('prospect_id', p.id).eq('channel', out[0].channel).limit(1);
      const { data, error } = await db.from('gx_prospect_contacts').insert([Object.assign({}, out[0], { prospect_id: p.id, is_primary: !(existing && existing.length) })]).select().single();
      if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'This contact already belongs to a prospect' : error.message });
      await audit(req, 'contact.add', 'prospect', p.id, { channel: data.channel });
      res.json(data);
    } catch (e) { fail(res, e, 'contact-add'); }
  });

  router.patch('/outreach/contacts/:id', edit, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}, upd = {};
      if (b.label !== undefined) upd.label = clip(b.label, 120);
      if (b.role_title !== undefined) upd.role_title = clip(b.role_title, 80);
      if (b.verification_status !== undefined) {
        if (!['unverified', 'format_valid', 'verified', 'invalid'].includes(b.verification_status)) return res.status(400).json({ error: 'Invalid verification_status (bounced is set by delivery events)' });
        upd.verification_status = b.verification_status; upd.verification_method = 'manual';
        if (b.verification_status === 'verified') upd.verified_at = new Date().toISOString();
      }
      const { data: c } = await db.from('gx_prospect_contacts').select('*').eq('id', req.params.id).maybeSingle();
      if (!c) return res.status(404).json({ error: 'Not found' });
      if (b.is_primary === true) await db.from('gx_prospect_contacts').update({ is_primary: false }).eq('prospect_id', c.prospect_id).eq('channel', c.channel);
      if (b.is_primary !== undefined) upd.is_primary = b.is_primary === true;
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_prospect_contacts').update(upd).eq('id', c.id);
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'contact.update', 'contact', c.id, { fields: Object.keys(upd) });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'contact-update'); }
  });

  router.delete('/outreach/contacts/:id', manage, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { error } = await db.from('gx_prospect_contacts').delete().eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'contact.delete', 'contact', req.params.id, {});
      res.json({ success: true });
    } catch (e) { fail(res, e, 'contact-delete'); }
  });

  // ---- Consent (append-only) ----
  router.get('/outreach/prospects/:id/consent', read, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const { data, error } = await db.from('gx_consent_records').select('*').eq('prospect_id', req.params.id).order('occurred_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  async function suppress(values, reason, by) {
    const vals = [...new Set(values.filter(Boolean))];
    if (!vals.length) return;
    await db.from('gx_suppressions').upsert(vals.map((v) => ({ value: v, reason, added_by: by })), { onConflict: 'value', ignoreDuplicates: true });
    for (const v of vals) {
      if (v.includes('@')) { await db.from('gx_prospects').update({ do_not_contact: true }).eq('email', v); await db.from('gx_leads').update({ do_not_contact: true }).eq('email', v); }
      else { await db.from('gx_prospects').update({ do_not_contact: true }).eq('phone', v); await db.from('gx_leads').update({ do_not_contact: true }).eq('phone', v); }
    }
  }

  router.post('/outreach/consent', manage, async (req, res) => {
    try {
      const b = req.body || {};
      if (!isUuid(b.prospect_id)) return res.status(400).json({ error: 'prospect_id required' });
      if (!['email', 'whatsapp'].includes(b.channel)) return res.status(400).json({ error: 'channel must be email or whatsapp' });
      if (!['granted', 'withdrawn'].includes(b.event)) return res.status(400).json({ error: 'event must be granted or withdrawn' });
      const allowed = b.event === 'granted' ? CONSENT_BASIS_GRANT : CONSENT_BASIS_WITHDRAW;
      if (!allowed.includes(b.basis)) return res.status(400).json({ error: 'basis must be one of ' + allowed.join(', ') });
      const source = clip(b.source, 200);
      if (!source) return res.status(400).json({ error: 'source required (e.g. the form, message or conversation where consent was given)' });
      if (b.event === 'granted' && !clip(b.evidence, 2000)) return res.status(400).json({ error: 'evidence required for granted consent (quote, link or reference)' });
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', b.prospect_id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Prospect not found' });
      const rec = await C.recordConsent(db, {
        prospect_id: p.id, contact_id: isUuid(b.contact_id) ? b.contact_id : null, channel: b.channel, event: b.event, basis: b.basis,
        source, evidence: clip(b.evidence, 2000), recorded_by: actorOf(req),
      });
      if (b.event === 'withdrawn') {
        const { data: contacts } = await db.from('gx_prospect_contacts').select('*').eq('prospect_id', p.id);
        const vals = (contacts || []).filter((c) => (b.channel === 'email' ? c.channel === 'email' : c.channel !== 'email')).map((c) => c.value);
        await suppress(vals, 'opt_out', actorOf(req));
      }
      await activity(p.id, b.event === 'granted' ? 'consent_granted' : 'opted_out', actorOf(req), { channel: b.channel, basis: b.basis });
      await audit(req, 'consent.' + b.event, 'prospect', p.id, { channel: b.channel, basis: b.basis, source });
      res.json(rec);
    } catch (e) { fail(res, e, 'consent'); }
  });

  // ---- Suppression list ----
  router.get('/outreach/suppressions', manage, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500), offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { data, count, error } = await db.from('gx_suppressions').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ total: count || 0, suppressions: data || [] });
  });

  router.post('/outreach/suppressions', manage, async (req, res) => {
    try {
      const raw = String((req.body && req.body.value) || '').trim();
      const value = raw.includes('@') ? D.normEmail(raw) : D.normPhone(raw);
      if (!value) return res.status(400).json({ error: 'Provide a valid email address or Nigerian phone number' });
      const reason = ['opt_out', 'bounce', 'complaint', 'admin', 'legal'].includes(req.body.reason) ? req.body.reason : 'admin';
      await suppress([value], reason, actorOf(req));
      await audit(req, 'suppression.add', 'suppression', value, { reason });
      res.json({ success: true, value });
    } catch (e) { fail(res, e, 'suppress-add'); }
  });

  // Removing someone from the do-not-contact list is deliberate and rare: owner only, with a recorded reason.
  router.delete('/outreach/suppressions/:value', owner, async (req, res) => {
    try {
      const why = clip(req.body && req.body.reason, 500);
      if (!why) return res.status(400).json({ error: 'A reason is required to remove a suppression (for example, the person asked in writing to be contacted again)' });
      const value = decodeURIComponent(req.params.value);
      const { error } = await db.from('gx_suppressions').delete().eq('value', value);
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'suppression.remove', 'suppression', value, { reason: why });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'suppress-remove'); }
  });

  // ---- Settings ----
  router.get('/outreach/settings', read, async (req, res) => {
    const s = await C.getSettings(db);
    const { data: ack } = await db.from('gx_settings').select('value').eq('key', 'li_b2b_acknowledged').maybeSingle();
    res.json({ settings: s, legitimate_interest_acknowledgement: (ack && ack.value) || null });
  });

  // Plain-language setup checklist for the "Start Here" tab. Reports only whether each variable is SET, never its value.
  router.get('/outreach/readiness', read, async (req, res) => {
    try {
      const E = process.env, has = (k) => !!E[k];
      const count = async (table, f) => { try { let q = db.from(table).select('id', { count: 'exact', head: true }); if (f) q = f(q); const { count: c } = await q; return c || 0; } catch (e) { return null; } };
      const s = await C.getSettings(db);
      const items = [
        { key: 'email', title: 'Email sending (Resend)', ok: has('RESEND_API_KEY') && has('OUTREACH_FROM_EMAIL'), needed_for: 'Sending invitation emails to agents and agencies.', how: 'On Render add RESEND_API_KEY and OUTREACH_FROM_EMAIL (an address on a domain you verified in Resend, e.g. outreach@mail.trygethome.online).', missing: ['RESEND_API_KEY', 'OUTREACH_FROM_EMAIL'].filter((k) => !has(k)) },
        { key: 'email_tracking', title: 'Email delivery tracking (Resend webhook)', ok: has('RESEND_WEBHOOK_SECRET'), needed_for: 'Knowing which emails were delivered, bounced or marked as spam.', how: 'In Resend > Webhooks add the URL ' + (E.API_PUBLIC_URL || E.RENDER_EXTERNAL_URL || 'https://<your-render-url>') + '/api/growth/webhooks/resend, then put its signing secret in RESEND_WEBHOOK_SECRET.', missing: has('RESEND_WEBHOOK_SECRET') ? [] : ['RESEND_WEBHOOK_SECRET'] },
        { key: 'unsubscribe', title: 'Unsubscribe links', ok: has('API_PUBLIC_URL') || has('RENDER_EXTERNAL_URL'), needed_for: 'Every email must carry a working unsubscribe link (required by law).', how: 'Set API_PUBLIC_URL to your Render URL.', missing: (has('API_PUBLIC_URL') || has('RENDER_EXTERNAL_URL')) ? [] : ['API_PUBLIC_URL'] },
        { key: 'whatsapp', title: 'WhatsApp (Meta Cloud API)', ok: has('WA_PHONE_NUMBER_ID') && has('WA_ACCESS_TOKEN'), optional: true, needed_for: 'Sending approved WhatsApp templates to people who opted in. Without it you can still copy messages and send by hand.', how: 'Meta Business > WhatsApp > API setup. Add WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_BUSINESS_ACCOUNT_ID, WA_APP_SECRET and WA_VERIFY_TOKEN.', missing: ['WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN'].filter((k) => !has(k)) },
        { key: 'ai', title: 'AI message writer', ok: has('ANTHROPIC_API_KEY') || has('LOCAL_AI_URL'), optional: true, needed_for: 'Slightly personalised openings. Without it, plain templates are used and everything still works.', how: 'ANTHROPIC_API_KEY is already used by the AI chat; nothing more to do if that works.', missing: [] },
        { key: 'sms', title: 'SMS (Termii)', ok: has('TERMII_API_KEY'), optional: true, needed_for: 'Payment and booking confirmation SMS to customers. It is NOT used by outreach to agents.', how: 'Add TERMII_API_KEY and TERMII_SENDER_ID (sender ID must be approved by Termii). Note: the confirmation SMS code currently passes the customer email instead of a phone number, so no SMS can arrive until a phone field is saved at checkout.', missing: has('TERMII_API_KEY') ? [] : ['TERMII_API_KEY'] },
      ];
      const [prospects, contactable, campaigns, active, toReview, replies, suppressed] = await Promise.all([
        count('gx_prospects'), count('gx_prospects', (q) => q.in('stage', ['qualified', 'permission_obtained', 'campaign_ready'])),
        count('gx_recruit_campaigns'), count('gx_recruit_campaigns', (q) => q.eq('status', 'active')),
        count('gx_messages', (q) => q.eq('status', 'pending_approval')), count('gx_replies', (q) => q.eq('needs_human', true).eq('handled', false)), count('gx_suppressions'),
      ]);
      res.json({
        items, settings: { legitimate_interest_email: !!(s && s.li_b2b_email_enabled), approval_required: true },
        counts: { prospects, ready_to_contact: contactable, campaigns, active_campaigns: active, messages_to_review: toReview, replies_waiting: replies, suppressed },
        required_ok: items.filter((i) => !i.optional).every((i) => i.ok),
      });
    } catch (e) { console.error('readiness error:', e.message); res.status(500).json({ error: 'Could not build checklist.' }); }
  });

  router.patch('/outreach/settings', manage, async (req, res) => {
    try {
      const b = req.body || {}, changed = {};
      for (const k of Object.keys(b)) {
        if (k === 'acknowledge_lia' || k === 'lia_note') continue;
        if (!SETTING_RULES[k]) return res.status(400).json({ error: 'Unknown setting: ' + k });
        if (!SETTING_RULES[k](b[k])) return res.status(400).json({ error: 'Invalid value for ' + k });
        changed[k] = typeof b[k] === 'string' ? b[k].trim() : b[k];
      }
      if (!Object.keys(changed).length) return res.status(400).json({ error: 'Nothing to update' });
      if (changed.li_b2b_email_enabled === true) {
        if (b.acknowledge_lia !== true || !clip(b.lia_note, 1000)) return res.status(400).json({ error: 'Enabling legitimate-interest B2B email requires acknowledge_lia: true and a note recording that the Legitimate Interest Assessment was completed' });
        await db.from('gx_settings').upsert([{ key: 'li_b2b_acknowledged', value: { by: actorOf(req), at: new Date().toISOString(), note: clip(b.lia_note, 1000) }, updated_by: actorOf(req) }], { onConflict: 'key' });
      }
      const rows = Object.keys(changed).map((k) => ({ key: k, value: changed[k], updated_by: actorOf(req), updated_at: new Date().toISOString() }));
      const { error } = await db.from('gx_settings').upsert(rows, { onConflict: 'key' });
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'settings.update', 'settings', null, changed);
      res.json({ success: true, settings: await C.getSettings(db) });
    } catch (e) { fail(res, e, 'settings'); }
  });

  // ---- Pipeline (kanban) ----
  router.get('/outreach/pipeline', read, async (req, res) => {
    try {
      const perStage = Math.min(parseInt(req.query.per_stage) || 20, 100);
      const cols = await Promise.all(STAGES.map(async (stage) => {
        let q = db.from('gx_prospects').select('id, name, contact_person, category, state, city, last_contacted_at, email_permission, owner_type, owner_id, discovered_at', { count: 'exact' }).eq('stage', stage).order('discovered_at', { ascending: false }).limit(perStage);
        if (req.query.state) q = q.ilike('state', String(req.query.state).replace(/[^\w ]/g, '').slice(0, 60));
        if (isUuid(req.query.campaign_id)) q = q.eq('campaign_id', req.query.campaign_id);
        const { data, count } = await q;
        return { stage, count: count || 0, prospects: data || [] };
      }));
      res.json({ columns: cols, labels: { new: 'Discovered', qualified: 'Qualified', permission_obtained: 'Permission Obtained', campaign_ready: 'Campaign Ready', contacted: 'Contacted', interested: 'Interested', applied: 'Registered', approved: 'Registered (verified)', subscribed: 'Subscribed', lost: 'Lost' } });
    } catch (e) { fail(res, e, 'pipeline'); }
  });

  // ---- Duplicates: review and merge ----
  router.get('/outreach/duplicates', manage, async (req, res) => {
    try {
      const rows = await fetchAll(() => db.from('gx_prospects').select('id, name, name_key, website_domain, state, city, stage, discovered_at'));
      const groups = [], byDomain = {}, byName = {};
      rows.forEach((p) => {
        if (p.website_domain) (byDomain[p.website_domain] = byDomain[p.website_domain] || []).push(p);
        if (p.name_key) (byName[p.name_key + '|' + String(p.state || '').toLowerCase()] = byName[p.name_key + '|' + String(p.state || '').toLowerCase()] || []).push(p);
      });
      Object.entries(byDomain).forEach(([k, v]) => { if (v.length > 1) groups.push({ reason: 'same website', key: k, prospects: v }); });
      Object.entries(byName).forEach(([k, v]) => { if (v.length > 1) groups.push({ reason: 'same business name and state', key: k.split('|')[0], prospects: v }); });
      res.json({ groups });
    } catch (e) { fail(res, e, 'duplicates'); }
  });

  router.post('/outreach/prospects/merge', manage, async (req, res) => {
    try {
      const { keep_id, remove_id } = req.body || {};
      if (!isUuid(keep_id) || !isUuid(remove_id) || keep_id === remove_id) return res.status(400).json({ error: 'keep_id and remove_id must be two different prospect ids' });
      const [{ data: keep }, { data: gone }] = await Promise.all([db.from('gx_prospects').select('*').eq('id', keep_id).maybeSingle(), db.from('gx_prospects').select('*').eq('id', remove_id).maybeSingle()]);
      if (!keep || !gone) return res.status(404).json({ error: 'Prospect not found' });
      for (const t of ['gx_prospect_contacts', 'gx_prospect_sources', 'gx_consent_records', 'gx_messages', 'gx_replies', 'gx_events', 'gx_conversions', 'gx_prospect_activity', 'gx_outreach']) {
        const { error } = await db.from(t).update({ prospect_id: keep_id }).eq('prospect_id', remove_id);
        if (error) return res.status(500).json({ error: 'Merge failed on ' + t + ': ' + error.message });
      }
      await db.from('gx_prospects').delete().eq('id', remove_id);
      const fill = {};
      ['contact_person', 'category', 'website', 'website_domain', 'source_url', 'phone', 'email', 'state', 'city', 'profile_id', 'campaign_id', 'owner_id', 'owner_type'].forEach((k) => { if (keep[k] == null && gone[k] != null) fill[k] = gone[k]; });
      if (gone.do_not_contact) fill.do_not_contact = true;
      if (Object.keys(fill).length) await db.from('gx_prospects').update(fill).eq('id', keep_id);
      await activity(keep_id, 'merged', actorOf(req), { merged_from: remove_id, name: gone.name });
      await audit(req, 'prospect.merge', 'prospect', keep_id, { removed: remove_id });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'merge'); }
  });

  // ---- Export (CSV) ----
  router.get('/outreach/export.csv', manage, async (req, res) => {
    try {
      const f = req.query;
      const rows = await fetchAll(() => {
        let q = db.from('gx_prospects').select('*').order('discovered_at', { ascending: false });
        if (STAGES.includes(f.stage)) q = q.eq('stage', f.stage);
        if (f.state) q = q.ilike('state', String(f.state).replace(/[^\w ]/g, '').slice(0, 60));
        if (isUuid(f.campaign_id)) q = q.eq('campaign_id', f.campaign_id);
        return q;
      });
      if (rows.length > 20000) return res.status(400).json({ error: 'Too many rows; narrow the filters' });
      const ids = rows.map((p) => p.id);
      const contacts = [];
      for (let i = 0; i < ids.length; i += 150) { const { data } = await db.from('gx_prospect_contacts').select('prospect_id, channel, value').in('prospect_id', ids.slice(i, i + 150)); (data || []).forEach((c) => contacts.push(c)); }
      const by = {}; contacts.forEach((c) => { (by[c.prospect_id] = by[c.prospect_id] || []).push(c); });
      const head = ['business_name', 'contact_person', 'category', 'state', 'city', 'emails', 'phones', 'website', 'source_url', 'discovered_at', 'verification_status', 'email_permission', 'whatsapp_permission', 'do_not_contact', 'stage', 'last_contacted_at'];
      const lines = [head.join(',')].concat(rows.map((p) => {
        const cs = by[p.id] || [];
        return [p.name, p.contact_person, p.category, p.state, p.city, cs.filter((c) => c.channel === 'email').map((c) => c.value).join('; ') || p.email, cs.filter((c) => c.channel !== 'email').map((c) => c.value).join('; ') || p.phone,
          p.website, p.source_url, p.discovered_at, p.verification_status, p.email_permission, p.whatsapp_permission, p.do_not_contact, p.stage, p.last_contacted_at].map(csvCell).join(',');
      }));
      await audit(req, 'prospects.export', 'prospect', null, { rows: rows.length, filters: { stage: f.stage || null, state: f.state || null } });
      res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="gethome-prospects-' + new Date().toISOString().slice(0, 10) + '.csv"').send(lines.join('\r\n'));
    } catch (e) { fail(res, e, 'export'); }
  });

  // ---- Audit log, roles, retention ----
  router.get('/outreach/audit-log', manage, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500), offset = Math.max(parseInt(req.query.offset) || 0, 0);
    let q = db.from('gx_audit_log').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.entity) q = q.eq('entity', String(req.query.entity).slice(0, 40));
    if (req.query.actor) q = q.eq('actor', String(req.query.actor).slice(0, 200));
    const { data, count, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ total: count || 0, entries: data || [] });
  });

  router.get('/outreach/roles', owner, async (req, res) => {
    const { data, error } = await db.from('gx_admin_roles').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  router.put('/outreach/roles/:userId', owner, async (req, res) => {
    try {
      if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'Invalid user id' });
      if (!['admin', 'recruiter', 'viewer'].includes(req.body && req.body.role)) return res.status(400).json({ error: 'role must be admin, recruiter or viewer' });
      const { data: prof } = await db.from('profiles').select('id').eq('id', req.params.userId).maybeSingle();
      if (!prof) return res.status(404).json({ error: 'No GetHome account with this id' });
      const { error } = await db.from('gx_admin_roles').upsert([{ user_id: req.params.userId, role: req.body.role, created_by: actorOf(req) }], { onConflict: 'user_id' });
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'role.set', 'user', req.params.userId, { role: req.body.role });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'role-set'); }
  });
  router.delete('/outreach/roles/:userId', owner, async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'Invalid user id' });
    const { error } = await db.from('gx_admin_roles').delete().eq('user_id', req.params.userId);
    if (error) return res.status(500).json({ error: error.message });
    await audit(req, 'role.remove', 'user', req.params.userId, {});
    res.json({ success: true });
  });

  // Data retention: delete discovered prospects that were never contacted, never consented, never converted and are
  // older than the configured period. Dry run by default. The suppression list is never purged.
  router.post('/outreach/retention/run', owner, async (req, res) => {
    try {
      const dry = !(req.body && req.body.dry_run === false);
      const s = await C.getSettings(db);
      const cutoff = new Date(Date.now() - (Number(s.retention_days_unengaged) || 365) * 86400000).toISOString();
      const rows = await fetchAll(() => db.from('gx_prospects').select('id').lt('discovered_at', cutoff).in('stage', ['new', 'qualified', 'permission_obtained', 'campaign_ready']).is('last_contacted_at', null).is('profile_id', null).eq('email_permission', 'none').eq('whatsapp_permission', 'none'));
      const ids = rows.map((r) => r.id);
      if (!dry) for (let i = 0; i < ids.length; i += 100) await db.from('gx_prospects').delete().in('id', ids.slice(i, i + 100));
      await audit(req, dry ? 'retention.dry_run' : 'retention.purge', 'prospect', null, { count: ids.length, cutoff });
      res.json({ dry_run: dry, cutoff, prospects_affected: ids.length });
    } catch (e) { fail(res, e, 'retention'); }
  });

  app.use('/api/growth', router);
};
