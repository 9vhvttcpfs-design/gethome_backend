// Shared authorization middleware for new (growth) routes.
// Mirrors the existing auth model: admin = Supabase JWT with profiles.role='admin';
// staff (SA/GHA) = opaque token in staff_sessions. Existing routes keep their own checks.
module.exports = function createAuth(db) {
  function bearer(req) {
    return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  }

  async function getAdmin(req) {
    const token = bearer(req);
    if (!token) return null;
    const { data: { user }, error } = await db.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
    return profile && profile.role === 'admin' ? user : null;
  }

  async function getStaff(req) {
    const token = bearer(req);
    if (!token) return null;
    const { data: s } = await db.from('staff_sessions')
      .select('staff_id, staff_role, expires_at').eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    return s || null;
  }

  function requireAdmin(req, res, next) {
    getAdmin(req).then(function (u) {
      if (!u) return res.status(401).json({ error: 'Unauthorized' });
      req.admin = u; next();
    }).catch(function () { res.status(500).json({ error: 'Auth check failed' }); });
  }

  // roles: array like ['SA','GHA']
  function requireStaff(roles) {
    return function (req, res, next) {
      getStaff(req).then(function (s) {
        if (!s) return res.status(401).json({ error: 'Unauthorized' });
        if (roles && roles.length && roles.indexOf(s.staff_role) === -1) return res.status(403).json({ error: 'Forbidden' });
        req.staff = s; next();
      }).catch(function () { res.status(500).json({ error: 'Auth check failed' }); });
    };
  }

  // ---- Role-based access for the Outreach Command Centre ----
  // GetHome admins (profiles.role = 'admin') are owners. Other signed-in users can be granted a narrower
  // role (admin | recruiter | viewer) in gx_admin_roles.
  const ROLE_RANK = { viewer: 1, recruiter: 2, admin: 3, owner: 4 };

  async function getAdminRole(req) {
    const token = bearer(req);
    if (!token) return null;
    const { data: { user }, error } = await db.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile && profile.role === 'admin') return { user, role: 'owner' };
    const { data: row } = await db.from('gx_admin_roles').select('role').eq('user_id', user.id).maybeSingle();
    return row && ROLE_RANK[row.role] ? { user, role: row.role } : null;
  }

  // requireRole('recruiter') lets recruiter, admin and owner through; 401 when not signed in as any of them.
  function requireRole(min) {
    return function (req, res, next) {
      getAdminRole(req).then(function (r) {
        if (!r) return res.status(401).json({ error: 'Unauthorized' });
        if (ROLE_RANK[r.role] < ROLE_RANK[min]) return res.status(403).json({ error: 'Your role (' + r.role + ') cannot do this' });
        req.admin = r.user; req.adminRole = r.role; next();
      }).catch(function () { res.status(500).json({ error: 'Auth check failed' }); });
    };
  }

  return { requireAdmin, requireStaff, getAdmin, getStaff, getAdminRole, requireRole, ROLE_RANK };
};
