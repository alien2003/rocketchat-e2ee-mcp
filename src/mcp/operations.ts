/**
 * Read-only operations behind the MCP tools and the CLI. Each returns plain JSON-serialisable data.
 *
 * Read paths prefer the local index and treat network work as optional (`app.soft`): when Rocket.Chat is
 * unreachable they answer from the index and say so in `notes` instead of failing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { decryptFile, type FileEncryption } from '../e2ee/file.ts';
import { decryptMessage } from '../e2ee/message.ts';
import { convertMessage } from '../index/convert.ts';
import type { MessageRecord, RoomRecord } from '../index/store.ts';
import type { SyncReport } from '../index/sync.ts';
import type { Message, Upload } from '../rc-api/schemas.ts';
import { formatMessage, formatRoom, parseMessageRef, REASON_HINTS } from './format.ts';

export class ToolError extends Error {
  override name = 'ToolError';
  readonly code: string;
  readonly hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const ROOM_STALE_MS = 60_000;
/** Messages backfilled per sync call when the caller does not say otherwise (MCP calls must stay bounded). */
export const DEFAULT_SYNC_CHUNK = 2000;
/** Rate-limit budget for best-effort calls (server search): skip rather than stall a tool call. */
const OPTIONAL_CALL_WAIT_MS = 2000;
/** Marker that identifies a directory rc-mcp created (purge only deletes marked directories). */
export const FILES_MARKER = '.rc-mcp-files';

/** Validates an ISO-8601 date/date-time argument and normalises it to the stored format (UTC, ms, Z). */
export function normalizeDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ToolError(
      'invalid-argument',
      `${field} must be an ISO-8601 date or date-time (got "${value}")`,
      'Examples: "2026-03-01", "2026-03-01T12:00:00Z", "2026-03-01T14:00:00+02:00".',
    );
  }
  return new Date(ms).toISOString();
}

// ----------------------------------------------------------------------------------------------- rooms

/** Refreshes rooms when possible; returns a note when serving from a stale index instead. */
async function refreshSoft(app: App, maxAgeMs = ROOM_STALE_MS): Promise<string[]> {
  if (!app.hasLocalData) {
    await app.refreshRooms(maxAgeMs); // nothing local to fall back to: surface the real error
    return [];
  }
  const r = await app.soft('refresh the room list', () => app.refreshRooms(maxAgeMs));
  return r.ok ? [] : [r.note];
}

export async function resolveRoom(app: App, ref: string, notes: string[] = []): Promise<RoomRecord> {
  notes.push(...(await refreshSoft(app)));
  let room = app.store.findRoom(ref);
  if (!room && notes.length === 0) {
    notes.push(...(await refreshSoft(app, 0)));
    room = app.store.findRoom(ref);
  }
  if (!room) {
    throw new ToolError(
      'room-not-found',
      `No room matching "${ref}" among the rooms this account is subscribed to.`,
      'Call list_rooms to see room ids and names.',
    );
  }
  return room;
}

export async function listRooms(
  app: App,
  args: {
    filter?: string;
    type?: 'all' | 'channel' | 'private-group' | 'direct-message';
    encrypted_only?: boolean;
    limit?: number;
  },
) {
  const notes = await refreshSoft(app, args.filter ? ROOM_STALE_MS : 15_000);
  const session = await app.soft('unlock E2EE keys', () => app.session());
  const typeMap = { channel: 'c', 'private-group': 'p', 'direct-message': 'd' } as const;
  const needle = args.filter?.toLowerCase();
  const rooms = app.store
    .listRooms()
    .filter((r) => !args.type || args.type === 'all' || r.t === typeMap[args.type])
    .filter((r) => !args.encrypted_only || r.encrypted)
    .filter((r) => !needle || `${r.displayName} ${r.name ?? ''} ${r.topic ?? ''}`.toLowerCase().includes(needle))
    .slice(0, args.limit ?? 200);
  const e2ee = !session.ok
    ? 'unknown (offline)'
    : session.value.state.status === 'ready'
      ? 'unlocked'
      : { status: 'unavailable', reason: session.value.state.reason, hint: REASON_HINTS[session.value.state.reason] };
  return {
    e2ee,
    count: rooms.length,
    rooms: rooms.map((r) => {
      const sync = app.store.getSyncState(r.rid);
      const counts = app.store.countMessages(r.rid);
      return formatRoom(r, {
        indexed_messages: counts.total,
        ...(counts.undecryptable ? { undecryptable_messages: counts.undecryptable } : {}),
        history_complete: Boolean(sync?.backfillDone),
        last_synced: sync?.lastSyncAt ?? null,
      });
    }),
    ...(notes.length ? { notes } : {}),
  };
}

