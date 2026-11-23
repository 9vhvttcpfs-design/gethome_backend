// Outreach Command Centre, phase 5: WhatsApp Business Platform (Cloud API) adapter.
// Official API only. No WhatsApp Web automation. Credentials only from environment variables:
//   WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_BUSINESS_ACCOUNT_ID, WA_GRAPH_VERSION (optional)
// Rules enforced here: marketing messages go only to contacts with a recorded WhatsApp opt-in, only as Meta-approved
// templates, and free-form replies only inside the 24-hour customer-service window opened by the prospect's own message.
'use strict';
const express = require('express');
const crypto = require('crypto');
const createAuth = require('../middleware/auth');
const { limiter } = require('../middleware/security');
const D = require('./dedupe');
const C = require('./consent');
const AI = require('./ai');
const Core = require('./outreachCore');

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const clip = (v, n) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; };
const graph = () => 'https://graph.facebook.com/' + (process.env.WA_GRAPH_VERSION || 'v21.0');
const configured = () => !!(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);
const WINDOW_MS = 24 * 3600 * 1000;

// X-Hub-Signature-256: "sha256=<hex hmac of raw body with the app secret>"
function verifyMetaSignature(appSecret, rawBody, header) {
  try {
    if (!appSecret || !header || !String(header).startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const a = Buffer.from(String(header).slice(7)), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

async function graphCall(fetchImpl, method, path, body) {
  const r = await (fetchImpl || fetch)(graph() + path, { method, headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && (j.error.message || j.error.error_user_msg)) || ('HTTP ' + r.status)); e.retryable = r.status === 429 || r.status >= 500; throw e; }
  return j;
}

// Named placeholders ({{business_name}}) -> Meta's positional ({{1}}), in the order of `variables`.
function toMetaBody(body, variables) {
  let missing = null;
  const out = String(body).replace(/\{\{(\w+)\}\}/g, (m, k) => { const i = variables.indexOf(k); if (i < 0) { missing = k; return m; } return '{{' + (i + 1) + '}}'; });
  return missing ? { error: 'Placeholder {{' + missing + '}} is not in the template variables list' } : { text: out };
}

module.exports = function mountWhatsApp(app, db, deps) {
  deps = deps || {};
  const now = () => (deps.now ? deps.now() : new Date());
  const auth = createAuth(db);
  const router = express.Router();
  const read = auth.requireRole('viewer'), edit = auth.requireRole('recruiter'), manage = auth.requireRole('admin');
  const actorOf = (req) => (req.admin && (req.admin.email || req.admin.id)) || 'unknown';
  const audit = async (req, action, entity, id, details) => { try { await db.from('gx_audit_log').insert([{ actor: actorOf(req), actor_role: req.adminRole, action, entity, entity_id: id ? String(id) : null, details: details || {}, ip: req.ip }]); } catch (e) { /* best effort */ } };

  router.get('/outreach/whatsapp/status', read, (req, res) => {
    res.json({ configured: configured(), webhook_secret_set: !!process.env.WA_APP_SECRET, verify_token_set: !!process.env.WA_VERIFY_TOKEN, business_account_set: !!process.env.WA_BUSINESS_ACCOUNT_ID,
      note: configured() ? 'Cloud API credentials are present.' : 'Not configured. Add the WA_* environment variables; until then WhatsApp outreach stays draft-and-copy.' });
  });

  // ---------- webhook ----------
  router.get('/webhooks/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && process.env.WA_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge'] || ''));
    res.sendStatus(403);
  });

  async function recordOnce(type, providerEventId, prospectId, messageId, payload) {
    const { error } = await db.from('gx_events').insert([{ type, provider: 'whatsapp', provider_event_id: providerEventId, prospect_id: prospectId || null, message_id: messageId || null, payload: payload || {}, occurred_at: now().toISOString() }]);
    return !(error && error.code === '23505');   // false = already handled
  }

  router.post('/webhooks/whatsapp', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    if (!process.env.WA_APP_SECRET) return res.status(503).json({ error: 'Webhook not configured' });
    if (!verifyMetaSignature(process.env.WA_APP_SECRET, raw, req.headers['x-hub-signature-256'])) return res.status(401).json({ error: 'Invalid signature' });
    try {
      const body = JSON.parse(raw.toString('utf8'));
      for (const entry of body.entry || []) for (const ch of entry.changes || []) {
        const v = ch.value || {};
        for (const st of v.statuses || []) {
          const { data: m } = await db.from('gx_messages').select('*').eq('provider', 'whatsapp').eq('provider_message_id', st.id).maybeSingle();
          if (!await recordOnce('wa_' + st.status, st.id + ':' + st.status, m && m.prospect_id, m && m.id, { status: st.status })) continue;
          if (!m) continue;
          if (st.status === 'delivered') await db.from('gx_messages').update({ status: m.status === 'sent' ? 'delivered' : m.status, delivered_at: now().toISOString() }).eq('id', m.id);
          else if (st.status === 'failed') await db.from('gx_messages').update({ status: 'failed', last_error: String((st.errors && st.errors[0] && st.errors[0].title) || 'failed').slice(0, 300) }).eq('id', m.id);
        }
        for (const msg of v.messages || []) {
          const phone = D.normPhone(msg.from);
          if (!await recordOnce('wa_inbound', 'in:' + msg.id, null, null, { from: phone })) continue;
          if (!phone) continue;
          const { data: ct } = await db.from('gx_prospect_contacts').select('*').in('channel', ['phone', 'whatsapp']).eq('value', phone).maybeSingle();
          if (!ct) continue;   // not a prospect: ignore (customer chats are handled elsewhere)
          const text = msg.type === 'text' ? (msg.text && msg.text.body) : (msg.type === 'button' ? (msg.button && msg.button.text) : '[' + msg.type + ']');
          await db.from('gx_events').insert([{ type: 'wa_window_open', provider: 'whatsapp', provider_event_id: 'win:' + msg.id, prospect_id: ct.prospect_id, payload: {}, occurred_at: now().toISOString() }]);
          const { data: last } = await db.from('gx_messages').select('id').eq('prospect_id', ct.prospect_id).eq('channel', 'whatsapp').in('status', ['sent', 'delivered']).order('created_at', { ascending: false }).limit(1);
          await Core.processReply(db, { prospect_id: ct.prospect_id, contact_id: ct.id, message_id: last && last[0] ? last[0].id : null, channel: 'whatsapp', body: text, raw: { wamid: msg.id } });
        }
      }
      res.json({ ok: true });
    } catch (e) { console.error('[webhook/whatsapp]', e.message); res.status(500).json({ error: 'Webhook failed' }); }
  });

  // ---------- templates: submit to Meta, sync approval status ----------
  router.post('/outreach/whatsapp/templates/:id/submit', manage, async (req, res) => {
    try {
      if (!configured() || !process.env.WA_BUSINESS_ACCOUNT_ID) return res.status(503).json({ error: 'WhatsApp Cloud API is not configured' });
      if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { data: t } = await db.from('gx_message_templates').select('*').eq('id', req.params.id).maybeSingle();
      if (!t || t.channel !== 'whatsapp') return res.status(404).json({ error: 'WhatsApp template not found' });
      const name = clip(t.wa_template_name, 100);
      if (!name || !/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Set a template name using lowercase letters, numbers and underscores' });
      const conv = toMetaBody(t.body, t.variables || []); if (conv.error) return res.status(400).json({ error: conv.error });
      const example = (t.variables || []).map((v) => 'Example ' + v);
      const comp = { type: 'BODY', text: conv.text }; if (example.length) comp.example = { body_text: [example] };
      const j = await graphCall(deps.fetchImpl, 'POST', '/' + process.env.WA_BUSINESS_ACCOUNT_ID + '/message_templates', { name, language: t.language || 'en', category: 'MARKETING', components: [comp] });
      await db.from('gx_message_templates').update({ wa_status: 'pending' }).eq('id', t.id);
      await audit(req, 'whatsapp.template.submit', 'template', t.id, { name });
      res.json({ success: true, meta_id: j.id || null, status: 'pending' });
    } catch (e) { res.status(502).json({ error: 'Meta rejected the request: ' + e.message }); }
  });
  router.post('/outreach/whatsapp/templates/:id/sync', manage, async (req, res) => {
    try {
      if (!configured() || !process.env.WA_BUSINESS_ACCOUNT_ID) return res.status(503).json({ error: 'WhatsApp Cloud API is not configured' });
      const { data: t } = await db.from('gx_message_templates').select('*').eq('id', req.params.id).maybeSingle();
      if (!t || !t.wa_template_name) return res.status(404).json({ error: 'Template not found' });
      const j = await graphCall(deps.fetchImpl, 'GET', '/' + process.env.WA_BUSINESS_ACCOUNT_ID + '/message_templates?name=' + encodeURIComponent(t.wa_template_name));
      const hit = (j.data || [])[0]; if (!hit) return res.json({ status: t.wa_status, note: 'Meta has no template with this name yet' });
      const map = { APPROVED: 'approved', REJECTED: 'rejected', PENDING: 'pending', PAUSED: 'rejected', DISABLED: 'rejected' };
      const status = map[hit.status] || 'pending';
      await db.from('gx_message_templates').update({ wa_status: status }).eq('id', t.id);
      res.json({ status, meta_status: hit.status });
    } catch (e) { res.status(502).json({ error: 'Could not reach Meta: ' + e.message }); }
  });

  // ---------- sending approved marketing templates ----------
  async function processWhatsApp(opts) {
    const settings = await C.getSettings(db);
    const out = { sent: 0, blocked: 0, failed: 0, waiting: 0, stopped_reason: null };
    if (!configured()) { out.stopped_reason = 'not_configured'; return out; }
    const cap = Number(settings.daily_whatsapp_limit) || 50;
    const start = now(); start.setUTCHours(0, 0, 0, 0);
    const { data: today } = await db.from('gx_messages').select('id').eq('channel', 'whatsapp').gte('sent_at', start.toISOString());
    let count = (today || []).length;
    const { data: queue } = await db.from('gx_messages').select('*').eq('status', 'approved').eq('channel', 'whatsapp').lte('scheduled_for', now().toISOString()).limit(Math.min(opts.max || 20, 50));
    for (const m of queue || []) {
      if (count >= cap) { out.stopped_reason = 'daily_limit'; break; }
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', m.prospect_id).maybeSingle();
      const { data: ct } = m.contact_id ? await db.from('gx_prospect_contacts').select('*').eq('id', m.contact_id).maybeSingle() : { data: null };
      const { data: t } = m.template_id ? await db.from('gx_message_templates').select('*').eq('id', m.template_id).maybeSingle() : { data: null };
      const gate = p ? await C.evaluateSend(db, p, ct, 'whatsapp', settings) : { ok: false, reason: 'no_contact' };
      if (!gate.ok || !t || t.wa_status !== 'approved') {
        if (gate.ok && t && t.wa_status !== 'approved') { out.waiting++; continue; }   // keep queued until Meta approves the template
        await db.from('gx_messages').update({ status: 'cancelled', last_error: 'blocked at send time: ' + (gate.reason || 'template') }).eq('id', m.id);
        if (p) await Core.stopForProspect(db, p.id, Core.STOP_REASON[gate.reason] || 'admin');
        out.blocked++; continue;
      }
      await db.from('gx_messages').update({ status: 'sending', attempts: (m.attempts || 0) + 1 }).eq('id', m.id);
      try {
        const vars = ((m.personalization || {}).wa_variables || []).map((x) => ({ type: 'text', text: String(x || '-').slice(0, 200) }));
        const j = await graphCall(deps.fetchImpl, 'POST', '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
          messaging_product: 'whatsapp', to: ct.value, type: 'template',
          template: { name: t.wa_template_name, language: { code: t.language || 'en' }, components: vars.length ? [{ type: 'body', parameters: vars }] : undefined },
        });
        const ts = now().toISOString();
        await db.from('gx_messages').update({ status: 'sent', sent_at: ts, provider: 'whatsapp', provider_message_id: (j.messages && j.messages[0] && j.messages[0].id) || null, last_error: null }).eq('id', m.id);
        const upd = { whatsapp_attempts: (p.whatsapp_attempts || 0) + 1, last_contacted_at: ts }; if (!p.contacted_at) upd.contacted_at = ts;
        if (['new', 'qualified', 'permission_obtained', 'campaign_ready'].includes(p.stage)) upd.stage = 'contacted';
        await db.from('gx_prospects').update(upd).eq('id', p.id);
        if (m.enrollment_id) {
          const { data: en } = await db.from('gx_sequence_enrollments').select('*').eq('id', m.enrollment_id).maybeSingle();
          const { data: seq } = en ? await db.from('gx_sequences').select('*').eq('id', en.sequence_id).maybeSingle() : { data: null };
          const next = seq && (seq.steps || []).find((s) => s.step === en.current_step + 1);
          if (en && next && upd.whatsapp_attempts < (Number(settings.max_whatsapp_attempts) || 2)) await db.from('gx_sequence_enrollments').update({ current_step: next.step, next_send_at: new Date(now().getTime() + next.delay_days * 86400000).toISOString() }).eq('id', en.id);
          else if (en) await db.from('gx_sequence_enrollments').update({ status: 'completed', next_send_at: null }).eq('id', en.id);
        }
        count++; out.sent++;
      } catch (e) {
        const attempts = (m.attempts || 0) + 1;
        if (e.retryable !== false && attempts < 3) await db.from('gx_messages').update({ status: 'approved', last_error: String(e.message).slice(0, 300), scheduled_for: new Date(now().getTime() + attempts * 5 * 60000).toISOString() }).eq('id', m.id);
        else await db.from('gx_messages').update({ status: 'failed', last_error: String(e.message).slice(0, 300) }).eq('id', m.id);
        out.failed++;
      }
    }
    return out;
  }
  router.post('/outreach/whatsapp/process', manage, limiter(60 * 1000, 6), async (req, res) => {
    try { const r = await processWhatsApp({ max: parseInt(req.body && req.body.max) || 20 }); await audit(req, 'whatsapp.process', 'queue', null, r); res.json(r); } catch (e) { res.status(500).json({ error: 'Request failed' }); }
  });

  // ---------- human handover: reply inside the 24h window ----------
  async function windowOpen(prospectId) {
    const { data } = await db.from('gx_events').select('occurred_at').eq('prospect_id', prospectId).eq('type', 'wa_window_open').order('occurred_at', { ascending: false }).limit(1);
    return !!(data && data[0] && now().getTime() - new Date(data[0].occurred_at).getTime() < WINDOW_MS);
  }
  router.get('/outreach/whatsapp/window', read, async (req, res) => {
    if (!isUuid(req.query.prospect_id)) return res.status(400).json({ error: 'prospect_id required' });
    res.json({ open: await windowOpen(req.query.prospect_id) });
  });
  router.post('/outreach/whatsapp/reply', edit, limiter(60 * 1000, 20), async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'WhatsApp Cloud API is not configured' });
      const b = req.body || {};
      if (!isUuid(b.prospect_id) || !clip(b.text, 1000)) return res.status(400).json({ error: 'prospect_id and text required' });
      const { data: p } = await db.from('gx_prospects').select('*').eq('id', b.prospect_id).maybeSingle();
      if (!p) return res.status(404).json({ error: 'Not found' });
      const { data: sup } = await db.from('gx_suppressions').select('value').in('value', [p.phone].filter(Boolean)).limit(1);
      if (p.do_not_contact || (sup && sup.length)) return res.status(409).json({ error: 'This prospect opted out' });
      if (!await windowOpen(p.id)) return res.status(409).json({ error: 'The 24-hour reply window is closed. Free-form messages are only allowed within 24 hours of the prospect\'s own message. Use an approved template instead.' });
      const { data: ct } = await db.from('gx_prospect_contacts').select('*').eq('prospect_id', p.id).in('channel', ['phone', 'whatsapp']).limit(1);
      if (!ct || !ct[0]) return res.status(400).json({ error: 'No phone contact' });
      const j = await graphCall(deps.fetchImpl, 'POST', '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', { messaging_product: 'whatsapp', to: ct[0].value, type: 'text', text: { body: String(b.text).slice(0, 1000) } });
      await db.from('gx_messages').insert([{ prospect_id: p.id, contact_id: ct[0].id, channel: 'whatsapp', step: 0, body: String(b.text).slice(0, 1000), generated_by: 'human', status: 'sent', sent_at: now().toISOString(), provider: 'whatsapp', provider_message_id: (j.messages && j.messages[0] && j.messages[0].id) || null, created_by: actorOf(req) }]);
      await audit(req, 'whatsapp.reply', 'prospect', p.id, {});
      res.json({ success: true });
    } catch (e) { res.status(502).json({ error: 'Send failed: ' + e.message }); }
  });

  app.use('/api/growth', router);
  return { processWhatsApp };
};
Object.assign(module.exports, { verifyMetaSignature, toMetaBody, configured });
