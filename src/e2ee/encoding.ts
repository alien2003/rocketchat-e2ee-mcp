/**
 * Byte/string conversions with exactly the semantics of Rocket.Chat's client
 * (apps/meteor/client/lib/e2ee/binary.ts and packages/base64 at 8.9.0).
 */
import { E2eeError } from './errors.ts';

const B64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard base64 (RFC 4648 §4, with or without padding), strict: anything else is malformed input. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (!B64_ALPHABET.test(input) || input.length % 4 === 1) {
    throw new E2eeError('malformed-payload', 'invalid base64 data');
  }
  return new Uint8Array(Buffer.from(input, 'base64'));
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Rocket.Chat's `Binary.decode`: one byte per UTF-16 code unit, rejecting code units above 0xFF.
 * Used for the E2EE password and PBKDF2 salt (so a password is NOT UTF-8 encoded) and for JWK strings.
 */
export function binaryStringToBytes(input: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 0xff) {
      throw new E2eeError(
        'unsupported-password',
        'contains characters outside Latin-1, which the Rocket.Chat client cannot use as key material',
      );
    }
    out[i] = code;
  }
  return out;
}

/** Rocket.Chat's `Binary.encode`: each byte becomes one char code. */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}
