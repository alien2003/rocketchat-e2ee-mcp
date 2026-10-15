/**
 * The user's unlocked E2EE state: private key + per-room keyrings. Holds keys in memory only.
 */
import { E2eeError, type E2eeFailureReason, isE2eeError } from './errors.ts';
import { buildKeyring, type RoomKeyring, type SubscriptionKeyMaterial } from './keyring.ts';
import { type StoredPrivateKeyVersion, unlockPrivateKey } from './private-key.ts';
import type { CryptoKey } from './webcrypto.ts';

export interface MyKeys {
  public_key?: string | null;
  private_key?: string | null;
}

export type SessionState =
  | { status: 'ready'; privateKeyFormat: StoredPrivateKeyVersion }
  | { status: 'unavailable'; reason: E2eeFailureReason; detail: string };

export class E2eeSession {
  readonly state: SessionState;
  private readonly privateKey: CryptoKey | undefined;
  private readonly keyrings = new Map<string, { fingerprint: string; keyring: Promise<RoomKeyring> }>();

  private constructor(state: SessionState, privateKey?: CryptoKey) {
    this.state = state;
    this.privateKey = privateKey;
  }

  static unavailable(reason: E2eeFailureReason, detail: string): E2eeSession {
    return new E2eeSession({ status: 'unavailable', reason, detail });
  }

  /** Unlocks the private key. Never throws for expected conditions; inspect `state` instead. */
  static async open(params: { userId: string; password: string | undefined; keys: MyKeys }): Promise<E2eeSession> {
    if (!params.keys.private_key || !params.keys.public_key) {
      return E2eeSession.unavailable('no-user-keys', 'this account has no E2EE keys on the server');
    }
    if (!params.password) {
      return E2eeSession.unavailable('no-e2ee-password', 'RC_E2EE_PASSWORD is not set');
    }
    try {
      const { key, version, publicModulus } = await unlockPrivateKey(
        params.keys.private_key,
        params.password,
        params.userId,
      );
      const publicJwk = JSON.parse(params.keys.public_key) as { n?: string };
      if (publicJwk.n && publicJwk.n !== publicModulus) {
        return E2eeSession.unavailable('wrong-password', 'decrypted private key does not match the public key');
      }
      return new E2eeSession({ status: 'ready', privateKeyFormat: version }, key);
    } catch (error) {
      if (isE2eeError(error)) return E2eeSession.unavailable(error.reason, error.message);
      return E2eeSession.unavailable('wrong-password', 'could not unlock the private key');
    }
  }

  get ready(): boolean {
    return this.state.status === 'ready';
  }

  /** Returns (cached) keyring for a subscription; recomputed when its key material changes. */
  keyringFor(sub: SubscriptionKeyMaterial): Promise<RoomKeyring> {
    if (!this.privateKey) {
      const reason = this.state.status === 'unavailable' ? this.state.reason : 'no-e2ee-password';
      return Promise.reject(new E2eeError(reason, 'E2EE is not unlocked'));
    }
    const fingerprint = JSON.stringify([
      sub.E2EKey ?? null,
      sub.E2ESuggestedKey ?? null,
      (sub.oldRoomKeys ?? []).map((k) => k.e2eKeyId),
      (sub.suggestedOldRoomKeys ?? []).map((k) => k.e2eKeyId),
    ]);
    const cached = this.keyrings.get(sub.rid);
    if (cached && cached.fingerprint === fingerprint) return cached.keyring;
    const keyring = buildKeyring(sub, this.privateKey);
    this.keyrings.set(sub.rid, { fingerprint, keyring });
    return keyring;
  }
}
