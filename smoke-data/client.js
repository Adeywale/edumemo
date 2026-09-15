// Minimal CSRF + cookie-aware HTTP client for the feature smoke test.
const BASE = process.env.SMOKE_BASE || 'http://localhost:3199';

class Client {
  constructor() {
    this.cookie = '';
    this.csrf = null;
  }

  captureCookies(res) {
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return;
    const keep = [];
    let newSid = null;
    for (const part of setCookie.split(';')) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      const name = eq > 0 ? trimmed.slice(0, eq) : trimmed;
      const value = eq > 0 ? trimmed.slice(eq + 1) : '';
      if (/^(Path|HttpOnly|Secure|SameSite|Max-Age|Expires|Domain)/i.test(name)) continue;
      if (name === 'edumemo.sid') newSid = value;
      keep.push(`${name}=${value}`);
    }
    if (!keep.length) return;
    const joined = keep.join('; ');
    // The server regenerates the session id on login/logout (express-session
    // regenerate() starts a fresh, empty session), which invalidates the old
    // CSRF token. In a browser this is invisible because the page navigates
    // and api.js refetches /api/csrf-token; replicate that here by dropping
    // the cached token whenever the session id changes.
    if (newSid && newSid !== this.sid) {
      this.sid = newSid;
      this.csrf = null;
    }
    this.cookie = joined;
  }

  async request(method, path, body, { raw = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (method !== 'GET') {
      if (!this.csrf) {
        const r0 = await fetch(`${BASE}/api/csrf-token`, { headers });
        const j0 = await r0.json();
        // Capture the session cookie FIRST: the very first call establishes
        // the session id, and captureCookies() drops the cached CSRF token
        // whenever the session id changes. Assigning the token afterwards
        // keeps it paired with the session it actually belongs to (otherwise
        // a client whose first call is a POST sends a null token and the
        // server answers 403 "Invalid or missing security token").
        this.captureCookies(r0);
        this.csrf = j0.csrfToken;
        // The CSRF fetch populated the cookie jar; make sure the follow-up
        // request actually carries it (browsers do this automatically,
        // Node fetch does not).
        if (this.cookie) headers['Cookie'] = this.cookie;
      }
      headers['X-CSRF-Token'] = this.csrf;
    }
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    this.captureCookies(res);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok && !raw) {
      const headerInfo = JSON.stringify({ cookie: this.cookie.slice(0, 40), csrf: this.csrf ? this.csrf.slice(0, 12) : null });
      throw new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)} [${headerInfo}]`);
    }
    return { status: res.status, data };
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body || {}); }
  postRaw(path, body) { return this.request('POST', path, body || {}, { raw: true }); }
  put(path, body) { return this.request('PUT', path, body || {}); }
  putRaw(path, body) { return this.request('PUT', path, body || {}, { raw: true }); }
}

module.exports = Client;