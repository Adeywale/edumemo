/*
 * Verifies the staff approval + memo-permission rules end to end on a
 * THROWAWAY database (database/database.sqlite is never touched):
 *
 *   1. Every new staff account (teaching and non-teaching) registers to
 *      'pending_approval' and registration returns a plain confirmation with
 *      no explanation text.
 *   2. Unapproved staff are refused (403) by the login endpoint.
 *   3. An administrator approves both accounts via the admin API.
 *   4. Approved staff sign in as 'active'.
 *   5. Non-teaching staff are refused (403) by EVERY memo-writing endpoint:
 *      create, edit, publish, resend, archive, delete and estimate.
 *   6. Non-teaching staff still RECEIVE memos targeted at them, and can only
 *      ever see the Received view.
 *   7. Approved teaching staff can create and publish memos.
 *
 * Run with:   node check-staff-memo-permissions.js
 * It boots its own server on PORT 3211 (override with CHECK_PORT) and deletes
 * the temp database when it finishes.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');

const PORT = Number(process.env.CHECK_PORT || 3211);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'smoke-data', 'staff-check.sqlite');
const UPLOAD_DIR = path.join(__dirname, 'smoke-data', 'staff-check-uploads');
const ADMIN_EMAIL = `check.admin.${Date.now()}@example.edu`;
const ADMIN_PASSWORD = 'CheckPass123!';

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
/** A 403 that is the permission refusal -- not the CSRF middleware's message. */
const isPermissionRefusal = (res) => res.status === 403 && !/security token/i.test((res.data && res.data.error) || '');
const raw = (client, method, url, body) => client.request(method, url, body, { raw: true });

