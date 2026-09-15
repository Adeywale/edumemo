// Database layer backed by sql.js -- a pure WebAssembly build of SQLite.
//
// Why: the previous driver (better-sqlite3) is a native addon that must be
// compiled with a C++ toolchain, which caused install failures on machines
// without Visual Studio Build Tools configured (a common Windows problem).
// sql.js ships a precompiled .wasm file and needs no compiler at all, on any
// OS, while still being real SQLite underneath -- so every table, query, and
// constraint in schema.sql behaves identically. This module exposes the
// same small API surface the rest of the app already uses
// (db.prepare(sql).run/get/all(...), db.exec(sql), db.pragma(str),
// db.transaction(fn)) so no controller or service code needed to change.
//
// Persistence note: sql.js keeps the database entirely in memory; durability
// comes from calling Database.export() and writing the bytes to disk
// ourselves. That export must never happen while an explicit BEGIN...COMMIT
// is in progress -- doing so was found to silently corrupt the in-memory
// transaction state (SQLite would then report "no transaction is active" on
// COMMIT). So writes made *inside* db.transaction(fn) are persisted exactly
// once, after COMMIT; writes made outside any transaction persist
// immediately after each statement, same as before.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
require('dotenv').config();

// ------------------------------------------------------------------
// Where the .sqlite file actually lives, in priority order:
//
//   1. DATABASE_PATH        -- explicit override, always wins if set.
//   2. RAILWAY_VOLUME_MOUNT_PATH -- Railway sets this automatically for
//      any service that has a Volume attached (e.g. "/data"). If present,
//      we write the DB inside it without the user having to also set
//      DATABASE_PATH by hand.
//   3. A local folder next to this file -- fine for local dev, but on
//      most hosts (Railway included) this directory is wiped on every
//      deploy/restart, so anything written here does not survive.
//
// isPersistent reflects whether we're confident the chosen location
// survives a redeploy. It's surfaced in the startup banner (server.js)
// so a wiped-database problem is obvious in the logs instead of showing
// up later as "valid credentials suddenly stop working".
// ------------------------------------------------------------------
let dbPath;
let isPersistent;

if (process.env.DATABASE_PATH) {
  dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH);
  // We can't know for certain the target is durable, but an explicit
  // override is assumed intentional (e.g. pointed at a mounted volume).
  isPersistent = true;
} else if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  dbPath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite');
  isPersistent = true;
} else {
  dbPath = path.join(__dirname, 'database.sqlite');
  isPersistent = false;
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

/** Converts a plain object like {userId: 5} into sql.js's expected
 *  {"@userId": 5} named-parameter binding format. Values are left as-is;
 *  undefined is coerced to null since sqlite bindings reject undefined. */
function toNamedBinding(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[`@${key}`] = value === undefined ? null : value;
  }
  return out;
}

function toPositionalBinding(args) {
  return args.map((v) => (v === undefined ? null : v));
}

class PreparedStatement {
  constructor(db, sql) {
    this.db = db; // the owning SqlJsDatabase, so we can check transaction depth
    this.sql = sql;
  }

  _bind(args) {
    const stmt = this.db.raw.prepare(this.sql);
    if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      stmt.bind(toNamedBinding(args[0]));
    } else if (args.length > 0) {
      stmt.bind(toPositionalBinding(args));
    }
    return stmt;
  }

  get(...args) {
    const stmt = this._bind(args);
    let row;
    try {
      row = stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
    return row;
  }

  all(...args) {
    const stmt = this._bind(args);
    const rows = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  run(...args) {
    const stmt = this._bind(args);
    try {
      stmt.step();
    } finally {
      stmt.free();
    }
    const idRow = this.db.raw.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = idRow.length ? idRow[0].values[0][0] : undefined;
    const changes = this.db.raw.getRowsModified();
    // Only persist immediately when this write is NOT part of an explicit
    // transaction -- persisting mid-transaction is what corrupts state (see
    // note above). Transactional writes are flushed once at COMMIT instead.
    if (this.db.txDepth === 0) this.db.persistToDisk();
    return { lastInsertRowid, changes };
  }
}

class SqlJsDatabase {
  constructor(rawDb, persistFn) {
    this.raw = rawDb;
    this.txDepth = 0;
    this.persistToDisk = persistFn;
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  /** Runs one or more semicolon-separated statements (used for schema.sql). */
  exec(sql) {
    const result = this.raw.exec(sql);
    if (this.txDepth === 0) this.persistToDisk();
    return result;
  }

  pragma(clause) {
    this.raw.exec(`PRAGMA ${clause}`);
  }

  /** Mirrors better-sqlite3's db.transaction(fn) -- returns a callable that
   *  wraps fn in BEGIN/COMMIT, rolling back on any thrown error. Nested
   *  calls (a transaction started while already inside one) just run fn
   *  inline, relying on the outermost transaction for atomicity/persist. */
  transaction(fn) {
    return (...args) => {
      const isOutermost = this.txDepth === 0;
      if (isOutermost) this.raw.exec('BEGIN');
      this.txDepth++;

      let result;
      try {
        result = fn(...args);
      } catch (err) {
        this.txDepth--;
        if (isOutermost) {
          try { this.raw.exec('ROLLBACK'); } catch (rollbackErr) { /* already closed */ }
        }
        throw err;
      }

      this.txDepth--;
      if (isOutermost) {
        this.raw.exec('COMMIT');
        this.persistToDisk();
      }
      return result;
    };
  }
}

let readyPromise = null;
let instance = null;
// Set during init(); swaps the live in-memory sql.js database for the one in
// the provided Buffer and points the persistence closure at the new instance.
// Used only by the guarded, temporary /__import-db route in server.js.
let reloadInternal = null;

function requireReady() {
  if (!instance) {
    throw new Error('Database not initialized yet. init() must be awaited at server startup before any request is handled.');
  }
  return instance;
}

/** Must be awaited once at server startup before any request handling. */
function init() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const SQL = await initSqlJs({
      // Locate the .wasm file that ships inside the sql.js package itself --
      // no network fetch, no build step.
      locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });

    let rawDb;
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      rawDb = new SQL.Database(fileBuffer);
    } else {
      rawDb = new SQL.Database();
    }
    rawDb.exec('PRAGMA foreign_keys = ON');

    const persistToDisk = () => {
      const data = rawDb.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    };

    instance = new SqlJsDatabase(rawDb, persistToDisk);
    reloadInternal = (bytes) => {
      if (instance.txDepth !== 0) {
        throw new Error('Cannot reload the database while a transaction is open.');
      }
      const fresh = new SQL.Database(bytes);
      fresh.exec('PRAGMA foreign_keys = ON');
      rawDb = fresh;
      instance.raw = fresh;
      // Persist immediately: without this, the swapped-in database lives only
      // in memory and the next process restart would reload the old file.
      persistToDisk();
    };
    return instance;
  })();

  return readyPromise;
}

// Every controller/service does `const db = require('../database/db')` once
// at module load time (before init() has necessarily resolved) and then
// calls db.prepare(...)/db.exec(...) later, inside request handlers -- by
// which point server.js has already awaited init(). So this exported object
// stays a stable reference whose methods simply delegate to the real
// sql.js-backed instance at call time, not at require time.
module.exports = {
  init,
  prepare: (sql) => requireReady().prepare(sql),
  exec: (sql) => requireReady().exec(sql),
  pragma: (clause) => requireReady().pragma(clause),
  transaction: (fn) => requireReady().transaction(fn),
  reloadFromBuffer: (bytes) => {
    if (!reloadInternal) throw new Error('Database not initialized yet.');
    reloadInternal(bytes);
  },
  get dbPath() { return dbPath; },
  get isPersistent() { return isPersistent; },
};
