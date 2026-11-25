// GetHome Growth Engine - Phase 5: marketing campaigns, AI copy/script generation grounded in real
// listing data, a content calendar with approval, and campaign performance from tracked links.
// Photos/videos are uploaded here; posting is done from the phone's share sheet or the platform's own page (no platform keys
// needed), then the post URL and its numbers are recorded here. Insights rank what performed and advise what to make next.
'use strict';
const express = require('express');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');
const { matchesCity } = require('./cityAreas');
const multer = require('multer');
const crypto = require('crypto');

const GOALS = ['customer_acquisition', 'agent_recruitment', 'brand_awareness'];
const KINDS = ['social_post', 'video_script', 'ad_copy', 'whatsapp_broadcast', 'email', 'seo_blurb'];
const STATUSES = ['idea', 'draft', 'approved', 'scheduled', 'published', 'rejected'];
const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed'];
const PLATFORMS = ['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'whatsapp', 'google_ads', 'email', 'website'];
const PURPOSE_TAB = { rent: 'rent', sale: 'sale', shortlet: 'shortlet' };
const DAILY_AI_ITEM_CAP = 60; // keeps model spend predictable
const SITE = 'https://trygethome.online';
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'property-media';
const MEDIA_TYPES = { 'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'image/webp': ['image', 'webp'], 'video/mp4': ['video', 'mp4'], 'video/quicktime': ['video', 'mov'] };
const METRIC_KEYS = ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks'];
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
// How well a post did: interactions (comments, shares and saves count more than likes) per 1,000 people reached.
function scoreOf(m) {
  m = m || {}; const n = (k) => Math.max(0, Number(m[k]) || 0);
  const inter = n('likes') + 2 * n('comments') + 3 * n('shares') + 2 * n('saves') + 2 * n('clicks');
  const base = n('reach') || n('views');
  return { interactions: inter, base, score: base > 0 ? Math.round((inter / base) * 1000) : inter, per_1000: base > 0 };
}
const hasMetrics = (m) => METRIC_KEYS.some((k) => Number(m && m[k]) > 0);

const clip = (v, n) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; };
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

module.exports = function mountMarketing(app, db) {
  const auth = createAuth(db);
  const router = express.Router();
  router.use('/marketing', auth.requireAdmin);

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

  // ---- Campaigns ----
  router.get('/marketing/campaigns', async (req, res) => {
    const { data, error } = await db.from('gx_campaigns').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  router.post('/marketing/campaigns', async (req, res) => {
    try {
      const b = req.body || {};
      const name = clip(b.name, 120);
      if (!name) return res.status(400).json({ error: 'name required' });
      const utm = slugify(b.utm_campaign || name);
      if (utm.length < 3) return res.status(400).json({ error: 'utm_campaign must be 3-40 chars (a-z, 0-9, _)' });
      const budget = b.budget_ngn === undefined || b.budget_ngn === '' ? 0 : Number(b.budget_ngn);
      if (!Number.isFinite(budget) || budget < 0) return res.status(400).json({ error: 'budget_ngn must be a non-negative number' });
      const row = {
        name, utm_campaign: utm, goal: GOALS.includes(b.goal) ? b.goal : 'customer_acquisition',
        channel: clip(b.channel, 30), state: clip(b.state, 60), city: clip(b.city, 60), budget_ngn: budget,
        status: CAMPAIGN_STATUSES.includes(b.status) ? b.status : 'active', notes: clip(b.notes, 1000),
        created_by: req.admin.email || req.admin.id,
      };
      for (const k of ['start_date', 'end_date']) {
        if (b[k]) { const d = new Date(b[k]); if (isNaN(d)) return res.status(400).json({ error: k + ' invalid' }); row[k] = d.toISOString().slice(0, 10); }
      }
      const { data, error } = await db.from('gx_campaigns').insert([row]).select().single();
      if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'A campaign with this utm_campaign already exists' : error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/marketing/campaigns/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}, upd = {};
      if (b.status !== undefined) { if (!CAMPAIGN_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' }); upd.status = b.status; }
      if (b.budget_ngn !== undefined) { const n = Number(b.budget_ngn); if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid budget' }); upd.budget_ngn = n; }
      if (b.notes !== undefined) upd.notes = clip(b.notes, 1000);
      // utm_campaign is deliberately not editable: links already posted carry it.
      if (b.name !== undefined) { const v = clip(b.name, 120); if (!v) return res.status(400).json({ error: 'name cannot be empty' }); upd.name = v; }
      if (b.goal !== undefined) { if (!GOALS.includes(b.goal)) return res.status(400).json({ error: 'Invalid goal' }); upd.goal = b.goal; }
      for (const k of ['channel', 'state', 'city']) if (b[k] !== undefined) upd[k] = clip(b[k], k === 'channel' ? 30 : 60);
      for (const k of ['start_date', 'end_date']) {
        if (b[k] === undefined) continue;
        if (!b[k]) { upd[k] = null; continue; }
        const d = new Date(b[k]); if (isNaN(d)) return res.status(400).json({ error: k + ' invalid' }); upd[k] = d.toISOString().slice(0, 10);
      }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_campaigns').update(upd).eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Performance: tracked links (utm_campaign) joined to sessions, signups, leads and spend ----
  router.get('/marketing/performance', async (req, res) => {
    try {
      const [camps, sessions, leads, spend, content] = await Promise.all([
        fetchAll(() => db.from('gx_campaigns').select('id, name, utm_campaign, goal, channel, budget_ngn, status')),
        fetchAll(() => db.from('gx_attribution').select('utm_campaign, profile_id').not('utm_campaign', 'is', null)),
        fetchAll(() => db.from('gx_leads').select('utm_campaign, status').not('utm_campaign', 'is', null)),
        fetchAll(() => db.from('gx_spend').select('utm_campaign, amount_ngn').not('utm_campaign', 'is', null)),
        fetchAll(() => db.from('gx_content_items').select('campaign_id, status')),
      ]);
      const rows = camps.map((c) => {
        const s = sessions.filter((x) => x.utm_campaign === c.utm_campaign);
        const l = leads.filter((x) => x.utm_campaign === c.utm_campaign);
        const sp = spend.filter((x) => x.utm_campaign === c.utm_campaign).reduce((t, x) => t + (parseFloat(x.amount_ngn) || 0), 0);
        const signups = s.filter((x) => x.profile_id).length;
        const items = content.filter((x) => x.campaign_id === c.id);
        return {
          id: c.id, name: c.name, utm_campaign: c.utm_campaign, goal: c.goal, channel: c.channel, status: c.status,
          budget_ngn: parseFloat(c.budget_ngn) || 0, spend_logged_ngn: sp,
          sessions: s.length, signups, leads: l.length, leads_converted: l.filter((x) => x.status === 'converted').length,
          cost_per_signup_ngn: signups > 0 && sp > 0 ? Math.round(sp / signups) : null,
          cost_per_lead_ngn: l.length > 0 && sp > 0 ? Math.round(sp / l.length) : null,
          content_published: items.filter((x) => x.status === 'published').length, content_total: items.length,
        };
      });
      res.json({
        campaigns: rows,
        note: 'Costs use spend logged in gx_spend with the same utm_campaign (POST /api/growth/spend). Sessions and signups only exist where links carried utm_campaign and the visitor\'s browser sent attribution.',
      });
    } catch (e) { console.error('[marketing/performance]', e.message); res.status(500).json({ error: 'Report failed' }); }
  });

  // ---- Photo / video upload (stored in the public media bucket; returns a link to attach to a post) ----
  router.post('/marketing/media', limiter(60 * 1000, 20), (req, res) => {
    mediaUpload.single('file')(req, res, async (err) => {
      try {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 50 MB). Compress the video first.' : 'Upload failed' });
        const f = req.file; if (!f) return res.status(400).json({ error: 'Choose a photo or video' });
        const kind = MEDIA_TYPES[f.mimetype];
        if (!kind) return res.status(400).json({ error: 'Only JPG, PNG, WEBP photos and MP4 or MOV videos are allowed' });
        const path = 'marketing/' + new Date().toISOString().slice(0, 7) + '/' + crypto.randomUUID() + '.' + kind[1];
        const { data, error } = await db.storage.from(BUCKET).upload(path, f.buffer, { contentType: f.mimetype, cacheControl: '31536000', upsert: false });
        if (error) { console.error('[marketing/media]', error.message); return res.status(500).json({ error: 'Could not store the file' }); }
        res.json({ url: db.storage.from(BUCKET).getPublicUrl(data.path).data.publicUrl, media_type: kind[0], bytes: f.size });
      } catch (e) { console.error('[marketing/media]', e.message); res.status(500).json({ error: 'Upload failed' }); }
    });
  });

  // ---- Content items / calendar ----
  router.get('/marketing/content', async (req, res) => {
    try {
      let q = db.from('gx_content_items').select('*').order('scheduled_for', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(Math.min(parseInt(req.query.limit) || 100, 300));
      if (STATUSES.includes(req.query.status)) q = q.eq('status', req.query.status);
      if (KINDS.includes(req.query.kind)) q = q.eq('kind', req.query.kind);
      if (isUuid(req.query.campaign_id)) q = q.eq('campaign_id', req.query.campaign_id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/marketing/content', async (req, res) => {
    try {
      const b = req.body || {};
      if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'kind must be one of ' + KINDS.join(', ') });
      const body = clip(b.body, 6000);
      if (!body) return res.status(400).json({ error: 'body required' });
      const row = {
        campaign_id: isUuid(b.campaign_id) ? b.campaign_id : null, kind: b.kind, platform: PLATFORMS.includes(b.platform) ? b.platform : null,
        title: clip(b.title, 160), body, hashtags: clip(b.hashtags, 300), status: 'draft', generated_by: 'human', created_by: req.admin.email || req.admin.id,
        context: { goal: GOALS.includes(b.goal) ? b.goal : 'customer_acquisition' },
      };
      if (b.media_url) {
        const u = clip(b.media_url, 600); if (!u || !/^https:\/\//i.test(u)) return res.status(400).json({ error: 'media_url must be an https link' });
        row.media_url = u; row.media_type = b.media_type === 'video' ? 'video' : 'image';
      }
      const { data, error } = await db.from('gx_content_items').insert([row]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/marketing/content/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const b = req.body || {}, upd = {};
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
        upd.status = b.status;
        if (b.status === 'published') upd.published_at = new Date().toISOString();
      }
      if (b.body !== undefined) { const v = clip(b.body, 6000); if (!v) return res.status(400).json({ error: 'body cannot be empty' }); upd.body = v; }
      if (b.title !== undefined) upd.title = clip(b.title, 160);
      if (b.hashtags !== undefined) upd.hashtags = clip(b.hashtags, 300);
      if (b.published_url !== undefined) {
        const u = clip(b.published_url, 500);
        if (u && !/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'published_url must start with http(s)://' });
        upd.published_url = u;
      }
      if (b.media_url !== undefined) {
        if (!b.media_url) { upd.media_url = null; upd.media_type = null; }
        else { const u = clip(b.media_url, 600); if (!u || !/^https:\/\//i.test(u)) return res.status(400).json({ error: 'media_url must be an https link' }); upd.media_url = u; upd.media_type = b.media_type === 'video' ? 'video' : 'image'; }
      }
      if (b.metrics !== undefined) {
        const m = {}; for (const k of METRIC_KEYS) { if (b.metrics && b.metrics[k] !== undefined && b.metrics[k] !== '') { const n = Number(b.metrics[k]); if (!Number.isFinite(n) || n < 0 || n > 1e9) return res.status(400).json({ error: k + ' must be a non-negative number' }); m[k] = Math.round(n); } }
        upd.metrics = m; upd.metrics_updated_at = new Date().toISOString();
      }
      if (b.scheduled_for !== undefined) {
        if (b.scheduled_for === null) upd.scheduled_for = null;
        else { const d = new Date(b.scheduled_for); if (isNaN(d)) return res.status(400).json({ error: 'Invalid scheduled_for' }); upd.scheduled_for = d.toISOString(); }
      }
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const { error } = await db.from('gx_content_items').update(upd).eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/marketing/content/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const { error } = await db.from('gx_content_items').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // ---- Insights: which posts performed, why that may be, and what to make next ----
  const goalOf = (it) => (it.context && it.context.goal) || 'customer_acquisition';
  const lengthBucket = (t) => (String(t || '').length < 220 ? 'short (under 220 characters)' : 'long (220+ characters)');
  function groupBy(items, keyFn) {
    const g = {};
    items.forEach((it) => { const k = keyFn(it); if (!g[k]) g[k] = { posts: 0, total: 0 }; g[k].posts++; g[k].total += it._s.score; });
    return Object.keys(g).map((k) => ({ label: k, posts: g[k].posts, avg_score: Math.round(g[k].total / g[k].posts) })).sort((a, b) => b.avg_score - a.avg_score);
  }
  async function loadScored(goal, days, platform) {
    const since = new Date(Date.now() - (days || 90) * 86400000).toISOString();
    let q = db.from('gx_content_items').select('*').eq('status', 'published').gte('created_at', since).limit(500);
    if (platform) q = q.eq('platform', platform);
    const { data, error } = await q; if (error) throw error;
    return (data || []).filter((it) => hasMetrics(it.metrics) && (!goal || goalOf(it) === goal)).map((it) => Object.assign(it, { _s: scoreOf(it.metrics) }));
  }
  router.get('/marketing/insights', limiter(60 * 1000, 8), async (req, res) => {
    try {
      const goal = GOALS.includes(req.query.goal) ? req.query.goal : null;
      const days = Math.min(Math.max(parseInt(req.query.days) || 90, 7), 365);
      const items = await loadScored(goal, days);
      const brief = (it) => ({ id: it.id, title: it.title, platform: it.platform, kind: it.kind, media: it.media_type || 'none', goal: goalOf(it), posted: it.published_at, url: it.published_url, metrics: it.metrics, score: it._s.score, text: String(it.body || '').slice(0, 420) });
      const ranked = items.slice().sort((a, b) => b._s.score - a._s.score);
      const groups = {
        by_platform: groupBy(items, (i) => i.platform || 'unknown'),
        by_format: groupBy(items, (i) => (i.media_type === 'video' ? 'video' : (i.media_type === 'image' ? 'photo' : 'text only'))),
        by_kind: groupBy(items, (i) => i.kind),
        by_goal: groupBy(items, (i) => goalOf(i)),
        by_length: groupBy(items, (i) => lengthBucket(i.body)),
        by_hashtag_use: groupBy(items, (i) => (i.hashtags && String(i.hashtags).trim() ? 'with hashtags' : 'no hashtags')),
      };
      const out = {
        days, goal, posts_analysed: items.length, scoring: 'Score = interactions per 1,000 people reached (likes + 2x comments + 3x shares + 2x saves + 2x link clicks), or the raw interaction total when reach/views were not entered.',
        top: ranked.slice(0, 5).map(brief), bottom: ranked.length > 5 ? ranked.slice(-3).reverse().map(brief) : [], groups, advice: null, note: null,
      };
      if (items.length < 5) out.note = 'Only ' + items.length + ' published post(s) have numbers so far. Record the numbers for at least 5 to 10 posts for advice you can rely on.';
      if (!items.length) return res.json(out);
      if (!process.env.ANTHROPIC_API_KEY) { out.note = (out.note ? out.note + ' ' : '') + 'AI advice is off (ANTHROPIC_API_KEY missing); the rankings above are still accurate.'; return res.json(out); }
      const [camps, sessions, leads] = await Promise.all([
        fetchAll(() => db.from('gx_campaigns').select('id, name, utm_campaign, goal')),
        fetchAll(() => db.from('gx_attribution').select('utm_campaign, profile_id').not('utm_campaign', 'is', null)),
        fetchAll(() => db.from('gx_leads').select('utm_campaign').not('utm_campaign', 'is', null)),
      ]);
      const campaigns = camps.map((c) => { const s = sessions.filter((x) => x.utm_campaign === c.utm_campaign); return { name: c.name, goal: c.goal, visits: s.length, signups: s.filter((x) => x.profile_id).length, leads: leads.filter((x) => x.utm_campaign === c.utm_campaign).length }; }).filter((c) => c.visits || c.leads);
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const system = [
        'You are a marketing analyst for GetHome, a Nigerian property marketplace. Two goals: customer_acquisition (property seekers) and agent_recruitment (agents and agencies).',
        'Use ONLY the data supplied. Never invent numbers. Explain WHY a post may have worked as a hypothesis based on its format, hook, length, platform and content, and say so plainly when the sample is too small (under about 8 posts) to be sure.',
        'Be specific and practical for a small team posting by hand. Return ONLY JSON with keys: "summary" (2-3 sentences), "what_worked" (array of strings), "what_did_not" (array of strings), "why" (array of strings), "do_next" (array of 4-6 concrete actions), "ideas" (object with arrays "customer_acquisition" and "agent_recruitment", each 3 objects {"platform","format","hook","idea"}).',
        'Never suggest invented prices, statistics, testimonials or guarantees in the ideas.',
      ].join('\n');
      const resp = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 2200, system, messages: [{ role: 'user', content: JSON.stringify({ scoring: out.scoring, posts_analysed: items.length, groups, top_posts: out.top, weakest_posts: out.bottom, campaign_results_from_tracked_links: campaigns }) }] });
      const text = (resp.content && resp.content[0] && resp.content[0].text) || '';
      const m = text.match(/\{[\s\S]*\}/); try { out.advice = m ? JSON.parse(m[0]) : null; } catch (e) { out.advice = null; }
      if (!out.advice) out.note = (out.note ? out.note + ' ' : '') + 'The AI advice could not be read this time. Try again.';
      res.json(out);
    } catch (e) { console.error('[marketing/insights]', e.message); res.status(500).json({ error: 'Insights failed' }); }
  });

  // ---- AI generation, grounded in real listings. Always saved as drafts for a human to approve. ----
  async function listingFacts(city, purpose) {
    let q = db.from('properties').select('title, location, purpose, property_type, bedrooms, rent, price, cost_per_night, currency_symbol')
      .or('is_deleted.eq.false,is_deleted.is.null').or('is_sold.eq.false,is_sold.is.null').limit(1000);
    if (PURPOSE_TAB[purpose]) q = q.eq('purpose', purpose);
    const { data } = await q;
    let rows = data || [];
    if (city) rows = rows.filter((p) => matchesCity(p.location, city));
    const priceOf = (p) => (p.purpose === 'shortlet' ? p.cost_per_night : (p.purpose === 'sale' ? (p.price || p.rent) : (p.rent || p.price)));
    const prices = rows.map(priceOf).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    const types = {}; rows.forEach((p) => { if (p.property_type) types[p.property_type] = (types[p.property_type] || 0) + 1; });
    const areas = {}; rows.forEach((p) => { if (p.location) areas[p.location] = (areas[p.location] || 0) + 1; });
    return {
      listing_count: rows.length,
      price_min_naira: prices[0] || null, price_max_naira: prices[prices.length - 1] || null,
      property_types: types, example_areas: Object.keys(areas).slice(0, 6),
    };
  }

  function trackedLink(platform, campaign, city, purpose) {
    const p = new URLSearchParams();
    if (PURPOSE_TAB[purpose]) p.set('tab', PURPOSE_TAB[purpose]);
    if (city) p.set('city', city);
    p.set('utm_source', platform || 'social');
    p.set('utm_medium', platform === 'google_ads' ? 'cpc' : (platform === 'whatsapp' ? 'whatsapp' : (platform === 'email' ? 'email' : 'social')));
    if (campaign) p.set('utm_campaign', campaign.utm_campaign);
    return SITE + '/?' + p.toString();
  }

  const KIND_SPEC = {
    social_post: 'a short social media post (max 90 words), warm and conversational, ending with a clear call to action and the link',
    video_script: 'a 30 to 45 second vertical video script: a hook in the first 3 seconds, then scenes with "VISUAL:" and "VOICEOVER:" lines, ending with a call to action. Only describe visuals that are generic (street scenes, a phone showing the GetHome app); never claim specific footage of listings',
    ad_copy: 'search/social ad copy: a headline (max 30 characters), a second headline (max 30 characters) and a description (max 90 characters). Put them on separate lines labelled Headline 1, Headline 2, Description',
    whatsapp_broadcast: 'a WhatsApp broadcast message (max 70 words), friendly, with the link on its own line. No more than one emoji',
    email: 'a short marketing email: a subject line prefixed "Subject:", then a body of under 120 words with the link',
    seo_blurb: 'a 60-80 word descriptive paragraph for a location landing page; informative, no hype, no link',
  };

  router.post('/marketing/generate', limiter(60 * 1000, 6), async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' });
      const b = req.body || {};
      if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'kind must be one of ' + KINDS.join(', ') });
      const platform = PLATFORMS.includes(b.platform) ? b.platform : null;
      const count = Math.min(Math.max(parseInt(b.count) || 3, 1), 5);
      const city = clip(b.city, 60), purpose = PURPOSE_TAB[b.purpose] ? b.purpose : null;
      const topic = clip(b.topic, 300), audience = clip(b.audience, 100);
      const goal = GOALS.includes(b.goal) ? b.goal : 'customer_acquisition';

      const startDay = new Date(); startDay.setUTCHours(0, 0, 0, 0);
      const { count: today } = await db.from('gx_content_items').select('id', { count: 'exact', head: true }).eq('generated_by', 'ai').gte('created_at', startDay.toISOString());
      if ((today || 0) + count > DAILY_AI_ITEM_CAP) return res.status(429).json({ error: 'Daily AI generation cap (' + DAILY_AI_ITEM_CAP + ' items) reached.' });

      let campaign = null;
      if (isUuid(b.campaign_id)) { const { data } = await db.from('gx_campaigns').select('*').eq('id', b.campaign_id).maybeSingle(); campaign = data || null; }
      const facts = goal === 'agent_recruitment' ? null : await listingFacts(city, purpose);
      let learned = [];
      try { learned = (await loadScored(goal, 180, platform)).sort((a, b) => b._s.score - a._s.score).slice(0, 3).map((it) => ({ format: it.media_type || 'text only', score: it._s.score, text: String(it.body || '').slice(0, 350) })); } catch (e) { learned = []; }
      const link = goal === 'agent_recruitment' && !campaign ? SITE + '/' : trackedLink(platform, campaign, city, purpose);

      const system = [
        'You write marketing copy for GetHome Realestate Ltd, a Nigerian property marketplace that connects property seekers with verified real estate agents and agencies.',
        'Write in clear, friendly Nigerian English. Naira amounts use the ₦ sign.',
        'STRICT RULES: use only the FACTS provided. Never invent prices, listing counts, statistics, testimonials, awards, user numbers, guarantees or legal/financial promises. If a figure is not in FACTS, do not mention it.',
        'You may state these platform truths: properties are physically inspected by verified agents; fees are shown up front; inspections can be booked on the platform; verified agents and agencies can list properties.',
        'Do not use hashtags unless the kind is social_post; then add 3 to 5 relevant ones. Do not use misleading urgency.',
        'Return ONLY a JSON array of ' + count + ' objects with keys "title" (short internal label), "body", "hashtags" (string, may be empty). No prose outside the JSON.',
      ].join('\n');
      const userMsg = 'Write ' + count + ' different variations of ' + KIND_SPEC[b.kind] + '.\n' + JSON.stringify({
        goal, platform, audience: audience || (goal === 'agent_recruitment' ? 'real estate agents and agencies in Nigeria' : 'property seekers in Nigeria'),
        topic: topic || null, location: city || null, purpose: purpose || null,
        link_to_include: b.kind === 'seo_blurb' ? null : link, FACTS: facts,
        campaign: campaign ? { name: campaign.name, goal: campaign.goal } : null,
        past_best_performers: learned.length ? learned : undefined,
        past_best_performers_note: learned.length ? 'Style reference only: these posts did well for this goal. Match what made them work (tone, hook, structure). Do not copy them, and do not reuse any figures or claims from them.' : undefined,
      });

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] });
      const text = (resp.content && resp.content[0] && resp.content[0].text) || '';
      const m = text.match(/\[[\s\S]*\]/);
      let items; try { items = m ? JSON.parse(m[0]) : null; } catch (e) { items = null; }
      if (!Array.isArray(items) || !items.length) return res.status(502).json({ error: 'The AI returned an unreadable response. Try again.' });

      const rows = items.slice(0, count).map((it) => ({
        campaign_id: campaign ? campaign.id : null, kind: b.kind, platform, title: clip(it && it.title, 160), body: clip(it && it.body, 6000) || '',
        hashtags: clip(it && it.hashtags, 300), link_url: b.kind === 'seo_blurb' ? null : link, status: 'draft', generated_by: 'ai',
        context: { facts, city, purpose, topic, goal }, created_by: req.admin.email || req.admin.id,
      })).filter((r) => r.body);
      if (!rows.length) return res.status(502).json({ error: 'The AI returned empty content. Try again.' });
      const { data, error } = await db.from('gx_content_items').insert(rows).select();
      if (error) return res.status(500).json({ error: error.message });
      res.json({ items: data, facts_used: facts, note: 'Saved as drafts. Review every claim before approving and posting.' });
    } catch (e) { console.error('[marketing/generate]', e.message); res.status(500).json({ error: 'Generation failed' }); }
  });

  app.use('/api/growth', router);
};
