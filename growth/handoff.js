// AI assistant "speak to a human" routing.
// Who should the customer be sent to for a given location?
//   1. the active Service Agent (SA) covering that location,
//   2. otherwise GetHome Realestate's own WhatsApp number (09130649368).
// SAs who are inactive/closed, or have no phone/WhatsApp number on file, are skipped.
'use strict';
const { cityOf } = require('./cityAreas');

// GetHome Realestate's official line, shown when no SA covers the customer's location.
const GETHOME_NUMBER = '09130649368';
const DEAD = ['inactive', 'closed', 'deactivated', 'suspended'];
const isLive = (row) => !row.status || DEAD.indexOf(String(row.status).toLowerCase()) === -1;
const numberOf = (row) => row.whatsapp_number || row.whatsapp || row.phone || null;

// Loose but safe text match: equal, or one contains the other (3+ chars so empty/short values never match).
function textMatch(a, b) {
  a = String(a || '').toLowerCase().trim();
  b = String(b || '').toLowerCase().trim();
  if (a.length < 3 || b.length < 3) return false;
  return a === b || a.includes(b) || b.includes(a);
}

module.exports = function createHandoff(db, formatWaNumber) {
  async function resolveHandoffContact(location, summaryText) {
    const raw = String(location || '').trim();
    const tokens = [raw, raw ? cityOf(raw) : null].filter(Boolean);
    const matches = (...fields) => tokens.some((t) => fields.some((f) => textMatch(t, f)));
    const hello = 'Hello, I was chatting with GetHome AI' + (summaryText ? ' about ' + summaryText : '') + '. I would like to speak with an agent.';
    const build = (role, row, extra) => {
      const digits = formatWaNumber(numberOf(row));
      return Object.assign({
        role, id: row.id, name: row.full_name || null, code: row.sa_code || row.gha_code || null,
        whatsapp: digits, wa_link: 'https://wa.me/' + digits + '?text=' + encodeURIComponent(hello),
      }, extra || {});
    };

    if (tokens.length) {
      // 1) SA covering the location (sa_locations), then SA whose own location text matches
      const { data: locs } = await db.from('sa_locations').select('sa_id, city, state, is_active').eq('is_active', true);
      const saIds = [...new Set((locs || []).filter((l) => matches(l.city, l.state)).map((l) => l.sa_id))];
      const { data: allSas } = await db.from('service_agents').select('*');
      const sas = (allSas || []).filter(isLive);
      const byCoverage = saIds.map((id) => sas.find((s) => s.id === id)).filter(Boolean);
      const byText = sas.filter((s) => matches(s.location));
      const sa = byCoverage.concat(byText).find((s) => numberOf(s));
      if (sa) return build('SA', sa);

    }

    // 2) GetHome Realestate's own number
    const fallback = GETHOME_NUMBER;
    const digits = formatWaNumber(fallback);
    return { role: 'GETHOME', id: null, name: 'GetHome Support', code: null, whatsapp: digits, wa_link: 'https://wa.me/' + digits + '?text=' + encodeURIComponent(hello) };
  }

  return { resolveHandoffContact };
};
