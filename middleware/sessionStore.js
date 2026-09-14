// A minimal express-session store persisted through our own sql.js-backed
// database (see database/db.js). Avoids connect-sqlite3, which depends on
// the native `sqlite3` addon -- the same class of Windows build-toolchain
// problem we removed better-sqlite3 for. Sessions live in the `sessions`
// table created by schema.sql.
const session = require('express-session');
const db = require('../database/db');

class SqlJsSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    // Opportunistically clear expired rows every 10 minutes.
    this._cleanupTimer = setInterval(() => this._clearExpired(), 10 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _clearExpired() {
    try {
      db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
    } catch (e) { /* db may not be ready yet during early startup; ignore */ }
  }

  get(sid, callback) {
    try {
      const row = db.prepare(`SELECT data FROM sessions WHERE sid = ? AND expires_at >= datetime('now')`).get(sid);
      if (!row) return callback(null, null);
      callback(null, JSON.parse(row.data));
    } catch (err) { callback(err); }
  }

  set(sid, sessionData, callback) {
    try {
      const maxAgeMs = (sessionData.cookie && sessionData.cookie.maxAge) || 1000 * 60 * 60 * 24 * 7;
      const expiresAt = new Date(Date.now() + maxAgeMs).toISOString();
      const data = JSON.stringify(sessionData);
      db.prepare(`
        INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
      `).run(sid, data, expiresAt);
      callback && callback(null);
    } catch (err) { callback && callback(err); }
  }

  destroy(sid, callback) {
    try {
      db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
      callback && callback(null);
    } catch (err) { callback && callback(err); }
  }

  touch(sid, sessionData, callback) {
    try {
      const maxAgeMs = (sessionData.cookie && sessionData.cookie.maxAge) || 1000 * 60 * 60 * 24 * 7;
      const expiresAt = new Date(Date.now() + maxAgeMs).toISOString();
      db.prepare(`UPDATE sessions SET expires_at = ? WHERE sid = ?`).run(expiresAt, sid);
      callback && callback(null);
    } catch (err) { callback && callback(err); }
  }
}

module.exports = SqlJsSessionStore;
