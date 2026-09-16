/*
 * Verifies memo notification fan-out (in-app + email + web push) end to end on
 * a THROWAWAY database (database/database.sqlite is never touched):
 *
 *   1. Two students are seeded; one of them has a device subscribed to a push
 *      endpoint that cannot be reached.
 *   2. An administrator publishes an institution-wide memo.
 *   3. Both recipients get an in-app notification and a delivery record for the
 *      memo -- one unreachable push device can never stop delivery to the other
 *      recipients.
 *   4. SMTP is deliberately left unconfigured for this run, so the email rows
 *      must be recorded as 'skipped' with an explanation. They must NOT be
 *      recorded as 'sent': the admin delivery report is what an operator looks
 *      at when recipients say "I never got an email", and a message that was
 *      never handed to a mail server must never look delivered.
 *   5. The failed push attempt is recorded against that device and the
 *      subscription is NOT deleted (only 404/410 mean the endpoint is gone).
 *
 * Run with:   node check-notification-delivery.js
 * It boots its own server on PORT 3213 (override with CHECK_PORT) and deletes
 * the temp database when it finishes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const PORT = Number(process.env.CHECK_PORT || 3213);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'smoke-data', 'notification-check.sqlite');
const UPLOAD_DIR = path.join(__dirname, 'smoke-data', 'notification-check-uploads');

const ADMIN_EMAIL = 'notify.check.admin@example.edu';
const STUDENT_A_EMAIL = 'notify.check.student.a@example.edu'; // has a dead push device
const STUDENT_B_EMAIL = 'notify.check.student.b@example.edu'; // no device at all
const PASSWORD = 'NotifyCheck123!';
const MEMO_TITLE = 'Notification fan-out check';

// These must be set BEFORE the modules below are required: smoke-data/client.js
// reads SMOKE_BASE at require time and database/db.js reads DATABASE_PATH the
// same way (dotenv never overrides a value already present in the environment).
process.env.SMOKE_BASE = BASE;
process.env.DATABASE_PATH = DB_FILE;
process.env.PORT = String(PORT);

const Client = require('./smoke-data/client');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  [${extra}]` : ''}`);
  if (!ok) failures += 1;
};

/** A realistic-looking, but unreachable, push subscription. */
function fakeSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    endpoint: 'https://push-service.invalid/dead-endpoint-' + Date.now(),
    p256dh: b64url(ecdh.getPublicKey(null, 'uncompressed')),
    auth: b64url(crypto.randomBytes(16)),
  };
}

/** Creates the throwaway DB: admin + two active students (one with a device). */
async function bootstrapDatabase() {
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  const db = require('./database/db');
  const initDatabase = require('./database/init');
  await initDatabase();

  const hash = bcrypt.hashSync(PASSWORD, 12);
  const admin = db.prepare(`
    INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified)
    VALUES ('administrator', ?, ?, 'Notify', 'Admin', 'active', 1)
  `).run(ADMIN_EMAIL, hash);
  db.prepare('INSERT INTO administrators (user_id, super_admin) VALUES (?, 1)').run(admin.lastInsertRowid);

  const studentA = db.prepare(`
    INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified, push_enabled)
    VALUES ('student', ?, ?, 'Device', 'Student', 'active', 1, 1)
  `).run(STUDENT_A_EMAIL, hash);
  const studentB = db.prepare(`
    INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified)
    VALUES ('student', ?, ?, 'Plain', 'Student', 'active', 1)
  `).run(STUDENT_B_EMAIL, hash);

  const sub = fakeSubscription();
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)`)
    .run(studentA.lastInsertRowid, sub.endpoint, sub.p256dh, sub.auth);

  return { studentAId: studentA.lastInsertRowid, studentBId: studentB.lastInsertRowid, sub };
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    // SMTP is blanked out so this check never sends a real email, and so the
    // "SMTP not configured" branch is the one under test. The VAPID keys are
    // left as configured: the push attempt against the dead endpoint above is
    // what proves one bad device does not stop the other recipients.
    env: {
      ...process.env,
      PORT: String(PORT), DATABASE_PATH: DB_FILE, UPLOAD_DIR,
      NODE_ENV: 'development', BASE_URL: BASE,
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM_EMAIL: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const res = await fetch(`${BASE}/api/config`); if (res.ok) return; } catch (_) { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no server answering on ${BASE}`);
}

