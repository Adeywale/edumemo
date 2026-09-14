// One-off migration: marks every existing account as email-verified so no
// user is ever blocked by email verification. Safe to re-run. Run with the
// server STOPPED (sql.js keeps the DB in memory and would overwrite this).
require('dotenv').config();
const db = require('./db');

(async () => {
  await db.init();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email_verified = 0`).get().n;
  db.prepare(`UPDATE users SET email_verified = 1 WHERE email_verified = 0`).run();
  const after = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email_verified = 0`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  console.log(`Users total: ${total} | newly verified: ${before} | still unverified: ${after}`);
  db.prepare(`SELECT id, email, role, status, email_verified FROM users ORDER BY id`).all()
    .forEach((u) => console.log(`  id=${u.id} ${u.email} role=${u.role} status=${u.status} verified=${u.email_verified}`));
})().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
