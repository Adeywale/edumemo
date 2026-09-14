const { nanoid } = require('nanoid');
const db = require('../database/db');

const VERIFICATION_TOKEN_TTL_HOURS = 48;
const RESET_TOKEN_TTL_HOURS = 1;

function createVerificationToken(userId) {
  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`)
    .run(userId, token, expiresAt);
  return token;
}

function consumeVerificationToken(token) {
  const row = db.prepare(`SELECT * FROM verification_tokens WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  db.prepare(`UPDATE verification_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return row;
}

function createPasswordResetToken(userId) {
  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`)
    .run(userId, token, expiresAt);
  return token;
}

function consumePasswordResetToken(token) {
  const row = db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return row;
}

module.exports = {
  createVerificationToken,
  consumeVerificationToken,
  createPasswordResetToken,
  consumePasswordResetToken,
};
