const db = require('../database/db');
const pushService = require('../services/pushService');

function listNotifications(req, res) {
  const user = req.session.user;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  const rows = db.prepare(`
    SELECT id, memo_id, title, body, is_read, created_at
    FROM notifications
    WHERE user_id = ? AND type = 'in_app'
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(user.id, pageSize, offset);

  const unreadCount = db.prepare(`
    SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND type = 'in_app' AND is_read = 0
  `).get(user.id).count;

  res.json({ notifications: rows, unreadCount });
}

function unreadCount(req, res) {
  const user = req.session.user;
  const count = db.prepare(`
    SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND type = 'in_app' AND is_read = 0
  `).get(user.id).count;
  res.json({ unreadCount: count });
}

function markAsRead(req, res) {
  const user = req.session.user;
  const id = Number(req.params.id);
  const notif = db.prepare(`SELECT * FROM notifications WHERE id = ? AND user_id = ?`).get(id, user.id);
  if (!notif) return res.status(404).json({ error: 'Notification not found.' });
  db.prepare(`UPDATE notifications SET is_read = 1, read_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ message: 'Marked as read.' });
}

function markAllAsRead(req, res) {
  const user = req.session.user;
  db.prepare(`UPDATE notifications SET is_read = 1, read_at = datetime('now') WHERE user_id = ? AND is_read = 0`).run(user.id);
  res.json({ message: 'All notifications marked as read.' });
}

function getPushPublicKey(req, res) {
  res.json({ publicKey: pushService.publicKey || null, configured: pushService.isConfigured });
}

function subscribePush(req, res) {
  const user = req.session.user;
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(user.id, endpoint, keys.p256dh, keys.auth);
  db.prepare(`UPDATE users SET push_enabled = 1 WHERE id = ?`).run(user.id);
  res.json({ message: 'Push notifications enabled.' });
}

function unsubscribePush(req, res) {
  const user = req.session.user;
  const { endpoint } = req.body;
  if (endpoint) {
    db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`).run(endpoint, user.id);
  } else {
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(user.id);
  }
  const remaining = db.prepare(`SELECT COUNT(*) as count FROM push_subscriptions WHERE user_id = ?`).get(user.id).count;
  if (remaining === 0) db.prepare(`UPDATE users SET push_enabled = 0 WHERE id = ?`).run(user.id);
  res.json({ message: 'Push notifications disabled.' });
}

module.exports = { listNotifications, unreadCount, markAsRead, markAllAsRead, getPushPublicKey, subscribePush, unsubscribePush };
