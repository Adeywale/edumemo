/*
 * READ-ONLY diagnostics for memo notification delivery (email + web push).
 * Loads the SQLite file with sql.js (never writes/persists anything), prints
 * the delivery tables, verifies that the VAPID key pair in .env actually
 * matches, and checks whether SMTP credentials are accepted by the mail host.
 *
 * Run with:   node diag-notifications.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

function b64urlToBuf(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function bufToB64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

(async () => {
  const dbFile = process.env.DATABASE_PATH
    ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
    : path.join(__dirname, 'database', 'database.sqlite');
  console.log('=== DATABASE ===');
  console.log('file:', dbFile, fs.existsSync(dbFile) ? `(${fs.statSync(dbFile).size} bytes)` : '(MISSING)');

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
  });
  const raw = new SQL.Database(fs.readFileSync(dbFile));
  const q = (sql) => {
    const res = raw.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  };
  const dump = (label, sql) => {
    console.log(`\n--- ${label} ---`);
    const rows = q(sql);
    if (!rows.length) return console.log('(no rows)');
    console.table(rows);
  };

  dump('users by role/status', `SELECT role, status, COUNT(*) AS n,
      SUM(push_enabled) AS push_opted_in, SUM(email_verified) AS verified
    FROM users GROUP BY role, status`);

  dump('push subscriptions', `SELECT
      (SELECT COUNT(*) FROM push_subscriptions) AS subscriptions,
      (SELECT COUNT(DISTINCT user_id) FROM push_subscriptions) AS subscribed_users`);

  dump('latest 8 memos + delivery outcome', `SELECT m.id, substr(m.title,1,28) AS title, m.status,
      m.estimated_recipient_count AS estimate,
      (SELECT COUNT(*) FROM memo_recipients mr WHERE mr.memo_id = m.id) AS recipients,
      (SELECT COUNT(*) FROM notifications n WHERE n.memo_id = m.id AND n.type = 'in_app') AS in_app_rows,
      (SELECT COUNT(*) FROM notifications n WHERE n.memo_id = m.id AND n.type = 'push') AS push_rows,
      (SELECT COUNT(*) FROM email_notifications e WHERE e.memo_id = m.id AND e.status = 'sent') AS emails_sent,
      (SELECT COUNT(*) FROM email_notifications e WHERE e.memo_id = m.id AND e.status = 'failed') AS emails_failed,
      m.published_at
    FROM memos m ORDER BY m.id DESC LIMIT 8`);

  dump('latest 10 email attempts', `SELECT id, memo_id, to_email, status, substr(COALESCE(error,''),1,60) AS error, created_at
    FROM email_notifications ORDER BY id DESC LIMIT 10`);

  dump('latest 10 push records', `SELECT id, user_id, memo_id, delivery_status, substr(COALESCE(failure_reason,''),1,50) AS reason, created_at
    FROM notifications WHERE type = 'push' ORDER BY id DESC LIMIT 10`);

  dump('notifications by type (all time)', `SELECT type, delivery_status, COUNT(*) AS n FROM notifications GROUP BY type, delivery_status`);

  console.log('\n=== VAPID KEY PAIR ===');
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.log('VAPID keys not both set -> web push is DISABLED (sendPushToUser returns skipped).');
  } else {
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(b64urlToBuf(priv));
      const derived = bufToB64url(ecdh.getPublicKey(null, 'uncompressed'));
      console.log('public key in .env matches private key:', derived === pub ? 'YES' : 'NO  <-- MISMATCH');
      if (derived !== pub) {
        console.log('  derived from private key:', derived);
        console.log('  configured public key  :', pub);
        console.log('  A mismatch makes every push attempt fail with 403, and pushService');
        console.log('  then DELETES the subscription from the database.');
      }
    } catch (err) {
      console.log('Could not derive the public key from VAPID_PRIVATE_KEY:', err.message);
    }
    console.log('VAPID_SUBJECT:', process.env.VAPID_SUBJECT || '(unset -> falls back to mailto:admin@example.edu)');
  }

  console.log('\n=== SMTP ===');
  if (!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM_EMAIL)) {
    console.log('SMTP not fully configured -> memo emails are only logged to the console (no real email).');
  } else {
    console.log('host:', process.env.SMTP_HOST, 'user:', process.env.SMTP_USER,
      'from:', process.env.SMTP_FROM_EMAIL, 'secure:', process.env.SMTP_SECURE);
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      family: 4,
    });
    try {
      await transporter.verify();
      console.log('SMTP verify: OK (credentials accepted)');
    } catch (err) {
      console.log('SMTP verify FAILED:', err.code || '', err.message);
      console.log('  -> every memo email will be logged as status=failed with this error.');
    } finally {
      transporter.close();
    }
  }
})().catch((err) => { console.error('Diagnostics crashed:', err); process.exit(1); });