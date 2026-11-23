// Outreach Command Centre, phases 7-8: recruitment conversions, GHA attribution and analytics.
// Rules:
//  - A "paying agent" and any subscription revenue are counted ONLY when an earnings row created from a verified
//    Flutterwave payment (gha_earnings / sa_earnings, keyed by payment_reference) exists for that agent.
//  - Nothing here calculates or pays compensation. Salary/PPA and the SA 6% commission are read from the existing
//    records and the existing salary function; the compensation model is not changed.
//  - Message "delivered" is a provider delivery event. Email opens are not measured or claimed.
'use strict';
const express = require('express');
const createAuth = require('../middleware/auth');
const Core = require('./outreachCore');

const STAGE_ORDER = ['new', 'qualified', 'permission_obtained', 'campaign_ready', 'contacted', 'interested', 'applied', 'approved', 'subscribed'];
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const num = (v) => parseFloat(v) || 0;

module.exports = function mountAnalytics(app, db, helpers) {
  helpers = helpers || {};
  const auth = createAuth(db);
  const router = express.Router();
  const read = auth.requireRole('viewer'), manage = auth.requireRole('admin');
  const actorOf = (req) => (req.admin && (req.admin.email || req.admin.id)) || 'unknown';
  const audit = async (req, action, details) => { try { await db.from('gx_audit_log').insert([{ actor: actorOf(req), actor_role: req.adminRole, action, entity: 'analytics', details: details || {}, ip: req.ip }]); } catch (e) { /* best effort */ } };
  const fail = (res, e, tag) => { console.error('[outreach/' + tag + ']', e.message || e); return res.status(500).json({ error: 'Report failed' }); };

  async function fetchAll(build) {
    let all = [];
    for (let from = 0; ; from += 1000) { const { data, error } = await build().range(from, from + 999); if (error) throw error; all = all.concat(data || []); if (!data || data.length < 1000) break; }
    return all;
  }
  async function inChunks(table, col, values, select) {
    let out = [];
    for (let i = 0; i < values.length; i += 150) { const { data, error } = await db.from(table).select(select).in(col, values.slice(i, i + 150)); if (error) throw error; out = out.concat(data || []); }
    return out;
  }

  // ---------- conversions: link prospects to real accounts, record verified events ----------
  async function syncConversions() {
    const res = { linked: 0, registered: 0, approved: 0, subscribed_payments: 0, stages_updated: 0 };
    // 1) link prospects that registered without being linked at signup (match on business email)
    const unlinked = await fetchAll(() => db.from('gx_prospects').select('id').is('profile_id', null).neq('stage', 'lost'));
    if (unlinked.length) {
      const contacts = await inChunks('gx_prospect_contacts', 'prospect_id', unlinked.map((p) => p.id), 'prospect_id, value, channel');
      const byEmail = {}; contacts.filter((c) => c.channel === 'email').forEach((c) => { byEmail[c.value] = c.prospect_id; });
      const emails = Object.keys(byEmail);
      const profs = emails.length ? await inChunks('profiles', 'email', emails, 'id, email, role') : [];
      for (const pr of profs) { if (pr.role !== 'agent') continue; const pid = byEmail[String(pr.email).toLowerCase()]; if (!pid) continue; await db.from('gx_prospects').update({ profile_id: pr.id }).eq('id', pid); res.linked++; }
    }
    // 2) registered / approved / subscribed
    const linked = await fetchAll(() => db.from('gx_prospects').select('id, profile_id, stage, owner_type, owner_id, applied_at, approved_at, subscribed_at').not('profile_id', 'is', null));
    if (!linked.length) return res;
    const profiles = await inChunks('profiles', 'id', [...new Set(linked.map((p) => p.profile_id))], 'id, status, created_at, sa_id, gha_id, subscription_tier, subscription_status, subscription_end, is_unlimited, unlimited_expires_at');
    const prof = {}; profiles.forEach((p) => { prof[p.id] = p; });
    const [ghaE, saE] = await Promise.all([
      inChunks('gha_earnings', 'agent_id', Object.keys(prof), 'agent_id, gha_id, payment_reference, subscription_amount, month_year'),
      inChunks('sa_earnings', 'agent_id', Object.keys(prof), 'agent_id, sa_id, payment_reference, subscription_amount, month_year'),
    ]);
    const nowD = new Date();
    for (const p of linked) {
      const a = prof[p.profile_id]; if (!a) continue;
      const gha = p.owner_type === 'GHA' ? p.owner_id : a.gha_id || null;
      const base = { prospect_id: p.id, profile_id: a.id, gha_id: gha, sa_id: a.sa_id || null };
      const ins = async (row) => { const { error } = await db.from('gx_conversions').insert([Object.assign({}, base, row)]); return !error; };
      if (await ins({ event: 'registered', occurred_at: a.created_at || nowD.toISOString() })) res.registered++;
      if (a.status === 'approved' && await ins({ event: 'approved', occurred_at: nowD.toISOString() })) res.approved++;
      // verified payments only: an earnings row with a payment_reference
      const seen = new Set();
      for (const e of [].concat(ghaE.filter((x) => x.agent_id === a.id).map((x) => Object.assign({ from: 'gha_earnings' }, x)), saE.filter((x) => x.agent_id === a.id).map((x) => Object.assign({ from: 'sa_earnings' }, x)))) {
        if (!e.payment_reference || seen.has(e.payment_reference)) continue; seen.add(e.payment_reference);
        if (await ins({ event: 'subscribed', subscription_amount: num(e.subscription_amount), payment_reference: e.payment_reference, payment_verified: true, verified_from: e.from, gha_id: e.gha_id || gha, sa_id: e.sa_id || a.sa_id || null, occurred_at: nowD.toISOString() })) res.subscribed_payments++;
      }
      // pipeline stage follows the real account (forward only)
      let stage = p.stage; const upd = {}; const ts = nowD.toISOString();
      if (helpers.isAgentSubActive && helpers.isAgentSubActive(a, nowD)) { stage = 'subscribed'; if (!p.subscribed_at) upd.subscribed_at = ts; }
      else if (a.status === 'approved' && STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf('approved')) stage = 'approved';
      else if (STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf('applied') && stage !== 'lost') stage = 'applied';
      if (stage !== p.stage && p.stage !== 'lost') {
        upd.stage = stage; if (!p.applied_at) upd.applied_at = ts; if (stage === 'approved' && !p.approved_at) upd.approved_at = ts;
        await db.from('gx_prospects').update(upd).eq('id', p.id); res.stages_updated++;
        await Core.stopForProspect(db, p.id, stage === 'subscribed' ? 'subscribed' : 'registered');
      }
    }
    return res;
  }

  router.post('/outreach/conversions/sync', manage, async (req, res) => {
    try { const r = await syncConversions(); await audit(req, 'conversions.sync', r); res.json(r); } catch (e) { fail(res, e, 'sync'); }
  });

  // ---------- analytics ----------
  function parseRange(q) {
    const to = q.to ? new Date(q.to) : new Date(); const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
    if (isNaN(to) || isNaN(from) || from > to) { const e = new Error('Invalid from/to date'); e.status = 400; throw e; }
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to.setUTCHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  async function compute(q) {
    const { from, to } = parseRange(q);
    const state = q.state ? String(q.state).toLowerCase() : null, campaignId = isUuid(q.campaign_id) ? q.campaign_id : null;
    const [prospects, campaigns, messages, replies, conv] = await Promise.all([
      fetchAll(() => db.from('gx_prospects').select('id, state, campaign_id, stage, discovered_at, qualified_at, email_permission, whatsapp_permission, do_not_contact')),
      fetchAll(() => db.from('gx_recruit_campaigns').select('id, name, status, created_at')),
      fetchAll(() => db.from('gx_messages').select('id, prospect_id, campaign_id, channel, status, sent_at, delivered_at, bounced_at, created_at').gte('created_at', from).lte('created_at', to)),
      fetchAll(() => db.from('gx_replies').select('id, prospect_id, channel, classification, received_at').gte('received_at', from).lte('received_at', to)),
      fetchAll(() => db.from('gx_conversions').select('prospect_id, event, subscription_amount, payment_reference, payment_verified, occurred_at').gte('occurred_at', from).lte('occurred_at', to)),
    ]);
    const pById = {}; prospects.forEach((p) => { pById[p.id] = p; });
    const inFilter = (p) => !!p && (!state || String(p.state || '').toLowerCase() === state) && (!campaignId || p.campaign_id === campaignId);
    const cohort = prospects.filter((p) => inFilter(p) && p.discovered_at >= from && p.discovered_at <= to);
    const cohortIds = cohort.map((p) => p.id);
    const contacts = cohortIds.length ? await inChunks('gx_prospect_contacts', 'prospect_id', cohortIds, 'prospect_id, channel, verification_status, verification_method') : [];
    const cBy = {}; contacts.forEach((c) => { (cBy[c.prospect_id] = cBy[c.prospect_id] || []).push(c); });
    const idx = (s) => STAGE_ORDER.indexOf(s);

    const msgs = messages.filter((m) => inFilter(pById[m.prospect_id]) && (!campaignId || m.campaign_id === campaignId));
    const sentMsgs = msgs.filter((m) => m.sent_at);
    const firstChannel = {}; sentMsgs.slice().sort((a, b) => (a.sent_at > b.sent_at ? 1 : -1)).forEach((m) => { if (!firstChannel[m.prospect_id]) firstChannel[m.prospect_id] = m.channel; });
    const contacted = new Set(sentMsgs.map((m) => m.prospect_id));
    const reps = replies.filter((r) => inFilter(pById[r.prospect_id]));
    const cv = conv.filter((c) => inFilter(pById[c.prospect_id]));
    const regSet = new Set(cv.filter((c) => c.event === 'registered').map((c) => c.prospect_id));
    const appSet = new Set(cv.filter((c) => c.event === 'approved').map((c) => c.prospect_id));
    const paidRows = cv.filter((c) => c.event === 'subscribed' && c.payment_verified && c.payment_reference);
    const seenRef = new Set(); const payments = paidRows.filter((c) => (seenRef.has(c.payment_reference) ? false : (seenRef.add(c.payment_reference), true)));
    const paySet = new Set(payments.map((c) => c.prospect_id));
    const interestedSet = new Set(reps.filter((r) => r.classification === 'interested').map((r) => r.prospect_id).concat(prospects.filter((p) => inFilter(p) && p.stage === 'interested').map((p) => p.id)));
    const revenue = payments.reduce((t, c) => t + num(c.subscription_amount), 0);

    const totals = {
      prospects_discovered: cohort.length,
      qualified: cohort.filter((p) => p.qualified_at || (idx(p.stage) >= idx('qualified'))).length,
      with_verified_contact: cohort.filter((p) => (cBy[p.id] || []).some((c) => c.verification_status === 'verified')).length,
      with_domain_checked_email: cohort.filter((p) => (cBy[p.id] || []).some((c) => c.channel === 'email' && c.verification_method === 'mx_lookup' && c.verification_status !== 'invalid')).length,
      with_explicit_permission: cohort.filter((p) => p.email_permission === 'granted' || p.whatsapp_permission === 'granted').length,
      opted_out: cohort.filter((p) => p.do_not_contact).length,
      campaigns_prepared: campaigns.filter((c) => c.status !== 'draft' && c.created_at >= from && c.created_at <= to && (!campaignId || c.id === campaignId)).length,
      emails_sent: sentMsgs.filter((m) => m.channel === 'email').length,
      emails_delivered: msgs.filter((m) => m.channel === 'email' && (m.delivered_at || m.status === 'delivered')).length,
      emails_bounced: msgs.filter((m) => m.channel === 'email' && (m.bounced_at || m.status === 'bounced')).length,
      whatsapp_sent: sentMsgs.filter((m) => m.channel === 'whatsapp').length,
      whatsapp_delivered: msgs.filter((m) => m.channel === 'whatsapp' && (m.delivered_at || m.status === 'delivered')).length,
      prospects_contacted: contacted.size,
      replies_received: reps.length,
      prospects_who_replied: new Set(reps.map((r) => r.prospect_id)).size,
      interested_prospects: interestedSet.size,
      registered_agents: regSet.size,
      approved_agents: appSet.size,
      paying_agents: paySet.size,
      subscription_revenue_ngn: revenue,
    };
    const rates = { reply_rate_pct: rate(totals.prospects_who_replied, totals.prospects_contacted), contacted_to_registered_pct: rate(regSet.size, totals.prospects_contacted), registered_to_paying_pct: rate(paySet.size, regSet.size), contacted_to_paying_pct: rate(paySet.size, totals.prospects_contacted) };

    const group = (keyFn, labelFn) => {
      const rows = {};
      const row = (k) => (rows[k] = rows[k] || { key: k, label: labelFn ? labelFn(k) : k, discovered: 0, contacted: new Set(), delivered: 0, replies: new Set(), interested: new Set(), registered: new Set(), paying: new Set(), revenue: 0 });
      cohort.forEach((p) => { row(keyFn(p)).discovered++; });
      sentMsgs.forEach((m) => { const p = pById[m.prospect_id]; if (p) row(keyFn(p, m)).contacted.add(m.prospect_id); });
      msgs.forEach((m) => { if (m.delivered_at || m.status === 'delivered') { const p = pById[m.prospect_id]; if (p) row(keyFn(p, m)).delivered++; } });
      reps.forEach((r) => { const p = pById[r.prospect_id]; if (p) { const rw = row(keyFn(p, { channel: r.channel })); rw.replies.add(r.prospect_id); if (r.classification === 'interested') rw.interested.add(r.prospect_id); } });
      regSet.forEach((id) => { const p = pById[id]; if (p) row(keyFn(p, { channel: firstChannel[id] })).registered.add(id); });
      payments.forEach((c) => { const p = pById[c.prospect_id]; if (p) { const rw = row(keyFn(p, { channel: firstChannel[c.prospect_id] })); rw.paying.add(c.prospect_id); rw.revenue += num(c.subscription_amount); } });
      return Object.values(rows).map((r) => ({ key: r.key, label: r.label, discovered: r.discovered, contacted: r.contacted.size, delivered: r.delivered, replies: r.replies.size, interested: r.interested.size, registered: r.registered.size, paying: r.paying.size, revenue_ngn: r.revenue, reply_rate_pct: rate(r.replies.size, r.contacted.size), contacted_to_registered_pct: rate(r.registered.size, r.contacted.size), registered_to_paying_pct: rate(r.paying.size, r.registered.size) }));
    };
    const cName = {}; campaigns.forEach((c) => { cName[c.id] = c.name; });
    return {
      range: { from, to }, filters: { state: q.state || null, campaign_id: campaignId },
      totals, rates,
      by_campaign: group((p) => p.campaign_id || 'none', (k) => (k === 'none' ? 'No campaign' : cName[k] || k)),
      by_state: group((p) => p.state || 'Unknown'),
      by_channel: group((p, m) => (m && m.channel) || firstChannel[p.id] || 'none', (k) => (k === 'none' ? 'Never contacted' : k)).filter((r) => r.key !== 'none'),
      notes: [
        'Discovery and permission figures count prospects discovered in this period; message, reply and conversion figures count events in this period.',
        'Paying agents and revenue count only subscriptions with a verified payment reference in the earnings records.',
        'Delivered means the provider reported delivery. Email opens are not measured, and replies are the measure of human engagement.',
        'Registered/paying are attributed to the channel of the first message sent to that prospect.',
      ],
    };
  }

  router.get('/outreach/analytics', read, async (req, res) => {
    try { res.json(await compute(req.query)); } catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); fail(res, e, 'analytics'); }
  });

  router.get('/outreach/reports/:name.csv', manage, async (req, res) => {
    try {
      const name = req.params.name; const a = await compute(req.query);
      let head, rows;
      if (name === 'campaigns' || name === 'states' || name === 'channels') {
        const src = name === 'campaigns' ? a.by_campaign : (name === 'states' ? a.by_state : a.by_channel);
        head = [name === 'campaigns' ? 'campaign' : (name === 'states' ? 'state' : 'channel'), 'discovered', 'contacted', 'delivered', 'replies', 'interested', 'registered', 'paying', 'revenue_ngn', 'reply_rate_pct', 'contacted_to_registered_pct', 'registered_to_paying_pct'];
        rows = src.map((r) => [r.label, r.discovered, r.contacted, r.delivered, r.replies, r.interested, r.registered, r.paying, r.revenue_ngn, r.reply_rate_pct, r.contacted_to_registered_pct, r.registered_to_paying_pct]);
      } else if (name === 'messages') {
        const msgs = await fetchAll(() => db.from('gx_messages').select('prospect_id, channel, step, status, sent_at, delivered_at, bounced_at, bounce_reason, campaign_id').gte('created_at', a.range.from).lte('created_at', a.range.to));
        const ps = await fetchAll(() => db.from('gx_prospects').select('id, name, state, city'));
        const by = {}; ps.forEach((p) => { by[p.id] = p; });
        head = ['business', 'state', 'city', 'channel', 'step', 'status', 'sent_at', 'delivered_at', 'bounced_at', 'bounce_reason'];
        rows = msgs.map((m) => { const p = by[m.prospect_id] || {}; return [p.name, p.state, p.city, m.channel, m.step, m.status, m.sent_at, m.delivered_at, m.bounced_at, m.bounce_reason]; });
      } else return res.status(404).json({ error: 'Unknown report. Use campaigns, states, channels or messages.' });
      await audit(req, 'report.export', { report: name, rows: rows.length });
      res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="outreach-' + name + '-' + new Date().toISOString().slice(0, 10) + '.csv"')
        .send([head.join(',')].concat(rows.map((r) => r.map(csvCell).join(','))).join('\r\n'));
    } catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); fail(res, e, 'report'); }
  });

  // ---------- GHA attribution (read-only on compensation) ----------
  router.get('/outreach/gha-performance', read, async (req, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : (helpers.getBillingMonth ? helpers.getBillingMonth() : new Date().toISOString().slice(0, 7));
      const settings = helpers.getGhaSalarySettings ? await helpers.getGhaSalarySettings() : { salary: 0, target: 25, ppa: 0 };
      const [ghas, prospects, ghaE, saE] = await Promise.all([
        fetchAll(() => db.from('gha_agents').select('id, gha_code, full_name, status')),
        fetchAll(() => db.from('gx_prospects').select('id, owner_type, owner_id, profile_id, stage').not('profile_id', 'is', null)),
        fetchAll(() => db.from('gha_earnings').select('gha_id, agent_id, agent_email, commission_amount, subscription_amount, payment_reference').eq('month_year', month)),
        fetchAll(() => db.from('sa_earnings').select('sa_id, agent_id, commission_amount, subscription_amount, payment_reference').eq('month_year', month)),
      ]);
      const profs = prospects.length ? await inChunks('profiles', 'id', prospects.map((p) => p.profile_id), 'id, gha_id, status') : [];
      const prof = {}; profs.forEach((p) => { prof[p.id] = p; });
      const convs = await fetchAll(() => db.from('gx_conversions').select('prospect_id, profile_id, gha_id, event, subscription_amount, payment_reference, payment_verified'));
      const out = ghas.map((g) => {
        const mine = prospects.filter((p) => (p.owner_type === 'GHA' && p.owner_id === g.id) || (prof[p.profile_id] && prof[p.profile_id].gha_id === g.id));
        const mineProfiles = new Set(mine.map((p) => p.profile_id));
        const subs = new Set(ghaE.filter((e) => e.gha_id === g.id).map((e) => e.agent_id || String(e.agent_email || '').toLowerCase()).filter(Boolean));
        const calc = helpers.calcGhaSalary ? helpers.calcGhaSalary(subs.size, settings) : { earned: 0, target_met: false };
        const myMonthEarn = ghaE.filter((e) => e.gha_id === g.id && mineProfiles.has(e.agent_id));
        const mySa = saE.filter((e) => mineProfiles.has(e.agent_id));
        const verified = convs.filter((c) => c.event === 'subscribed' && c.payment_verified && c.payment_reference && mineProfiles.has(c.profile_id));
        const seen = new Set(); const distinct = verified.filter((c) => (seen.has(c.payment_reference) ? false : (seen.add(c.payment_reference), true)));
        return {
          id: g.id, gha_code: g.gha_code, name: g.full_name, status: g.status,
          outreach_recruited: mine.length,
          outreach_approved: mine.filter((p) => prof[p.profile_id] && prof[p.profile_id].status === 'approved').length,
          outreach_paying_all_time: new Set(distinct.map((c) => c.profile_id)).size,
          outreach_subscription_value_all_time_ngn: distinct.reduce((t, c) => t + num(c.subscription_amount), 0),
          month, outreach_subscription_value_month_ngn: myMonthEarn.reduce((t, e) => t + num(e.subscription_amount), 0),
          subscribing_agents_month_all_sources: subs.size, monthly_target: settings.target, target_met: calc.target_met, salary_earned_ngn: calc.earned,
          gha_commission_recorded_on_outreach_agents_ngn: myMonthEarn.reduce((t, e) => t + num(e.commission_amount), 0),
          sa_commission_recorded_on_outreach_agents_ngn: mySa.reduce((t, e) => t + num(e.commission_amount), 0),
        };
      }).filter((g) => g.outreach_recruited > 0 || g.subscribing_agents_month_all_sources > 0).sort((a, b) => b.outreach_recruited - a.outreach_recruited);
      res.json({ month, settings: { salary: settings.salary, target: settings.target, ppa: settings.ppa }, ghas: out,
        note: 'Read-only. Salary uses the existing GHA salary rule (full salary at target, otherwise per-agent amount) over all subscribing agents; commissions are the amounts already recorded from verified payments. Nothing is calculated or paid from this page.' });
    } catch (e) { fail(res, e, 'gha-performance'); }
  });

  app.use('/api/growth', router);
  return { syncConversions, compute };
};
