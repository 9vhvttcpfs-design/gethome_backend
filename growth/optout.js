// Signed unsubscribe tokens shared by every outreach email (staff drafts, campaign sends, List-Unsubscribe header).
'use strict';
const crypto = require('crypto');
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

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
module.exports = { signToken, readToken };
