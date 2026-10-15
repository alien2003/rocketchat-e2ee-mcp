/**
 * Typed access to the index. All writes are upserts (`ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`, which
 * would bypass the FTS delete trigger).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { KeyStatus } from '../e2ee/keyring.ts';
import type { DecryptionInfo } from '../e2ee/message.ts';

export type RoomType = 'c' | 'p' | 'd' | 'l' | string;

export interface RoomRecord {
  rid: string;
  t: RoomType;
  name: string | null;
  fname: string | null;
  displayName: string;
  encrypted: boolean;
  keyStatus: KeyStatus | 'not-encrypted' | 'e2ee-unavailable' | null;
  keyDetail: string | null;
  topic: string | null;
  archived: boolean;
  lastMessageAt: string | null;
  updatedAt: string | null;
}

/** Attachment metadata as stored: decrypted, but with per-file keys removed. */
export interface StoredAttachment {
  title?: string;
  type?: string;
  description?: string;
  text?: string;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  encrypted?: boolean;
  imageDimensions?: { width: number; height: number };
  /** Quote attachments: who/what was quoted. */
  authorName?: string;
  messageLink?: string;
}

export interface MessageRecord {
  id: string;
  rid: string;
  tmid: string | null;
  t: string | null;
  ts: string;
  updatedAt: string | null;
  editedAt: string | null;
  userId: string | null;
  username: string | null;
  userName: string | null;
  text: string;
  encrypted: boolean;
  decryption: DecryptionInfo;
  attachments: StoredAttachment[];
  file: { id: string; name?: string; type?: string; size?: number } | null;
  tcount: number | null;
  /** Raw (still encrypted) document; persisted only while the message is undecryptable, for later retry. */
  raw?: unknown;
}

export interface SyncState {
  rid: string;
  backfillCursor: string | null;
  backfillDone: boolean;
  updatedCursor: number | null;
  deletedCursor: number | null;
  lastSyncAt: string | null;
}

export interface SearchFilters {
  rids?: string[];
  usernames?: string[];
  after?: string;
  before?: string;
  threadId?: string;
  limit?: number;
}

export interface SearchHit {
  message: MessageRecord;
  snippet: string;
  rank: number;
}

type Row = Record<string, SQLInputValue>;

const SYSTEM_TYPES_WITH_TEXT = new Set([
  undefined,
  null,
  '',
  'e2e',
  'message_pinned_e2e',
  'message_pinned',
  'discussion-created',
]);

export function isSearchableType(t: string | null | undefined): boolean {
  return SYSTEM_TYPES_WITH_TEXT.has(t ?? undefined);
}

