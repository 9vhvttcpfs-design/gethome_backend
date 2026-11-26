// Marketing: linked social accounts, hashtags and one-click publishing.
// Facebook Pages and Instagram professional accounts are posted to through Meta's official Graph API. The Page access
// token is encrypted before it is stored and is never sent back to the page. Other platforms are posted by hand.
'use strict';
const crypto = require('crypto');
const { limiter } = require('../middleware/security');

const KEY = 'social_accounts';
const LINK_KEYS = ['facebook', 'instagram', 'tiktok', 'x', 'youtube'];
// Instagram and TikTok cap hashtags at 5; fewer read better on Facebook and X.
const TAG_LIMIT = { instagram: 5, tiktok: 5, facebook: 3, x: 2, youtube: 3, whatsapp: 0 };
const PLACES = ['Abuja', 'Lagos', 'Port Harcourt', 'Ibadan', 'Enugu', 'Kano', 'Kaduna', 'Benin City', 'Asaba', 'Owerri', 'Uyo', 'Calabar', 'Abeokuta', 'Ilorin', 'Jos', 'Akure', 'Awka', 'Warri', 'Lekki', 'Ikeja', 'Ajah', 'Yaba', 'Surulere', 'Ikoyi', 'Gwarinpa', 'Wuse', 'Maitama', 'Kubwa', 'Lugbe'];

const clip = (v, n) => { if (v == null) return ''; return String(v).trim().slice(0, n); };
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const compact = (s) => String(s || '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

// ---------- hashtags ----------
const tagsIn = (s) => String(s || '').match(/#[A-Za-z0-9_]+/g) || [];
function cleanTags(input) {
  const words = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const seen = new Set(), out = [];
  words.forEach((w) => {
    const t = String(w).replace(/[^A-Za-z0-9_]/g, '');
    if (t.length < 2 || t.length > 40 || /^\d+$/.test(t) || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase()); out.push('#' + t);
  });
  return out;
}

// Tags taken only from what the post is about: its place, what is offered and who it is for.
function ruleTags(o) {
  const text = String(o.text || '').replace(/https?:\/\/\S+/g, ' ');
  const place = compact(o.city) || compact(PLACES.find((p) => new RegExp('\\b' + p + '\\b', 'i').test(text)));
  const agent = o.goal === 'agent_recruitment';
  const says = (re) => re.test(text);
  const out = [];
  if (place) out.push(place + 'RealEstate');
  if (agent) out.push('NigeriaRealtors', 'RealEstateAgent');
  else {
    if (o.purpose === 'shortlet' || says(/short[- ]?let/i)) out.push(place ? place + 'Shortlet' : 'ShortletNigeria');
    if (says(/\bland\b|\bplots?\b/i)) out.push('LandForSale');
    else if (o.purpose === 'sale' || says(/for sale|\bbuy(ing)?\b/i)) out.push('HouseForSale');
    if (o.purpose === 'rent' || says(/\brent(al|ing)?\b/i)) out.push('HouseForRent');
    if (place) out.push(place + 'Properties');
  }
  out.push('NigeriaRealEstate', 'GetHome');
  return cleanTags(out);
}

// Preferred tags first, topped up from the rules, with the brand tag always kept.
function finalTags(preferred, rules, platform) {
  const max = TAG_LIMIT[platform] === undefined ? 5 : TAG_LIMIT[platform];
  if (!max) return '';
  const all = cleanTags(preferred.concat(rules)).filter((t) => t.toLowerCase() !== '#gethome');
  return all.slice(0, max - 1).concat('#GetHome').join(' ');
}

// A tag naming a town the post never mentions would be wrong, so those are dropped.
function onTopic(tags, o) {
  const about = compact(o.city).toLowerCase() + ' ' + String(o.text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return tags.filter((t) => PLACES.every((p) => { const k = compact(p).toLowerCase(); return !t.toLowerCase().includes(k) || about.includes(k); }));
}

async function aiTags(o) {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 200,
      system: 'You choose hashtags for GetHome, a Nigerian property marketplace. Pick only hashtags that describe what this caption actually says: its location, property type, offer and audience. Prefer tags Nigerians really search. Never name a place, property type, price or claim that is not in the caption or details. Return ONLY a JSON array of up to 6 strings.',
      messages: [{ role: 'user', content: JSON.stringify({ caption: clip(o.text, 2000), location: o.city || null, purpose: o.purpose || null, audience: o.goal === 'agent_recruitment' ? 'real estate agents' : 'property seekers' }) }],
    });
    const m = ((resp.content && resp.content[0] && resp.content[0].text) || '').match(/\[[\s\S]*?\]/);
    return m ? onTopic(cleanTags(JSON.parse(m[0])), o) : [];
  } catch (e) { console.error('[social/hashtags]', e.message); return []; }
}

