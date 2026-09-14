// Read-only dump of sessions + users from the smoke DB (forensics).
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const dbPath = process.env.SMOKE_DB;
if (!dbPath) throw new Error('SMOKE_DB env var required');
(async () => {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const stmt = db.prepare('SELECT sid, data, expires_at FROM sessions ORDER BY rowid');
  let n = 0;
  while (stmt.step()) {
    const row = stmt.getAsObject();
    let d = '?';
    try { d = JSON.parse(row.data); } catch (e) {}
    console.log(`SESSION sid=${String(row.sid).slice(0, 40)} csrf=${(d.csrfToken || '').slice(0, 16)} cookie=${JSON.stringify(d.cookie || null)}`);
    n++;
  }
  console.log('TOTAL_SESSIONS', n);
})().catch((e) => { console.error('DUMP ERR', e.message || e); process.exit(1); });