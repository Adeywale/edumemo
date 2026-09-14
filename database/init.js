// Applies schema.sql to the SQLite database. Safe to re-run (all statements
// use IF NOT EXISTS). Must be awaited before any other module touches db.
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function initDatabase() {
  await db.init(); // boots the sql.js WASM engine and loads/creates the .sqlite file
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  // Additive migrations for databases created before staff types and recipient
  // groups were introduced. SQLite does not support ADD COLUMN IF NOT EXISTS.
  const userColumns = db.prepare(`PRAGMA table_info(users)`).all().map(column => column.name);
  if (!userColumns.includes('staff_type')) {
    db.exec(`ALTER TABLE users ADD COLUMN staff_type TEXT NOT NULL DEFAULT 'academic' CHECK (staff_type IN ('academic', 'non_academic'))`);
  }
  const targetColumns = db.prepare(`PRAGMA table_info(memo_target_rules)`).all().map(column => column.name);
  if (!targetColumns.includes('recipient_group')) {
    db.exec(`ALTER TABLE memo_target_rules ADD COLUMN recipient_group TEXT NOT NULL DEFAULT 'students'`);
  }
  if (!targetColumns.includes('recipient_user_ids')) {
    db.exec(`ALTER TABLE memo_target_rules ADD COLUMN recipient_user_ids TEXT`);
  }
  [['100 Level', 1], ['200 Level', 2], ['300 Level', 3], ['400 Level', 4], ['500 Level', 5]].forEach(([name, sortOrder]) => {
    db.prepare(`INSERT OR IGNORE INTO levels (name, sort_order) VALUES (?, ?)`).run(name, sortOrder);
  });
  console.log('Database schema applied successfully.');
}

if (require.main === module) {
  initDatabase().catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = initDatabase;
