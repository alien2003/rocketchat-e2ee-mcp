/**
 * Encrypted uploads. Port of `E2ERoom.encryptFile` / apps/meteor/public/enc.js (8.9.0), decrypt side only.
 *
 * Each file has its own AES-CTR-256 key (JWK) and a 16-byte initial counter block (`iv`, base64) with a 64-bit
 * counter (`length: 64`). Ciphertext length equals plaintext length; there is no tag. The uploader records the
 * hex SHA-256 of the plaintext in `hashes.sha256`; the official client never checks it, we do (when present).
 */
import { base64ToBytes, bytesToHex } from './encoding.ts';
import { E2eeError } from './errors.ts';

import { type CryptoKey, type JsonWebKey, subtle } from './webcrypto.ts';

export interface FileEncryption {
  key: JsonWebKey;
  iv: string;
}

export interface DecryptedFile {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  integrity: 'verified' | 'unverified';
}

export async function decryptFile(
  ciphertext: Uint8Array<ArrayBuffer>,
  encryption: FileEncryption | undefined,
  expectedSha256?: string,
): Promise<DecryptedFile> {
  if (!encryption?.key || typeof encryption.iv !== 'string') {
    throw new E2eeError('file-key-missing', 'encrypted file has no key/iv in its decrypted metadata');
  }
  const counter = base64ToBytes(encryption.iv);
  if (counter.length !== 16) throw new E2eeError('malformed-payload', 'file iv must be 16 bytes');
  let key: CryptoKey;
  try {
    key = await subtle.importKey('jwk', encryption.key, { name: 'AES-CTR' }, false, ['decrypt']);
  } catch (error) {
    throw new E2eeError('malformed-payload', 'file key is not a valid AES-CTR JWK', { cause: error });
  }
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, key, ciphertext));
  const sha256 = bytesToHex(new Uint8Array(await subtle.digest('SHA-256', plain)));
  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
    throw new E2eeError('file-hash-mismatch', 'decrypted file does not match the uploader-recorded SHA-256');
  }
  return { bytes: plain, sha256, integrity: expectedSha256 ? 'verified' : 'unverified' };
}
