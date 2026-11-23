// City -> neighbourhood map. Mirrors src/constants/cityAreas.js in the frontend so that marketing copy
// and landing pages describe the same set of listings the app's city filter shows.
'use strict';
const CITY_AREAS = {
  Lagos: ['lekki', 'ikeja', 'yaba', 'ajah', 'surulere', 'victoria island', 'ikoyi', 'ikorodu', 'magodo', 'gbagada', 'maryland', 'ogudu', 'badagry', 'epe', 'sangotedo', 'chevron', 'oniru', 'ojodu', 'festac', 'apapa'],
  Abuja: ['wuse', 'maitama', 'garki', 'gwarinpa', 'asokoro', 'jabi', 'kubwa', 'lugbe', 'utako', 'katampe', 'lokogoma', 'gwagwalada', 'fct', 'guzape', 'durumi', 'jikwoyi', 'wuye', 'gousa', 'ushafa', 'apo', 'mpape', 'karmo', 'life camp', 'kado', 'galadimawa', 'dawaki', 'kaura', 'nyanya', 'karu', 'kurudu', 'idu', 'mabushi', 'gudu', 'dei-dei', 'dei dei', 'bwari', 'kuje', 'jahi', 'gaduwa', 'sabon lugbe', 'kabusa', 'efab'],
  'Port Harcourt': ['rumuola', 'gra', 'trans amadi', 'rumuokoro', 'obio-akpor', 'obio akpor', 'rumuigbo', 'eleme', 'woji', 'peter odili'],
  Ibadan: ['bodija', 'ring road', 'akobo', 'iyaganku', 'challenge', 'oluyole'],
  Enugu: ['independence layout', 'trans ekulu', 'new haven'], 'Benin City': ['benin', 'ugbowo', 'gra benin'],
};

function wordIn(text, term) {
  const t = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]/g, '[-\\s]');
  return new RegExp('(^|[^a-z0-9])' + t + '([^a-z0-9]|$)').test(text);
}

function matchesCity(location, city) {
  const loc = String(location || '').toLowerCase();
  const c = String(city || '').toLowerCase();
  if (!loc || !c) return false;
  if (loc.includes(c)) return true;
  const key = Object.keys(CITY_AREAS).find((k) => k.toLowerCase() === c);
  return !!key && CITY_AREAS[key].some((a) => wordIn(loc, a));
}

module.exports = { CITY_AREAS, matchesCity };
