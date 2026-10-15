/**
 * Why something could not be decrypted. Every undecryptable item carries one of these so callers (and the LLM)
 * can tell "no key" from "wrong password" from "unsupported format".
 */
export type E2eeFailureReason =
  /** RC_E2EE_PASSWORD is not configured. */
  | 'no-e2ee-password'
  /** The account has no E2EE key pair on the server (E2EE never set up). */
  | 'no-user-keys'
  /** The E2EE password does not decrypt the stored private key. */
  | 'wrong-password'
  /** The password contains characters the official client cannot use either. */
  | 'unsupported-password'
  /** No room key is available for this room at all. */
  | 'no-room-key'
  /** A room key exists but not for the key id the message was encrypted with (e.g. older than the kept history). */
  | 'room-key-missing'
  /** A room key could not be unwrapped with our private key (the key pair changed since it was shared). */
  | 'room-key-undecryptable'
  /** The payload uses an algorithm this version does not implement (e.g. Matrix federation megolm). */
  | 'unsupported-algorithm'
  /** The payload is structurally invalid (bad base64, truncated, missing fields). */
  | 'malformed-payload'
  /** AES decryption failed: authentication tag mismatch / bad padding, i.e. wrong key or corrupted data. */
  | 'decryption-failed'
  /** Decrypted bytes are not the EJSON object the client produces. */
  | 'invalid-plaintext'
  /** Encrypted upload: content metadata had no key/iv. */
  | 'file-key-missing'
  /** Encrypted upload: plaintext SHA-256 differs from the hash recorded by the uploader. */
  | 'file-hash-mismatch';

export class E2eeError extends Error {
  override name = 'E2eeError';
  readonly reason: E2eeFailureReason;

  constructor(reason: E2eeFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}

export function isE2eeError(error: unknown): error is E2eeError {
  return error instanceof E2eeError;
}
