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
 * removes subscriptions the push service confirms are gone for good.
 * Returns { sent, failed, skipped, noSubscriptions, reason } so callers can
 * distinguish "server not configured", "user has no device subscribed",
 * "sent", and "the push service rejected this device".
 */
async function sendPushToUser(userId, payload) {
  if (!isConfigured) return { sent: 0, failed: 0, skipped: true, noSubscriptions: false, reason: 'Push not configured on server' };

  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).all(userId);
  if (!subs.length) return { sent: 0, failed: 0, skipped: false, noSubscriptions: true, reason: 'No device is currently subscribed' };

  let sent = 0;
  let failed = 0;
  let reason = null;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        {
          // An explicit TTL means the push service still delivers the alert
          // when the phone was offline/asleep for a while instead of dropping
          // it, and "high" urgency stops Android (Doze) from deferring the
          // notification until the user next unlocks the phone.
          TTL: 60 * 60 * 24,
          urgency: 'high',
        }
      );
      sent++;
    } catch (err) {
      failed++;
      reason = `${err.statusCode || 'error'}: ${err.body || err.message}`;

      // 404/410 are the push service telling us the endpoint itself is gone
      // (app uninstalled, browser re-created the subscription, site data
      // cleared). Only those are permanent, so only those are deleted.
      //
      // 403 is NOT proof the device is unreachable: it also appears when the
      // server's VAPID keys were regenerated/mis-set, or as a transient
      // rejection. Deleting the row on 403 would silently disable web push
      // for that user forever (nothing re-registers a device by itself), so
      // the subscription is kept and the failure is logged loudly instead.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
        console.error(`Push subscription ${sub.id} removed: endpoint is gone (${err.statusCode}). The user must enable push again from Settings.`);
      } else if (err.statusCode === 403) {
        console.error(
          `Push rejected with 403 for subscription ${sub.id} (user ${userId}): ${reason}. ` +
          'Check that VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are the same pair the device subscribed with ' +
          '(and that VAPID_SUBJECT is a valid mailto: or https: URI). The subscription was kept.'
        );
      } else {
        console.error(`Push send failed for subscription ${sub.id} (user ${userId}): ${reason}`);
      }
    }
  }
  return { sent, failed, skipped: false, noSubscriptions: false, reason };
}

module.exports = { isConfigured, sendPushToUser, countSubscriptionsForUser, publicKey: VAPID_PUBLIC_KEY };
