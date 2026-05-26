const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const app  = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());
// ── Supabase ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// ── Nodemailer ─────────────────────────────────────────────
// Render env vars needed: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_EMAIL
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
// Tiny helper so we don't repeat try/catch in every email send
async function sendAdminEmail(subject, text) {
  await transporter.sendMail({
    from:    `"GetHome Platform" <${process.env.SMTP_USER}>`,
    to:      process.env.ADMIN_EMAIL,
    subject,
    text,
  });
}
// ──────────────────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(" GetHome Backend is officially LIVE and talking to the Frontend!");
});
// ──────────────────────────────────────────────────────────
// AUTH
// ──────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)      return res.status(400).json({ error: "Email and password are required." });
  if (password.length < 6)      return res.status(400).json({ error: "Password must be at least 6 characters." });
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({
      user:  { id: data.user.id, email: data.user.email },
      token: data.session?.access_token || null,
      confirmationRequired: !data.session,
    });
  } catch (err) { res.status(500).json({ error: "Internal error during sign-up." }); }
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    // Fetch the user's role from your public 'profiles' table.
    // Expected schema: profiles(id uuid references auth.users, role text)
    // Role values: 'customer' (default), 'agent', 'admin'
    let role = 'customer';
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single();
      if (profile?.role) role = profile.role;
    } catch {
      // profiles table may not exist yet — default to 'customer', no crash
    }
    res.status(200).json({
      user:  { id: data.user.id, email: data.user.email, role },
      token: data.session?.access_token,
    });
  } catch (err) { res.status(500).json({ error: "Internal error during login." }); }
});
app.post('/api/auth/logout', async (req, res) => {
  try { await supabase.auth.signOut(); } catch {}
  res.status(200).json({ success: true });
});
// GET /api/auth/me
// Returns the current user's profile including role.
// Requires the Authorization header: "Bearer <token>"
// Frontend can call this after restoring session from localStorage
// to refresh role without requiring a full re-login.
app.get('/api/auth/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: "No token provided." });
  try {
    // Verify the token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired token." });
    let role = 'customer';
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      if (profile?.role) role = profile.role;
    } catch { /* profiles table not set up yet — safe default */ }
    res.status(200).json({ user: { id: user.id, email: user.email, role } });
  } catch (err) {
    console.error('/api/auth/me error:', err.message);
    res.status(500).json({ error: "Internal error fetching user profile." });
  }
});
// ──────────────────────────────────────────────────────────
// PROPERTIES
// ──────────────────────────────────────────────────────────
app.get('/api/properties', async (req, res) => {
  try {
    const { data, error } = await supabase.from('properties').select('*').order('id', { ascending: false });
    if (error) throw error;
    const out = data.map(p => {
      const rent    = parseFloat(p.rent)           || 0;
      const agency  = parseFloat(p.agency_fee)     || 0;
      const agree   = parseFloat(p.agreement_fee)  || 0;
      const caution = parseFloat(p.caution_fee)    || 0;
      const svc     = parseFloat(p.service_charge) || 0;
      return { ...p, rent, agency_fee: agency, agreement_fee: agree, caution_fee: caution, service_charge: svc, total_payment: rent + agency + agree + caution + svc };
    });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// POST /api/upload-image
// Receives base64 image data, uploads to Supabase Storage, returns public URL
app.post('/api/upload-image', async (req, res) => {
  const { fileName, fileType, fileData } = req.body;
  if (!fileName || !fileType || !fileData) {
    return res.status(400).json({ error: "fileName, fileType, and fileData are required." });
  }
  try {
    // Strip base64 prefix (data:image/jpeg;base64,XXXX)
    const base64Data = fileData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const { data, error } = await supabase.storage
      .from('property-images')
      .upload(fileName, buffer, {
        contentType: fileType,
        upsert: true,
      });
    if (error) throw error;
    // Get public URL
    const { data: urlData } = supabase.storage
      .from('property-images')
      .getPublicUrl(fileName);
    res.status(200).json({ url: urlData.publicUrl });
  } catch (err) {
    console.error("Image upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/properties', async (req, res) => {
  const { title, location, price, image_url, rent, agency_fee, agreement_fee, caution_fee, service_charge } = req.body;
  if (!title || !location || !price) return res.status(400).json({ error: "title, location, and price are required." });
  try {
    const { data, error } = await supabase.from('properties').insert([{
      title,
      location,
      price:          parseFloat(price)          || 0,
      image_url:      image_url                  || null,
      rent:           parseFloat(rent)           || parseFloat(price) || 0,
      agency_fee:     parseFloat(agency_fee)     || 0,
      agreement_fee:  parseFloat(agreement_fee)  || 0,
      caution_fee:    parseFloat(caution_fee)    || 0,
      service_charge: parseFloat(service_charge) || 0,
    }]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// PUT /api/properties/:id  — update an existing listing
app.put('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  const { title, location, price, image_url, rent, agency_fee, agreement_fee, caution_fee, service_charge } = req.body;
  if (!title || !location || !price) {
    return res.status(400).json({ error: "title, location, and price are required." });
  }
  try {
    const { data, error } = await supabase
      .from('properties')
      .update({
        title,
        location,
        price:          parseFloat(price)          || 0,
        image_url:      image_url                  || null,
        rent:           parseFloat(rent)           || parseFloat(price) || 0,
        agency_fee:     parseFloat(agency_fee)     || 0,
        agreement_fee:  parseFloat(agreement_fee)  || 0,
        caution_fee:    parseFloat(caution_fee)    || 0,
        service_charge: parseFloat(service_charge) || 0,
      })
      .eq('id', id)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Property not found." });
    res.status(200).json(data[0]);
  } catch (err) {
    console.error("Error updating property:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// DELETE /api/properties/:id  — permanently remove a listing
app.delete('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('properties')
      .delete()
      .eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true, deletedId: id });
  } catch (err) {
    console.error("Error deleting property:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// ESCROW NOTIFICATION
// Called by frontend after Paystack escrow payment success.
// Logs the transaction and dispatches admin email.
// ──────────────────────────────────────────────────────────
app.post('/api/escrow-notify', async (req, res) => {
  const {
    reference, amount_naira, escrow_fee_naira,
    user_id, user_email,
    property_id, property_title, property_location,
    add_ons = {},
  } = req.body;
  if (!reference || !property_id) return res.status(400).json({ error: "reference and property_id required." });
  // Optional: log to Supabase transactions table
  // Uncomment once you create the table:
  // await supabase.from('transactions').insert([{
  //   paystack_ref: reference, amount_naira, escrow_fee_naira,
  //   user_id, user_email, property_id,
  //   add_on_cleaning: add_ons.cleaning || false,
  //   add_on_relocation: add_ons.relocation || false,
  //   type: 'escrow', status: 'confirmed', created_at: new Date().toISOString(),
  // }]);
  const addOnLines = [
    add_ons.cleaning   && '  • Professional Deep Cleaning (₦92,000 — GetHome cut: ₦12,000)',
    add_ons.relocation && '  • Relocation & Haulage (₦230,000 — GetHome cut: ₦30,000)',
  ].filter(Boolean).join('\n') || '  None selected';
  const body = `
 NEW ESCROW DEPOSIT — ACTION REQUIRED
=========================================
Paystack Reference : ${reference}
Amount Paid (₦)    : ₦${Number(amount_naira).toLocaleString('en-NG')}
Escrow Fee (₦)     : ₦${Number(escrow_fee_naira || 0).toLocaleString('en-NG')}
CUSTOMER--------
User ID    : ${user_id    || 'N/A'}
User Email : ${user_email || 'N/A'}
PROPERTY--------
Listing ID : ${property_id}
Title      : ${property_title}
Location   : ${property_location}
ADD-ON SERVICES OPTED IN-------------------------
${addOnLines}
REVENUE SUMMARY FOR THIS TRANSACTION-------------------------------------
  Escrow Processing Fee (kept by platform) : ₦${Number(escrow_fee_naira || 0).toLocaleString('en-NG')}
  Cleaning commission (if opted in)        : ₦${add_ons.cleaning   ? '12,000' : '0'}
  Relocation commission (if opted in)      : ₦${add_ons.relocation ? '30,000' : '0'}
NEXT STEPS----------
  1. Verify payment on the Paystack dashboard (ref above).
  2. Assign an inspection officer to this listing.
  3. Contact the customer to confirm their inspection slot.
  4. Dispatch cleaning / moving vendors if add-ons selected.
=========================================
  `.trim();
  try {
    await sendAdminEmail(` Escrow Confirmed — ${property_title} (Ref: ${reference})`, body);
    console.log(` Escrow notification sent. Ref: ${reference}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Escrow email error:", err.message);
    res.status(200).json({ success: false, warning: "Payment captured but email failed. Check SMTP config." });
  }
});
// ──────────────────────────────────────────────────────────
// PROXY INSPECTION NOTIFICATION
// Called after a customer pays ₦12,500 for a GetHome proxy
// inspection. Alerts the ops team to schedule a site visit.
// ──────────────────────────────────────────────────────────
app.post('/api/inspection-notify', async (req, res) => {
  const { reference, amount_naira, user_email, property_id, property_title, property_location } = req.body;
  if (!reference || !property_id) return res.status(400).json({ error: "reference and property_id required." });
  // Optional Supabase log:
  // await supabase.from('transactions').insert([{
  //   paystack_ref: reference, amount_naira,
  //   user_email, property_id, type: 'proxy_inspection', status: 'confirmed',
  //   created_at: new Date().toISOString(),
  // }]);
  const body = `
 PROXY INSPECTION BOOKED — ACTION REQUIRED
==============================================
A customer has paid for a GetHome Proxy Inspection.
Please schedule a site visit within 24 hours.
Paystack Reference : ${reference}
Amount Paid (₦)    : ₦${Number(amount_naira).toLocaleString('en-NG')}
CUSTOMER--------
Email : ${user_email || 'N/A'}
PROPERTY--------
Listing ID : ${property_id}
Title      : ${property_title}
Location   : ${property_location}
DELIVERABLE TO CUSTOMER-----------------------
  • Full physical site visit by GetHome inspector
  • Video walkthrough of all rooms + structure
  • Written defect / condition report
  • Delivered within 48 hours of booking
NEXT STEPS----------
  1. Assign a field inspector to this property.
  2. Coordinate access with the listing agent.
  3. Record and edit the inspection video.
  4. Send the video + report to ${user_email || 'the customer'}.
==============================================
  `.trim();
  try {
    await sendAdminEmail(` Proxy Inspection Booked — ${property_title} (Ref: ${reference})`, body);
    console.log(` Inspection notification sent. Ref: ${reference}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Inspection email error:", err.message);
    res.status(200).json({ success: false, warning: "Payment captured but email failed." });
  }
});
// ──────────────────────────────────────────────────────────
// AGENT TIER UPGRADE
// Called after agent pays for Premium or Agency plan upgrade.
// Records the upgrade and sends admin confirmation.
// ──────────────────────────────────────────────────────────
app.post('/api/agent/upgrade', async (req, res) => {
  const { reference, tier, agent_email } = req.body;
  if (!reference || !tier || !agent_email) return res.status(400).json({ error: "reference, tier, and agent_email required." });
  const tierConfig = { free: { label: 'Free', limit: 3 }, premium: { label: 'Premium', limit: 15 }, agency: { label: 'Agency', limit: 100 } };
  const t = tierConfig[tier] || tierConfig.premium;
  // Optional Supabase log:
  // await supabase.from('agent_upgrades').insert([{
  //   paystack_ref: reference, tier, agent_email,
  //   listing_limit: t.limit, created_at: new Date().toISOString(),
  // }]);
  const body = `
 AGENT TIER UPGRADE — ${t.label.toUpperCase()}
=============================================
An agent has upgraded their listing plan.
Paystack Reference : ${reference}
Agent Email        : ${agent_email}
New Tier           : ${t.label}
Listing Limit      : ${t.limit} active listings
ACTION REQUIRED---------------
  1. Update this agent's tier in your admin records.
  2. If Agency plan: set up their dedicated Agency Profile page.
  3. Send a welcome email confirming their new plan.
=============================================
  `.trim();
  try {
    await sendAdminEmail(` Agent Upgraded to ${t.label} — ${agent_email}`, body);
    console.log(` Agent upgrade notification sent. Ref: ${reference}`);
    res.status(200).json({ success: true, tier, listingLimit: t.limit });
  } catch (err) {
    console.error("Agent upgrade email error:", err.message);
    res.status(200).json({ success: false, warning: "Payment captured but email failed." });
  }
});
// ──────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────
app.put('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  const { title, location, price, image_url, rent, agency_fee, agreement_fee, caution_fee, service_charge } = req.body;
  if (!title || !location || !price) {
    return res.status(400).json({ error: "title, location, and price are required." });
  }
  try {
    const { data, error } = await supabase
      .from('properties')
      .update({ title, location, price: parseFloat(price) || 0, image_url: image_url || null, rent: parseFloat(rent) || 0, agency_fee: parseFloat(agency_fee) || 0, agreement_fee: parseFloat(agreement_fee) || 0, caution_fee: parseFloat(caution_fee) || 0, service_charge: parseFloat(service_charge) || 0 })
      .eq('id', id)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Property not found." });
    res.status(200).json(data[0]);
  } catch (err) {
    console.error("Error updating property:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('properties')
      .delete()
      .eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true, deletedId: id });
  } catch (err) {
    console.error("Error deleting property:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => console.log(` GetHome backend running on port ${PORT}`));