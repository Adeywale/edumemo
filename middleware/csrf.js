// Lightweight session-bound CSRF protection (double-submit style) so we
// avoid depending on the archived `csurf` package.
const { nanoid } = require('nanoid');

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = nanoid(32);
  }
  next();
}

function issueCsrfToken(req, res) {
  res.json({ csrfToken: req.session.csrfToken });
}

function verifyCsrfToken(req, res, next) {
  // Only state-changing methods need verification.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const tokenFromClient = req.get('X-CSRF-Token') || (req.body && req.body._csrf);
  if (!tokenFromClient || tokenFromClient !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing security token. Please refresh the page and try again.' });
  }
  next();
}

module.exports = { ensureCsrfToken, issueCsrfToken, verifyCsrfToken };
