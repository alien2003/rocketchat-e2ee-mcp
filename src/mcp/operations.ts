/**
 * Read-only operations behind the MCP tools and the CLI. Each returns plain JSON-serialisable data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// ----------------------------------------------------------------------------------------------- rooms

export async function resolveRoom(app: App, ref: string): Promise<RoomRecord> {
  await app.refreshRooms();
  let room = app.store.findRoom(ref);
  if (!room) {
    await app.refreshRooms(0);
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
  await app.refreshRooms(args.filter ? ROOM_STALE_MS : 15_000);
  const session = await app.session();
  const typeMap = { channel: 'c', 'private-group': 'p', 'direct-message': 'd' } as const;
  const needle = args.filter?.toLowerCase();
  const rooms = app.store
    .listRooms()
    .filter((r) => !args.type || args.type === 'all' || r.t === typeMap[args.type])
    .filter((r) => !args.encrypted_only || r.encrypted)
    .filter((r) => !needle || `${r.displayName} ${r.name ?? ''} ${r.topic ?? ''}`.toLowerCase().includes(needle))
    .slice(0, args.limit ?? 200);
  return {
    e2ee:
      session.state.status === 'ready'
        ? 'unlocked'
        : { status: 'unavailable', reason: session.state.reason, hint: REASON_HINTS[session.state.reason] },
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
  };
}

// ----------------------------------------------------------------------------------------------- sync

export async function syncRooms(app: App, args: { room?: string; full?: boolean; max_messages?: number }) {
  const syncer = await app.syncer();
  let reports: SyncReport[];
  if (args.room) {
    const room = await resolveRoom(app, args.room);
    reports = [
      await syncer.syncRoom(room.rid, {
        full: args.full ?? false,
        ...(args.max_messages ? { maxMessages: args.max_messages } : {}),
      }),
    ];
  } else {
    reports = await syncer.syncAll({
      full: args.full ?? false,
      skipUnchanged: !args.full,
      ...(args.max_messages ? { maxMessages: args.max_messages } : {}),
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
    ...(reports.some((r) => !r.backfillComplete)
      ? { note: 'Some rooms have older history not yet indexed; call sync again to continue.' }
      : {}),
    unchanged_rooms: reports.length - changed.length,
  };
}

/** Makes sure a room is reasonably fresh in the index before reading it. */
async function ensureRoomSynced(app: App, room: RoomRecord, minMessages: number, before?: string): Promise<void> {
  const syncer = await app.syncer();
  const state = app.store.getSyncState(room.rid);
  const stale = !state?.lastSyncAt || Date.now() - Date.parse(state.lastSyncAt) > ROOM_STALE_MS;
  if (stale) await syncer.syncRoom(room.rid, { maxMessages: Math.max(minMessages * 2, 200) });
  // Pull older history on demand until the requested window is covered or history is exhausted.
  for (let i = 0; i < 20; i++) {
    const s = app.store.getSyncState(room.rid);
    if (!s || s.backfillDone) return;
    const have = app.store.listMessages(room.rid, {
      ...(before ? { before } : {}),
      limit: minMessages,
      includeThreads: true,
    });
    if (have.length >= minMessages) return;
    await syncer.syncRoom(room.rid, { maxMessages: Math.max(minMessages, 200) });
  }
}

// ----------------------------------------------------------------------------------------------- messages

