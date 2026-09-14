/* Temporary end-to-end test: publish a memo -> real SMTP email delivery (safe to delete). */
process.env.PORT = '3999';
const bcrypt = require('bcryptjs');
const db = require('./database/db');

const BASE = 'http://localhost:3999';
const ADMIN_EMAIL = 'test.superadmin.temp@example.edu';
const STUDENT_EMAIL = 'edumemo26+memo-test@gmail.com'; // Gmail plus-addressing -> lands in your real inbox
const TEST_PASSWORD = 'TempPass123!';
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}
function makeJar() {
  const jar = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    store(res) {
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
    },
  };
}
async function req(jar, method, p, { body, csrf, form } = {}) {
  const headers = {};
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const cookie = jar.header();
  if (cookie) headers['Cookie'] = cookie;
  let payload;
  if (form) payload = form;                       // FormData -> multipart (no manual Content-Type)
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  jar.store(res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* html */ }
  return { status: res.status, location: res.headers.get('location'), data, text };
}
const getCsrf = async (jar) => (await req(jar, 'GET', '/api/csrf-token')).data.csrfToken;

(async () => {
  await db.init();
  const hash = bcrypt.hashSync(TEST_PASSWORD, 10);
  for (const email of [ADMIN_EMAIL, STUDENT_EMAIL]) db.prepare('DELETE FROM users WHERE email = ?').run(email);
  // A previous crashed run can leave an orphaned student_profiles row behind
  // (users are deleted by email, profiles are not) which then trips the
  // matric_number UNIQUE constraint on re-insert.
  db.prepare(`DELETE FROM student_profiles WHERE matric_number = 'TEST-MAIL-1'`).run();
  db.prepare(`DELETE FROM courses WHERE code = 'TEST 999'`).run();

  const adm = db.prepare(
    `INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified)
     VALUES ('administrator', ?, ?, 'Temp', 'Super', 'active', 1)`
  ).run(ADMIN_EMAIL, hash).lastInsertRowid;
  db.prepare('INSERT INTO administrators (user_id, super_admin) VALUES (?, 1)').run(adm);
  const stu = db.prepare(
    `INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified, email_notifications_enabled)
     VALUES ('student', ?, ?, 'Test', 'Recipient', 'active', 1, 1)`
  ).run(STUDENT_EMAIL, hash).lastInsertRowid;
  db.prepare('INSERT INTO student_profiles (user_id, matric_number, faculty_id, department_id) VALUES (?, ?, 9, 63)').run(stu, 'TEST-MAIL-1');
  const courseId = db.prepare(`INSERT INTO courses (code, title, department_id) VALUES ('TEST 999', 'Email Delivery Test Course', 63)`).run().lastInsertRowid;
  db.prepare('INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)').run(stu, courseId);

  require('./server');
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/config'); break; } catch (e) { await new Promise(r2 => setTimeout(r2, 250)); }
  }
  console.log('Test server up on 3999. Accounts + target course ready.\n');

  const A = makeJar();
  const csrf0 = await getCsrf(A);
  let r = await req(A, 'POST', '/api/auth/admin-login', { body: { email: ADMIN_EMAIL, password: TEST_PASSWORD }, csrf: csrf0 });
  check('Super Admin login -> 200', r.status === 200, r.status === 200 ? '' : JSON.stringify(r.data));
  // Login regenerates the session, so the pre-login CSRF token is stale —
  // fetch a fresh one from the new session before the next state-changing call.
  const csrfA = await getCsrf(A);

  const fd = new FormData();
  fd.append('title', 'Email Delivery Test Memo');
  fd.append('body', 'This memo exists to verify that recipients receive an email when a memo is published.');
  fd.append('categoryId', '');
  fd.append('institutionWide', 'false');
  fd.append('facultyId', '');
  fd.append('departmentId', '');
  fd.append('levelId', '');
  fd.append('studyModeId', '');
  fd.append('courseId', String(courseId));
  r = await req(A, 'POST', '/api/memos', { form: fd, csrf: csrfA });
  check('Create draft memo -> 201', r.status === 201, JSON.stringify(r.data));
  const memoId = r.data && r.data.memoId;

  await runPublish(req, getCsrf, { check, results, A, memoId, courseId });
})().catch((err) => { console.error('Test runner crashed:', err); process.exit(1); });

// Part 2: publish + verify email_notifications + real SMTP send + cleanup.
async function runPublish(req, getCsrf, ctx) {
  const { check, results, A, memoId, courseId } = ctx;
  if (!memoId) { console.log('ABORT: no memo id'); process.exit(1); }

  const csrfA2 = await getCsrf(A);
  let r = await req(A, 'POST', `/api/memos/${memoId}/publish`, { body: {}, csrf: csrfA2 });
  check('Publish memo -> 200', r.status === 200, JSON.stringify(r.data));

  // Give the background SMTP send time to finish (Gmail TLS + delivery can
  // take several seconds; the delivery log row is written after the send).
  for (let i = 0; i < 20; i++) {
    await new Promise((r2) => setTimeout(r2, 1000));
    const row = db.prepare(
      `SELECT en.status FROM email_notifications en WHERE en.memo_id = ?`
    ).get(memoId);
    if (row) break;
  }
  const rows = db.prepare(
    `SELECT en.to_email, en.subject, en.status, en.error
     FROM email_notifications en JOIN users u ON u.id = en.user_id
     WHERE en.memo_id = ? AND u.email = 'edumemo26+memo-test@gmail.com'`
  ).all(memoId);
  const emailRow = rows[0];
  check('email_notifications row created for recipient', !!emailRow, emailRow ? `${emailRow.to_email} | ${emailRow.subject}` : 'missing');
  check('Email really sent via SMTP (status sent)', emailRow && emailRow.status === 'sent', emailRow && emailRow.status === 'failed' ? `error: ${emailRow.error}` : emailRow && emailRow.status);
  check('Recipient count limited to test student', rows.length === 1, `rows=${rows.length}`);

  const inApp = db.prepare(
    `SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id
     WHERE n.memo_id = ? AND n.type = 'in_app' AND u.email = 'edumemo26+memo-test@gmail.com'`
  ).get(memoId);
  check('In-app notification created', !!inApp);

  // Cleanup test data (cascades remove recipients/notifications/email logs).
  db.prepare(`DELETE FROM memos WHERE id = ?`).run(memoId);
  db.prepare(`DELETE FROM courses WHERE code = 'TEST 999'`).run();
  for (const email of ['test.superadmin.temp@example.edu', 'edumemo26+memo-test@gmail.com']) {
    db.prepare('DELETE FROM users WHERE email = ?').run(email);
  }
  console.log('\nTest data cleaned (real email, if sent, stays in the inbox).');
  const failed = results.filter(t => !t.ok);
  console.log(`\n========== ${results.length - failed.length}/${results.length} checks passed ==========`);
  if (failed.length) process.exit(1);
  process.exit(0);
}
