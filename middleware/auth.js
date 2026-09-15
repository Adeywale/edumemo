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

/**
 * Memo-writing gate. Sending memos is a teaching-staff privilege: only
 * administrators and *teaching* staff whose account is approved (status
 * 'active') may create, edit, publish, resend, archive or delete a memo.
 *
 * Non-teaching staff have receive-only access, so they are refused here
 * regardless of their account status. The memo controllers repeat every one
 * of these checks, so relaxing this middleware could never silently open
 * memo sending to a non-teaching account.
 */
function requireMemoPublisher(req, res, next) {
  const user = req.session.user;
  if (!user) {
    return res.status(401).json({ error: 'Please log in to continue.' });
  }
  if (user.role === 'administrator') return next();
  if (user.role !== 'staff') {
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  }
  if (user.staffType !== 'academic') {
    return res.status(403).json({ error: 'Non-teaching staff can receive and read memos but cannot create or send them.' });
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

module.exports = { requireAuth, requireRole, requireMemoPublisher };
