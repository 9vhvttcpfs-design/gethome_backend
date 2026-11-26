// Outreach Command Centre, phase 2: prospect discovery.
// Source adapters (OpenStreetMap/Overpass, public agency websites, CSV, future providers) all return the same
// candidate shape and go through one ingestion path (normalise, de-duplicate, store source + contacts).
// Jobs run on demand from the admin page (no background worker), in bounded batches.
// Compliance: public data only; robots.txt respected; no scraping of Google Maps or directories whose terms forbid it;
// discovered contact details do NOT grant permission to market (see consent.js).
'use strict';
const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');
const D = require('./dedupe');
const C = require('./consent');
const P = require('./places');
const Web = require('./websearch');

const OUR_UA_TOKEN = 'gethomeoutreach';
const USER_AGENT = process.env.OSM_USER_AGENT || 'GetHomeOutreach/1.0 (+https://trygethome.online)';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const NAME_OK = /^[A-Za-z .'\-]{2,60}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (v, n) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; };
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

// ---------- network helpers ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.'); }
  return true;
}

// Rejects anything that is not a public web host (localhost, private ranges, cloud metadata addresses).
async function assertPublicUrl(url, lookup) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Private host blocked');
  const addrs = net.isIP(host) ? [{ address: host }] : await (lookup || ((h) => dns.lookup(h, { all: true })))(host);
  if (!addrs || !addrs.length) throw new Error('Host does not resolve');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private address blocked');
  return u;
}

async function readLimited(res, maxBytes) {
  if (!res.body || !res.body.getReader) { const t = await res.text(); return t.slice(0, maxBytes); }
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; chunks.push(Buffer.from(value)); if (n >= maxBytes) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; } }
  return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
}

// Fetch with timeout, retries (network errors, 429, 5xx, honouring Retry-After) and SSRF-safe manual redirects.
async function safeFetch(url, opts, deps) {
  const d = Object.assign({ fetchImpl: fetch, lookup: null, retries: 2, timeoutMs: 15000, maxBytes: 500000, maxRedirects: 3, sleepImpl: sleep }, deps || {});
  let attempt = 0, current = url, redirects = 0;
  for (;;) {
    await assertPublicUrl(current, d.lookup);
    let res;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), d.timeoutMs);
      res = await d.fetchImpl(current, Object.assign({ redirect: 'manual', signal: ctl.signal, headers: Object.assign({ 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.5' }, (opts && opts.headers) || {}) }, opts && opts.method ? { method: opts.method, body: opts.body } : {}));
      clearTimeout(t);
    } catch (e) {
      if (attempt++ < d.retries) { await d.sleepImpl(500 * attempt); continue; }
      throw new Error('Network error: ' + e.message);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (redirects++ >= d.maxRedirects) throw new Error('Too many redirects');
      current = new URL(res.headers.get('location'), current).toString(); continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt++ < d.retries) {
      const ra = parseInt(res.headers.get('retry-after'), 10);
      await d.sleepImpl(Math.min((ra > 0 ? ra * 1000 : 1000 * attempt), 8000)); continue;
    }
    const text = await readLimited(res, d.maxBytes);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text, contentType: res.headers.get('content-type') || '', url: current };
  }
}

// ---------- robots.txt ----------
function parseRobots(text) {
  const groups = []; let cur = null, lastWasUA = false;
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*/, '').trim(); if (!line) return;
    const i = line.indexOf(':'); if (i < 0) return;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasUA = true; }
    else if ((k === 'allow' || k === 'disallow') && cur) { lastWasUA = false; if (v) cur.rules.push({ allow: k === 'allow', pattern: v }); else if (k === 'disallow') { /* empty disallow = allow all */ } }
    else lastWasUA = false;
  });
  const mine = groups.filter((g) => g.agents.some((a) => a === OUR_UA_TOKEN));
  const star = groups.filter((g) => g.agents.includes('*'));
  const rules = (mine.length ? mine : star).flatMap((g) => g.rules);
  const toRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return {
    allowed(path) {
      let best = null;
      for (const r of rules) { if (toRe(r.pattern).test(path)) { if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r; } }
      return !best || best.allow;
    },
  };
}

