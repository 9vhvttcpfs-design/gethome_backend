// AI assistant "speak to a human" routing.
// Who should the customer be sent to for a given location?
//   1. the active Service Agent (SA) covering that location,
//   2. otherwise an active GHA assigned to that location,
//   3. otherwise GetHome's own WhatsApp number.
// Staff who are inactive/closed, or who have no phone/WhatsApp number on file, are skipped.
'use strict';
const { cityOf } = require('./cityAreas');

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

      // 2) GHA assigned to the location (gha_location_assignments), primary first, then by location text
      const { data: assigns } = await db.from('gha_location_assignments').select('gha_id, city, is_primary, is_active').eq('is_active', true);
      const ghaIds = (assigns || []).filter((a) => matches(a.city)).sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)).map((a) => a.gha_id);
      const { data: allGhas } = await db.from('gha_agents').select('*');
      const ghas = (allGhas || []).filter(isLive);
      const byAssign = [...new Set(ghaIds)].map((id) => ghas.find((g) => g.id === id)).filter(Boolean);
      const byGhaText = ghas.filter((g) => matches(g.location));
      const gha = byAssign.concat(byGhaText).find((g) => numberOf(g));
      if (gha) return build('GHA', gha);
    }

    // 3) GetHome's own number
    const fallback = process.env.GETHOME_WHATSAPP || process.env.WHATSAPP_NUMBER || '2349130649368';
    const digits = formatWaNumber(fallback);
    return { role: 'GETHOME', id: null, name: 'GetHome Support', code: null, whatsapp: digits, wa_link: 'https://wa.me/' + digits + '?text=' + encodeURIComponent(hello) };
  }

  return { resolveHandoffContact };
};
