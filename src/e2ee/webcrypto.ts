/** WebCrypto types/handles shared by the E2EE codecs (Node's globalThis.crypto is the WebCrypto API). */
import type { webcrypto } from 'node:crypto';

export type CryptoKey = webcrypto.CryptoKey;
export type JsonWebKey = webcrypto.JsonWebKey;

export const subtle: webcrypto.SubtleCrypto = globalThis.crypto.subtle;
