// Emails to registered customers, inviting them back to look for a home, a commercial space or a shortlet.
// Only accounts with role 'customer' are written to. Every email carries an unsubscribe link, and each send is recorded
// in gx_events. A one-off send never reaches the same person twice. The daily, weekly and monthly updates, when switched on,
// write to each customer once per day, week or month until they unsubscribe.
'use strict';
const express = require('express');
const crypto = require('crypto');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');
const C = require('./consent');
const Mail = require('./email');
const D = require('./dedupe');
const { signToken, readToken } = require('./optout');

const SITE = 'https://trygethome.online';
const PROVIDER = 'customer_mail';
const SCHEDULE_KEY = 'customer_schedule';
const FREQUENCIES = ['monthly', 'weekly', 'daily']; // when several are due, the rarer one goes first
const LAGOS = 3600000; // Nigeria is UTC+1 all year
const PURPOSES = ['rent', 'sale', 'shortlet'];
const BUTTONS = [['Find a home to rent', 'tab=rent'], ['Buy a property', 'tab=sale'], ['Find commercial space', 'type=commercial'], ['Book a shortlet', 'tab=shortlet']];
// The latest moment (Nigeria clock, held in the UTC fields) at or before `local` when this update falls due.
function dueAt(frequency, day, hour, local) {
  const y = local.getUTCFullYear(), mo = local.getUTCMonth(), date = local.getUTCDate();
  if (frequency === 'monthly') {
    const d = new Date(Date.UTC(y, mo, day, hour));
    return d > local ? new Date(Date.UTC(y, mo - 1, day, hour)) : d;
  }
  const every = frequency === 'daily' ? 1 : 7;
  const d = new Date(Date.UTC(y, mo, date - (every === 1 ? 0 : (local.getUTCDay() - day + 7) % 7), hour));
  return d > local ? new Date(d.getTime() - every * 86400000) : d;
}
const dayOf = (d) => d.toISOString().slice(0, 10);

const clip = (v, n) => { if (v == null) return ''; return String(v).trim().slice(0, n); };
const link = (query) => SITE + '/?' + query + '&utm_source=customer_email&utm_medium=email&utm_campaign=come_back';
const firstName = (p) => clip(p && p.full_name, 80).split(/\s+/)[0] || 'there';

function priceOf(p) {
  const n = Number(p.purpose === 'shortlet' ? p.cost_per_night : (p.purpose === 'sale' ? (p.price || p.rent) : (p.rent || p.price)));
  return n > 0 ? (p.currency_symbol || '₦') + n.toLocaleString('en-NG') + (p.purpose === 'shortlet' ? ' per night' : '') : '';
}

// Builds the plain-text and HTML versions of one email.
function render({ body, images, listings, name, unsubUrl, logoUrl }) {
  const text = body.replace(/\{\{name\}\}/g, name);
  const e = Mail.esc;
  const picture = (u, alt) => '<img src="' + e(u) + '" alt="' + e(alt) + '" style="display:block;width:100%;height:auto;border:0;border-radius:8px;margin:0 0 12px">';
  const cards = listings.map((l) => '<a href="' + e(l.url) + '" style="display:block;text-decoration:none;color:#374151;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin:0 0 12px">' +
    picture(l.image, l.title) + '<strong>' + e(l.title) + '</strong><br>' + e([l.location, l.price].filter(Boolean).join(' · ')) + '</a>').join('');
  const buttons = BUTTONS.map(([label, q]) => '<a href="' + e(link(q)) + '" style="display:inline-block;background:#0a7d4f;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;margin:0 6px 8px 0;font-size:14px">' + e(label) + '</a>').join('');
  const logo = Mail.httpsUrl(logoUrl);
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#374151;line-height:1.6">' +
    (logo ? '<p style="margin:0 0 16px"><img src="' + e(logo) + '" alt="GetHome" style="max-height:48px;max-width:200px;border:0"></p>' : '') +
    '<p>' + e(text).replace(/\n/g, '<br>') + '</p>' + images.map((u) => picture(u, '')).join('') +
    (cards ? '<h3 style="margin:20px 0 10px">Latest on GetHome</h3>' + cards : '') +
    '<p style="margin:20px 0">' + buttons + '</p>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"><p style="color:#94a3b8;font-size:12px">GetHome Realestate Ltd, trygethome.online<br>You are receiving this because you have a GetHome account. <a href="' + e(unsubUrl) + '">Unsubscribe</a>.</p></div>';
  const plain = text + (listings.length ? '\n\nLatest on GetHome:\n' + listings.map((l) => '- ' + [l.title, l.location, l.price].filter(Boolean).join(', ') + ': ' + l.url).join('\n') : '') +
    '\n\n' + BUTTONS.map(([label, q]) => label + ': ' + link(q)).join('\n') +
    '\n\n--\nGetHome Realestate Ltd, trygethome.online\nYou are receiving this because you have a GetHome account. Unsubscribe: ' + unsubUrl;
  return { html, text: plain };
}