/** Creates the throwaway DB: one faculty and one Super Admin, nothing else. */
async function bootstrapDatabase() {
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  const db = require('./database/db');
  const initDatabase = require('./database/init');
  await initDatabase();
  db.prepare(`INSERT INTO faculties (name, code) VALUES (?, ?)`).run('Staff Check Faculty', 'SCF');
  const faculty = db.prepare(`SELECT id FROM faculties WHERE code = ?`).get('SCF');
  const admin = db.prepare(`
    INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified)
    VALUES ('administrator', ?, ?, 'Check', 'Admin', 'active', 1)
  `).run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12));
  db.prepare(`INSERT INTO administrators (user_id, super_admin) VALUES (?, 1)`).run(admin.lastInsertRowid);
  return faculty.id;
}

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    // SMTP/VAPID are blanked out so the run stays offline: this check must
    // never try to send a real email or push notification.
    env: {
      ...process.env,
      PORT: String(PORT), DATABASE_PATH: DB_FILE, UPLOAD_DIR,
      NODE_ENV: 'development', BASE_URL: BASE,
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM_EMAIL: '',
      VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
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
async function runChecks(facultyId) {
  const stamp = Date.now();
  const nonTeachingEmail = `check.nonteaching.${stamp}@example.edu`;
  const teachingEmail = `check.teaching.${stamp}@example.edu`;
  const password = 'StaffCheck123!';

  // ---------- 1. registration puts every staff account into pending_approval ----------
  const nonTeaching = new Client();
  const reg = await nonTeaching.post('/api/auth/register/staff', {
    firstName: 'Nora', lastName: 'Nonteaching', staffType: 'non_academic',
    email: nonTeachingEmail, password, confirmPassword: password,
  });
  check('non-teaching staff registration succeeds', reg.status === 201, `status=${reg.status}`);
  check('non-teaching registration returns the plain confirmation with no explanation',
    reg.data.message === 'Registration successful.', reg.data.message);

  const teaching = new Client();
  const teacherReg = await teaching.post('/api/auth/register/staff', {
    firstName: 'Tom', lastName: 'Teaching', staffType: 'academic', email: teachingEmail,
    phone: '0801234567', facultyId, departmentName: 'Computer Science',
    password, confirmPassword: password,
  });
  check('teaching staff registration succeeds', teacherReg.status === 201, `status=${teacherReg.status}`);
  check('teaching registration returns the plain confirmation with no explanation',
    teacherReg.data.message === 'Registration successful.', teacherReg.data.message);

  // ---------- 2. unapproved staff are refused at login ----------
  const ntEarlyLogin = await raw(nonTeaching, 'POST', '/api/auth/login', { email: nonTeachingEmail, password });
  check('unapproved non-teaching staff cannot log in', ntEarlyLogin.status === 403, `status=${ntEarlyLogin.status}`);
  check('the non-teaching login refusal explains the approval requirement',
    /has not been approved/.test((ntEarlyLogin.data && ntEarlyLogin.data.error) || ''),
    ntEarlyLogin.data && ntEarlyLogin.data.error);

  const tEarlyLogin = await raw(teaching, 'POST', '/api/auth/login', { email: teachingEmail, password });
  check('unapproved teaching staff cannot log in', tEarlyLogin.status === 403, `status=${tEarlyLogin.status}`);
  check('the teaching login refusal explains the approval requirement',
    /has not been approved/.test((tEarlyLogin.data && tEarlyLogin.data.error) || ''),
    tEarlyLogin.data && tEarlyLogin.data.error);

  // ---------- 3. the administrator approves both accounts ----------
  const admin = new Client();
  const adminLogin = await admin.post('/api/auth/admin-login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check('Super Admin login works on the throwaway database', adminLogin.status === 200, `status=${adminLogin.status}`);

  const pendingList = await admin.get('/api/admin/users?role=staff&status=pending_approval');
  const pendingRows = (pendingList.status === 200 && Array.isArray(pendingList.data)) ? pendingList.data : [];
  const nonTeachingRow = pendingRows.find((u) => u.email === nonTeachingEmail);
  const teachingRow = pendingRows.find((u) => u.email === teachingEmail);
  check('both registrations appear in the pending approvals list', !!nonTeachingRow && !!teachingRow,
    `rows=${pendingRows.length}`);

  const approveNonTeaching = await admin.post(`/api/admin/staff/${nonTeachingRow.id}/approve`, {});
  check('admin can approve the non-teaching staff account', approveNonTeaching.status === 200, `status=${approveNonTeaching.status}`);
  const approveTeaching = await admin.post(`/api/admin/staff/${teachingRow.id}/approve`, {});
  check('admin can approve the teaching staff account', approveTeaching.status === 200, `status=${approveTeaching.status}`);

  // ---------- 4. approved staff sign in as active ----------
  const login = await nonTeaching.post('/api/auth/login', { email: nonTeachingEmail, password });
  check('approved non-teaching staff can log in', login.status === 200, `status=${login.status}`);
  check('approved non-teaching account is active',
    login.data.user.status === 'active', `status=${login.data.user.status}`);
  check('non-teaching account is flagged staffType=non_academic', login.data.user.staffType === 'non_academic');
  check('approved login message carries no approval notice',
    !/approval/i.test(login.data.message || ''), login.data.message);

  const teacherLogin = await teaching.post('/api/auth/login', { email: teachingEmail, password });
  check('approved teaching staff can log in as active',
    teacherLogin.status === 200 && teacherLogin.data.user.status === 'active',
    `status=${teacherLogin.status} user=${teacherLogin.data.user && teacherLogin.data.user.status}`);

  // ---------- 5. every memo-writing endpoint refuses the non-teaching staff ----------
  const create = await raw(nonTeaching, 'POST', '/api/memos', {
    title: 'Should not exist', body: 'x', recipientGroup: 'students',
  });
  check('non-teaching staff cannot create a memo',
    isPermissionRefusal(create), `status=${create.status} ${JSON.stringify(create.data)}`);
  check('the refusal explains the receive-only rule',
    /cannot create or send/.test((create.data && create.data.error) || ''), create.data && create.data.error);

  const writeAttempts = [
    ['PUT', '/api/memos/1'],
    ['POST', '/api/memos/1/publish'],
    ['POST', '/api/memos/1/resend'],
    ['POST', '/api/memos/1/archive'],
    ['DELETE', '/api/memos/1'],
    ['GET', '/api/memos/estimate?recipientGroup=students'],
  ];
  for (const [method, url] of writeAttempts) {
    const res = await raw(nonTeaching, method, url, method === 'GET' ? undefined : {});
    check(`non-teaching staff refused: ${method} ${url}`, isPermissionRefusal(res), `status=${res.status}`);
  }

  // ---------- 6. receive-only views ----------
  const received = await nonTeaching.get('/api/memos?filter=received&page=1');
  check('non-teaching staff can load their Received list',
    received.status === 200 && Array.isArray(received.data.memos));
  const sent = await raw(nonTeaching, 'GET', '/api/memos?filter=sent');
  check('non-teaching staff cannot open the Sent view', isPermissionRefusal(sent), `status=${sent.status}`);
  const dashboard = await raw(nonTeaching, 'GET', '/staff/dashboard.html');
  check('non-teaching staff get their own dashboard carrying the staff-type label',
    dashboard.status === 200 && /Non-teaching staff/.test(dashboard.data || ''), `status=${dashboard.status}`);
  // ---------- 7. they still RECEIVE memos ----------
  const draft = await admin.post('/api/memos', {
    title: 'Non-teaching staff notice',
    body: 'All non-teaching staff should note the new opening hours.',
    recipientGroup: 'non_academic_staff',
  });
  check('admin can create a memo targeted at the non-teaching staff group', draft.status === 201, `status=${draft.status}`);
  const memoId = draft.data && draft.data.memoId;
  const publish = await admin.post(`/api/memos/${memoId}/publish`, {});
  check('publishing to non-teaching staff resolves at least one recipient',
    publish.status === 200 && publish.data.recipientCount >= 1,
    `status=${publish.status} count=${publish.data && publish.data.recipientCount}`);

  const inbox = await nonTeaching.get('/api/memos?filter=received&page=1');
  check('the memo lands in the non-teaching staff inbox', (inbox.data.memos || []).some((m) => m.id === memoId));
  const openMemo = await nonTeaching.get(`/api/memos/${memoId}`);
  check('non-teaching staff can open the memo addressed to them', openMemo.status === 200, `status=${openMemo.status}`);
  const resendOwn = await raw(nonTeaching, 'POST', `/api/memos/${memoId}/resend`, {});
  check('a received memo cannot be resent by its non-teaching recipient',
    isPermissionRefusal(resendOwn), `status=${resendOwn.status}`);

  // ---------- 8. approved teaching staff can create and publish memos ----------
  const teacherDraft = await teaching.post('/api/memos', {
    title: 'Teaching staff memo', body: 'Hello students', recipientGroup: 'students', facultyId,
  });
  check('approved teaching staff CAN create memo drafts', teacherDraft.status === 201, `status=${teacherDraft.status}`);

  const teacherPublish = await raw(teaching, 'POST', `/api/memos/${teacherDraft.data.memoId}/publish`, {});
  check('approved teaching staff pass the publish gate (no permission/approval 403)',
    teacherPublish.status !== 403, `status=${teacherPublish.status} ${JSON.stringify(teacherPublish.data)}`);

  const teacherSent = await teaching.get('/api/memos?filter=sent&page=1');
  check('teaching staff still see their Sent list', teacherSent.status === 200, `status=${teacherSent.status}`);
}

async function main() {
  console.log(`Throwaway database: ${DB_FILE}`);
  const facultyId = await bootstrapDatabase();
  const server = startServer();
  try {
    await waitForServer();
    await runChecks(facultyId);
  } finally {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (process.platform === 'win32' && server.pid) {
      try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* already gone */ }
    }
    fs.rmSync(DB_FILE, { force: true });
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nSTAFF MEMO PERMISSIONS VERIFIED OK' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('CHECK CRASHED:', (err && err.message) || err);
  process.exitCode = 1;
});