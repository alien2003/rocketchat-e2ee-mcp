/**
 * Failure reporting and parsing edge cases. Inputs are the committed real-client fixtures, deliberately damaged;
 * no test here encrypts anything with our own code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEncryptedContent } from '../../../src/e2ee/content.ts';
import { parseEjson } from '../../../src/e2ee/ejson.ts';
import { base64ToBytes, binaryStringToBytes } from '../../../src/e2ee/encoding.ts';
import { decryptFile } from '../../../src/e2ee/file.ts';
import { buildKeyring } from '../../../src/e2ee/keyring.ts';
import { decryptMessage, type RawMessage } from '../../../src/e2ee/message.ts';
import { E2eeSession } from '../../../src/e2ee/session.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const DIR = join(REPO_ROOT, 'test', 'fixtures', '8.9.0');
const read = <T>(rel: string): T => JSON.parse(readFileSync(join(DIR, rel), 'utf8')) as T;
const expected = read<{
  users: Record<'alice' | 'bob', { userId: string; e2eePassword: string }>;
  messages: Array<{ label: string; msgId: string; room: string; file?: unknown }>;
}>('expected.json');

async function aliceSession() {
  return E2eeSession.open({
    userId: expected.users.alice.userId,
    password: expected.users.alice.e2eePassword,
    keys: read('rest/alice/e2e.fetchMyKeys.json'),
  });
}
const groupSub = (who: string) =>
  read<{ subscription: Parameters<E2eeSession['keyringFor']>[0] }>(`rest/${who}/group.subscriptions.getOne.json`)
    .subscription;
const groupMessages = () => read<{ messages: RawMessage[] }>('rest/alice/group.groups.history.json').messages;
const firstText = () => {
  const id = expected.messages.find((m) => m.label === 'M1-plain')?.msgId;
  return groupMessages().find((m) => m._id === id) as RawMessage;
};

describe('E2EE failure modes', () => {
  it('no E2EE password configured -> session unavailable(no-e2ee-password)', async () => {
    const s = await E2eeSession.open({
      userId: 'x',
      password: undefined,
      keys: read('rest/alice/e2e.fetchMyKeys.json'),
    });
    expect(s.state).toMatchObject({ status: 'unavailable', reason: 'no-e2ee-password' });
  });

  it('account without E2EE keys -> no-user-keys', async () => {
    const s = await E2eeSession.open({ userId: 'x', password: 'p', keys: {} });
    expect(s.state).toMatchObject({ status: 'unavailable', reason: 'no-user-keys' });
  });

  it('a password with characters outside Latin-1 is reported, like the official client rejects it', async () => {
    const s = await E2eeSession.open({
      userId: expected.users.alice.userId,
      password: 'pässwörd 🔑',
      keys: read('rest/alice/e2e.fetchMyKeys.json'),
    });
    expect(s.state).toMatchObject({ status: 'unavailable', reason: 'unsupported-password' });
    expect(() => binaryStringToBytes('é')).not.toThrow();
  });

  it('tampered ciphertext fails AES-GCM authentication -> decryption-failed', async () => {
    const ring = await (await aliceSession()).keyringFor(groupSub('alice'));
    const raw = firstText();
    const content = raw.content as { ciphertext: string };
    const bytes = base64ToBytes(content.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = { ...raw, content: { ...content, ciphertext: Buffer.from(bytes).toString('base64') } };
    const { decryption, message } = await decryptMessage(tampered, ring);
    expect(decryption).toMatchObject({ state: 'undecryptable', reason: 'decryption-failed' });
    expect(message.msg).toBe('');
  });

  it('no keyring at all -> no-room-key (message kept, not dropped)', async () => {
    const { decryption, message } = await decryptMessage(firstText(), undefined);
    expect(decryption).toMatchObject({ state: 'undecryptable', reason: 'no-room-key' });
    expect(message._id).toBe(firstText()._id);
  });

  it("a room key wrapped for someone else's key pair -> keyring status undecryptable", async () => {
    const session = await aliceSession();
    const bobSub = groupSub('bob');
    const ring = await session.keyringFor({ ...bobSub, rid: 'other-room' });
    expect(ring.status).toBe('undecryptable');
    expect(ring.problems[0]).toMatchObject({ source: 'current', reason: 'room-key-undecryptable' });
    const { decryption } = await decryptMessage(firstText(), ring);
    expect(decryption).toMatchObject({ state: 'undecryptable', reason: 'room-key-undecryptable' });
  });

  it('a suggested-only key is used read-only and reported as such', async () => {
    const session = await aliceSession();
    const sub = groupSub('alice');
    const ring = await session.keyringFor({
      rid: 'suggested-room',
      E2ESuggestedKey: sub.E2EKey,
      oldRoomKeys: sub.oldRoomKeys,
    });
    expect(ring.status).toBe('suggested');
  });

  it('unsupported and malformed payloads are reported, not thrown away', async () => {
    expect(() => decodeEncryptedContent({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' })).toThrow(
      expect.objectContaining({ reason: 'unsupported-algorithm' }),
    );
    expect(() => decodeEncryptedContent({ algorithm: 'rc.v2.aes-sha2', ciphertext: 'AAAA' })).toThrow(
      expect.objectContaining({ reason: 'malformed-payload' }),
    );
    const megolm = { _id: 'm', rid: 'r', t: 'e2e', content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'abc' } };
    const res = await decryptMessage(megolm, undefined);
    expect(res.decryption).toMatchObject({ state: 'undecryptable', reason: 'unsupported-algorithm' });
  });

  it('plaintext messages pass through untouched', async () => {
    const res = await decryptMessage({ _id: 'p', rid: 'r', msg: 'hello', u: { _id: 'u' } }, undefined);
    expect(res).toMatchObject({ decryption: { state: 'plaintext' }, message: { msg: 'hello' } });
  });

  it('a corrupted file fails the uploader-recorded SHA-256 check', async () => {
    const id = expected.messages.find((m) => m.label === 'M7-file-text')?.msgId;
    const raw = groupMessages().find((m) => m._id === id) as RawMessage;
    const ring = await (await aliceSession()).keyringFor(groupSub('alice'));
    const { message } = await decryptMessage(raw, ring);
    const att = (message.attachments as Array<{ fileId: string; encryption: never; hashes: { sha256: string } }>)[0];
    if (!att) throw new Error('no attachment');
    const cipher = new Uint8Array(readFileSync(join(DIR, 'files', `${att.fileId}.bin`)));
    cipher[0] = (cipher[0] ?? 0) ^ 1;
    await expect(decryptFile(cipher, att.encryption, att.hashes.sha256)).rejects.toMatchObject({
      reason: 'file-hash-mismatch',
    });
    await expect(decryptFile(cipher, undefined)).rejects.toMatchObject({ reason: 'file-key-missing' });
  });

  it('strict base64 and EJSON revival', () => {
    expect(() => base64ToBytes('ab$c')).toThrow(expect.objectContaining({ reason: 'malformed-payload' }));
    expect(
      parseEjson('{"ts":{"$date":0},"b":{"$binary":"AQI="},"n":{"$InfNaN":-1},"e":{"$escape":{"$date":"x"}}}'),
    ).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      b: 'AQI=',
      n: Number.NEGATIVE_INFINITY,
      e: { $date: 'x' },
    });
  });

  it('keyrings are cached per room until the key material changes', async () => {
    const session = await aliceSession();
    const sub = groupSub('alice');
    const a = await session.keyringFor(sub);
    expect(await session.keyringFor(sub)).toBe(a);
    const b = await session.keyringFor({ ...sub, oldRoomKeys: [] });
    expect(b).not.toBe(a);
    expect(b.old.size).toBe(0);
    // buildKeyring is the uncached primitive
    expect(
      (
        await buildKeyring(
          { rid: 'empty' },
          (
            await (
              await import('node:crypto')
            ).webcrypto.subtle.generateKey(
              { name: 'RSA-OAEP', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
              false,
              ['decrypt', 'encrypt'],
            )
          ).privateKey,
        )
      ).status,
    ).toBe('missing');
  });
});
