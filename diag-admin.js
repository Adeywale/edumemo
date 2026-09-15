/* Temporary admin-login diagnostic (read-only; deleted after use). */
require('dotenv').config();
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('./database/db');

const say = (line) => console.log(line);

(async () => {
  await db.init();
  say(`DB file in use      : ${db.dbPath}`);
  say(`DATABASE_PATH env   : ${process.env.DATABASE_PATH || '(not set)'}`);
  say(`PORT env            : ${process.env.PORT || '(not set)'}`);
  say(`SEED_ADMIN_EMAIL    : ${process.env.SEED_ADMIN_EMAIL || '(not set)'}`);
  say(`SEED_ADMIN_PASSWORD : ${process.env.SEED_ADMIN_PASSWORD ? '(set, ' + process.env.SEED_ADMIN_PASSWORD.length + ' chars)' : '(not set)'}`);
  say('');

  const admins = db.prepare(`SELECT id, email, role, status, email_verified, created_at FROM users WHERE role = 'administrator' ORDER BY id`).all();
  say(`Administrator accounts: ${admins.length}`);
  const seedPw = process.env.SEED_ADMIN_PASSWORD || '';
  let legacy = {};
  try { legacy = JSON.parse(fs.readFileSync('admin-login.json', 'utf8')); } catch (_) { legacy = {}; }

  for (const a of admins) {
    const full = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(a.id);
    const row = db.prepare(`SELECT super_admin FROM administrators WHERE user_id = ?`).get(a.id);
    say(`  id=${a.id} ${a.email} status=${a.status} verified=${a.email_verified}`);
    say(`     administrators row : ${row ? 'present (super_admin=' + row.super_admin + ')' : 'MISSING'}`);
    say(`     password matches SEED_ADMIN_PASSWORD : ${seedPw ? bcrypt.compareSync(seedPw, full.password_hash) : 'n/a'}`);
    say(`     password matches admin-login.json    : ${legacy.password ? bcrypt.compareSync(legacy.password, full.password_hash) : 'n/a'}`);
    say(`     email matches admin-login.json       : ${legacy.email ? legacy.email === a.email : 'n/a'}`);
  }

  const counts = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN role='student' THEN 1 ELSE 0 END),0) AS students,
      COALESCE(SUM(CASE WHEN role='staff' THEN 1 ELSE 0 END),0) AS staff,
      COUNT(*) AS total FROM users`).get();
  say('');
  say(`Accounts in this DB : students=${counts.students} staff=${counts.staff} total=${counts.total}`);

  const stray = fs.existsSync('database/.verify-delete-tmp.sqlite');
  say(`Stray test DB file present: ${stray}`);
  say('');
})().catch((err) => { console.error('DIAG FAILED:', err.message); process.exitCode = 1; });