// ---------- HTML extraction (public business contact details only) ----------
const JUNK_EMAIL = /(\.(png|jpe?g|gif|webp|svg|css|js)$)|(^(example|user|name|email|your|test)@)|(@(example\.|sentry|wixpress|domain\.com|email\.com|yourdomain))/i;
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16); let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function extractFromHtml(html, baseUrl) {
  const h = String(html || '');
  const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const emails = new Set(), phones = new Set();
  (text.match(/data-cfemail="[0-9a-f]+"/gi) || []).forEach((m) => { const e = D.normEmail(decodeCfEmail(m.slice(14, -1))); if (e && !JUNK_EMAIL.test(e)) emails.add(e); });
  (text.match(/mailto:([^"'?\s>]+)/gi) || []).forEach((m) => { const e = D.normEmail(decodeURIComponent(m.slice(7))); if (e && !JUNK_EMAIL.test(e)) emails.add(e); });
  (text.replace(/<[^>]+>/g, ' ').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((m) => { const e = D.normEmail(m); if (e && !JUNK_EMAIL.test(e)) emails.add(e); });
  (text.match(/tel:([+\d\s().-]{7,20})/gi) || []).forEach((m) => { const p = D.normPhone(m.slice(4)); if (p) phones.add(p); });
  (text.replace(/<[^>]+>/g, ' ').match(/(?:\+?234[\s-]?|0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}/g) || []).forEach((m) => { const p = D.normPhone(m); if (p) phones.add(p); });
  const og = (h.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const name = clip(og || (title ? title.split(/[|–—-]/)[0] : null), 160);
  const links = [];
  (h.match(/<a\s[^>]*href=["']([^"'#]+)["']/gi) || []).forEach((a) => { const href = (a.match(/href=["']([^"'#]+)["']/i) || [])[1]; if (!href || /^(mailto|tel|javascript):/i.test(href)) return; try { const u = new URL(href, baseUrl); if (/contact|about/i.test(u.pathname) && u.origin === new URL(baseUrl).origin) links.push(u.toString()); } catch (e) { /* skip */ } });
  return { emails: [...emails].slice(0, 5), phones: [...phones].slice(0, 5), name: name ? name.replace(/\s+/g, ' ').trim() : null, links: [...new Set(links)].slice(0, 2) };
}

// ---------- adapters ----------
// Every adapter: { id, label, description, limits, async run(ctx) -> { items, notes, done } }
const adapters = {};
function registerAdapter(a) { adapters[a.id] = a; }

// Reads up to 3 public pages (home, contact, about) of one business website, obeying robots.txt.
async function crawlSite(spec, ctx) {
  const notes = [];
  const home = D.cleanUrl(spec.url);
  if (!home) return { item: null, notes: ['Skipped an invalid URL'] };
  try {
    const origin = new URL(home).origin;
    let robots = parseRobots('');
    try { const r = await safeFetch(origin + '/robots.txt', {}, ctx.net); if (r.status >= 500) throw new Error('robots unavailable'); if (r.ok) robots = parseRobots(r.text); } catch (e) { return { item: null, notes: [origin + ': robots.txt unavailable, skipped to be safe'] }; }
    const pages = [home]; const seen = new Set(); const emails = [], phones = []; let name = spec.name || null;
    while (pages.length && seen.size < 3) {
      const pageUrl = pages.shift(); if (seen.has(pageUrl)) continue; seen.add(pageUrl);
      if (!robots.allowed(new URL(pageUrl).pathname)) { notes.push(pageUrl + ': disallowed by robots.txt'); continue; }
      if (seen.size > 1) await (ctx.sleep || sleep)(1000);
      const r = await safeFetch(pageUrl, {}, ctx.net);
      if (!r.ok || !/html/i.test(r.contentType)) continue;
      const x = extractFromHtml(r.text, r.url);
      if (!name) name = x.name;
      x.emails.forEach((e) => emails.push({ channel: 'email', value: e, source_url: pageUrl }));
      x.phones.forEach((p) => phones.push({ channel: 'phone', value: p, source_url: pageUrl }));
      x.links.forEach((l) => { if (!seen.has(l)) pages.push(l); });
    }
    if (!name) return { item: null, notes: notes.concat(home + ': no business name found; add one when listing the URL') };
    return { item: { name, category: spec.category || (ctx.target === 'agent' ? 'independent_agent' : 'established_agency'), state: spec.state || ctx.state, city: spec.city || ctx.city, website: home, source_url: home, contacts: emails.concat(phones), raw: { pages_read: [...seen] } }, notes };
  } catch (e) { return { item: null, notes: notes.concat(home + ': ' + e.message) }; }
}

// Different businesses are read at the same time; pages of one site are still read one per second.
async function crawlMany(specs, ctx) {
  const out = await Promise.all(specs.map((s) => crawlSite(typeof s === 'string' ? { url: s } : (s || {}), ctx)));
  return { items: out.map((o) => o.item).filter(Boolean), notes: out.reduce((a, o) => a.concat(o.notes), []) };
}

const WEB_BATCH = 8, WEB_MAX_ROUNDS = 4;
registerAdapter({
  id: 'web', label: 'Search the web (recommended)',
  description: "Searches the web for real estate agencies and agents in the state you choose, then reads each website's public contact pages for business emails and phone numbers. No website list needed.",
  limits: 'Each search round uses your Anthropic API credit. Property portals and social networks are left out. Obeys robots.txt.',
  async run(ctx) {
    const prev = ctx.params || {};
    let queue = Array.isArray(prev.queue) ? prev.queue : [];
    let round = Number(prev.round) || 0, found = null;
    const seen = new Set((Array.isArray(prev.seen) ? prev.seen : []).concat(ctx.knownDomains || []));
    if (!queue.length) {
      if (!ctx.state && !ctx.city) throw new Error('Choose a state');
      const r = await (ctx.search || Web.searchAgencies)({ state: ctx.state || ctx.city, city: ctx.state ? ctx.city : null, target: ctx.target, round, exclude: seen });
      queue = r.sites; round++; found = r.sites.length;
      r.sites.forEach((s) => seen.add(D.domainOf(s.url)));
    }
    const batch = queue.slice(0, WEB_BATCH), rest = queue.slice(WEB_BATCH);
    const { items, notes } = await crawlMany(batch, ctx);
    // A website that could not be read is still worth keeping: its name and address came from the search.
    const readOk = new Set(items.map((i) => i.website));
    batch.forEach((s) => { if (s.name && !readOk.has(s.url)) items.push({ name: s.name, category: ctx.target === 'agent' ? 'independent_agent' : 'established_agency', state: ctx.state, city: s.city || ctx.city, website: s.url, source_url: s.url, contacts: [], raw: { from: 'web_search' } }); });
    if (found !== null) notes.unshift('Search round ' + round + ' found ' + found + ' new websites');
    const done = !rest.length && (round >= WEB_MAX_ROUNDS || found === 0);
    return { items, done, params: { queue: rest, round, seen: [...seen].slice(-300) }, notes: notes.join('; ') };
  },
});

registerAdapter({
  id: 'website', label: 'Websites I already know (optional)',
  description: 'Reads the home, contact and about pages of agency websites you paste in, and records business emails and phone numbers that are publicly shown. Use "Search the web" if you do not have addresses.',
  limits: 'Up to 6 sites per run, max 3 pages per site, respects robots.txt, public web hosts only.',
  async run(ctx) {
    const urls = Array.isArray(ctx.params.urls) ? ctx.params.urls : [];
    const start = parseInt(ctx.params.cursor) || 0, batch = urls.slice(start, start + 6);
    const { items, notes } = await crawlMany(batch, ctx);
    const next = start + batch.length;
    return { items, done: next >= urls.length, cursor: next, notes: notes.join('; ') };
  },
});

registerAdapter({
  id: 'osm', label: 'OpenStreetMap (free, limited)',
  description: 'Businesses mapped as estate agents or property managers in OpenStreetMap. Free, but very few Nigerian businesses are mapped, so expect small numbers.',
  limits: 'One query per job. Data (c) OpenStreetMap contributors (ODbL).',
  async run(ctx) {
    const state = ctx.state ? P.canonicalState(ctx.state) : null, city = ctx.city || null;
    if (!state && !city) throw new Error('Choose a state or city');
    if ((state && !NAME_OK.test(state)) || (city && !NAME_OK.test(city))) throw new Error('Provide a valid state or city name (letters only)');
    const n = Math.min((ctx.limit || 100) * 2, 500);
    // States are mapped as "Ogun State" / "Ashanti Region" and Abuja as "Federal Capital Territory".
    const area = state === 'Abuja' ? 'Federal Capital Territory' : state;
    const where = city
      ? 'node["place"~"^(city|town|suburb)$"]["name"="' + city + '"](area.c)->.p;'
      : 'rel(area.c)["boundary"="administrative"]["name"~"^(' + area + ')( State| Region)?$",i];map_to_area->.a;';
    const scope = city ? '(around.p:15000)' : '(area.a)';
    const q = '[out:json][timeout:60];area["ISO3166-1"~"^(NG|GH)$"]["admin_level"="2"]->.c;' + where +
      '(nwr["office"~"^(estate_agent|property_management)$"]' + scope + ';nwr["shop"="estate_agent"]' + scope + ';nwr["office"]["name"~"real ?estate|realt|propert",i]' + scope + ';);out tags center ' + n + ';';
    // The public servers are often at capacity, so try a second one before giving up.
    const servers = ctx.overpassUrl ? [ctx.overpassUrl] : [OVERPASS_URL, 'https://overpass.kumi.systems/api/interpreter'];
    let j = null, problem = null;
    for (const server of servers) {
      try {
        const res = await safeFetch(server, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, Object.assign({ timeoutMs: 45000, maxBytes: 5000000, retries: 1 }, ctx.net));
        if (!res.ok) { problem = 'HTTP ' + res.status; continue; }
        j = JSON.parse(res.text); break;
      } catch (e) { problem = e.message; }
    }
    if (!j) throw new Error('OpenStreetMap is busy right now (' + problem + '). Try again later, or use "Search the web".');
    const split = (v) => String(v || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const items = (j.elements || []).map((el) => {
      const t = el.tags || {}; if (!t.name) return null;
      const src = 'https://www.openstreetmap.org/' + el.type + '/' + el.id;
      const contacts = [];
      [t.phone, t['contact:phone'], t.mobile, t['contact:mobile']].forEach((v) => split(v).forEach((p) => contacts.push({ channel: 'phone', value: p, source_url: src })));
      split(t['contact:whatsapp']).forEach((p) => contacts.push({ channel: 'whatsapp', value: p, source_url: src }));
      [t.email, t['contact:email']].forEach((v) => split(v).forEach((e) => contacts.push({ channel: 'email', value: e, source_url: src })));
      return { name: t.name, category: ctx.target === 'agent' ? 'independent_agent' : 'established_agency', state: ctx.state, city: t['addr:city'] || city, website: t.website || t['contact:website'] || t.url || null, source_url: src, contacts, raw: t, notes: 'Source: OpenStreetMap contributors (ODbL)' };
    }).filter(Boolean);
    return { items, done: true, notes: 'OpenStreetMap has ' + items.length + ' named estate agents for ' + (city || state) + (items.length < 10 ? '. Use "Search the web" for many more.' : '') };
  },
});

registerAdapter({
  id: 'provider', label: 'Third-party data provider (not configured)',
  description: 'Placeholder for a future licensed data provider. Add an adapter with registerAdapter() and set its credentials as environment variables.',
  limits: 'Disabled until configured.',
  async run() { return { items: [], done: true, notes: 'No data provider is configured' }; },
});

// ---------- ingestion: one path for every source ----------
const SOURCE_FOR = { web: 'website_crawl', osm: 'osm', website: 'website_crawl', csv: 'csv_import', manual: 'manual', provider: 'provider' };

async function ingestCandidate(db, cand, ctx) {
  const adapter = ctx.adapter;
  const name = clip(cand.name, 160);
  if (!name) return { status: 'invalid', reason: 'no business name' };
  const contacts = []; const seen = new Set();
  (cand.contacts || []).forEach((c) => {
    const ch = c.channel === 'email' ? 'email' : (c.channel === 'whatsapp' ? 'whatsapp' : 'phone');
    const value = ch === 'email' ? D.normEmail(c.value) : D.normPhone(c.value);
    if (!value || seen.has(ch + value)) return; seen.add(ch + value);
    contacts.push({ channel: ch, value, label: clip(c.label, 120), source_url: D.cleanUrl(c.source_url) || D.cleanUrl(cand.source_url), is_role_address: ch === 'email' && D.isRoleAddress(value), verification_status: 'format_valid', verification_method: 'format' });
  });
  const website = D.cleanUrl(cand.website), sourceUrl = D.cleanUrl(cand.source_url) || website;
  if (!sourceUrl && !contacts.length && !website) return { status: 'invalid', reason: 'no contact, website or source' };
  const key = D.nameKey(name), domain = D.domainOf(website);
  const dups = await D.findDuplicates(db, { emails: contacts.filter((c) => c.channel === 'email').map((c) => c.value), phones: contacts.filter((c) => c.channel !== 'email').map((c) => c.value), domain, nameKey: key, state: cand.state, city: cand.city });

  const recordSource = (pid) => db.from('gx_prospect_sources').insert([{ prospect_id: pid, adapter: ctx.adapterLabel || adapter, source_url: sourceUrl, job_id: ctx.jobId || null, raw: cand.raw || {} }]);
  if (dups.length) {
    const pid = dups[0].prospect_id;
    await recordSource(pid);
    for (const c of contacts) { const { error } = await db.from('gx_prospect_contacts').insert([Object.assign({}, c, { prospect_id: pid })]); if (error && error.code !== '23505') console.error('ingest enrich:', error.message); }
    return { status: 'duplicate', id: pid, reasons: dups[0].reasons };
  }
  const category = ['independent_agent', 'established_agency', 'commercial_agent', 'residential_agent', 'property_consultant', 'other'].includes(cand.category) ? cand.category : null;
  const row = {
    name, contact_person: clip(cand.contact_person, 120), category, type: category === 'independent_agent' ? 'agent' : 'agency',
    state: clip(cand.state, 60), city: clip(cand.city, 60), website, website_domain: domain, source_url: sourceUrl, name_key: key,
    source: SOURCE_FOR[adapter] || 'provider', consent_basis: 'public_business_listing', notes: clip(cand.notes, 500), created_by: ctx.actor || 'discovery',
    phone: (contacts.find((c) => c.channel !== 'email') || {}).value || null, email: (contacts.find((c) => c.channel === 'email') || {}).value || null,
  };
  if (ctx.autoQualify && contacts.length) { row.stage = 'qualified'; row.qualified_at = new Date().toISOString(); }
  const { data: p, error } = await db.from('gx_prospects').insert([row]).select().single();
  if (error) {
    if (error.code === '23505') return { status: 'duplicate', reasons: ['contact'] };
    return { status: 'invalid', reason: error.message };
  }
  if (contacts.length) {
    const first = {};
    const rows = contacts.map((c) => { const k = c.channel === 'email' ? 'email' : 'phone'; const primary = !first[k]; first[k] = true; return Object.assign({}, c, { prospect_id: p.id, is_primary: primary }); });
    const { error: cErr } = await db.from('gx_prospect_contacts').insert(rows);
    if (cErr && cErr.code !== '23505') console.error('ingest contacts:', cErr.message);
  }
  await recordSource(p.id);
  try { await db.from('gx_prospect_activity').insert([{ prospect_id: p.id, activity: 'created', actor: ctx.actor || 'discovery', payload: { source: adapter } }]); } catch (e) { /* best effort */ }
  return { status: 'inserted', id: p.id };
}

// Checks that an email's domain can receive mail (MX or A record). It does NOT prove the mailbox exists,
// so a passing contact stays "format valid"; "verified" is reserved for a delivered message or a manual check.
async function mxOk(domain, resolver) {
  const r = resolver || { mx: (d) => dns.resolveMx(d), a: (d) => dns.resolve4(d) };
  try { const mx = await r.mx(domain); if (mx && mx.length) return true; } catch (e) { if (!['ENODATA', 'ENOTFOUND'].includes(e.code)) return null; }
  try { const a = await r.a(domain); return !!(a && a.length); } catch (e) { return ['ENODATA', 'ENOTFOUND'].includes(e.code) ? false : null; }
}

async function verifyProspectContacts(db, prospectId, resolver) {
  const { data: contacts } = await db.from('gx_prospect_contacts').select('*').eq('prospect_id', prospectId).eq('channel', 'email');
  let checked = 0, invalid = 0;
  for (const c of contacts || []) {
    if (c.verification_status === 'verified' || c.verification_status === 'bounced') continue;
    const ok = await mxOk(c.value.split('@')[1], resolver); checked++;
    if (ok === false) { invalid++; await db.from('gx_prospect_contacts').update({ verification_status: 'invalid', verification_method: 'mx_lookup' }).eq('id', c.id); }
    else if (ok === true) await db.from('gx_prospect_contacts').update({ verification_method: 'mx_lookup' }).eq('id', c.id);
  }
  return { checked, invalid };
}

// ---------- routes ----------
module.exports = function mountDiscovery(app, db, deps) {
  const auth = createAuth(db);
  const router = express.Router();
  const edit = auth.requireRole('recruiter'), manage = auth.requireRole('admin');
  const actorOf = (req) => (req.admin && (req.admin.email || req.admin.id)) || 'unknown';
  const audit = async (req, action, id, details) => { try { await db.from('gx_audit_log').insert([{ actor: actorOf(req), actor_role: req.adminRole, action, entity: 'discovery', entity_id: id ? String(id) : null, details: details || {}, ip: req.ip }]); } catch (e) { /* best effort */ } };
  const resolver = deps && deps.resolver;

  router.get('/outreach/discovery/adapters', edit, (req, res) => {
    res.json(Object.values(adapters).map((a) => ({ id: a.id, label: a.label, description: a.description, limits: a.limits })));
  });

  async function dailyRemaining() {
    const s = await C.getSettings(db);
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const { data } = await db.from('gx_discovery_jobs').select('inserted_count').gte('created_at', start.toISOString());
    const used = (data || []).reduce((t, j) => t + (j.inserted_count || 0), 0);
    return { limit: Number(s.daily_discovery_limit) || 300, used, remaining: Math.max(0, (Number(s.daily_discovery_limit) || 300) - used) };
  }

  router.get('/outreach/discovery/jobs', edit, async (req, res) => {
    const { data, error } = await db.from('gx_discovery_jobs').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ jobs: data || [], daily: await dailyRemaining() });
  });

  router.post('/outreach/discovery/jobs', manage, limiter(60 * 1000, 20), async (req, res) => {
    try {
      const b = req.body || {};
      if (!adapters[b.adapter]) return res.status(400).json({ error: 'Unknown adapter. Available: ' + Object.keys(adapters).join(', ') });
      if ((b.adapter === 'osm' || b.adapter === 'web') && !clip(b.state, 60) && !clip(b.city, 60)) return res.status(400).json({ error: 'Choose a state or city' });
      const params = {};
      if (b.adapter === 'website') {
        const urls = (Array.isArray(b.urls) ? b.urls : []).slice(0, 60);
        if (!urls.length) return res.status(400).json({ error: 'Provide the agency website URLs to read' });
        params.urls = urls; params.cursor = 0;
      }
      params.auto_qualify = b.auto_qualify !== false;
      const row = { adapter: b.adapter, state: clip(b.state, 60), city: clip(b.city, 60), target: ['agency', 'agent', 'both'].includes(b.target) ? b.target : 'agency', params, limit_count: Math.min(Math.max(parseInt(b.limit) || 100, 1), 500), created_by: actorOf(req) };
      const { data, error } = await db.from('gx_discovery_jobs').insert([row]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      await audit(req, 'discovery.job.create', data.id, { adapter: b.adapter, state: row.state, city: row.city });
      res.json(data);
    } catch (e) { res.status(500).json({ error: 'Could not create job' }); }
  });

  router.post('/outreach/discovery/jobs/:id/cancel', manage, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    await db.from('gx_discovery_jobs').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', req.params.id).in('status', ['queued', 'running']);
    await audit(req, 'discovery.job.cancel', req.params.id);
    res.json({ success: true });
  });

  router.post('/outreach/discovery/jobs/:id/run', manage, limiter(60 * 1000, 10), async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: job } = await db.from('gx_discovery_jobs').select('*').eq('id', req.params.id).maybeSingle();
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) return res.status(409).json({ error: 'Job is ' + job.status });
      const adapter = adapters[job.adapter];
      if (!adapter) return res.status(400).json({ error: 'Adapter no longer available' });
      const daily = await dailyRemaining();
      if (daily.remaining <= 0) return res.status(429).json({ error: 'Daily discovery limit reached (' + daily.limit + '). Change it in Permissions & Limits.' });
      await db.from('gx_discovery_jobs').update({ status: 'running', started_at: job.started_at || new Date().toISOString() }).eq('id', job.id);
      let result;
      let knownDomains = [];
      if (job.adapter === 'web') {
        let kq = db.from('gx_prospects').select('website_domain').order('discovered_at', { ascending: false }).limit(150);
        if (job.state) kq = kq.or(P.stateFilter(job.state));
        knownDomains = ((await kq).data || []).map((r) => r.website_domain).filter(Boolean);
      }
      try {
        result = await adapter.run({ knownDomains, search: deps && deps.search, state: job.state, city: job.city, target: job.target, limit: job.limit_count, params: job.params || {}, net: deps && deps.net, overpassUrl: deps && deps.overpassUrl, sleep: deps && deps.sleep });
      } catch (e) {
        await db.from('gx_discovery_jobs').update({ status: 'failed', error: String(e.message).slice(0, 500), finished_at: new Date().toISOString() }).eq('id', job.id);
        return res.status(502).json({ error: 'Source failed: ' + e.message });
      }
      const cap = Math.min(job.limit_count - job.inserted_count, daily.remaining);
      let inserted = 0, duplicates = 0, invalid = 0; const newIds = [];
      for (const item of result.items) {
        if (inserted >= cap) break;
        const r = await ingestCandidate(db, item, { adapter: job.adapter, adapterLabel: adapter.label, jobId: job.id, actor: actorOf(req), autoQualify: (job.params || {}).auto_qualify !== false });
        if (r.status === 'inserted') { inserted++; newIds.push(r.id); } else if (r.status === 'duplicate') duplicates++; else invalid++;
      }
      let verified = { checked: 0, invalid: 0 };
      for (const id of newIds.slice(0, 100)) { const v = await verifyProspectContacts(db, id, resolver); verified.checked += v.checked; verified.invalid += v.invalid; }
      const done = result.done || inserted >= cap;
      const params = Object.assign({}, job.params || {}, result.params || {}); if (result.cursor != null) params.cursor = result.cursor;
      await db.from('gx_discovery_jobs').update({
        status: done ? 'completed' : 'running', params, found_count: (job.found_count || 0) + result.items.length, inserted_count: (job.inserted_count || 0) + inserted,
        duplicate_count: (job.duplicate_count || 0) + duplicates, finished_at: done ? new Date().toISOString() : null, error: result.notes ? String(result.notes).slice(0, 500) : null,
      }).eq('id', job.id);
      await audit(req, 'discovery.job.run', job.id, { found: result.items.length, inserted, duplicates, invalid });
      res.json({ found: result.items.length, inserted, duplicates, invalid, email_domains_checked: verified.checked, email_domains_invalid: verified.invalid, done, notes: result.notes || null });
    } catch (e) { console.error('[discovery/run]', e.message); res.status(500).json({ error: 'Job failed' }); }
  });

  // CSV rows (parsed in the browser). Same ingestion path; the importer states how the data was obtained.
  router.post('/outreach/discovery/import', edit, limiter(10 * 60 * 1000, 10), async (req, res) => {
    try {
      const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
      if (!rows || !rows.length) return res.status(400).json({ error: 'rows array required' });
      if (rows.length > 2000) return res.status(400).json({ error: 'Max 2000 rows per import' });
      const daily = await dailyRemaining();
      if (daily.remaining <= 0 && req.adminRole !== 'owner') return res.status(429).json({ error: 'Daily discovery limit reached' });
      let inserted = 0, duplicates = 0, invalid = 0; const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const contacts = [];
        ['email', 'email2'].forEach((k) => r[k] && contacts.push({ channel: 'email', value: r[k], label: r.contact_person || r.contact }));
        ['phone', 'phone2', 'mobile'].forEach((k) => r[k] && contacts.push({ channel: 'phone', value: r[k], label: r.contact_person || r.contact }));
        const out = await ingestCandidate(db, { name: r.business_name || r.name, contact_person: r.contact_person || r.contact, category: r.category, state: r.state, city: r.city, website: r.website, source_url: r.source_url, contacts, notes: r.notes }, { adapter: 'csv', actor: actorOf(req), autoQualify: false });
        if (out.status === 'inserted') inserted++; else if (out.status === 'duplicate') duplicates++; else { invalid++; if (errors.length < 30) errors.push({ row: i + 1, error: out.reason }); }
      }
      await audit(req, 'discovery.import', null, { rows: rows.length, inserted, duplicates, invalid });
      res.json({ inserted, duplicates, invalid, errors });
    } catch (e) { res.status(500).json({ error: 'Import failed' }); }
  });

  router.post('/outreach/prospects/:id/verify', edit, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      res.json(await verifyProspectContacts(db, req.params.id, resolver));
    } catch (e) { res.status(500).json({ error: 'Verification failed' }); }
  });

  app.use('/api/growth', router);
  return { adapters, ingestCandidate, verifyProspectContacts };
};
Object.assign(module.exports, { helpers: { parseRobots, extractFromHtml, assertPublicUrl, safeFetch, isPrivateIp, ingestCandidate, mxOk, verifyProspectContacts, adapters } });