export async function getMessages(
  app: App,
  args: { room: string; before?: string; after?: string; limit?: number; include_thread_replies?: boolean },
) {
  const room = await resolveRoom(app, args.room);
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 200);
  await ensureRoomSynced(app, room, limit, args.before);
  const rows = app.store.listMessages(room.rid, {
    ...(args.before ? { before: args.before } : {}),
    ...(args.after ? { after: args.after } : {}),
    limit: limit + 1,
    includeThreads: args.include_thread_replies ?? false,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const sync = app.store.getSyncState(room.rid);
  return {
    room: formatRoom(room),
    order: 'oldest-first',
    count: page.length,
    has_older: hasMore || !sync?.backfillDone,
    ...(page[0] ? { older_than_cursor: page[0].ts } : {}),
    messages: page.map((m) => formatMessage(m, room, app.siteUrl)),
  };
}

async function fetchAndIndexMessage(app: App, id: string): Promise<MessageRecord> {
  const local = app.store.getMessage(id);
  if (local) return local;
  const res = await app.client.get('chat.getMessage', { msgId: id });
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
  await app.refreshRooms();
  const message = await fetchAndIndexMessage(app, id);
  const room = app.store.getRoom(message.rid);
  const formatted = formatMessage(message, room, app.siteUrl);
  const quoted = [];
  if (args.resolve_quotes !== false) {
    for (const q of formatted.quotes ?? []) {
      try {
        quoted.push(
          formatMessage(await fetchAndIndexMessage(app, q.message_id), app.store.getRoom(message.rid), app.siteUrl),
        );
      } catch {
        quoted.push({ id: q.message_id, unavailable: true });
      }
    }
  }
  return {
    message: formatted,
    ...(quoted.length ? { quoted_messages: quoted } : {}),
    ...(message.tcount ? { note: `This message starts a thread with ${message.tcount} replies; use get_thread.` } : {}),
  };
}

export async function getThread(app: App, args: { thread_id?: string; url?: string; limit?: number }) {
  const ref = args.url ? parseMessageRef(args.url) : args.thread_id ? parseMessageRef(args.thread_id) : {};
  const id = ref.threadId ?? ref.messageId;
  if (!id) throw new ToolError('invalid-argument', 'Provide thread_id (the root message id) or a thread URL.');
  await app.refreshRooms();
  let root = await fetchAndIndexMessage(app, id);
  if (root.tmid) root = await fetchAndIndexMessage(app, root.tmid); // a reply was given: use its thread
  const room = app.store.getRoom(root.rid);
  if (room) await ensureRoomSynced(app, room, 1);
  let replies = app.store.threadMessages(root.id, args.limit ?? 500);
  if ((root.tcount ?? 0) > replies.length) {
    // Not all replies are indexed yet (old thread): fetch the thread directly.
    const syncer = await app.syncer();
    const keyring = await syncer.keyringFor(root.rid).catch(() => undefined);
    let offset = 0;
    for (;;) {
      const res = await app.client.get('chat.getThreadMessages', { tmid: root.id, count: 100, offset });
      for (const raw of res.messages) {
        const { record, deleted } = await convertMessage(raw as Message, keyring);
        if (!deleted && room) app.store.upsertMessage(record);
      }
      offset += res.messages.length;
      if (res.messages.length < 100 || offset >= (res.total ?? offset)) break;
    }
    replies = app.store.threadMessages(root.id, args.limit ?? 500);
  }
  return {
    room: room ? formatRoom(room) : { id: root.rid },
    root: formatMessage(root, room, app.siteUrl),
    reply_count: replies.length,
    replies: replies.map((m) => formatMessage(m, room, app.siteUrl)),
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
  await app.refreshRooms();
  const rooms = args.rooms?.length ? await Promise.all(args.rooms.map((r) => resolveRoom(app, r))) : undefined;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const notes: string[] = [];
  if (args.refresh !== false) {
    const syncer = await app.syncer();
    if (rooms) {
      for (const room of rooms) {
        const s = app.store.getSyncState(room.rid);
        if (!s?.lastSyncAt || Date.now() - Date.parse(s.lastSyncAt) > ROOM_STALE_MS)
          await syncer.syncRoom(room.rid, { maxMessages: 2000 });
      }
    } else if (Date.now() - app.lastGlobalSyncAt > 5 * 60_000) {
      await syncer.syncAll({ skipUnchanged: true, maxMessages: 2000 });
      app.lastGlobalSyncAt = Date.now();
    }
  }
  const hits = app.store.search(args.query, {
    ...(rooms ? { rids: rooms.map((r) => r.rid) } : {}),
    ...(args.from?.length ? { usernames: args.from } : {}),
    ...(args.after ? { after: args.after } : {}),
    ...(args.before ? { before: args.before } : {}),
    ...(args.thread_id ? { threadId: args.thread_id } : {}),
    limit,
  });
  const results = hits.map((h) => ({
    ...formatMessage(h.message, app.store.getRoom(h.message.rid), app.siteUrl),
    snippet: h.snippet,
    source: 'index' as 'index' | 'server' | 'index+server',
  }));

  // Server-side search only works for unencrypted rooms (E2EE content is opaque to the server).
  if (args.include_server_search !== false) {
    const plainRooms = (rooms ?? app.store.listRooms()).filter((r) => !r.encrypted).slice(0, rooms ? 10 : 5);
    for (const room of plainRooms) {
      try {
        const res = await app.client.get('chat.search', { roomId: room.rid, searchText: args.query, count: limit });
        for (const raw of res.messages) {
          if (
            args.from?.length &&
            !args.from.map((f) => f.replace(/^@/, '').toLowerCase()).includes((raw.u.username ?? '').toLowerCase())
          )
            continue;
          const existing = results.find((r) => r.id === raw._id);
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
      } catch (error) {
        notes.push(
          `server search skipped for ${room.displayName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!rooms && app.store.listRooms().filter((r) => !r.encrypted).length > plainRooms.length) {
      notes.push('Server-side search covered the 5 most active unencrypted rooms; pass `rooms` to target others.');
    }
  }
  const stats = app.store.stats();
  const incomplete = app.store.listRooms().filter((r) => !app.store.getSyncState(r.rid)?.backfillDone).length;
  if (incomplete) notes.push(`${incomplete} room(s) have older history not indexed yet; run sync to extend coverage.`);
  if (stats.undecryptable)
    notes.push(`${stats.undecryptable} indexed message(s) could not be decrypted and are not searchable.`);
  return {
    query: args.query,
    count: results.length,
    results: results.slice(0, limit * 2),
    index: { rooms: stats.rooms, messages: stats.messages },
    ...(notes.length ? { notes } : {}),
  };
}

// ----------------------------------------------------------------------------------------------- files & users

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|toml|sql|csv|x-ndjson|markdown))/;
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|ts|tsx|py|rb|go|rs|java|kt|sh|sql|ini|cfg|conf|log|diff|patch)$/i;

export interface FileResult {
  meta: Record<string, unknown>;
  text?: string;
  image?: { data: string; mimeType: string };
}

export async function getFile(
  app: App,
  args: { file_id?: string; message_id?: string; max_inline_bytes?: number },
): Promise<FileResult> {
  if (!args.file_id && !args.message_id) throw new ToolError('invalid-argument', 'Provide file_id or message_id.');
  await app.refreshRooms();
  let messageId = args.message_id;
  if (!messageId && args.file_id) {
    const row = app.store.db
      .prepare('SELECT id FROM messages WHERE file_json LIKE ? OR attachments_json LIKE ? LIMIT 1')
      .get(`%"id":"${args.file_id}"%`, `%"fileId":"${args.file_id}"%`) as { id: string } | undefined;
    messageId = row?.id;
  }
  // Re-fetch and decrypt the message: per-file keys are never stored in the index.
  let raw: Message | undefined;
  if (messageId) raw = (await app.client.get('chat.getMessage', { msgId: messageId })).message;
  const syncer = await app.syncer();
  let encryption: FileEncryption | undefined;
  let sha256: string | undefined;
  let name: string | undefined;
  let type: string | undefined;
  let fileId = args.file_id;
  let rid = raw?.rid;
  if (raw) {
    const keyring = await syncer.keyringFor(raw.rid).catch(() => undefined);
    const { message, decryption } = await decryptMessage(raw, keyring);
    if (decryption.state === 'undecryptable') {
      throw new ToolError(
        'undecryptable',
        `The file's message cannot be decrypted: ${decryption.reason}`,
        REASON_HINTS[decryption.reason],
      );
    }
    const atts = (message.attachments ?? []) as Array<Record<string, unknown>>;
    const att = atts.find((a) => a.fileId && (!fileId || a.fileId === fileId)) ?? atts.find((a) => a.fileId);
    const file = message.file as { _id?: string; name?: string; type?: string } | undefined;
    fileId ??= (att?.fileId as string | undefined) ?? file?._id;
    encryption = att?.encryption as FileEncryption | undefined;
    sha256 = (att?.hashes as { sha256?: string } | undefined)?.sha256;
    name = (att?.title as string | undefined) ?? file?.name;
    type = (att?.image_type ?? att?.audio_type ?? att?.video_type ?? file?.type) as string | undefined;
  }
  if (!fileId) throw new ToolError('file-not-found', 'No file attachment found on that message.');
  let upload: Upload | undefined;
  if (!raw || !name) {
    // Fall back to the room file listing (also covers E2EE uploads whose message content lacks metadata).
    const room = rid ? app.store.getRoom(rid) : undefined;
    const rooms = room ? [room] : app.store.listRooms();
    for (const r of rooms) {
      const endpoint = r.t === 'd' ? 'im.files' : r.t === 'p' ? 'groups.files' : 'channels.files';
      const res = await app.client.get(endpoint, { roomId: r.rid, count: 100 });
      upload = res.files.find((f) => f._id === fileId);
      if (upload) {
        rid = r.rid;
        break;
      }
    }
    if (upload?.content) {
      const keyring = await syncer.keyringFor(upload.rid ?? rid ?? '').catch(() => undefined);
      const { message } = await decryptMessage(
        { _id: upload._id, rid: upload.rid ?? '', t: 'e2e', content: upload.content },
        keyring,
      );
      const meta = message as unknown as {
        name?: string;
        type?: string;
        encryption?: FileEncryption;
        hashes?: { sha256?: string };
      };
      name ??= meta.name;
      type ??= meta.type;
      encryption ??= meta.encryption;
      sha256 ??= meta.hashes?.sha256;
    }
  }
  const path = upload?.path ?? `/file-upload/${fileId}/${encodeURIComponent(upload?.name ?? name ?? 'file')}`;
  const downloaded = await app.client.download(new URL(path, 'http://x').pathname);
  const result = encryption
    ? await decryptFile(downloaded.bytes, encryption, sha256)
    : { bytes: downloaded.bytes, integrity: 'unverified' as const };
  const bytes = result.bytes;
  type ??= downloaded.contentType;
  const meta: Record<string, unknown> = {
    file_id: fileId,
    name: name ?? fileId,
    type: type ?? 'application/octet-stream',
    size: bytes.length,
    encrypted: Boolean(encryption),
    ...(encryption ? { integrity: result.integrity } : {}),
    ...(messageId ? { message_id: messageId } : {}),
  };
  const maxInline = args.max_inline_bytes ?? 256 * 1024;
  const isText = (type && TEXT_TYPES.test(type)) || (name && TEXT_EXTENSIONS.test(name));
  if (isText && bytes.length <= maxInline) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { meta: { ...meta, inline: true }, text };
  }
  const dir = app.config.ephemeral ? join(tmpdir(), `rc-mcp-${process.pid}`) : app.filesDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safeName = `${fileId}-${(name ?? 'file').replace(/[^\w.-]+/g, '_')}`.slice(0, 180);
  const target = join(dir, safeName);
  writeFileSync(target, bytes, { mode: 0o600 });
  const out: FileResult = { meta: { ...meta, inline: false, saved_to: target } };
  if (type?.startsWith('image/') && bytes.length <= 4 * 1024 * 1024) {
    out.image = { data: Buffer.from(bytes).toString('base64'), mimeType: type };
  }
  return out;
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
