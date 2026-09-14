// Dump verification_tokens + email log token for comparison.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
(async () => {
  const dbp = process.env.SMOKE_DB || 'smoke-data/db-a/snapshot.sqlite';
  const SQL = await initSqlJs({ locateFile: (f) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database(fs.readFileSync(dbp));
  const stmt = db.prepare('SELECT id, user_id, token, expires_at, used_at, created_at FROM verification_tokens ORDER BY id');
  while (stmt.step()) {
    const r = stmt.getAsObject();
    console.log(`VT id=${r.id} user=${r.user_id} expires=${r.expires_at} used=${r.used_at || 'NULL'} len=${String(r.token).length}`);
    console.log('   token=', String(r.token));
  }
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });