require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');

const db = require('./database/db');
const initDatabase = require('./database/init');
const seedDatabase = require('./database/seed');
const SqlJsSessionStore = require('./middleware/sessionStore');
const { ensureCsrfToken, issueCsrfToken, verifyCsrfToken } = require('./middleware/csrf');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const memoRoutes = require('./routes/memoRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const metaRoutes = require('./routes/metaRoutes');
const adminRoutes = require('./routes/adminRoutes');
const profileRoutes = require('./routes/profileRoutes');

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

async function main() {
  // The sql.js WASM engine boots asynchronously and the schema must be
  // applied before any request touches the database, so this is awaited
  // here rather than at module load time.
  await initDatabase();

  const { UPLOAD_DIR } = require('./middleware/upload');
  const uploadsPersistent = Boolean(process.env.UPLOAD_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
  const pushService = require('./services/pushService');

  // ------------------------------------------------------------
  // STARTUP DIAGNOSTICS
  // Printed on every boot so a "credentials/attachments that work locally
  // fail on the host" report can be diagnosed from the deploy logs alone,
  // without needing to reproduce it. If isPersistent is false in a
  // production/hosted environment, that file/folder will NOT survive the
  // next redeploy or restart — accounts or uploaded attachments created
  // now will disappear, which looks exactly like broken auth or missing
  // files.
  // ------------------------------------------------------------
  console.log('------------------------------------------------------------');
  console.log(`Database file: ${db.dbPath}`);
  console.log(`Uploads folder: ${UPLOAD_DIR}`);
  console.log(`Persistent storage detected: ${db.isPersistent ? 'yes' : 'NO'}`);
  console.log(`SMTP (email) configured: ${isProd ? (process.env.SMTP_HOST ? 'yes' : 'NO') : 'n/a (development mode may log to console)'}`);
  console.log(`Web Push (VAPID) configured: ${pushService.isConfigured ? 'yes' : 'NO'}`);
  if ((!db.isPersistent || !uploadsPersistent) && isProd) {
    console.warn(
      'WARNING: no DATABASE_PATH/UPLOAD_DIR or RAILWAY_VOLUME_MOUNT_PATH is set, ' +
      'so the database and/or uploaded attachments are being written to the ' +
      'container\'s local disk. On Railway (and most hosts) this is wiped on ' +
      'every redeploy/restart -- accounts, memos, notification history and every ' +
      'device\'s web-push subscription are lost at once, so recipients stop ' +
      'receiving memo emails and push alerts until they register again. Attach a ' +
      'Railway Volume to fix this permanently (both paths auto-detect ' +
      'RAILWAY_VOLUME_MOUNT_PATH once one is attached, no other config needed).'
    );
  }
  if (isProd && !pushService.isConfigured) {
    console.warn(
      'WARNING: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set, so web push ' +
      'notifications will never be delivered. Generate a key pair once with ' +
      '`npx web-push generate-vapid-keys` and add the results (plus ' +
      'VAPID_SUBJECT=mailto:...) to the Railway environment variables.'
    );
  }
  if (isProd && !process.env.BASE_URL) {
    console.warn(
      'WARNING: BASE_URL is not set, so links embedded in password-reset, ' +
      'verification, and new-memo emails fall back to the request Host header. ' +
      'Set BASE_URL to your public domain (e.g. https://yourapp.up.railway.app) ' +
      'so emailed link patterns are always correct, especially when a phone ' +
      'opens the link.'
    );
  }
  console.log('------------------------------------------------------------');

  // ------------------------------------------------------------
  // FIRST-BOOT BOOTSTRAP FOR NEW/EMPTY DATABASES
  // A brand-new (or freshly wiped) deployment starts with an empty
  // SQLite file, so no accounts exist and nobody can sign in. When the
  // users table is empty, seed the academic structure plus the
  // administrator account (credentials come from SEED_ADMIN_EMAIL /
  // SEED_ADMIN_PASSWORD -- seed.js throws clearly if these are unset).
  // Set AUTO_SEED=false to skip this behaviour. Safe to re-run: seed.js
  // reuses existing lookup records.
  // ------------------------------------------------------------
  if (process.env.AUTO_SEED !== 'false') {
    const { n: userCount } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    if (userCount === 0) {
      console.log('Empty database detected — seeding academic structure and admin account...');
      await seedDatabase();
      console.log(`Log in with SEED_ADMIN_EMAIL (${process.env.SEED_ADMIN_EMAIL || '(not set!)'}) and SEED_ADMIN_PASSWORD.`);
    } else {
      console.log(`Existing database found with ${userCount} user(s) — skipping seed.`);
    }
  }

  const app = express();
  app.set('trust proxy', 1);

  // -------------------------------------------------------------------
  // ONE-TIME DATABASE IMPORT (guarded).
  // Active only while the IMPORT_TOKEN environment variable is set; the
  // request must present it in the x-import-token header. Accepts a raw
  // SQLite database file, hot-swaps the in-memory sql.js instance, and
  // persists it to DATABASE_PATH. Disabled by deleting IMPORT_TOKEN and
  // restarting the service.
  // -------------------------------------------------------------------
  app.post('/__import-db', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
    const provided = req.get('x-import-token');
    if (!process.env.IMPORT_TOKEN || !provided || provided !== process.env.IMPORT_TOKEN) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 512) {
      return res.status(400).json({ error: 'Request body must be a SQLite database file.' });
    }
    try {
      db.reloadFromBuffer(req.body);
      const { n: userCount } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
      const { n: memoCount } = db.prepare('SELECT COUNT(*) AS n FROM memos').get();
      console.log(`Database imported: ${userCount} users, ${memoCount} memos.`);
      res.json({ ok: true, users: userCount, memos: memoCount });
    } catch (err) {
      console.error('Database import failed:', err.message);
      res.status(500).json({ error: 'Import failed: ' + err.message });
    }
  });

  // ---------------- SECURITY HEADERS ----------------
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Existing role pages use inline page controllers. Keep their original
        // interfaces operational while all data-changing APIs retain CSRF and
        // server-side authorization checks.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // ---------------- SESSION ----------------
  app.use(session({
    store: new SqlJsSessionStore(),
    name: 'edumemo.sid',
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  }));

  // ---------------- CSRF ----------------
  app.use(ensureCsrfToken);
  app.get('/api/csrf-token', issueCsrfToken);
  app.use('/api', verifyCsrfToken);

  // ---------------- PUBLIC CONFIG (safe values only; never secrets) ----------------
  app.get('/api/config', (req, res) => {
    res.json({
      institutionName: process.env.INSTITUTION_NAME || 'EduMemo',
      institutionShortName: process.env.INSTITUTION_SHORT_NAME || 'EduMemo',
    });
  });

  // ---------------- API ROUTES ----------------
  app.use('/api/auth', authRoutes);
  app.use('/api/memos', memoRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/meta', metaRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/profile', profileRoutes);

  // ---------------- AUTH PORTALS & SERVER-SIDE PAGE GUARDS ----------------
  // Regular users: /login -> /dashboard (their existing dashboard).
  app.get('/login', (req, res) => {
    const user = req.session.user;
    if (!user) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    return res.redirect(user.role === 'administrator' ? '/admin/dashboard' : '/dashboard');
  });

  app.get('/dashboard', (req, res) => {
    const user = req.session.user;
    if (!user) return res.redirect('/login');
    if (user.role === 'administrator') return res.redirect('/admin/dashboard');
    return res.redirect(user.role === 'staff' ? '/staff/dashboard.html' : '/student/dashboard.html');
  });

  // Super Admin area: every GET under /admin is server-guarded, including
  // direct access to /admin/<page>.html (which would otherwise be static).
  app.use('/admin', (req, res, next) => {
    if (req.method !== 'GET') return next();
    const user = req.session.user;
    const isLoginPage = req.path === '/login' || req.path === '/login.html';
    if (isLoginPage) {
      if (!user) return res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
      return res.redirect(user.role === 'administrator' ? '/admin/dashboard' : '/dashboard');
    }
    if (user && user.role === 'administrator') return next();
    if (!user) return res.redirect('/admin/login');
    return res.redirect('/dashboard'); // authenticated regular user -> denied
  });

  const adminPage = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', file));
  app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));
  app.get('/admin/dashboard', adminPage('dashboard.html'));
  app.get('/admin/users', adminPage('users.html'));
  app.get('/admin/academic-structure', adminPage('academic-structure.html'));
  app.get('/admin/departments', adminPage('academic-structure.html'));
  app.get('/admin/memos', adminPage('memo-records.html'));
  app.get('/admin/memo-records', adminPage('memo-records.html'));
  app.get('/admin/create-memo', adminPage('create-memo.html'));
  app.get('/admin/reports', adminPage('reports.html'));
  app.get('/admin/audit-logs', adminPage('audit-logs.html'));
  app.get('/admin/settings', adminPage('settings.html'));

  // Regular user areas: unauthenticated visitors are redirected server-side.
  app.use(['/student', '/staff'], (req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.session.user) return next();
    return res.redirect('/login');
  });

  // Memo permalink used by email/push notifications -> existing memo page.
  app.get('/memo/:id', (req, res) => res.redirect(`/memo.html?id=${encodeURIComponent(req.params.id)}`));

  // ---------------- STATIC FRONTEND ----------------
  app.use(express.static(path.join(__dirname, 'public')));

  // Service worker must be served from the root scope to control the whole site.
  app.get('/service-worker.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'service-worker.js'));
  });

  app.get('/', (req, res) => res.redirect('/login'));

  // ---------------- 404 for unmatched API routes ----------------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Resource not found.' }));

  // ---------------- 404 for unmatched pages ----------------
  app.use((req, res) => res.status(404).send(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page not found</title></head>' +
    '<body style="font-family:sans-serif;padding:48px;text-align:center;">' +
    '<h2 style="color:#15291b;">404 — Page not found</h2>' +
    '<p style="color:#54655c;">The page you are looking for does not exist.</p>' +
    '<p><a href="/login" style="color:#176b38;font-weight:700;">Go to login</a></p>' +
    '</body></html>'
  ));

  // ---------------- CENTRAL ERROR HANDLER ----------------
  app.use(errorHandler);

  app.listen(PORT, () => {
    console.log(`EduMemo server running at http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log('Development mode: unconfigured SMTP/VAPID services will log to console instead of sending.');
    }
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
