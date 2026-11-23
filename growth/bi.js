// GetHome Growth Engine - Phase 2: business intelligence (admin only).
// Read-only. Reuses the platform's own definitions (active subscription, billing month, GHA salary
// formula) passed in from index.js so the numbers always match the rest of the admin tooling.
'use strict';
const express = require('express');
const createAuth = require('../middleware/auth');

const PAGE = 1000; // Supabase returns at most 1000 rows per request

module.exports = function mountBi(app, db, helpers) {
  const auth = createAuth(db);
  const router = express.Router();
  router.use('/bi', auth.requireAdmin); // every BI route is admin-only

  // Fetch every row of a query (Supabase silently caps a single select at 1000 rows).
  async function fetchAll(build) {
    let all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
    }
    return all;
  }
  const count = async (q) => { const { count: c, error } = await q; if (error) throw error; return c || 0; };
  const head = (table) => db.from(table).select('id', { count: 'exact', head: true });
  const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

  function range(q) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
    if (isNaN(to) || isNaN(from) || from > to) { const e = new Error('Invalid from/to date'); e.status = 400; throw e; }
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to.setUTCHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const fail = (res, err, tag) => {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[bi/' + tag + ']', err.message || err);
    return res.status(500).json({ error: 'Report failed' });
  };
  const monthParam = (q) => (/^\d{4}-\d{2}$/.test(q.month || '') ? q.month : helpers.getBillingMonth());

  // Agent subscription revenue rows, de-duplicated across gha_earnings and sa_earnings
  // (the same payment can appear in both; payment_reference identifies it).
  async function subscriptionPayments(filterMonth) {
    const mk = (t) => () => { let q = db.from(t).select('payment_reference, agent_id, subscription_amount, month_year, created_at'); if (filterMonth) q = q.eq('month_year', filterMonth); return q; };
    const [g, s] = await Promise.all([fetchAll(mk('gha_earnings')), fetchAll(mk('sa_earnings'))]);
    const seen = new Map();
    g.concat(s).forEach((r) => {
      const key = r.payment_reference || (r.agent_id + '|' + r.month_year);
      if (!seen.has(key)) seen.set(key, r);
    });
    return Array.from(seen.values());
  }

  // ---- Top-line cards ----
  router.get('/bi/summary', async (req, res) => {
    try {
      const month = helpers.getBillingMonth();
      const now = new Date();
      const [customers, props, featured, openLeads, totalLeads, agents, payments] = await Promise.all([
        count(head('profiles').eq('role', 'customer')),
        count(head('properties').or('is_deleted.eq.false,is_deleted.is.null').or('is_sold.eq.false,is_sold.is.null')),
        count(head('properties').or('is_deleted.eq.false,is_deleted.is.null').eq('is_featured', true)),
        count(head('gx_leads').not('status', 'in', '(converted,dead)')),
        count(head('gx_leads')),
        fetchAll(() => db.from('profiles').select('id, status, agent_type, subscription_tier, subscription_status, subscription_end, is_unlimited, unlimited_expires_at, nin_verified, cac_verified').eq('role', 'agent')),
        subscriptionPayments(month),
      ]);
      const paying = agents.filter((a) => helpers.isAgentSubActive(a, now));
      res.json({
        generated_at: now.toISOString(), billing_month: month,
        customers,
        agents_total: agents.length,
        agencies_total: agents.filter((a) => a.agent_type === 'agency').length,
        agents_approved: agents.filter((a) => a.status === 'approved').length,
        agents_id_verified: agents.filter((a) => a.nin_verified || a.cac_verified).length,
        paying_agents: paying.length,
        paying_agencies: paying.filter((a) => a.agent_type === 'agency').length,
        listings_live: props, featured_listings: featured,
        leads_total: totalLeads, leads_open: openLeads,
        subscription_revenue_this_month_ngn: payments.reduce((t, p) => t + (parseFloat(p.subscription_amount) || 0), 0),
        subscription_payments_this_month: payments.length,
      });
    } catch (e) { fail(res, e, 'summary'); }
  });

  // ---- Funnel: sessions -> leads -> signups -> verified -> paying (period counts, not a strict cohort) ----
  router.get('/bi/funnel', async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const inRange = (q) => q.gte('created_at', from).lte('created_at', to);
      const [visits, leads, attributedSignups, customers, agentRows, convertedLeads] = await Promise.all([
        count(inRange(head('gx_attribution'))),
        count(inRange(head('gx_leads')).neq('segment', 'agent_prospect')),
        count(inRange(head('gx_attribution')).not('profile_id', 'is', null)),
        count(inRange(head('profiles')).eq('role', 'customer')),
        fetchAll(() => inRange(db.from('profiles').select('id, status, nin_verified, cac_verified, subscription_tier, subscription_status, subscription_end, is_unlimited, unlimited_expires_at').eq('role', 'agent'))),
        count(inRange(head('gx_leads')).eq('status', 'converted')),
      ]);
      const now = new Date();
      const agentsSignedUp = agentRows.length;
      const verified = agentRows.filter((a) => a.nin_verified || a.cac_verified).length;
      const approved = agentRows.filter((a) => a.status === 'approved').length;
      const paying = agentRows.filter((a) => helpers.isAgentSubActive(a, now)).length;
      res.json({
        range: { from, to },
        note: 'Counts are for people who signed up in this period (a cohort view of agents). Visits only exist from the day the frontend started calling /api/growth/attribution.',
        customer_funnel: { visits, leads, attributed_signups: attributedSignups, customer_signups: customers, converted_leads: convertedLeads,
          visit_to_signup_pct: rate(attributedSignups, visits), lead_conversion_pct: rate(convertedLeads, leads) },
        agent_funnel: { signed_up: agentsSignedUp, id_verified: verified, approved, paying,
          signup_to_verified_pct: rate(verified, agentsSignedUp), signup_to_approved_pct: rate(approved, agentsSignedUp), signup_to_paying_pct: rate(paying, agentsSignedUp) },
      });
    } catch (e) { fail(res, e, 'funnel'); }
  });

  // ---- Revenue by month (from earnings rows) + current active plan value ----
  router.get('/bi/revenue', async (req, res) => {
    try {
      const rows = await subscriptionPayments(null);
      const byMonth = {};
      rows.forEach((p) => { const m = p.month_year || String(p.created_at || '').slice(0, 7); if (!m) return; byMonth[m] = byMonth[m] || { revenue_ngn: 0, payments: 0 }; byMonth[m].revenue_ngn += parseFloat(p.subscription_amount) || 0; byMonth[m].payments++; });
      const months = Object.keys(byMonth).sort().slice(-12);
      const history = months.map((m) => ({ month: m, revenue_ngn: byMonth[m].revenue_ngn, payments: byMonth[m].payments }));
      const now = new Date();
      const agents = await fetchAll(() => db.from('profiles').select('subscription_tier, subscription_amount, subscription_status, subscription_end, is_unlimited, unlimited_expires_at').eq('role', 'agent'));
      const byTier = {};
      agents.filter((a) => helpers.isAgentSubActive(a, now)).forEach((a) => {
        const t = a.is_unlimited ? 'unlimited' : (a.subscription_tier || 'unknown');
        byTier[t] = byTier[t] || { agents: 0, plan_value_ngn: 0 };
        byTier[t].agents++; byTier[t].plan_value_ngn += parseFloat(a.subscription_amount) || 0;
      });
      res.json({
        history,
        active_by_tier: byTier,
        note: 'history = money recorded in gha_earnings/sa_earnings by billing month (28th rollover). plan_value is the amount of each agent\'s current plan, not monthly recurring revenue, because plans have different durations.',
      });
    } catch (e) { fail(res, e, 'revenue'); }
  });

  // ---- Agent acquisition ----
  router.get('/bi/agents', async (req, res) => {
    try {
      const now = new Date();
      const rows = await fetchAll(() => db.from('profiles').select('status, agent_type, gha_id, sa_id, created_at, subscription_tier, subscription_status, subscription_end, is_unlimited, unlimited_expires_at, nin_verified, cac_verified, referred_by_gha').eq('role', 'agent'));
      const ym = (d) => d.toISOString().slice(0, 7);
      const thisM = ym(now), lastM = ym(new Date(now.getFullYear(), now.getMonth() - 1, 15));
      const s = { total: rows.length, agents: 0, agencies: 0, by_status: {}, id_verified: 0, paying: 0, expired: 0, with_gha: 0, via_gha_referral: 0, signups_this_month: 0, signups_last_month: 0 };
      rows.forEach((a) => {
        if (a.agent_type === 'agency') s.agencies++; else s.agents++;
        s.by_status[a.status || 'unknown'] = (s.by_status[a.status || 'unknown'] || 0) + 1;
        if (a.nin_verified || a.cac_verified) s.id_verified++;
        if (helpers.isAgentSubActive(a, now)) s.paying++;
        if (helpers.isAgentSubExpired(a, now)) s.expired++;
        if (a.gha_id) s.with_gha++;
        if (a.referred_by_gha) s.via_gha_referral++;
        const m = String(a.created_at || '').slice(0, 7);
        if (m === thisM) s.signups_this_month++; if (m === lastM) s.signups_last_month++;
      });
      s.approved_to_paying_pct = rate(s.paying, s.by_status.approved || 0);
      s.month_over_month_pct = s.signups_last_month > 0 ? Math.round(((s.signups_this_month - s.signups_last_month) / s.signups_last_month) * 100) : null;
      res.json(s);
    } catch (e) { fail(res, e, 'agents'); }
  });

  // ---- GHA performance, using the platform's own salary formula (target met -> salary, else subscribers x PPA) ----
  router.get('/bi/gha-performance', async (req, res) => {
    try {
      const month = monthParam(req.query);
      const settings = await helpers.getGhaSalarySettings();
      const accompanyFee = await helpers.getGhaAccompanyFee();
      const monthStart = month + '-01';
      const next = new Date(monthStart); next.setUTCMonth(next.getUTCMonth() + 1);
      const monthEnd = next.toISOString().slice(0, 10);
      const [ghas, earnings, referred, payments, insp] = await Promise.all([
        fetchAll(() => db.from('gha_agents').select('id, gha_code, full_name, email, status, sa_id')),
        fetchAll(() => db.from('gha_earnings').select('gha_id, agent_id, agent_email, commission_amount, subscription_amount, is_paid').eq('month_year', month)),
        fetchAll(() => db.from('profiles').select('gha_id').eq('role', 'agent').not('gha_id', 'is', null)),
        fetchAll(() => db.from('staff_payments').select('staff_id, salary_amount').eq('staff_type', 'GHA').eq('month_year', month)),
        fetchAll(() => db.from('inspections').select('gha_id').eq('status', 'confirmed').eq('gha_accompanied', true).gte('sa_confirmed_at', monthStart).lt('sa_confirmed_at', monthEnd)),
      ]);
      const by = (arr, f) => arr.reduce((m, r) => { const k = f(r); (m[k] = m[k] || []).push(r); return m; }, {});
      const earnBy = by(earnings, (r) => r.gha_id), refBy = by(referred, (r) => r.gha_id), payBy = by(payments, (r) => r.staff_id), inspBy = by(insp, (r) => r.gha_id);
      const out = ghas.map((g) => {
        const e = earnBy[g.id] || [];
        const subscribers = new Set(e.map((r) => r.agent_id || (r.agent_email || '').toLowerCase()).filter(Boolean)).size;
        const calc = helpers.calcGhaSalary(subscribers, settings);
        const salaryPaid = (payBy[g.id] || []).reduce((t, r) => t + (parseFloat(r.salary_amount) || 0), 0);
        const inspections = (inspBy[g.id] || []).length;
        const inspectionFees = inspections * accompanyFee;
        const commission = e.reduce((t, r) => t + (parseFloat(r.commission_amount) || 0), 0);
        const subRevenue = e.reduce((t, r) => t + (parseFloat(r.subscription_amount) || 0), 0);
        return {
          id: g.id, gha_code: g.gha_code, name: g.full_name, status: g.status, sa_id: g.sa_id,
          referred_agents_total: (refBy[g.id] || []).length,
          subscribing_agents: subscribers, monthly_target: settings.target, target_met: calc.target_met,
          target_pct: settings.target > 0 ? Math.round((subscribers / settings.target) * 100) : null,
          subscription_revenue_ngn: subRevenue,
          salary_earned_ngn: calc.earned, salary_paid_ngn: salaryPaid, salary_owed_ngn: Math.max(0, calc.earned - salaryPaid),
          accompanied_inspections: inspections, inspection_fees_ngn: inspectionFees,
          commission_recorded_ngn: commission,
          cost_to_platform_ngn: calc.earned + inspectionFees,
          revenue_per_naira_cost: (calc.earned + inspectionFees) > 0 ? Math.round((subRevenue / (calc.earned + inspectionFees)) * 100) / 100 : null,
        };
      }).sort((a, b) => b.subscribing_agents - a.subscribing_agents);
      const sum = (k) => out.reduce((t, g) => t + (g[k] || 0), 0);
      res.json({
        month, settings: { salary: settings.salary, target: settings.target, ppa: settings.ppa, accompany_fee: accompanyFee },
        totals: { ghas: out.length, subscribing_agents: sum('subscribing_agents'), subscription_revenue_ngn: sum('subscription_revenue_ngn'), salary_earned_ngn: sum('salary_earned_ngn'), salary_owed_ngn: sum('salary_owed_ngn'), inspection_fees_ngn: sum('inspection_fees_ngn'), ghas_at_target: out.filter((g) => g.target_met).length },
        note: 'Salary uses the live formula in index.js (calcGhaSalary). commission_recorded_ngn is the percentage commission still written to gha_earnings; it is informational and is not added to cost_to_platform_ngn.',
        ghas: out,
      });
    } catch (e) { fail(res, e, 'gha-performance'); }
  });

  // ---- Lead pipeline ----
  router.get('/bi/leads', async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const rows = await fetchAll(() => db.from('gx_leads').select('source, segment, status, next_follow_up, utm_source').gte('created_at', from).lte('created_at', to));
      const tally = (f) => rows.reduce((m, r) => { const k = f(r) || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});
      const nowIso = new Date().toISOString();
      const converted = rows.filter((r) => r.status === 'converted').length;
      res.json({
        range: { from, to }, total: rows.length, converted, conversion_pct: rate(converted, rows.length),
        overdue_follow_ups: rows.filter((r) => r.next_follow_up && r.next_follow_up < nowIso && !['converted', 'dead'].includes(r.status)).length,
        by_source: tally((r) => r.source), by_segment: tally((r) => r.segment), by_status: tally((r) => r.status), by_utm_source: tally((r) => r.utm_source),
      });
    } catch (e) { fail(res, e, 'leads'); }
  });

  // ---- Marketing efficiency ----
  router.get('/bi/marketing', async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const [spend, sessions, leads] = await Promise.all([
        fetchAll(() => db.from('gx_spend').select('channel, amount_ngn').gte('spend_date', from.slice(0, 10)).lte('spend_date', to.slice(0, 10))),
        fetchAll(() => db.from('gx_attribution').select('utm_source, utm_medium, profile_id').gte('created_at', from).lte('created_at', to)),
        fetchAll(() => db.from('gx_leads').select('utm_source, utm_medium').gte('created_at', from).lte('created_at', to)),
      ]);
      const spendBy = {}; let totalSpend = 0;
      spend.forEach((s) => { const a = parseFloat(s.amount_ngn) || 0; spendBy[s.channel] = (spendBy[s.channel] || 0) + a; totalSpend += a; });
      const PAID = ['cpc', 'paid', 'paidsocial', 'paid_social', 'ppc'];
      const paidSessions = sessions.filter((s) => PAID.includes(String(s.utm_medium || '').toLowerCase()));
      const paidSignups = paidSessions.filter((s) => s.profile_id).length;
      const paidLeads = leads.filter((l) => PAID.includes(String(l.utm_medium || '').toLowerCase())).length;
      const signups = sessions.filter((s) => s.profile_id).length;
      const per = (n) => (n > 0 ? Math.round(totalSpend / n) : null);
      const sources = {};
      sessions.forEach((s) => { const k = s.utm_source || 'direct'; sources[k] = sources[k] || { sessions: 0, signups: 0 }; sources[k].sessions++; if (s.profile_id) sources[k].signups++; });
      res.json({
        range: { from, to }, total_spend_ngn: totalSpend, spend_by_channel: spendBy,
        sessions: sessions.length, signups, leads: leads.length,
        cost_per_lead_ngn: per(leads.length), cost_per_signup_ngn: per(signups),
        paid: { sessions: paidSessions.length, signups: paidSignups, leads: paidLeads },
        by_utm_source: sources,
        note: totalSpend === 0 ? 'No spend recorded yet. Add entries via POST /api/growth/spend.' : 'Cost per lead/signup divides ALL spend by ALL leads/signups in the range (organic included), so it flatters paid channels; use the paid block for channel-level judgement.',
      });
    } catch (e) { fail(res, e, 'marketing'); }
  });

  app.use('/api/growth', router);
};
