// One-time safe migration: single Super Admin role model.
// Keeps users.role = 'administrator' (schema CHECK constraint) and promotes
// every administrators row to super_admin = 1 so there is exactly one
// administrative role. Idempotent and never deletes data.
// Run with the server stopped:  node database/migrate-super-admin.js
const db = require('./db');

(async () => {
  await db.init();
  const before = db.prepare(
    `SELECT u.id, u.email, u.status, a.super_admin
     FROM users u JOIN administrators a ON a.user_id = u.id WHERE u.role = 'administrator'`
  ).all();
  console.log('Before migration:', JSON.stringify(before));

  db.prepare(`UPDATE administrators SET super_admin = 1`).run();

  const after = db.prepare(
    `SELECT u.id, u.email, u.status, a.super_admin
     FROM users u JOIN administrators a ON a.user_id = u.id WHERE u.role = 'administrator'`
  ).all();
  console.log('After migration :', JSON.stringify(after));
  console.log('Migration complete: all administrator accounts are Super Admins (statuses unchanged).');
})().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
