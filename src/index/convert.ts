/**
 * Turns a raw REST message into an index record: decrypts it (if needed) and strips per-file key material from
 * attachments before anything is persisted.
 */
import type { RoomKeyring } from '../e2ee/keyring.ts';
import { decryptMessage, isEncryptedMessage } from '../e2ee/message.ts';
import type { Message } from '../rc-api/schemas.ts';
import type { MessageRecord, StoredAttachment } from './store.ts';

type Att = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function sanitizeAttachment(a: Att): StoredAttachment {
  const mime = str(a.image_type) ?? str(a.audio_type) ?? str(a.video_type);
  const dims = a.image_dimensions as { width?: unknown; height?: unknown } | undefined;
  const out: StoredAttachment = {};
  const set = <K extends keyof StoredAttachment>(k: K, v: StoredAttachment[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('title', str(a.title));
  set('type', str(a.type));
  set('description', str(a.description));
  set('text', str(a.text));
  set('fileId', str(a.fileId));
  set('fileName', a.fileId ? str(a.title) : undefined);
  set('mimeType', mime);
  set('size', num(a.size) ?? num(a.image_size) ?? num(a.audio_size) ?? num(a.video_size));
  if (a.encryption) out.encrypted = true;
  if (dims && typeof dims.width === 'number' && typeof dims.height === 'number') {
    out.imageDimensions = { width: dims.width, height: dims.height };
  }
  set('authorName', str(a.author_name));
  set('messageLink', str(a.message_link));
  return out;
}

export interface Converted {
  record: MessageRecord;
  deleted: boolean;
}

export async function convertMessage(raw: Message, keyring: RoomKeyring | undefined): Promise<Converted> {
  const encrypted = isEncryptedMessage(raw);
  const { message, decryption } = await decryptMessage(raw, keyring);
  const attachments = Array.isArray(message.attachments)
    ? (message.attachments.filter((a) => a && typeof a === 'object') as Att[]).map(sanitizeAttachment)
    : [];
  const f = message.file as Att | undefined;
  const file =
    f && typeof f._id === 'string'
      ? {
          id: f._id,
          ...(str(f.name) ? { name: str(f.name) } : {}),
          ...(str(f.type) ? { type: str(f.type) } : {}),
          ...(num(f.size) !== undefined ? { size: num(f.size) } : {}),
        }
      : null;
  return {
    deleted: raw.t === 'rm',
    record: {
      id: raw._id,
      rid: raw.rid,
      tmid: raw.tmid ?? null,
      t: raw.t ?? null,
      ts: raw.ts,
      updatedAt: raw._updatedAt ?? null,
      editedAt: raw.editedAt ?? null,
      userId: raw.u?._id ?? null,
      username: raw.u?.username ?? null,
      userName: raw.u?.name ?? null,
      text: message.msg ?? '',
      encrypted,
      decryption,
      attachments,
      file: file as MessageRecord['file'],
      tcount: raw.tcount ?? null,
      ...(decryption.state === 'undecryptable' ? { raw } : {}),
    },
  };
}
