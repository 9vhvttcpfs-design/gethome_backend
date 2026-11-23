// Shared outreach rules used by email, WhatsApp and analytics:
// reply classification, "stop everything for this prospect", and permanent suppression.
'use strict';
const D = require('./dedupe');
const C = require('./consent');

const PENDING = ['draft', 'pending_approval', 'approved', 'queued'];

// Rule-based reply classifier. Deliberately simple and explainable; a person can always override it.
function classifyReply(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  if (/\b(unsubscribe|remove me|opt[ -]?out|take me off|stop (emailing|messaging|contacting|sending)|do not (contact|email|message|text)|don'?t (contact|email|message|text)|stop)\b/.test(t)) return 'unsubscribe';
  if (/(out of (the )?office|auto[- ]?reply|automatic reply|on (annual )?leave|on vacation)/.test(t)) return 'out_of_office';
  if (/(not interested|no thanks|no thank you|not for us|not relevant|we are not|i am not|i'?m not)/.test(t)) return 'not_interested';
  if (/(interested|tell me more|more (info|information|details)|how (much|does|do)|sign me up|call me|sounds good|send (me )?(the )?(details|link)|\byes\b)/.test(t)) return 'interested';
  return 'question';
}

async function suppressValues(db, values, reason, by) {
  const vals = [...new Set((values || []).filter(Boolean))];
  if (!vals.length) return;
  await db.from('gx_suppressions').upsert(vals.map((v) => ({ value: v, reason: reason || 'opt_out', added_by: by || 'system' })), { onConflict: 'value', ignoreDuplicates: true });
  for (const v of vals) {
    const col = v.includes('@') ? 'email' : 'phone';
    await db.from('gx_prospects').update({ do_not_contact: true }).eq(col, v);
    await db.from('gx_leads').update({ do_not_contact: true }).eq(col, v);
  }
}

// Stops every active follow-up sequence for a prospect and cancels messages that have not gone out yet.
async function stopForProspect(db, prospectId, reason) {
  const { data: enrols } = await db.from('gx_sequence_enrollments').select('id').eq('prospect_id', prospectId).eq('status', 'active');
  let stopped = 0;
  for (const e of enrols || []) {
    await db.from('gx_sequence_enrollments').update({ status: 'stopped', stop_reason: reason, next_send_at: null }).eq('id', e.id); stopped++;
  }
  await db.from('gx_messages').update({ status: 'cancelled', last_error: 'stopped: ' + reason }).eq('prospect_id', prospectId).in('status', PENDING);
  return stopped;
}

const STOP_REASON = { opted_out: 'opted_out', suppressed: 'opted_out', consent_withdrawn: 'consent_changed', contact_bounced: 'bounced', contact_invalid: 'bounced', max_attempts_reached: 'max_attempts', reply_awaiting_human: 'reply', stage_subscribed: 'subscribed', stage_applied: 'registered', stage_approved: 'registered', stage_lost: 'admin' };

// Records an inbound reply (any channel), classifies it and applies the consequences.
// Returns { reply, classification }.
async function processReply(db, r) {
  const classification = r.classification || classifyReply(r.body);
  const needsHuman = !['unsubscribe', 'out_of_office', 'not_interested'].includes(classification);
  const { data: reply, error } = await db.from('gx_replies').insert([{
    prospect_id: r.prospect_id, contact_id: r.contact_id || null, message_id: r.message_id || null, channel: r.channel,
    body: String(r.body || '').slice(0, 5000), classification, classified_by: r.classification ? 'human' : 'rules',
    needs_human: needsHuman, raw: r.raw || {},
  }]).select().single();
  if (error) throw error;
  if (classification === 'out_of_office') return { reply, classification };   // an auto-reply must not stop, advance or mark anything as replied

  if (r.message_id) await db.from('gx_messages').update({ status: 'replied' }).eq('id', r.message_id).in('status', ['sent', 'delivered']);
  await stopForProspect(db, r.prospect_id, classification === 'unsubscribe' ? 'opted_out' : 'reply');

  const { data: p } = await db.from('gx_prospects').select('*').eq('id', r.prospect_id).maybeSingle();
  if (!p) return { reply, classification };
  if (classification === 'unsubscribe') {
    const { data: contacts } = await db.from('gx_prospect_contacts').select('value, channel').eq('prospect_id', p.id);
    await suppressValues(db, (contacts || []).map((c) => c.value).concat([p.email, p.phone]), 'opt_out', 'reply');
    await C.recordConsent(db, { prospect_id: p.id, contact_id: r.contact_id || null, channel: r.channel, event: 'withdrawn', basis: 'withdrawn_by_prospect', source: 'reply', evidence: String(r.body || '').slice(0, 300), recorded_by: 'system' });
  } else if (classification === 'interested') {
    if (['new', 'qualified', 'permission_obtained', 'campaign_ready', 'contacted'].includes(p.stage)) await db.from('gx_prospects').update({ stage: 'interested' }).eq('id', p.id);
  } else if (classification === 'not_interested') {
    if (!['applied', 'approved', 'subscribed'].includes(p.stage)) await db.from('gx_prospects').update({ stage: 'lost', lost_reason: 'not interested (reply)' }).eq('id', p.id);
  }
  try { await db.from('gx_prospect_activity').insert([{ prospect_id: p.id, activity: 'reply_' + classification, actor: 'system', payload: { channel: r.channel } }]); } catch (e) { /* best effort */ }
  return { reply, classification };
}

module.exports = { classifyReply, suppressValues, stopForProspect, processReply, STOP_REASON, PENDING };