function toRoom(r: Row): RoomRecord {
  return {
    rid: String(r.rid),
    t: String(r.t),
    name: (r.name as string | null) ?? null,
    fname: (r.fname as string | null) ?? null,
    displayName: String(r.display_name),
    encrypted: Boolean(r.encrypted),
    keyStatus: (r.key_status as RoomRecord['keyStatus']) ?? null,
    keyDetail: (r.key_detail as string | null) ?? null,
    topic: (r.topic as string | null) ?? null,
    archived: Boolean(r.archived),
    lastMessageAt: (r.last_message_at as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
  };
}

function toMessage(r: Row): MessageRecord {
  const state = String(r.decryption_state) as DecryptionInfo['state'];
  let decryption: DecryptionInfo;
  if (state === 'undecryptable') {
    decryption = {
      state,
      reason: String(r.failure_reason) as never,
      detail: String(r.failure_detail ?? ''),
      ...(r.kid ? { kid: String(r.kid) } : {}),
    };
  } else if (state === 'decrypted') {
    const [codec = '', keySource = 'current'] = String(r.failure_detail ?? '').split('|');
    decryption = { state, codec, kid: String(r.kid ?? ''), keySource: keySource as never };
  } else {
    decryption = { state: 'plaintext' };
  }
  return {
    id: String(r.id),
    rid: String(r.rid),
    tmid: (r.tmid as string | null) ?? null,
    t: (r.t as string | null) ?? null,
    ts: String(r.ts),
    updatedAt: (r.updated_at as string | null) ?? null,
    editedAt: (r.edited_at as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    userName: (r.user_name as string | null) ?? null,
    text: String(r.text ?? ''),
    encrypted: Boolean(r.encrypted),
    decryption,
    attachments: r.attachments_json ? (JSON.parse(String(r.attachments_json)) as StoredAttachment[]) : [],
    file: r.file_json ? (JSON.parse(String(r.file_json)) as MessageRecord['file']) : null,
    tcount: (r.tcount as number | null) ?? null,
  };
}

/** Builds an FTS5 query from free text: every token must match (AND); `foo*` keeps prefix matching. */
export function toFtsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}_*'-]+/gu) ?? [];
  return tokens
    .map((tok) => {
      const prefix = tok.endsWith('*');
      const clean = tok.replace(/\*+$/, '').replace(/"/g, '');
      if (!clean) return '';
      return prefix ? `"${clean}"*` : `"${clean}"`;
    })
    .filter(Boolean)
    .join(' ');
}

export class IndexStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertRoom(room: RoomRecord): void {
    this.db
      .prepare(
        `INSERT INTO rooms (rid, t, name, fname, display_name, encrypted, key_status, key_detail, topic, archived,
                            last_message_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rid) DO UPDATE SET t = excluded.t, name = excluded.name, fname = excluded.fname,
           display_name = excluded.display_name, encrypted = excluded.encrypted, key_status = excluded.key_status,
           key_detail = excluded.key_detail, topic = excluded.topic, archived = excluded.archived,
           last_message_at = excluded.last_message_at, updated_at = excluded.updated_at`,
      )
      .run(
        room.rid,
        room.t,
        room.name,
        room.fname,
        room.displayName,
        room.encrypted ? 1 : 0,
        room.keyStatus,
        room.keyDetail,
        room.topic,
        room.archived ? 1 : 0,
        room.lastMessageAt,
        room.updatedAt,
      );
  }

  /** Removes rooms the user is no longer subscribed to (and their messages). */
  retainRooms(rids: string[]): string[] {
    const existing = this.listRooms().map((r) => r.rid);
    const keep = new Set(rids);
    const gone = existing.filter((rid) => !keep.has(rid));
    for (const rid of gone) this.deleteRoom(rid);
    return gone;
  }

  deleteRoom(rid: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE rid = ?').run(rid);
      this.db.prepare('DELETE FROM sync_state WHERE rid = ?').run(rid);
      this.db.prepare('DELETE FROM rooms WHERE rid = ?').run(rid);
    });
  }

  getRoom(rid: string): RoomRecord | undefined {
    const r = this.db.prepare('SELECT * FROM rooms WHERE rid = ?').get(rid) as Row | undefined;
    return r ? toRoom(r) : undefined;
  }

  listRooms(): RoomRecord[] {
    return (
      this.db.prepare('SELECT * FROM rooms ORDER BY last_message_at DESC NULLS LAST, display_name').all() as Row[]
    ).map(toRoom);
  }

  /** Resolves a room by id, name, fname, display name or `@username` for DMs (case-insensitive). */
  findRoom(ref: string): RoomRecord | undefined {
    const byId = this.getRoom(ref);
    if (byId) return byId;
    const needle = ref.replace(/^[#@]/, '').toLowerCase();
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM rooms WHERE lower(name) = ? OR lower(fname) = ? OR lower(display_name) = ?
         ORDER BY last_message_at DESC NULLS LAST`,
        )
        .all(needle, needle, needle) as Row[]
    ).map(toRoom);
    return rows[0];
  }

  getSyncState(rid: string): SyncState | undefined {
    const r = this.db.prepare('SELECT * FROM sync_state WHERE rid = ?').get(rid) as Row | undefined;
    if (!r) return undefined;
    return {
      rid,
      backfillCursor: (r.backfill_cursor as string | null) ?? null,
      backfillDone: Boolean(r.backfill_done),
      updatedCursor: (r.updated_cursor as number | null) ?? null,
      deletedCursor: (r.deleted_cursor as number | null) ?? null,
      lastSyncAt: (r.last_sync_at as string | null) ?? null,
    };
  }

  saveSyncState(s: SyncState): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (rid, backfill_cursor, backfill_done, updated_cursor, deleted_cursor, last_sync_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (rid) DO UPDATE SET backfill_cursor = excluded.backfill_cursor,
           backfill_done = excluded.backfill_done, updated_cursor = excluded.updated_cursor,
           deleted_cursor = excluded.deleted_cursor, last_sync_at = excluded.last_sync_at`,
      )
      .run(s.rid, s.backfillCursor, s.backfillDone ? 1 : 0, s.updatedCursor, s.deletedCursor, s.lastSyncAt);
  }

  resetRoomMessages(rid: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE rid = ?').run(rid);
      this.db.prepare('DELETE FROM sync_state WHERE rid = ?').run(rid);
    });
  }

  /** Returns 'inserted' | 'updated' | 'unchanged'. */
  upsertMessage(m: MessageRecord): 'inserted' | 'updated' | 'unchanged' {
    const existing = this.db
      .prepare('SELECT updated_at, text, decryption_state FROM messages WHERE id = ?')
      .get(m.id) as Row | undefined;
    const searchText = isSearchableType(m.t)
      ? [...new Set([m.text, ...m.attachments.flatMap((a) => [a.title, a.description, a.text, a.fileName])])]
          .filter(Boolean)
          .join('\n')
      : '';
    const decryptionDetail =
      m.decryption.state === 'undecryptable'
        ? m.decryption.detail
        : m.decryption.state === 'decrypted'
          ? `${m.decryption.codec}|${m.decryption.keySource}`
          : null;
    this.db
      .prepare(
        `INSERT INTO messages (id, rid, tmid, t, ts, updated_at, edited_at, user_id, username, user_name, text, encrypted,
                               decryption_state, failure_reason, failure_detail, kid, attachments_json, file_json,
                               tcount, search_text, pending_raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET rid = excluded.rid, tmid = excluded.tmid, t = excluded.t, ts = excluded.ts,
           updated_at = excluded.updated_at, edited_at = excluded.edited_at, user_id = excluded.user_id,
           username = excluded.username, user_name = excluded.user_name, text = excluded.text,
           encrypted = excluded.encrypted, decryption_state = excluded.decryption_state,
           failure_reason = excluded.failure_reason, failure_detail = excluded.failure_detail, kid = excluded.kid,
           attachments_json = excluded.attachments_json, file_json = excluded.file_json, tcount = excluded.tcount,
           search_text = excluded.search_text, pending_raw = excluded.pending_raw`,
      )
      .run(
        m.id,
        m.rid,
        m.tmid,
        m.t,
        m.ts,
        m.updatedAt,
        m.editedAt,
        m.userId,
        m.username,
        m.userName,
        m.text,
        m.encrypted ? 1 : 0,
        m.decryption.state,
        m.decryption.state === 'undecryptable' ? m.decryption.reason : null,
        decryptionDetail,
        m.decryption.state === 'plaintext' ? null : (m.decryption.kid ?? null),
        m.attachments.length ? JSON.stringify(m.attachments) : null,
        m.file ? JSON.stringify(m.file) : null,
        m.tcount,
        searchText,
        m.decryption.state === 'undecryptable' && m.raw !== undefined ? JSON.stringify(m.raw) : null,
      );
    if (!existing) return 'inserted';
    const changed =
      existing.updated_at !== m.updatedAt ||
      existing.text !== m.text ||
      existing.decryption_state !== m.decryption.state;
    return changed ? 'updated' : 'unchanged';
  }

  /** Undecryptable messages of a room with their raw encrypted documents (for retry when keys change). */
  pendingUndecryptable(rid: string): { id: string; kid: string | null; raw: unknown }[] {
    return (
      this.db
        .prepare('SELECT id, kid, pending_raw FROM messages WHERE rid = ? AND pending_raw IS NOT NULL')
        .all(rid) as Row[]
    ).map((r) => ({ id: String(r.id), kid: (r.kid as string | null) ?? null, raw: JSON.parse(String(r.pending_raw)) }));
  }

  deleteMessage(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes) > 0;
  }

  getMessage(id: string): MessageRecord | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  /** Messages of a room, newest first, excluding thread replies unless `includeThreads`. */
  listMessages(
    rid: string,
    opts: { before?: string; after?: string; limit?: number; includeThreads?: boolean } = {},
  ): MessageRecord[] {
    const clauses = ['rid = ?'];
    const params: SQLInputValue[] = [rid];
    if (!opts.includeThreads) clauses.push('tmid IS NULL');
    if (opts.before) {
      clauses.push('ts < ?');
      params.push(opts.before);
    }
    if (opts.after) {
      clauses.push('ts >= ?');
      params.push(opts.after);
    }
    params.push(opts.limit ?? 50);
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
        .all(...params) as Row[]
    ).map(toMessage);
  }

  threadMessages(tmid: string, limit = 500): MessageRecord[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE tmid = ? ORDER BY ts ASC LIMIT ?').all(tmid, limit) as Row[]
    ).map(toMessage);
  }

  countMessages(rid?: string): { total: number; undecryptable: number } {
    const row = (
      rid
        ? this.db
            .prepare(
              "SELECT count(*) AS total, sum(decryption_state = 'undecryptable') AS bad FROM messages WHERE rid = ?",
            )
            .get(rid)
        : this.db
            .prepare("SELECT count(*) AS total, sum(decryption_state = 'undecryptable') AS bad FROM messages")
            .get()
    ) as Row;
    return { total: Number(row.total ?? 0), undecryptable: Number(row.bad ?? 0) };
  }

  search(query: string, filters: SearchFilters = {}): SearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const clauses = ['messages_fts MATCH ?'];
    const params: SQLInputValue[] = [fts];
    if (filters.rids?.length) {
      clauses.push(`m.rid IN (${filters.rids.map(() => '?').join(', ')})`);
      params.push(...filters.rids);
    }
    if (filters.usernames?.length) {
      clauses.push(`lower(m.username) IN (${filters.usernames.map(() => '?').join(', ')})`);
      params.push(...filters.usernames.map((u) => u.replace(/^@/, '').toLowerCase()));
    }
    if (filters.after) {
      clauses.push('m.ts >= ?');
      params.push(filters.after);
    }
    if (filters.before) {
      clauses.push('m.ts < ?');
      params.push(filters.before);
    }
    if (filters.threadId) {
      clauses.push('(m.tmid = ? OR m.id = ?)');
      params.push(filters.threadId, filters.threadId);
    }
    params.push(filters.limit ?? 20);
    const rows = this.db
      .prepare(
        `SELECT m.*, snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet, bm25(messages_fts) AS rank
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE ${clauses.join(' AND ')}
         ORDER BY rank LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({ message: toMessage(r), snippet: String(r.snippet ?? ''), rank: Number(r.rank) }));
  }

  stats(): { rooms: number; messages: number; undecryptable: number } {
    const rooms = Number((this.db.prepare('SELECT count(*) AS n FROM rooms').get() as Row).n);
    return { rooms, ...(({ total, undecryptable }) => ({ messages: total, undecryptable }))(this.countMessages()) };
  }

  close(): void {
    this.db.close();
  }
}
