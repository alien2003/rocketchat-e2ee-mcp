/**
 * Decrypts a raw Rocket.Chat message document (as returned by the REST API) with a room keyring, mirroring
 * `E2ERoom.decryptMessage` / `decryptMessageContent` / `E2E.decryptPinnedMessage` (8.9.0):
 *   - t !== 'e2e' (and not an encrypted pin): plaintext, returned unchanged;
 *   - `content` with rc.v1/rc.v2: decrypted fields (msg, attachments, files, file) replace the server's
 *     placeholder fields; `removed-file` attachments present on the server copy are preserved;
 *   - no `content` but a `msg` string: legacy v1 payload in `msg`;
 *   - t === 'message_pinned_e2e': attachments[0].content holds the pinned message.
 * Nothing is dropped: failures produce `decryption.state === 'undecryptable'` with a reason.
 */
import {
  type DecodedPayload,
  type DecryptedContent,
  decodeEncryptedContent,
  decryptPayload,
  type EncryptedContent,
  isEncryptedContent,
} from './content.ts';
import { E2eeError, type E2eeFailureReason, isE2eeError } from './errors.ts';
import type { KeySource, RoomKeyring } from './keyring.ts';

export interface RawMessage {
  _id: string;
  rid: string;
  t?: string;
  msg?: string;
  content?: unknown;
  attachments?: unknown[];
  file?: unknown;
  files?: unknown[];
  tmid?: string;
  [key: string]: unknown;
}

export type DecryptionInfo =
  | { state: 'plaintext' }
  | { state: 'decrypted'; codec: string; kid: string; keySource: KeySource }
  | { state: 'undecryptable'; reason: E2eeFailureReason; detail: string; kid?: string; codec?: string };

export interface DecryptedMessage<T extends RawMessage = RawMessage> {
  message: T & { msg: string };
  decryption: DecryptionInfo;
}

export function isEncryptedMessage(raw: RawMessage): boolean {
  return raw.t === 'e2e' || raw.t === 'message_pinned_e2e';
}

/** Decrypts one payload with the best matching key, reporting precise reasons. */
export async function decryptWithKeyring(
  payload: string | EncryptedContent,
  keyring: RoomKeyring | undefined,
): Promise<{ content: DecryptedContent; decoded: DecodedPayload; keySource: KeySource }> {
  const decoded = decodeEncryptedContent(payload);
  if (!keyring) throw new E2eeError('no-room-key', 'no room key available for this room');
  const candidates = keyring.candidatesFor(decoded.kid);
  if (candidates.length === 0) {
    throw new E2eeError(keyring.problems.length ? 'room-key-undecryptable' : 'no-room-key', describe(keyring));
  }
  let exactError: unknown;
  let fallbackError: unknown;
  for (const { key, exact } of candidates) {
    try {
      const content = await decryptPayload(decoded, key);
      return { content, decoded, keySource: key.source };
    } catch (error) {
      if (exact) {
        exactError ??= error;
      } else if (isE2eeError(error) && error.reason === 'decryption-failed') {
        fallbackError = new E2eeError(
          'room-key-missing',
          `no key for key id ${decoded.kid}; held keys: ${keyring.keyIds.join(', ') || 'none'}`,
          { cause: error },
        );
      } else {
        fallbackError = error;
      }
    }
  }
  // A failure with the key the message names is more precise than a failed fallback attempt.
  throw exactError ?? fallbackError;
}

function describe(keyring: RoomKeyring): string {
  if (keyring.problems.length) {
    return `room key(s) ${keyring.problems.map((p) => p.keyId || '(no id)').join(', ')} could not be unwrapped`;
  }
  return 'this account has not received a key for this room yet';
}

function failure(error: unknown, kid?: string, codec?: string): DecryptionInfo {
  if (isE2eeError(error)) {
    return {
      state: 'undecryptable',
      reason: error.reason,
      detail: error.message,
      ...(kid ? { kid } : {}),
      ...(codec ? { codec } : {}),
    };
  }
  return { state: 'undecryptable', reason: 'decryption-failed', detail: String(error) };
}

function peekKid(payload: unknown): { kid?: string; codec?: string } {
  try {
    if (typeof payload === 'string' || isEncryptedContent(payload)) {
      const d = decodeEncryptedContent(payload as string | EncryptedContent);
      return { kid: d.kid, codec: d.codec };
    }
  } catch {
    // reported by the main path
  }
  return isEncryptedContent(payload) ? { codec: payload.algorithm } : {};
}

function isRemovedFileAttachment(att: unknown): att is { type: 'removed-file'; fileId?: string } {
  return typeof att === 'object' && att !== null && (att as { type?: unknown }).type === 'removed-file';
}

function mergeContent<T extends RawMessage>(raw: T, content: DecryptedContent): T & { msg: string } {
  const removed = (raw.attachments ?? []).filter(isRemovedFileAttachment);
  const merged = { ...raw, ...content } as T & { msg: string };
  if (typeof merged.msg !== 'string') merged.msg = '';
  if (removed.length && Array.isArray(merged.attachments)) {
    const removeAll = removed.find((r) => !r.fileId);
    merged.attachments = merged.attachments.map((att) => {
      const fileId = (att as { fileId?: string }).fileId;
      if (removeAll && fileId) return removeAll;
      return removed.find((r) => r.fileId && r.fileId === fileId) ?? att;
    });
  }
  return merged;
}

export async function decryptMessage<T extends RawMessage>(
  raw: T,
  keyring: RoomKeyring | undefined,
): Promise<DecryptedMessage<T>> {
  if (raw.t === 'message_pinned_e2e') {
    const [first, ...rest] = (raw.attachments ?? []) as Array<Record<string, unknown>>;
    if (!first || !isEncryptedContent(first.content)) {
      return { message: { ...raw, msg: raw.msg ?? '' }, decryption: { state: 'plaintext' } };
    }
    try {
      const { content, decoded, keySource } = await decryptWithKeyring(first.content, keyring);
      return {
        message: { ...raw, msg: raw.msg ?? '', attachments: [{ ...first, text: content.msg ?? '' }, ...rest] },
        decryption: { state: 'decrypted', codec: decoded.codec, kid: decoded.kid, keySource },
      };
    } catch (error) {
      const { kid, codec } = peekKid(first.content);
      return { message: { ...raw, msg: raw.msg ?? '' }, decryption: failure(error, kid, codec) };
    }
  }

  if (raw.t !== 'e2e') {
    return { message: { ...raw, msg: raw.msg ?? '' }, decryption: { state: 'plaintext' } };
  }

  const payload: unknown =
    raw.content !== undefined && raw.content !== null ? raw.content : raw.msg ? raw.msg : undefined;
  if (payload === undefined) {
    // An e2e message without any payload (e.g. a file message sent before the room key was ready).
    return {
      message: { ...raw, msg: '' },
      decryption: { state: 'decrypted', codec: 'none', kid: '', keySource: 'current' },
    };
  }
  if (!(typeof payload === 'string' || isEncryptedContent(payload))) {
    return {
      message: { ...raw, msg: '' },
      decryption: { state: 'undecryptable', reason: 'malformed-payload', detail: 'unrecognised encrypted payload' },
    };
  }
  try {
    const { content, decoded, keySource } = await decryptWithKeyring(payload, keyring);
    return {
      message: mergeContent(raw, content),
      decryption: { state: 'decrypted', codec: decoded.codec, kid: decoded.kid, keySource },
    };
  } catch (error) {
    const { kid, codec } = peekKid(payload);
    return { message: { ...raw, msg: '' }, decryption: failure(error, kid, codec) };
  }
}
