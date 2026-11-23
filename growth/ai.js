// Outreach Command Centre, phase 3: message personalisation.
// Provider interface: "template" (no AI, always available), "anthropic" (Claude), "openai_compatible" (any local or hosted model
// that speaks the /chat/completions protocol). The platform is fully usable with "template" only.
// The AI may only rephrase the opening using FACTS stored on the prospect. Its output is validated and rejected
// (falling back to the plain template) if it adds numbers, links, guarantees or anything not in the facts.
'use strict';

const CATEGORY_LABEL = { independent_agent: 'independent real estate agent', established_agency: 'real estate agency', commercial_agent: 'commercial property agent', residential_agent: 'residential property agent', property_consultant: 'property consultant' };
const BANNED = /(guarantee|guaranteed|100%|act now|limited time|urgent|risk[- ]free|get rich|free money|earn \$|earn n|₦\s?\d)/i;

// ---------- providers ----------
const providers = {
  template: { id: 'template', available: () => true, generate: async () => null },
  anthropic: {
    id: 'anthropic', available: () => !!process.env.ANTHROPIC_API_KEY,
    async generate({ system, user, maxTokens }) {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const r = await client.messages.create({ model: process.env.OUTREACH_AI_MODEL || 'claude-haiku-4-5', max_tokens: maxTokens || 700, system, messages: [{ role: 'user', content: user }] });
      return (r.content && r.content[0] && r.content[0].text) || '';
    },
  },
  openai_compatible: {
    id: 'openai_compatible', available: () => !!process.env.LOCAL_AI_URL,
    async generate({ system, user, maxTokens }) {
      const res = await fetch(process.env.LOCAL_AI_URL.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, process.env.LOCAL_AI_KEY ? { Authorization: 'Bearer ' + process.env.LOCAL_AI_KEY } : {}),
        body: JSON.stringify({ model: process.env.LOCAL_AI_MODEL || 'default', max_tokens: maxTokens || 700, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error('Local AI returned HTTP ' + res.status);
      const j = await res.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    },
  },
};

// ---------- template merge ----------
function mergeVars(prospect, contact, settings, link) {
  const contactName = (contact && contact.label) || prospect.contact_person || null;
  const where = [prospect.city, prospect.state].filter(Boolean).join(', ');
  return {
    contact_name: contactName || 'there', business_name: prospect.name || 'your business', city: prospect.city || '', state: prospect.state || '',
    in_location: where ? ' in ' + where : '', link, sender_name: (settings && settings.email_sender_name) || 'GetHome',
  };
}
function merge(text, vars) { return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : '')); }

// The only facts the AI is allowed to use. Fields that are not recorded are simply absent.
function factsFor(prospect, contact) {
  const f = { business_name: prospect.name };
  if (CATEGORY_LABEL[prospect.category]) f.business_type = CATEGORY_LABEL[prospect.category];
  if ((contact && contact.label) || prospect.contact_person) f.contact_person = (contact && contact.label) || prospect.contact_person;
  if (prospect.city) f.city = prospect.city;
  if (prospect.state) f.state = prospect.state;
  if (prospect.website_domain) f.website = prospect.website_domain;
  return f;
}

const numbersIn = (s) => new Set((String(s).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')));
const urlsIn = (s) => new Set(String(s).match(/https?:\/\/[^\s)>\]"']+/g) || []);

// Returns null when the AI output is acceptable, otherwise a short reason.
function validateAiOutput(baseBody, baseSubject, out, facts, link) {
  if (!out || typeof out.body !== 'string' || typeof out.subject !== 'string') return 'malformed output';
  if (out.body.length < 80 || out.body.length > baseBody.length * 1.35 + 200) return 'length out of range';
  if (out.subject.length < 5 || out.subject.length > 120) return 'subject length out of range';
  if (!out.body.includes(link)) return 'missing the registration link';
  const allowedUrls = new Set([link]); const bad = [...urlsIn(out.body)].find((u) => !allowedUrls.has(u.replace(/[.,;]$/, '')));
  if (bad) return 'contains an extra link';
  if (BANNED.test(out.body) || BANNED.test(out.subject)) return 'contains a prohibited claim';
  const allowedNums = new Set([...numbersIn(baseBody), ...numbersIn(baseSubject), ...numbersIn(JSON.stringify(facts))]);
  const extra = [...numbersIn(out.body)].find((n) => !allowedNums.has(n));
  if (extra) return 'introduces a number not in the facts (' + extra + ')';
  const firstLine = baseBody.split('\n')[0];
  if (!out.body.startsWith(firstLine)) return 'changed the greeting';
  return null;
}

function parseJsonObject(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// Builds subject + body for one prospect. Never throws: any AI problem falls back to the plain template.
async function personalize({ prospect, contact, template, settings, link, providerName, generate }) {
  const vars = mergeVars(prospect, contact, settings, link);
  const baseSubject = merge(template.subject || 'GetHome', vars), baseBody = merge(template.body, vars);
  const facts = factsFor(prospect, contact);
  const result = { subject: baseSubject, body: baseBody, generated_by: 'template', facts, provider: 'template', ai_rejected: null };
  const name = providerName || (settings && settings.ai_provider) || 'template';
  const provider = providers[name];
  if (name === 'template' || !provider || (!generate && !provider.available())) { if (name !== 'template') result.ai_rejected = 'provider not available'; return result; }
  try {
    const system = 'You help personalise a recruitment email from GetHome, a Nigerian property marketplace. Use ONLY the FACTS supplied. Never invent details about the business, its history, size, listings, awards, clients or prices. Do not add numbers, links, claims or promises. Keep a professional, natural tone suitable for Nigerian business correspondence.';
    const user = 'FACTS: ' + JSON.stringify(facts) + '\n\nBASE SUBJECT: ' + baseSubject + '\n\nBASE EMAIL:\n' + baseBody + '\n\nTask: rewrite ONLY the first paragraph after the greeting so it reads naturally for this recipient, using the facts where they fit. Keep the greeting line, every other paragraph, the link and the sign-off exactly as they are. Return ONLY JSON: {"subject": "...", "body": "..."} where body is the complete email.';
    const raw = await (generate || provider.generate)({ system, user, maxTokens: 800 });
    const out = parseJsonObject(raw);
    const why = validateAiOutput(baseBody, baseSubject, out, facts, link);
    if (why) { result.ai_rejected = why; return result; }
    return Object.assign(result, { subject: out.subject.trim(), body: out.body.trim(), generated_by: 'ai', provider: name });
  } catch (e) { result.ai_rejected = 'provider error: ' + String(e.message).slice(0, 120); return result; }
}

module.exports = { providers, personalize, mergeVars, merge, factsFor, validateAiOutput, CATEGORY_LABEL };