function db_cleanup() {
  for (const file of [DB_FILE, `${DB_FILE}-journal`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (fs.existsSync(UPLOAD_DIR)) fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
}

async function runChecks(seed) {
  // The server runs in a separate process and writes to the same SQLite file.
  // Rows are therefore read straight from disk: the in-process db instance is
  // a snapshot taken at bootstrap time and would never see the notifications
  // the running server creates.
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f) });
  const query = (sql, params = []) => {
    const raw = new SQL.Database(fs.readFileSync(DB_FILE));
    try {
      const stmt = raw.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } finally {
      raw.close();
    }
  };

  // ---------- publish an institution-wide memo ----------
  const admin = new Client();
  // Administrators have their own portal login endpoint (a regular /login is
  // refused for administrator accounts).
  const login = await admin.post('/api/auth/admin-login', { email: ADMIN_EMAIL, password: PASSWORD });
  check('administrator login succeeds', login.status === 200, `status=${login.status}`);

  const created = await admin.post('/api/memos', {
    title: MEMO_TITLE,
    body: 'This memo exists to verify notification fan-out to every recipient.',
    institutionWide: true,
  });
  check('institution-wide draft created', created.status === 201, `status=${created.status} ${JSON.stringify(created.data)}`);
  const memoId = created.data && created.data.memoId;

  const published = await admin.post(`/api/memos/${memoId}/publish`, { confirmBroadcast: true });
  check('memo published to both students',
    published.status === 200 && published.data.recipientCount === 2,
    `status=${published.status} recipients=${published.data && published.data.recipientCount}`);

  // Delivery runs in the background after the response -- wait for the rows.
  let emailRows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    emailRows = query(`SELECT * FROM email_notifications WHERE memo_id = ?`, [memoId]);
    if (emailRows.length >= 2) break;
  }

  const inApp = query(`SELECT user_id FROM notifications WHERE memo_id = ? AND type = 'in_app'`, [memoId])
    .map((r) => r.user_id);
  check('both recipients received an in-app notification',
    inApp.includes(seed.studentAId) && inApp.includes(seed.studentBId),
    `user_ids=[${inApp.join(',')}]`);

  check('a delivery record exists for every recipient', emailRows.length === 2, `rows=${emailRows.length}`);

  // ---------- email truthfulness ----------
  const skipped = emailRows.filter((r) => r.status === 'skipped');
  check('unsent emails are recorded as skipped, never as sent',
    emailRows.length === 2 && skipped.length === 2,
    emailRows.map((r) => `${r.to_email}:${r.status}`).join(', '));
  check('the skipped rows explain why nothing was delivered',
    skipped.length === 2 && skipped.every((r) => /smtp/i.test(r.error || '')),
    skipped.map((r) => r.error).join(' | '));

  // ---------- push: one dead device, delivery still completes ----------
  const pushRows = query(`SELECT * FROM notifications WHERE memo_id = ? AND type = 'push'`, [memoId]);
  const aPush = pushRows.filter((r) => r.user_id === seed.studentAId);
  check('the unreachable device is recorded as a failed push (reason kept)',
    aPush.length === 1 && aPush[0].delivery_status === 'failed' && !!aPush[0].failure_reason,
    aPush.length ? `${aPush[0].delivery_status}: ${aPush[0].failure_reason}` : 'no push row');
  check('no push attempt is invented for a recipient with no device',
    pushRows.every((r) => r.user_id === seed.studentAId), `user_ids=[${pushRows.map((r) => r.user_id).join(',')}]`);
  check('the subscription is kept (only 404/410 mean the endpoint is gone)',
    query(`SELECT id FROM push_subscriptions WHERE user_id = ?`, [seed.studentAId]).length === 1);

  // ---------- the memo itself still reached the second recipient ----------
  const studentB = new Client();
  const bLogin = await studentB.post('/api/auth/login', { email: STUDENT_B_EMAIL, password: PASSWORD });
  check('second student can sign in', bLogin.status === 200, `status=${bLogin.status}`);
  const inbox = await studentB.get('/api/memos?page=1');
  const titles = (inbox.data.memos || []).map((m) => m.title);
  check("the memo is in the second recipient's inbox (fan-out was not aborted)",
    titles.includes(MEMO_TITLE), `titles=${JSON.stringify(titles)}`);
}

async function main() {
  const seed = await bootstrapDatabase();
  const child = startServer();
  try {
    await waitForServer();
    await runChecks(seed);
  } finally {
    child.kill();
    db_cleanup();
  }
  console.log(`\n========== ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`} ==========`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Check runner crashed:', err);
  db_cleanup();
  process.exit(1);
});