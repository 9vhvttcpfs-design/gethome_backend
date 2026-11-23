// Normalisation and duplicate detection for prospects.
// Matching signals, strongest first: email, phone, website domain, normalised business name + city.
'use strict';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'mail.com', 'ymail.com']);
// Hosts that are not a business's own website, so a shared domain says nothing about identity.
const SHARED_HOSTS = new Set(['facebook.com', 'm.facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'linktr.ee', 'wa.me', 'whatsapp.com', 'youtube.com', 'tiktok.com', 'wixsite.com', 'blogspot.com', 'wordpress.com', 'google.com', 'goo.gl', 'business.site', 'sites.google.com']);
const ROLE_LOCALPARTS = new Set(['info', 'contact', 'hello', 'sales', 'enquiries', 'enquiry', 'inquiries', 'support', 'admin', 'office', 'lettings', 'rentals', 'properties', 'agency', 'team', 'mail', 'customercare', 'care']);
const NAME_NOISE = new Set(['ltd', 'limited', 'nigeria', 'nig', 'plc', 'llc', 'inc', 'co', 'company', 'and', 'the', 'of', 'realtors', 'realtor', 'real', 'estate', 'estates', 'properties', 'property', 'homes', 'home', 'agency', 'agencies', 'agents', 'agent', 'services', 'service', 'consult', 'consultants', 'consulting', 'global', 'international', 'enterprises', 'enterprise', 'group', 'investments', 'investment', 'resources', 'concept', 'concepts', 'solutions', 'venture', 'ventures']);

function normEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('234')) return d.length >= 12 && d.length <= 13 ? d : null;
  if (d.startsWith('0') && d.length === 11) return '234' + d.slice(1);
  if (d.length === 10) return '234' + d;
  return null;
}

// Host without www/port/path, or null when it is empty or a shared platform (social page, linktree...).
function domainOf(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  try {
    const host = new URL(s).hostname.replace(/^www\./, '');
    if (!host.includes('.') || SHARED_HOSTS.has(host) || FREE_MAIL.has(host)) return null;
    for (const h of SHARED_HOSTS) if (host.endsWith('.' + h)) return null;
    return host;
  } catch (e) { return null; }
}

function cleanUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s); return /^https?:$/.test(u.protocol) ? u.toString().slice(0, 500) : null; } catch (e) { return null; }
}

// "Prime Haven Realtors Ltd." and "PRIME HAVEN REAL ESTATE LIMITED" both become "prime haven".
function nameKey(name) {
  const words = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !NAME_NOISE.has(w));
  const key = (kept.length ? kept : words).join(' ').trim();
  return key.length >= 3 ? key : null;
}

function isRoleAddress(email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  return ROLE_LOCALPARTS.has(local);
}

function isFreeMail(email) {
  return FREE_MAIL.has(String(email || '').split('@')[1] || '');
}

// Finds existing prospects that look like the same business. Returns [{ prospect_id, reasons: [...] }].
async function findDuplicates(db, cand, opts) {
  const exclude = opts && opts.excludeId;
  const found = new Map();
  const add = (id, reason) => { if (!id || id === exclude) return; if (!found.has(id)) found.set(id, new Set()); found.get(id).add(reason); };

  const emails = (cand.emails || []).filter(Boolean), phones = (cand.phones || []).filter(Boolean);
  if (emails.length) { const { data } = await db.from('gx_prospect_contacts').select('prospect_id').eq('channel', 'email').in('value', emails); (data || []).forEach((r) => add(r.prospect_id, 'email')); }
  if (phones.length) { const { data } = await db.from('gx_prospect_contacts').select('prospect_id').in('channel', ['phone', 'whatsapp']).in('value', phones); (data || []).forEach((r) => add(r.prospect_id, 'phone')); }
  if (cand.domain) { const { data } = await db.from('gx_prospects').select('id').eq('website_domain', cand.domain); (data || []).forEach((r) => add(r.id, 'website')); }
  if (cand.nameKey) {
    let q = db.from('gx_prospects').select('id, city').eq('name_key', cand.nameKey);
    if (cand.state) q = q.eq('state', cand.state);
    const { data } = await q;
    (data || []).forEach((r) => { if (!cand.city || !r.city || String(r.city).toLowerCase() === String(cand.city).toLowerCase()) add(r.id, 'business_name'); });
  }
  return Array.from(found.entries()).map(([prospect_id, reasons]) => ({ prospect_id, reasons: Array.from(reasons) }));
}

module.exports = { normEmail, normPhone, domainOf, cleanUrl, nameKey, isRoleAddress, isFreeMail, findDuplicates };