// ----------------------------------------------------------------------------------------------- sync

export async function syncRooms(
  app: App,
  args: { room?: string; full?: boolean; max_messages?: number; unbounded?: boolean },
) {
  const syncer = await app.syncer();
  const maxMessages = args.unbounded ? undefined : (args.max_messages ?? DEFAULT_SYNC_CHUNK);
  let reports: SyncReport[];
  if (args.room) {
    const room = await resolveRoom(app, args.room);
    reports = [await syncer.syncRoom(room.rid, { full: args.full ?? false, ...(maxMessages ? { maxMessages } : {}) })];
  } else {
    reports = await syncer.syncAll({
      full: args.full ?? false,
      skipUnchanged: !args.full,
      ...(maxMessages ? { maxMessages } : {}),
    });
    app.lastGlobalSyncAt = Date.now();
  }
  const changed = reports.filter((r) => r.inserted || r.updated || r.deleted || r.error || !r.backfillComplete);
  return {
    rooms_checked: reports.length,
    totals: {
      new: reports.reduce((n, r) => n + r.inserted, 0),
      updated: reports.reduce((n, r) => n + r.updated, 0),
      deleted: reports.reduce((n, r) => n + r.deleted, 0),
      undecryptable: reports.reduce((n, r) => n + r.undecryptable, 0),
    },
    rooms: changed.map((r) => ({
      room: r.room,
      room_id: r.rid,
      new: r.inserted,
      updated: r.updated,
      deleted: r.deleted,
      ...(r.undecryptable ? { undecryptable: r.undecryptable } : {}),
      history_complete: r.backfillComplete,
      ...(r.fullResync ? { full_resync: true } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
    ...(reports.some((r) => !r.backfillComplete && !r.error)
      ? { note: 'Some rooms have older history not yet indexed; call sync again to continue.' }
      : {}),
    failed_rooms: reports.filter((r) => r.error).length,
    unchanged_rooms: reports.length - changed.length,
  };
}

/** Oldest timestamp (ms) from which the index holds a room's history contiguously, or -Infinity when complete. */
function completeFrom(app: App, rid: string): number {
  const s = app.store.getSyncState(rid);
  if (!s) return Number.POSITIVE_INFINITY;
  if (s.backfillDone) return Number.NEGATIVE_INFINITY;
  // The backfill cursor overlaps by 1 ms, so everything at or after cursor - 1 has been fetched.
  return s.backfillCursor ? Number(s.backfillCursor) - 1 : Number.POSITIVE_INFINITY;
}

/**
 * Brings a room up to date (one incremental call when stale) and backfills older history until the requested
 * window lies entirely inside the contiguously indexed range. Returns notes when network work had to be skipped.
 */
async function ensureWindow(
  app: App,
  room: RoomRecord,
  window: { limit: number; before?: string | undefined; includeThreads: boolean },
): Promise<string[]> {
  const notes: string[] = [];
  const s = app.store.getSyncState(room.rid);
  const stale = !s?.lastSyncAt || Date.now() - Date.parse(s.lastSyncAt) > ROOM_STALE_MS;
  if (stale) {
    const r = await app.soft(`sync ${room.displayName}`, async () =>
      (await app.syncer()).syncRoom(room.rid, { maxMessages: Math.max(window.limit * 2, 200) }),
    );
    if (!r.ok) return [r.note];
  }
  for (let i = 0; i < 25; i++) {
    const frontier = completeFrom(app, room.rid);
    if (frontier === Number.NEGATIVE_INFINITY) break;
    const rows = app.store.listMessages(room.rid, {
      ...(window.before ? { before: window.before } : {}),
      limit: window.limit + 1,
      includeThreads: window.includeThreads,
    });
    const oldest = rows.at(-1);
    if (rows.length > window.limit && oldest && Date.parse(oldest.ts) >= frontier) break;
    const gap = window.before ? Math.max(0, Date.parse(window.before) - frontier) : 0;
    const r = await app.soft(`load older history of ${room.displayName}`, async () =>
      (await app.syncer()).syncRoom(room.rid, {
        skipIncremental: true,
        maxMessages: Math.max(window.limit * 2, gap > 0 ? 1000 : 200),
      }),
    );
    if (!r.ok) {
      notes.push(r.note);
      break;
    }
  }
  return notes;
}

// ----------------------------------------------------------------------------------------------- messages

export async function getMessages(
  app: App,
  args: { room: string; before?: string; after?: string; limit?: number; include_thread_replies?: boolean },
) {
  const notes: string[] = [];
  const room = await resolveRoom(app, args.room, notes);
  const before = normalizeDate(args.before, 'before');
  const after = normalizeDate(args.after, 'after');
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 200);
  const includeThreads = args.include_thread_replies ?? false;
  notes.push(...(await ensureWindow(app, room, { limit, before, includeThreads })));
  const frontier = completeFrom(app, room.rid);
  const rows = app.store
    .listMessages(room.rid, {
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      limit: limit + 1,
      includeThreads,
    })
    // Never serve rows from beyond the contiguous range: they would make the page look complete when it is not.
    .filter((m) => Date.parse(m.ts) >= frontier);
  const page = rows.slice(0, limit).reverse();
  const hasOlder = rows.length > limit || frontier !== Number.NEGATIVE_INFINITY;
  if (frontier !== Number.NEGATIVE_INFINITY && rows.length <= limit && !notes.length) {
    notes.push('Older history of this room is not indexed yet; call again with before=older_than_cursor or run sync.');
  }
  return {
    room: formatRoom(room),
    order: 'oldest-first',
    count: page.length,
    has_older: hasOlder,
    ...(page[0] ? { older_than_cursor: page[0].ts } : {}),
    messages: page.map((m) => formatMessage(m, room, app.siteUrl)),
    ...(notes.length ? { notes } : {}),
  };
}

/** Local copy first; otherwise fetch, decrypt and (for subscribed rooms) index it. */
async function fetchMessage(app: App, id: string): Promise<MessageRecord> {
  const local = app.store.getMessage(id);
  if (local) return local;
  const res = await app.client.get('chat.getMessage', { msgId: id });
  if (res.message._hidden) throw new ToolError('message-deleted', `Message ${id} was deleted.`);
  const syncer = await app.syncer();
  const keyring = await syncer.keyringFor(res.message.rid).catch(() => undefined);
  const { record, deleted } = await convertMessage(res.message, keyring);
  if (deleted) throw new ToolError('message-deleted', `Message ${id} was deleted.`);
  if (app.store.getRoom(record.rid)) app.store.upsertMessage(record);
  return record;
}

export async function getMessage(app: App, args: { id?: string; url?: string; resolve_quotes?: boolean }) {
  const ref = args.url ? parseMessageRef(args.url) : args.id ? parseMessageRef(args.id) : {};
  const id = ref.messageId ?? ref.threadId;
  if (!id) {
    throw new ToolError('invalid-argument', 'Provide a message id or a Rocket.Chat message URL (…?msg=<id>).');
  }
  const notes = await refreshSoft(app);
  const message = await fetchMessage(app, id);
  const room = app.store.getRoom(message.rid);
  const formatted = formatMessage(message, room, app.siteUrl);
  const quoted = [];
  if (args.resolve_quotes !== false) {
    for (const q of formatted.quotes ?? []) {
      try {
        const qm = await fetchMessage(app, q.message_id);
        quoted.push(formatMessage(qm, app.store.getRoom(qm.rid), app.siteUrl));
      } catch {
        quoted.push({ id: q.message_id, unavailable: true });
      }
    }
  }
  return {
    message: formatted,
    ...(quoted.length ? { quoted_messages: quoted } : {}),
    ...(message.tcount ? { note: `This message starts a thread with ${message.tcount} replies; use get_thread.` } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

export async function getThread(app: App, args: { thread_id?: string; url?: string; limit?: number }) {
  const ref = args.url ? parseMessageRef(args.url) : args.thread_id ? parseMessageRef(args.thread_id) : {};
  const id = ref.threadId ?? ref.messageId;
  if (!id) throw new ToolError('invalid-argument', 'Provide thread_id (the root message id) or a thread URL.');
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000);
  const notes = await refreshSoft(app);
  let root = await fetchMessage(app, id);
  if (root.tmid) root = await fetchMessage(app, root.tmid); // a reply was given: use its thread
  const room = app.store.getRoom(root.rid);
  if (room) {
    const s = app.store.getSyncState(room.rid);
    if (!s?.lastSyncAt || Date.now() - Date.parse(s.lastSyncAt) > ROOM_STALE_MS) {
      const r = await app.soft(`sync ${room.displayName}`, async () =>
        (await app.syncer()).syncRoom(room.rid, { skipBackfill: Boolean(s?.updatedCursor), maxMessages: 200 }),
      );
      if (!r.ok) notes.push(r.note);
    }
    root = app.store.getMessage(root.id) ?? root;
  }
  const byId = new Map(app.store.threadMessages(root.id, 100_000).map((m) => [m.id, m]));
  if ((root.tcount ?? 0) > byId.size) {
    // Not all replies are indexed (old thread or a room this account does not index): fetch the thread.
    const r = await app.soft('fetch the thread', async () => {
      const keyring = await (await app.syncer()).keyringFor(root.rid).catch(() => undefined);
      for (let offset = 0; ; ) {
        const res = await app.client.get('chat.getThreadMessages', { tmid: root.id, count: 100, offset });
        for (const raw of res.messages) {
          const { record, deleted } = await convertMessage(raw as Message, keyring);
          if (deleted) continue;
          byId.set(record.id, record);
          if (room) app.store.upsertMessage(record);
        }
        offset += res.messages.length;
        if (res.messages.length < 100 || offset >= (res.total ?? offset)) break;
      }
    });
    if (!r.ok) notes.push(r.note);
  }
  const replies = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const shown = replies.slice(0, limit);
  return {
    room: room ? formatRoom(room) : { id: root.rid },
    root: formatMessage(root, room, app.siteUrl),
    total_replies: Math.max(root.tcount ?? 0, replies.length),
    returned: shown.length,
    ...(shown.length < replies.length ? { truncated: true } : {}),
    replies: shown.map((m) => formatMessage(m, room, app.siteUrl)),
    ...(notes.length ? { notes } : {}),
  };
}

// ----------------------------------------------------------------------------------------------- search

export async function search(
  app: App,
  args: {
    query: string;
    rooms?: string[];
    from?: string[];
    after?: string;
    before?: string;
    thread_id?: string;
    limit?: number;
    include_server_search?: boolean;
    refresh?: boolean;
  },
) {
  const notes: string[] = [];
  const after = normalizeDate(args.after, 'after');
  const before = normalizeDate(args.before, 'before');
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const refresh = args.refresh !== false;
  const rooms = args.rooms?.length
    ? await Promise.all(
        args.rooms.map((r) => (refresh ? resolveRoom(app, r, notes) : Promise.resolve(app.store.findRoom(r)))),
      )
    : undefined;
  if (rooms?.some((r) => !r)) {
    throw new ToolError('room-not-found', 'One of the rooms is not in the local index.', 'Call list_rooms first.');
  }
  const scoped = rooms as RoomRecord[] | undefined;

  if (refresh) {
    if (scoped) {
      for (const room of scoped) {
        const s = app.store.getSyncState(room.rid);
        if (!s?.lastSyncAt || Date.now() - Date.parse(s.lastSyncAt) > ROOM_STALE_MS) {
          const r = await app.soft(`sync ${room.displayName}`, async () =>
            (await app.syncer()).syncRoom(room.rid, { maxMessages: DEFAULT_SYNC_CHUNK }),
          );
          if (!r.ok) notes.push(r.note);
        }
      }
    } else if (Date.now() - app.lastGlobalSyncAt > 5 * 60_000) {
      const r = await app.soft('sync rooms', async () =>
        (await app.syncer()).syncAll({ skipUnchanged: true, maxMessages: DEFAULT_SYNC_CHUNK }),
      );
      if (r.ok) app.lastGlobalSyncAt = Date.now();
      else notes.push(r.note);
    }
  }

  const fromSet = args.from?.map((f) => f.replace(/^@/, '').toLowerCase());
  const threadRef = args.thread_id ? parseMessageRef(args.thread_id) : {};
  const threadId = threadRef.threadId ?? threadRef.messageId;
  if (args.thread_id && !threadId)
    throw new ToolError('invalid-argument', 'thread_id must be a message id or a thread URL.');
  const hits = app.store.search(args.query, {
    ...(scoped ? { rids: scoped.map((r) => r.rid) } : {}),
    ...(fromSet?.length ? { usernames: fromSet } : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    ...(threadId ? { threadId } : {}),
    limit,
  });
  type Result = ReturnType<typeof formatMessage> & { snippet: string; source: 'index' | 'server' | 'index+server' };
  const results: Result[] = hits.map((h) => ({
    ...formatMessage(h.message, app.store.getRoom(h.message.rid), app.siteUrl),
    snippet: h.snippet,
    source: 'index',
  }));

  // Server-side search only works for unencrypted rooms (E2EE content is opaque to the server). Unencrypted
  // rooms are indexed locally too, so this is opt-in by default unless specific rooms are targeted.
  // refresh=false means "no network at all" unless server search is explicitly requested.
  const serverSearch = args.include_server_search ?? (refresh && Boolean(scoped?.length));
  if (serverSearch) {
    const plainRooms = (scoped ?? app.store.listRooms()).filter((r) => !r.encrypted).slice(0, 10);
    for (const room of plainRooms) {
      const r = await app.soft(`server-search ${room.displayName}`, () =>
        app.client.get(
          'chat.search',
          { roomId: room.rid, searchText: args.query, count: limit },
          { maxRateLimitWaitMs: OPTIONAL_CALL_WAIT_MS },
        ),
      );
      if (!r.ok) {
        notes.push(r.note);
        break;
      }
      for (const raw of r.value.messages) {
        if (fromSet?.length && !fromSet.includes((raw.u.username ?? '').toLowerCase())) continue;
        if (after && raw.ts < after) continue;
        if (before && raw.ts >= before) continue;
        if (threadId && raw._id !== threadId && raw.tmid !== threadId) continue;
        const existing = results.find((x) => x.id === raw._id);
        if (existing) {
          existing.source = 'index+server';
          continue;
        }
        const { record } = await convertMessage(raw, undefined);
        results.push({
          ...formatMessage(record, room, app.siteUrl),
          snippet: record.text.slice(0, 200),
          source: 'server',
        });
      }
    }
  }
  const final = results.slice(0, limit);
  const stats = app.store.stats();
  const incomplete = app.store.listRooms().filter((r) => !app.store.getSyncState(r.rid)?.backfillDone).length;
  if (incomplete) notes.push(`${incomplete} room(s) have older history not indexed yet; run sync to extend coverage.`);
  if (stats.undecryptable)
    notes.push(`${stats.undecryptable} indexed message(s) could not be decrypted and are not searchable.`);
  return {
    query: args.query,
    count: final.length,
    ...(results.length > final.length ? { more_available: true } : {}),
    results: final,
    index: { rooms: stats.rooms, messages: stats.messages },
    ...(notes.length ? { notes } : {}),
  };
}

// ----------------------------------------------------------------------------------------------- files & users

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|toml|sql|csv|x-ndjson|markdown))/;
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|ts|tsx|py|rb|go|rs|java|kt|sh|sql|ini|cfg|conf|log|diff|patch)$/i;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_EPHEMERAL_BINARY_BYTES = 10 * 1024 * 1024;

export interface FileResult {
  meta: Record<string, unknown>;
  text?: string;
  image?: { data: string; mimeType: string };
  /** Binary content returned inline (ephemeral mode never writes decrypted files to disk). */
  blob?: { data: string; mimeType: string };
}

interface FileFacts {
  fileId: string;
  rid?: string | undefined;
  name?: string | undefined;
  type?: string | undefined;
  encryption?: FileEncryption | undefined;
  sha256?: string | undefined;
  path?: string | undefined;
  e2ee: boolean;
}

async function findUpload(app: App, fileId: string, rid: string | undefined): Promise<Upload | undefined> {
  const candidates = rid ? [app.store.getRoom(rid) ?? { rid, t: 'p' }] : app.store.listRooms().slice(0, 30);
  for (const room of candidates) {
    const endpoint = room.t === 'd' ? 'im.files' : room.t === 'p' ? 'groups.files' : 'channels.files';
    try {
      for (let offset = 0; offset < 1000; offset += 100) {
        const res = await app.client.get(endpoint, { roomId: room.rid, count: 100, offset });
        const hit = res.files.find((f) => f._id === fileId);
        if (hit) return { ...hit, rid: hit.rid ?? room.rid };
        if (res.files.length < 100) break;
      }
    } catch {
      // a room we cannot list files of: keep looking elsewhere
    }
  }
  return undefined;
}

async function decryptUploadMeta(app: App, upload: Upload, facts: FileFacts): Promise<void> {
  if (!upload.content) return;
  const keyring = await (await app.syncer()).keyringFor(upload.rid ?? facts.rid ?? '').catch(() => undefined);
  const { message, decryption } = await decryptMessage(
    { _id: upload._id, rid: upload.rid ?? '', t: 'e2e', content: upload.content },
    keyring,
  );
  if (decryption.state === 'undecryptable') {
    throw new ToolError(
      'undecryptable',
      `The file's metadata cannot be decrypted: ${decryption.reason}`,
      REASON_HINTS[decryption.reason],
    );
  }
  const meta = message as unknown as {
    name?: string;
    type?: string;
    encryption?: FileEncryption;
    hashes?: { sha256?: string };
  };
  facts.name = meta.name ?? facts.name;
  facts.type = meta.type ?? facts.type;
  facts.encryption ??= meta.encryption;
  facts.sha256 ??= meta.hashes?.sha256;
}

export async function getFile(
  app: App,
  args: { file_id?: string; message_id?: string; max_inline_bytes?: number },
): Promise<FileResult> {
  if (!args.file_id && !args.message_id) throw new ToolError('invalid-argument', 'Provide file_id or message_id.');
  if (args.file_id && !ID_PATTERN.test(args.file_id))
    throw new ToolError('invalid-argument', 'file_id has an invalid format.');
  await refreshSoft(app);
  let messageId = args.message_id ? parseMessageRef(args.message_id).messageId : undefined;
  if (args.message_id && !messageId) {
    throw new ToolError('invalid-argument', 'message_id must be a message id or a Rocket.Chat message URL.');
  }
  if (!messageId && args.file_id) {
    const row = app.store.db
      .prepare('SELECT id FROM messages WHERE file_json LIKE ? OR attachments_json LIKE ? LIMIT 1')
      .get(`%"id":"${args.file_id}"%`, `%"fileId":"${args.file_id}"%`) as { id: string } | undefined;
    messageId = row?.id;
  }

  // Re-fetch and decrypt the message: per-file keys are never stored in the index.
  let facts: FileFacts | undefined;
  if (messageId) {
    const raw = (await app.client.get('chat.getMessage', { msgId: messageId })).message;
    const keyring = await (await app.syncer()).keyringFor(raw.rid).catch(() => undefined);
    const { message, decryption } = await decryptMessage(raw, keyring);
    if (decryption.state === 'undecryptable') {
      throw new ToolError(
        'undecryptable',
        `The file's message cannot be decrypted: ${decryption.reason}`,
        REASON_HINTS[decryption.reason],
      );
    }
    const atts = ((message.attachments ?? []) as Array<Record<string, unknown>>).filter(
      (a) => typeof a.fileId === 'string',
    );
    const file = message.file as { _id?: string; name?: string; type?: string } | undefined;
    const att = args.file_id ? atts.find((a) => a.fileId === args.file_id) : atts[0];
    const fileId = args.file_id ?? (att?.fileId as string | undefined) ?? file?._id;
    if (!fileId || (args.file_id && !att && file?._id !== args.file_id)) {
      throw new ToolError('file-not-found', 'That message does not carry the requested file.');
    }
    facts = {
      fileId,
      rid: raw.rid,
      name: (att?.title as string | undefined) ?? file?.name,
      type: (att?.image_type ??
        att?.audio_type ??
        att?.video_type ??
        (file?._id === fileId ? file?.type : undefined)) as string | undefined,
      encryption: att?.encryption as FileEncryption | undefined,
      sha256: (att?.hashes as { sha256?: string } | undefined)?.sha256,
      e2ee: raw.t === 'e2e',
    };
  }

  // E2EE file messages sent without encrypted content keep the key only in the upload record.
  if (!facts || (facts.e2ee && !facts.encryption)) {
    const fileId = facts?.fileId ?? args.file_id ?? '';
    const upload = await findUpload(app, fileId, facts?.rid);
    if (!upload && !facts) {
      throw new ToolError(
        'file-not-found',
        `File ${fileId} was not found.`,
        'Pass the message_id that carries the file, or run sync first.',
      );
    }
    if (upload) {
      facts ??= { fileId, rid: upload.rid, e2ee: Boolean(upload.content) };
      facts.path = upload.path;
      facts.e2ee ||= Boolean(upload.content);
      await decryptUploadMeta(app, upload, facts);
      if (!upload.content && upload.type) facts.type ??= upload.type;
      facts.name ??= upload.name;
    }
  }
  if (!facts) throw new ToolError('file-not-found', 'File not found.');
  if (facts.e2ee && !facts.encryption) {
    throw new ToolError(
      'file-key-missing',
      'This encrypted file has no decryption key in its message or upload record.',
      REASON_HINTS['file-key-missing'],
    );
  }

  const path = facts.path ?? `/file-upload/${facts.fileId}/${encodeURIComponent(facts.name ?? facts.fileId)}`;
  const downloaded = await app.client.download(new URL(path, 'http://x').pathname);
  const result = facts.encryption
    ? await decryptFile(downloaded.bytes, facts.encryption, facts.sha256)
    : { bytes: downloaded.bytes, integrity: 'unverified' as const };
  const bytes = result.bytes;
  const type = facts.type ?? downloaded.contentType ?? 'application/octet-stream';
  const meta: Record<string, unknown> = {
    file_id: facts.fileId,
    name: facts.name ?? facts.fileId,
    type,
    size: bytes.length,
    encrypted: Boolean(facts.encryption),
    ...(facts.encryption ? { integrity: result.integrity } : {}),
    ...(messageId ? { message_id: messageId } : {}),
  };

  const maxInline = args.max_inline_bytes ?? 256 * 1024;
  const isText = TEXT_TYPES.test(type) || Boolean(facts.name && TEXT_EXTENSIONS.test(facts.name));
  if (isText && bytes.length <= maxInline) {
    return { meta: { ...meta, inline: true }, text: new TextDecoder('utf-8').decode(bytes) };
  }
  const base64 = () => Buffer.from(bytes).toString('base64');
  if (type.startsWith('image/') && bytes.length <= MAX_IMAGE_BYTES) {
    return { meta: { ...meta, inline: true }, image: { data: base64(), mimeType: type } };
  }
  if (app.config.ephemeral) {
    // Ephemeral mode never writes decrypted content to disk.
    if (bytes.length > MAX_EPHEMERAL_BINARY_BYTES) {
      throw new ToolError(
        'file-too-large',
        `The file is ${bytes.length} bytes; in ephemeral mode files are only returned inline (limit ${MAX_EPHEMERAL_BINARY_BYTES}).`,
        'Disable RC_MCP_EPHEMERAL to have large files saved to the private data directory.',
      );
    }
    return { meta: { ...meta, inline: true }, blob: { data: base64(), mimeType: type } };
  }
  const dir = app.filesDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, FILES_MARKER), 'Created by rc-mcp; `rc-mcp purge` deletes this directory.\n', {
    mode: 0o600,
  });
  const safeName =
    `${facts.fileId.replace(/[^A-Za-z0-9_-]/g, '_')}-${(facts.name ?? 'file').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_')}`.slice(
      0,
      180,
    );
  const target = join(dir, safeName);
  writeFileSync(target, bytes, { mode: 0o600 });
  return { meta: { ...meta, inline: false, saved_to: target } };
}

export async function getUser(app: App, args: { username?: string; user_id?: string }) {
  if (!args.username && !args.user_id) throw new ToolError('invalid-argument', 'Provide username or user_id.');
  const res = await app.client.get(
    'users.info',
    args.user_id ? { userId: args.user_id } : { username: (args.username ?? '').replace(/^@/, '') },
  );
  const u = res.user;
  return {
    id: u._id,
    username: u.username,
    name: u.name,
    status: u.status,
    ...(u.statusText ? { status_text: u.statusText } : {}),
    ...(u.bio ? { bio: u.bio } : {}),
    ...(u.roles ? { roles: u.roles } : {}),
    ...(u.utcOffset !== undefined ? { utc_offset: u.utcOffset } : {}),
    ...(u.active !== undefined ? { active: u.active } : {}),
    ...(u.type ? { type: u.type } : {}),
  };
}