async function suggestHashtags(o) { return finalTags(await aiTags(o), ruleTags(o), o.platform); }

// Caption plus whichever hashtags it does not already contain.
function composeCaption(body, hashtags) {
  const have = new Set(tagsIn(body).map((t) => t.toLowerCase()));
  const add = cleanTags(hashtags).filter((t) => !have.has(t.toLowerCase()));
  return String(body || '').trim() + (add.length ? '\n\n' + add.join(' ') : '');
}

// ---------- token storage ----------
function cryptoKey() {
  const secret = process.env.GROWTH_SIGNING_SECRET || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return secret ? crypto.createHash('sha256').update('gx-social:' + secret).digest() : null;
}
function encrypt(text) {
  const key = cryptoKey(); if (!key) throw new Error('Set GROWTH_SIGNING_SECRET on the server before linking accounts.');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(stored) {
  try {
    const [iv, tag, data] = String(stored).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

function mountSocial(router, db, deps) {
  deps = deps || {};
  const doFetch = (u, o) => (deps.fetchImpl || fetch)(u, o);
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graphBase = () => 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
  const busy = new Set();

  async function graph(method, path, token, params) {
    const qs = new URLSearchParams(params || {}).toString();
    const url = graphBase() + path + (method === 'GET' && qs ? '?' + qs : '');
    const r = await doFetch(url, { method, headers: Object.assign({ Authorization: 'Bearer ' + token }, method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), body: method === 'POST' ? qs : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || ('HTTP ' + r.status));
    return j;
  }

  async function load() {
    const { data, error } = await db.from('gx_settings').select('value').eq('key', KEY).maybeSingle();
    if (error) throw error;
    return (data && data.value) || {};
  }
  async function save(value, actor) {
    const { error } = await db.from('gx_settings').upsert([{ key: KEY, value, updated_by: actor, updated_at: new Date().toISOString() }], { onConflict: 'key' });
    if (error) throw error;
  }
  const publicView = (a) => {
    const ok = !!(a.meta && decrypt(a.meta.token));
    return {
      facebook: { connected: ok, page_id: (a.meta && a.meta.page_id) || '', page_name: (a.meta && a.meta.page_name) || '' },
      instagram: { connected: ok && !!a.meta.ig_id, username: (a.meta && a.meta.ig_username) || '' },
      links: a.links || {},
    };
  };
  const actorOf = (req) => (req.admin && (req.admin.email || req.admin.id)) || 'unknown';

  router.get('/marketing/social/accounts', async (req, res) => {
    try { res.json(publicView(await load())); } catch (e) { console.error('[social/accounts]', e.message); res.status(500).json({ error: 'Could not read the linked accounts. Has the outreach database script been run?' }); }
  });

  router.put('/marketing/social/accounts', limiter(60 * 1000, 20), async (req, res) => {
    try {
      const b = req.body || {}, a = await load();
      if (b.links !== undefined) {
        const links = {};
        for (const k of LINK_KEYS) {
          const v = clip(b.links && b.links[k], 300);
          if (!v) continue;
          if (!/^https:\/\/\S+$/i.test(v)) return res.status(400).json({ error: 'The ' + k + ' link must start with https://' });
          links[k] = v;
        }
        a.links = links;
      }
      const pageId = clip(b.page_id, 40), given = clip(b.access_token, 1000);
      if (pageId || given) {
        if (!/^\d{5,25}$/.test(pageId)) return res.status(400).json({ error: 'The Facebook Page ID is a number, found under your Page\'s About details.' });
        const token = given || (a.meta && a.meta.page_id === pageId ? decrypt(a.meta.token) : null);
        if (!token) return res.status(400).json({ error: 'Paste the access token for this Page.' });
        let page;
        try { page = await graph('GET', '/' + pageId, token, { fields: 'name,access_token,instagram_business_account{id,username}' }); }
        catch (e) { return res.status(400).json({ error: 'Facebook did not accept these details: ' + e.message }); }
        const ig = page.instagram_business_account || {};
        // A user or system-user token is swapped for the Page's own token, which is what posting needs.
        a.meta = { page_id: pageId, page_name: page.name || '', ig_id: ig.id || null, ig_username: ig.username || '', token: encrypt(page.access_token || token) };
      }
      await save(a, actorOf(req));
      res.json(publicView(a));
    } catch (e) { console.error('[social/accounts]', e.message); res.status(500).json({ error: e.message }); }
  });

  router.delete('/marketing/social/accounts/meta', async (req, res) => {
    try { const a = await load(); delete a.meta; await save(a, actorOf(req)); res.json(publicView(a)); }
    catch (e) { console.error('[social/disconnect]', e.message); res.status(500).json({ error: 'Could not disconnect' }); }
  });

  router.post('/marketing/hashtags', limiter(60 * 1000, 20), async (req, res) => {
    try {
      const b = req.body || {}, text = clip(b.text, 6000);
      if (!text) return res.status(400).json({ error: 'Write the caption first' });
      res.json({ hashtags: await suggestHashtags({ text, platform: clip(b.platform, 20), city: clip(b.city, 60), purpose: clip(b.purpose, 20), goal: clip(b.goal, 40) }) });
    } catch (e) { console.error('[social/hashtags]', e.message); res.status(500).json({ error: 'Could not create hashtags' }); }
  });

  async function toFacebook(meta, token, item, caption) {
    let id;
    if (item.media_url && item.media_type === 'video') id = (await graph('POST', '/' + meta.page_id + '/videos', token, { file_url: item.media_url, description: caption })).id;
    else if (item.media_url) { const j = await graph('POST', '/' + meta.page_id + '/photos', token, { url: item.media_url, caption }); id = j.post_id || j.id; }
    else id = (await graph('POST', '/' + meta.page_id + '/feed', token, Object.assign({ message: caption }, item.link_url ? { link: item.link_url } : {}))).id;
    return { id, url: 'https://www.facebook.com/' + id };
  }

  // Instagram takes the file first, processes it, then publishes. A long video may need a second click.
  async function toInstagram(meta, token, item, caption, pendingId) {
    let container = pendingId;
    if (!container) {
      const params = item.media_type === 'video' ? { media_type: 'REELS', video_url: item.media_url, caption } : { image_url: item.media_url, caption };
      container = (await graph('POST', '/' + meta.ig_id + '/media', token, params)).id;
    }
    let status = '';
    for (let i = 0; i < 20; i++) {
      status = (await graph('GET', '/' + container, token, { fields: 'status_code' })).status_code;
      if (status === 'FINISHED' || status === 'ERROR' || status === 'EXPIRED') break;
      await sleep(3000);
    }
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error('Instagram could not process this file. Check the video or photo format and size.');
    if (status !== 'FINISHED') return { pending: container };
    const id = (await graph('POST', '/' + meta.ig_id + '/media_publish', token, { creation_id: container })).id;
    let url = null;
    try { url = (await graph('GET', '/' + id, token, { fields: 'permalink' })).permalink || null; } catch (e) { /* the post is live even without its link */ }
    return { id, url };
  }

  router.post('/marketing/content/:id/publish', limiter(60 * 1000, 12), async (req, res) => {
    const b = req.body || {}, platform = b.platform, lock = req.params.id + ':' + platform;
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    if (platform !== 'facebook' && platform !== 'instagram') return res.status(400).json({ error: 'Direct posting works for Facebook and Instagram' });
    if (busy.has(lock)) return res.status(409).json({ error: 'This post is already being sent' });
    busy.add(lock);
    try {
      const { data: item } = await db.from('gx_content_items').select('*').eq('id', req.params.id).maybeSingle();
      if (!item) return res.status(404).json({ error: 'Not found' });
      if (item.status === 'rejected') return res.status(409).json({ error: 'This item is marked rejected. Change its status first.' });
      const context = item.context || {}, posts = context.posts || {};
      if (posts[platform] && b.again !== true) return res.status(409).json({ error: 'Already posted to ' + platform });

      const a = await load(), token = a.meta && decrypt(a.meta.token);
      if (!token) return res.status(409).json({ error: 'Link your Facebook Page first, under Linked social accounts.' });
      if (platform === 'instagram' && !a.meta.ig_id) return res.status(409).json({ error: 'No Instagram professional account is connected to that Facebook Page.' });
      if (platform === 'instagram' && !item.media_url) return res.status(400).json({ error: 'Instagram needs a photo or video. Attach one first.' });
      if (platform === 'instagram' && item.media_type !== 'video' && !/\.jpe?g(\?|$)/i.test(item.media_url)) return res.status(400).json({ error: 'Instagram only accepts JPG photos. Attach the photo again and it is converted for you.' });

      const body = clip(b.caption === undefined ? item.body : b.caption, 6000);
      if (!body) return res.status(400).json({ error: 'The caption is empty' });
      let hashtags = clip(b.hashtags === undefined ? item.hashtags : b.hashtags, 300);
      if (!hashtags && !tagsIn(body).length) hashtags = await suggestHashtags({ text: body, platform, city: context.city, purpose: context.purpose, goal: context.goal });
      const caption = composeCaption(body, hashtags);
      if (platform === 'instagram' && caption.length > 2200) return res.status(400).json({ error: 'Instagram captions are limited to 2,200 characters' });

      const pending = context.ig_pending && context.ig_pending.media_url === item.media_url && context.ig_pending.caption === caption ? context.ig_pending.id : null;
      let out;
      try { out = platform === 'facebook' ? await toFacebook(a.meta, token, item, caption) : await toInstagram(a.meta, token, item, caption, pending); }
      catch (e) { return res.status(502).json({ error: platform + ' refused the post: ' + e.message }); }

      if (out.pending) {
        await db.from('gx_content_items').update({ context: Object.assign({}, context, { ig_pending: { id: out.pending, media_url: item.media_url, caption } }) }).eq('id', item.id);
        return res.json({ pending: true, hashtags, message: 'Instagram is still processing the video. Press Post to Instagram again in a minute.' });
      }
      // Re-read so that posting to Facebook and Instagram close together keeps both records.
      const { data: fresh } = await db.from('gx_content_items').select('context, published_url, published_at').eq('id', item.id).maybeSingle();
      const next = Object.assign({}, (fresh && fresh.context) || context);
      if (platform === 'instagram') delete next.ig_pending;
      next.posts = Object.assign({}, next.posts, { [platform]: { id: out.id, url: out.url, at: new Date().toISOString() } });
      const upd = { body, hashtags: hashtags || null, status: 'published', context: next, published_at: (fresh && fresh.published_at) || new Date().toISOString(), published_url: (fresh && fresh.published_url) || out.url };
      if (!item.platform) upd.platform = platform;
      const { error } = await db.from('gx_content_items').update(upd).eq('id', item.id);
      if (error) console.error('[social/publish] posted but not recorded:', error.message);
      res.json({ posted: true, url: out.url, hashtags, published_url: upd.published_url });
    } catch (e) { console.error('[social/publish]', e.message); res.status(500).json({ error: 'Posting failed' }); }
    finally { busy.delete(lock); }
  });
}

module.exports = mountSocial;
Object.assign(module.exports, { SETTINGS_KEY: KEY, cleanTags, ruleTags, finalTags, onTopic, suggestHashtags, composeCaption, encrypt, decrypt });
