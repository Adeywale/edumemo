// Resets (or creates) the Super Admin account's password from the values in
// .env — SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
//
// Why this exists: seed.js only INSERTs the administrator when no row with
// that email exists yet. Once the account has been created, editing
// SEED_ADMIN_PASSWORD in .env has no effect at all, because seed.js takes the
// "Administrator already exists" branch and never touches password_hash.
// server.js's AUTO_SEED bootstrap is also skipped whenever the users table is
// non-empty. The result is the confusing "Incorrect email or password."
// message even though .env looks correct.
//
// This script re-hashes the .env password and writes it onto the account, so
// the credentials in .env become the credentials that actually work.
// It also makes sure the account is a super admin, active and email-verified,
// since any of those states will block the Admin Portal login.
//
// Run with the server stopped:  node database/reset-admin-password.js
require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('./db');

const SALT_ROUNDS = 10;
// Mirrors the minimum enforced by authController (registration + reset flows),
// so the seeded password can also be changed later through the app's own UI.
const MIN_PASSWORD_LENGTH = 8;

(async () => {
  await db.init();

  const email = (process.env.SEED_ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.SEED_ADMIN_PASSWORD || '';

  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in .env before running this script.');
  }
  // The login route itself imposes no length rule — it only compares hashes —
  // so a short password is applied rather than rejected. It is still flagged,
  // because registration / reset-password / change-password all enforce the
  // 8-character minimum, meaning a shorter password cannot later be re-entered
  // through the application's own forms.
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.warn(
      `WARNING: SEED_ADMIN_PASSWORD is only ${password.length} character(s). ` +
      `Signing in will work, but the app enforces a ${MIN_PASSWORD_LENGTH}-character ` +
      'minimum in its change-password and reset-password forms, so this value ' +
      'cannot be re-set through the UI later. A longer password is recommended.'
    );
  }

  console.log(`Database file: ${db.dbPath}`);

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  const apply = db.transaction(() => {
    const user = db.prepare(`SELECT id, role, status FROM users WHERE email = ?`).get(email);

    if (!user) {
      const result = db.prepare(
        `INSERT INTO users
         (role, email, password_hash, first_name, last_name, status, email_verified)
         VALUES ('administrator', ?, ?, 'System', 'Administrator', 'active', 1)`
      ).run(email, passwordHash);

      db.prepare(
        `INSERT INTO administrators (user_id, super_admin) VALUES (?, 1)`
      ).run(result.lastInsertRowid);

      console.log(`Created Super Admin account: ${email}`);
      return;
    }

    if (user.role !== 'administrator') {
      throw new Error(
        `The account ${email} exists but its role is "${user.role}", not "administrator". ` +
        'Refusing to overwrite a non-admin account. Point SEED_ADMIN_EMAIL at a ' +
        'different address, or promote this account deliberately.'
      );
    }

    // Password + the states the Admin Portal checks before granting access.
    db.prepare(
      `UPDATE users
       SET password_hash = ?, status = 'active', email_verified = 1, updated_at = datetime('now')
       WHERE id = ?`
    ).run(passwordHash, user.id);

    // The account must also have an administrators row flagged super_admin.
    const adminRow = db.prepare(`SELECT user_id FROM administrators WHERE user_id = ?`).get(user.id);
    if (adminRow) {
      db.prepare(`UPDATE administrators SET super_admin = 1 WHERE user_id = ?`).run(user.id);
    } else {
      db.prepare(`INSERT INTO administrators (user_id, super_admin) VALUES (?, 1)`).run(user.id);
    }

    console.log(`Updated Super Admin account: ${email} (previous status: ${user.status})`);
  });

  apply();

  // Verify against what is now actually stored, not against what we intended.
  const stored = db.prepare(`SELECT password_hash, status, email_verified FROM users WHERE email = ?`).get(email);
  const verified = bcrypt.compareSync(password, stored.password_hash);

  console.log('');
  console.log('=========================================================');
  console.log(`Email          : ${email}`);
  console.log(`Password check : ${verified ? 'PASS — SEED_ADMIN_PASSWORD now matches the stored hash' : 'FAIL'}`);
  console.log(`Status         : ${stored.status}`);
  console.log(`Email verified : ${stored.email_verified}`);
  console.log('Sign in at /admin/login (the Super Admin portal, not /login).');
  console.log('=========================================================');

  if (!verified) process.exit(1);
})().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
