// Debug: exercise the exact Client flow used by smoke.js against verify-email.
const Client = require('./client');
(async () => {
  const c = new Client();
  const r1 = await c.request('GET', '/api/csrf-token');
  console.log('csrf response status', r1.status, 'csrfToken set?', !!c.csrf, 'cookie?', c.cookie.slice(0, 60));
  const r2 = await c.request('POST', '/api/auth/verify-email', { token: 'dummy' });
  console.log('verify-email status', r2.status, JSON.stringify(r2.data));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });