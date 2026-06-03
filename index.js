const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const app  = express();
const PORT = process.env.PORT || 5000;
const allowedOrigins = [
  'https://trygethome.online',
  'https://www.trygethome.online',
  'http://localhost:5173',
  'http://localhost:5174',
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());
// ── Supabase ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// ── Nodemailer ─────────────────────────────────────────────
// Render env vars needed: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_EMAIL
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.resend.com',
  port:   Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'resend',
    pass: process.env.SMTP_PASS,
  },
});
// Send email to admin
async function sendAdminEmail(subject, text) {
  await transporter.sendMail({
    from:    `"GetHome Platform" <${process.env.SMTP_USER}>`,
    to:      process.env.ADMIN_EMAIL,
    subject,
    text,
  });
}
// Send email to customer - never blocks main flow
async function sendCustomerEmail(to, subject, text) {
  if (!to || !process.env.SMTP_PASS) {
    console.log('Email skipped - no recipient or SMTP not configured');
    return;
  }
  try {
    await transporter.sendMail({
      from:    `"GetHome" <${process.env.SMTP_USER || 'noreply@trygethome.online'}>`,
      to,
      subject,
      text,
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Email failed to ${to}:`, err.message);
    // Never rethrow - email failures must never break user flows
  }
}
// Send SMS via Termii
// Add TERMII_API_KEY and TERMII_SENDER_ID to Render env vars
async function sendSMS(phone, message) {
  if (!process.env.TERMII_API_KEY || !phone) return;
  try {
    let p = String(phone).replace(/\D/g, '');
    if (p.startsWith('0')) p = '234' + p.slice(1);
    if (!p.startsWith('234')) p = '234' + p;
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      p,
        from:    process.env.TERMII_SENDER_ID || 'GetHome',
        sms:     message,
        type:    'plain',
        channel: 'generic',
        api_key: process.env.TERMII_API_KEY,
      }),
    });
    const data = await res.json();
    console.log('SMS sent:', data.message || data.code);
  } catch (err) {
    console.error('SMS failed:', err.message);
  }
}
// ──────────────────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'GetHome Backend is LIVE', timestamp: new Date().toISOString() });
});
// Self-ping every 14 minutes to prevent Render free tier sleep
setInterval(function() {
  try {
    var https = require('https');
    var url = process.env.RENDER_EXTERNAL_URL || '';
    if (!url) return;
    https.get(url + '/', function(r){ console.log('Keep-alive ping:', r.statusCode); }).on('error', function(){});
  } catch(e) {}
}, 14 * 60 * 1000);
// ──────────────────────────────────────────────────────────
// AUTH
// ──────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  if (password.length < 6)  return res.status(400).json({ error: "Password must be at least 6 characters." });
  // Block disposable emails
  const blockedDomains = ['mailinator.com','guerrillamail.com','tempmail.com','throwam.com','yopmail.com','sharklasers.com'];
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (blockedDomains.includes(emailDomain)) {
    return res.status(400).json({ error: 'Disposable email addresses are not allowed.' });
  }
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    // Safely get user info - data.user may be null if email confirmation pending
    const userId   = data?.user?.id   || null;
    const userEmail = data?.user?.email || email;
    const hasSession = !!data?.session;
    // Create profile - non-blocking
    if (userId) {
      supabase.from('profiles')
        .upsert([{ id: userId, role: 'customer' }], { onConflict: 'id' })
        .then(() => console.log('Profile created for:', userEmail))
        .catch(e  => console.error('Profile error (non-blocking):', e.message));
    }
    // Send welcome email - completely non-blocking, never affects response
    setImmediate(async function() {
      try {
        await sendCustomerEmail(
          userEmail,
          'Welcome to GetHome!',
          `Hello and welcome to GetHome!
Your account has been successfully created.
Please check your inbox and click the verification link to activate your account.
Once verified you can browse properties, book inspections and secure listings.
Questions? WhatsApp: +2349077246534
The GetHome Team`
        );
      } catch (e) {
        console.error('Welcome email failed (non-blocking):', e.message);
      }
    });
    // Always respond successfully - email sending never blocks this
    return res.status(201).json({
      user:  userId ? { id: userId, email: userEmail, role: 'customer' } : null,
      token: data?.session?.access_token || null,
      confirmationRequired: !hasSession,
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    return res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});
// Agent registration - same as signup but sets role to 'agent'
app.post('/api/auth/agent-register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  // Block disposable emails
  const blockedDomains = ['mailinator.com','guerrillamail.com','tempmail.com','throwam.com','yopmail.com','sharklasers.com','trashmail.com'];
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (blockedDomains.includes(emailDomain)) {
    return res.status(400).json({ error: 'Disposable email addresses are not allowed. Please use a real email.' });
  }
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    // Set role to 'agent' in profiles table
    try {
      await supabase.from('profiles').upsert([{ id: data.user.id, role: 'agent' }], { onConflict: 'id' });
    } catch (profileErr) {
      console.error('Agent profile error:', profileErr.message);
    }
    // Notify admin of new agent registration
    try {
      await sendAdminEmail(
        'New Agent Registration - GetHome',
        `A new agent has registered:\n\nEmail: ${email}\nTime: ${new Date().toISOString()}\n\nPlease review and verify this agent account.`
      );
    } catch (emailErr) {
      console.error('Admin notification error:', emailErr.message);
    }
    const userId    = data?.user?.id    || null;
    const userEmail  = data?.user?.email  || email;
    const hasSession = !!data?.session;
    return res.status(201).json({
      user: userId ? { id: userId, email: userEmail, role: 'agent' } : null,
      token: data?.session?.access_token || null,
      confirmationRequired: !hasSession,
    });
  } catch (err) {
  }
    console.error('Agent register error:', err.message);
    return res.status(500).json({ error: 'Agent registration failed. Please try again.' });
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error('Login error:', error.message);
      const msg = error.message.includes('Invalid login') ? 'Invalid email or password. Please try again.' :
                  error.message.includes('Email not confirmed') ? 'Please verify your email before logging in. Check your inbox.' :
                  error.message;
      return res.status(401).json({ error: msg });
    }
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
  const { title, location, price, image_url, rent, agency_fee, agreement_fee, caution_fee, service_charge, is_featured, created_by } = req.body;
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
  const { title, location, price, image_url, rent, agency_fee, agreement_fee, caution_fee, service_charge, is_featured } = req.body;
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
    // Notify admin
    await sendAdminEmail(` Escrow Confirmed — ${property_title} (Ref: ${reference})`, body);
    // Send customer confirmation email
    await sendCustomerEmail(
      user_email,
      `GetHome - Escrow Payment Confirmed for ${property_title}`,
      `Hello,
Your escrow payment has been successfully confirmed!
PAYMENT DETAILS--------------
Reference    : ${reference}
Property     : ${property_title}
Location     : ${property_location}
Amount Paid  : NGN ${Number(amount_naira).toLocaleString('en-NG')}
WHAT HAPPENS NEXT-----------------
1. Our operations team has been notified.
2. An inspection officer will be assigned to your property.
3. We will contact you within 24 hours to confirm your inspection slot.
4. Your funds are held securely in escrow until verification is complete.
For any questions, contact us via WhatsApp: +2349077246534
Thank you for trusting GetHome.
The GetHome Team`
    );
    // Send customer SMS confirmation
    await sendSMS(
      user_email, // Note: replace with user_phone when phone field is added
      `GetHome: Your escrow payment of NGN ${Number(amount_naira).toLocaleString('en-NG')} for ${property_title} is confirmed. Ref: ${reference}. Our team will contact you within 24hrs.`
    );
    console.log(`Escrow notification sent. Ref: ${reference}`);
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
    // Notify admin
    await sendAdminEmail(` Proxy Inspection Booked — ${property_title} (Ref: ${reference})`, body);
    // Send customer confirmation email
    await sendCustomerEmail(
      user_email,
      `GetHome - Proxy Inspection Booked for ${property_title}`,
      `Hello,
Your proxy inspection has been successfully booked and paid for!
INSPECTION DETAILS------------------
Reference    : ${reference}
Property     : ${property_title}
Location     : ${property_location}
Amount Paid  : NGN ${Number(amount_naira).toLocaleString('en-NG')}
WHAT YOU WILL RECEIVE----------------------- A full physical site visit by a GetHome inspector- HD video walkthrough of all rooms and building structure- Written condition and defect report- Delivered to this email address within 48 hours
You do not need to travel or be present. We handle everything.
For any questions, contact us via WhatsApp: +2349077246534
Thank you for choosing GetHome.
The GetHome Team`
    );
    // Send SMS confirmation
    await sendSMS(
      user_email,
      `GetHome: Proxy Inspection booked for ${property_title}. Ref: ${reference}. Your video report will be delivered within 48hrs to your email.`
    );
    console.log(`Inspection notification sent. Ref: ${reference}`);
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
// LEGAL AGREEMENT ACCEPTANCE
// Records when a user accepts Terms, Privacy Policy or
// Agent Agreement. Stored in Supabase for compliance.
// ──────────────────────────────────────────────────────────
app.post('/api/legal/accept', async (req, res) => {
  const { user_id, user_email, agreement_type, version } = req.body;
  // agreement_type: 'terms_and_privacy' | 'agent_agreement'
  if (!user_id || !agreement_type) {
    return res.status(400).json({ error: "user_id and agreement_type are required." });
  }
  try {
    // Log acceptance to Supabase
    // Uncomment once you create the legal_acceptances table:
    // await supabase.from('legal_acceptances').insert([{
    //   user_id,
    //   user_email,
    //   agreement_type,
    //   version: version || '1.0',
    //   accepted_at: new Date().toISOString(),
    //   ip_address: req.ip,
    // }]);
    console.log(`Legal acceptance: ${user_email} accepted ${agreement_type}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Legal acceptance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// AGENT LISTING COUNT
// Returns how many listings an agent has published.
// Used for tier enforcement.
// ──────────────────────────────────────────────────────────
app.get('/api/agent/listing-count/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { count, error } = await supabase
      .from('properties')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', userId);
    if (error) throw error;
    res.status(200).json({ count: count || 0 });
  } catch (err) {
    console.error('Listing count error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(` GetHome backend running on port ${PORT}`));