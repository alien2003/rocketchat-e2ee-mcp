/**
 * Shapes index records into compact, LLM-friendly JSON for tool results and CLI output.
 */
import type { E2eeFailureReason } from '../e2ee/errors.ts';
import type { MessageRecord, RoomRecord } from '../index/store.ts';

export const REASON_HINTS: Record<E2eeFailureReason, string> = {
  'no-e2ee-password':
    'Set RC_E2EE_PASSWORD (your Rocket.Chat E2EE password / recovery phrase) to read encrypted rooms.',
  'no-user-keys': 'This account has never set up E2EE. Log in once with the official client to create keys.',
  'wrong-password': 'RC_E2EE_PASSWORD does not unlock your E2EE private key. Use the current E2EE password.',
  'unsupported-password': 'The E2EE password contains characters the Rocket.Chat client cannot use as key material.',
  'no-room-key':
    'This account has not received the room key yet. It is shared automatically when another member is online in the official client.',
  'room-key-missing':
    'Encrypted with a room key this account does not hold (e.g. sent before you got access, or before a room key reset older than the 10 kept keys).',
  'room-key-undecryptable':
    'The room key was shared for a different key pair (your E2EE keys were reset since). Ask a member to re-share keys by opening the room in the official client.',
  'unsupported-algorithm': 'Encrypted with an algorithm this version does not support (e.g. Matrix federation).',
  'malformed-payload': 'The encrypted payload is malformed.',
  'decryption-failed': 'Decryption failed (wrong key or corrupted data).',
  'invalid-plaintext': 'Decrypted data is not a Rocket.Chat message payload.',
  'file-key-missing': 'The file message carries no decryption key.',
  'file-hash-mismatch': 'The decrypted file does not match the checksum recorded by the uploader.',
};

export function roomTypeLabel(t: string): string {
  if (t === 'c') return 'channel';
  if (t === 'p') return 'private-group';
  if (t === 'd') return 'direct-message';
  if (t === 'l') return 'livechat';
  return t;
}

export function permalink(
  site: string,
  room: Pick<RoomRecord, 't' | 'name' | 'rid'> | undefined,
  msg: MessageRecord,
): string {
  if (!room) return `${site}/?msg=${msg.id}`;
  const base =
    room.t === 'd'
      ? `${site}/direct/${room.rid}`
      : room.t === 'c'
        ? `${site}/channel/${encodeURIComponent(room.name ?? room.rid)}`
        : `${site}/group/${encodeURIComponent(room.name ?? room.rid)}`;
  return msg.tmid ? `${base}/thread/${msg.tmid}?msg=${msg.id}` : `${base}?msg=${msg.id}`;
}

/** Message ids referenced by Rocket.Chat permalinks in a text (quotes are `[ ](<permalink>)` prefixes). */
export function extractMessageLinks(text: string): { messageId: string; url: string }[] {
  const out: { messageId: string; url: string }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s)\]]+/g)) {
    try {
      const url = new URL(match[0]);
      const id = url.searchParams.get('msg');
      if (id && /^[A-Za-z0-9]{10,24}$/.test(id)) out.push({ messageId: id, url: match[0] });
    } catch {
      // not a URL
    }
  }
  return out;
}

/** Removes the leading `[ ](permalink)` quote markers the client prepends, leaving the author's text. */
export function stripQuoteMarkers(text: string): string {
  return text.replace(/^(\[ \]\(https?:\/\/[^)]+\)\s*)+/, '');
}

export interface FormattedMessage {
  id: string;
  room_id: string;
  room?: string;
  ts: string;
  author: string;
  text: string;
  thread_id?: string;
  reply_count?: number;
  edited_at?: string;
  system_type?: string;
  quotes?: { message_id: string; url: string }[];
  attachments?: Array<Record<string, unknown>>;
  encrypted?: true;
  undecryptable?: { reason: string; hint: string; key_id?: string };
  permalink: string;
}

export function formatMessage(m: MessageRecord, room: RoomRecord | undefined, site: string): FormattedMessage {
  const author = m.username
    ? m.userName && m.userName !== m.username
      ? `${m.userName} (@${m.username})`
      : `@${m.username}`
    : 'unknown';
  const quotes = extractMessageLinks(m.text).map((q) => ({ message_id: q.messageId, url: q.url }));
  const out: FormattedMessage = {
    id: m.id,
    room_id: m.rid,
    ...(room ? { room: room.displayName } : {}),
    ts: m.ts,
    author,
    text: quotes.length ? stripQuoteMarkers(m.text) : m.text,
    permalink: permalink(site, room, m),
  };
  if (m.tmid) out.thread_id = m.tmid;
  if (m.tcount) out.reply_count = m.tcount;
  if (m.editedAt) out.edited_at = m.editedAt;
  if (m.t && m.t !== 'e2e') out.system_type = m.t;
  if (quotes.length) out.quotes = quotes;
  if (m.attachments.length) {
    out.attachments = m.attachments.map((a) => {
      const att: Record<string, unknown> = {};
      if (a.fileId) att.file_id = a.fileId;
      if (a.fileName ?? a.title) att.name = a.fileName ?? a.title;
      if (a.mimeType ?? (a.fileId && m.file?.id === a.fileId ? m.file.type : undefined)) {
        att.type = a.mimeType ?? m.file?.type;
      }
      if (a.size) att.size = a.size;
      if (a.description) att.description = a.description;
      if (a.text) att.text = a.text;
      if (a.authorName) att.quoted_author = a.authorName;
      if (a.messageLink) att.quoted_link = a.messageLink;
      if (a.encrypted) att.encrypted = true;
      return att;
    });
  }
  if (m.encrypted) out.encrypted = true;
  if (m.decryption.state === 'undecryptable') {
    out.undecryptable = {
      reason: m.decryption.reason,
      hint: REASON_HINTS[m.decryption.reason],
      ...(m.decryption.kid ? { key_id: m.decryption.kid } : {}),
    };
  }
  return out;
}

export function formatRoom(r: RoomRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: r.rid,
    name: r.displayName,
    ...(r.name && r.name !== r.displayName ? { handle: r.name } : {}),
    type: roomTypeLabel(r.t),
    encrypted: r.encrypted,
    key_status: r.keyStatus,
    ...(r.keyDetail ? { key_detail: r.keyDetail } : {}),
    ...(r.topic ? { topic: r.topic } : {}),
    ...(r.archived ? { archived: true } : {}),
    last_activity: r.lastMessageAt,
    ...extra,
  };
}

/** Parses a pasted Rocket.Chat URL (or a bare id) into a message/thread id. */
export function parseMessageRef(input: string): { messageId?: string; threadId?: string } {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{10,24}$/.test(trimmed)) return { messageId: trimmed };
  try {
    const url = new URL(trimmed);
    const msg = url.searchParams.get('msg') ?? undefined;
    const thread = url.pathname.match(/\/thread\/([A-Za-z0-9]{10,24})/)?.[1];
    return { ...(msg ? { messageId: msg } : {}), ...(thread ? { threadId: thread } : {}) };
  } catch {
    return {};
  }
}