module.exports = function mountCustomerMail(app, db, deps) {
  deps = deps || {};
  const now = () => (deps.now ? deps.now() : new Date());
  const auth = createAuth(db);
  const router = express.Router();
  router.use('/customer-mail', auth.requireAdmin);
  const baseUrl = (req) => (process.env.API_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
  let sendingNow = false;
  const failedToday = new Set(); // addresses that failed go to the back, so they cannot hold up everyone else

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

  // Customers who can be emailed: have an address, account not deleted, not unsubscribed or bounced.
  async function audience() {
    const rows = await fetchAll(() => db.from('profiles').select('*').eq('role', 'customer').order('id', { ascending: true }));
    const seen = new Set(), people = [];
    rows.forEach((r) => {
      const email = r.is_deleted ? null : D.normEmail(r.email);
      if (email && !seen.has(email)) { seen.add(email); people.push({ id: r.id, email, full_name: r.full_name }); }
    });
    const blocked = new Set();
    const emails = people.map((p) => p.email);
    for (let i = 0; i < emails.length; i += 200) {
      const { data, error } = await db.from('gx_suppressions').select('value').in('value', emails.slice(i, i + 200));
      if (error) throw error;
      (data || []).forEach((s) => blocked.add(s.value));
    }
    return { total: rows.length, with_email: people.length, unsubscribed: blocked.size, people: people.filter((p) => !blocked.has(p.email)) };
  }

  async function latestListings(count, purpose) {
    if (!count) return [];
    let q = db.from('properties').select('title, location, purpose, rent, price, cost_per_night, currency_symbol, image_urls, image_url, created_at')
      .or('is_deleted.eq.false,is_deleted.is.null').or('is_sold.eq.false,is_sold.is.null').order('created_at', { ascending: false }).limit(100);
    if (purpose) q = q.eq('purpose', purpose);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((p) => {
      const image = [].concat(p.image_urls || [], p.image_url || []).map(Mail.httpsUrl).find(Boolean);
      const tab = PURPOSES.includes(p.purpose) ? p.purpose : 'rent';
      return image && p.title ? { title: p.title, location: p.location || '', price: priceOf(p), image, url: link('tab=' + tab + '&q=' + encodeURIComponent(p.title)) } : null;
    }).filter(Boolean).slice(0, count);
  }

  // Reads and checks what the admin wrote. Returns { error } or the message.
  function readMessage(b) {
    const subject = clip(b.subject, 200), body = clip(b.body, 5000);
    if (!subject || !body) return { error: 'Subject and message are required' };
    const given = Array.isArray(b.images) ? b.images.filter(Boolean) : [];
    if (given.length > 4) return { error: 'Up to 4 photos' };
    const images = given.map((u) => Mail.httpsUrl(String(u)));
    if (images.some((u) => !u)) return { error: 'Each photo must be a public https:// link' };
    const count = Math.min(Math.max(parseInt(b.listings) || 0, 0), 6);
    const purpose = PURPOSES.includes(b.purpose) ? b.purpose : null;
    // Identifies this message, so pressing Send again carries on instead of repeating it.
    const key = crypto.createHash('sha1').update(JSON.stringify([subject, body, images])).digest('hex').slice(0, 16);
    return { subject, body, images, count, purpose, key };
  }

  const fail = (res, e, tag) => { console.error('[customer-mail/' + tag + ']', e.message || e); res.status(500).json({ error: 'Request failed' }); };

  router.get('/customer-mail/audience', async (req, res) => {
    try { const a = await audience(); res.json({ customers: a.total, with_email: a.with_email, unsubscribed: a.unsubscribed, can_email: a.people.length }); }
    catch (e) { fail(res, e, 'audience'); }
  });

  router.post('/customer-mail/preview', limiter(60 * 1000, 20), async (req, res) => {
    try {
      const m = readMessage(req.body || {}); if (m.error) return res.status(400).json({ error: m.error });
      const settings = await C.getSettings(db);
      const listings = await latestListings(m.count, m.purpose);
      res.json({ html: render({ body: m.body, images: m.images, listings, name: 'Ada', unsubUrl: SITE, logoUrl: settings.email_logo_url }).html, listings: listings.length });
    } catch (e) { fail(res, e, 'preview'); }
  });

  async function mailer(m) {
    const settings = await C.getSettings(db);
    const provider = settings.email_provider || 'resend';
    if (!deps.sendEmail && !Mail.configured(provider)) return null;
    const sendFn = deps.sendEmail || ((msg) => Mail.send(provider, msg));
    const listings = await latestListings(m.count, m.purpose);
    return { settings, deliver: (to, name, unsubUrl) => {
      const r = render({ body: m.body, images: m.images, listings, name, unsubUrl, logoUrl: settings.email_logo_url });
      return sendFn({ from: Mail.fromAddress(settings.email_sender_name), to, subject: m.subject.replace(/\{\{name\}\}/g, name), text: r.text, html: r.html, replyTo: settings.reply_to_email, headers: { 'List-Unsubscribe': '<' + unsubUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    } };
  }

  // Sends one batch of one campaign, to everyone who has not had it yet. A scheduled update also leaves anyone already
  // emailed today for tomorrow; a one-off send leaves out anyone emailed in the last skipDays.
  async function sendBatch({ m, mail, base, campaign, scheduled, skipDays }) {
    const today = dayOf(new Date(now().getTime() + LAGOS));
    const startOfDay = new Date(Date.parse(today + 'T00:00:00Z') - LAGOS);
    const cutoff = scheduled || !skipDays ? startOfDay : new Date(Math.min(now().getTime() - skipDays * 86400000, startOfDay.getTime()));
    const recentRows = await fetchAll(() => db.from('gx_events').select('payload, occurred_at').eq('provider', PROVIDER).gte('occurred_at', cutoff.toISOString()).order('occurred_at', { ascending: true }));
    const had = new Set(), recent = new Set();
    const same = await fetchAll(() => db.from('gx_events').select('payload').eq('provider', PROVIDER).like('provider_event_id', campaign + ':%').order('occurred_at', { ascending: true }));
    same.forEach((h) => had.add((h.payload || {}).user_id));
    recentRows.forEach((h) => { const id = (h.payload || {}).user_id; if ((scheduled || skipDays) && !had.has(id)) recent.add(id); });

    // Customer and outreach emails share the provider's daily allowance.
    const { data: outreachToday } = await db.from('gx_messages').select('id').eq('channel', 'email').gte('sent_at', startOfDay.toISOString());
    const sentToday = recentRows.filter((h) => new Date(h.occurred_at) >= startOfDay).length + (outreachToday || []).length;
    let allowance = Math.max(0, Number(mail.settings.daily_email_limit) - sentToday);

    const a = await audience();
    // Whoever was emailed longest ago goes first, so a daily limit does not leave the same people out every time.
    const lastAt = new Map();
    if (scheduled) {
      const week = await fetchAll(() => db.from('gx_events').select('payload, occurred_at').eq('provider', PROVIDER).gte('occurred_at', new Date(now().getTime() - 7 * 86400000).toISOString()).order('occurred_at', { ascending: true }));
      week.forEach((h) => lastAt.set((h.payload || {}).user_id, Date.parse(h.occurred_at)));
    }
    const queue = a.people.filter((p) => !had.has(p.id) && !recent.has(p.id)).sort((x, y) => (failedToday.has(x.id) - failedToday.has(y.id)) || ((lastAt.get(x.id) || 0) - (lastAt.get(y.id) || 0)));
    const out = { sent: 0, failed: 0, already_had_it: a.people.filter((p) => had.has(p.id)).length, emailed_recently: a.people.filter((p) => recent.has(p.id)).length, remaining: queue.length, stopped_reason: null, last_error: null };
    const spacing = Number(mail.settings.send_spacing_ms) || 700;
    const t0 = Date.now();
    let failuresInARow = 0;
    for (const p of queue) {
      if (allowance <= 0) { out.stopped_reason = 'daily_limit'; break; }
      if (out.sent + out.failed >= 50 || Date.now() - t0 > 40000) { out.stopped_reason = 'batch_full'; break; }
      if (failuresInARow >= 3) { out.stopped_reason = 'provider_error'; break; }
      // Record first: the unique id means two sends can never both email this person.
      const eventId = campaign + ':' + p.id;
      const { error } = await db.from('gx_events').insert([{ type: 'customer_email', provider: PROVIDER, provider_event_id: eventId, payload: { user_id: p.id, campaign, subject: m.subject }, occurred_at: now().toISOString() }]);
      if (error) { if (error.code !== '23505') throw error; out.remaining--; continue; }
      try {
        await mail.deliver(p.email, firstName(p), base + '/api/growth/customer-unsubscribe/' + signToken(p.id));
        out.sent++; out.remaining--; allowance--; failuresInARow = 0; failedToday.delete(p.id);
      } catch (e) {
        await db.from('gx_events').delete().eq('provider', PROVIDER).eq('provider_event_id', eventId);
        failedToday.add(p.id); out.failed++; failuresInARow++; out.last_error = String(e.message).slice(0, 300);
      }
      if (!deps.sendEmail) await new Promise((r) => setTimeout(r, spacing));
    }
    return out;
  }

  router.post('/customer-mail/send', limiter(60 * 1000, 20), async (req, res) => {
    let locked = false;
    try {
      const b = req.body || {};
      const m = readMessage(b); if (m.error) return res.status(400).json({ error: m.error });
      const testTo = b.test_to ? D.normEmail(b.test_to) : null;
      if (b.test_to && !testTo) return res.status(400).json({ error: 'That test address is not a valid email' });
      const mail = await mailer(m);
      if (!mail) return res.status(503).json({ error: 'Email sending is not set up on the server' });
      if (testTo) {
        try { await mail.deliver(testTo, 'there', SITE); } catch (e) { return res.status(502).json({ error: 'Test not sent: ' + e.message }); }
        return res.json({ test: true, sent: 1 });
      }
      if (sendingNow) return res.status(409).json({ error: 'Customer emails are already being sent. Try again in a minute.' });
      sendingNow = locked = true;
      const skipDays = Math.min(Math.max(parseInt(b.skip_recent_days) || 0, 0), 365);
      res.json(await sendBatch({ m, mail, base: baseUrl(req), campaign: m.key, scheduled: false, skipDays }));
    } catch (e) { fail(res, e, 'send'); }
    finally { if (locked) sendingNow = false; }
  });

  // ---------- weekly and monthly updates ----------
  async function loadSchedules() {
    const { data, error } = await db.from('gx_settings').select('value').eq('key', SCHEDULE_KEY).maybeSingle();
    if (error) throw error;
    return (data && data.value) || {};
  }
  async function saveSchedules(value, actor) {
    const { error } = await db.from('gx_settings').upsert([{ key: SCHEDULE_KEY, value, updated_by: actor, updated_at: now().toISOString() }], { onConflict: 'key' });
    if (error) throw error;
  }
  async function publicView(all) {
    const local = new Date(now().getTime() + LAGOS);
    const out = { daily_limit: Number((await C.getSettings(db)).daily_email_limit) };
    FREQUENCIES.forEach((k) => {
      const s = all[k];
      if (!s) { out[k] = { enabled: false }; return; }
      const last = dueAt(k, s.day, s.hour, local);
      const next = k === 'monthly' ? new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, s.day, s.hour)) : new Date(last.getTime() + (k === 'daily' ? 1 : 7) * 86400000);
      // Switched on after today's hour on its own day: that one is still to go out.
      const pending = s.enabled && dayOf(last) === s.start && !(s.last && s.last.period === dayOf(last));
      out[k] = Object.assign({}, s, { base_url: undefined, next: s.enabled ? dayOf(pending ? last : next) : null });
    });
    return out;
  }

  router.get('/customer-mail/schedule', async (req, res) => {
    try { res.json(await publicView(await loadSchedules())); } catch (e) { fail(res, e, 'schedule'); }
  });

  router.put('/customer-mail/schedule', limiter(60 * 1000, 20), async (req, res) => {
    try {
      const b = req.body || {};
      if (!FREQUENCIES.includes(b.frequency)) return res.status(400).json({ error: 'Choose daily, weekly or monthly' });
      const all = await loadSchedules();
      const actor = (req.admin && (req.admin.email || req.admin.id)) || 'unknown';
      if (b.enabled !== true) {
        if (all[b.frequency]) all[b.frequency].enabled = false;
        await saveSchedules(all, actor);
        return res.json(await publicView(all));
      }
      const m = readMessage(b); if (m.error) return res.status(400).json({ error: m.error });
      const day = b.frequency === 'daily' ? 0 : Number(b.day), hour = Number(b.hour);
      const [min, max] = b.frequency === 'monthly' ? [1, 28] : [0, 6];
      if (!Number.isInteger(day) || day < min || day > max) return res.status(400).json({ error: 'Choose which day it goes out' });
      if (!Number.isInteger(hour) || hour < 6 || hour > 20) return res.status(400).json({ error: 'Choose a time between 6am and 8pm' });
      const before = all[b.frequency] || {};
      // `start` stops a newly switched-on update from sending last week's or last month's turn straight away.
      all[b.frequency] = { enabled: true, day, hour, start: before.enabled ? before.start : dayOf(new Date(now().getTime() + LAGOS)), subject: m.subject, body: m.body, images: m.images, listings: m.count, purpose: m.purpose, base_url: baseUrl(req), last: before.last || null };
      await saveSchedules(all, actor);
      res.json(await publicView(all));
    } catch (e) { fail(res, e, 'schedule-save'); }
  });

  // Called every few minutes by the server. When an update falls due it works through the list in batches; anyone left
  // over because of the daily limit is sent on the following days, until the next one falls due.
  async function runScheduled() {
    if (sendingNow) return;
    sendingNow = true;
    try {
      const all = await loadSchedules();
      const local = new Date(now().getTime() + LAGOS);
      for (const k of FREQUENCIES) {
        const s = all[k];
        // Leftovers from an earlier day also wait for the chosen hour, so nothing goes out at night.
        if (!s || !s.enabled || local.getUTCHours() < s.hour) continue;
        const period = dayOf(dueAt(k, s.day, s.hour, local));
        if (period < s.start) continue;
        const m = readMessage(Object.assign({}, s));
        const mail = m.error ? null : await mailer(Object.assign(m, { count: s.listings }));
        if (!mail) continue;
        const out = await sendBatch({ m, mail, base: s.base_url, campaign: k + ':' + period, scheduled: true });
        if (!out.sent && !out.failed) { if (out.stopped_reason) break; continue; }
        // Re-read so that switching it off while a batch is going out is not undone.
        const fresh = await loadSchedules();
        const prev = fresh[k].last && fresh[k].last.period === period ? fresh[k].last : { sent: 0, failed: 0 };
        fresh[k].last = { period, sent: prev.sent + out.sent, failed: prev.failed + out.failed, waiting: out.remaining, reason: out.stopped_reason === 'batch_full' ? null : out.stopped_reason, error: out.last_error };
        await saveSchedules(fresh, 'scheduled-send');
        console.log('[customer-mail/' + k + '] sent ' + out.sent + ', failed ' + out.failed + ', waiting ' + out.remaining);
        // Finish this one before a more frequent update starts on the people still waiting for it.
        if (out.stopped_reason) break;
      }
    } catch (e) { console.error('[customer-mail/scheduled]', e.message); }
    finally { sendingNow = false; }
  }

  // Public unsubscribe. GET only shows a button, so mail scanners that open links cannot unsubscribe anyone.
  const page = (inner) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>GetHome</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px">' + inner + '</body>';
  router.get('/customer-unsubscribe/:token', (req, res) => {
    if (!readToken(req.params.token)) return res.status(400).type('html').send(page('<p>This link is not valid.</p>'));
    res.type('html').send(page('<h2>Stop emails from GetHome?</h2><form method="post"><button style="padding:10px 18px;font-size:15px">Yes, unsubscribe me</button></form>'));
  });
  router.post('/customer-unsubscribe/:token', limiter(10 * 60 * 1000, 20), async (req, res) => {
    try {
      const id = readToken(req.params.token);
      if (!id) return res.status(400).type('html').send(page('<p>This link is not valid.</p>'));
      const { data: p } = await db.from('profiles').select('email').eq('id', id).maybeSingle();
      const email = p && D.normEmail(p.email);
      if (email) {
        const { error } = await db.from('gx_suppressions').upsert([{ value: email, reason: 'opt_out', added_by: 'customer_unsubscribe' }], { onConflict: 'value', ignoreDuplicates: true });
        if (error) throw error;
      }
      res.type('html').send(page('<h2>You have been unsubscribed.</h2>'));
    } catch (e) { console.error('[customer-mail/unsubscribe]', e.message); res.status(500).type('html').send(page('<p>Something went wrong. Please try again.</p>')); }
  });

  app.use('/api/growth', router);
  return { runScheduled };
};
module.exports.render = render;
