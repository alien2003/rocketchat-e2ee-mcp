/**
 * SQLite (node:sqlite, FTS5) storage for decrypted messages. See ADR 0001 §2 and §8.
 *
 * The database holds PLAINTEXT of encrypted rooms. It lives in a 0700 directory with 0600 files, or entirely in
 * memory when ephemeral. It never stores the E2EE password, the private key, room keys or per-file keys.
 */
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../logger.ts';

const log = createLogger({ name: 'index' });

export const DB_FILENAME = 'index.sqlite';
const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE rooms (
      rid TEXT PRIMARY KEY,
      t TEXT NOT NULL,
      name TEXT,
      fname TEXT,
      display_name TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      key_status TEXT,
      key_detail TEXT,
      topic TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE sync_state (
      rid TEXT PRIMARY KEY,
      backfill_cursor TEXT,
      backfill_done INTEGER NOT NULL DEFAULT 0,
      updated_cursor INTEGER,
      deleted_cursor INTEGER,
      last_sync_at TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      rid TEXT NOT NULL,
      tmid TEXT,
      t TEXT,
      ts TEXT NOT NULL,
      updated_at TEXT,
      edited_at TEXT,
      user_id TEXT,
      username TEXT,
      user_name TEXT,
      text TEXT NOT NULL DEFAULT '',
      encrypted INTEGER NOT NULL DEFAULT 0,
      decryption_state TEXT NOT NULL,
      failure_reason TEXT,
      failure_detail TEXT,
      kid TEXT,
      attachments_json TEXT,
      file_json TEXT,
      tcount INTEGER,
      search_text TEXT NOT NULL DEFAULT '',
      -- raw ciphertext document, kept only while undecryptable so it can be retried when keys arrive
      pending_raw TEXT
    );
    CREATE INDEX messages_rid_ts ON messages (rid, ts);
    CREATE INDEX messages_tmid_ts ON messages (tmid, ts);
    CREATE INDEX messages_username ON messages (username);
    CREATE INDEX messages_pending ON messages (rid) WHERE pending_raw IS NOT NULL;
    CREATE VIRTUAL TABLE messages_fts USING fts5 (
      search_text,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, search_text) VALUES (new.rowid, new.search_text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
      INSERT INTO messages_fts (rowid, search_text) VALUES (new.rowid, new.search_text);
    END;
  `,
};

export interface OpenOptions {
  dataDir: string;
  ephemeral: boolean;
}

export interface OpenedDatabase {
  db: DatabaseSync;
  path: string | undefined;
}

/** Ensures `dir` exists and is private (0700). Returns a warning when it already existed with wider perms. */
export function ensurePrivateDir(dir: string): string | undefined {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return undefined;
  }
  if (process.platform === 'win32') return undefined;
  const mode = statSync(dir).mode & 0o777;
  if (mode & 0o077) {
    chmodSync(dir, 0o700);
    return `tightened permissions of ${dir} from ${mode.toString(8)} to 700`;
  }
  return undefined;
}

export function openDatabase(options: OpenOptions): OpenedDatabase {
  let path: string | undefined;
  let db: DatabaseSync;
  if (options.ephemeral) {
    db = new DatabaseSync(':memory:');
  } else {
    const warning = ensurePrivateDir(options.dataDir);
    if (warning) log.warn(warning);
    path = join(options.dataDir, DB_FILENAME);
    db = new DatabaseSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (!options.ephemeral) db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return { db, path };
}

function migrate(db: DatabaseSync): void {
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  let version = 0;
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    version = row ? Number(row.value) : 0;
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(`index schema v${version} is newer than this rc-mcp (v${SCHEMA_VERSION}); run \`rc-mcp purge\``);
  }
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(v));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
