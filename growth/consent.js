// The single gate every sender must pass before a message to a prospect is queued or sent.
// Rules (from the approved policy):
//  - suppressed, opted-out, bounced/invalid, already-registered and lost prospects are never contacted;
//  - email: explicit consent if recorded; otherwise one B2B first-contact basis, "legitimate interest",
//    which only works when an admin has switched it on after the assessment is signed off;
//  - WhatsApp: explicit opt-in only (Meta policy), never legitimate interest;
//  - stop after the configured number of unanswered attempts (default 2) and when a reply awaits a human.
'use strict';

const DEFAULTS = {
  li_b2b_email_enabled: false, max_email_attempts: 2, max_whatsapp_attempts: 2,
  daily_discovery_limit: 300, daily_email_limit: 100,
  email_sender_name: 'GetHome', ai_provider: 'template', email_provider: 'resend', send_spacing_ms: 700, daily_whatsapp_limit: 50, reply_to_email: 'gethome.realest@gmail.com', outreach_whatsapp_number: '09077246534', retention_days_unengaged: 365,
};

async function getSettings(db) {
  const out = Object.assign({}, DEFAULTS);
  try {
    const { data } = await db.from('gx_settings').select('key, value');
    (data || []).forEach((r) => { out[r.key] = r.value; });
  } catch (e) { /* defaults apply */ }
  return out;
}

// Latest explicit consent event for a prospect + channel (append-only history), or null.
async function latestConsent(db, prospectId, channel) {
  const { data } = await db.from('gx_consent_records').select('event, basis, source, occurred_at')
    .eq('prospect_id', prospectId).eq('channel', channel).order('occurred_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

const BLOCKED_STAGES = ['subscribed', 'lost', 'applied', 'approved']; // already registered, paying, or dropped

// Returns { ok, basis, reason }. `contact` is a gx_prospect_contacts row (or null for prospect-level checks).
async function evaluateSend(db, prospect, contact, channel, settings) {
  const s = settings || await getSettings(db);
  const no = (reason) => ({ ok: false, basis: null, reason });

  if (channel !== 'email' && channel !== 'whatsapp') return no('unsupported_channel');
  if (!contact) return no('no_contact');
  if (channel === 'email' && contact.channel !== 'email') return no('wrong_contact_channel');
  if (channel === 'whatsapp' && contact.channel === 'email') return no('wrong_contact_channel');

  if (prospect.do_not_contact) return no('opted_out');
  const { data: sup } = await db.from('gx_suppressions').select('value').in('value', [contact.value, prospect.phone, prospect.email].filter(Boolean)).limit(1);
  if (sup && sup.length) return no('suppressed');
  if (contact.verification_status === 'invalid' || contact.verification_status === 'bounced') return no('contact_' + contact.verification_status);
  if (BLOCKED_STAGES.indexOf(prospect.stage) !== -1) return no('stage_' + prospect.stage);

  const attempts = channel === 'email' ? (prospect.email_attempts || 0) : (prospect.whatsapp_attempts || 0);
  const maxAttempts = Number(channel === 'email' ? s.max_email_attempts : s.max_whatsapp_attempts) || 2;
  if (attempts >= maxAttempts) return no('max_attempts_reached');

  const { data: open } = await db.from('gx_replies').select('id').eq('prospect_id', prospect.id).eq('needs_human', true).eq('handled', false).limit(1);
  if (open && open.length) return no('reply_awaiting_human');

  const c = await latestConsent(db, prospect.id, channel);
  if (c && c.event === 'withdrawn') return no('consent_withdrawn');
  if (c && c.event === 'granted') return { ok: true, basis: c.basis, reason: null };

  if (channel === 'whatsapp') return no('whatsapp_requires_opt_in');
  // Email with no explicit consent: B2B legitimate interest, only when enabled and the contact's origin is recorded.
  if (!s.li_b2b_email_enabled) return no('legitimate_interest_not_enabled');
  if (!(contact.source_url || prospect.source_url)) return no('source_not_recorded');
  return { ok: true, basis: 'legitimate_interest_b2b', reason: null };
}

// Appends a consent event and refreshes the prospect's denormalised permission + pipeline stage.
async function recordConsent(db, rec) {
  const row = {
    prospect_id: rec.prospect_id, contact_id: rec.contact_id || null, channel: rec.channel, event: rec.event,
    basis: rec.basis, source: rec.source, evidence: rec.evidence || null, recorded_by: rec.recorded_by,
    occurred_at: rec.occurred_at || new Date().toISOString(),
  };
  const { data, error } = await db.from('gx_consent_records').insert([row]).select().single();
  if (error) throw error;

  const col = rec.channel === 'whatsapp' ? 'whatsapp_permission' : (rec.channel === 'email' ? 'email_permission' : null);
  if (col) {
    const upd = {}; upd[col] = rec.event === 'granted' ? 'granted' : 'withdrawn';
    if (rec.event === 'granted') {
      const { data: p } = await db.from('gx_prospects').select('stage').eq('id', rec.prospect_id).maybeSingle();
      if (p && (p.stage === 'new' || p.stage === 'qualified')) upd.stage = 'permission_obtained';
    }
    await db.from('gx_prospects').update(upd).eq('id', rec.prospect_id);
  }
  return data;
}

module.exports = { DEFAULTS, getSettings, latestConsent, evaluateSend, recordConsent };
