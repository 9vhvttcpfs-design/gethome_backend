// Security middleware: HTTP headers + rate limiting.
// Additive only - mounted once from index.js, no existing route is changed.
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

function limiter(windowMs, max, message) {
  return rateLimit({
    windowMs: windowMs,
    max: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Too many requests. Please slow down and try again shortly.' },
  });
}

// Generous global ceiling: protects against floods without hurting real users
// (mobile users on shared carrier IPs). Webhooks and health checks are exempt.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
  skip: function (req) {
    return req.path === '/' || req.path === '/api/flutterwave/webhook';
  },
});

// Stricter limits for abuse-prone public endpoints.
const authLimiter   = limiter(15 * 60 * 1000, 40, 'Too many attempts. Please wait a few minutes and try again.');
const publicWriteLimiter = limiter(60 * 1000, 30, 'Too many requests. Please slow down.');
const aiLimiter     = limiter(60 * 1000, 20, 'Too many messages. Please wait a moment before continuing.');

function applySecurity(app) {
  // Render sits behind a proxy; needed so rate limits key on the real client IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    // CSP off: /admin-tools serves inline scripts. Cross-origin resource policy
    // relaxed so the web/mobile apps can still load API-served assets.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use('/api/', globalLimiter);
  app.use(['/api/auth/login', '/api/auth/signup', '/api/auth/agent-register',
           '/api/auth/create-agent-row', '/api/auth/telegram', '/api/staff/login'], authLimiter);
  app.use(['/api/verify-nin', '/api/verify-cac', '/api/verify-ghana-card',
           '/api/deposit-intent', '/api/escrow-notify', '/api/inspection-notify'], publicWriteLimiter);
  app.use('/api/ai/chat', aiLimiter);
}

module.exports = { applySecurity, limiter };
