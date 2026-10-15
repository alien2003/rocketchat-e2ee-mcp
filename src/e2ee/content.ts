/**
 * Encrypted message/upload content codecs. Port of apps/meteor/client/lib/e2ee/content.ts and
 * `E2ERoom.decrypt` (rocketchat.e2e.room.ts) at 8.9.0. Versioned so new formats can be registered.
 *
 *   rc.v1.aes-sha2  ciphertext = kid(12 chars) + base64(iv[16] || ciphertext); a bare string payload (legacy
 *                   `msg` field) is treated as v1. Legacy room keys are AES-CBC-128.
 *   rc.v2.aes-sha2  { kid, iv: base64(12 bytes), ciphertext: base64 } with AES-GCM-256.
 *
 * The plaintext is UTF-8 EJSON: `{ msg, attachments?, files?, file? }` (current) or `{ text, ... }` (legacy).
 */

import { parseEjson } from './ejson.ts';
import { base64ToBytes } from './encoding.ts';
import { E2eeError } from './errors.ts';
import type { RoomKey } from './room-key.ts';

import { subtle } from './webcrypto.ts';

export interface EncryptedContent {
  algorithm: string;
  ciphertext: string;
  iv?: string;
  kid?: string;
}

export interface DecodedPayload {
  codec: string;
  kid: string;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

export interface ContentCodec {
  algorithm: string;
  decode(payload: EncryptedContent): DecodedPayload;
}

const v1: ContentCodec = {
  algorithm: 'rc.v1.aes-sha2',
  decode(payload) {
    if (payload.ciphertext.length < 12) throw new E2eeError('malformed-payload', 'v1 ciphertext too short for kid');
    const kid = payload.ciphertext.slice(0, 12);
    const raw = base64ToBytes(payload.ciphertext.slice(12));
    if (raw.length < 16) throw new E2eeError('malformed-payload', 'v1 ciphertext too short for iv');
    return { codec: this.algorithm, kid, iv: raw.slice(0, 16), ciphertext: raw.slice(16) };
  },
};

const v2: ContentCodec = {
  algorithm: 'rc.v2.aes-sha2',
  decode(payload) {
    if (!payload.kid || !payload.iv || !payload.ciphertext) {
      throw new E2eeError('malformed-payload', 'v2 payload needs kid, iv and ciphertext');
    }
    return {
      codec: this.algorithm,
      kid: payload.kid,
      iv: base64ToBytes(payload.iv),
      ciphertext: base64ToBytes(payload.ciphertext),
    };
  },
};

const CODECS = new Map<string, ContentCodec>([
  [v1.algorithm, v1],
  [v2.algorithm, v2],
]);

/** Registers an additional content codec (for future formats). */
export function registerContentCodec(codec: ContentCodec): void {
  CODECS.set(codec.algorithm, codec);
}

export function isEncryptedContent(value: unknown): value is EncryptedContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EncryptedContent).algorithm === 'string' &&
    typeof (value as EncryptedContent).ciphertext === 'string'
  );
}

/** Normalises the legacy bare-string payload to a v1 object, then decodes it with the matching codec. */
export function decodeEncryptedContent(payload: string | EncryptedContent): DecodedPayload {
  const normalized: EncryptedContent =
    typeof payload === 'string' ? { algorithm: 'rc.v1.aes-sha2', ciphertext: payload } : payload;
  const codec = CODECS.get(normalized.algorithm);
  if (!codec) {
    throw new E2eeError('unsupported-algorithm', `encryption algorithm ${normalized.algorithm} is not supported`);
  }
  return codec.decode(normalized);
}

/** The decrypted fields the client merges back into the message (Object.assign semantics). */
export interface DecryptedContent {
  msg?: string;
  attachments?: unknown[];
  files?: unknown[];
  file?: unknown;
  [key: string]: unknown;
}

/** AES-decrypts a decoded payload with a room key and parses the EJSON plaintext like `E2ERoom.decrypt`. */
export async function decryptPayload(decoded: DecodedPayload, roomKey: RoomKey): Promise<DecryptedContent> {
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: roomKey.key.algorithm.name, iv: decoded.iv }, roomKey.key, decoded.ciphertext);
  } catch (error) {
    throw new E2eeError('decryption-failed', `could not decrypt with room key ${roomKey.keyId}`, { cause: error });
  }
  let parsed: unknown;
  try {
    // Same as the browser client: invalid UTF-8 sequences become U+FFFD instead of failing.
    parsed = parseEjson(new TextDecoder('utf-8').decode(plain));
  } catch (error) {
    throw new E2eeError('invalid-plaintext', 'decrypted content is not UTF-8 EJSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new E2eeError('invalid-plaintext', 'decrypted content is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  // Legacy clients encrypted `{ text }`; current ones `{ msg }` (see E2ERoom.decrypt).
  if (typeof obj.text === 'string' && !('msg' in obj)) {
    const { text, ...rest } = obj;
    return { msg: text, ...rest };
  }
  return obj as DecryptedContent;
}
