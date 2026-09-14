// Route-protection middleware. All authorization decisions are made on the
// server from req.session.user, never trusted from client input.

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Please log in to continue.' });
    }
    return res.redirect('/login.html');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Please log in to continue.' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

/** Staff must additionally be "active" (i.e. approved, not pending/suspended) to publish memos. */
function requireApprovedStaff(req, res, next) {
  const user = req.session.user;
  if (!user || user.role !== 'staff') {
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({
      error: user.status === 'pending_approval'
        ? 'Your staff account is awaiting administrator approval.'
        : 'Your staff account has been suspended. Contact administration.',
    });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireApprovedStaff };
