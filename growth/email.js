// Email provider adapter. Resend (HTTP API) or SMTP, chosen by the email_provider setting.
// Credentials only ever come from environment variables.
'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function configured(provider) {
  if (provider === 'smtp') return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  return !!(process.env.RESEND_API_KEY || process.env.SMTP_PASS);
}

// from: "Name <address>". Address comes from OUTREACH_FROM_EMAIL, then SMTP_FROM, then the platform default.
function fromAddress(senderName) {
  const addr = process.env.OUTREACH_FROM_EMAIL || process.env.SMTP_FROM || 'noreply@trygethome.online';
  return String(senderName || 'GetHome').replace(/[<>"\r\n]/g, '') + ' <' + addr + '>';
}

async function sendResend(m, fetchImpl) {
  const key = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
  const r = await (fetchImpl || fetch)('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, reply_to: m.replyTo || undefined, headers: m.headers }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(String(j.message || j.error || ('HTTP ' + r.status)).slice(0, 300)); e.retryable = r.status === 429 || r.status >= 500; throw e; }
  return { id: j.id || null, provider: 'resend' };
}

async function sendSmtp(m) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 465, secure: (Number(process.env.SMTP_PORT) || 465) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  const info = await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo, headers: m.headers });
  return { id: info.messageId || null, provider: 'smtp' };
}

async function send(provider, message, fetchImpl) {
  if (!configured(provider)) { const e = new Error('Email provider "' + provider + '" is not configured'); e.retryable = false; throw e; }
  return provider === 'smtp' ? sendSmtp(message) : sendResend(message, fetchImpl);
}

module.exports = { send, configured, fromAddress, esc };
