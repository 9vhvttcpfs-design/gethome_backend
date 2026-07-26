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
const adminClient = serviceClient;
console.log('adminClient using service key:', !!process.env.SUPABASE_SERVICE_KEY);
console.log('Admin client initialized:', process.env.SUPABASE_SERVICE_KEY ? 'SERVICE KEY' : 'ANON KEY FALLBACK');
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
    const { data: callerP } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (callerP?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { filePath } = req.body;
    const { data, error } = await adminClient.storage
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
    // Fetch pending agents only - use adminClient to bypass RLS
    const { data: agents, error } = await adminClient
      .from('profiles')
      .select('id, role, status, is_unlimited, created_at, email, full_name, phone, office_address, experience, specialty, nin_number, cac_number, about, verification_level, kyc_documents, bank_name, account_number, account_name, subscription_tier, subscription_start, subscription_end, subscription_status')
      .eq('role', 'agent')
      .not('status', 'in', '(approved,rejected)')
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
      await Promise.all(agentsMissingEmail.map(async function(agent) {
        try {
          const { data: authUser } = await adminClient.auth.admin.getUserById(agent.id);
          const foundEmail = authUser?.user?.email;
          if (foundEmail) {
            agent.email = foundEmail;
            // Also update the profiles table so future calls are fast
            const { error: emailUpdateErr } = await supabase.from('profiles').update({ email: foundEmail }).eq('id', agent.id);
            if (emailUpdateErr) console.error('Email profile update failed for', agent.id, emailUpdateErr.message);
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

app.get('/api/admin/approved-agents', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await adminClient
      .from('profiles')
      .select('*')
      .eq('role', 'agent')
      .eq('status', 'approved')
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/verified-pending-agents', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    const user = userData?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (!profile || profile.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { data, error } = await adminClient.from('verified_pending_agents').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve agent (admin only)
app.post('/api/admin/approve-agent', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const { data: userData_approve, error: authError } = await adminClient.auth.getUser(token);
    const user = userData_approve?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const { verificationTier } = req.body;
    const validTiers = ['basic', 'verified', 'premium'];
    const tier = validTiers.includes(verificationTier) ? verificationTier : 'basic';
    // Update status and verification level using adminClient to bypass RLS
    const { error } = await adminClient
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
    const { data: userData_reject, error: authError } = await adminClient.auth.getUser(token);
    const user = userData_reject?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const { error } = await adminClient.from('profiles').update({ status: 'rejected' }).eq('id', agentId);
    if (error) throw error;
    res.json({ success: true, message: 'Agent rejected' });
  } catch (err) {
    console.error('Reject agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Disapprove agent (admin only) - suspends a previously approved agent's ability to upload listings
app.post('/api/admin/disapprove-agent', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    const user = userData?.user;
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const { error } = await adminClient.from('profiles').update({ status: 'disapproved' }).eq('id', agentId).eq('role', 'agent');
    if (error) throw error;
    console.log('Agent disapproved:', agentId);
    res.json({ success: true, message: 'Agent disapproved. They can no longer upload listings.' });
  } catch (err) {
    console.error('Disapprove agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/admin/revoke-agent', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const { error } = await adminClient.from('profiles')
      .update({ status: 'pending_sa_review' }).eq('id', agent_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Toggle featured status for a property (admin only)
app.patch('/api/admin/properties/:id/feature', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
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
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
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

    // Delete all previous sessions for this staff member before creating a new one
    await serviceClient.from('staff_sessions')
      .delete()
      .eq('staff_id', staff.id);
    console.log('Cleared old sessions for:', staffId);

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
        whatsapp_number: staff.whatsapp_number || null,
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
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });

    if (session.staff_role === 'SA') {
      const { data: staff } = await serviceClient
        .from('service_agents')
        .select('*')
        .eq('id', session.staff_id)
        .single();
      if (!staff) return res.status(404).json({ error: 'Staff record not found' });

      return res.json({
        id: staff.id,
        code: staff.sa_code,
        full_name: staff.full_name,
        email: staff.email,
        phone: staff.phone,
        location: staff.location,
        role: 'SA',
        whatsapp_number: staff.whatsapp_number || null,
      });
    }

    // GHA — fetch with SA details joined
    const { data: ghaRecord } = await adminClient
      .from('gha_agents')
      .select('*, service_agents!gha_agents_sa_id_fkey(sa_code, full_name, email, phone, whatsapp_number)')
      .eq('id', session.staff_id)
      .single();

    if (!ghaRecord) return res.status(404).json({ error: 'GHA record not found' });

    const { count: agentCount } = await adminClient
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('gha_id', session.staff_id);

    const saDetails = ghaRecord.service_agents || {};

    return res.json({
      id: ghaRecord.id,
      code: ghaRecord.gha_code,
      gha_code: ghaRecord.gha_code,
      full_name: ghaRecord.full_name,
      email: ghaRecord.email,
      phone: ghaRecord.phone,
      location: ghaRecord.location,
      status: ghaRecord.status,
      role: 'GHA',
      commission_rate: ghaRecord.commission_rate || 5,
      sa_id: ghaRecord.sa_id,
      sa_code: saDetails.sa_code || null,
      sa_name: saDetails.full_name || null,
      sa_email: saDetails.email || null,
      sa_phone: saDetails.phone || null,
      sa_whatsapp: saDetails.whatsapp_number || null,
      agent_count: agentCount || 0,
    });
  } catch (err) {
    console.error('Staff me error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/profile
app.get('/api/gha/profile', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const { data: ghaRecord } = await adminClient
      .from('gha_agents')
      .select('*, service_agents!gha_agents_sa_id_fkey(sa_code, full_name, email, phone, whatsapp_number)')
      .eq('id', session.staff_id)
      .single();

    if (!ghaRecord) return res.status(404).json({ error: 'GHA profile not found' });

    const { count: agentCount } = await adminClient
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('gha_id', session.staff_id);

    const sa = ghaRecord.service_agents || {};
    res.json({
      gha_code: ghaRecord.gha_code,
      full_name: ghaRecord.full_name,
      email: ghaRecord.email,
      phone: ghaRecord.phone,
      location: ghaRecord.location,
      status: ghaRecord.status,
      commission_rate: ghaRecord.commission_rate || 5,
      sa_id: ghaRecord.sa_id,
      sa_code: sa.sa_code || 'Not assigned',
      sa_name: sa.full_name || 'Not assigned',
      sa_email: sa.email || null,
      sa_whatsapp: sa.whatsapp_number || null,
      agent_count: agentCount || 0,
    });
  } catch (err) {
    console.error('GHA profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/my-ghas
app.get('/api/sa/my-ghas', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: session, error: sessionErr } = await adminClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionErr || !session) {
      console.error('SA my-ghas session error:', sessionErr?.message);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (session.staff_role !== 'SA') {
      return res.status(403).json({ error: 'SA access required' });
    }

    const saId = session.staff_id;
    console.log('Fetching GHAs for SA:', saId);

    const { data: ghas, error: ghaErr } = await adminClient
      .from('gha_agents_enriched')
      .select('id, gha_code, full_name, email, phone, location, status, commission_rate, created_at, agent_count, listing_count, active_subscriptions, expired_subscriptions')
      .eq('sa_id', saId)
      .order('created_at', { ascending: false });

    if (ghaErr) {
      console.error('GHA query error:', ghaErr.message, ghaErr.code);
      return res.json([]);
    }

    const safeGhas = ghas || [];
    console.log('Found', safeGhas.length, 'GHAs for SA', saId);

    res.json(safeGhas);
  } catch (err) {
    console.error('CRITICAL: SA my-ghas exception:', err.message, err.stack);
    res.status(200).json([]);
  }
});

// GET /api/sa/my-agents
app.get('/api/sa/my-agents', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const { data: session } = await adminClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { data: saRecord } = await adminClient.from('service_agents')
      .select('location').eq('id', session.staff_id).single();
    const saLocation = saRecord?.location || '';
    console.log('SA location for filtering:', saLocation);

    const { data: agents, error } = await adminClient
      .rpc('get_sa_localized_agents', { sa_uuid: session.staff_id });

    if (error || !agents || agents.length === 0) {
      console.log('RPC returned empty or failed, using relaxed fallback for location:', saLocation);

      var locationWords = (saLocation || '').split(/[\s,]+/).filter(function(w) {
        return w.length > 2;
      });

      // Fetch both pending and approved agents so the full dashboard is populated
      var fallbackQuery = adminClient
        .from('profiles')
        .select('*')
        .eq('role', 'agent')
        .in('status', ['pending', 'pending_gha_inspection', 'pending_sa_review', 'approved']);

      if (locationWords.length > 0) {
        var orConditions = locationWords.map(function(word) {
          return 'office_address.ilike.%' + word + '%,city.ilike.%' + word + '%';
        }).join(',');
        fallbackQuery = fallbackQuery.or(orConditions + ',office_address.is.null,office_address.eq.,city.is.null,city.eq.');
      }

      var { data: fallbackAgents } = await fallbackQuery.order('created_at', { ascending: false });
      // Normalise city and requested_gha_code for UI safety even in fallback path
      var normFallback = (fallbackAgents || []).map(function(a) {
        return Object.assign({}, a, {
          city:               (a.city || '').trim() || null,
          requested_gha_code: (a.requested_gha_code || '').trim() || null,
        });
      });
      return res.json(normFallback);
    }

    const enriched = (agents || []).map(function(a) {
      var ghaId = a.assigned_gha_id || a.gha_id || null;
      var saId  = a.assigned_sa_id  || a.sa_id  || null;
      return Object.assign({}, a, {
        gha_id:             ghaId,
        sa_id:              saId,
        office_address:     a.location || a.office_address || null,
        // Safe string normalisation so the SA board UI always receives clean values
        city:               (a.city || '').trim() || null,
        requested_gha_code: (a.requested_gha_code || '').trim() || null,
        already_assigned:   !!(ghaId && saId),
        already_assigned_other_sa: !!(ghaId && saId && saId !== session.staff_id),
      });
    });

    res.json(enriched);
  } catch (err) {
    console.error('SA my-agents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/pending-agents
app.get('/api/sa/pending-agents', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    // Get SA location for matching
    const { data: saRecord } = await adminClient
      .from('service_agents').select('location, sa_code').eq('id', session.staff_id).single();
    const saLocation = (saRecord?.location || '').toLowerCase().trim();
    const saKeywords = saLocation.split(/[\s,]+/).map(w => w.trim()).filter(w => w.length > 2);

    console.log('SA', saRecord?.sa_code, 'fetching pending agents for location:', saLocation);

    // PART 1: Unclaimed agents (sa_id IS NULL) matching this SA's city - these are NEW pending agents
    const { data: unclaimedAgents } = await adminClient
      .from('profiles')
      .select('id, email, full_name, phone, status, verification_level, gha_id, sa_id, gha_code, office_address, city, experience, specialty, nin_number, cac_number, about, requested_gha_code, gha_verified, subscription_tier, subscription_end, created_at')
      .eq('role', 'agent')
      .is('sa_id', null)
      .order('created_at', { ascending: false });

    // Filter unclaimed agents by city match (relaxed)
    const matchedUnclaimed = (unclaimedAgents || []).filter(function(a) {
      if (saKeywords.length === 0) return true; // no SA location set - show all
      const agentCity = (a.city || '').toLowerCase();
      const agentAddr = (a.office_address || '').toLowerCase();
      const agentText = agentCity + ' ' + agentAddr;
      const hasNoLocation = !agentCity && !agentAddr;
      const matches = saKeywords.some(function(kw) { return agentText.includes(kw); });
      return matches || hasNoLocation;
    });

    // PART 2: Agents ALREADY assigned to this SA (after SA claimed them) - these are in later stages
    const { data: claimedAgents } = await adminClient
      .from('profiles')
      .select('id, email, full_name, phone, status, verification_level, gha_id, sa_id, gha_code, office_address, city, experience, specialty, nin_number, cac_number, about, requested_gha_code, gha_verified, subscription_tier, subscription_end, created_at')
      .eq('role', 'agent')
      .eq('sa_id', session.staff_id)
      .order('created_at', { ascending: false });

    console.log('Unclaimed matched:', matchedUnclaimed.length, '| Claimed by this SA:', (claimedAgents || []).length);

    const pendingStatuses = ['pending', 'pending_sa_review', 'awaiting_review'];

    // Pending = unclaimed agents in this SA's area, status pending
    const pending = matchedUnclaimed.filter(function(a) {
      return pendingStatuses.includes(a.status) || !a.status;
    });

    // GHA inspection = already claimed by this SA and sent to a GHA
    const ghaInspection = (claimedAgents || []).filter(function(a) {
      return a.status === 'pending_gha_inspection';
    });

    // Approved = claimed by this SA and approved
    const approved = (claimedAgents || []).filter(function(a) {
      return a.status === 'approved';
    });

    res.json({
      pending: pending,
      pending_gha_inspection: ghaInspection,
      approved: approved,
    });
  } catch (err) {
    console.error('Pending agents exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/approve-agent
app.post('/api/sa/approve-agent', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const saId = session.staff_id;

    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    const { data: agent } = await adminClient.from('profiles')
      .select('*').eq('id', agent_id).single();
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Block if agent is assigned to a different SA
    if (agent.sa_id && agent.sa_id !== saId) {
      return res.status(403).json({ error: 'This agent is assigned to a different SA and cannot be approved by you.' });
    }

    if (agent.gha_id && agent.gha_verified === false) {
      return res.status(400).json({
        error: 'This agent has been flagged by their GHA. Please review before approving.',
      });
    }

    const { error: updateErr } = await adminClient
      .from('profiles')
      .update({
        status: 'approved',
        sa_id: session.staff_id,
      })
      .eq('id', agent_id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    console.log('Agent approved successfully:', agent_id, '| by SA:', session.staff_id);

    try {
      await sendCustomerEmail(
        agent.email,
        'Your GetHome Agent Account is Approved!',
        `Hello ${agent.full_name || 'Agent'},\n\nCongratulations! Your GetHome agent account has been approved. You can now log in and start uploading property listings.\n\nWelcome to the GetHome family!\n\nGetHome Team`
      );
    } catch(emailErr) { console.error('Approval email failed:', emailErr.message); }

    res.json({ success: true, message: 'Agent approved successfully' });
  } catch (err) {
    console.error('Approve agent exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/reject-agent
app.post('/api/sa/reject-agent', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { agent_id, reason } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    const { error: updateErr } = await adminClient.from('profiles')
      .update({ status: 'rejected' }).eq('id', agent_id).eq('sa_id', session.staff_id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    const { data: agent } = await adminClient.from('profiles').select('email, full_name').eq('id', agent_id).single();
    try {
      await sendCustomerEmail(
        agent?.email,
        'GetHome Agent Application Update',
        'Hello ' + (agent?.full_name || 'Agent') + ',\n\nYour agent application was not approved at this time' + (reason ? '. Reason: ' + reason : '.') + '\n\nContact us on WhatsApp for more information.\n\nGetHome Team'
      );
    } catch(e) { console.error('Reject email failed:', e.message); }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/send-to-gha
app.post('/api/sa/send-to-gha', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { agent_id, gha_code, gha_id: rawGhaId } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    let resolvedGhaId = rawGhaId;

    if (!resolvedGhaId && gha_code) {
      const { data: ghaRecord, error: ghaLookupErr } = await adminClient
        .from('gha_agents')
        .select('id')
        .eq('gha_code', gha_code)
        .single();

      if (ghaLookupErr || !ghaRecord) {
        console.error('GHA code lookup failed:', gha_code, '|', ghaLookupErr?.message);
        return res.status(404).json({ error: 'No GHA found with code: ' + gha_code });
      }
      resolvedGhaId = ghaRecord.id;
    }

    if (!resolvedGhaId) {
      return res.status(400).json({ error: 'Either gha_id or gha_code is required' });
    }

    // Verify GHA belongs to this SA
    const { data: gha } = await serviceClient
      .from('gha_agents')
      .select('id, email, full_name, gha_code')
      .eq('id', resolvedGhaId)
      .eq('sa_id', saId)
      .single();
    if (!gha) return res.status(403).json({ error: 'This GHA does not belong to your team' });

    // Fetch agent details
    const { data: agent } = await serviceClient
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', agent_id)
      .single();
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Update agent status and assign to GHA; sa_id claims the previously-unclaimed agent
    const { error: updateErr } = await serviceClient
      .from('profiles')
      .update({
        gha_id: resolvedGhaId,
        sa_id: saId,
        gha_code: gha.gha_code,
        status: 'approved',
      })
      .eq('id', agent_id);
    if (updateErr) throw updateErr;
    console.log('Agent auto-approved on GHA assignment:', agent_id);

    // Notification is best-effort only - must never block the primary action
    try {
      const { error: notifErr } = await serviceClient.from('notifications').insert({
        recipient_type: 'GHA',
        recipient_id: resolvedGhaId,
        type: 'inspection_request',
        title: 'New Agent to Verify',
        message: `Please verify agent ${agent.full_name || agent_id} registration details and confirm to SA.`,
        is_read: false,
      });
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    // Email GHA
    if (gha.email) {
      setImmediate(async function () {
        try {
          await sendCustomerEmail(gha.email, 'GetHome - New Agent Inspection Request',
`Hello ${gha.full_name || 'GHA'},

An agent has been sent to you for inspection and verification.

Agent Name: ${agent.full_name || 'N/A'}
Agent Email: ${agent.email || 'N/A'}

Please review the agent's registration details, conduct the necessary inspection, and confirm to your SA once done.

Log in to your GHA dashboard to action this request.

The GetHome Team
https://trygethome.online`);
        } catch (e) { console.error('send-to-gha email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('SA send-to-gha error:', err.message);
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

// POST /api/sa/add-gha
app.post('/api/sa/add-gha', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;
    const { full_name, email, phone, location, password } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ error: 'full_name, email and password are required' });

    const { count } = await serviceClient
      .from('gha_agents')
      .select('id', { count: 'exact', head: true });
    const gha_code = 'GHA' + String((count || 0) + 1).padStart(4, '0');
    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await serviceClient
      .from('gha_agents')
      .insert([{ full_name, email, phone: phone || null, location: location || null, sa_id: saId, gha_code, password_hash, status: 'active' }])
      .select()
      .single();
    if (error) throw error;

    const result = Object.assign({}, data);
    delete result.password_hash;
    res.status(201).json(result);
  } catch (err) {
    console.error('SA add-gha error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/search-agent
app.get('/api/sa/search-agent', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: session } = await adminClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!session || session.staff_role !== 'SA') {
      return res.status(403).json({ error: 'SA access required' });
    }

    // Get SA location for city matching
    const { data: saRecord } = await adminClient
      .from('service_agents')
      .select('location, sa_code')
      .eq('id', session.staff_id)
      .single();

    const saLocation = (saRecord?.location || '').toLowerCase().trim();

    // Extract city keywords from SA location
    // e.g. 'Wuse Abuja' -> ['wuse', 'abuja']
    const saKeywords = saLocation
      .split(/[\s,]+/)
      .map(w => w.trim())
      .filter(w => w.length > 2);

    console.log('SA', saRecord?.sa_code, 'location:', saLocation, 'keywords:', saKeywords);

    const searchEmail = (req.query.email || '').trim().toLowerCase();
    if (!searchEmail) return res.status(400).json({ error: 'Email is required' });

    // Search by email with role=agent - NO status filter
    const { data: foundAgent, error: searchError } = await adminClient
      .from('profiles')
      .select('id, email, full_name, phone, status, verification_level, gha_id, sa_id, gha_code, office_address, city, experience, specialty, nin_number, cac_number, about, requested_gha_code, created_at')
      .ilike('email', searchEmail)
      .eq('role', 'agent')
      .single();

    if (searchError || !foundAgent) {
      console.log('Agent not found:', searchEmail);
      return res.status(404).json({
        error: 'No registered agent found with that email. Make sure the agent has signed up on GetHome as an agent first.'
      });
    }

    // Location check - only enforce if SA has a location set
    if (saKeywords.length > 0) {
      const agentCity = (foundAgent.city || '').toLowerCase().trim();
      const agentAddress = (foundAgent.office_address || '').toLowerCase().trim();
      const agentLocationText = agentCity + ' ' + agentAddress;

      // Check if any SA keyword appears in agent location OR agent location appears in SA location
      const locationMatch = saKeywords.some(function(keyword) {
        return agentLocationText.includes(keyword) || saLocation.includes(agentCity);
      });

      // Also allow if agent has no city set yet
      const agentHasNoLocation = !agentCity && !agentAddress;

      if (!locationMatch && !agentHasNoLocation) {
        return res.status(400).json({
          error: 'This agent is located in ' + (foundAgent.city || 'a different area') + ' and is outside your service area (' + saRecord?.location + '). Only agents in your area can be assigned to your GHAs.',
          location_mismatch: true,
          agent_city: foundAgent.city || 'Unknown',
          sa_location: saRecord?.location,
        });
      }
    }

    // Check if already assigned to a GHA under a DIFFERENT SA
    if (foundAgent.gha_id && foundAgent.sa_id && foundAgent.sa_id !== session.staff_id) {
      return res.status(400).json({
        error: 'This agent is already assigned to a GHA under a different SA. Only admin can reassign them.',
        locked: true,
      });
    }

    console.log('Agent found and eligible:', foundAgent.email, 'status:', foundAgent.status);

    res.json({
      agent: Object.assign({}, foundAgent, {
        already_assigned: !!(foundAgent.gha_id && foundAgent.sa_id === session.staff_id),
        assigned_gha_code: foundAgent.gha_code || null,
      })
    });
  } catch (err) {
    console.error('Search agent exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/assign-agent-to-gha
app.post('/api/sa/assign-agent-to-gha', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { email, gha_code, agent_id, gha_id } = req.body;
    if ((!email && !agent_id) || (!gha_code && !gha_id)) {
      return res.status(400).json({ error: 'Provide either (agent_id + gha_id) or (email + gha_code)' });
    }

    // Find the agent's UUID - agents live in profiles. Accept a direct agent_id or fall back to email lookup.
    const agentQuery = adminClient
      .from('profiles')
      .select('id, full_name, email, sa_id, gha_id, gha_code')
      .eq('role', 'agent');
    const { data: agentProfile, error: agentErr } = agent_id
      ? await agentQuery.eq('id', agent_id).single()
      : await agentQuery.ilike('email', email.trim()).single();

    if (agentErr || !agentProfile) {
      console.error('Agent lookup failed for', agent_id ? 'id: ' + agent_id : 'email: ' + email, '|', agentErr?.message);
      return res.status(404).json({ error: agent_id ? 'No registered agent found with that id' : 'No registered agent found with that email' });
    }

    // Find the GHA's UUID - GHAs live in gha_agents, NOT profiles. Accept a direct gha_id or fall back to gha_code lookup.
    const ghaQuery = adminClient
      .from('gha_agents')
      .select('id, gha_code, sa_id, full_name');
    const { data: ghaRecord, error: ghaErr } = gha_id
      ? await ghaQuery.eq('id', gha_id).single()
      : await ghaQuery.eq('gha_code', gha_code.trim().toUpperCase()).single();

    if (ghaErr || !ghaRecord) {
      console.error('GHA lookup failed for', gha_id ? 'id: ' + gha_id : 'code: ' + gha_code, '|', ghaErr?.message);
      return res.status(404).json({ error: 'No GHA found with code: ' + gha_code });
    }

    // Verify this GHA actually belongs to the requesting SA
    if (ghaRecord.sa_id !== session.staff_id) {
      return res.status(403).json({ error: 'This GHA does not belong to your team' });
    }

    // Check if agent is already assigned to a GHA under a DIFFERENT SA
    if (agentProfile.gha_id && agentProfile.sa_id && agentProfile.sa_id !== session.staff_id) {
      return res.status(400).json({
        error: 'This agent is already assigned to a GHA under a different SA. Only admin can change this assignment.',
        locked: true,
        current_gha_code: agentProfile.gha_code || 'another GHA',
      });
    }

    // Check if agent is already under THIS SA's GHA - allow reassignment within same SA
    if (agentProfile.gha_id && agentProfile.sa_id === session.staff_id && agentProfile.gha_id === ghaRecord.id) {
      return res.status(400).json({
        error: 'This agent is already assigned to this GHA.',
        already_here: true,
      });
    }

    const { data: sa } = await adminClient.from('service_agents')
      .select('id, sa_code, full_name').eq('id', session.staff_id).single();

    console.log('BEFORE UPDATE - agent_id:', agentProfile.id, '| gha_id:', ghaRecord.id, '| email:', agentProfile.email, '| gha_code:', ghaRecord.gha_code);

    // Now perform the assignment using the resolved real UUIDs
    const { data: updated, error: updateErr } = await adminClient
      .from('profiles')
      .update({
        role: 'agent',
        gha_id: ghaRecord.id,
        sa_id: ghaRecord.sa_id,
        gha_code: ghaRecord.gha_code,
        status: 'approved',
      })
      .eq('id', agentProfile.id)
      .select();

    console.log('UPDATE RESULT - error:', JSON.stringify(updateErr), '| rows affected:', updated ? updated.length : 'null', '| data:', JSON.stringify(updated));

    if (updateErr) {
      console.error('DATABASE UPDATE FAILED:', updateErr.message, updateErr.code, updateErr.details, updateErr.hint);
      return res.status(500).json({ error: 'Database error: ' + updateErr.message });
    }

    if (!updated || updated.length === 0) {
      console.error('CRITICAL: Update query succeeded but affected ZERO rows. agent id:', agentProfile.id);
      return res.status(404).json({ error: 'No profile was updated. The agent may not exist: ' + agentProfile.email });
    }

    console.log('Agent', agentProfile.email, 'assigned to GHA', ghaRecord.gha_code, 'successfully');
    console.log('Agent auto-approved on GHA assignment:', agentProfile.id);

    const updatedProfile = updated[0];
    try {
      await sendCustomerEmail(
        updatedProfile?.email,
        'You have been assigned to a GetHome team',
        `Hello ${updatedProfile?.full_name || 'Agent'},\n\nYou have been assigned to GHA ${ghaRecord.gha_code} - ${ghaRecord.full_name} under SA ${sa?.sa_code}.\n\nYour account is now being reviewed. You will be notified once approved.\n\nGetHome Team`
      );
    } catch(emailErr) { console.error('Assignment email failed:', emailErr.message); }

    const agentName = updatedProfile?.full_name || updatedProfile?.email || 'New Agent';
    try {
      const { error: notifErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'GHA',
        recipient_id: ghaRecord.id,
        type: 'agent_verification',
        title: 'Confirm Agent Information',
        message: 'SA has assigned agent ' + agentName + ' to your team. Please review their registration details and confirm their information so the SA can approve them.',
        is_read: false,
      }]);
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    res.json({ success: true, message: 'Agent assigned to ' + ghaRecord.gha_code, updated_agent: updatedProfile });
  } catch (err) {
    console.error('Assign agent exception:', err.message);
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
    const saCommission = totalRevenue * 0.05;

    const byMonth = {};
    (agents || []).forEach(function(a) {
      if (!a.subscription_start) return;
      const key = a.subscription_start.slice(0, 7);
      if (!byMonth[key]) byMonth[key] = { month: key, revenue: 0, agent_count: 0, sa_commission: 0, is_paid: earningsMap[key]?.is_paid || false };
      byMonth[key].revenue += parseFloat(a.subscription_amount) || 0;
      byMonth[key].agent_count += 1;
      byMonth[key].sa_commission = byMonth[key].revenue * 0.05;
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

// POST /api/gha/verify-agent
app.post('/api/gha/verify-agent', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const { agent_id, notes } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    const { data: agent } = await adminClient.from('profiles')
      .select('*').eq('id', agent_id).single();
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.gha_id !== session.staff_id) return res.status(403).json({ error: 'This agent is not under your GHA' });

    const { error: updateErr } = await adminClient.from('profiles')
      .update({ gha_verified: true, status: 'pending_sa_review' }).eq('id', agent_id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    const { data: saData } = await adminClient.from('service_agents')
      .select('id, email, full_name').eq('id', agent.sa_id).single();

    try {
      const { error: notifErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'SA',
        recipient_id: agent.sa_id,
        type: 'agent_verified',
        title: 'GHA Verified Agent',
        message: 'Agent ' + (agent.full_name || agent.email) + ' has been verified by GHA. You can now approve them.',
        is_read: false,
      }]);
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    try {
      await sendCustomerEmail(
        saData?.email,
        'Agent Verification Complete - Action Required',
        `Hello ${saData?.full_name || 'SA'},\n\nGHA has verified agent ${agent.full_name || agent.email}. Please log in to your SA dashboard to approve this agent.\n\nGetHome Team`
      );
    } catch(emailErr) { console.error('SA email failed:', emailErr.message); }

    res.json({ success: true, message: 'Agent verified successfully. SA has been notified to approve.' });
  } catch (err) {
    console.error('Verify agent exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gha/confirm-agent
app.post('/api/gha/confirm-agent', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const { agent_id, notes } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent_id)) {
      return res.status(400).json({ error: 'agent_id must be a valid UUID, got: ' + agent_id });
    }

    const { data: agent } = await adminClient.from('profiles').select('*').eq('id', agent_id).single();
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.gha_id !== session.staff_id) return res.status(403).json({ error: 'This agent is not under your GHA' });

    const { error: updateErr } = await adminClient.from('profiles')
      .update({ gha_verified: true, status: 'pending_sa_review' }).eq('id', agent_id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    const { data: saData } = await adminClient.from('service_agents')
      .select('id, email, full_name').eq('id', agent.sa_id).single();

    const { error: saNotifyErr } = await adminClient.from('notifications').insert([{
      recipient_type: 'SA',
      recipient_id: agent.sa_id,
      type: 'agent_verified',
      title: 'GHA Confirmed Agent Details',
      message: 'Agent ' + (agent.full_name || agent.email) + ' has been confirmed by their GHA. Ready for your approval.',
      is_read: false,
    }]);
    if (saNotifyErr) {
      console.error('SA notification failed (non-blocking):', saNotifyErr.message);
      // non-blocking - do not throw, just log and continue, since this is typically a notification insert that should never crash the main action
    }

    res.json({ success: true, message: 'Agent confirmed successfully' });
  } catch (err) {
    console.error('Confirm agent exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/overview
app.get('/api/gha/overview', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    // staff_code holds the 'GHA0001' string; profiles.gha_code is how agents are linked
    const ghaCode = req.staffSession.staff_code;
    console.log('GHA overview - gha_code:', ghaCode);

    // Fetch agent IDs first — needed for property queries
    const { data: agentRows, error: agentErr } = await adminClient
      .from('profiles')
      .select('id')
      .eq('gha_code', ghaCode)
      .eq('role', 'agent');

    if (agentErr) {
      console.error('GHA overview agent fetch error:', agentErr.message);
      return res.json({ totalAgents: 0, activeSubscriptions: 0, propertiesSold: 0, activeListings: 0 });
    }

    const agentIds = (agentRows || []).map(function(a) { return a.id; });
    const totalAgents = agentIds.length;
    console.log('GHA overview - found', totalAgents, 'agents for', ghaCode);
    const now = new Date().toISOString();

    // Run remaining counts in parallel
    const [subResult, soldResult, activeResult] = await Promise.all([
      adminClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('gha_code', ghaCode)
        .eq('role', 'agent')
        .gt('subscription_end', now),

      agentIds.length > 0
        ? adminClient
            .from('properties')
            .select('id', { count: 'exact', head: true })
            .in('created_by', agentIds)
            .eq('is_sold', true)
        : Promise.resolve({ count: 0, error: null }),

      agentIds.length > 0
        ? adminClient
            .from('properties')
            .select('id', { count: 'exact', head: true })
            .in('created_by', agentIds)
            .eq('is_sold', false)
        : Promise.resolve({ count: 0, error: null }),
    ]);

    if (subResult.error) console.error('GHA overview sub count error:', subResult.error.message);
    if (soldResult.error) console.error('GHA overview sold count error:', soldResult.error.message);
    if (activeResult.error) console.error('GHA overview active count error:', activeResult.error.message);

    res.json({
      totalAgents,
      activeSubscriptions: subResult.count || 0,
      propertiesSold: soldResult.count || 0,
      activeListings: activeResult.count || 0,
    });
  } catch (err) {
    console.error('GHA overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/my-agents
app.get('/api/gha/my-agents', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    // staff_code holds 'GHA0001'; profiles.gha_code is how agents are linked to this GHA
    const ghaCode = req.staffSession.staff_code;

    console.log('GHA fetching agents - gha_code:', ghaCode);
    const { data: agents, error } = await adminClient
      .from('profiles')
      .select('id, full_name, email, phone, status, verification_level, gha_code, gha_id, sa_id, office_address, city, experience, specialty, nin_number, cac_number, about, gha_verified, subscription_tier, subscription_end, created_at')
      .eq('gha_code', ghaCode)
      .eq('role', 'agent')
      .order('created_at', { ascending: false });

    console.log('Query result - found agents:', (agents || []).length, '| error:', error?.message);
    if (agents && agents.length > 0) {
      console.log('Sample agent gha_id values:', agents.map(a => a.gha_id));
    }

    const enrichedAgents = await Promise.all((agents || []).map(async function(agent) {
      const { count: listingCount } = await adminClient
        .from('properties')
        .select('id', { count: 'exact', head: true })
        .eq('created_by', agent.id);

      const isExpired = agent.subscription_end && new Date(agent.subscription_end) < new Date();

      return Object.assign({}, agent, {
        listing_count: listingCount || 0,
        subscription_tier: agent.subscription_tier || 'free',
        subscription_end: agent.subscription_end || null,
        is_subscription_expired: !!isExpired,
      });
    }));
    res.json(enrichedAgents);
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
app.get('/api/gha/earnings', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const { data: earnings, error } = await adminClient
      .from('gha_earnings')
      .select('*')
      .eq('gha_id', session.staff_id)
      .eq('month_year', month)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('GHA earnings error:', error.message);
      return res.json({ earnings: [], total_commission: 0, is_paid: false });
    }

    const earningsList = earnings || [];
    const totalCommission = earningsList.reduce((sum, e) => sum + (parseFloat(e.commission_amount) || 0), 0);
    const isPaid = earningsList.length > 0 && earningsList.every(e => e.is_paid === true);
    const paidAt = isPaid ? earningsList[0]?.paid_at : null;

    res.json({
      month,
      earnings: earningsList,
      total_commission: totalCommission,
      is_paid: isPaid,
      paid_at: paidAt,
    });
  } catch (err) {
    console.error('GHA earnings exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/earnings
app.get('/api/sa/earnings', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const { data: earnings, error } = await adminClient
      .from('sa_earnings')
      .select('*')
      .eq('sa_id', session.staff_id)
      .eq('month_year', month)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('SA earnings error:', error.message);
      return res.json({ earnings: [], total_commission: 0, is_paid: false });
    }

    const earningsList = earnings || [];
    const totalCommission = earningsList.reduce((sum, e) => sum + (parseFloat(e.commission_amount) || 0), 0);
    const isPaid = earningsList.length > 0 && earningsList.every(e => e.is_paid === true);
    const paidAt = isPaid ? earningsList[0]?.paid_at : null;

    // Also get GHA breakdown for this SA
    const { data: ghaBreakdown } = await adminClient
      .from('sa_earnings')
      .select('gha_id, commission_amount, is_paid, month_year')
      .eq('sa_id', session.staff_id)
      .eq('month_year', month);

    // Enrich with GHA names
    const enrichedBreakdown = await Promise.all((ghaBreakdown || []).map(async function(row) {
      const { data: gha } = await adminClient
        .from('gha_agents')
        .select('gha_code, full_name')
        .eq('id', row.gha_id)
        .maybeSingle();
      return Object.assign({}, row, {
        gha_code: gha?.gha_code || 'Unknown',
        gha_name: gha?.full_name || 'Unknown',
      });
    }));

    res.json({
      month,
      earnings: earningsList,
      total_commission: totalCommission,
      is_paid: isPaid,
      paid_at: paidAt,
      gha_breakdown: enrichedBreakdown,
    });
  } catch (err) {
    console.error('SA earnings exception:', err.message);
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
      .insert([{ full_name, email, phone, location: location || null, sa_code, password_hash, commission_rate: 5 }])
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

    const enriched = await Promise.all((sas || []).map(async function(sa) {
      const { data: ghas } = await serviceClient
        .from('gha_agents')
        .select('id')
        .eq('sa_id', sa.id);
      const ghaIds = (ghas || []).map(function(g) { return g.id; });
      const ghaCount = ghaIds.length;

      let agentCount = 0;
      let monthlyEarnings = 0;
      let totalListings = 0;
      let activeSubscriptions = 0;
      let expiredSubscriptions = 0;

      if (ghaIds.length > 0) {
        const { data: agentsUnderSa } = await serviceClient
          .from('profiles')
          .select('id, subscription_tier, subscription_end, subscription_amount')
          .in('gha_id', ghaIds)
          .eq('role', 'agent');

        const agentIds = (agentsUnderSa || []).map(function(a) { return a.id; });
        agentCount = agentIds.length;

        if (agentIds.length > 0) {
          const { count } = await serviceClient
            .from('properties')
            .select('id', { count: 'exact', head: true })
            .in('created_by', agentIds);
          totalListings = count || 0;
        }

        activeSubscriptions = (agentsUnderSa || []).filter(function(a) {
          return a.subscription_tier && a.subscription_tier !== 'free' && a.subscription_end && new Date(a.subscription_end) > new Date();
        }).length;
        expiredSubscriptions = (agentsUnderSa || []).filter(function(a) {
          return a.subscription_end && new Date(a.subscription_end) < new Date();
        }).length;

        monthlyEarnings = (agentsUnderSa || []).reduce(function(sum, p) {
          return sum + (parseFloat(p.subscription_amount) || 0) * 0.05;
        }, 0);
      }

      const result = Object.assign({}, sa, {
        gha_count: ghaCount,
        agent_count: agentCount,
        monthly_earnings: monthlyEarnings,
        total_listings: totalListings,
        active_subscriptions: activeSubscriptions,
        expired_subscriptions: expiredSubscriptions,
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

    const enriched = await Promise.all((ghas || []).map(async function(gha) {
      const { data: agentsUnderGha } = await serviceClient
        .from('profiles')
        .select('id, subscription_tier, subscription_end, subscription_amount')
        .eq('gha_id', gha.id)
        .eq('role', 'agent');

      const agentIds = (agentsUnderGha || []).map(function(a) { return a.id; });

      let totalListings = 0;
      if (agentIds.length > 0) {
        const { count } = await serviceClient
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .in('created_by', agentIds);
        totalListings = count || 0;
      }

      const activeSubscriptions = (agentsUnderGha || []).filter(function(a) {
        return a.subscription_tier && a.subscription_tier !== 'free' && a.subscription_end && new Date(a.subscription_end) > new Date();
      }).length;
      const expiredSubscriptions = (agentsUnderGha || []).filter(function(a) {
        return a.subscription_end && new Date(a.subscription_end) < new Date();
      }).length;
      const monthlyEarnings = (agentsUnderGha || []).reduce(function(sum, p) {
        return sum + (parseFloat(p.subscription_amount) || 0) * 0.05;
      }, 0);

      const result = Object.assign({}, gha, {
        agent_count: agentIds.length,
        total_listings: totalListings,
        active_subscriptions: activeSubscriptions,
        expired_subscriptions: expiredSubscriptions,
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

// GET /api/admin/search-sa?q=SA001
app.get('/api/admin/search-sa', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

    const { data: sas, error } = await serviceClient
      .from('service_agents')
      .select('*')
      .ilike('sa_code', `%${q}%`)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const now = new Date().toISOString();
    const enriched = await Promise.all((sas || []).map(async function(sa) {
      const { data: ghas } = await serviceClient
        .from('gha_agents').select('id').eq('sa_id', sa.id);
      const ghaIds = (ghas || []).map(function(g) { return g.id; });

      let agentCount = 0;
      if (ghaIds.length > 0) {
        const { count } = await serviceClient
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .in('gha_id', ghaIds)
          .eq('role', 'agent');
        agentCount = count || 0;
      }

      const result = Object.assign({}, sa, {
        gha_count: ghaIds.length,
        agent_count: agentCount,
      });
      delete result.password_hash;
      delete result.gh_staff_token;
      return result;
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Admin search-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/search-gha?q=GHA001
app.get('/api/admin/search-gha', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

    const { data: ghas, error } = await serviceClient
      .from('gha_agents')
      .select('*')
      .ilike('gha_code', `%${q}%`)
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

    const enriched = await Promise.all((ghas || []).map(async function(gha) {
      const { count: agentCount } = await serviceClient
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('gha_id', gha.id)
        .eq('role', 'agent');

      const result = Object.assign({}, gha, {
        agent_count: agentCount || 0,
        sa: gha.sa_id ? (saMap[gha.sa_id] || null) : null,
      });
      delete result.password_hash;
      delete result.gh_staff_token;
      return result;
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Admin search-gha error:', err.message);
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

    const { data: sa } = await serviceClient.from('service_agents').select('email, full_name, sa_code').eq('id', sa_id).single();

    const { error: saErr } = await serviceClient.from('service_agents').update({ status: 'inactive' }).eq('id', sa_id);
    if (saErr) throw saErr;

    const { data: deactivatedGhas, error: ghaErr } = await serviceClient
      .from('gha_agents').update({ status: 'inactive' }).eq('sa_id', sa_id).select('id, gha_code');
    if (ghaErr) throw ghaErr;

    if (sa?.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(sa.email, 'GetHome - Account Deactivated',
`Hello ${sa.full_name || 'Service Agent'},

Your GetHome SA account (${sa.sa_code || ''}) has been deactivated by admin.

If you believe this is an error, please contact GetHome support.

The GetHome Team
https://trygethome.online`);
        } catch (e) { console.error('SA deactivate email error:', e.message); }
      });
    }

    res.json({ success: true, ghas_deactivated: (deactivatedGhas || []).length });
  } catch (err) {
    console.error('Admin deactivate-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reactivate-sa
app.post('/api/admin/reactivate-sa', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { sa_id } = req.body;
    if (!sa_id) return res.status(400).json({ error: 'sa_id is required' });

    const { data: sa } = await serviceClient.from('service_agents').select('email, full_name, sa_code').eq('id', sa_id).single();

    const { error } = await serviceClient.from('service_agents').update({ status: 'active' }).eq('id', sa_id);
    if (error) throw error;

    if (sa?.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(sa.email, 'GetHome - Account Reactivated',
`Hello ${sa.full_name || 'Service Agent'},

Your GetHome SA account (${sa.sa_code || ''}) has been reactivated. You can now log in again.

The GetHome Team
https://trygethome.online`);
        } catch (e) { console.error('SA reactivate email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Admin reactivate-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/deactivate-gha
app.post('/api/admin/deactivate-gha', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { gha_id } = req.body;
    if (!gha_id) return res.status(400).json({ error: 'gha_id is required' });

    const { data: gha } = await serviceClient.from('gha_agents').select('email, full_name, gha_code, sa_id').eq('id', gha_id).single();
    if (!gha) return res.status(404).json({ error: 'GHA not found' });

    const { error: ghaErr } = await serviceClient.from('gha_agents').update({ status: 'inactive' }).eq('id', gha_id);
    if (ghaErr) throw ghaErr;

    const { data: unassignedAgents, error: agentErr } = await serviceClient
      .from('profiles').update({ gha_id: null }).eq('gha_id', gha_id).select('id, full_name, email');
    if (agentErr) throw agentErr;

    if (gha.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(gha.email, 'GetHome - GHA Account Deactivated',
`Hello ${gha.full_name || 'GHA'},

Your GetHome GHA account (${gha.gha_code || ''}) has been deactivated by admin.

If you believe this is an error, contact GetHome support.

The GetHome Team
https://trygethome.online`);
        } catch (e) { console.error('GHA deactivate email error:', e.message); }
      });
    }

    if (gha.sa_id) {
      const { data: saInfo } = await serviceClient.from('service_agents').select('email, full_name').eq('id', gha.sa_id).single();
      if (saInfo?.email) {
        setImmediate(async function() {
          try {
            await sendCustomerEmail(saInfo.email, 'GetHome - GHA Deactivated Under Your SA',
`Hello ${saInfo.full_name || 'SA'},

GHA ${gha.gha_code || gha_id} (${gha.full_name || ''}) has been deactivated by admin.

${(unassignedAgents || []).length} agent(s) under this GHA have been unassigned and are now available for reassignment to another GHA.

Please log in to your SA dashboard to reassign them.

The GetHome Team
https://trygethome.online`);
          } catch (e) { console.error('SA notification email error:', e.message); }
        });
      }
    }

    res.json({ success: true, unassigned_agents: unassignedAgents || [] });
  } catch (err) {
    console.error('Admin deactivate-gha error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reactivate-gha
app.post('/api/admin/reactivate-gha', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { gha_id } = req.body;
    if (!gha_id) return res.status(400).json({ error: 'gha_id is required' });

    const { data: gha } = await serviceClient.from('gha_agents').select('email, full_name, gha_code').eq('id', gha_id).single();

    const { error } = await serviceClient.from('gha_agents').update({ status: 'active' }).eq('id', gha_id);
    if (error) throw error;

    if (gha?.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(gha.email, 'GetHome - GHA Account Reactivated',
`Hello ${gha.full_name || 'GHA'},

Your GetHome GHA account (${gha.gha_code || ''}) has been reactivated. You can now log in again.

The GetHome Team
https://trygethome.online`);
        } catch (e) { console.error('GHA reactivate email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Admin reactivate-gha error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/close-sa — deactivate SA and transfer all GHAs + their agents to another SA
app.post('/api/admin/close-sa', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { sa_id, target_sa_id } = req.body;
    if (!sa_id || !target_sa_id) return res.status(400).json({ error: 'sa_id and target_sa_id are required' });
    if (sa_id === target_sa_id) return res.status(400).json({ error: 'target_sa_id must be different from sa_id' });

    const [{ data: sa }, { data: targetSa }] = await Promise.all([
      serviceClient.from('service_agents').select('email, full_name, sa_code').eq('id', sa_id).single(),
      serviceClient.from('service_agents').select('email, full_name, sa_code').eq('id', target_sa_id).single(),
    ]);
    if (!sa) return res.status(404).json({ error: 'SA not found' });
    if (!targetSa) return res.status(404).json({ error: 'Target SA not found' });

    // Get all GHAs under the closing SA
    const { data: ghas, error: ghaFetchErr } = await serviceClient
      .from('gha_agents').select('id').eq('sa_id', sa_id);
    if (ghaFetchErr) throw ghaFetchErr;

    const ghaIds = (ghas || []).map(g => g.id);

    // Transfer GHAs to target SA
    if (ghaIds.length > 0) {
      const { error: ghaTransferErr } = await serviceClient
        .from('gha_agents').update({ sa_id: target_sa_id }).eq('sa_id', sa_id);
      if (ghaTransferErr) throw ghaTransferErr;

      // Update sa_id on all agents under those GHAs
      const { error: agentTransferErr } = await serviceClient
        .from('profiles').update({ sa_id: target_sa_id }).in('gha_id', ghaIds);
      if (agentTransferErr) throw agentTransferErr;
    }

    // Close the SA
    const { error: saCloseErr } = await serviceClient
      .from('service_agents').update({ status: 'inactive' }).eq('id', sa_id);
    if (saCloseErr) throw saCloseErr;

    setImmediate(async function () {
      try {
        if (sa.email) {
          await sendCustomerEmail(sa.email, 'GetHome - SA Account Closed',
`Hello ${sa.full_name || 'Service Agent'},

Your GetHome SA account (${sa.sa_code || ''}) has been closed by admin.

All GHAs and agents under your account have been transferred to SA ${targetSa.sa_code || target_sa_id}.

If you believe this is an error, please contact GetHome support.

The GetHome Team
https://trygethome.online`);
        }
        if (targetSa.email) {
          await sendCustomerEmail(targetSa.email, 'GetHome - GHAs Transferred to Your SA Account',
`Hello ${targetSa.full_name || 'Service Agent'},

${ghaIds.length} GHA(s) and their agents have been transferred to your SA account (${targetSa.sa_code || ''}) from the closed SA account (${sa.sa_code || ''}).

Please log in to your SA dashboard to review and manage the newly assigned GHAs and agents.

The GetHome Team
https://trygethome.online`);
        }
      } catch (e) { console.error('close-sa email error:', e.message); }
    });

    res.json({ success: true, ghas_transferred: ghaIds.length });
  } catch (err) {
    console.error('Admin close-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/close-gha — deactivate GHA and transfer all its agents to another GHA
app.post('/api/admin/close-gha', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { gha_id, target_gha_id } = req.body;
    if (!gha_id || !target_gha_id) return res.status(400).json({ error: 'gha_id and target_gha_id are required' });
    if (gha_id === target_gha_id) return res.status(400).json({ error: 'target_gha_id must be different from gha_id' });

    const [{ data: gha }, { data: targetGha }] = await Promise.all([
      serviceClient.from('gha_agents').select('email, full_name, gha_code, sa_id').eq('id', gha_id).single(),
      serviceClient.from('gha_agents').select('email, full_name, gha_code, sa_id').eq('id', target_gha_id).single(),
    ]);
    if (!gha) return res.status(404).json({ error: 'GHA not found' });
    if (!targetGha) return res.status(404).json({ error: 'Target GHA not found' });

    // Transfer all agents to the target GHA (also update sa_id to target GHA's sa_id)
    const { data: transferredAgents, error: agentTransferErr } = await serviceClient
      .from('profiles')
      .update({ gha_id: target_gha_id, sa_id: targetGha.sa_id })
      .eq('gha_id', gha_id)
      .select('id, full_name, email');
    if (agentTransferErr) throw agentTransferErr;

    // Close the GHA
    const { error: ghaCloseErr } = await serviceClient
      .from('gha_agents').update({ status: 'inactive' }).eq('id', gha_id);
    if (ghaCloseErr) throw ghaCloseErr;

    setImmediate(async function () {
      try {
        if (gha.email) {
          await sendCustomerEmail(gha.email, 'GetHome - GHA Account Closed',
`Hello ${gha.full_name || 'GHA'},

Your GetHome GHA account (${gha.gha_code || ''}) has been closed by admin.

All agents under your account have been transferred to GHA ${targetGha.gha_code || target_gha_id}.

If you believe this is an error, please contact GetHome support.

The GetHome Team
https://trygethome.online`);
        }
        if (targetGha.email) {
          await sendCustomerEmail(targetGha.email, 'GetHome - Agents Transferred to Your GHA Account',
`Hello ${targetGha.full_name || 'GHA'},

${(transferredAgents || []).length} agent(s) have been transferred to your GHA account (${targetGha.gha_code || ''}) from the closed GHA account (${gha.gha_code || ''}).

Please log in to your GHA dashboard to review and manage the newly assigned agents.

The GetHome Team
https://trygethome.online`);
        }
      } catch (e) { console.error('close-gha email error:', e.message); }
    });

    res.json({ success: true, agents_transferred: (transferredAgents || []).length });
  } catch (err) {
    console.error('Admin close-gha error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reassign-gha', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });


    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !userData?.user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile } = await adminClient
      .from('profiles').select('role').eq('id', userData.user.id).single();
    if (!profile || profile.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { ghaId, newSaId } = req.body;
    console.log('Reassign GHA request - ghaId:', ghaId, 'newSaId:', newSaId);
    if (!ghaId || !newSaId) return res.status(400).json({ error: 'ghaId and newSaId are required' });

    // Try direct update first
    const { data: updateData, error: updateErr } = await adminClient
      .from('gha_agents')
      .update({ sa_id: newSaId })
      .eq('id', ghaId)
      .select();

    if (updateErr) {
      console.error('Direct update failed:', updateErr.message, '| Trying RPC...');
      // Fallback to RPC function
      const { error: rpcErr } = await adminClient.rpc('assign_gha_to_sa', {
        target_gha_id: ghaId,
        target_sa_id: newSaId,
      });
      if (rpcErr) {
        console.error('RPC also failed:', rpcErr.message);
        return res.status(500).json({ error: rpcErr.message });
      }
    }

    console.log('GHA reassigned successfully. Updated rows:', updateData?.length || 'via RPC');

    const { data: gha } = await adminClient.from('gha_agents').select('gha_code, full_name').eq('id', ghaId).single();
    const { data: sa } = await adminClient.from('service_agents').select('sa_code, full_name').eq('id', newSaId).single();

    res.json({
      success: true,
      message: (gha?.gha_code || 'GHA') + ' has been reassigned to ' + (sa?.sa_code || 'SA') + ' - ' + (sa?.full_name || ''),
    });
  } catch (err) {
    console.error('Reassign GHA exception:', err.message);
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

    const { error, count } = await serviceClient
      .from('sa_earnings')
      .update({ is_paid: true, paid_at: new Date().toISOString(), paid_by: admin.id })
      .eq('sa_id', sa_id)
      .eq('month_year', month_year)
      .select();

    console.log('SA mark-paid update result - error:', JSON.stringify(error), '| rows returned:', count, '| sa_id sent:', sa_id, '| month_year sent:', month_year);
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

    // Notify SA immediately so their board updates within next poll
    const { data: saEarning } = await adminClient.from('sa_earnings')
      .select('commission_amount').eq('sa_id', sa_id).eq('month_year', month_year).single();

    const { error: notifErr } = await adminClient.from('notifications').insert([{
      recipient_type: 'SA',
      recipient_id: sa_id,
      type: 'commission_paid',
      title: 'Commission Payment Received',
      message: 'Your commission of NGN ' + (parseFloat(saEarning?.commission_amount || 0)).toLocaleString() + ' for ' + month_year + ' has been paid by admin.',
      is_read: false,
    }]);
    if (notifErr) console.error('SA payment notification failed (non-blocking):', notifErr.message);

    res.json({ success: true, message: 'SA commission marked as paid' });
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

    // Notify GHA immediately so their board updates within next poll
    const { data: ghaEarning } = await adminClient.from('gha_earnings')
      .select('commission_amount').eq('gha_id', gha_id).eq('month_year', month_year).single();

    const { error: notifErr } = await adminClient.from('notifications').insert([{
      recipient_type: 'GHA',
      recipient_id: gha_id,
      type: 'commission_paid',
      title: 'Commission Payment Received',
      message: 'Your commission of NGN ' + (parseFloat(ghaEarning?.commission_amount || 0)).toLocaleString() + ' for ' + month_year + ' has been paid by admin.',
      is_read: false,
    }]);
    if (notifErr) console.error('GHA payment notification failed (non-blocking):', notifErr.message);

    res.json({ success: true, message: 'GHA commission marked as paid' });
  } catch (err) {
    console.error('Admin mark-gha-paid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/earnings
app.get('/api/admin/earnings', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token provided' });


    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'Unauthorized - please log out and log back in' });
    }

    const { data: callerProfile } = await adminClient
      .from('profiles').select('role').eq('id', userData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const { data: ghaEarnings } = await adminClient
      .from('gha_earnings').select('*').eq('month_year', month);
    const { data: saEarnings } = await adminClient
      .from('sa_earnings').select('*').eq('month_year', month);

    const ghaList = ghaEarnings || [];
    const saList  = saEarnings  || [];

    const ghaIds = [...new Set(ghaList.map(e => e.gha_id).filter(Boolean))];
    const saIds  = [...new Set(saList.map(e => e.sa_id).filter(Boolean))];

    let ghaMap = {};
    if (ghaIds.length > 0) {
      const { data: ghaStaff } = await adminClient.from('gha_agents').select('id, gha_code, full_name').in('id', ghaIds);
      (ghaStaff || []).forEach(g => { ghaMap[g.id] = g; });
    }
    let saMap = {};
    if (saIds.length > 0) {
      const { data: saStaff } = await adminClient.from('service_agents').select('id, sa_code, full_name').in('id', saIds);
      (saStaff || []).forEach(s => { saMap[s.id] = s; });
    }

    const enrichedGha = ghaList.map(e => Object.assign({}, e, {
      gha_code: ghaMap[e.gha_id]?.gha_code || 'Unknown',
      gha_name: ghaMap[e.gha_id]?.full_name || 'Unknown',
    }));
    const enrichedSa = saList.map(e => Object.assign({}, e, {
      sa_code: saMap[e.sa_id]?.sa_code || 'Unknown',
      sa_name: saMap[e.sa_id]?.full_name || 'Unknown',
    }));

    const ghaTotal = ghaList.reduce((sum, e) => sum + (parseFloat(e.commission_amount) || 0), 0);
    const saTotal  = saList.reduce((sum, e) => sum + (parseFloat(e.commission_amount) || 0), 0);

    res.json({
      month,
      gha_earnings: enrichedGha,
      sa_earnings: enrichedSa,
      gha_total: ghaTotal,
      sa_total: saTotal,
      grand_total: ghaTotal + saTotal,
    });
  } catch (err) {
    console.error('Earnings endpoint exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/create-inspection
app.post('/api/sa/create-inspection', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { property_id, customer_name, customer_email, customer_phone, property_address, gha_id, inspection_date, notes, inspection_type } = req.body;

    if (!customer_name || !customer_email || !gha_id) {
      return res.status(400).json({ error: 'customer_name, customer_email and gha_id are required' });
    }

    const { data: gha } = await adminClient.from('gha_agents')
      .select('id, gha_code, full_name, sa_id, email').eq('id', gha_id).single();
    if (!gha) return res.status(404).json({ error: 'GHA not found' });
    if (gha.sa_id !== session.staff_id) return res.status(403).json({ error: 'This GHA does not belong to your team' });

    const { data: inspection, error: insertErr } = await adminClient.from('inspections').insert([{
      property_id: property_id ? parseInt(property_id) : null,
      gha_id: gha_id,
      assigned_by_sa: session.staff_id,
      customer_name: customer_name.trim(),
      customer_email: customer_email.trim().toLowerCase(),
      customer_phone: (customer_phone || '').trim(),
      property_address: (property_address || '').trim(),
      inspection_date: inspection_date || null,
      inspection_type: inspection_type || 'physical',
      notes: notes || null,
      status: 'pending',
    }]).select().single();

    if (insertErr) {
      console.error('Inspection insert error:', insertErr.message);
      return res.status(500).json({ error: insertErr.message });
    }

    try {
      const { error: notifErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'GHA',
        recipient_id: gha_id,
        type: 'inspection_request',
        title: 'New Inspection Assigned',
        message: 'Inspect property for customer ' + customer_name + ' at ' + (property_address || 'address TBD') + (inspection_date ? ' on ' + new Date(inspection_date).toLocaleDateString() : ''),
        property_id: property_id ? parseInt(property_id) : null,
        inspection_id: inspection.id,
        customer_email: customer_email,
        customer_phone: customer_phone || '',
        is_read: false,
      }]);
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    try {
      await sendCustomerEmail(
        gha.email,
        'New Inspection Assigned - GetHome',
        `Hello ${gha.full_name},\n\nA new inspection has been assigned to you.\n\nCustomer: ${customer_name}\nEmail: ${customer_email}\nPhone: ${customer_phone || 'Not provided'}\nAddress: ${property_address || 'TBD'}\nDate: ${inspection_date ? new Date(inspection_date).toLocaleString() : 'TBD'}\nType: ${inspection_type || 'Physical'}\n\nPlease log in to your GHA dashboard to view details.\n\nGetHome Team`
      );
    } catch(emailErr) { console.error('GHA notification email failed:', emailErr.message); }

    res.json({ success: true, inspection });
  } catch (err) {
    console.error('Create inspection exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/inspections
app.get('/api/sa/inspections', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { data: inspections, error } = await serviceClient
      .from('inspections')
      .select('*')
      .eq('assigned_by_sa', saId)
      .order('inspection_date', { ascending: false });
    if (error) throw error;

    const ghaIds = [...new Set((inspections || []).map(function(i) { return i.gha_id; }).filter(Boolean))];
    const propertyIds = [...new Set((inspections || []).map(function(i) { return i.property_id; }).filter(Boolean))];

    let ghaMap = {}, propertyMap = {};
    if (ghaIds.length > 0) {
      const { data: ghas } = await serviceClient
        .from('gha_agents').select('id, full_name, gha_code').in('id', ghaIds);
      (ghas || []).forEach(function(g) { ghaMap[g.id] = g; });
    }
    if (propertyIds.length > 0) {
      const { data: props } = await serviceClient
        .from('properties').select('id, title, location').in('id', propertyIds);
      (props || []).forEach(function(p) { propertyMap[p.id] = p; });
    }

    const enriched = (inspections || []).map(function(i) {
      const gha = ghaMap[i.gha_id] || {};
      const prop = propertyMap[i.property_id] || {};
      return Object.assign({}, i, {
        gha_name: gha.full_name || null,
        gha_code: gha.gha_code || null,
        property_title: prop.title || null,
        property_location: prop.location || null,
      });
    });

    res.json(enriched);
  } catch (err) {
    console.error('SA inspections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/confirm-inspection
app.post('/api/sa/confirm-inspection', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { inspection_id } = req.body;
    if (!inspection_id) return res.status(400).json({ error: 'inspection_id is required' });

    const { data: inspection } = await serviceClient
      .from('inspections').select('*').eq('id', inspection_id).eq('assigned_by_sa', saId).single();
    if (!inspection) return res.status(403).json({ error: 'Inspection not found or not assigned by you' });

    const { error } = await serviceClient
      .from('inspections')
      .update({ status: 'confirmed', sa_confirmed: true, sa_confirmed_at: new Date().toISOString() })
      .eq('id', inspection_id);
    if (error) throw error;

    try {
      const { error: notifErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'GHA',
        recipient_id: inspection.gha_id,
        type: 'inspection_passed',
        title: 'Inspection Confirmed by SA',
        message: 'Your inspection for customer ' + inspection.customer_name + ' has been reviewed and confirmed by your SA. Great work!',
        inspection_id: inspection_id,
        is_read: false,
      }]);
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('SA confirm-inspection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gha/mark-inspection-done
app.post('/api/gha/mark-inspection-done', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access only' });
    const ghaId = req.staffSession.staff_id;

    const { inspection_id, notes } = req.body;
    if (!inspection_id) return res.status(400).json({ error: 'inspection_id is required' });
    if (!notes || notes.trim().length < 20) {
      return res.status(400).json({ error: 'Please provide detailed inspection notes of at least 20 characters' });
    }

    const { data: inspection } = await serviceClient
      .from('inspections').select('*').eq('id', inspection_id).eq('gha_id', ghaId).single();
    if (!inspection) return res.status(403).json({ error: 'Inspection not found or not assigned to your GHA' });

    const { error } = await serviceClient
      .from('inspections')
      .update({ status: 'done', notes: notes.trim(), gha_done_at: new Date().toISOString() })
      .eq('id', inspection_id);
    if (error) throw error;

    // After successfully updating the inspection send detailed message to SA
    const { data: inspDetails } = await adminClient.from('inspections')
      .select('*, gha_agents(gha_code, full_name)').eq('id', inspection_id).single();

    if (inspDetails?.assigned_by_sa) {
      const { error: inspMsgErr } = await adminClient.from('staff_messages').insert([{
        sender_type: 'GHA',
        sender_id: req.staffSession.staff_id,
        sender_name: inspDetails.gha_agents?.full_name,
        sender_code: inspDetails.gha_agents?.gha_code,
        recipient_type: 'SA',
        recipient_id: inspDetails.assigned_by_sa,
        subject: 'Inspection Complete: ' + (inspDetails.property_address || 'Property'),
        message: 'Inspection completed for customer ' + (inspDetails.customer_name || 'N/A') +
          '\n\nProperty: ' + (inspDetails.property_address || 'N/A') +
          '\nCustomer Email: ' + (inspDetails.customer_email || 'N/A') +
          '\nCustomer Phone: ' + (inspDetails.customer_phone || 'N/A') +
          '\nInspection Date: ' + new Date(inspDetails.gha_done_at || Date.now()).toLocaleString() +
          '\n\nGHA Notes:\n' + notes,
        message_type: 'inspection_note',
        related_inspection_id: inspection_id,
      }]);
      if (inspMsgErr) console.error('Inspection message failed:', inspMsgErr.message);
    }

    // Notify SA that inspection is done
    try {
      const { error: notifSaErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'SA',
        recipient_id: inspection.assigned_by_sa,
        type: 'inspection_done',
        title: 'Inspection Completed',
        message: 'GHA has completed inspection for customer ' + inspection.customer_name + ' at ' + (inspection.property_address || 'property address') + '. Notes: ' + notes.substring(0, 100),
        inspection_id: inspection_id,
        customer_email: inspection.customer_email,
        customer_phone: inspection.customer_phone || '',
        is_read: false,
      }]);
      if (notifSaErr) console.error('Non-blocking notification error (action still succeeded):', notifSaErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    // Also notify the GHA themselves as confirmation
    try {
      const { error: notifGhaErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'GHA',
        recipient_id: req.staffSession.staff_id,
        type: 'inspection_passed',
        title: 'Inspection Submitted Successfully',
        message: 'Your inspection report for customer ' + inspection.customer_name + ' has been submitted and is awaiting SA confirmation.',
        inspection_id: inspection_id,
        is_read: false,
      }]);
      if (notifGhaErr) console.error('Non-blocking notification error (action still succeeded):', notifGhaErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    if (inspection.assigned_by_sa) {
      const [{ data: sa }, { data: ghaInfo }] = await Promise.all([
        serviceClient.from('service_agents').select('email, full_name').eq('id', inspection.assigned_by_sa).single(),
        serviceClient.from('gha_agents').select('full_name').eq('id', ghaId).single(),
      ]);
      const ghaName = ghaInfo?.full_name || 'GHA';
      const notePreview = notes.trim().slice(0, 100) + (notes.trim().length > 100 ? '...' : '');

      setImmediate(async function() {
        try {
          await serviceClient.from('notifications').insert([{
            recipient_type: 'SA',
            recipient_id: inspection.assigned_by_sa,
            type: 'inspection_done',
            title: 'GHA Completed Inspection',
            message: `${ghaName} has completed the inspection for ${inspection.customer_name || 'N/A'} at ${inspection.property_address || 'N/A'}. Notes: ${notePreview}`,
            is_read: false,
          }]);
        } catch (e) { console.error('GHA mark-done notification insert error:', e.message); }
        if (sa?.email) {
          try {
            await sendCustomerEmail(
              sa.email,
              'GetHome - GHA Has Completed an Inspection',
              `Hello ${sa.full_name || 'SA'},

${ghaName} has completed the inspection for the following:

Customer     : ${inspection.customer_name || 'N/A'}
Property     : ${inspection.property_address || 'N/A'}
Notes        : ${notes.trim()}

Please log in to your SA dashboard to review and confirm this inspection.

The GetHome Team
https://trygethome.online`
            );
          } catch (e) { console.error('GHA mark-inspection-done SA email error:', e.message); }
        }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('GHA mark-inspection-done error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/assign-gha-to-sa
app.post('/api/admin/assign-gha-to-sa', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { gha_id, sa_id } = req.body;
    if (!gha_id || !sa_id) return res.status(400).json({ error: 'gha_id and sa_id are required' });

    const { data: gha } = await serviceClient
      .from('gha_agents').select('id, sa_id').eq('id', gha_id).single();
    if (!gha) return res.status(404).json({ error: 'GHA not found' });

    const { data: sa } = await serviceClient
      .from('service_agents').select('id').eq('id', sa_id).single();
    if (!sa) return res.status(404).json({ error: 'SA not found' });

    // Reassign GHA to new SA
    const { error: ghaErr } = await serviceClient
      .from('gha_agents').update({ sa_id }).eq('id', gha_id);
    if (ghaErr) throw ghaErr;

    // Cascade sa_id update to all agents under this GHA
    const { error: agentErr } = await serviceClient
      .from('profiles').update({ sa_id }).eq('gha_id', gha_id);
    if (agentErr) throw agentErr;

    res.json({ success: true, message: 'GHA assigned to SA successfully' });
  } catch (err) {
    console.error('Admin assign-gha-to-sa error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/assign-agent-to-gha
app.post('/api/admin/assign-agent-to-gha', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !userData?.user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', userData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const { agent_id, gha_id } = req.body;
    console.log('Admin assign request - agent_id:', agent_id, 'gha_id:', gha_id);
    if (!agent_id || !gha_id) return res.status(400).json({ error: 'agent_id and gha_id are required' });

    const { data: gha, error: ghaErr } = await adminClient.from('gha_agents').select('id, gha_code, sa_id, full_name').eq('id', gha_id).single();
    if (ghaErr || !gha) {
      console.error('GHA lookup failed:', ghaErr?.message);
      return res.status(404).json({ error: 'GHA not found with id: ' + gha_id });
    }

    if (typeof agent_id !== 'string' || agent_id.length < 10) {
      console.error('INVALID agent_id received:', agent_id, typeof agent_id);
      return res.status(400).json({ error: 'Invalid agent_id format received: ' + JSON.stringify(agent_id) });
    }
    if (typeof gha_id !== 'string' || gha_id.length < 10) {
      console.error('INVALID gha_id received:', gha_id, typeof gha_id);
      return res.status(400).json({ error: 'Invalid gha_id format received: ' + JSON.stringify(gha_id) });
    }

    console.log('BEFORE UPDATE - agent_id:', agent_id, '| gha_id:', gha_id, '| typeof agent_id:', typeof agent_id, '| typeof gha_id:', typeof gha_id);

    const { data: updated, error: updateErr } = await adminClient
      .from('profiles')
      .update({
        role: 'agent',
        gha_id: gha_id,
        sa_id: gha.sa_id,
        gha_code: gha.gha_code,
        status: 'approved',
      })
      .eq('id', agent_id)
      .select();

    console.log('UPDATE RESULT - error:', JSON.stringify(updateErr), '| rows affected:', updated ? updated.length : 'null', '| data:', JSON.stringify(updated));

    if (updateErr) {
      console.error('DATABASE UPDATE FAILED:', updateErr.message, updateErr.code, updateErr.details, updateErr.hint);
      return res.status(500).json({ error: 'Database error: ' + updateErr.message });
    }

    if (!updated || updated.length === 0) {
      console.error('CRITICAL: Update query succeeded but affected ZERO rows. agent_id may not exist or may be wrong type:', agent_id);
      return res.status(404).json({ error: 'No profile was updated. The agent_id may be invalid: ' + agent_id });
    }

    console.log('VERIFIED SUCCESS - agent profile actually updated:', JSON.stringify(updated[0]));
    console.log('Agent auto-approved on GHA assignment:', agent_id);

    res.json({ success: true, message: 'Agent assigned to ' + gha.gha_code, updated_agent: updated[0] });
  } catch (err) {
    console.error('Admin assign exception:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/inspections
app.get('/api/admin/inspections', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: inspections, error } = await serviceClient
      .from('inspections')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const saIds = [...new Set((inspections || []).map(function(i) { return i.assigned_by_sa; }).filter(Boolean))];
    const ghaIds = [...new Set((inspections || []).map(function(i) { return i.gha_id; }).filter(Boolean))];
    const propertyIds = [...new Set((inspections || []).map(function(i) { return i.property_id; }).filter(Boolean))];

    let saMap = {}, ghaMap = {}, propertyMap = {};

    if (saIds.length > 0) {
      const { data: sas } = await serviceClient
        .from('service_agents')
        .select('id, sa_code, full_name')
        .in('id', saIds);
      (sas || []).forEach(function(s) { saMap[s.id] = s; });
    }
    if (ghaIds.length > 0) {
      const { data: ghas } = await serviceClient
        .from('gha_agents')
        .select('id, gha_code, full_name')
        .in('id', ghaIds);
      (ghas || []).forEach(function(g) { ghaMap[g.id] = g; });
    }
    if (propertyIds.length > 0) {
      const { data: props } = await serviceClient
        .from('properties')
        .select('id, title, location')
        .in('id', propertyIds);
      (props || []).forEach(function(p) { propertyMap[p.id] = p; });
    }

    const enriched = (inspections || []).map(function(i) {
      const sa = saMap[i.assigned_by_sa] || {};
      const gha = ghaMap[i.gha_id] || {};
      const prop = propertyMap[i.property_id] || {};
      return Object.assign({}, i, {
        sa_code: sa.sa_code || null,
        sa_name: sa.full_name || null,
        gha_code: gha.gha_code || null,
        gha_name: gha.full_name || null,
        property_title: prop.title || null,
        property_location: prop.location || null,
      });
    });

    res.json(enriched);
  } catch (err) {
    console.error('Admin inspections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/confirm-inspection
app.post('/api/admin/confirm-inspection', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { inspection_id } = req.body;
    if (!inspection_id) return res.status(400).json({ error: 'inspection_id is required' });

    const { error: updateErr } = await serviceClient
      .from('inspections')
      .update({ status: 'confirmed', sa_confirmed: true, sa_confirmed_at: new Date().toISOString() })
      .eq('id', inspection_id);
    if (updateErr) throw updateErr;

    const { data: inspection } = await serviceClient
      .from('inspections')
      .select('customer_email, customer_name, property_id, property_address')
      .eq('id', inspection_id)
      .single();

    let propertyTitle = null;
    if (inspection?.property_id) {
      const { data: prop } = await serviceClient
        .from('properties')
        .select('title')
        .eq('id', inspection.property_id)
        .single();
      propertyTitle = prop?.title || null;
    }

    if (inspection?.customer_email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            inspection.customer_email,
            'GetHome - Your Property Inspection Has Been Confirmed',
            `Hello ${inspection.customer_name || ''},

We are pleased to inform you that your property inspection has been completed and confirmed by the GetHome team.

Property  : ${propertyTitle || inspection.property_address || 'N/A'}

Our team will be in contact with you shortly with the full report and next steps.

Thank you for choosing GetHome.
The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('Admin confirm-inspection email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Admin confirm-inspection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/reassign-inspection
app.post('/api/admin/reassign-inspection', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { inspection_id, new_gha_id } = req.body;
    if (!inspection_id || !new_gha_id) return res.status(400).json({ error: 'inspection_id and new_gha_id are required' });

    const { data: ghaCheck } = await serviceClient
      .from('gha_agents')
      .select('id, gha_code, full_name, email')
      .eq('id', new_gha_id)
      .single();
    if (!ghaCheck) return res.status(404).json({ error: 'GHA not found' });

    const { data: inspection, error: updateErr } = await serviceClient
      .from('inspections')
      .update({ gha_id: new_gha_id, status: 'pending', gha_done_at: null, notes: null })
      .eq('id', inspection_id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    if (!inspection) return res.status(404).json({ error: 'Inspection not found' });

    try {
      const { error: notifErr } = await serviceClient.from('notifications').insert([{
        recipient_type: 'GHA',
        recipient_id: new_gha_id,
        type: 'inspection_request',
        title: 'Inspection Reassigned to You',
        message: `An inspection for customer "${inspection.customer_name || 'N/A'}" at ${inspection.property_address || 'N/A'} has been reassigned to you. Inspection date: ${inspection.inspection_date || 'TBD'}.`,
        is_read: false,
      }]);
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    if (ghaCheck.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            ghaCheck.email,
            'GetHome - Inspection Reassigned to You',
            `Hello ${ghaCheck.full_name || 'GHA'},

An inspection has been reassigned to you by admin.

INSPECTION DETAILS
------------------
Customer Name   : ${inspection.customer_name || 'N/A'}
Customer Email  : ${inspection.customer_email || 'N/A'}
Customer Phone  : ${inspection.customer_phone || 'N/A'}
Property        : ${inspection.property_address || 'N/A'}
Inspection Date : ${inspection.inspection_date || 'TBD'}

Please log in to your GHA dashboard to view and manage this inspection.

The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('Admin reassign-inspection GHA email error:', e.message); }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Admin reassign-inspection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/property-sa/:propertyId
app.get('/api/property-sa/:propertyId', async (req, res) => {
  try {
    const propertyId = parseInt(req.params.propertyId);
    if (!propertyId) return res.json({});

    const { data: result } = await adminClient.rpc('get_property_sa_whatsapp', {
      property_id_input: propertyId
    });

    if (!result || result.length === 0) {
      console.log('No SA found for property:', propertyId);
      return res.json({ fallback: true });
    }

    const sa = result[0];
    res.json({
      sa_id: sa.sa_id,
      sa_name: sa.sa_name,
      sa_whatsapp: sa.sa_whatsapp,
      sa_email: sa.sa_email,
      sa_code: sa.sa_code,
      matched_city: sa.matched_city,
    });
  } catch (err) {
    console.error('Property SA lookup error:', err.message);
    res.json({ fallback: true });
  }
});

// GET /api/sa/notifications
app.get('/api/sa/notifications', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: session, error: sessionErr } = await adminClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionErr || !session) {
      console.error('SA notifications session error - FULL OBJECT:', JSON.stringify(sessionErr), '| session value:', JSON.stringify(session));
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (session.staff_role !== 'SA') {
      return res.status(403).json({ error: 'SA access required' });
    }

    const saId = session.staff_id;
    console.log('Fetching notifications for SA:', saId);

    const { data: notifs, error: notifErr } = await adminClient
      .from('notifications')
      .select('*')
      .eq('recipient_type', 'SA')
      .eq('recipient_id', saId)
      .eq('dismissed_by_sa', false)
      .order('created_at', { ascending: false })
      .limit(50);

    if (notifErr) {
      console.error('SA notifications query error:', notifErr.message, notifErr.code);
      return res.json({ notifications: [], unread_count: 0 });
    }

    const safeNotifs = notifs || [];
    const unreadCount = safeNotifs.filter(function(n) { return n.is_read === false || n.is_read === null; }).length;

    console.log('SA notifications found:', safeNotifs.length, '| unread:', unreadCount);

    res.json({ notifications: safeNotifs, unread_count: unreadCount });
  } catch (err) {
    console.error('SA notifications exception:', err.message);
    res.json({ notifications: [], unread_count: 0 });
  }
});

// GET /api/gha/notifications
app.get('/api/gha/notifications', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: session, error: sessionErr } = await adminClient
      .from('staff_sessions')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionErr || !session) {
      console.error('GHA notifications session error:', sessionErr?.message);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (session.staff_role !== 'GHA') {
      return res.status(403).json({ error: 'GHA access required' });
    }

    const ghaId = session.staff_id;
    console.log('Fetching notifications for GHA:', ghaId);

    const { data: notifs, error: notifErr } = await adminClient
      .from('notifications')
      .select('*')
      .eq('recipient_type', 'GHA')
      .eq('recipient_id', ghaId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (notifErr) {
      console.error('GHA notifications query error:', notifErr.message, notifErr.code);
      return res.json({ notifications: [], unread_count: 0 });
    }

    const safeNotifs = notifs || [];
    const unreadCount = safeNotifs.filter(function(n) { return n.is_read === false || n.is_read === null; }).length;

    console.log('GHA notifications found:', safeNotifs.length, '| unread:', unreadCount);

    res.json({ notifications: safeNotifs, unread_count: unreadCount });
  } catch (err) {
    console.error('GHA notifications exception:', err.message);
    res.json({ notifications: [], unread_count: 0 });
  }
});

// POST /api/sa/assign-inspection
app.post('/api/sa/assign-inspection', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;

    const { gha_id, notification_id, customer_name, customer_email, customer_phone, property_id, inspection_date, notes } = req.body;
    if (!gha_id) return res.status(400).json({ error: 'gha_id is required' });

    const { data: ghaCheck } = await serviceClient
      .from('gha_agents').select('id, gha_code, full_name, email').eq('id', gha_id).eq('sa_id', saId).single();
    if (!ghaCheck) return res.status(403).json({ error: 'This GHA does not belong to you' });

    const { data: inspection, error: insertErr } = await serviceClient
      .from('inspections')
      .insert([{
        gha_id,
        property_id: property_id || null,
        inspection_date: inspection_date || null,
        customer_name: customer_name || null,
        customer_email: customer_email || null,
        customer_phone: customer_phone || null,
        notes: notes || null,
        assigned_by_sa: saId,
        status: 'pending',
      }])
      .select()
      .single();
    if (insertErr) throw insertErr;

    if (notification_id) {
      await serviceClient.from('notifications').update({ is_read: true }).eq('id', notification_id);
    }

    try {
      const { error: notifErr } = await serviceClient.from('notifications').insert([{
        recipient_type: 'GHA',
        recipient_id: gha_id,
        type: 'inspection_request',
        title: 'New Inspection Assigned',
        message: `You have been assigned a new inspection for customer "${customer_name || 'N/A'}". Inspection date: ${inspection_date || 'TBD'}.`,
        is_read: false,
      }]);
      if (notifErr) console.error('Non-blocking notification error (action still succeeded):', notifErr.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    if (ghaCheck.email) {
      setImmediate(async function() {
        try {
          await sendCustomerEmail(
            ghaCheck.email,
            'GetHome - New Inspection Assigned to You',
            `Hello ${ghaCheck.full_name || 'GHA'},

A new property inspection has been assigned to you.

INSPECTION DETAILS
------------------
Customer Name   : ${customer_name || 'N/A'}
Customer Email  : ${customer_email || 'N/A'}
Customer Phone  : ${customer_phone || 'N/A'}
Inspection Date : ${inspection_date || 'TBD'}
${notes ? 'Notes           : ' + notes : ''}

Please log in to your GHA dashboard to view and manage this inspection.

The GetHome Team
https://trygethome.online`
          );
        } catch (e) { console.error('SA assign-inspection GHA email error:', e.message); }
      });
    }

    res.status(201).json(inspection);
  } catch (err) {
    console.error('SA assign-inspection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mark-notification-read
app.post('/api/mark-notification-read', verifyStaffToken, async (req, res) => {
  try {
    const { notification_id } = req.body;
    if (!notification_id) return res.status(400).json({ error: 'notification_id is required' });

    const { error } = await serviceClient
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notification_id)
      .eq('recipient_id', req.staffSession.staff_id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('mark-notification-read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/profile
app.get('/api/sa/profile', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;
    const { data, error } = await serviceClient
      .from('service_agents')
      .select('id, full_name, email, phone, location, whatsapp_number, sa_code, created_at')
      .eq('id', saId)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('sa/profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/my-locations
app.get('/api/sa/my-locations', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { data: locations } = await adminClient
      .from('sa_locations')
      .select('city, state, is_active')
      .eq('sa_id', session.staff_id)
      .eq('is_active', true)
      .order('city');

    const { data: ghaAssignments } = await adminClient
      .from('gha_location_assignments')
      .select('city, is_primary, gha_agents(gha_code, full_name)')
      .eq('sa_id', session.staff_id)
      .eq('is_active', true)
      .order('city');

    res.json({
      cities: (locations || []).map(function(l) { return l.city; }),
      locations: locations || [],
      gha_assignments: ghaAssignments || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/update-profile
app.post('/api/sa/update-profile', verifyStaffToken, async (req, res) => {
  try {
    if (req.staffSession.staff_role !== 'SA') return res.status(403).json({ error: 'SA access only' });
    const saId = req.staffSession.staff_id;
    let { whatsapp_number, full_name, phone, location } = req.body;

    if (whatsapp_number != null) {
      whatsapp_number = String(whatsapp_number).replace(/[^0-9]/g, '');
      if (whatsapp_number.startsWith('0')) whatsapp_number = '234' + whatsapp_number.substring(1);
    }

    const updates = {};
    if (whatsapp_number != null) updates.whatsapp_number = whatsapp_number;
    if (full_name      != null) updates.full_name      = String(full_name).trim();
    if (phone          != null) updates.phone          = String(phone).trim();
    if (location       != null) updates.location       = String(location).trim();

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });

    let data;
    try {
      const result = await serviceClient
        .from('service_agents')
        .update(updates)
        .eq('id', saId)
        .select('id, full_name, email, phone, location, whatsapp_number, sa_code, created_at')
        .single();
      if (result.error) {
        console.error('sa/update-profile DB error (full):', JSON.stringify(result.error));
        throw result.error;
      }
      data = result.data;
    } catch (dbErr) {
      console.error('sa/update-profile update threw:', JSON.stringify(dbErr));
      throw dbErr;
    }

    res.json(data);
  } catch (err) {
    console.error('sa/update-profile error:', err.message);
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
      (async () => {
        const { error: profileErr } = await supabase.from('profiles')
          .upsert([{ id: finalUserId, role: 'customer', status: 'approved', email: userEmail }], { onConflict: 'id' });
        if (profileErr) console.error('Profile error (non-blocking):', profileErr.message);
        else console.log('Customer profile created for:', userEmail);
      })();
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
  const { email, password, fullName, phone, address, city, experience, specialty, nin, cac, about, requested_gha_code } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  // Block disposable emails
  const blockedDomains = ['mailinator.com','guerrillamail.com','tempmail.com','throwam.com','yopmail.com','sharklasers.com','trashmail.com'];
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (blockedDomains.includes(emailDomain)) {
    return res.status(400).json({ error: 'Disposable email addresses are not allowed. Please use a real email.' });
  }
  try {
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
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

    if (signUpError) {
      // Supabase sometimes returns an email-sending error but still creates the auth user.
      // Treat those as non-blocking; any other error is a real signup failure.
      const isEmailError = signUpError.message.toLowerCase().includes('sending') ||
                           signUpError.message.toLowerCase().includes('email') ||
                           signUpError.message.toLowerCase().includes('confirmation');
      if (!isEmailError) {
        console.error('Auth signup failed:', signUpError.message);
        return res.status(400).json({ error: signUpError.message });
      }
      console.error('Supabase email error for agent (non-blocking):', signUpError.message);
    }

    if (!signUpData || !signUpData.user || !signUpData.user.id) {
      console.error('Signup succeeded but no user object returned');
      return res.status(500).json({ error: 'Account created but user ID missing. Please contact support.' });
    }

    const newUserId = signUpData.user.id;
    console.log('Auth user created successfully with id:', newUserId);

    // Insert into profiles using the EXACT id returned from signUp.
    // adminClient (service role) bypasses RLS so this works before the user is authenticated.
    const { data: agentInsert, error: agentInsertError } = await adminClient
      .from('profiles')
      .upsert([{
        id: newUserId,
        role: 'agent',
        status: 'pending',
        email: email,
        full_name: fullName || null,
        phone: phone || null,
        office_address: address && city ? address + ', ' + city : (address || null),
        city: city || null,
        requested_gha_code: requested_gha_code ? requested_gha_code.toUpperCase().trim() : null,
        experience: experience || null,
        specialty: specialty || null,
        nin_number: nin || null,
        cac_number: cac || null,
        about: about || null,
      }], { onConflict: 'id' })
      .select();

    if (agentInsertError) {
      console.error('Agent profile insert failed:', agentInsertError.message, agentInsertError.code, agentInsertError.details);
      return res.status(500).json({ error: 'Account created but agent profile failed: ' + agentInsertError.message });
    }

    if (!agentInsert || agentInsert.length === 0) {
      console.error('Profile upsert returned no rows for userId:', newUserId);
      return res.status(500).json({ error: 'Account created but profile write unconfirmed. Please contact support.' });
    }

    console.log('Agent profile created successfully:', JSON.stringify(agentInsert[0]));

    // Notification is best-effort only - must never block the registration response
    try {
      let ghaRecordId = null;
      if (requested_gha_code) {
        const { data: ghaRecord } = await adminClient
          .from('gha_agents')
          .select('id')
          .eq('gha_code', requested_gha_code.toUpperCase().trim())
          .single();
        ghaRecordId = ghaRecord?.id || null;
      }
      const { error: notifError } = await adminClient
        .from('notifications')
        .insert([{
          recipient_type: 'GHA',
          recipient_id: ghaRecordId,
          type: 'agent_verification',
          title: 'New Agent Registration',
          message: 'A new agent has registered and requested GHA: ' + (requested_gha_code || 'none specified'),
          is_read: false,
        }]);
      if (notifError) {
        console.error('Non-blocking notification error (registration still succeeded):', notifError.message);
      }
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (registration still succeeded):', notifCatchErr.message);
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

    return res.status(201).json({
      success: true,
      message: 'Registration successful',
      user: { id: newUserId, email: email, role: 'agent' },
      token: signUpData?.session?.access_token || null,
      confirmationRequired: !signUpData?.session,
      agent: agentInsert[0],
    });
  } catch (err) {
    console.error('Agent register error:', err.message);
    return res.status(500).json({ error: 'Agent registration failed. Please try again.' });
  }
});

// POST /api/auth/create-agent-row
// Called by the frontend immediately after Supabase Auth signup completes.
// Uses the service role key (adminClient) to bypass RLS and retries on foreign key
// violations to absorb the auth.users replication delay.
app.post('/api/auth/create-agent-row', async (req, res) => {
  try {
    const { id, email, full_name, name, phone, phone_number, office_address, address, city, experience, specialty, nin, nin_number, cac, cac_number, about, about_self, country, requested_gha_code } = req.body;
    if (!id || !email) return res.status(400).json({ error: 'id and email are required' });

    console.log('Calling create_agent_with_retry RPC for id:', id);

    const { data, error } = await adminClient.rpc('create_agent_with_retry', {
      p_id: id,
      p_email: email,
      p_full_name: full_name || name || null,
      p_phone: phone || phone_number || null,
      p_office_address: office_address || address || null,
      p_city: city || null,
      p_experience: experience || null,
      p_specialty: specialty || null,
      p_nin: nin || nin_number || null,
      p_cac: cac || cac_number || null,
      p_about: about || about_self || null,
      p_country: country || 'NG',
      p_requested_gha_code: requested_gha_code || null,
    });

    if (error) {
      console.error('create_agent_with_retry RPC failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log('Agent created successfully via RPC:', JSON.stringify(data));
    res.status(201).json({ success: true, agent: data });
  } catch (err) {
    console.error('create-agent-row exception:', err.message);
    res.status(500).json({ error: err.message });
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
      const { data: profile, error: profileError } = await adminClient
        .from('profiles')
        .select('role, status, is_unlimited, verification_level')
        .eq('id', data.user.id)
        .single();
      if (profileError) {
        console.error('Profile fetch error on login:', profileError.message);
        // If profile missing entirely, create one so future logins work
        if (profileError.code === 'PGRST116') { // not found
          console.log('Profile missing for user - creating default customer profile');
          const { error: upsertErr } = await adminClient.from('profiles').upsert([{
            id: data.user.id,
            role: 'customer',
            status: 'approved',
            email: email,
          }], { onConflict: 'id' });
          if (upsertErr) console.error('Profile create failed:', upsertErr.message);
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
      const { data: profile } = await adminClient
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
    // Strictly resolve agent identity from token only - never trust client-supplied IDs for auth
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please log in again.' });
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user) {
      console.error('Token validation failed:', authError?.message);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    const agentId = authData.user.id;
    console.log('Authenticated agent ID:', agentId);

    // Authenticated client: passes the user's JWT so Supabase RLS evaluates
    // auth.uid() correctly for this request.
    const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: 'Bearer ' + token } },
    });

    // Fetch profile using the verified ID from token - never from request body
    const { data: profileData, error: profileErr } = await adminClient
      .from('profiles')
      .select('id, role, status, verification_level, is_unlimited')
      .eq('id', agentId)
      .single();

    console.log('Profile lookup result - status:', profileData?.status, '| error:', profileErr?.message);

    if (profileErr || !profileData) {
      console.error('Profile not found for agent:', agentId, profileErr?.message);
      return res.status(403).json({ error: 'Agent profile not found. Please contact support.' });
    }

    const isAdmin     = profileData.role === 'admin';
    const isUnlimited = profileData.is_unlimited === true;
    const level       = profileData.verification_level || 'basic';
    const limits      = { basic: 3, verified: 15, premium: 999 };
    const limit       = limits[level] || 3;

    // Approval check
    if (!isAdmin && profileData.status !== 'approved') {
      console.log('Agent not approved - status:', profileData.status, '| agent:', agentId);
      const statusMsg = profileData.status === 'disapproved'
        ? 'Your agent account has been suspended. Please contact admin.'
        : 'Your agent account is not yet approved. Please wait for admin approval.';
      return res.status(403).json({ error: statusMsg, status: profileData.status });
    }

    // Override created_by with the authenticated user ID so agents can't post as other agents
    req.body.created_by = agentId;

    // Check listing limit for free tier agents
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

    // Notify the agent's SA about the new listing
    if (agentId) {
      try {
        const { data: agentProfile } = await adminClient.from('profiles')
          .select('sa_id, gha_id, full_name, email, gha_code').eq('id', agentId).single();

        // Find SA via direct assignment or via GHA
        var notifySaId = agentProfile?.sa_id;

        if (!notifySaId && agentProfile?.gha_id) {
          const { data: ghaRecord } = await adminClient
            .from('gha_agents')
            .select('sa_id')
            .eq('id', agentProfile.gha_id)
            .single();
          notifySaId = ghaRecord?.sa_id || null;
        }

        if (notifySaId) {
          const { error: notifErr } = await adminClient.from('notifications').insert([{
            recipient_type: 'SA',
            recipient_id: notifySaId,
            type: 'new_listing_alert',
            title: 'New Property Listed',
            message: 'Agent ' + (agentProfile?.full_name || agentProfile?.email || 'Unknown') +
              ' posted a new listing: ' + title +
              ' in ' + location,
            is_read: false,
          }]);
          if (notifErr) console.error('SA new listing notification failed:', notifErr.message);

          const messageText = 'Agent ' + (agentProfile.full_name || agentProfile.email) +
            ' has posted a new listing: ' + title +
            '\nLocation: ' + location +
            '\nPrice: NGN ' + parseFloat(price || 0).toLocaleString() +
            '\n\nPlease instruct the assigned GHA (' + (agentProfile.gha_code || 'GHA') + ') to verify this property.';

          const { error: listingAlertErr } = await adminClient.from('staff_messages').insert([{
            sender_type: 'ADMIN',
            sender_id: notifySaId,
            sender_name: 'System',
            sender_code: 'SYSTEM',
            recipient_type: 'SA',
            recipient_id: notifySaId,
            subject: 'New Listing: ' + title,
            message: messageText,
            message_type: 'new_listing_alert',
            related_property_id: data[0].id,
          }]);
          if (listingAlertErr) console.error('New listing SA alert failed:', listingAlertErr.message);

          console.log('SA', notifySaId, 'notified of new listing by agent', agentId);
        } else {
          console.log('No SA found for agent', agentId, '- notification skipped');
        }
      } catch (e) { console.error('New listing SA alert lookup failed:', e.message); }
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
    // Notify SA if property's agent belongs to one
    setImmediate(async function() {
      try {
        const { data: prop } = await serviceClient
          .from('properties').select('created_by').eq('id', property_id).single();
        if (prop?.created_by) {
          const { data: profile } = await serviceClient
            .from('profiles').select('sa_id').eq('id', prop.created_by).single();
          if (profile?.sa_id) {
            await serviceClient.from('notifications').insert([{
              recipient_type: 'SA',
              recipient_id: profile.sa_id,
              type: 'proxy_payment',
              title: 'Proxy Inspection Payment Received',
              message: `Customer ${user_email || 'N/A'} paid ₦${Number(amount_naira).toLocaleString('en-NG')} for a proxy inspection of "${property_title || 'N/A'}". Reference: ${reference}.`,
              is_read: false,
            }]);
          }
        }
      } catch (e) { console.error('SA proxy-payment notification error:', e.message); }
    });
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
  const { reference, tier, agent_email, user_id } = req.body;
  if (!reference || !tier || !agent_email) return res.status(400).json({ error: "reference, tier, and agent_email required." });
  const tierConfig = { free: { label: 'Free', limit: 3 }, premium: { label: 'Premium', limit: 15 }, agency: { label: 'Agency', limit: 100 } };
  const t = tierConfig[tier] || tierConfig.premium;

  const subscriptionEndDate = new Date();
  subscriptionEndDate.setFullYear(subscriptionEndDate.getFullYear() + 1);
  const subscriptionEndIso = subscriptionEndDate.toISOString();

  // Resolve agent ID — prefer explicit user_id, fall back to email lookup
  let userId = user_id || null;
  if (!userId) {
    const { data: profile } = await adminClient.from('profiles').select('id').eq('email', agent_email).single();
    userId = profile?.id || null;
  }

  if (userId) {
    const { error: profileSubErr } = await adminClient.from('profiles').update({
      subscription_tier: tier,
      subscription_start: new Date().toISOString(),
      subscription_end: subscriptionEndIso,
      subscription_status: 'active',
    }).eq('id', userId);
    if (profileSubErr) console.error('Profile subscription sync failed:', profileSubErr.message);

    const { error: agentSubErr } = await adminClient.from('agents').update({
      subscription_tier: tier,
      subscription_end: subscriptionEndIso,
    }).eq('id', userId);
    if (agentSubErr) {
      console.error('Agent table subscription sync failed (non-blocking):', agentSubErr.message);
      // non-blocking - do not throw, just log and continue, since this is typically a notification insert that should never crash the main action
    }
  } else {
    console.error('Agent upgrade: could not resolve user ID for email', agent_email, '— DB not updated');
  }

  const body = `
 AGENT TIER UPGRADE — ${t.label.toUpperCase()}
=============================================
An agent has upgraded their listing plan.
Paystack Reference : ${reference}
Agent Email        : ${agent_email}
Agent User ID      : ${userId || 'UNRESOLVED — check manually'}
New Tier           : ${t.label}
Listing Limit      : ${t.limit} active listings
Subscription End   : ${subscriptionEndIso}
DB Updated         : ${userId ? 'YES' : 'NO — manual action required'}
=============================================
  `.trim();
  try {
    await sendAdminEmail(` Agent Upgraded to ${t.label} — ${agent_email}`, body);
    console.log(` Agent upgrade notification sent. Ref: ${reference}`);
    res.status(200).json({ success: true, tier, listingLimit: t.limit, subscription_end: subscriptionEndIso });
  } catch (err) {
    console.error("Agent upgrade email error:", err.message);
    res.status(200).json({ success: false, warning: "Payment captured but email failed.", subscription_end: subscriptionEndIso });
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
app.post('/api/gha/mark-notifications-read', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const { notification_id } = req.body;
    if (notification_id) {
      await adminClient.from('notifications').update({ is_read: true })
        .eq('id', notification_id).eq('recipient_id', session.staff_id);
    } else {
      await adminClient.from('notifications').update({ is_read: true })
        .eq('recipient_type', 'GHA').eq('recipient_id', session.staff_id).eq('is_read', false);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN FORCE-ASSIGN AGENT TO GHA
const adminForceAssignHandler = async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    const { data: userData, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !userData?.user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: callerProfile } = await adminClient
      .from('profiles').select('role').eq('id', userData.user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Accept canonical names or legacy aliases from the /assign-agent-gha route
    const agent_id = req.body.target_agent_id || req.body.agent_id;
    const gha_id   = req.body.target_gha_id   || req.body.gha_id;
    if (!agent_id || !gha_id) {
      return res.status(400).json({ error: 'target_agent_id and target_gha_id are required' });
    }

    const { data: gha, error: ghaErr } = await adminClient
      .from('gha_agents')
      .select('id, gha_code, sa_id, full_name')
      .eq('id', gha_id)
      .single();
    if (ghaErr || !gha) {
      console.error('Force-assign GHA lookup failed:', ghaErr?.message);
      return res.status(404).json({ error: 'GHA not found with id: ' + gha_id });
    }

    if (typeof agent_id !== 'string' || agent_id.length < 10) {
      console.error('INVALID agent_id received:', agent_id, typeof agent_id);
      return res.status(400).json({ error: 'Invalid agent_id format received: ' + JSON.stringify(agent_id) });
    }
    if (typeof gha_id !== 'string' || gha_id.length < 10) {
      console.error('INVALID gha_id received:', gha_id, typeof gha_id);
      return res.status(400).json({ error: 'Invalid gha_id format received: ' + JSON.stringify(gha_id) });
    }

    console.log('BEFORE UPDATE - agent_id:', agent_id, '| gha_id:', gha_id, '| typeof agent_id:', typeof agent_id, '| typeof gha_id:', typeof gha_id);

    const { data: updated, error: updateErr } = await adminClient
      .from('profiles')
      .update({
        role: 'agent',
        gha_id: gha_id,
        sa_id: gha.sa_id,
        gha_code: gha.gha_code,
        status: 'approved',
      })
      .eq('id', agent_id)
      .select();

    console.log('UPDATE RESULT - error:', JSON.stringify(updateErr), '| rows affected:', updated ? updated.length : 'null', '| data:', JSON.stringify(updated));

    if (updateErr) {
      console.error('DATABASE UPDATE FAILED:', updateErr.message, updateErr.code, updateErr.details, updateErr.hint);
      return res.status(500).json({ error: 'Database error: ' + updateErr.message });
    }

    if (!updated || updated.length === 0) {
      console.error('CRITICAL: Update query succeeded but affected ZERO rows. agent_id may not exist or may be wrong type:', agent_id);
      return res.status(404).json({ error: 'No profile was updated. The agent_id may be invalid: ' + agent_id });
    }

    console.log('VERIFIED SUCCESS - agent profile actually updated:', JSON.stringify(updated[0]));
    console.log('Agent auto-approved on GHA assignment:', agent_id);

    try {
      const { error: notifError } = await adminClient
        .from('notifications')
        .insert([{
          recipient_id: gha_id,
          recipient_type: 'GHA',
          type: 'agent_verification',
          title: 'New Agent Assigned',
          message: 'An administrator has assigned a new agent to your team for verification.',
          is_read: false,
        }]);
      if (notifError) console.error('Non-blocking notification error (action still succeeded):', notifError.message);
    } catch (notifCatchErr) {
      console.error('Notification insert threw an exception (action still succeeded):', notifCatchErr.message);
    }

    res.status(200).json({
      success: true,
      message: 'Agent successfully linked to GHA.',
      updated_agent: updated[0],
    });
  } catch (err) {
    console.error('Admin force-assign-agent exception:', err.message);
    res.status(500).json({ error: err.message || 'Internal server exception during GHA mapping.' });
  }
};
app.post('/api/admin/force-assign-agent', adminForceAssignHandler);
// Alias: frontend originally called /assign-agent-gha
app.post('/api/admin/assign-agent-gha', adminForceAssignHandler);

// ──────────────────────────────────────────────────────────
// FLUTTERWAVE PAYMENT
// ──────────────────────────────────────────────────────────
app.post('/api/flutterwave/initialize-transaction', async (req, res) => {
  try {
    const { amount, customer_email, customer_name, purpose, property_id } = req.body;
    if (!amount || !customer_email) return res.status(400).json({ error: 'amount and customer_email are required' });

    const reference = 'GH-' + Date.now() + '-' + Math.floor(Math.random() * 10000);

    const flwPayload = {
      tx_ref: reference,
      amount: parseFloat(amount),
      currency: 'NGN',
      redirect_url: 'https://trygethome.online/?payment=complete',
      customer: { email: customer_email, name: customer_name || customer_email },
      customizations: { title: 'GetHome', description: purpose || 'GetHome Payment' },
    };
    flwPayload.meta = req.body.meta || {};

    const initRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FLW_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(flwPayload),
    });
    const initData = await initRes.json();
    if (initData.status !== 'success') {
      console.error('Flutterwave init failed:', JSON.stringify(initData));
      return res.status(500).json({ error: 'Failed to initialize payment' });
    }

    if (property_id) {
      const { error: updateErr } = await adminClient.from('properties').update({
        deposit_reference: reference,
        deposit_amount: amount,
        deposit_status: 'pending',
      }).eq('id', property_id);
      if (updateErr) console.error('Property deposit update failed (non-blocking):', updateErr.message);
    }

    console.log('Flutterwave transaction initialized:', reference);
    res.json({ checkout_url: initData.data.link, reference: reference });
  } catch (err) {
    console.error('Flutterwave initialize exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/flutterwave/webhook', async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
      console.error('Flutterwave webhook signature mismatch - possible spoofed request');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    const reference = event?.data?.tx_ref;
    const status = event?.data?.status;

    console.log('Flutterwave webhook received - reference:', reference, '| status:', status);

    if (status === 'successful') {
      const { error: updateErr } = await adminClient.from('properties').update({
        deposit_status: 'confirmed',
        deposit_confirmed: true,
      }).eq('deposit_reference', reference);
      if (updateErr) console.error('Deposit confirm update failed (non-blocking):', updateErr.message);

      const { data: property } = await adminClient.from('properties')
        .select('title, created_by').eq('deposit_reference', reference).single();

      if (property) {
        const { data: agentProfile } = await adminClient.from('profiles')
          .select('sa_id').eq('id', property.created_by).single();

        if (agentProfile?.sa_id) {
          const { error: notifErr } = await adminClient.from('notifications').insert([{
            recipient_type: 'SA',
            recipient_id: agentProfile.sa_id,
            type: 'proxy_payment',
            title: 'Payment Confirmed via Flutterwave',
            message: 'Payment confirmed for property: ' + property.title + '. Reference: ' + reference,
            is_read: false,
          }]);
          if (notifErr) console.error('Notification insert failed (non-blocking):', notifErr.message);
        }
      }
    }

    // Handle agent subscription payments
    if (status === 'successful' && event?.data?.meta?.payment_type === 'subscription') {
      const agentId = event?.data?.meta?.agent_id;
      const tier = event?.data?.meta?.tier;
      const amount = parseFloat(event?.data?.amount || 0);

      if (agentId && tier) {
        const tierDurations = { premium: 30, agency: 30 };
        const daysToAdd = tierDurations[tier] || 30;
        const subscriptionEnd = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();

        // Update agent subscription in profiles
        const { error: subErr } = await adminClient.from('profiles').update({
          subscription_tier: tier,
          subscription_start: new Date().toISOString(),
          subscription_end: subscriptionEnd,
          subscription_amount: amount,
          subscription_status: 'active',
        }).eq('id', agentId);

        if (subErr) {
          console.error('Subscription update failed (non-blocking):', subErr.message);
        } else {
          console.log('Agent subscription updated:', agentId, tier, subscriptionEnd);

          // Also sync to agents table
          const { error: agentSyncErr } = await adminClient.from('agents').update({
            subscription_tier: tier,
            subscription_end: subscriptionEnd,
          }).eq('id', agentId);
          if (agentSyncErr) console.error('Agents table sync failed (non-blocking):', agentSyncErr.message);

          // Get agent's GHA and SA for earnings calculation
          const { data: agentProfile } = await adminClient
            .from('profiles')
            .select('gha_id, sa_id, gha_code, full_name, email')
            .eq('id', agentId)
            .single();

          const monthYear = new Date().toISOString().slice(0, 7);

          // Create GHA earnings row (5% commission)
          if (agentProfile?.gha_id) {
            const ghaCommission = Math.round(amount * 0.05);
            console.log('Commission calc:', amount, '* 5% =', ghaCommission);
            const { error: ghaEarnErr } = await adminClient.from('gha_earnings').insert([{
              gha_id: agentProfile.gha_id,
              agent_id: agentId,
              agent_email: agentProfile.email,
              subscription_amount: amount,
              commission_rate: 5,
              commission_amount: ghaCommission,
              month_year: monthYear,
              is_paid: false,
            }]);
            if (ghaEarnErr) console.error('GHA earnings insert failed (non-blocking):', ghaEarnErr.message);
            else console.log('GHA earnings created:', agentProfile.gha_id, 'commission:', ghaCommission);

            // Notify GHA
            const { error: ghaNotifErr } = await adminClient.from('notifications').insert([{
              recipient_type: 'GHA',
              recipient_id: agentProfile.gha_id,
              type: 'subscription_payment',
              title: 'Agent Subscription Payment',
              message: 'Agent ' + (agentProfile.full_name || agentProfile.email) + ' subscribed to ' + tier + ' plan. Your commission: NGN ' + ghaCommission.toLocaleString(),
              is_read: false,
            }]);
            if (ghaNotifErr) console.error('GHA notification failed (non-blocking):', ghaNotifErr.message);
          }

          // Create SA earnings row (5% commission)
          if (agentProfile?.sa_id) {
            const saCommission = Math.round(amount * 0.05);
            console.log('Commission calc:', amount, '* 5% =', saCommission);
            const { error: saEarnErr } = await adminClient.from('sa_earnings').insert([{
              sa_id: agentProfile.sa_id,
              gha_id: agentProfile.gha_id || null,
              agent_id: agentId,
              subscription_amount: amount,
              commission_rate: 5,
              commission_amount: saCommission,
              month_year: monthYear,
              is_paid: false,
            }]);
            if (saEarnErr) console.error('SA earnings insert failed (non-blocking):', saEarnErr.message);
            else console.log('SA earnings created:', agentProfile.sa_id, 'commission:', saCommission);

            // Notify SA
            const { error: saNotifErr } = await adminClient.from('notifications').insert([{
              recipient_type: 'SA',
              recipient_id: agentProfile.sa_id,
              type: 'subscription_payment',
              title: 'Agent Subscription Payment',
              message: 'Agent ' + (agentProfile.full_name || agentProfile.email) + ' subscribed to ' + tier + ' plan. Your commission: NGN ' + saCommission.toLocaleString(),
              is_read: false,
            }]);
            if (saNotifErr) console.error('SA notification failed (non-blocking):', saNotifErr.message);
          }
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Flutterwave webhook exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gha-inspection-stats', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });

    let isAuthorized = false;
    let saId = null;

    const { data: staffSession } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (staffSession && staffSession.staff_role === 'SA') {
      isAuthorized = true;
      saId = staffSession.staff_id;
    } else {
      const { data: userData } = await adminClient.auth.getUser(token);
      if (userData?.user) {
        const { data: profile } = await adminClient.from('profiles').select('role').eq('id', userData.user.id).single();
        if (profile?.role === 'admin') isAuthorized = true;
      }
    }

    if (!isAuthorized) return res.status(403).json({ error: 'Admin or SA access required' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const monthStart = month + '-01';
    const nextMonth = new Date(monthStart);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const monthEnd = nextMonth.toISOString().slice(0, 10);

    let ghaQuery = adminClient.from('gha_agents').select('id, gha_code, full_name, sa_id');
    if (saId) ghaQuery = ghaQuery.eq('sa_id', saId);
    const { data: ghas } = await ghaQuery;

    const stats = await Promise.all((ghas || []).map(async function(gha) {
      const { count: completedCount } = await adminClient
        .from('inspections')
        .select('id', { count: 'exact', head: true })
        .eq('gha_id', gha.id)
        .in('status', ['done', 'confirmed'])
        .gte('gha_done_at', monthStart)
        .lt('gha_done_at', monthEnd);

      const { count: pendingCount } = await adminClient
        .from('inspections')
        .select('id', { count: 'exact', head: true })
        .eq('gha_id', gha.id)
        .eq('status', 'pending');

      return {
        gha_id: gha.id,
        gha_code: gha.gha_code,
        gha_name: gha.full_name,
        completed_this_month: completedCount || 0,
        pending_now: pendingCount || 0,
      };
    }));

    stats.sort(function(a, b) { return b.completed_this_month - a.completed_this_month; });
    res.json({ month, stats });
  } catch (err) {
    console.error('GHA inspection stats exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/monthly-history - Admin views any past month
app.get('/api/admin/monthly-history', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const { data: ghaSum } = await adminClient
      .from('monthly_gha_summaries')
      .select('*')
      .eq('month_year', month)
      .order('total_subscription_revenue', { ascending: false });

    const { data: agentSnaps } = await adminClient
      .from('monthly_agent_snapshots')
      .select('*')
      .eq('month_year', month)
      .order('subscription_amount', { ascending: false });

    const { data: availableMonths } = await adminClient
      .from('monthly_gha_summaries')
      .select('month_year')
      .order('month_year', { ascending: false });

    const months = [...new Set((availableMonths || []).map(r => r.month_year))];

    res.json({
      month,
      gha_summaries: ghaSum || [],
      agent_snapshots: agentSnaps || [],
      available_months: months,
    });
  } catch (err) {
    console.error('Monthly history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sa/monthly-history - SA views their own past months
app.get('/api/sa/monthly-history', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const { data: ghaSum } = await adminClient
      .from('monthly_gha_summaries')
      .select('*')
      .eq('sa_id', session.staff_id)
      .eq('month_year', month)
      .order('total_subscription_revenue', { ascending: false });

    const { data: agentSnaps } = await adminClient
      .from('monthly_agent_snapshots')
      .select('*')
      .eq('sa_id', session.staff_id)
      .eq('month_year', month);

    const { data: availableMonths } = await adminClient
      .from('monthly_gha_summaries')
      .select('month_year')
      .eq('sa_id', session.staff_id)
      .order('month_year', { ascending: false });

    const months = [...new Set((availableMonths || []).map(r => r.month_year))];

    res.json({
      month,
      gha_summaries: ghaSum || [],
      agent_snapshots: agentSnaps || [],
      available_months: months,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha/monthly-history - GHA views their own past months
app.get('/api/gha/monthly-history', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const { data: agentSnaps } = await adminClient
      .from('monthly_agent_snapshots')
      .select('*')
      .eq('gha_id', session.staff_id)
      .eq('month_year', month)
      .order('subscription_amount', { ascending: false });

    const { data: availableMonths } = await adminClient
      .from('monthly_agent_snapshots')
      .select('month_year')
      .eq('gha_id', session.staff_id)
      .order('month_year', { ascending: false });

    const months = [...new Set((availableMonths || []).map(r => r.month_year))];

    const totalRevenue = (agentSnaps || []).reduce((sum, a) => sum + (parseFloat(a.subscription_amount) || 0), 0);
    const totalCommission = (agentSnaps || []).reduce((sum, a) => sum + (parseFloat(a.gha_commission) || 0), 0);

    res.json({
      month,
      agent_snapshots: agentSnaps || [],
      available_months: months,
      total_revenue: totalRevenue,
      total_commission: totalCommission,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/take-snapshot - Admin manually triggers a snapshot
app.post('/api/admin/take-snapshot', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const month = req.body.month || null;
    const { data, error } = await adminClient.rpc('take_monthly_snapshot', {
      target_month: month
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/all-payments - Admin overview separating agent subscriptions from customer payments
app.get('/api/admin/all-payments', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    // Agent subscription payments from earnings tables
    const { data: ghaEarnings } = await adminClient
      .from('gha_earnings')
      .select('*, gha_agents(gha_code, full_name)')
      .eq('month_year', month)
      .order('created_at', { ascending: false });

    const { data: saEarnings } = await adminClient
      .from('sa_earnings')
      .select('*, service_agents(sa_code, full_name)')
      .eq('month_year', month)
      .order('created_at', { ascending: false });

    // Customer deposit payments
    const { data: deposits } = await adminClient
      .from('properties')
      .select('id, title, location, deposit_amount, deposit_status, deposit_confirmed, deposit_reference, created_at')
      .not('deposit_amount', 'is', null)
      .order('created_at', { ascending: false });

    // Calculate totals
    const totalAgentRevenue = (ghaEarnings || []).reduce((sum, e) => sum + (parseFloat(e.subscription_amount) || 0), 0);
    const totalCustomerRevenue = (deposits || []).filter(d => d.deposit_confirmed).reduce((sum, d) => sum + (parseFloat(d.deposit_amount) || 0), 0);
    const totalGhaCommission = (ghaEarnings || []).reduce((sum, e) => sum + (parseFloat(e.commission_amount) || 0), 0);
    const totalSaCommission = (saEarnings || []).reduce((sum, e) => sum + (parseFloat(e.commission_amount) || 0), 0);

    res.json({
      month,
      agent_subscriptions: ghaEarnings || [],
      sa_earnings: saEarnings || [],
      customer_deposits: deposits || [],
      totals: {
        agent_subscription_revenue: totalAgentRevenue,
        customer_deposit_revenue: totalCustomerRevenue,
        total_gha_commission: totalGhaCommission,
        total_sa_commission: totalSaCommission,
        grand_total_revenue: totalAgentRevenue + totalCustomerRevenue,
      }
    });
  } catch (err) {
    console.error('All payments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/staff-kpis - fetch all staff KPIs for a month
app.get('/api/admin/staff-kpis', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);

    // Fetch existing KPI records for this month
    const { data: kpis } = await adminClient
      .from('staff_kpis')
      .select('*')
      .eq('month_year', month)
      .order('staff_type')
      .order('staff_code');

    // Fetch all SAs
    const { data: sas } = await adminClient
      .from('service_agents')
      .select('id, sa_code, full_name, status');

    // Fetch all GHAs
    const { data: ghas } = await adminClient
      .from('gha_agents')
      .select('id, gha_code, full_name, status');

    // Merge staff lists with their KPI data
    const saList = (sas || []).map(function(sa) {
      var kpi = (kpis || []).find(function(k) { return k.staff_id === sa.id; }) || {};
      return Object.assign({}, sa, {
        staff_type: 'SA',
        staff_code: sa.sa_code,
        staff_name: sa.full_name,
        kpi_id: kpi.id || null,
        attendance_score: kpi.attendance_score || null,
        csat_score: kpi.csat_score || null,
        inspection_fidelity_score: kpi.inspection_fidelity_score || null,
        onboarding_milestones_score: kpi.onboarding_milestones_score || null,
        response_time_score: kpi.response_time_score || null,
        management_notes: kpi.management_notes || '',
        overall_score: kpi.overall_score || null,
        updated_at: kpi.updated_at || null,
      });
    });

    const ghaList = (ghas || []).map(function(gha) {
      var kpi = (kpis || []).find(function(k) { return k.staff_id === gha.id; }) || {};
      return Object.assign({}, gha, {
        staff_type: 'GHA',
        staff_code: gha.gha_code,
        staff_name: gha.full_name,
        kpi_id: kpi.id || null,
        attendance_score: kpi.attendance_score || null,
        csat_score: kpi.csat_score || null,
        inspection_fidelity_score: kpi.inspection_fidelity_score || null,
        onboarding_milestones_score: kpi.onboarding_milestones_score || null,
        response_time_score: kpi.response_time_score || null,
        management_notes: kpi.management_notes || '',
        overall_score: kpi.overall_score || null,
        updated_at: kpi.updated_at || null,
      });
    });

    res.json({ month, sa_kpis: saList, gha_kpis: ghaList });
  } catch (err) {
    console.error('Staff KPIs fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/staff-kpis - save or update KPI scores for a staff member
app.post('/api/admin/staff-kpis', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const {
      staff_id, staff_type, staff_code, staff_name, month_year,
      attendance_score, csat_score, inspection_fidelity_score,
      onboarding_milestones_score, response_time_score, management_notes
    } = req.body;

    if (!staff_id || !month_year || !staff_type) {
      return res.status(400).json({ error: 'staff_id, staff_type and month_year are required' });
    }

    const { data, error } = await adminClient
      .from('staff_kpis')
      .upsert([{
        staff_id,
        staff_type,
        staff_code,
        staff_name,
        month_year,
        attendance_score: attendance_score !== '' ? parseFloat(attendance_score) : null,
        csat_score: csat_score !== '' ? parseFloat(csat_score) : null,
        inspection_fidelity_score: inspection_fidelity_score !== '' ? parseFloat(inspection_fidelity_score) : null,
        onboarding_milestones_score: onboarding_milestones_score !== '' ? parseFloat(onboarding_milestones_score) : null,
        response_time_score: response_time_score !== '' ? parseFloat(response_time_score) : null,
        management_notes: management_notes || null,
        updated_at: new Date().toISOString(),
      }], { onConflict: 'staff_id,month_year' })
      .select();

    if (error) {
      console.error('Staff KPI save error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log('Staff KPI saved for:', staff_code, month_year);
    res.json({ success: true, kpi: data?.[0] });
  } catch (err) {
    console.error('Staff KPI save exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rate-gha - customer submits a rating after inspection
app.post('/api/rate-gha', async (req, res) => {
  try {
    const {
      inspection_id, gha_id, customer_email, customer_name,
      rating, review_text, categories
    } = req.body;

    if (!gha_id || !rating) {
      return res.status(400).json({ error: 'gha_id and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    // Prevent duplicate ratings for same inspection
    if (inspection_id) {
      const { data: existing } = await adminClient
        .from('gha_ratings')
        .select('id')
        .eq('inspection_id', inspection_id)
        .eq('customer_email', customer_email || '')
        .maybeSingle();
      if (existing) {
        return res.status(400).json({ error: 'You have already rated this inspection' });
      }
    }

    const { data, error } = await adminClient.from('gha_ratings').insert([{
      gha_id,
      inspection_id: inspection_id || null,
      customer_email: customer_email || null,
      customer_name: customer_name || null,
      rating: parseFloat(rating),
      review_text: review_text || null,
      rating_categories: categories || {},
      is_verified: !!inspection_id,
    }]).select().single();

    if (error) {
      console.error('Rating insert error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Notify GHA of new rating
    const { error: notifErr } = await adminClient.from('notifications').insert([{
      recipient_type: 'GHA',
      recipient_id: gha_id,
      type: 'new_rating',
      title: 'New Customer Rating',
      message: 'A customer rated your inspection ' + rating + '/5' + (review_text ? ': "' + review_text.substring(0, 80) + '"' : ''),
      is_read: false,
    }]);
    if (notifErr) console.error('Rating notification failed (non-blocking):', notifErr.message);

    console.log('New GHA rating submitted:', gha_id, rating);
    res.json({ success: true, rating: data });
  } catch (err) {
    console.error('Rate GHA exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gha-ratings/:ghaId - get all ratings for a specific GHA
app.get('/api/gha-ratings/:ghaId', async (req, res) => {
  try {
    const { ghaId } = req.params;
    const { data: ratings, error } = await adminClient
      .from('gha_ratings')
      .select('*')
      .eq('gha_id', ghaId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const ratingsList = ratings || [];
    const average = ratingsList.length > 0
      ? Math.round((ratingsList.reduce((sum, r) => sum + r.rating, 0) / ratingsList.length) * 10) / 10
      : 0;

    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    ratingsList.forEach(function(r) {
      var star = Math.round(r.rating);
      if (distribution[star] !== undefined) distribution[star]++;
    });

    res.json({
      gha_id: ghaId,
      average_rating: average,
      total_ratings: ratingsList.length,
      distribution,
      ratings: ratingsList,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/all-ratings - admin sees all ratings across all GHAs
app.get('/api/admin/all-ratings', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: ratings } = await adminClient
      .from('gha_ratings')
      .select('*, gha_agents(gha_code, full_name, average_rating, total_ratings)')
      .order('created_at', { ascending: false })
      .limit(200);

    const { data: ghas } = await adminClient
      .from('gha_agents')
      .select('id, gha_code, full_name, average_rating, total_ratings')
      .order('average_rating', { ascending: false });

    res.json({
      ratings: ratings || [],
      gha_leaderboard: ghas || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/calculate-kpis', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const { data, error } = await adminClient.rpc('calculate_staff_kpis', { target_month: month });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/staff-targets', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const { staff_type, month_year, inspections_target, response_time_target_hours, agent_verifications_target, csat_target, agent_approvals_target, territory_revenue_target } = req.body;
    const { data, error } = await adminClient.from('staff_monthly_targets').upsert([{
      staff_type, month_year,
      inspections_target: parseInt(inspections_target) || 10,
      response_time_target_hours: parseFloat(response_time_target_hours) || 48,
      agent_verifications_target: parseInt(agent_verifications_target) || 5,
      csat_target: parseFloat(csat_target) || 4.7,
      agent_approvals_target: parseInt(agent_approvals_target) || 20,
      territory_revenue_target: parseFloat(territory_revenue_target) || 0,
    }], { onConflict: 'staff_type,month_year' }).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, targets: data?.[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sa/dismiss-notification', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { notification_id } = req.body;
    if (!notification_id) return res.status(400).json({ error: 'notification_id is required' });

    const { error } = await adminClient.from('notifications')
      .update({
        dismissed_by_sa: true,
        dismissed_at: new Date().toISOString(),
        is_read: true,
      })
      .eq('id', notification_id)
      .eq('recipient_id', session.staff_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sa-locations - get all SA locations for admin management
app.get('/api/admin/sa-locations', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: sas } = await adminClient
      .from('service_agents')
      .select('id, sa_code, full_name, status')
      .order('sa_code');

    const { data: locations } = await adminClient
      .from('sa_locations')
      .select('*')
      .order('city');

    const { data: ghaAssignments } = await adminClient
      .from('gha_location_assignments')
      .select('*, gha_agents(gha_code, full_name)')
      .order('city');

    const enrichedSas = (sas || []).map(function(sa) {
      return Object.assign({}, sa, {
        locations: (locations || []).filter(function(l) { return l.sa_id === sa.id && l.is_active; }),
        gha_assignments: (ghaAssignments || []).filter(function(g) { return g.sa_id === sa.id && g.is_active; }),
      });
    });

    res.json(enrichedSas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sa-add-location - admin adds a city to an SA
app.post('/api/admin/sa-add-location', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { sa_id, city, state } = req.body;
    if (!sa_id || !city) return res.status(400).json({ error: 'sa_id and city are required' });

    const { data, error } = await adminClient.from('sa_locations').upsert([{
      sa_id,
      city: city.trim(),
      state: state ? state.trim() : null,
      is_active: true,
    }], { onConflict: 'sa_id,city' }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    console.log('Location added to SA:', sa_id, city);
    res.json({ success: true, location: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sa-remove-location - admin removes a city from an SA
app.post('/api/admin/sa-remove-location', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { sa_id, city } = req.body;
    if (!sa_id || !city) return res.status(400).json({ error: 'sa_id and city are required' });

    const { error } = await adminClient.from('sa_locations')
      .update({ is_active: false })
      .eq('sa_id', sa_id)
      .eq('city', city.trim());

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, message: city + ' removed from SA coverage' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/gha-assign-location - assign a GHA to cover a specific city
app.post('/api/admin/gha-assign-location', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { gha_id, sa_id, city, is_primary } = req.body;
    if (!gha_id || !sa_id || !city) return res.status(400).json({ error: 'gha_id, sa_id and city are required' });

    // Verify GHA belongs to this SA
    const { data: gha } = await adminClient.from('gha_agents').select('id, gha_code').eq('id', gha_id).eq('sa_id', sa_id).single();
    if (!gha) return res.status(400).json({ error: 'This GHA does not belong to this SA' });

    const { data, error } = await adminClient.from('gha_location_assignments').upsert([{
      gha_id,
      sa_id,
      city: city.trim(),
      is_primary: !!is_primary,
      is_active: true,
    }], { onConflict: 'gha_id,city' }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, assignment: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/gha-inspection-payments', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const monthStart = month + '-01';
    const monthEnd = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1)).toISOString().slice(0, 10);

    const { data: ghas } = await adminClient.from('gha_agents')
      .select('id, gha_code, full_name, sa_id, service_agents(sa_code, full_name)');

    const results = await Promise.all((ghas || []).map(async function(gha) {
      const { data: inspections } = await adminClient
        .from('inspections')
        .select('id, status, gha_done_at, customer_name, customer_email, customer_phone, property_address, property_id, inspection_type')
        .eq('gha_id', gha.id)
        .eq('inspection_type', 'customer')
        .in('status', ['done', 'confirmed'])
        .not('gha_done_at', 'is', null)
        .gte('gha_done_at', monthStart)
        .lt('gha_done_at', monthEnd);

      // For each inspection, get the property title if property_id exists
      const enrichedInspections = await Promise.all((inspections || []).map(async function(insp) {
        var propertyTitle = insp.property_address || 'N/A';
        if (insp.property_id) {
          const { data: prop } = await adminClient
            .from('properties')
            .select('title, location, created_by')
            .eq('id', insp.property_id)
            .maybeSingle();
          if (prop) {
            propertyTitle = prop.title || insp.property_address || 'N/A';
            // Get the agent's GHA
            if (prop.created_by) {
              const { data: agentProfile } = await adminClient
                .from('profiles')
                .select('gha_id, gha_code')
                .eq('id', prop.created_by)
                .maybeSingle();
              insp.agent_gha_id = agentProfile?.gha_id || null;
              insp.agent_gha_code = agentProfile?.gha_code || null;
            }
          }
        }
        return Object.assign({}, insp, {
          property_title: propertyTitle,
          customer_display: insp.customer_email || insp.customer_name || 'Unknown Customer',
        });
      }));

      const count = enrichedInspections.length;

      // Tiered payment calculation
      var payment = 0;
      var breakdown = [];
      if (count >= 1) {
        var tier1 = Math.min(count, 10);
        payment += tier1 * 1200;
        breakdown.push({ tier: '1-10', count: tier1, rate: 1200, subtotal: tier1 * 1200 });
      }
      if (count >= 11) {
        var tier2 = Math.min(count - 10, 10);
        payment += tier2 * 1500;
        breakdown.push({ tier: '11-20', count: tier2, rate: 1500, subtotal: tier2 * 1500 });
      }
      if (count >= 21) {
        var tier3 = count - 20;
        payment += tier3 * 1700;
        breakdown.push({ tier: '21+', count: tier3, rate: 1700, subtotal: tier3 * 1700 });
      }

      return {
        gha_id: gha.id,
        gha_code: gha.gha_code,
        gha_name: gha.full_name,
        sa_code: gha.service_agents?.sa_code || null,
        sa_name: gha.service_agents?.full_name || null,
        month_year: month,
        total_inspections: count,
        payment_breakdown: breakdown,
        total_payment: payment,
        inspections: enrichedInspections,
      };
    }));

    // Sort by total inspections descending
    results.sort(function(a, b) { return b.total_inspections - a.total_inspections; });

    const grandTotal = results.reduce(function(sum, r) { return sum + r.total_payment; }, 0);

    res.json({
      month,
      gha_payments: results,
      grand_total: grandTotal,
      total_inspections: results.reduce(function(sum, r) { return sum + r.total_inspections; }, 0),
    });
  } catch (err) {
    console.error('GHA inspection payments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/staff-payments - calculate and return all staff payment totals
app.get('/api/admin/staff-payments', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const monthStart = month + '-01';
    const monthEnd = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1)).toISOString().slice(0, 10);

    // ── GHA PAYMENTS ────────────────────────────────
    const { data: ghas } = await adminClient
      .from('gha_agents')
      .select('id, gha_code, full_name, email, sa_id, bank_name, account_number, account_name, bank_code, service_agents(sa_code, full_name)');

    const ghaPayments = await Promise.all((ghas || []).map(async function(gha) {
      // Get completed inspections this month
      const { data: inspections } = await adminClient
        .from('inspections')
        .select('id, status, gha_done_at, customer_name, customer_email, customer_phone, property_address, property_id, inspection_type')
        .eq('gha_id', gha.id)
        .eq('inspection_type', 'customer')
        .in('status', ['done', 'confirmed'])
        .not('gha_done_at', 'is', null)
        .gte('gha_done_at', monthStart)
        .lt('gha_done_at', monthEnd);

      // For each inspection, get the property title if property_id exists
      const enrichedInspections = await Promise.all((inspections || []).map(async function(insp) {
        var propertyTitle = insp.property_address || 'N/A';
        if (insp.property_id) {
          const { data: prop } = await adminClient
            .from('properties')
            .select('title, location, created_by')
            .eq('id', insp.property_id)
            .maybeSingle();
          if (prop) {
            propertyTitle = prop.title || insp.property_address || 'N/A';
            // Get the agent's GHA
            if (prop.created_by) {
              const { data: agentProfile } = await adminClient
                .from('profiles')
                .select('gha_id, gha_code')
                .eq('id', prop.created_by)
                .maybeSingle();
              insp.agent_gha_id = agentProfile?.gha_id || null;
              insp.agent_gha_code = agentProfile?.gha_code || null;
            }
          }
        }
        return Object.assign({}, insp, {
          property_title: propertyTitle,
          customer_display: insp.customer_email || insp.customer_name || 'Unknown Customer',
        });
      }));

      const count = enrichedInspections.length;

      // Tiered inspection payment
      var inspPayment = 0;
      var breakdown = [];
      if (count >= 1) {
        var t1 = Math.min(count, 10);
        inspPayment += t1 * 1200;
        breakdown.push({ tier: '1-10', count: t1, rate: 1200, subtotal: t1 * 1200 });
      }
      if (count >= 11) {
        var t2 = Math.min(count - 10, 10);
        inspPayment += t2 * 1500;
        breakdown.push({ tier: '11-20', count: t2, rate: 1500, subtotal: t2 * 1500 });
      }
      if (count >= 21) {
        var t3 = count - 20;
        inspPayment += t3 * 1700;
        breakdown.push({ tier: '21+', count: t3, rate: 1700, subtotal: t3 * 1700 });
      }

      // Commission from subscriptions
      const { data: earnings } = await adminClient
        .from('gha_earnings')
        .select('commission_amount, is_paid')
        .eq('gha_id', gha.id)
        .eq('month_year', month);

      const commissionTotal = (earnings || []).reduce(function(sum, e) {
        return sum + (parseFloat(e.commission_amount) || 0);
      }, 0);

      const totalPayment = inspPayment + commissionTotal;

      // Check existing payment record
      const { data: existingPayment } = await adminClient
        .from('staff_payments')
        .select('*')
        .eq('staff_id', gha.id)
        .eq('month_year', month)
        .maybeSingle();

      // Upsert payment record
      await adminClient.from('staff_payments').upsert([{
        staff_id: gha.id,
        staff_type: 'GHA',
        staff_code: gha.gha_code,
        staff_name: gha.full_name,
        staff_email: gha.email,
        month_year: month,
        inspection_count: count,
        inspection_payment: inspPayment,
        commission_amount: commissionTotal,
        total_payment: totalPayment,
        payment_status: existingPayment?.payment_status || 'unpaid',
        updated_at: new Date().toISOString(),
      }], { onConflict: 'staff_id,month_year' });

      return {
        staff_id: gha.id,
        staff_type: 'GHA',
        gha_code: gha.gha_code,
        gha_name: gha.full_name,
        staff_email: gha.email,
        sa_code: gha.service_agents?.sa_code || null,
        sa_name: gha.service_agents?.full_name || null,
        bank_name: gha.bank_name || null,
        account_number: gha.account_number || null,
        account_name: gha.account_name || null,
        bank_code: gha.bank_code || null,
        inspection_count: count,
        inspection_payment: inspPayment,
        inspection_breakdown: breakdown,
        inspections: enrichedInspections,
        commission_amount: commissionTotal,
        total_payment: totalPayment,
        payment_status: existingPayment?.payment_status || 'unpaid',
        paid_at: existingPayment?.paid_at || null,
        flutterwave_reference: existingPayment?.flutterwave_reference || null,
      };
    }));

    // ── SA PAYMENTS ─────────────────────────────────
    const { data: sas } = await adminClient
      .from('service_agents')
      .select('id, sa_code, full_name, email, bank_name, account_number, account_name, bank_code');

    const saPayments = await Promise.all((sas || []).map(async function(sa) {
      // SA commission from subscriptions
      const { data: saEarnings } = await adminClient
        .from('sa_earnings')
        .select('commission_amount, is_paid')
        .eq('sa_id', sa.id)
        .eq('month_year', month);

      const commissionTotal = (saEarnings || []).reduce(function(sum, e) {
        return sum + (parseFloat(e.commission_amount) || 0);
      }, 0);

      // SA inspection oversight bonus (optional: ₦500 per confirmed inspection under them)
      const { count: confirmedCount } = await adminClient
        .from('inspections')
        .select('id', { count: 'exact', head: true })
        .eq('assigned_by_sa', sa.id)
        .eq('status', 'confirmed')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd);

      const totalPayment = commissionTotal;

      const { data: existingPayment } = await adminClient
        .from('staff_payments')
        .select('*')
        .eq('staff_id', sa.id)
        .eq('month_year', month)
        .maybeSingle();

      await adminClient.from('staff_payments').upsert([{
        staff_id: sa.id,
        staff_type: 'SA',
        staff_code: sa.sa_code,
        staff_name: sa.full_name,
        staff_email: sa.email,
        month_year: month,
        inspection_count: confirmedCount || 0,
        inspection_payment: 0,
        commission_amount: commissionTotal,
        total_payment: totalPayment,
        payment_status: existingPayment?.payment_status || 'unpaid',
        updated_at: new Date().toISOString(),
      }], { onConflict: 'staff_id,month_year' });

      return {
        staff_id: sa.id,
        staff_type: 'SA',
        sa_code: sa.sa_code,
        sa_name: sa.full_name,
        staff_email: sa.email,
        bank_name: sa.bank_name || null,
        account_number: sa.account_number || null,
        account_name: sa.account_name || null,
        bank_code: sa.bank_code || null,
        inspections_overseen: confirmedCount || 0,
        commission_amount: commissionTotal,
        total_payment: totalPayment,
        payment_status: existingPayment?.payment_status || 'unpaid',
        paid_at: existingPayment?.paid_at || null,
        flutterwave_reference: existingPayment?.flutterwave_reference || null,
      };
    }));

    const ghaGrandTotal = ghaPayments.reduce(function(sum, g) { return sum + g.total_payment; }, 0);
    const saGrandTotal = saPayments.reduce(function(sum, s) { return sum + s.total_payment; }, 0);

    res.json({
      month,
      gha_payments: ghaPayments.sort(function(a, b) { return b.total_payment - a.total_payment; }),
      sa_payments: saPayments.sort(function(a, b) { return b.total_payment - a.total_payment; }),
      totals: {
        gha_total: ghaGrandTotal,
        sa_total: saGrandTotal,
        grand_total: ghaGrandTotal + saGrandTotal,
        unpaid_count: [...ghaPayments, ...saPayments].filter(function(p) { return p.payment_status === 'unpaid' && p.total_payment > 0; }).length,
      }
    });
  } catch (err) {
    console.error('Staff payments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/pay-staff-flutterwave - initiate Flutterwave payment to staff
app.post('/api/admin/pay-staff-flutterwave', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { staff_id, staff_type, month_year, total_payment, staff_email, staff_name, staff_code } = req.body;
    if (!staff_id || !total_payment || !staff_email) {
      return res.status(400).json({ error: 'staff_id, total_payment and staff_email are required' });
    }

    const reference = 'GHSTAFF-' + staff_code + '-' + month_year.replace('-', '') + '-' + Date.now();

    // Initialize Flutterwave transfer/payment
    const flwRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FLW_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: reference,
        amount: parseFloat(total_payment),
        currency: 'NGN',
        redirect_url: 'https://trygethome.online/?staff_payment=complete',
        customer: {
          email: staff_email,
          name: staff_name || staff_code,
        },
        customizations: {
          title: 'GetHome Staff Payment',
          description: staff_type + ' ' + staff_code + ' payment for ' + month_year,
        },
        meta: {
          payment_type: 'staff_payment',
          staff_id: staff_id,
          staff_type: staff_type,
          month_year: month_year,
        },
      }),
    });

    const flwData = await flwRes.json();
    if (flwData.status !== 'success') {
      console.error('Flutterwave staff payment init failed:', JSON.stringify(flwData));
      return res.status(500).json({ error: 'Payment initialization failed: ' + (flwData.message || 'Unknown error') });
    }

    // Update payment record to processing
    await adminClient.from('staff_payments').update({
      payment_status: 'processing',
      flutterwave_reference: reference,
      updated_at: new Date().toISOString(),
    }).eq('staff_id', staff_id).eq('month_year', month_year);

    res.json({
      success: true,
      checkout_url: flwData.data.link,
      reference: reference,
    });
  } catch (err) {
    console.error('Staff payment init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/mark-staff-paid - manually mark staff payment as paid
app.post('/api/admin/mark-staff-paid', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { staff_id, month_year, payment_notes } = req.body;
    if (!staff_id || !month_year) return res.status(400).json({ error: 'staff_id and month_year are required' });

    const { data: payment } = await adminClient.from('staff_payments')
      .select('*').eq('staff_id', staff_id).eq('month_year', month_year).single();
    if (!payment) return res.status(404).json({ error: 'Payment record not found' });

    const { error: updateErr } = await adminClient.from('staff_payments').update({
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      paid_by: admin.id,
      payment_notes: payment_notes || null,
      updated_at: new Date().toISOString(),
    }).eq('staff_id', staff_id).eq('month_year', month_year);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Notify staff member
    const { error: notifErr } = await adminClient.from('notifications').insert([{
      recipient_type: payment.staff_type,
      recipient_id: staff_id,
      type: 'payment_received',
      title: 'Payment Received',
      message: 'Your payment of NGN ' + parseFloat(payment.total_payment).toLocaleString() + ' for ' + month_year + ' has been processed. Thank you for your service!',
      is_read: false,
    }]);
    if (notifErr) console.error('Staff payment notification failed:', notifErr.message);

    res.json({ success: true, message: 'Payment marked as paid successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/update-bank-details - SA updates their bank account
app.post('/api/sa/update-bank-details', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { bank_name, account_number, account_name, bank_code } = req.body;
    if (!bank_name || !account_number || !account_name) {
      return res.status(400).json({ error: 'bank_name, account_number and account_name are required' });
    }
    if (account_number.length < 10 || account_number.length > 10) {
      return res.status(400).json({ error: 'Account number must be exactly 10 digits' });
    }

    const { data, error } = await adminClient.from('service_agents')
      .update({
        bank_name: bank_name.trim(),
        account_number: account_number.trim(),
        account_name: account_name.trim(),
        bank_code: bank_code || null,
      })
      .eq('id', session.staff_id)
      .select('id, sa_code, full_name, bank_name, account_number, account_name')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    console.log('SA bank details updated:', session.staff_id);
    res.json({ success: true, message: 'Bank details updated successfully', data });
  } catch (err) {
    console.error('SA bank update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gha/update-bank-details - GHA updates their bank account
app.post('/api/gha/update-bank-details', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const { bank_name, account_number, account_name, bank_code } = req.body;
    if (!bank_name || !account_number || !account_name) {
      return res.status(400).json({ error: 'bank_name, account_number and account_name are required' });
    }
    if (account_number.length !== 10) {
      return res.status(400).json({ error: 'Account number must be exactly 10 digits' });
    }

    const { data, error } = await adminClient.from('gha_agents')
      .update({
        bank_name: bank_name.trim(),
        account_number: account_number.trim(),
        account_name: account_name.trim(),
        bank_code: bank_code || null,
      })
      .eq('id', session.staff_id)
      .select('id, gha_code, full_name, bank_name, account_number, account_name')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    console.log('GHA bank details updated:', session.staff_id);
    res.json({ success: true, message: 'Bank details updated successfully', data });
  } catch (err) {
    console.error('GHA bank update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/verify-bank-account - verify bank account via Flutterwave before paying
app.post('/api/admin/verify-bank-account', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { account_number, bank_code } = req.body;
    if (!account_number || !bank_code) {
      return res.status(400).json({ error: 'account_number and bank_code are required' });
    }

    const flwRes = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FLW_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_number, account_bank: bank_code }),
    });

    const flwData = await flwRes.json();
    if (flwData.status !== 'success') {
      return res.status(400).json({ error: 'Could not verify account: ' + (flwData.message || 'Invalid account details') });
    }

    res.json({
      success: true,
      account_name: flwData.data.account_name,
      account_number: flwData.data.account_number,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/pay-staff-transfer - pay staff via Flutterwave bank transfer
app.post('/api/admin/pay-staff-transfer', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { staff_id, staff_type, month_year } = req.body;
    if (!staff_id || !staff_type || !month_year) {
      return res.status(400).json({ error: 'staff_id, staff_type and month_year are required' });
    }

    const table = staff_type === 'SA' ? 'service_agents' : 'gha_agents';
    const { data: staff } = await adminClient.from(table)
      .select('id, full_name, email, bank_name, account_number, account_name, bank_code')
      .eq('id', staff_id).single();

    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    if (!staff.account_number || !staff.bank_code) {
      return res.status(400).json({
        error: staff.full_name + ' has not added their bank account details yet. Please ask them to update their profile first.',
      });
    }

    const { data: payment } = await adminClient.from('staff_payments')
      .select('*').eq('staff_id', staff_id).eq('month_year', month_year).single();
    if (!payment) return res.status(404).json({ error: 'No payment record found for this month' });
    if (payment.total_payment <= 0) return res.status(400).json({ error: 'Payment amount is zero — nothing to pay' });
    if (payment.payment_status === 'paid') return res.status(400).json({ error: 'This payment has already been processed' });

    const reference = 'GHSTAFF-' + (staff_type === 'SA' ? 'SA' : 'GHA') + '-' + month_year.replace('-', '') + '-' + Date.now();

    // Initiate Flutterwave transfer
    const transferRes = await fetch('https://api.flutterwave.com/v3/transfers', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FLW_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account_bank: staff.bank_code,
        account_number: staff.account_number,
        amount: parseFloat(payment.total_payment),
        narration: 'GetHome ' + staff_type + ' payment ' + month_year,
        currency: 'NGN',
        reference: reference,
        beneficiary_name: staff.account_name || staff.full_name,
        meta: {
          sender: 'GetHome',
          sender_country: 'NG',
          mobile_number: '',
        },
      }),
    });

    const transferData = await transferRes.json();
    console.log('Flutterwave transfer response:', JSON.stringify(transferData));

    if (transferData.status !== 'success') {
      return res.status(500).json({
        error: 'Transfer failed: ' + (transferData.message || 'Unknown Flutterwave error'),
        details: transferData,
      });
    }

    // Mark as processing
    await adminClient.from('staff_payments').update({
      payment_status: 'processing',
      flutterwave_reference: reference,
      flutterwave_tx_id: transferData.data?.id?.toString() || null,
      updated_at: new Date().toISOString(),
    }).eq('staff_id', staff_id).eq('month_year', month_year);

    // Notify staff
    const { error: paymentNotifErr } = await adminClient.from('notifications').insert([{
      recipient_type: staff_type,
      recipient_id: staff_id,
      type: 'payment_processing',
      title: 'Payment Processing',
      message: 'Your payment of NGN ' + parseFloat(payment.total_payment).toLocaleString() + ' for ' + month_year + ' is being processed to your ' + staff.bank_name + ' account ending ' + staff.account_number.slice(-4) + '.',
      is_read: false,
    }]);
    if (paymentNotifErr) console.error('Payment notification failed:', paymentNotifErr.message);

    res.json({
      success: true,
      message: 'Transfer initiated successfully to ' + staff.bank_name + ' ' + staff.account_number,
      reference: reference,
      transfer_id: transferData.data?.id,
    });
  } catch (err) {
    console.error('Staff transfer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/messages - fetch inbox for SA or GHA
app.get('/api/staff/messages', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { data: messages } = await adminClient
      .from('staff_messages')
      .select('*')
      .eq('recipient_type', session.staff_role)
      .eq('recipient_id', session.staff_id)
      .order('created_at', { ascending: false })
      .limit(50);

    const unread = (messages || []).filter(function(m) { return !m.is_read; }).length;
    res.json({ messages: messages || [], unread_count: unread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staff/sent-messages - fetch sent messages
app.get('/api/staff/sent-messages', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { data: messages } = await adminClient
      .from('staff_messages')
      .select('*')
      .eq('sender_type', session.staff_role)
      .eq('sender_id', session.staff_id)
      .order('created_at', { ascending: false })
      .limit(50);

    res.json({ messages: messages || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/send-message - send a message
app.post('/api/staff/send-message', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { recipient_type, recipient_id, subject, message, message_type, related_inspection_id, related_property_id } = req.body;
    if (!recipient_type || !recipient_id || !message) {
      return res.status(400).json({ error: 'recipient_type, recipient_id and message are required' });
    }

    // Get sender details
    const senderTable = session.staff_role === 'SA' ? 'service_agents' : 'gha_agents';
    const senderCode = session.staff_role === 'SA' ? 'sa_code' : 'gha_code';
    const { data: sender } = await adminClient.from(senderTable)
      .select('full_name, ' + senderCode).eq('id', session.staff_id).single();

    // Get recipient details
    let recipientName = null;
    let recipientCode = null;
    if (recipient_type === 'SA') {
      const { data: rec } = await adminClient.from('service_agents')
        .select('full_name, sa_code').eq('id', recipient_id).single();
      recipientName = rec?.full_name;
      recipientCode = rec?.sa_code;
    } else if (recipient_type === 'GHA') {
      const { data: rec } = await adminClient.from('gha_agents')
        .select('full_name, gha_code').eq('id', recipient_id).single();
      recipientName = rec?.full_name;
      recipientCode = rec?.gha_code;
    } else if (recipient_type === 'ADMIN') {
      recipientName = 'Admin';
      recipientCode = 'ADMIN';
    }

    // When sending to ADMIN use a fixed known value instead of a placeholder UUID
    var finalRecipientId = recipient_id;
    if (recipient_type === 'ADMIN') {
      finalRecipientId = 'admin';
    }

    const { data: newMessage, error: insertErr } = await adminClient
      .from('staff_messages')
      .insert([{
        sender_type: session.staff_role.toUpperCase(),
        sender_id: session.staff_id,
        sender_name: sender?.full_name,
        sender_code: sender?.[senderCode],
        recipient_type: (recipient_type || '').toUpperCase(),
        recipient_id: finalRecipientId,
        recipient_name: recipientName,
        recipient_code: recipientCode,
        subject: subject || null,
        message: message.trim(),
        message_type: message_type || 'general',
        related_inspection_id: related_inspection_id || null,
        related_property_id: related_property_id || null,
      }])
      .select().single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // Also insert a notification so recipient sees it immediately
    const { error: msgNotifErr } = await adminClient.from('notifications').insert([{
      recipient_type,
      recipient_id: finalRecipientId,
      type: 'new_message',
      title: 'New Message from ' + (sender?.[senderCode] || session.staff_role),
      message: (subject ? subject + ': ' : '') + message.trim().substring(0, 100),
      is_read: false,
    }]);
    if (msgNotifErr) console.error('Message notification failed:', msgNotifErr.message);

    res.json({ success: true, message: newMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staff/mark-message-read
app.post('/api/staff/mark-message-read', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { message_id } = req.body;
    if (message_id) {
      await adminClient.from('staff_messages').update({ is_read: true, read_at: new Date().toISOString() })
        .eq('id', message_id).eq('recipient_id', session.staff_id);
    } else {
      await adminClient.from('staff_messages').update({ is_read: true, read_at: new Date().toISOString() })
        .eq('recipient_type', session.staff_role).eq('recipient_id', session.staff_id).eq('is_read', false);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/send-message - admin sends message to SA or GHA
app.post('/api/admin/send-message', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { recipient_type, recipient_id, subject, message, message_type, related_inspection_id, related_property_id } = req.body;
    if (!recipient_type || !recipient_id || !message) {
      return res.status(400).json({ error: 'recipient_type, recipient_id and message are required' });
    }

    const { data: newMessage, error: insertErr } = await adminClient
      .from('staff_messages')
      .insert([{
        sender_type: 'ADMIN',
        sender_id: admin.id,
        sender_name: 'Admin',
        sender_code: 'ADMIN',
        recipient_type: (recipient_type || '').toUpperCase(),
        recipient_id,
        subject: subject || null,
        message: message.trim(),
        message_type: message_type || 'general',
        related_inspection_id: related_inspection_id || null,
        related_property_id: related_property_id || null,
      }])
      .select().single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    const { error: adminMsgNotifErr } = await adminClient.from('notifications').insert([{
      recipient_type,
      recipient_id,
      type: 'new_message',
      title: 'New Message from Admin',
      message: (subject ? subject + ': ' : '') + message.trim().substring(0, 100),
      is_read: false,
    }]);
    if (adminMsgNotifErr) console.error('Admin message notification failed:', adminMsgNotifErr.message);

    res.json({ success: true, message: newMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/messages - admin views all messages
app.get('/api/admin/messages', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    console.log('Admin messages endpoint hit - admin id:', admin?.id);

    const { data: inbox, error: inboxErr } = await adminClient
      .from('staff_messages')
      .select('*')
      .eq('recipient_type', 'ADMIN')
      .order('created_at', { ascending: false })
      .limit(100);

    console.log('Admin inbox query result - count:', (inbox || []).length, '| error:', inboxErr?.message);
    console.log('Raw inbox data:', JSON.stringify(inbox?.slice(0, 2)));

    const { data: sent } = await adminClient
      .from('staff_messages')
      .select('*')
      .eq('sender_type', 'ADMIN')
      .order('created_at', { ascending: false })
      .limit(100);

    res.json({
      inbox: inbox || [],
      sent: sent || [],
      unread_count: (inbox || []).filter(function(m) { return !m.is_read; }).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sa/my-listings', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    console.log('SA listings request - staff_id:', session.staff_id);

    // Approach 1: agents directly assigned to this SA
    const { data: directAgents } = await adminClient
      .from('profiles')
      .select('id, full_name, email, gha_id, gha_code')
      .eq('sa_id', session.staff_id)
      .eq('role', 'agent');

    console.log('Direct agents (sa_id match):', (directAgents || []).length);

    // Approach 2: agents under GHAs that belong to this SA
    const { data: saGhas } = await adminClient
      .from('gha_agents')
      .select('id, gha_code')
      .eq('sa_id', session.staff_id);

    const ghaIds = (saGhas || []).map(function(g) { return g.id; });

    console.log('GHAs under this SA:', (saGhas || []).length, '| GHA ids:', ghaIds);

    let ghaAgents = [];
    if (ghaIds.length > 0) {
      const { data: agentsViaGha } = await adminClient
        .from('profiles')
        .select('id, full_name, email, gha_id, gha_code')
        .in('gha_id', ghaIds)
        .eq('role', 'agent');
      ghaAgents = agentsViaGha || [];
    }

    console.log('Agents via GHA:', ghaAgents.length);

    // Merge and deduplicate by agent id
    const agentMap = {};
    [...(directAgents || []), ...ghaAgents].forEach(function(a) {
      agentMap[a.id] = a;
    });
    const agents = Object.values(agentMap);

    const agentIds = agents.map(function(a) { return a.id; });

    console.log('Total unique agents:', agents.length, '| agent ids:', agentIds);

    try {
      const agentIds = agents.map(function(a) { return a.id; });
      console.log('Fetching listings for', agentIds.length, 'agents');

      const { data: listings, error } = await adminClient
        .from('properties')
        .select('id, title, rent, price, location, image_urls, created_at, created_by, property_type, deposit_status, gha_verified, gha_verified_by, gha_verified_at, verification_notes, agency_fee, agreement_fee, caution_fee, inspection_fee, inspection_fee_set_at, is_featured')
        .in('created_by', agentIds)
        .order('created_at', { ascending: false });

      console.log('Properties query done - count:', (listings || []).length, '| error:', error?.message);

      if (error) return res.status(500).json({ error: 'Properties query failed: ' + error.message });

      const enriched = (listings || []).map(function(listing) {
        const agent = agentMap[listing.created_by] || {};
        const gha = (saGhas || []).find(function(g) { return g.id === agent.gha_id; }) || {};
        return Object.assign({}, listing, {
          agent_name: agent.full_name || 'Unknown',
          agent_email: agent.email || null,
          agent_gha_id: agent.gha_id || null,
          agent_gha_code: agent.gha_code || gha.gha_code || null,
          display_price: listing.rent || listing.price || 0,
          display_image: (listing.image_urls && listing.image_urls[0]) || null,
        });
      });

      console.log('Enrichment done - final count:', enriched.length);
      res.json(enriched);
    } catch (innerErr) {
      console.error('SA listings INNER ERROR:', innerErr.message, innerErr.stack);
      res.status(500).json({ error: innerErr.message });
    }
  } catch (err) {
    console.error('SA listings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sa/peer-sas', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { data: sas } = await adminClient
      .from('service_agents')
      .select('id, sa_code, full_name')
      .neq('id', session.staff_id)
      .eq('status', 'active')
      .order('sa_code');

    res.json(sas || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gha/verify-listing', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'GHA') return res.status(403).json({ error: 'GHA access required' });

    const { property_id, verification_notes } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });

    const { data: gha } = await adminClient.from('gha_agents')
      .select('gha_code, full_name, sa_id').eq('id', session.staff_id).single();

    const { data: updated, error: updateErr } = await adminClient
      .from('properties')
      .update({
        gha_verified: true,
        gha_verified_by: session.staff_id,
        gha_verified_at: new Date().toISOString(),
        verification_notes: verification_notes || null,
      })
      .eq('id', property_id)
      .select('id, title, created_by')
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Notify SA that property has been verified
    if (gha?.sa_id) {
      const { error: notifErr } = await adminClient.from('notifications').insert([{
        recipient_type: 'SA',
        recipient_id: gha.sa_id,
        type: 'listing_verified',
        title: 'Property Verified by GHA',
        message: gha.gha_code + ' has verified property: ' + (updated?.title || 'Property #' + property_id) + (verification_notes ? '\n\nNotes: ' + verification_notes : ''),
        is_read: false,
      }]);
      if (notifErr) console.error('Verification notification failed:', notifErr.message);

      // Also send inbox message to SA
      const { error: msgErr } = await adminClient.from('staff_messages').insert([{
        sender_type: 'GHA',
        sender_id: session.staff_id,
        sender_name: gha.full_name,
        sender_code: gha.gha_code,
        recipient_type: 'SA',
        recipient_id: gha.sa_id,
        subject: 'Property Verified: ' + (updated?.title || 'Property #' + property_id),
        message: 'I have completed the physical verification of this property.\n\nProperty: ' + (updated?.title || 'Property #' + property_id) + '\n\nVerification Status: VERIFIED ✓' + (verification_notes ? '\n\nVerification Notes:\n' + verification_notes : '\n\nNo issues found. Property details are accurate.'),
        message_type: 'listing_verification',
        related_property_id: property_id,
      }]);
      if (msgErr) console.error('Verification message failed:', msgErr.message);
    }

    console.log('Property', property_id, 'verified by GHA', gha?.gha_code);
    res.json({ success: true, message: 'Property verified successfully', property: updated });
  } catch (err) {
    console.error('Verify listing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/mark-message-read
app.post('/api/admin/mark-message-read', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { message_id } = req.body;
    if (message_id) {
      await adminClient.from('staff_messages')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('id', message_id)
        .eq('recipient_type', 'ADMIN');
    } else {
      await adminClient.from('staff_messages')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('recipient_type', 'ADMIN')
        .eq('is_read', false);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sent-messages
app.get('/api/admin/sent-messages', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: sent } = await adminClient
      .from('staff_messages')
      .select('*')
      .eq('sender_type', 'ADMIN')
      .order('created_at', { ascending: false })
      .limit(100);

    res.json({ sent: sent || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sa/set-inspection-fee
app.post('/api/sa/set-inspection-fee', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { data: session } = await adminClient.from('staff_sessions')
      .select('*').eq('token', token).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!session || session.staff_role !== 'SA') return res.status(403).json({ error: 'SA access required' });

    const { property_id, inspection_fee } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });
    if (inspection_fee === undefined || inspection_fee === null) return res.status(400).json({ error: 'inspection_fee is required' });
    if (parseFloat(inspection_fee) < 0) return res.status(400).json({ error: 'Inspection fee cannot be negative' });

    // Verify this property belongs to an agent under this SA
    const { data: property } = await adminClient
      .from('properties')
      .select('id, title, created_by')
      .eq('id', property_id)
      .single();

    if (!property) return res.status(404).json({ error: 'Property not found' });

    const { data: agentProfile } = await adminClient
      .from('profiles')
      .select('sa_id, gha_id')
      .eq('id', property.created_by)
      .single();

    // Check direct SA assignment first
    var isUnderThisSA = agentProfile?.sa_id === session.staff_id;

    // If not directly assigned check via GHA
    if (!isUnderThisSA && agentProfile?.gha_id) {
      const { data: ghaRecord } = await adminClient
        .from('gha_agents')
        .select('sa_id')
        .eq('id', agentProfile.gha_id)
        .single();
      isUnderThisSA = ghaRecord?.sa_id === session.staff_id;
    }

    if (!isUnderThisSA) {
      return res.status(403).json({ error: 'This property is not under your territory' });
    }

    const { data: updated, error: updateErr } = await adminClient
      .from('properties')
      .update({
        inspection_fee: parseFloat(inspection_fee),
        inspection_fee_set_by: session.staff_id,
        inspection_fee_set_at: new Date().toISOString(),
      })
      .eq('id', property_id)
      .select('id, title, inspection_fee')
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    console.log('Inspection fee set:', property_id, '| fee:', inspection_fee, '| by SA:', session.staff_id);
    res.json({ success: true, message: 'Inspection fee set to NGN ' + parseFloat(inspection_fee).toLocaleString(), property: updated });
  } catch (err) {
    console.error('Set inspection fee error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/inspection-fees - admin views all properties with inspection fees
app.get('/api/admin/inspection-fees', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { data: properties } = await adminClient
      .from('properties')
      .select('id, title, location, property_type, image_urls, inspection_fee, inspection_fee_set_by, inspection_fee_set_at, created_by')
      .order('inspection_fee_set_at', { ascending: false });

    // Enrich with SA and agent details
    const enriched = await Promise.all((properties || []).map(async function(prop) {
      var saName = null;
      var saCode = null;
      var agentName = null;

      if (prop.inspection_fee_set_by) {
        const { data: sa } = await adminClient
          .from('service_agents')
          .select('sa_code, full_name')
          .eq('id', prop.inspection_fee_set_by)
          .maybeSingle();
        saCode = sa?.sa_code || null;
        saName = sa?.full_name || null;
      }

      if (prop.created_by) {
        const { data: agent } = await adminClient
          .from('profiles')
          .select('full_name, email')
          .eq('id', prop.created_by)
          .maybeSingle();
        agentName = agent?.full_name || agent?.email || null;
      }

      return Object.assign({}, prop, {
        sa_code: saCode,
        sa_name: saName,
        agent_name: agentName,
      });
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/set-inspection-fee - admin sets or adjusts inspection fee
app.post('/api/admin/set-inspection-fee', async (req, res) => {
  try {
    const admin = await verifyAdminToken(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const { property_id, inspection_fee } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id is required' });
    if (inspection_fee === undefined || inspection_fee === null) return res.status(400).json({ error: 'inspection_fee is required' });

    const { data: updated, error: updateErr } = await adminClient
      .from('properties')
      .update({
        inspection_fee: parseFloat(inspection_fee),
        inspection_fee_set_by: admin.id,
        inspection_fee_set_at: new Date().toISOString(),
      })
      .eq('id', property_id)
      .select('id, title, inspection_fee')
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    console.log('Admin set inspection fee:', property_id, '| fee:', inspection_fee);
    res.json({ success: true, message: 'Inspection fee updated to NGN ' + parseFloat(inspection_fee).toLocaleString(), property: updated });
  } catch (err) {
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