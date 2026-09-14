const db = require('../database/db');
const emailService = require('./emailService');
const pushService = require('./pushService');

/**
 * For a published memo, notify every recipient in memo_recipients immediately.
 * All registered recipients receive the memo e-mail right away — no opt-in is
 * required; web push is sent to recipients who enabled it. Durable records in
 * notifications / email_notifications are created for every attempt so admins
 * have a full delivery/read history.
 */
async function notifyMemoRecipients(memo, baseUrl, options = {}) {
  const { skipInApp = false } = options;
  // A recipient only receives a web push when they have actually subscribed
  // at least one device (push_subscriptions row) -- the push_enabled flag is
  // the user's *preference* recorded at registration/settings, but a browser
  // must have completed the PushManager subscription before there is anything
  // to send to. The per-user subscription count lets us skip users who opted
  // in but have no device set up, instead of logging a meaningless failure.
  const recipients = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.email, u.push_enabled,
           (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.user_id = u.id) AS subscription_count
    FROM memo_recipients mr
    JOIN users u ON u.id = mr.user_id
    WHERE mr.memo_id = ?
  `).all(memo.id);

  const memoUrl = `${baseUrl}/memo/${memo.id}`;
  const insertNotification = db.prepare(`
    INSERT INTO notifications (user_id, memo_id, type, title, body, delivery_status)
    VALUES (?, ?, 'in_app', ?, ?, 'sent')
  `);
  const insertEmailLog = db.prepare(`
    INSERT INTO email_notifications (user_id, memo_id, to_email, subject, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPushNotifRecord = db.prepare(`
    INSERT INTO notifications (user_id, memo_id, type, title, body, delivery_status, failure_reason)
    VALUES (?, ?, 'push', ?, ?, ?, ?)
  `);

  let pushSentCount = 0;
  let emailSentCount = 0;

  // In-app notification rows are cheap synchronous DB writes -- create all
  // of them up front so every recipient sees the memo in-app immediately,
  // independent of how long email/push delivery takes. A resend skips these:
  // recipients already have the memo in-app, only the email/push is re-sent.
  if (!skipInApp) {
    for (const r of recipients) {
      insertNotification.run(r.id, memo.id, memo.title, `New memo published: ${memo.title}`);
    }
  }

  // Push and email were previously sent one recipient at a time, each
  // fully awaited before moving to the next -- for N recipients that is N
  // sequential SMTP/push round-trips (minutes for a large class). Sending
  // them concurrently, in bounded batches, is what actually makes delivery
  // fast without overwhelming the SMTP server or push service.
  const CONCURRENCY = 15;
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const batch = recipients.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (r) => {
      const name = `${r.first_name} ${r.last_name}`;
      let pushSent = false;
      let pushRecord = null;

      // Only attempt a web push when the recipient actually has a device
      // subscribed (see the query note above). Users who merely opted in at
      // registration but never completed the browser subscription are simply
      // not attempted -- no bogus "failed" rows in their notification history.
      if (r.subscription_count > 0) {
        const result = await pushService.sendPushToUser(r.id, {
          title: memo.title,
          body: `A new memo has been published.`,
          url: memoUrl,
        });
        if (result.skipped) {
          pushRecord = ['skipped', 'Push not configured on server'];
        } else if (result.sent > 0) {
          pushSent = true;
          pushRecord = ['sent', null];
        } else if (result.noSubscriptions) {
          pushRecord = ['skipped', 'No device is currently subscribed'];
        } else {
          pushRecord = ['failed', 'Push service rejected the subscription'];
        }
      }

      const emailResult = await emailService.sendMemoNotificationEmail(r.email, name, {
        title: memo.title,
        senderName: memo.senderName,
      }, memoUrl);

      return { r, pushSent, pushRecord, emailOk: emailResult.ok, emailError: emailResult.error };
    }));

    // DB writes stay on the main thread, sequential, after each batch
    // resolves -- sql.js is single-connection so this keeps writes safe
    // while still letting the slow network I/O run in parallel.
    for (const res of results) {
      if (res.pushRecord) {
        insertPushNotifRecord.run(res.r.id, memo.id, memo.title, 'Web Push notification', res.pushRecord[0], res.pushRecord[1]);
        if (res.pushSent) pushSentCount++;
      }
      if (res.emailOk) emailSentCount++;
      insertEmailLog.run(
        res.r.id, memo.id, res.r.email, emailService.memoNotificationSubject(memo.title),
        res.emailOk ? 'sent' : 'failed',
        res.emailOk ? null : (res.emailError || null)
      );
    }
  }

  return { recipientCount: recipients.length, pushSentCount, emailSentCount };
}

module.exports = { notifyMemoRecipients };
