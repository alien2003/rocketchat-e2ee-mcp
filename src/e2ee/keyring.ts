/**
 * Per-room set of usable keys, built from the user's subscription:
 *   E2EKey            current room key (accepted)
 *   E2ESuggestedKey   room key re-shared by another member but not yet accepted by an official client;
 *                     used read-only here, never accepted (see ADR 0001 §5)
 *   oldRoomKeys[]     keys from before room-key resets ({ e2eKeyId, ts, E2EKey }), newest first, max 10 kept
 */
import { E2eeError, type E2eeFailureReason, isE2eeError } from './errors.ts';
import { type RoomKey, unwrapRoomKey } from './room-key.ts';
import type { CryptoKey } from './webcrypto.ts';

export interface SubscriptionKeyMaterial {
  rid: string;
  E2EKey?: string | null;
  E2ESuggestedKey?: string | null;
  oldRoomKeys?: Array<{ e2eKeyId: string; ts?: unknown; E2EKey: string }> | null;
}

export type KeySource = 'current' | 'suggested' | 'old';

export interface KeyringKey extends RoomKey {
  source: KeySource;
}

export type KeyStatus =
  /** A current room key is available. */
  | 'ok'
  /** Only a not-yet-accepted suggested key is available (readable; open the official client to accept it). */
  | 'suggested'
  /** The subscription carries no room key at all (waiting for another member to share it). */
  | 'missing'
  /** Key material exists but could not be unwrapped with this user's private key. */
  | 'undecryptable';

export interface KeyProblem {
  keyId: string;
  source: KeySource;
  reason: E2eeFailureReason;
}

export class RoomKeyring {
  readonly rid: string;
  readonly current: KeyringKey | undefined;
  readonly old: ReadonlyMap<string, KeyringKey>;
  readonly problems: readonly KeyProblem[];

  constructor(rid: string, current: KeyringKey | undefined, old: Map<string, KeyringKey>, problems: KeyProblem[]) {
    this.rid = rid;
    this.current = current;
    this.old = old;
    this.problems = problems;
  }

  get status(): KeyStatus {
    if (this.current?.source === 'current') return 'ok';
    if (this.current?.source === 'suggested') return 'suggested';
    return this.problems.length > 0 ? 'undecryptable' : 'missing';
  }

  get keyIds(): string[] {
    return [...(this.current ? [this.current.keyId] : []), ...this.old.keys()];
  }

  /**
   * Candidate keys for a message key id, in the client's order: an old key with that id, else the current key
   * (the official client also falls back to the current key when the id is unknown).
   */
  candidatesFor(kid: string): { key: KeyringKey; exact: boolean }[] {
    const out: { key: KeyringKey; exact: boolean }[] = [];
    const old = this.old.get(kid);
    if (old) out.push({ key: old, exact: true });
    if (this.current && this.current !== old) out.push({ key: this.current, exact: this.current.keyId === kid });
    return out;
  }
}

async function tryUnwrap(
  wrapped: string,
  privateKey: CryptoKey,
  source: KeySource,
  problems: KeyProblem[],
  fallbackId: string,
): Promise<KeyringKey | undefined> {
  try {
    return { ...(await unwrapRoomKey(wrapped, privateKey)), source };
  } catch (error) {
    problems.push({ keyId: fallbackId, source, reason: isE2eeError(error) ? error.reason : 'room-key-undecryptable' });
    return undefined;
  }
}

export async function buildKeyring(sub: SubscriptionKeyMaterial, privateKey: CryptoKey): Promise<RoomKeyring> {
  const problems: KeyProblem[] = [];
  let current: KeyringKey | undefined;
  if (sub.E2EKey) {
    current = await tryUnwrap(sub.E2EKey, privateKey, 'current', problems, prefixOf(sub.E2EKey));
  }
  if (!current && sub.E2ESuggestedKey) {
    current = await tryUnwrap(sub.E2ESuggestedKey, privateKey, 'suggested', problems, prefixOf(sub.E2ESuggestedKey));
  }
  const old = new Map<string, KeyringKey>();
  for (const entry of sub.oldRoomKeys ?? []) {
    if (!entry?.E2EKey) continue;
    const key = await tryUnwrap(entry.E2EKey, privateKey, 'old', problems, entry.e2eKeyId);
    // Index by the recorded id (what messages reference); the wrapped prefix normally matches it.
    if (key) old.set(entry.e2eKeyId || key.keyId, key);
  }
  return new RoomKeyring(sub.rid, current, old, problems);
}

function prefixOf(wrapped: string): string {
  return wrapped.length > 344 ? wrapped.slice(0, -344) : '';
}

export function noKeyError(rid: string): E2eeError {
  return new E2eeError('no-room-key', `no room key available for room ${rid}`);
}
