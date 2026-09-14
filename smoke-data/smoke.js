// End-to-end smoke test for the Web Push + Forgot Password features.
// Requires a running server (see smoke-data/README notes).
const fs = require('fs');
const Client = require('./client');
const BASE = process.env.SMOKE_BASE || 'http://localhost:3199';
const LOG = process.env.SMOKE_LOG;
const STATE_FILE = process.env.SMOKE_STATE || 'smoke-data/state.json';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('ok -', msg);
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/config`);
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Server did not become ready within 90s');
}

// Registrations send the verification email to the dev console log (SMTP
// unset) -- read it back to grab the token and verify the account as a
// user would by clicking the emailed link.
function readVerificationToken() {
  if (!LOG) throw new Error('SMOKE_LOG env var required to read the verification link');
  const { execSync } = require('child_process');
  for (let i = 0; i < 20; i++) {
    const log = fs.readFileSync(LOG, 'utf8');
    // Take the LAST verification link in the log -- the fresh one from the
    // most recent registration -- in case an earlier smoke run left residue.
    const matches = log.match(/(https?:\/\/[^\s]+?verify-email\.html\?token=[A-Za-z0-9_-]+)/g);
    if (matches && matches.length) return matches[matches.length - 1];
    execSync('ping -n 1 127.0.0.1 >nul 2>&1', { shell: true });
  }
  throw new Error('No verification link found in server log');
}

async function main() {
  await waitForServer();

  const studentEmail = `smoke.${Date.now()}@example.edu`;
  const pwdA = 'OriginalPass123!';
  const pwdB = 'NewPass456!';
  let memoId = null;

  // ---- static pages the two features depend on ----
  {
    const urls = [
      ['/login.html', 'login.html serves'],
      ['/forgot-password.html', 'forgot-password.html serves'],
      ['/reset-password.html?token=demo', 'reset-password.html serves'],
      ['/service-worker.js', 'service-worker.js serves at root scope (required for Web Push)'],
      ['/manifest.json', 'manifest.json serves (PWA installability for Android)'],
      ['/js/push.js', 'push.js serves'],
    ];
    for (const [url, label] of urls) {
      const res = await fetch(`${BASE}${url}`);
      assert(res.status === 200, label);
    }
  }

  // ---- student registration with push opt-in ----
  const reg = new Client();
  const fac = await reg.get('/api/meta/faculties');
  const levels = await reg.get('/api/meta/levels');
  const modes = await reg.get('/api/meta/study-modes');
  assert(fac.status === 200 && fac.data.length > 0, 'faculties list available pre-login (registration UX)');
  const r1 = await reg.post('/api/auth/register/student', {
    firstName: 'Smoke', lastName: 'Student', phone: '0801234567',
    matricNumber: `SMK-${Date.now()}`, facultyId: fac.data[0].id,
    departmentName: 'Computer Science', levelId: levels.data[0].id,
    studyModeId: modes.data[0].id, email: studentEmail,
    password: pwdA, confirmPassword: pwdA, enablePush: true,
  });
  assert(r1.status === 201, 'student registration (push opt-in) succeeds');

  // verify email like the emailed link would
  const verifyUrl = readVerificationToken();
  const vToken = verifyUrl.split('token=')[1];
  const vc = new Client();
  const vres = await vc.post('/api/auth/verify-email', { token: vToken });
  assert(vres.status === 200, 'email verification link works');
  const vAgain = await vc.postRaw('/api/auth/verify-email', { token: vToken });
  assert(vAgain.status === 400, 'verification token is single-use');

  // ---- login ----
  const stu = new Client();
  const login = await stu.post('/api/auth/login', { email: studentEmail, password: pwdA });
  assert(login.status === 200 && login.data.user.role === 'student', 'student logs in after verification');
  const me = await stu.get('/api/auth/me');
  assert(me.data.user.role === 'student', '/api/auth/me returns the session user');
// ---- profile exposes push state BEFORE any device ----
  const prof1 = await stu.get('/api/profile');
  assert(prof1.data.account.pushEnabled === true, 'pushEnabled=true (preference from registration)');
  assert(prof1.data.account.pushSubscribed === false, 'pushSubscribed=false (no device subscribed yet)');
  assert(typeof prof1.data.account.pushConfigured === 'boolean', 'pushConfigured exposed to the UI');

  // ---- subscribe a device (what PushClient.enable() posts after the browser prompt) ----
  const sub = await stu.post('/api/notifications/push/subscribe', {
    endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${Date.now()}`,
    keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(24) },
  });
  assert(sub.status === 200, '/api/notifications/push/subscribe stores the subscription');
  const prof2 = await stu.get('/api/profile');
  assert(prof2.data.account.pushSubscribed === true, 'pushSubscribed=true after subscribing a device');
  const pubkey = await stu.get('/api/notifications/push/public-key');
  assert(pubkey.status === 200, 'push public-key endpoint reachable when authenticated');

  // ---- admin publishes a memo targeted at exactly this student ----
  const admin = new Client();
  const alogin = await admin.post('/api/auth/admin-login', {
    email: process.env.SMOKE_ADMIN_EMAIL || 'admin@smoke.edu',
    password: process.env.SMOKE_ADMIN_PASSWORD || 'AdminPass123!',
  });
  assert(alogin.status === 200 && alogin.data.user.role === 'administrator', 'administrator login works');
  const memo = await admin.post('/api/memos', {
    title: 'Smoke test memo',
    body: 'This memo exercises the publish -> recipient -> in-app + push pipeline.',
    recipientGroup: 'selected_users',
    recipientUserIds: [me.data.user.id],
  });
  assert(memo.status === 201 && memo.data.memoId > 0, 'admin creates a draft memo');
  memoId = memo.data.memoId;
  const pub = await admin.post(`/api/memos/${memoId}/publish`, {});
  assert(pub.status === 200 && pub.data.recipientCount === 1, 'publish targets exactly 1 recipient');
  await new Promise((r) => setTimeout(r, 4000)); // background email/push delivery

  // student receives it in-app + in inbox
  const notifs = await stu.get('/api/notifications?page=1');
  assert(notifs.data.notifications.some((n) => n.memo_id === memoId), 'in-app notification recorded for the memo');
  const list = await stu.get('/api/memos?page=1');
  assert(list.data.memos.some((m) => m.id === memoId), 'memo appears in the student inbox');

  // unsubscribe endpoint still works
  const unsub = await stu.post('/api/notifications/push/unsubscribe', {
    endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${Date.now() - 1}`,
  });
  assert(unsub.status === 200, 'push unsubscribe endpoint responds');

  // ---- logout ----
  await stu.post('/api/auth/logout');

  // ---- FORGOT PASSWORD flow ----
  const fp = new Client();
  const forgot = await fp.post('/api/auth/forgot-password', { email: studentEmail });
  assert(forgot.status === 200, 'forgot-password returns success (no account enumeration)');
  const nf = new Client();
  const forgotMissing = await nf.post('/api/auth/forgot-password', { email: 'nobody@example.edu' });
  assert(forgotMissing.status === 200, 'unknown email gets the same generic response (no enumeration)');

  if (forgot.data.devResetUrl) {
    const resetUrl = forgot.data.devResetUrl;
    assert(/reset-password\.html\?token=[A-Za-z0-9_-]{32,}/.test(resetUrl), 'reset link embeds a long random token');
    const token = resetUrl.split('token=')[1];
    const page = await fetch(`${BASE}/reset-password.html?token=${token}`);
    assert(page.status === 200, 'reset page opens from the emailed link (works on a phone)');

    const rp = new Client();
    const tooShort = await rp.postRaw('/api/auth/reset-password', { token, password: 'short', confirmPassword: 'short' });
    assert(tooShort.status === 400, 'weak reset passwords rejected');

    const badToken = await rp.postRaw('/api/auth/reset-password', { token: 'x'.repeat(48), password: pwdB, confirmPassword: pwdB });
    assert(badToken.status === 400, 'invalid/expired reset tokens rejected');

    const ok = await rp.post('/api/auth/reset-password', { token, password: pwdB, confirmPassword: pwdB });
    assert(ok.status === 200, 'valid reset token updates the password');

    const reuse = await rp.postRaw('/api/auth/reset-password', { token, password: pwdB, confirmPassword: pwdB });
    assert(reuse.status === 400, 'reset token is single-use');

    const oldPw = new Client();
    const oldLogin = await oldPw.postRaw('/api/auth/login', { email: studentEmail, password: pwdA });
    assert(oldLogin.status === 401, 'old password no longer works after reset');

    const newPw = new Client();
    const newLogin = await newPw.post('/api/auth/login', { email: studentEmail, password: pwdB });
    assert(newLogin.status === 200, 'new password signs in after reset');
  } else {
    console.log('note - devResetUrl absent (SMTP configured); token-level checks skipped in this run');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ studentEmail, memoId, pwdA, pwdB }, null, 2));
  console.log('\nSMOKE OK - all feature checks passed.');
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err.message || err);
  process.exit(1);
});