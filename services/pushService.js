const webpush = require('web-push');
const db = require('../database/db');

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

const isConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (isConfigured) {
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:admin@example.edu',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

/** Number of active push subscriptions a user currently has on this server. */
function countSubscriptionsForUser(userId) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`).get(userId);
  return row ? row.n : 0;
}

/**
 * Sends a web push notification to every subscription belonging to a user.
 * Silently no-ops (per-subscription) if VAPID keys are not configured, and
 * removes subscriptions that the push service reports as expired/invalid.
 * Returns { sent, skipped, noSubscriptions } so callers can distinguish
 * "server not configured", "user has no device subscribed", and "sent".
 */
async function sendPushToUser(userId, payload) {
  if (!isConfigured) return { sent: 0, skipped: true, noSubscriptions: false };

  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).all(userId);
  if (!subs.length) return { sent: 0, skipped: false, noSubscriptions: true };

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      // 404/410 = the device's push endpoint is gone (re-installed app,
      // browser re-created the subscription, etc.) -- drop it so we don't
      // keep failing against it. 403 usually means the subscription is
      // invalid/stale on the push service, so it should be dropped too.
      if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 403) {
        db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
      } else {
        console.error('Push send failed for subscription', sub.id, err.message);
      }
    }
  }
  return { sent, skipped: false, noSubscriptions: false };
}

module.exports = { isConfigured, sendPushToUser, countSubscriptionsForUser, publicKey: VAPID_PUBLIC_KEY };
