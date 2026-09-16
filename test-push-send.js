/*
 * Live Web Push check: sends a real push notification to every subscription
 * stored for a user, using the same code path publishing a memo uses, and
 * reports exactly what the push service replied. Nothing is written to the
 * database (subscriptions are only removed by pushService when the push
 * service says the endpoint is gone).
 *
 * Run with:   node test-push-send.js [userId]
 */
require('dotenv').config();
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

(async () => {
  console.log('VAPID public key set:', Boolean(VAPID_PUBLIC_KEY));
  console.log('VAPID private key set:', Boolean(VAPID_PRIVATE_KEY));
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log('-> web push is disabled on this server (sendPushToUser returns skipped).');
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.edu', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const dbFile = process.env.DATABASE_PATH
    ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
    : path.join(__dirname, 'database', 'database.sqlite');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f) });
  const raw = new SQL.Database(fs.readFileSync(dbFile));
  const q = (sql, params = []) => {
    const stmt = raw.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };

  const subs = q(`SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth, u.email
                  FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id`);
  console.log(`\nStored subscriptions: ${subs.length}`);
  for (const s of subs) {
    const target = process.argv[2] ? Number(process.argv[2]) : s.user_id;
    if (target !== s.user_id) continue;
    console.log(`\n--- subscription #${s.id} (user #${s.user_id} ${s.email}) ---`);
    console.log('endpoint:', s.endpoint.slice(0, 80) + '...');
    try {
      const res = await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: 'EduMemo delivery check', body: 'If you see this, Web Push works end to end.', url: '/' }),
        { TTL: 60 }
      );
      console.log('push service replied:', res.statusCode, '(accepted)');
      console.log('  -> the push service (FCM) accepted the message; if no notification appears,');
      console.log('     the browser/device side is the problem (permission, service worker, focus).');
    } catch (err) {
      console.log('push service REJECTED:', err.statusCode, err.body || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log('  -> endpoint is gone (404/410). pushService deletes such rows, so this user');
        console.log('     will NEVER receive push again until the browser re-subscribes.');
      } else if (err.statusCode === 403) {
        console.log('  -> 403: the VAPID key pair the subscription was created with does not match');
        console.log('     the server keys (or the subscription is stale).');
      }
    }
  }
})().catch((err) => { console.error('crashed:', err); process.exit(1); });