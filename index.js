const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const app  = express();
const PORT = process.env.PORT || 5000;
// ── Environment Variable Validation ────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const MISSING_ENV = REQUIRED_ENV.filter(k => !process.env[k]);
if (MISSING_ENV.length > 0) {
  console.error('FATAL: Missing environment variables:', MISSING_ENV.join(', '));
  console.error('Please set them in Render environment settings.');
  process.exit(1);
}
console.log('ENV check passed:', {
  SUPABASE_URL: process.env.SUPABASE_URL ? 'SET' : 'MISSING',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'SET' : 'MISSING',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? 'SET' : 'MISSING',
  RESEND_API_KEY: process.env.RESEND_API_KEY ? 'SET' : 'MISSING',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ? 'SET' : 'MISSING',
});
const allowedOrigins = [
  'https://trygethome.online',
  'https://www.trygethome.online',
  'https://gethome.online',
  'https://www.gethome.online',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
];
// ── CORS - must be before all routes ───────────────────
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile, curl, Render health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    console.error('CORS blocked request from origin:', origin);
    return callback(new Error('Not allowed by CORS: ' + origin), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400, // 24 hours preflight cache
}));
// Handle OPTIONS preflight explicitly
app.options('*', cors());
app.use(express.json());
// ── Supabase ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// Service-role client — bypasses RLS for trusted server-side writes.
// Auth is still enforced manually (we verify the JWT before using this).
const serviceClient = process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : supabase;
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
  tls: { rejectUnauthorized: false },
});
// Send email to admin
async function sendAdminEmail(subject, text) {
  if (!process.env.ADMIN_EMAIL) return;
  await sendCustomerEmail(process.env.ADMIN_EMAIL, subject, text);
}
// Send email to customer - never blocks main flow
async function sendCustomerEmail(to, subject, text) {
  if (!to) { console.log('Email skipped - no recipient'); return; }
  const resendKey = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
  // Try Resend HTTP API first (most reliable)
  if (resendKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `GetHome <${process.env.SMTP_FROM || 'noreply@trygethome.online'}>`,
          to: [to],
          subject,
          text,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px;color:#374151">
            <h2 style="color:#0a2240">GetHome</h2>
            <div style="white-space:pre-line;line-height:1.7">${text}</div>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <div style="text-align:center;margin:20px 0">
              <a href="https://trygethome.online"
                style="display:inline-block;padding:12px 28px;background-color:#27ae60;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px">
                Open GetHome App
              </a>
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center">trygethome.online</p>
          </div>`,
        }),
      });
      const result = await response.json();
      if (response.ok) {
        console.log('Email sent via Resend API to:', to, '| ID:', result.id);
        return;
      }
      console.error('Resend API error:', result);
    } catch (err) {
      console.error('Resend API failed, trying SMTP:', err.message);
    }
  }
  // Fallback to SMTP
  if (process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: `"GetHome" <${process.env.SMTP_USER || 'noreply@trygethome.online'}>`,
        to, subject, text,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
          <h2 style="color:#0a2240">GetHome</h2>
          <div style="white-space:pre-line;line-height:1.7;color:#374151">${text}</div>
          <div style="text-align:center;margin:24px 0">
            <a href="https://trygethome.online" style="display:inline-block;padding:12px 28px;background:#27ae60;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Open GetHome App</a>
          </div>
          <p style="color:#94a3b8;font-size:12px;text-align:center">trygethome.online</p>
        </div>`,
      });
      console.log('Email sent via SMTP to:', to);
    } catch (err) {
      console.error('SMTP also failed:', err.message);
    }
  } else {
    console.log('No email credentials configured - skipping email to:', to);
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
  res.json({
    status: 'ok',
    message: 'GetHome Backend is LIVE',
    timestamp: new Date().toISOString(),
    supabase_configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    service_key_configured: !!process.env.SUPABASE_SERVICE_KEY,
  });
});
// Test email endpoint - visit /test-email?to=youremail@gmail.com to test
app.get('/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Add ?to=youremail@gmail.com to the URL' });
  try {
    console.log('Testing email to:', to);
    console.log('SMTP config:', {
      host: process.env.SMTP_HOST || 'smtp.resend.com',
      port: process.env.SMTP_PORT || 465,
      user: process.env.SMTP_USER || 'resend',
      passSet: !!process.env.SMTP_PASS,
    });
    await transporter.sendMail({
      from: `"GetHome" <${process.env.SMTP_USER || 'noreply@trygethome.online'}>`,
      to,
      subject: 'GetHome Email Test',
      text: 'This is a test email from GetHome backend. If you see this, email is working!',
    });
    res.json({ success: true, message: 'Test email sent to ' + to });
  } catch (err) {
    console.error('Test email error:', err);
    res.status(500).json({ success: false, error: err.message, code: err.code, smtp: { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER, passSet: !!process.env.SMTP_PASS } });
  }
});
// ──────────────────────────────────────────────────────────
// VIDEO UPLOAD
// ──────────────────────────────────────────────────────────
const multer = require('multer');
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: function(req, file, cb) {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});
app.post('/api/upload-video', uploadMiddleware.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });
  try {
    const fileName = `videos/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    console.log('Uploading video:', { fileName, bucket: 'property-media' });
    const { data, error } = await serviceClient.storage
      .from('property-media')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });
    if (error) throw error;
    const { data: urlData } = serviceClient.storage.from('property-media').getPublicUrl(fileName);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    console.error('Video upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// KYC DOCUMENT UPLOAD (Private bucket - admin read only)
// ──────────────────────────────────────────────────────────
const multerKYC = require('multer');
const kycUpload = multerKYC({
  storage: multerKYC.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: function(req, file, cb) {
    var allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only images and PDFs allowed'));
  }
});
app.post('/api/upload-kyc', kycUpload.single('file'), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { userId, fileName } = req.body;
    const safeName = fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = `${userId || user.id}/${safeName}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    // Upload to private KYC bucket - NOT public
    const { data, error } = await supabase.storage
      .from('agent-kyc-documents')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });
    if (error) throw error;
    // Return file path only - not a public URL (admin must use service key to view)
    res.json({ url: filePath, path: data.path });
  } catch (err) {
    console.error('KYC upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Agent submits verification data
app.post('/api/agent/submit-verification', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { targetTier, phone, nin, selfieUrl, cacUrl, govIdUrl, propAuthUrl,
            references, officeAddress, emergencyContact, guarantorInfo,
            ghana_card_number, orc_number } = req.body;
    const { error } = await supabase
      .from('profiles')
      .update({
        phone,
        nin_number: nin,
        office_address: officeAddress || null,
        emergency_contact: emergencyContact || null,
        guarantor_info: guarantorInfo || null,
        kyc_documents: { selfieUrl, cacUrl, govIdUrl, propAuthUrl },
        references: references || [],
        verification_requested_tier: targetTier,
        verification_status: 'submitted',
        ghana_card_number: ghana_card_number || null,
        orc_number: orc_number || null,
      })
      .eq('id', user.id);
    if (error) throw error;
    // Notify admin
    setImmediate(async function() {
      try {
        await sendAdminEmail(
          'Agent Verification Submitted - GetHome',
          `Agent ${user.email} has submitted verification documents for tier: ${targetTier}\n\nPlease review in the Admin Dashboard.`
        );
      } catch(e) { console.error('Admin notify error:', e.message); }
    });
    res.json({ success: true, message: 'Verification submitted successfully' });
  } catch (err) {
    console.error('Verification submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Admin get signed URL for KYC document (service key required)
app.post('/api/admin/kyc-url', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Service key not configured' });
    const adminKYC = require('@supabase/supabase-js').createClient(
      process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: callerP } = await adminKYC.from('profiles').select('role').eq('id', user.id).single();
    if (callerP?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { filePath } = req.body;
    const { data, error } = await adminKYC.storage
      .from('agent-kyc-documents')
      .createSignedUrl(filePath, 300); // 5 min expiry
    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (err) {
    console.error('KYC URL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ──────────────────────────────────────────────────────────
// Get all agents (admin only)
app.get('/api/admin/agents', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    // Use service key client for reliable token verification
    const adminClient = process.env.SUPABASE_SERVICE_KEY
      ? require('@supabase/supabase-js').createClient(
          process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        )
      : supabase;
    // Verify token - use adminClient for reliability
    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    const user = userData?.user;
    if (authError || !user) {
      console.error('Admin auth error:', authError?.message, '| Token length:', token?.length);
      return res.status(401).json({ error: 'Unauthorized - please log out and log back in to refresh your session' });
    }
    const { data: callerProfile, error: profileErr } = await adminClient
      .from('profiles').select('role').eq('id', user.id).single();
    console.log('Admin check - user:', user.id, 'role:', callerProfile?.role, 'error:', profileErr?.message);
    if (!callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required. Your role: ' + (callerProfile?.role || 'unknown') });
    }
    // Fetch ALL agents - use adminClient to bypass RLS
    const { data: agents, error } = await adminClient
      .from('profiles')
      .select('id, role, status, is_unlimited, created_at, email, full_name, phone, office_address, experience, specialty, nin_number, cac_number, about, verification_level, kyc_documents')
      .eq('role', 'agent')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Profiles fetch error:', error.message);
      throw error;
    }
    console.log(`Fetched ${agents?.length || 0} agents from profiles table`);
    // Email is stored directly in profiles.email column
    // Fall back to auth.admin lookup if email column not populated
    let agentsWithEmail = (agents || []).map(function(agent) {
      return Object.assign({}, agent, {
        email: agent.email || 'Email unavailable'
      });
    });
    // For agents missing email, try auth.admin lookup if service key available
    const agentsMissingEmail = agentsWithEmail.filter(a => a.email === 'Email unavailable');
    if (agentsMissingEmail.length > 0 && process.env.SUPABASE_SERVICE_KEY) {
      const supabaseAdmin = require('@supabase/supabase-js').createClient(
        process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY
      );
      await Promise.all(agentsMissingEmail.map(async function(agent) {
        try {
          const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(agent.id);
          const foundEmail = authUser?.user?.email;
          if (foundEmail) {
            agent.email = foundEmail;
            // Also update the profiles table so future calls are fast
            supabase.from('profiles').update({ email: foundEmail }).eq('id', agent.id).then(() => {}).catch(() => {});
          }
        } catch (e) {
          console.error('Email fallback lookup failed for', agent.id, e.message);
        }
      }));
    }
    console.log('Returning', agentsWithEmail.length, 'agents to admin dashboard');
    res.json(agentsWithEmail);
  } catch (err) {
    console.error('Fetch agents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Approve agent (admin only)
app.post('/api/admin/approve-agent', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const serviceClient_approve = process.env.SUPABASE_SERVICE_KEY
      ? require('@supabase/supabase-js').createClient(
          process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        )
      : supabase;
    const { data: userData_approve, error: authError } = await serviceClient_approve.auth.getUser(token);
    const user = userData_approve?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    const adminClient2 = process.env.SUPABASE_SERVICE_KEY
      ? require('@supabase/supabase-js').createClient(
          process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        )
      : supabase;
    const { data: profile } = await adminClient2.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const { verificationTier } = req.body;
    const validTiers = ['basic', 'verified', 'premium'];
    const tier = validTiers.includes(verificationTier) ? verificationTier : 'basic';
    // Update status and verification level using adminClient to bypass RLS
    const { error } = await adminClient2
      .from('profiles')
      .update({ status: 'approved', verification_level: tier })
      .eq('id', agentId)
      .eq('role', 'agent');
    if (error) throw error;
    console.log('Agent approved:', agentId);
    // Get agent email to notify them
    try {
      const { data: authUser } = await supabase.auth.admin.getUserById(agentId);
      const agentEmail = authUser?.user?.email;
      if (agentEmail) {
        setImmediate(async function() {
          try {
            await sendCustomerEmail(
              agentEmail,
              'Your GetHome Agent Account Has Been Approved!',
              `Congratulations!
Your GetHome agent account has been approved. You can now log in and start listing properties.
Sign in here: https://trygethome.online
Welcome to the GetHome agent network!
The GetHome Team
https://trygethome.online`
            );
          } catch (e) { console.error('Approval email error:', e.message); }
        });
      }
    } catch (e) { console.error('Could not send approval email:', e.message); }
    res.json({ success: true, message: 'Agent approved successfully' });
  } catch (err) {
    console.error('Approve agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Reject agent (admin only)
app.post('/api/admin/reject-agent', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const serviceClient_reject = process.env.SUPABASE_SERVICE_KEY
      ? require('@supabase/supabase-js').createClient(
          process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        )
      : supabase;
    const { data: userData_reject, error: authError } = await serviceClient_reject.auth.getUser(token);
    const user = userData_reject?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    const adminClient3 = process.env.SUPABASE_SERVICE_KEY
      ? require('@supabase/supabase-js').createClient(
          process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        )
      : supabase;
    const { data: profile } = await adminClient3.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const { error } = await adminClient3.from('profiles').update({ status: 'rejected' }).eq('id', agentId);
    if (error) throw error;
    res.json({ success: true, message: 'Agent rejected' });
  } catch (err) {
    console.error('Reject agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Toggle featured status for a property (admin only)
app.patch('/api/admin/properties/:id/feature', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const adminClient = process.env.SUPABASE_SERVICE_KEY
      ? require('@supabase/supabase-js').createClient(
          process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        )
      : supabase;
    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    const user = userData?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { id } = req.params;
    const { is_featured } = req.body;
    if (typeof is_featured !== 'boolean') return res.status(400).json({ error: 'is_featured must be a boolean' });
    const { data, error } = await adminClient
      .from('properties')
      .update({ is_featured })
      .eq('id', id)
      .select();
    if (error) {
      console.error('admin toggleFeatured error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data || data.length === 0) return res.status(404).json({ error: 'Property not found' });
    return res.json({ success: true, message: 'Featured status updated successfully', property: data[0] });
  } catch (err) {
    console.error('Feature toggle error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: 'https://trygethome.online',
        data: {
          role: 'customer',
          status: 'approved',
        },
      },
    });
    // Handle errors - ignore email-related errors since user is still created
    if (error) {
      const errMsg = error.message.toLowerCase();
      const isEmailError = errMsg.includes('sending') ||
                           errMsg.includes('confirmation') ||
                           errMsg.includes('smtp') ||
                           errMsg.includes('email rate') ||
                           errMsg.includes('not send');
      const isAlreadyExists = errMsg.includes('already registered') ||
                               errMsg.includes('already exists') ||
                               errMsg.includes('user already');
      if (isAlreadyExists) {
        return res.status(400).json({ error: 'An account with this email already exists. Please log in instead.' });
      }
      if (!isEmailError) {
        return res.status(400).json({ error: error.message });
      }
      // Email error - log and continue, account was created
      console.error('Supabase email error (account still created):', error.message);
    }
    // Safely get user info - data.user may be null if email error occurred
    const userId    = data?.user?.id    || null;
    const userEmail = data?.user?.email || email;
    const hasSession = !!data?.session;
    // If user was not returned due to email error, try to fetch them
    let finalUserId = userId;
    if (!finalUserId) {
      try {
        const { data: listData } = await supabase.auth.admin.listUsers();
        const found = listData?.users?.find(u => u.email === email);
        if (found) finalUserId = found.id;
      } catch (lookupErr) {
        console.error('User lookup error (non-blocking):', lookupErr.message);
      }
    }
    // Create customer profile with explicit role, status and email
    if (finalUserId) {
      supabase.from('profiles')
        .upsert([{ id: finalUserId, role: 'customer', status: 'approved', email: userEmail }], { onConflict: 'id' })
        .then(() => console.log('Customer profile created for:', userEmail))
        .catch(e => console.error('Profile error (non-blocking):', e.message));
    }
    // Send welcome email - completely non-blocking, never affects response
    setImmediate(async function() {
      try {
        await sendCustomerEmail(
          userEmail,
          'Welcome to GetHome - Verify Your Email',
          `Hello and welcome to GetHome!
Your account has been successfully created.
VERIFY YOUR EMAIL:
Please check your inbox for a separate verification email from GetHome and click the confirmation link inside it.
Once verified, sign in to your account here:
https://trygethome.online
On the GetHome app you can:- Browse verified properties with full fee breakdown- Book inspections- Secure listings with escrow protection
Questions? WhatsApp us: https://wa.me/2349077246534
The GetHome Team
https://trygethome.online`
        );
      } catch (e) {
        console.error('Welcome email failed (non-blocking):', e.message);
      }
    });
    // Always respond successfully - email sending never blocks this
    return res.status(201).json({
      user:  finalUserId ? { id: finalUserId, email: userEmail, role: 'customer' } : null,
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
  const { email, password, fullName, phone, address, experience, specialty, nin, cac, about } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  // Block disposable emails
  const blockedDomains = ['mailinator.com','guerrillamail.com','tempmail.com','throwam.com','yopmail.com','sharklasers.com','trashmail.com'];
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (blockedDomains.includes(emailDomain)) {
    return res.status(400).json({ error: 'Disposable email addresses are not allowed. Please use a real email.' });
  }
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: 'https://trygethome.online',
        data: {
          role: 'agent',
          status: 'pending',
        },
      },
    });
    // Handle Supabase email errors - user may still be created
    if (error) {
      const isEmailError = error.message.toLowerCase().includes('sending') ||
                           error.message.toLowerCase().includes('email') ||
                           error.message.toLowerCase().includes('confirmation');
      if (!isEmailError) {
        return res.status(400).json({ error: error.message });
      }
      console.error('Supabase email error for agent (non-blocking):', error.message);
    }
    // Set role=agent, status=pending, and store email in profiles table
    const agentUserId = data?.user?.id || null;
    if (agentUserId) {
      try {
        const { error: profileErr } = await supabase
          .from('profiles')
          .upsert([{
            id: agentUserId,
            role: 'agent',
            status: 'pending',
            email: email,
            full_name: fullName || null,
            phone: phone || null,
            office_address: address || null,
            experience: experience || null,
            specialty: specialty || null,
            nin_number: nin || null,
            cac_number: cac || null,
            about: about || null,
          }], { onConflict: 'id' });
        if (profileErr) console.error('Agent profile error:', profileErr.message);
        else console.log('Agent profile created: role=agent, status=pending, email:', email);
      } catch (profileErr) {
        console.error('Agent profile upsert failed:', profileErr.message);
      }
    }
    // Send welcome email to agent with WhatsApp link for account approval
    const agentWhatsAppMsg = encodeURIComponent(
      `Hello GetHome, I just registered as an agent with this email: ${email}. Please activate my agent account.`
    );
    const agentWhatsAppLink = `https://wa.me/${process.env.WHATSAPP_NUMBER || "2349077246534"}?text=${agentWhatsAppMsg}`;
    setImmediate(async function() {
      try {
        await sendCustomerEmail(
          email,
          'GetHome Agent Registration - Next Steps',
          `Hello!
Thank you for registering as a GetHome agent.
STEP 1 - VERIFY YOUR EMAIL:
Check your inbox for a verification email from GetHome and click the confirmation link.
STEP 2 - CONTACT US ON WHATSAPP:
After verifying, message us on WhatsApp to activate your agent account:
${agentWhatsAppLink}
Tell us: "I just registered as an agent with email: ${email}"
STEP 3 - SIGN IN TO YOUR ACCOUNT:
Once approved, sign in here to start listing properties:
https://trygethome.online
We approve agent accounts within 24 hours.
Questions? WhatsApp: https://wa.me/${process.env.WHATSAPP_NUMBER || "2349077246534"}
The GetHome Team
https://trygethome.online`
        );
        console.log('Agent welcome email sent to:', email);
      } catch (emailErr) {
        console.error('Agent welcome email error:', emailErr.message);
      }
    });
    // Notify admin of new agent registration
    setImmediate(async function() {
      try {
        await sendAdminEmail(
          'New Agent Registration - GetHome',
          `A new agent has registered:\n\nEmail: ${email}\nTime: ${new Date().toISOString()}\n\nPlease review and approve this agent account.`
        );
      } catch (emailErr) {
        console.error('Admin notification error:', emailErr.message);
      }
    });
    const userId    = data?.user?.id    || null;
    const userEmail  = data?.user?.email  || email;
    const hasSession = !!data?.session;
    return res.status(201).json({
      user: userId ? { id: userId, email: userEmail, role: 'agent' } : null,
      token: data?.session?.access_token || null,
      confirmationRequired: !hasSession,
    });
  } catch (err) {
    console.error('Agent register error:', err.message);
    return res.status(500).json({ error: 'Agent registration failed. Please try again.' });
  }
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
    // Force fresh profile fetch - bypass any cache using service key if available
    let role = 'customer';
    let status = 'approved';
    let is_unlimited = false;
    try {
      // Use service key client to bypass RLS and always get latest data
      const profileClient = process.env.SUPABASE_SERVICE_KEY
        ? require('@supabase/supabase-js').createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY,
            { auth: { autoRefreshToken: false, persistSession: false } }
          )
        : supabase;
      const { data: profile, error: profileError } = await profileClient
        .from('profiles')
        .select('role, status, is_unlimited, verification_level')
        .eq('id', data.user.id)
        .single();
      if (profileError) {
        console.error('Profile fetch error on login:', profileError.message);
        // If profile missing entirely, create one so future logins work
        if (profileError.code === 'PGRST116') { // not found
          console.log('Profile missing for user - creating default customer profile');
          await profileClient.from('profiles').upsert([{
            id: data.user.id,
            role: 'customer',
            status: 'approved',
            email: email,
          }], { onConflict: 'id' }).catch(e => console.error('Profile create failed:', e.message));
        }
      } else if (profile) {
        role         = profile.role         || 'customer';
        status       = profile.status       || 'approved';
        is_unlimited = profile.is_unlimited || false;
        console.log(`Login: ${email} | role=${role} | status=${status} | unlimited=${is_unlimited}`);
      }
      // Admins are always approved
      if (role === 'admin') status = 'approved';
      // CRITICAL: if agent status is still null/undefined, treat as pending not approved
      if (role === 'agent' && (!status || status === 'null')) {
        status = 'pending';
        console.log(`Agent ${email} has no status - treating as pending`);
      }
    } catch (profileErr) {
      console.error('Profile fetch failed:', profileErr.message);
    }
    // If agent is pending - return special flag so frontend can block login
    const isPendingAgent = role === 'agent' && status === 'pending';
    console.log(`Login response: ${email} | role=${role} | status=${status} | pending=${isPendingAgent}`);
    res.status(200).json({
      user:  { id: data.user.id, email: data.user.email, role, status, is_unlimited },
      pendingAgent: isPendingAgent,
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
    let status = 'approved';
    let is_unlimited = false;
    try {
      // Use service key for fresh non-cached profile data
      const meClient = process.env.SUPABASE_SERVICE_KEY
        ? require('@supabase/supabase-js').createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY,
            { auth: { autoRefreshToken: false, persistSession: false } }
          )
        : supabase;
      const { data: profile } = await meClient
        .from('profiles')
        .select('role, status, is_unlimited')
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
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      console.error('Properties fetch: Supabase env vars missing');
      return res.status(500).json({ error: 'Database not configured on server' });
    }
    const { data, error } = await supabase.from('properties').select('*').order('id', { ascending: false });
    if (error) {
      console.error('Supabase properties error:', error.message, '| code:', error.code);
      return res.status(500).json({ error: error.message });
    }
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
    console.log('Uploading image:', { fileName, bucket: 'property-images' });
    const { data, error } = await serviceClient.storage
      .from('property-images')
      .upload(fileName, buffer, {
        contentType: fileType,
        upsert: true,
      });
    if (error) throw error;
    // Get public URL
    const { data: urlData } = serviceClient.storage
      .from('property-images')
      .getPublicUrl(fileName);
    res.status(200).json({ url: urlData.publicUrl });
  } catch (err) {
    console.error("Image upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/properties', async (req, res) => {
  const { title, location, price, image_url, video_url, description, bedrooms, bathrooms, rent, agency_fee, agreement_fee, caution_fee, service_charge, is_featured, created_by } = req.body;
  if (!title || !location || !price) return res.status(400).json({ error: "title, location, and price are required." });
  try {
    // Resolve agent ID and build a JWT-scoped client so RLS sees auth.uid()
    let agentId = created_by || null;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const { data: userData, error: authErr } = await supabase.auth.getUser(token);
      if (!authErr && userData?.user?.id) {
        agentId = userData.user.id;
      } else if (authErr) {
        console.error('uploadProperty auth lookup error:', authErr.message);
      }
    }
    // Authenticated client: passes the user's JWT so Supabase RLS evaluates
    // auth.uid() correctly for this request.
    const userSupabase = token
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: 'Bearer ' + token } },
        })
      : serviceClient;
    const { data, error } = await userSupabase.from('properties').insert([{
      title,
      location,
      description:    description                || null,
      bedrooms:       bedrooms                   || null,
      bathrooms:      bathrooms                  || null,
      price:          parseFloat(price)          || 0,
      image_url:      image_url                  || null,
      video_url:      video_url                  || null,
      rent:           parseFloat(rent)           || parseFloat(price) || 0,
      agency_fee:     parseFloat(agency_fee)     || 0,
      agreement_fee:  parseFloat(agreement_fee)  || 0,
      caution_fee:    parseFloat(caution_fee)    || 0,
      service_charge: parseFloat(service_charge) || 0,
      is_featured:    is_featured === true || is_featured === 'true' || false,
      created_by:     agentId,
    }]).select();
    if (error) {
      console.error('uploadProperty insert error:', error.message, error.code, error.details, error.hint);
      throw error;
    }
    res.status(201).json(data[0]);
  } catch (err) {
    console.error('uploadProperty unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});
// PUT /api/properties/:id  — update an existing listing
app.put('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  const { title, location, price, image_url, video_url, description, bedrooms, bathrooms, rent, agency_fee, agreement_fee, caution_fee, service_charge, is_featured } = req.body;
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
        video_url:      video_url                  || null,
        description:    description                || null,
        bedrooms:       bedrooms                   || null,
        bathrooms:      bathrooms                  || null,
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
  } catch (error) {
    console.error("Error updating property:", error.message);
    res.status(500).json({ error: error.message });
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
// PATCH /api/properties/:id/toggle-featured  — set is_featured directly
app.patch('/api/properties/:id/toggle-featured', async (req, res) => {
  const { id } = req.params;
  const { is_featured } = req.body;
  if (typeof is_featured !== 'boolean') {
    return res.status(400).json({ error: 'is_featured must be a boolean' });
  }
  try {
    const { data, error } = await supabase
      .from('properties')
      .update({ is_featured })
      .eq('id', id)
      .select();
    if (error) {
      console.error('toggleFeatured error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data || data.length === 0) return res.status(404).json({ error: 'Property not found' });
    return res.json({ success: true, updated: data[0] });
  } catch (err) {
    console.error('toggleFeatured unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
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
// Global error handler - catches all unhandled errors
app.use(function(err, req, res, next) {
  console.error('Unhandled error:', err.message, '| Origin:', req.headers.origin);
  if (err.message && err.message.toLowerCase().includes('cors')) {
    return res.status(403).json({ error: 'CORS blocked this request', origin: req.headers.origin || 'unknown' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});
// 404 handler
app.use(function(req, res) {
  res.status(404).json({ error: 'Route not found: ' + req.method + ' ' + req.path });
});
app.listen(PORT, () => console.log(` GetHome backend running on port ${PORT}`));