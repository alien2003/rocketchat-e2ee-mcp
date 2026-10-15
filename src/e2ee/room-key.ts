/**
 * Room ("group session") keys. Port of `PrefixedBase64`, `E2ERoom.importGroupKey` and `crypto/aes.ts` (8.9.0).
 *
 * A wrapped room key string (subscription `E2EKey`, `E2ESuggestedKey`, `oldRoomKeys[].E2EKey`) is
 *   <keyId prefix, any length> + base64(RSA-OAEP-SHA256(privateKey, JSON(JWK)))   (the base64 part is 344 chars)
 * The key id prefix is a UUID for keys created by current clients and 12 chars for legacy keys.
 * The JWK `alg` selects the cipher: A256GCM -> AES-GCM-256 (12-byte IV), A128CBC -> AES-CBC-128 (16-byte IV).
 */
import { base64ToBytes, bytesToBinaryString } from './encoding.ts';
import { E2eeError } from './errors.ts';

import { type CryptoKey, type JsonWebKey, subtle } from './webcrypto.ts';

const ENCODED_LENGTH = 344; // base64 of 256 bytes (RSA-2048 ciphertext)
const DECODED_LENGTH = 256;

export function splitWrappedRoomKey(wrapped: string): { keyId: string; ciphertext: Uint8Array<ArrayBuffer> } {
  if (typeof wrapped !== 'string' || wrapped.length < ENCODED_LENGTH) {
    throw new E2eeError('malformed-payload', 'wrapped room key is too short');
  }
  const keyId = wrapped.slice(0, -ENCODED_LENGTH);
  const ciphertext = base64ToBytes(wrapped.slice(-ENCODED_LENGTH));
  if (ciphertext.length !== DECODED_LENGTH) {
    throw new E2eeError('malformed-payload', 'wrapped room key does not decode to 256 bytes');
  }
  return { keyId, ciphertext };
}

const ALGORITHMS = {
  A256GCM: { name: 'AES-GCM', length: 256 },
  A128CBC: { name: 'AES-CBC', length: 128 },
} as const;

export type RoomKeyAlgorithm = keyof typeof ALGORITHMS;

export interface RoomKey {
  /** Key id from the wrapped key prefix (what messages reference as `kid`). */
  keyId: string;
  algorithm: RoomKeyAlgorithm;
  key: CryptoKey;
}

/** Unwraps a room key with the user's RSA private key. */
export async function unwrapRoomKey(wrapped: string, privateKey: CryptoKey): Promise<RoomKey> {
  const { keyId, ciphertext } = splitWrappedRoomKey(wrapped);
  let jwkString: string;
  try {
    jwkString = bytesToBinaryString(new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ciphertext)));
  } catch (error) {
    throw new E2eeError('room-key-undecryptable', `room key ${keyId || '(no id)'} is not wrapped for this key pair`, {
      cause: error,
    });
  }
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(jwkString) as JsonWebKey;
  } catch (error) {
    throw new E2eeError('malformed-payload', 'unwrapped room key is not a JWK', { cause: error });
  }
  const alg = jwk.alg as string | undefined;
  if (!alg || !(alg in ALGORITHMS)) {
    throw new E2eeError('unsupported-algorithm', `room key algorithm ${alg ?? '(none)'} is not supported`);
  }
  const algorithm = alg as RoomKeyAlgorithm;
  const key = await subtle.importKey('jwk', jwk, ALGORITHMS[algorithm], false, ['decrypt']);
  return { keyId, algorithm, key };
}
