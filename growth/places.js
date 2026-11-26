// Nigerian states and Ghanaian regions used by prospect discovery and outreach filters.
// Mirrored in the frontend at src/features/outreach/places.js.
'use strict';

const NG_STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];
const GH_REGIONS = ['Greater Accra', 'Ashanti', 'Western', 'Western North', 'Central', 'Eastern', 'Volta', 'Oti', 'Northern', 'Savannah', 'North East', 'Upper East', 'Upper West', 'Bono', 'Bono East', 'Ahafo'];

// "Ogun State" -> "Ogun"; "FCT" / "Federal Capital Territory" -> "Abuja".
function canonicalState(s) {
  const t = String(s || '').trim().replace(/\s+(state|region)$/i, '');
  if (/^(fct|f\.c\.t\.?|federal capital territory|abuja)$/i.test(t)) return 'Abuja';
  return t;
}

const countryOf = (state) => (GH_REGIONS.some((r) => r.toLowerCase() === canonicalState(state).toLowerCase()) ? 'GH' : 'NG');

// PostgREST filter matching every spelling a stored state may have.
function stateFilter(state) {
  const c = canonicalState(state).replace(/[^\w ]/g, '').slice(0, 60);
  const names = c === 'Abuja' ? ['Abuja', 'FCT', 'Federal Capital Territory'] : [c, c + ' State', c + ' Region'];
  return names.map((n) => 'state.ilike.' + n).join(',');
}

module.exports = { NG_STATES, GH_REGIONS, canonicalState, countryOf, stateFilter };
