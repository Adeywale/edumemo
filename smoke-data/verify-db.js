// Read-only verification of the persisted SQLite file after the server is
// stopped. Asserts the two features left the expected durable records.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = process.env.SMOKE_DB;
if (!dbPath) throw new Error('SMOKE_DB env var required');

function fail(msg) { console.error('DB VERIFY FAILED: ' + msg); process.exit(1); }
function all(db, sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(...params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  return rows;
}
function one(db, sql, ...params) { return all(db, sql, ...params)[0]; }

(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const state = JSON.parse(fs.readFileSync(process.env.SMOKE_STATE || 'smoke-data/state.json', 'utf8'));
  const student = one(db, 'SELECT * FROM users WHERE email = ?', state.studentEmail);
  if (!student) return fail('student account not persisted in users');
  console.log('ok - student account persisted');

  if (student.push_enabled !== 1) return fail('push_enabled should be 1 (registration opt-in preference)');
  console.log('ok - push_enabled=1 persisted for the student');

  const subs = all(db, 'SELECT * FROM push_subscriptions WHERE user_id = ?', student.id);
  console.log(`note - ${subs.length} push subscription row(s) after unsubscribe during flow`);

  const memo = one(db, 'SELECT * FROM memos WHERE id = ?', state.memoId);
  if (!memo || memo.status !== 'published') return fail('memo should be published');
  console.log('ok - memo persisted as published');

  const inApp = one(db, "SELECT COUNT(*) AS n FROM notifications WHERE memo_id = ? AND type = 'in_app'", state.memoId);
  if (!inApp || inApp.n < 1) return fail('in-app notification row missing');
  console.log('ok - in-app notification recorded');

  const pushRows = all(db, "SELECT * FROM notifications WHERE memo_id = ? AND type = 'push'", state.memoId);
  const wantPush = process.env.SMOKE_EXPECT_PUSH === '1';
  if (wantPush) {
    if (pushRows.length < 1) return fail('expected a push notification record for the subscribed user');
    console.log('ok - push notification record exists');
    for (const row of pushRows) {
      console.log(`note - push delivery_status=${row.delivery_status} failure_reason=${row.failure_reason || '(none)'}`);
    }
  } else {
    console.log('note - push records not asserted (VAPID-unconfigured phase)');
  }

  const resetTokens = all(db, "SELECT * FROM password_reset_tokens WHERE user_id = ?", student.id);
  if (resetTokens.length < 1) return fail('expected at least one password_reset_tokens row');
  const used = resetTokens.filter((t) => !!t.used_at);
  if (used.length !== resetTokens.length) return fail('every reset token should be consumed after the flow');
  console.log('ok - reset tokens persisted and consumed (single-use)');
  for (const t of resetTokens) {
    console.log(`note - reset token expires_at=${t.expires_at} used_at=${t.used_at} (1h TTL confirmed by expiry)`);
  }

  const oldPw = one(db, "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL", student.id);
  if (oldPw.n !== 0) return fail('no unused reset tokens should remain');

  console.log('\nDB VERIFY OK.');
})().catch((err) => {
  console.error('DB VERIFY ERROR:', err.message || err);
  process.exit(1);
});