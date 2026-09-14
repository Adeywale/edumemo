/* Shared API client: attaches CSRF token to state-changing requests, and
   normalizes JSON/multipart handling + error messages. */

const Api = (() => {
  let csrfToken = null;

  async function ensureCsrfToken() {
    if (csrfToken) return csrfToken;
    const res = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  async function request(method, url, body, isMultipart = false) {
    const headers = {};
    if (!isMultipart) headers['Content-Type'] = 'application/json';

    if (method !== 'GET') {
      headers['X-CSRF-Token'] = await ensureCsrfToken();
    }

    const res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body ? (isMultipart ? body : JSON.stringify(body)) : undefined,
    });

    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }

    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
    put: (url, body) => request('PUT', url, body || {}),
    del: (url) => request('DELETE', url),
    postForm: (url, formData) => request('POST', url, formData, true),
    putForm: (url, formData) => request('PUT', url, formData, true),
  };
})();
