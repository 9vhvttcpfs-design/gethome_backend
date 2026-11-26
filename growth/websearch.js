// Finds real estate agency websites by searching the web with Claude's server-side web search tool.
// Needs ANTHROPIC_API_KEY (already used by the AI chat). Only websites whose domain appeared in an actual
// search result are returned, so an address the model made up can never be saved.
// Contact details are NOT taken from the model: discovery.js reads them from each site's own public pages.
'use strict';
const D = require('./dedupe');
const P = require('./places');

const MODEL = process.env.OUTREACH_SEARCH_MODEL || 'claude-opus-5-5';
// Property portals, directories and social networks: not an agency's own website, and several forbid scraping.
const NOT_AGENCY = ['propertypro.ng', 'nigeriapropertycentre.com', 'privateproperty.com.ng', 'jiji.ng', 'jiji.com.gh', 'tolet.com.ng', 'meqasa.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'wikipedia.org', 'google.com', 'businesslist.com.ng', 'vconnect.com', 'finelib.com', 'yellowpages.net.ng', 'nairaland.com'];

const FOCUS = [
  'estate agencies and realtors',
  'property management companies and letting agents in the largest towns',
  'estate surveyors and valuers who sell or let property',
  'property developers and smaller independent realtors in other towns',
];

const isPortal = (domain) => NOT_AGENCY.some((d) => domain === d || domain.endsWith('.' + d));

function parseList(text) {
  // The list is the last "[{ ... }]" in the reply; earlier brackets may belong to the prose around it.
  const s = String(text || ''), starts = [...s.matchAll(/\[\s*\{/g)];
  if (!starts.length) return [];
  try { const j = JSON.parse(s.slice(starts[starts.length - 1].index, s.lastIndexOf(']') + 1)); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}

// Domains of every page the search tool actually returned.
function searchedDomains(content) {
  const out = new Set();
  (content || []).forEach((b) => {
    if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) return;
    b.content.forEach((r) => { const d = r && D.domainOf(r.url); if (d) out.add(d); });
  });
  return out;
}

async function defaultCreate(params) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Web search needs ANTHROPIC_API_KEY on the server. Add it on Render, or use another source.');
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 150000, maxRetries: 1 });
  // A model that declines on policy grounds is retried on a fallback model inside the same call.
  return client.beta.messages.stream(Object.assign({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, params)).finalMessage();
}

// Returns { sites: [{ url, name, city }], searches }.
async function searchAgencies({ state, city, target, round, exclude, create }) {
  const region = P.canonicalState(state);
  const country = P.countryOf(region) === 'GH' ? 'Ghana' : 'Nigeria';
  const place = [city, region === 'Abuja' ? 'Abuja (Federal Capital Territory)' : region + (country === 'Ghana' ? ' Region' : ' State'), country].filter(Boolean).join(', ');
  const who = target === 'agent' ? 'independent real estate agents and realtors' : target === 'both' ? 'real estate agencies and independent agents' : 'real estate agencies';
  const skip = [...(exclude || [])].slice(0, 150);
  const user = 'Search the web for ' + who + ' based in or serving ' + place + '. This search round, concentrate on ' + FOCUS[(round || 0) % FOCUS.length] + '.\n' +
    'Search several different ways, including by the main towns and cities in that area.\n' +
    'Return only businesses that have their own website. Leave out property portals, business directories, news articles and social media pages.' +
    (skip.length ? '\nWe already have these websites, so find different ones: ' + skip.join(', ') : '') +
    '\n\nFinish with ONLY a JSON array, no other text after it: [{"name": "business name", "url": "https://their-website", "city": "town or null"}]. Use only addresses that appeared in your search results.';
  // The basic search tool returns every result block directly, which the address check below relies on.
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6, blocked_domains: NOT_AGENCY }];
  const messages = [{ role: 'user', content: user }];
  const send = create || defaultCreate;

  let content = [], response, searches = 0;
  for (let turn = 0; turn < 4; turn++) {
    response = await send({ model: MODEL, max_tokens: 16000, output_config: { effort: 'low' }, tools, messages });
    content = content.concat(response.content || []);
    searches += (response.usage && response.usage.server_tool_use && response.usage.server_tool_use.web_search_requests) || 0;
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  if (response.stop_reason === 'refusal') throw new Error('The search was declined. Try a different state or source.');

  const failed = content.find((b) => b.type === 'web_search_tool_result' && b.content && !Array.isArray(b.content));
  const real = searchedDomains(content);
  if (!real.size && failed) throw new Error('Web search failed: ' + (failed.content.error_code || 'unknown error') + '. Check that web search is enabled for your Anthropic account.');

  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const known = new Set(skip), seen = new Set(), sites = [];
  parseList(text).forEach((s) => {
    const url = D.cleanUrl(s && s.url), domain = D.domainOf(url);
    if (!domain || isPortal(domain) || !real.has(domain) || known.has(domain) || seen.has(domain)) return;
    seen.add(domain);
    sites.push({ url: new URL(url).origin + '/', name: s.name ? String(s.name).slice(0, 160) : null, city: s.city && s.city !== 'null' ? String(s.city).slice(0, 60) : null });
  });
  return { sites, searches };
}

module.exports = { searchAgencies, searchedDomains, parseList, isPortal, MODEL };
