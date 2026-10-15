/**
 * Legacy formats that current clients no longer produce, checked against the public test vectors shipped in
 * Rocket.Chat's own repository (extracted by scripts/extract-upstream-vectors.ts, see the JSON's `source`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKeyring } from '../../../src/e2ee/keyring.ts';
import { decryptMessage } from '../../../src/e2ee/message.ts';
import { decodeStoredPrivateKey, decryptStoredPrivateKey, importPrivateKey } from '../../../src/e2ee/private-key.ts';
import { E2eeSession } from '../../../src/e2ee/session.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const v = JSON.parse(readFileSync(join(REPO_ROOT, 'test/fixtures/upstream/legacy-v1.json'), 'utf8')) as {
  user: {
    userId: string;
    e2ePassword: string;
    storedPrivateKey: string;
    publicKey: string;
    decryptedPrivateKeyJwk: string;
  };
  room: { e2eKey: string; kid: string };
  message: { msg: string; expectedText: string };
};

describe('upstream legacy vectors (Rocket.Chat test fixtures)', () => {
  it('detects the v1 {"$binary"} private key format: salt = userId, 1000 iterations, AES-CBC (16-byte IV)', () => {
    const decoded = decodeStoredPrivateKey(v.user.storedPrivateKey, v.user.userId);
    expect(decoded).toMatchObject({ version: 'v1', salt: 'userE2EE', iterations: 1000 });
    expect(decoded.iv.length).toBe(16);
  });

  it('decrypts the v1 private key to exactly the JWK the client stores', async () => {
    const jwk = await decryptStoredPrivateKey(v.user.storedPrivateKey, v.user.e2ePassword, v.user.userId);
    expect(JSON.parse(jwk)).toEqual(JSON.parse(v.user.decryptedPrivateKeyJwk));
  });

  it('opens a session (public key matches) and rejects a wrong password', async () => {
    const keys = { public_key: v.user.publicKey, private_key: v.user.storedPrivateKey };
    const ok = await E2eeSession.open({ userId: v.user.userId, password: v.user.e2ePassword, keys });
    expect(ok.state).toEqual({ status: 'ready', privateKeyFormat: 'v1' });
    const bad = await E2eeSession.open({ userId: v.user.userId, password: 'minus mobile dexter forest', keys });
    expect(bad.state).toMatchObject({ status: 'unavailable', reason: 'wrong-password' });
    const wrongSalt = await E2eeSession.open({ userId: 'someone-else', password: v.user.e2ePassword, keys });
    expect(wrongSalt.state).toMatchObject({ status: 'unavailable', reason: 'wrong-password' });
  });

  it('unwraps the legacy 12-char-id A128CBC room key and decrypts the legacy `msg` payload', async () => {
    const privateKey = await importPrivateKey(v.user.decryptedPrivateKeyJwk);
    const ring = await buildKeyring({ rid: 'legacy-room', E2EKey: v.room.e2eKey }, privateKey);
    expect(ring.status).toBe('ok');
    expect(ring.current).toMatchObject({ keyId: v.room.kid, algorithm: 'A128CBC' });
    const { message, decryption } = await decryptMessage(
      { _id: 'm1', rid: 'legacy-room', t: 'e2e', msg: v.message.msg },
      ring,
    );
    expect(decryption).toEqual({ state: 'decrypted', codec: 'rc.v1.aes-sha2', kid: v.room.kid, keySource: 'current' });
    expect(message.msg).toBe(v.message.expectedText);
  });
});
