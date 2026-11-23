// Recruitment outreach: generate a message for a prospect and (for email only) optionally send it.
// WhatsApp/SMS are drafted for the recruiter to copy and send manually, then confirmed via mark-sent.
// Swap in an API sender for those channels later by extending sendMessage().
'use strict';
const crypto = require('crypto');
const { limiter } = require('../middleware/security');

const SITE = 'https://trygethome.online';
const DAILY_EMAIL_CAP = 100;           // protects the sending domain's reputation
const RESEND_COOLDOWN_HOURS = 72;      // never email the same prospect twice within this window
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

function secret() {
  return process.env.GROWTH_SIGNING_SECRET || crypto.createHash('sha256').update('gx-optout:' + (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '')).digest('hex');
}
function signToken(id) { return id + '.' + crypto.createHmac('sha256', secret()).update(id).digest('hex').slice(0, 24); }
function readToken(t) {
  const [id, sig] = String(t || '').split('.');
  if (!isUuid(id) || !sig) return null;
  const good = signToken(id).split('.')[1];
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

// Deterministic templates (no model call, no invented claims). {link} carries UTM + GHA ref for attribution.
function buildMessage(p, channel, template, ctx) {
  const params = new URLSearchParams({ utm_source: 'recruit', utm_medium: channel, utm_campaign: slug(ctx.campaignName) || 'direct_outreach' });
  if (ctx.ghaCode) params.set('ref', ctx.ghaCode);
  const link = SITE + '/?' + params.toString();
  const who = p.type === 'agency' ? 'agencies' : 'agents';
  const hello = 'Hello ' + (p.name || (p.type === 'agency' ? (p.agency_name || 'there') : 'there')) + ',';
  const where = p.city || p.state ? ' in ' + [p.city, p.state].filter(Boolean).join(', ') : '';
  let body;
  if (template === 'followup') {
    body = [hello, '',
      'Following up on my earlier note about GetHome, the Nigerian property marketplace that connects property seekers with verified agents and agencies.',
      'If you would like to list your properties' + where + ', you can register here: ' + link, '',
      'Happy to answer any questions. Just reply to this message.'].join('\n');
  } else {
    body = [hello, '',
      'I am reaching out from GetHome Realestate Ltd. GetHome is a Nigerian property marketplace that connects property seekers with verified real estate ' + who + '. We are onboarding verified ' + who + where + ' and thought of you.',
      'Verified ' + who + ' list properties for seekers to browse, and inspection bookings are handled through the platform.', '',
      'You can register here: ' + link, '',
      'If you have any questions, just reply to this message.'].join('\n');
  }
  const subject = template === 'followup' ? 'Following up: list your properties on GetHome' : 'Invitation to list your properties on GetHome';
  return { subject, text: body, link };
}

async function sendEmail(to, subject, text, unsubUrl) {
  const key = process.env.RESEND_API_KEY || process.env.SMTP_PASS; // same key the platform mailer uses
  if (!key) return { ok: false, error: 'Email sending is not configured' };
  const footer = '\n\n--\nGetHome Realestate Ltd, trygethome.online\nYou received this because your business contact details are publicly listed or you asked to hear from us. To stop receiving messages from GetHome, use this link: ' + unsubUrl;
  const textFull = text + footer;
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#374151;line-height:1.6">' +
    esc(text).replace(/\n/g, '<br>') +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">' +
    '<p style="color:#94a3b8;font-size:12px">GetHome Realestate Ltd, trygethome.online<br>You received this because your business contact details are publicly listed or you asked to hear from us. <a href="' + esc(unsubUrl) + '">Stop receiving messages from GetHome</a>.</p></div>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'GetHome <' + (process.env.SMTP_FROM || 'noreply@trygethome.online') + '>',
        to: [to], subject, text: textFull, html,
        headers: { 'List-Unsubscribe': '<' + unsubUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: String(j.message || j.error || ('HTTP ' + r.status)).slice(0, 300) };
    return { ok: true, id: j.id || null };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}

module.exports = function mountOutreach(ctx) {
  const { router, db, requireCrm, canTouch, activity, suppress } = ctx;
  const baseUrl = (req) => (process.env.API_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');

  async function advanceToContacted(p, actor) {
    const upd = { contacted_at: p.contacted_at || new Date().toISOString() };
    if (p.stage === 'new') upd.stage = 'contacted';
    await db.from('gx_prospects').update(upd).eq('id', p.id);
    await activity(p.id, 'contacted', actor, {});
  }

  // Generate a message (always) and optionally send it (email, admin only).
  router.post('/recruit/outreach', requireCrm, limiter(60 * 1000, 30), async (req, res) => {
    try {
      const b = req.body || {};
      if (!isUuid(b.prospect_id)) return res.status(400).json({ error: 'prospect_id required' });
      const channel = ['email', 'whatsapp', 'sms'].includes(b.channel) ? b.channel : null;
      if (!channel) return res.status(400).json({ error: 'channel must be email, whatsapp or sms' });
      const template = b.template === 'followup' ? 'followup' : 'intro';
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', b.prospect_id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Prospect not found' });
      if (!canTouch(req.crm, p)) return res.status(403).json({ error: 'Forbidden' });
      if (p.do_not_contact) return res.status(409).json({ error: 'This prospect has opted out and must not be contacted.' });
      if (p.stage === 'lost' || p.stage === 'subscribed') return res.status(409).json({ error: 'Prospect is already ' + p.stage + '.' });
      if (channel === 'email' && !p.email) return res.status(400).json({ error: 'Prospect has no email address.' });
      if (channel !== 'email' && !p.phone) return res.status(400).json({ error: 'Prospect has no phone number.' });
      const { data: sup } = await db.from('gx_suppressions').select('value').in('value', [p.phone, p.email].filter(Boolean)).limit(1);
      if (sup && sup.length) return res.status(409).json({ error: 'This contact is on the do-not-contact list.' });

      let ghaCode = null, campaignName = null;
      if (p.owner_type === 'GHA' && p.owner_id) { const { data: g } = await db.from('gha_agents').select('gha_code').eq('id', p.owner_id).maybeSingle(); ghaCode = g && g.gha_code; }
      if (p.campaign_id) { const { data: c } = await db.from('gx_recruit_campaigns').select('name').eq('id', p.campaign_id).maybeSingle(); campaignName = c && c.name; }
      const msg = buildMessage(p, channel, template, { ghaCode, campaignName });

      const { data: row, error: insErr } = await db.from('gx_outreach').insert([{
        prospect_id: p.id, channel, template, subject: channel === 'email' ? msg.subject : null,
        message_text: msg.text, status: 'draft_ready', created_by: req.crm.actor,
      }]).select().single();
      if (insErr) return res.status(500).json({ error: insErr.message });

      const out = { outreach_id: row.id, channel, subject: row.subject, message_text: msg.text, status: 'draft_ready', sent: false };
      if (channel !== 'email') out.wa_link = channel === 'whatsapp' ? 'https://wa.me/' + p.phone + '?text=' + encodeURIComponent(msg.text) : null;

      if (b.send === true) {
        if (channel !== 'email') { out.send_error = 'Only email can be sent automatically. Copy the message and send it yourself, then confirm with mark-sent.'; return res.json(out); }
        if (req.crm.type !== 'ADMIN') { out.send_error = 'Only an admin can send email. Your draft is saved.'; return res.json(out); }
        const since = new Date(Date.now() - RESEND_COOLDOWN_HOURS * 3600000).toISOString();
        const { count: recent } = await db.from('gx_outreach').select('id', { count: 'exact', head: true }).eq('prospect_id', p.id).eq('channel', 'email').eq('status', 'sent').gte('sent_at', since);
        if (recent > 0) { out.send_error = 'This prospect was emailed in the last ' + RESEND_COOLDOWN_HOURS + ' hours.'; return res.json(out); }
        const startDay = new Date(); startDay.setUTCHours(0, 0, 0, 0);
        const { count: today } = await db.from('gx_outreach').select('id', { count: 'exact', head: true }).eq('channel', 'email').eq('status', 'sent').gte('sent_at', startDay.toISOString());
        if (today >= DAILY_EMAIL_CAP) { out.send_error = 'Daily email cap (' + DAILY_EMAIL_CAP + ') reached. Draft saved.'; return res.json(out); }
        const unsub = baseUrl(req) + '/api/growth/opt-out/' + signToken(p.id);
        const r = await sendEmail(p.email, msg.subject, msg.text, unsub);
        if (r.ok) {
          await db.from('gx_outreach').update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: r.id }).eq('id', row.id);
          await advanceToContacted(p, req.crm.actor);
          out.status = 'sent'; out.sent = true;
        } else {
          await db.from('gx_outreach').update({ status: 'failed', error: r.error }).eq('id', row.id);
          out.status = 'failed'; out.send_error = r.error;
        }
      }
      res.json(out);
    } catch (e) { console.error('[outreach]', e.message); res.status(500).json({ error: 'Could not prepare outreach' }); }
  });

  // Recruiter confirms they sent a drafted message themselves (WhatsApp / SMS / phone).
  router.post('/recruit/outreach/:id/mark-sent', requireCrm, async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: o } = await db.from('gx_outreach').select('*').eq('id', req.params.id).maybeSingle();
      if (!o) return res.status(404).json({ error: 'Not found' });
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', o.prospect_id).maybeSingle();
      if (!p || !canTouch(req.crm, p)) return res.status(403).json({ error: 'Forbidden' });
      if (o.status !== 'draft_ready') return res.status(409).json({ error: 'Message is already ' + o.status });
      if (p.do_not_contact) return res.status(409).json({ error: 'This prospect has opted out.' });
      await db.from('gx_outreach').update({ status: 'sent_manual', sent_at: new Date().toISOString() }).eq('id', o.id);
      await advanceToContacted(p, req.crm.actor);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/recruit/outreach', requireCrm, async (req, res) => {
    try {
      if (!isUuid(req.query.prospect_id)) return res.status(400).json({ error: 'prospect_id required' });
      const { data: p } = await db.from('gx_prospects').select('owner_type, owner_id').eq('id', req.query.prospect_id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Not found' });
      if (!canTouch(req.crm, p)) return res.status(403).json({ error: 'Forbidden' });
      const { data } = await db.from('gx_outreach').select('id, channel, template, subject, status, created_by, created_at, sent_at, error').eq('prospect_id', req.query.prospect_id).order('created_at', { ascending: false }).limit(50);
      res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Unsubscribe link in outreach emails. GET shows a confirm button (so link scanners that
  // prefetch URLs cannot opt people out by accident); POST performs it (also used for one-click). ----
  const page = (inner) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>GetHome</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px;color:#1a1a1a">' + inner + '</body>';
  router.get('/opt-out/:token', (req, res) => {
    if (!readToken(req.params.token)) return res.status(400).type('html').send(page('<p>This link is not valid.</p>'));
    res.type('html').send(page('<h2>Stop messages from GetHome?</h2><form method="post"><button style="padding:10px 18px;font-size:15px">Yes, unsubscribe me</button></form>'));
  });
  router.post('/opt-out/:token', limiter(10 * 60 * 1000, 20), async (req, res) => {
    try {
      const id = readToken(req.params.token);
      if (!id) return res.status(400).type('html').send(page('<p>This link is not valid.</p>'));
      const { data: p } = await db.from('gx_prospects').select('phone, email').eq('id', id).maybeSingle();
      if (p) await suppress(p.phone, p.email);
      res.type('html').send(page('<h2>You have been unsubscribed.</h2><p>GetHome will not contact you again.</p>'));
    } catch (e) { res.status(500).type('html').send(page('<p>Something went wrong. Please try again.</p>')); }
  });
};
