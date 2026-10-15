/**
 * Decrypts the user's RSA private key as stored by Rocket.Chat (`users.e2e.private_key`, returned by
 * `GET /api/v1/e2e.fetchMyKeys`). Port of apps/meteor/client/lib/e2ee/keychain.ts at 8.9.0.
 *
 * Stored formats (JSON strings):
 *   v1  {"$binary": base64(iv[16] || AES-CBC ciphertext)}           PBKDF2 salt = userId, 1000 iterations
 *   v2  {"iv": b64(iv[12]), "ciphertext": b64, "salt": "v2:<uid>:<uuid>", "iterations": 100000}   AES-GCM
 *
 * Key derivation (both versions): PBKDF2-HMAC-SHA256 over the password's Latin-1 bytes (`Binary.decode`) with
 * the salt's Latin-1 bytes, 256 output bits, imported as AES-CBC (16-byte IV) or AES-GCM (otherwise).
 * The plaintext is the private key JWK as a JSON string (RSA-OAEP-256).
 */
import { base64ToBytes, binaryStringToBytes, bytesToBinaryString } from './encoding.ts';
import { E2eeError } from './errors.ts';

import { type CryptoKey, type JsonWebKey, subtle } from './webcrypto.ts';

export type StoredPrivateKeyVersion = 'v1' | 'v2';

export interface DecodedStoredPrivateKey {
  version: StoredPrivateKeyVersion;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
  salt: string;
  iterations: number;
}

export function decodeStoredPrivateKey(stored: string, userId: string): DecodedStoredPrivateKey {
  let json: unknown;
  try {
    json = JSON.parse(stored);
  } catch (error) {
    throw new E2eeError('malformed-payload', 'stored private key is not JSON', { cause: error });
  }
  if (typeof json !== 'object' || json === null) {
    throw new E2eeError('malformed-payload', 'stored private key has an unknown format');
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.$binary === 'string') {
    const binary = base64ToBytes(obj.$binary);
    if (binary.length <= 16) throw new E2eeError('malformed-payload', 'v1 private key too short');
    return {
      version: 'v1',
      iv: binary.slice(0, 16),
      ciphertext: binary.slice(16),
      salt: userId,
      iterations: 1000,
    };
  }
  if (
    typeof obj.iv === 'string' &&
    typeof obj.ciphertext === 'string' &&
    typeof obj.salt === 'string' &&
    typeof obj.iterations === 'number'
  ) {
    return {
      version: 'v2',
      iv: base64ToBytes(obj.iv),
      ciphertext: base64ToBytes(obj.ciphertext),
      salt: obj.salt,
      iterations: obj.iterations,
    };
  }
  throw new E2eeError('malformed-payload', 'stored private key has an unknown format');
}

/** Derives the AES key protecting the private key, exactly like `Keychain.decryptKey`. */
export async function deriveMasterKey(password: string, salt: string, iterations: number, ivLength: number) {
  const baseKey = await subtle.importKey('raw', binaryStringToBytes(password), { name: 'PBKDF2' }, false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: binaryStringToBytes(salt), iterations },
    baseKey,
    256,
  );
  const name = ivLength === 16 ? 'AES-CBC' : 'AES-GCM';
  return subtle.importKey('raw', bits, { name, length: 256 }, false, ['decrypt']);
}

/** Returns the private key JWK as the exact string the client keeps in localStorage. */
export async function decryptStoredPrivateKey(stored: string, password: string, userId: string): Promise<string> {
  const decoded = decodeStoredPrivateKey(stored, userId);
  const key = await deriveMasterKey(password, decoded.salt, decoded.iterations, decoded.iv.length);
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: key.algorithm.name, iv: decoded.iv }, key, decoded.ciphertext);
  } catch (error) {
    throw new E2eeError('wrong-password', 'the E2EE password does not decrypt the stored private key', {
      cause: error,
    });
  }
  return bytesToBinaryString(new Uint8Array(plain));
}

export interface PrivateKeyJwk extends JsonWebKey {
  kty: 'RSA';
  n: string;
  e: string;
  d: string;
}

/** Imports the RSA-OAEP(SHA-256) private key for unwrapping room keys. */
export async function importPrivateKey(jwkString: string): Promise<CryptoKey> {
  let jwk: PrivateKeyJwk;
  try {
    jwk = JSON.parse(jwkString) as PrivateKeyJwk;
  } catch (error) {
    // CBC with a wrong key can still "succeed" with valid padding by chance; the result is then not JSON.
    throw new E2eeError('wrong-password', 'decrypted private key is not valid JSON', { cause: error });
  }
  if (jwk.kty !== 'RSA' || typeof jwk.d !== 'string') {
    throw new E2eeError('wrong-password', 'decrypted data is not an RSA private key');
  }
  return subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: { name: 'SHA-256' } }, false, ['decrypt']);
}

/** Full chain: stored private key + password -> usable RSA-OAEP CryptoKey (and the stored format version). */
export async function unlockPrivateKey(
  stored: string,
  password: string,
  userId: string,
): Promise<{ key: CryptoKey; version: StoredPrivateKeyVersion; publicModulus: string }> {
  const { version } = decodeStoredPrivateKey(stored, userId);
  const jwkString = await decryptStoredPrivateKey(stored, password, userId);
  const key = await importPrivateKey(jwkString);
  const publicModulus = (JSON.parse(jwkString) as PrivateKeyJwk).n;
  return { key, version, publicModulus };
}
