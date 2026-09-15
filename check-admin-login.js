/* Temporary: prove the Super Admin portal login works with the real config.
   Uses admin-login.json credentials and the real database (read-only checks). */
const fs = require('fs');
const BASE = process.env.CHECK_BASE || 'http://127.0.0.1:3000';
const CREDS = JSON.parse(fs.readFileSync('admin-login.json', 'utf8'));

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  [${extra}]` : ''}`);
  if (!ok) failures += 1;
};

async function waitForServer() {
  for (let i = 0; i < 45; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server answering on ${BASE}`);
}

(async () => {
  await waitForServer();

  // fresh cookie + CSRF token (same dance the browser client performs)
  const jar = { cookie: '' };
  const csrfRes = await fetch(`${BASE}/api/csrf-token`, { credentials: 'same-origin' });
  const setCookie = csrfRes.headers.get('set-cookie') || '';
  jar.cookie = setCookie.split(';')[0];
  const { csrfToken } = await csrfRes.json();
  check('admin login page reachable', (await fetch(`${BASE}/admin/login`, { redirect: 'manual' })).status === 200);
  check('/admin/login page reachable in browser terms', (await fetch(`${BASE}/login`)).status === 200);

  const login = await fetch(`${BASE}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: jar.cookie },
    body: JSON.stringify(CREDS),
  });
  const loginBody = await login.json().catch(() => ({}));
  check('Super Admin login with admin-login.json credentials succeeds', login.status === 200, `status=${login.status} ${JSON.stringify(loginBody)}`);
  check('login returns the dashboard redirect',
    (loginBody.redirect || '') === '/admin/dashboard', `redirect=${loginBody.redirect}`);
  check('logged-in role is administrator', loginBody.user && loginBody.user.role === 'administrator');

  const cookie = (login.headers.get('set-cookie') || '').split(';')[0] || jar.cookie;
  const authed = async (path) => fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });

  const dash = await authed('/admin/dashboard');
  check('admin dashboard loads for the signed-in Super Admin', dash.status === 200, `status=${dash.status}`);

  const usersPage = await authed('/admin/users.html?tab=students');
  check('admin Users page loads', usersPage.status === 200, `status=${usersPage.status}`);

  const list = await authed('/api/admin/users?role=student');
  const listBody = await list.json().catch(() => null);
  check('users API works with the session', list.status === 200 && Array.isArray(listBody), `status=${list.status}`);

  const loginPageWhileAuthed = await authed('/admin/login');
  check('authenticated admin is redirected away from the login page (302)',
    loginPageWhileAuthed.status === 302, `status=${loginPageWhileAuthed.status}`);

  // the new delete endpoint must be protected and must not touch data here:
  const noSession = await fetch(`${BASE}/api/admin/users/99999999`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
  check('delete endpoint refuses anonymous callers (401)', noSession.status === 401, `status=${noSession.status}`);
  const withSession = await fetch(`${BASE}/api/admin/users/99999999`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken, Cookie: cookie } });
  check('delete endpoint answers the Super Admin (404 for a non-existent id)',
    withSession.status === 404, `status=${withSession.status}`);

  // wrong password must still be rejected (no accidental "any password" acceptance)
  const bad = await fetch(`${BASE}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: jar.cookie },
    body: JSON.stringify({ email: CREDS.email, password: 'definitely-not-the-password' }),
  });
  check('a wrong password is still rejected (401)', bad.status === 401, `status=${bad.status}`);

  console.log(failures === 0 ? '\nADMIN LOGIN VERIFIED OK' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('CHECK CRASHED:', err && err.message ? err.message : err);
  process.exitCode = 1;
});