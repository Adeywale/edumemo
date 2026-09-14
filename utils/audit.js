const db = require('../database/db');

/**
 * Records an action in the audit_logs table.
 * @param {object} opts
 * @param {object|null} opts.actor - the acting user (req.session.user) or null
 * @param {string} opts.action - short machine-readable action name, e.g. "memo.publish"
 * @param {string} [opts.targetType]
 * @param {number} [opts.targetId]
 * @param {object|string} [opts.details]
 * @param {string} [opts.ip]
 */
function logAction({ actor, action, targetType = null, targetId = null, details = null, ip = null }) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    actor ? actor.id : null,
    actor ? actor.role : null,
    action,
    targetType,
    targetId,
    details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
    ip
  );
}

module.exports = { logAction };
