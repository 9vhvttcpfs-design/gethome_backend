const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const bcrypt     = require('bcrypt');
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
const BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET || 'property-media';
const KYC_BUCKET  = process.env.SUPABASE_KYC_BUCKET     || 'agent-kyc-documents';
console.log('Storage bucket:', BUCKET_NAME);
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
  if (!req.file.buffer) return res.status(400).json({ error: 'No file buffer received' });
  try {
    const fileName = `videos/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    console.log('Uploading video:', { fileName, bucket: BUCKET_NAME });
    const { data, error } = await serviceClient.storage
      .from(BUCKET_NAME)
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });
    if (error) {
      console.error('Upload failed for bucket:', BUCKET_NAME, '| error:', error.message, '| code:', error.statusCode);
      return res.status(500).json({ error: 'Bucket upload error: ' + error.message + ' | Bucket tried: ' + BUCKET_NAME });
    }
    const { data: urlData } = serviceClient.storage.from(BUCKET_NAME).getPublicUrl(data.path);
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
    if (!req.file.buffer) return res.status(400).json({ error: 'No file buffer received' });
    const { userId, fileName } = req.body;
    const safeName = fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = `${userId || user.id}/${safeName}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    // Upload to private KYC bucket - NOT public
    const { data, error } = await supabase.storage
      .from(KYC_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });
    if (error) {
      console.error('KYC upload failed for bucket:', KYC_BUCKET, '| error:', error.message, '| code:', error.statusCode);
      return res.status(500).json({ error: 'Bucket upload error: ' + error.message + ' | Bucket tried: ' + KYC_BUCKET });
    }
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
      .select('id, role, status, is_unlimited, created_at, email, full_name, phone, office_address, experience, specialty, nin_number, cac_number, about, verification_level, kyc_documents, bank_name, account_number, account_name')
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
// ──────────────────────────────────────────────────────────
// AGENT BANK DETAILS
// ──────────────────────────────────────────────────────────
app.post('/api/agent/bank-details', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { bank_name, account_number, account_name } = req.body;
    if (!bank_name || !account_number || !account_name) {
      return res.status(400).json({ error: 'bank_name, account_number, and account_name are required' });
    }
    if (!/^\d{10}$/.test(account_number)) {
      return res.status(400).json({ error: 'account_number must be exactly 10 digits' });
    }
    const { error } = await serviceClient
      .from('profiles')
      .update({ bank_name, account_number, account_name })
      .eq('id', user.id);
    if (error) throw error;
    res.json({ success: true, message: 'Bank details saved successfully' });
  } catch (err) {
    console.error('Save bank details error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// MARK PROPERTY AS SOLD (admin only)
// ──────────────────────────────────────────────────────────
app.post('/api/admin/mark-sold', async (req, res) => {
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
    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { property_id, sold_price } = req.body;
    if (!property_id || sold_price === undefined) return res.status(400).json({ error: 'property_id and sold_price are required' });
    const { data: property, error: fetchErr } = await adminClient
      .from('properties')
      .select('*')
      .eq('id', property_id)
      .single();
    if (fetchErr || !property) return res.status(404).json({ error: 'Property not found' });
    const commission = Math.round(parseFloat(property.agency_fee) * 0.025);
    const { data: updated, error: updateErr } = await adminClient
      .from('properties')
      .update({
        is_sold: true,
        sold_at: new Date().toISOString(),
        sold_price: sold_price,
        commission_amount: commission,
      })
      .eq('id', property_id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    if (property.created_by) {
      const { data: agentProfile } = await adminClient
        .from('profiles')
        .select('email, full_name')
        .eq('id', property.created_by)
        .single();
      if (agentProfile?.email) {
        setImmediate(async function() {
          try {
            await sendCustomerEmail(
              agentProfile.email,
              'Property Sold - Commission Due to GetHome',
              `Hello ${agentProfile.full_name || 'Agent'},

Your property listing "${property.title}" at ${property.location} has been marked as sold.

COMMISSION DUE TO GETHOME
Commission Amount : ₦${Number(commission).toLocaleString('en-NG')}

To receive payment and for us to process commission settlement, please add your bank details in your agent portal at https://trygethome.online.

Thank you for working with GetHome.
The GetHome Team
https://trygethome.online`
            );
          } catch (e) { console.error('Mark sold agent email error:', e.message); }
        });
      }
    }
    res.json({ success: true, property: updated, commission_amount: commission });
  } catch (err) {
    console.error('Mark sold error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// GET ALL TRANSACTIONS (admin only)
// ──────────────────────────────────────────────────────────
app.get('/api/admin/transactions', async (req, res) => {
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
    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { data: properties, error: propsErr } = await adminClient
      .from('properties')
      .select('*')
      .eq('is_sold', true);
    if (propsErr) throw propsErr;
    const agentIds = [...new Set((properties || []).map(p => p.created_by).filter(Boolean))];
    let agentMap = {};
    if (agentIds.length > 0) {
      const { data: agents } = await adminClient
        .from('profiles')
        .select('id, bank_name, account_number, account_name, email, full_name')
        .in('id', agentIds);
      (agents || []).forEach(function(a) { agentMap[a.id] = a; });
    }
    const transactions = (properties || [])
      .map(function(p) { return Object.assign({}, p, { agent: agentMap[p.created_by] || null }); })
      .sort(function(a, b) { return new Date(b.sold_at) - new Date(a.sold_at); });
    res.json(transactions);
  } catch (err) {
    console.error('Get transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// MARK COMMISSION AS PAID (admin only)
// ──────────────────────────────────────────────────────────
app.post('/api/admin/mark-commission-paid', async (req, res) => {
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
    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { property_id } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });
    const commission_reference = 'COMM-' + Date.now();
    const { data: property, error: fetchErr } = await adminClient
      .from('properties')
      .select('title, location, created_by, commission_amount')
      .eq('id', property_id)
      .single();
    if (fetchErr || !property) return res.status(404).json({ error: 'Property not found' });
    const { error: updateErr } = await adminClient
      .from('properties')
      .update({ commission_paid: true, commission_reference })
      .eq('id', property_id);
    if (updateErr) throw updateErr;
    if (property.created_by) {
      const { data: agentProfile } = await adminClient
        .from('profiles')
        .select('email, full_name')
        .eq('id', property.created_by)
        .single();
      if (agentProfile?.email) {
        setImmediate(async function() {
          try {
            await sendCustomerEmail(
              agentProfile.email,
              'GetHome Commission Processed - ' + property.title,
              `Hello ${agentProfile.full_name || 'Agent'},

This is to confirm that your GetHome commission for the property "${property.title}" has been processed.

COMMISSION DETAILS
Property          : ${property.title}
Location          : ${property.location}
Commission Amount : ₦${Number(property.commission_amount || 0).toLocaleString('en-NG')}
Reference         : ${commission_reference}

Thank you for being a valued partner of GetHome.
The GetHome Team
https://trygethome.online`
            );
          } catch (e) { console.error('Commission paid email error:', e.message); }
        });
      }
    }
    res.json({ success: true, commission_reference });
  } catch (err) {
    console.error('Mark commission paid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// GET ALL LISTINGS (admin only)
// ──────────────────────────────────────────────────────────
app.get('/api/admin/all-listings', async (req, res) => {
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
    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { data: properties, error: propsErr } = await adminClient
      .from('properties')
      .select('*')
      .order('created_at', { ascending: false });
    if (propsErr) throw propsErr;
    const agentIds = [...new Set((properties || []).map(p => p.created_by).filter(Boolean))];
    let agentMap = {};
    if (agentIds.length > 0) {
      const { data: agents } = await adminClient
        .from('profiles')
        .select('id, email, full_name, phone, office_address, experience, specialty, nin_number, cac_number, about, verification_level, status, bank_name, account_number, account_name, created_at')
        .in('id', agentIds);
      (agents || []).forEach(function(a) { agentMap[a.id] = a; });
    }
    const enriched = (properties || []).map(function(p) {
      const profile = agentMap[p.created_by] || {};
      return Object.assign({}, p, {
        agent: profile,
        agent_name: profile.full_name || null,
        agent_email: profile.email || null,
        agent_phone: profile.phone || null,
        agent_address: profile.office_address || null,
        agent_experience: profile.experience || null,
        agent_specialty: profile.specialty || null,
        agent_nin: profile.nin_number || null,
        agent_cac: profile.cac_number || null,
        agent_about: profile.about || null,
        agent_verification: profile.verification_level || null,
        agent_status: profile.status || null,
        agent_bank_name: profile.bank_name || null,
        agent_account_number: profile.account_number || null,
        agent_account_name: profile.account_name || null,
        agent_created_at: profile.created_at || null,
      });
    });
    res.json(enriched);
  } catch (err) {
    console.error('Get all listings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// GET AGENT SOLD LISTINGS
// ──────────────────────────────────────────────────────────
app.get('/api/agent/sold-listings', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await serviceClient
      .from('properties')
      .select('*')
      .eq('created_by', user.id)
      .eq('is_sold', true)
      .order('sold_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Get agent sold listings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// DEPOSIT INTENT
// ──────────────────────────────────────────────────────────
app.post('/api/deposit-intent', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { property_id, property_title, property_location, deposit_amount, user_email } = req.body;
    if (!property_id || !deposit_amount) return res.status(400).json({ error: 'property_id and deposit_amount are required' });
    const reference = 'GH-DEP-' + Date.now();
    const { error: updateErr } = await serviceClient
      .from('properties')
      .update({
        deposit_status: 'pending',
        depositor_email: user_email,
        deposit_date: new Date().toISOString(),
        deposit_reference: reference,
        deposit_amount: parseFloat(deposit_amount),
      })
      .eq('id', property_id);
    if (updateErr) throw updateErr;
    setImmediate(async function() {
      try {
        await sendAdminEmail(
          'New Deposit Intent - GetHome',
          `NEW DEPOSIT INTENT
==================
Reference        : ${reference}
Property ID      : ${property_id}
Property Title   : ${property_title || 'N/A'}
Location         : ${property_location || 'N/A'}
Deposit Amount   : ₦${Number(deposit_amount).toLocaleString('en-NG')}
Customer Email   : ${user_email || 'N/A'}

Please review and confirm this deposit in the Admin Dashboard.`
        );
      } catch (e) { console.error('Deposit intent admin email error:', e.message); }
    });
    res.json({ success: true, reference });
  } catch (err) {
    console.error('Deposit intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// ADMIN DEPOSITS
// ──────────────────────────────────────────────────────────
app.get('/api/admin/deposits', async (req, res) => {
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
    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { data: deposits, error: depositsErr } = await adminClient
      .from('properties')
      .select('*')
      .not('deposit_status', 'is', null)
      .neq('deposit_status', 'none')
      .order('deposit_date', { ascending: false });
    if (depositsErr) throw depositsErr;
    res.json(deposits || []);
  } catch (err) {
    console.error('Get deposits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// ADMIN CONFIRM DEPOSIT
// ──────────────────────────────────────────────────────────
app.post('/api/admin/confirm-deposit', async (req, res) => {
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
    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerProfile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { property_id } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });
    const { error: updateErr } = await adminClient
      .from('properties')
      .update({ deposit_confirmed: true, deposit_status: 'confirmed' })
      .eq('id', property_id);
    if (updateErr) throw updateErr;
    const { data: property, error: fetchErr } = await adminClient
      .from('properties')
      .select('title, depositor_email, deposit_reference')
      .eq('id', property_id)
      .single();
    if (fetchErr) throw fetchErr;
    if (property?.depositor_email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            property.depositor_email,
            'GetHome - Your Deposit Has Been Confirmed',
            `Hello,

Your deposit for the property "${property.title || 'N/A'}" has been confirmed by the GetHome team.

You will be contacted shortly to finalize the transaction.

Your reference number is: ${property.deposit_reference || 'N/A'}

Thank you for choosing GetHome.
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('Confirm deposit customer email error:', e.message); }
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Confirm deposit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ──────────────────────────────────────────────────────────
// STAFF AUTH HELPERS
// ──────────────────────────────────────────────────────────

async function verifyAdminToken(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { data: { user }, error } = await serviceClient.auth.getUser(token);
  if (error || !user) return null;
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profile?.role !== 'admin') return null;
  return user;
}

async function verifyStaffToken(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No token' });
  const { data: session } = await serviceClient
    .from('staff_sessions')
    .select('*')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .single();
  if (!session) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  req.staffSession = session;
  next();
}

// ──────────────────────────────────────────────────────────
// STAFF ENDPOINTS
// ──────────────────────────────────────────────────────────

// POST /api/staff/login
app.post('/api/staff/login', async (req, res) => {
  try {
    const { staffId, password, role } = req.body;
    if (!staffId || !password || !role) return res.status(400).json({ error: 'staffId, password, and role are required' });

    let table, codeField;
    if (role === 'SA') {
      table = 'service_agents';
      codeField = 'sa_code';
    } else if (role === 'GHA') {
      table = 'gha_agents';
      codeField = 'gha_code';
    } else {
      return res.status(400).json({ error: 'role must be SA or GHA' });
    }

    const { data: staff } = await serviceClient
      .from(table)
      .select('*')
      .eq(codeField, staffId.toUpperCase().trim())
      .single();

    if (!staff) return res.status(401).json({ error: 'Invalid staff ID or password' });

    if (staff.status === 'inactive') {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact admin.' });
    }

    let valid;
    if (staff.password_hash) {
      valid = await bcrypt.compare(password, staff.password_hash);
    } else {
      valid = password === staff.password_hash;
    }
    if (!valid) return res.status(401).json({ error: 'Invalid staff ID or password' });

    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await serviceClient.from('staff_sessions').insert([{
      staff_id: staff.id,
      staff_role: role,
      staff_code: staffId.toUpperCase().trim(),
      token,
      expires_at: expiresAt,
    }]);

    await serviceClient.from(table).update({ last_login: new Date().toISOString() }).eq('id', staff.id);

    res.json({
      token,
      user: {
        id: staff.id,
        code: role === 'SA' ? staff.sa_code : staff.gha_code,
        full_name: staff.full_name,
        email: staff.email,
        phone: staff.phone,
        location: staff.location,
        role,
        sa_id: staff.sa_id || null,
      },
    });
  } catch (err) {
    console.error('Staff login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/me
app.get('/api/staff/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: session } = await serviceClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!session) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });

    let table, codeField;
    if (session.staff_role === 'SA') {
      table = 'service_agents';
      codeField = 'sa_code';
    } else {
      table = 'gha_agents';
      codeField = 'gha_code';
    }

    const { data: staff } = await serviceClient.from(table).select('*').eq('id', session.staff_id).single();
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });

    res.json({
      id: staff.id,
      code: staff[codeField],
      full_name: staff.full_name,
      email: staff.email,
      phone: staff.phone,
      location: staff.location,
      role: session.staff_role,
      sa_id: staff.sa_id || null,
    });
  } catch (err) {
    console.error('Staff me error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/my-ghas
app.get('/api/sa/my-ghas', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { data: ghas, error } = await serviceClient
      .from('gha_agents')
      .select('*')
      .eq('sa_id', saId);
    if (error) throw error;

    const now = new Date().toISOString();
    const enriched = await Promise.all((ghas || []).map(async function(gha) {
      const { count: agentCount } = await serviceClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('gha_id', gha.id);

      const { data: activeSubs } = await serviceClient
        .from('profiles')
        .select('subscription_amount')
        .eq('gha_id', gha.id)
        .gt('subscription_end', now);
      const monthlyCommission = (activeSubs || []).reduce(function(sum, p) {
        return sum + (parseFloat(p.subscription_amount) || 0) * 0.05;
      }, 0);

      return Object.assign({}, gha, {
        password_hash: undefined,
        gh_staff_token: undefined,
        agent_count: agentCount || 0,
        monthly_commission: monthlyCommission,
      });
    }));

    res.json(enriched);
  } catch (err) {
    console.error('SA my-ghas error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/my-agents
app.get('/api/sa/my-agents', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { data: ghas } = await serviceClient
      .from('gha_agents')
      .select('id')
      .eq('sa_id', saId);
    const ghaIds = (ghas || []).map(function(g) { return g.id; });

    if (ghaIds.length === 0) return res.json([]);

    const { data: agents, error } = await serviceClient
      .from('profiles')
      .select('*')
      .in('gha_id', ghaIds)
      .eq('role', 'agent');
    if (error) throw error;

    const now = new Date();
    const enriched = (agents || []).map(function(agent) {
      return Object.assign({}, agent, {
        is_expired: agent.subscription_end ? new Date(agent.subscription_end) < now : false,
      });
    }).sort(function(a, b) { return b.is_expired - a.is_expired; });

    res.json(enriched);
  } catch (err) {
    console.error('SA my-agents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/pending-agents
app.get('/api/sa/pending-agents', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { data: agents, error } = await serviceClient
      .from('profiles')
      .select('*')
      .eq('sa_id', saId)
      .eq('status', 'pending')
      .eq('role', 'agent')
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json(agents || []);
  } catch (err) {
    console.error('SA pending-agents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/approve-agent
app.post('/api/sa/approve-agent', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { agent_id, gha_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    if (gha_id) {
      const { data: ghaCheck } = await serviceClient
        .from('gha_agents')
        .select('id')
        .eq('id', gha_id)
        .eq('sa_id', saId)
        .single();
      if (!ghaCheck) return res.status(403).json({ error: 'GHA does not belong to your SA' });
    }

    const { error } = await serviceClient
      .from('profiles')
      .update({ status: 'approved', gha_id: gha_id || null, sa_id: saId })
      .eq('id', agent_id);
    if (error) throw error;

    const { data: agent } = await serviceClient
      .from('profiles')
      .select('email, full_name')
      .eq('id', agent_id)
      .single();
    if (agent?.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            agent.email,
            'Your GetHome Agent Account Has Been Approved!',
            `Hello ${agent.full_name || 'Agent'},

Your GetHome agent account has been approved. You can now log in and start listing properties.

Sign in here: https://trygethome.online

Welcome to the GetHome agent network!
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('SA approve-agent email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('SA approve-agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/assign-gha
app.post('/api/sa/assign-gha', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { agent_id, gha_id } = req.body;
    if (!agent_id || !gha_id) return res.status(400).json({ error: 'agent_id and gha_id are required' });

    const { data: ghaCheck } = await serviceClient
      .from('gha_agents')
      .select('id')
      .eq('id', gha_id)
      .eq('sa_id', saId)
      .single();
    if (!ghaCheck) return res.status(403).json({ error: 'GHA does not belong to your SA' });

    const { error } = await serviceClient
      .from('profiles')
      .update({ gha_id })
      .eq('id', agent_id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('SA assign-gha error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/subscriptions
app.get('/api/sa/subscriptions', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { data: ghas } = await serviceClient
      .from('gha_agents')
      .select('id')
      .eq('sa_id', saId);
    const ghaIds = (ghas || []).map(function(g) { return g.id; });

    if (ghaIds.length === 0) return res.json({ agents: [], total_revenue: 0, sa_commission: 0, by_month: [] });

    const { data: agents, error } = await serviceClient
      .from('profiles')
      .select('id, full_name, email, gha_id, subscription_tier, subscription_amount, subscription_start, subscription_end')
      .in('gha_id', ghaIds)
      .eq('role', 'agent');
    if (error) throw error;

    const { data: saEarnings } = await serviceClient
      .from('sa_earnings')
      .select('month_year, amount, is_paid')
      .eq('sa_id', saId);
    const earningsMap = {};
    (saEarnings || []).forEach(function(e) { earningsMap[e.month_year] = e; });

    const totalRevenue = (agents || []).reduce(function(sum, a) {
      return sum + (parseFloat(a.subscription_amount) || 0);
    }, 0);
    const saCommission = totalRevenue * 0.07;

    const byMonth = {};
    (agents || []).forEach(function(a) {
      if (!a.subscription_start) return;
      const key = a.subscription_start.slice(0, 7);
      if (!byMonth[key]) byMonth[key] = { month: key, revenue: 0, agent_count: 0, sa_commission: 0, is_paid: earningsMap[key]?.is_paid || false };
      byMonth[key].revenue += parseFloat(a.subscription_amount) || 0;
      byMonth[key].agent_count += 1;
      byMonth[key].sa_commission = byMonth[key].revenue * 0.07;
    });

    res.json({
      agents: agents || [],
      total_revenue: totalRevenue,
      sa_commission: saCommission,
      by_month: Object.values(byMonth).sort(function(a, b) { return b.month.localeCompare(a.month); }),
    });
  } catch (err) {
    console.error('SA subscriptions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/deposits
app.get('/api/sa/deposits', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { data: ghas } = await serviceClient.from('gha_agents').select('id').eq('sa_id', saId);
    const ghaIds = (ghas || []).map(function(g) { return g.id; });
    if (ghaIds.length === 0) return res.json([]);

    const { data: agents } = await serviceClient
      .from('profiles')
      .select('id, full_name, email')
      .in('gha_id', ghaIds)
      .eq('role', 'agent');
    const agentIds = (agents || []).map(function(a) { return a.id; });
    const agentMap = {};
    (agents || []).forEach(function(a) { agentMap[a.id] = a; });

    if (agentIds.length === 0) return res.json([]);

    const { data: deposits, error } = await serviceClient
      .from('properties')
      .select('*')
      .in('created_by', agentIds)
      .not('deposit_status', 'is', null)
      .neq('deposit_status', 'none')
      .order('deposit_date', { ascending: false });
    if (error) throw error;

    const enriched = (deposits || []).map(function(p) {
      return Object.assign({}, p, { agent: agentMap[p.created_by] || null });
    });

    res.json(enriched);
  } catch (err) {
    console.error('SA deposits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/confirm-deposit
app.post('/api/sa/confirm-deposit', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });

    const { property_id } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });

    const { error: updateErr } = await serviceClient
      .from('properties')
      .update({ deposit_confirmed: true, deposit_status: 'confirmed' })
      .eq('id', property_id);
    if (updateErr) throw updateErr;

    const { data: property } = await serviceClient
      .from('properties')
      .select('title, depositor_email, deposit_reference')
      .eq('id', property_id)
      .single();

    if (property?.depositor_email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            property.depositor_email,
            'GetHome - Your Deposit Has Been Confirmed',
            `Hello,

Your deposit for the property "${property.title || 'N/A'}" has been confirmed.

You will be contacted shortly to finalize the transaction.

Reference: ${property.deposit_reference || 'N/A'}

Thank you for choosing GetHome.
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('SA confirm-deposit email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('SA confirm-deposit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/my-agents
app.get('/api/gha/my-agents', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { data: agents, error } = await serviceClient
      .from('profiles')
      .select('id, full_name, phone, email, nin_number, experience, specialty, verification_level, status, subscription_tier, subscription_end, bank_name, account_number, gha_id, sa_id, created_at')
      .eq('gha_id', ghaId)
      .eq('role', 'agent')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const now = new Date();
    const enriched = (agents || []).map(function(agent) {
      return Object.assign({}, agent, {
        nin_number: agent.nin_number
          ? agent.nin_number.slice(0, 3) + '****' + agent.nin_number.slice(-3)
          : null,
        is_expired: agent.subscription_end ? new Date(agent.subscription_end) < now : false,
      });
    });

    res.json(enriched);
  } catch (err) {
    console.error('GHA my-agents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/my-listings
app.get('/api/gha/my-listings', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { data: agentRows } = await serviceClient
      .from('profiles')
      .select('id, full_name, email')
      .eq('gha_id', ghaId)
      .eq('role', 'agent');
    const agentIds = (agentRows || []).map(function(a) { return a.id; });
    if (agentIds.length === 0) return res.json([]);

    const agentMap = {};
    (agentRows || []).forEach(function(a) { agentMap[a.id] = a; });

    const { data: properties, error } = await serviceClient
      .from('properties')
      .select('*')
      .in('created_by', agentIds)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const enriched = (properties || []).map(function(p) {
      const agent = agentMap[p.created_by] || {};
      return Object.assign({}, p, {
        agent_name: agent.full_name || null,
        agent_email: agent.email || null,
      });
    });

    res.json(enriched);
  } catch (err) {
    console.error('GHA my-listings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gha/verify-listing
app.post('/api/gha/verify-listing', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { property_id } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });

    const { data: agentRows } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('gha_id', ghaId)
      .eq('role', 'agent');
    const agentIds = (agentRows || []).map(function(a) { return a.id; });

    const { data: prop } = await serviceClient
      .from('properties')
      .select('id, created_by')
      .eq('id', property_id)
      .single();
    if (!prop || !agentIds.includes(prop.created_by)) {
      return res.status(403).json({ error: 'Property does not belong to an agent under your GHA' });
    }

    const { error } = await serviceClient
      .from('properties')
      .update({ gha_verified: true, gha_verified_at: new Date().toISOString() })
      .eq('id', property_id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('GHA verify-listing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/inspections
app.get('/api/gha/inspections', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { data: inspections, error } = await serviceClient
      .from('inspections')
      .select('*')
      .eq('gha_id', ghaId)
      .order('inspection_date', { ascending: false });
    if (error) throw error;

    const propertyIds = [...new Set((inspections || []).map(function(i) { return i.property_id; }).filter(Boolean))];
    let propertyMap = {};
    if (propertyIds.length > 0) {
      const { data: props } = await serviceClient
        .from('properties')
        .select('id, title, location')
        .in('id', propertyIds);
      (props || []).forEach(function(p) { propertyMap[p.id] = p; });
    }

    const enriched = (inspections || []).map(function(i) {
      const prop = propertyMap[i.property_id] || {};
      return Object.assign({}, i, {
        property_title: prop.title || null,
        property_location: prop.location || null,
      });
    });

    res.json(enriched);
  } catch (err) {
    console.error('GHA inspections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gha/update-inspection
app.post('/api/gha/update-inspection', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { inspection_id, status, notes } = req.body;
    if (!inspection_id || !status) return res.status(400).json({ error: 'inspection_id and status are required' });

    const { data: updated, error } = await serviceClient
      .from('inspections')
      .update({ status, notes: notes || null })
      .eq('id', inspection_id)
      .eq('gha_id', ghaId)
      .select()
      .single();
    if (error) throw error;
    if (!updated) return res.status(404).json({ error: 'Inspection not found or not assigned to your GHA' });

    if (status === 'completed' && updated.customer_email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            updated.customer_email,
            'GetHome - Your Property Inspection Is Complete',
            `Hello,

Your property inspection has been completed by the GetHome team.

Our representative will be in contact with you shortly with the full report and next steps.

Thank you for choosing GetHome.
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('GHA update-inspection email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('GHA update-inspection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/earnings
app.get('/api/gha/earnings', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { data: earnings, error } = await serviceClient
      .from('gha_earnings')
      .select('*')
      .eq('gha_id', ghaId)
      .order('month_year', { ascending: false });
    if (error) throw error;

    const total = (earnings || []).reduce(function(sum, e) {
      return sum + (parseFloat(e.amount) || 0);
    }, 0);

    res.json({
      earnings: earnings || [],
      total_earned: total,
      total_paid: (earnings || []).filter(function(e) { return e.is_paid; }).reduce(function(sum, e) { return sum + (parseFloat(e.amount) || 0); }, 0),
      total_pending: (earnings || []).filter(function(e) { return !e.is_paid; }).reduce(function(sum, e) { return sum + (parseFloat(e.amount) || 0); }, 0),
    });
  } catch (err) {
    console.error('GHA earnings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/create-sa
app.post('/api/admin/create-sa', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { full_name, email, phone, location, password } = req.body;
    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'full_name, email, phone, and password are required' });
    }

    const { count } = await serviceClient
      .from('service_agents')
      .select('id', { count: 'exact', head: true });
    const sa_code = 'SA' + String((count || 0) + 1).padStart(4, '0');
    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await serviceClient
      .from('service_agents')
      .insert([{ full_name, email, phone, location: location || null, sa_code, password_hash }])
      .select()
      .single();
    if (error) throw error;

    const result = Object.assign({}, data);
    delete result.password_hash;
    delete result.gh_staff_token;
    res.status(201).json(result);
  } catch (err) {
    console.error('Admin create-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/create-gha
app.post('/api/admin/create-gha', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { full_name, email, phone, location, sa_id, password } = req.body;
    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'full_name, email, phone, and password are required' });
    }

    if (sa_id) {
      const { data: saCheck } = await serviceClient
        .from('service_agents')
        .select('id')
        .eq('id', sa_id)
        .single();
      if (!saCheck) return res.status(400).json({ error: 'sa_id does not match any Service Agent' });
    }

    const { count } = await serviceClient
      .from('gha_agents')
      .select('id', { count: 'exact', head: true });
    const gha_code = 'GHA' + String((count || 0) + 1).padStart(4, '0');
    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await serviceClient
      .from('gha_agents')
      .insert([{ full_name, email, phone, location: location || null, sa_id: sa_id || null, gha_code, password_hash }])
      .select()
      .single();
    if (error) throw error;

    const result = Object.assign({}, data);
    delete result.password_hash;
    delete result.gh_staff_token;
    res.status(201).json(result);
  } catch (err) {
    console.error('Admin create-gha error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/all-sas
app.get('/api/admin/all-sas', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: sas, error } = await serviceClient
      .from('service_agents')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const now = new Date().toISOString();
    const enriched = await Promise.all((sas || []).map(async function(sa) {
      const { data: ghas } = await serviceClient
        .from('gha_agents')
        .select('id')
        .eq('sa_id', sa.id);
      const ghaIds = (ghas || []).map(function(g) { return g.id; });
      const ghaCount = ghaIds.length;

      let agentCount = 0;
      let monthlyEarnings = 0;
      if (ghaIds.length > 0) {
        const { count } = await serviceClient
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .in('gha_id', ghaIds)
          .eq('role', 'agent');
        agentCount = count || 0;

        const { data: activeSubs } = await serviceClient
          .from('profiles')
          .select('subscription_amount')
          .in('gha_id', ghaIds)
          .gt('subscription_end', now);
        monthlyEarnings = (activeSubs || []).reduce(function(sum, p) {
          return sum + (parseFloat(p.subscription_amount) || 0) * 0.10;
        }, 0);
      }

      const result = Object.assign({}, sa, {
        gha_count: ghaCount,
        agent_count: agentCount,
        monthly_earnings: monthlyEarnings,
      });
      delete result.password_hash;
      delete result.gh_staff_token;
      return result;
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Admin all-sas error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/all-ghas
app.get('/api/admin/all-ghas', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: ghas, error } = await serviceClient
      .from('gha_agents')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const saIds = [...new Set((ghas || []).map(function(g) { return g.sa_id; }).filter(Boolean))];
    let saMap = {};
    if (saIds.length > 0) {
      const { data: sas } = await serviceClient
        .from('service_agents')
        .select('id, full_name, email, sa_code')
        .in('id', saIds);
      (sas || []).forEach(function(s) { saMap[s.id] = s; });
    }

    const now = new Date().toISOString();
    const enriched = await Promise.all((ghas || []).map(async function(gha) {
      const { count: agentCount } = await serviceClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('gha_id', gha.id)
        .eq('role', 'agent');

      const { data: activeSubs } = await serviceClient
        .from('profiles')
        .select('subscription_amount')
        .eq('gha_id', gha.id)
        .gt('subscription_end', now);
      const monthlyEarnings = (activeSubs || []).reduce(function(sum, p) {
        return sum + (parseFloat(p.subscription_amount) || 0) * 0.05;
      }, 0);

      const result = Object.assign({}, gha, {
        agent_count: agentCount || 0,
        monthly_earnings: monthlyEarnings,
        sa: gha.sa_id ? (saMap[gha.sa_id] || null) : null,
      });
      delete result.password_hash;
      delete result.gh_staff_token;
      return result;
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Admin all-ghas error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/deactivate-sa
app.post('/api/admin/deactivate-sa', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { sa_id } = req.body;
    if (!sa_id) return res.status(400).json({ error: 'sa_id is required' });

    const { error: saErr } = await serviceClient
      .from('service_agents')
      .update({ status: 'inactive' })
      .eq('id', sa_id);
    if (saErr) throw saErr;

    const { error: ghaErr } = await serviceClient
      .from('gha_agents')
      .update({ status: 'inactive' })
      .eq('sa_id', sa_id);
    if (ghaErr) throw ghaErr;

    res.json({ success: true });
  } catch (err) {
    console.error('Admin deactivate-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/mark-sa-paid
app.post('/api/admin/mark-sa-paid', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { sa_id, month_year } = req.body;
    if (!sa_id || !month_year) return res.status(400).json({ error: 'sa_id and month_year are required' });

    const { error } = await serviceClient
      .from('sa_earnings')
      .update({ is_paid: true, paid_at: new Date().toISOString(), paid_by: admin.id })
      .eq('sa_id', sa_id)
      .eq('month_year', month_year);
    if (error) throw error;

    const { data: sa } = await serviceClient
      .from('service_agents')
      .select('email, full_name')
      .eq('id', sa_id)
      .single();
    if (sa?.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            sa.email,
            'GetHome - Your Commission Has Been Paid',
            `Hello ${sa.full_name || 'Service Agent'},

Your GetHome commission for ${month_year} has been processed and paid to your account.

Thank you for your continued partnership.
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('SA mark-paid email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Admin mark-sa-paid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/mark-gha-paid
app.post('/api/admin/mark-gha-paid', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { gha_id, month_year } = req.body;
    if (!gha_id || !month_year) return res.status(400).json({ error: 'gha_id and month_year are required' });

    const { error } = await serviceClient
      .from('gha_earnings')
      .update({ is_paid: true, paid_at: new Date().toISOString(), paid_by: admin.id })
      .eq('gha_id', gha_id)
      .eq('month_year', month_year);
    if (error) throw error;

    const { data: gha } = await serviceClient
      .from('gha_agents')
      .select('email, full_name')
      .eq('id', gha_id)
      .single();
    if (gha?.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            gha.email,
            'GetHome - Your Salary Has Been Processed',
            `Hello ${gha.full_name || 'GHA'},

Your GetHome salary for ${month_year} has been processed and paid to your account.

Thank you for your continued service.
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('GHA paid email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Admin mark-gha-paid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/earnings-summary
app.get('/api/admin/earnings-summary', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month_year = req.query.month_year || defaultMonth;

    const [{ data: ghaEarnings, error: ghaErr }, { data: saEarnings, error: saErr }] = await Promise.all([
      serviceClient.from('gha_earnings').select('*').eq('month_year', month_year),
      serviceClient.from('sa_earnings').select('*').eq('month_year', month_year),
    ]);
    if (ghaErr) throw ghaErr;
    if (saErr) throw saErr;

    const ghaIds = [...new Set((ghaEarnings || []).map(function(r) { return r.gha_id; }).filter(Boolean))];
    const saIds  = [...new Set((saEarnings  || []).map(function(r) { return r.sa_id;  }).filter(Boolean))];

    let ghaStaffMap = {}, saStaffMap = {};
    if (ghaIds.length > 0) {
      const { data: ghaStaff } = await serviceClient
        .from('gha_agents')
        .select('id, full_name, email, gha_code')
        .in('id', ghaIds);
      (ghaStaff || []).forEach(function(g) { ghaStaffMap[g.id] = g; });
    }
    if (saIds.length > 0) {
      const { data: saStaff } = await serviceClient
        .from('service_agents')
        .select('id, full_name, email, sa_code')
        .in('id', saIds);
      (saStaff || []).forEach(function(s) { saStaffMap[s.id] = s; });
    }

    const ghaMap = {};
    (ghaEarnings || []).forEach(function(row) {
      if (!ghaMap[row.gha_id]) {
        ghaMap[row.gha_id] = {
          gha_id: row.gha_id,
          staff: ghaStaffMap[row.gha_id] || null,
          total_earned: 0,
          is_paid: row.is_paid,
          paid_at: row.paid_at || null,
        };
      }
      ghaMap[row.gha_id].total_earned += parseFloat(row.commission_amount || row.amount) || 0;
    });

    const saMap = {};
    (saEarnings || []).forEach(function(row) {
      if (!saMap[row.sa_id]) {
        saMap[row.sa_id] = {
          sa_id: row.sa_id,
          staff: saStaffMap[row.sa_id] || null,
          total_earned: 0,
          is_paid: row.is_paid,
          paid_at: row.paid_at || null,
        };
      }
      saMap[row.sa_id].total_earned += parseFloat(row.commission_amount || row.amount) || 0;
    });

    const ghaTotals = Object.values(ghaMap);
    const saTotals  = Object.values(saMap);
    const grandTotalGHA = ghaTotals.reduce(function(s, r) { return s + r.total_earned; }, 0);
    const grandTotalSA  = saTotals.reduce(function(s, r) { return s + r.total_earned; }, 0);

    res.json({
      month_year,
      gha_totals: ghaTotals,
      sa_totals: saTotals,
      grand_total_gha: grandTotalGHA,
      grand_total_sa: grandTotalSA,
      grand_total_all: grandTotalGHA + grandTotalSA,
    });
  } catch (err) {
    console.error('Admin earnings-summary error:', err.message);
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
  const { fileName, fileType, fileData, image_urls } = req.body;
  if (!fileName || !fileType || !fileData) {
    return res.status(400).json({ error: "fileName, fileType, and fileData are required." });
  }
  try {
    // Strip base64 prefix (data:image/jpeg;base64,XXXX)
    const base64Data = fileData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer || buffer.length === 0) return res.status(400).json({ error: 'No file buffer received' });
    console.log('Uploading image:', { fileName, bucket: BUCKET_NAME });
    const { data, error } = await serviceClient.storage
      .from(BUCKET_NAME)
      .upload(fileName, buffer, {
        contentType: fileType,
        cacheControl: '3600',
        upsert: true,
      });
    if (error) {
      console.error('Upload failed for bucket:', BUCKET_NAME, '| error:', error.message, '| code:', error.statusCode);
      return res.status(500).json({ error: 'Bucket upload error: ' + error.message + ' | Bucket tried: ' + BUCKET_NAME });
    }
    const { data: urlData } = serviceClient.storage.from(BUCKET_NAME).getPublicUrl(data.path);
    const newUrl = urlData.publicUrl;
    const existingUrls = Array.isArray(image_urls) ? image_urls : [];
    const urls_array = [...existingUrls, newUrl];
    res.status(200).json({ url: newUrl, urls_array });
  } catch (err) {
    console.error("Image upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
const multiImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload-images', multiImageUpload.array('images', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No image files provided' });
  try {
    const urls = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      if (!file.buffer) return res.status(400).json({ error: 'No file buffer received for file ' + i });
      const fileName = `images/${Date.now()}_${i}_${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      const { data, error } = await serviceClient.storage
        .from(BUCKET_NAME)
        .upload(fileName, file.buffer, { contentType: file.mimetype, cacheControl: '3600', upsert: false });
      if (error) {
        console.error('Upload failed for bucket:', BUCKET_NAME, '| file:', i, '| error:', error.message, '| code:', error.statusCode);
        return res.status(500).json({ error: 'Bucket upload error: ' + error.message + ' | Bucket tried: ' + BUCKET_NAME });
      }
      const { data: urlData } = serviceClient.storage.from(BUCKET_NAME).getPublicUrl(data.path);
      urls.push(urlData.publicUrl);
    }
    res.json({ urls });
  } catch (err) {
    console.error('Multi-image upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/properties', async (req, res) => {
  const { title, location, price, image_url, image_urls, video_url, description, bedrooms, bathrooms, purpose, rent, agency_fee, agreement_fee, caution_fee, service_charge, is_featured, cost_per_night, created_by } = req.body;
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
    // Check listing limit for free tier agents
    if (agentId) {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('verification_level, is_unlimited, role')
        .eq('id', agentId)
        .single();

      const isAdmin     = profileData?.role === 'admin';
      const isUnlimited = profileData?.is_unlimited === true;
      const level       = profileData?.verification_level || 'basic';
      const limits      = { basic: 3, verified: 15, premium: 999 };
      const limit       = limits[level] || 3;

      if (!isAdmin && !isUnlimited) {
        const { count } = await supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('created_by', agentId);

        console.log('Listing limit check:', { agentId, tier: level, current: count, limit });

        if (count >= limit) {
          return res.status(403).json({
            error: 'Listing limit reached. Your ' + level + ' tier allows up to ' + limit + ' listings. Please contact admin to upgrade your verification tier.',
            limit,
            current: count,
            tier: level,
          });
        }
      }
    }

    const cleanedImageUrls = Array.isArray(image_urls) && image_urls.length > 0
      ? image_urls.filter(function(u) { return u && u.trim(); })
      : (image_url ? [image_url] : []);
    console.log('POST /api/properties:', {
      title,
      imageCount: cleanedImageUrls.length,
      hasVideo: !!video_url,
      purpose: purpose || 'rent',
    });
    const { data, error } = await userSupabase.from('properties').insert([{
      title,
      location,
      description:    description                || null,
      bedrooms:       bedrooms                   || null,
      bathrooms:      bathrooms                  || null,
      price:          parseFloat(price)          || 0,
      image_url:      (Array.isArray(image_urls) && image_urls[0]) || image_url || null,
      image_urls:     cleanedImageUrls,
      video_url:      video_url                  || null,
      rent:           parseFloat(rent)           || parseFloat(price) || 0,
      agency_fee:     parseFloat(agency_fee)     || 0,
      agreement_fee:  parseFloat(agreement_fee)  || 0,
      caution_fee:    parseFloat(caution_fee)    || 0,
      service_charge: parseFloat(service_charge) || 0,
      is_featured:    is_featured === true || is_featured === 'true' || false,
      purpose:        purpose                    || 'rent',
      cost_per_night: parseFloat(cost_per_night) || 0,
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
  const { title, location, price, image_url, image_urls, video_url, description, bedrooms, bathrooms, purpose, rent, agency_fee, agreement_fee, caution_fee, service_charge, is_featured, cost_per_night } = req.body;
  if (!title || !location || !price) {
    return res.status(400).json({ error: "title, location, and price are required." });
  }
  try {
    const cleanedImageUrlsPut = Array.isArray(image_urls) && image_urls.length > 0
      ? image_urls.filter(function(u) { return u && u.trim(); })
      : (image_url ? [image_url] : []);
    const { data, error } = await supabase
      .from('properties')
      .update({
        title,
        location,
        price:          parseFloat(price)          || 0,
        image_url:      (Array.isArray(image_urls) && image_urls[0]) || image_url || null,
        image_urls:     cleanedImageUrlsPut,
        video_url:      video_url                  || null,
        description:    description                || null,
        bedrooms:       bedrooms                   || null,
        bathrooms:      bathrooms                  || null,
        purpose:        purpose                    || 'rent',
        rent:           parseFloat(rent)           || parseFloat(price) || 0,
        agency_fee:     parseFloat(agency_fee)     || 0,
        agreement_fee:  parseFloat(agreement_fee)  || 0,
        caution_fee:    parseFloat(caution_fee)    || 0,
        service_charge: parseFloat(service_charge) || 0,
        cost_per_night: parseFloat(cost_per_night) || 0,
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