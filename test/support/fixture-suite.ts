/**
 * Assertions that our decryptor reproduces what the REAL Rocket.Chat web client produced and displayed.
 * Used by the unit layer (committed fixtures in test/fixtures/<version>) and by the ground-truth layer
 * (a fresh capture in .local/ground-truth/<version>). Nothing here encrypts: every ciphertext was produced by
 * Rocket.Chat's own client code (see scripts/generate-fixtures.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptFile } from '../../src/e2ee/file.ts';
import type { RoomKeyring } from '../../src/e2ee/keyring.ts';
import { decryptMessage, decryptWithKeyring, type RawMessage } from '../../src/e2ee/message.ts';
import { decodeStoredPrivateKey } from '../../src/e2ee/private-key.ts';
import { E2eeSession } from '../../src/e2ee/session.ts';
import type { JsonWebKey } from '../../src/e2ee/webcrypto.ts';

type Who = 'alice' | 'bob' | 'admin';
const REST_NAME: Record<Who, string> = { alice: 'alice', bob: 'bob', admin: 'rcadmin' };

interface ExpectedMessage {
  label: string;
  room: 'group' | 'dm';
  sender: Who;
  phase: 'pre-reset' | 'post-reset';
  msgId: string;
  tmid?: string;
  text: string;
  originalText?: string;
  quoteOfLabel?: string;
  file?: { name: string; type: string; contentFixture: string };
}

interface Expected {
  rcVersion: string;
  users: Record<Who, { userId: string; username: string; e2eePassword: string }>;
  rooms: { group: { rid: string; keyIds: { beforeReset: string; afterReset: string } }; dm: { rid: string } };
  messages: ExpectedMessage[];
  renderedByRealClient: Record<Who, Record<string, Record<string, string>>>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** Converts MongoDB canonical Extended JSON to the plain JSON shapes the REST API returns. */
function fromCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromCanonical);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('$date' in obj) {
      const d = obj.$date as { $numberLong?: string } | string;
      return new Date(typeof d === 'string' ? d : Number(d.$numberLong)).toISOString();
    }
    if ('$numberInt' in obj) return Number(obj.$numberInt);
    if ('$numberLong' in obj) return Number(obj.$numberLong);
    if ('$numberDouble' in obj) return Number(obj.$numberDouble);
    if ('$oid' in obj) return obj.$oid;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fromCanonical(v)]));
  }
  return value;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function hasFixtures(dir: string): boolean {
  return existsSync(join(dir, 'expected.json'));
}

export function describeFixtureSuite(dir: string): void {
  const expected = readJson<Expected>(join(dir, 'expected.json'));
  const rest = (who: Who, file: string) => readJson<Record<string, unknown>>(join(dir, 'rest', REST_NAME[who], file));
  const history = (who: Who, room: 'group' | 'dm') =>
    (rest(who, room === 'group' ? 'group.groups.history.json' : 'dm.im.history.json').messages ?? []) as RawMessage[];
  const subscription = (who: Who, room: 'group' | 'dm') =>
    rest(who, `${room}.subscriptions.getOne.json`).subscription as Parameters<E2eeSession['keyringFor']>[0] | undefined;
  const mongoMessages = fromCanonical(readJson(join(dir, 'mongo', 'rocketchat_message.json'))) as RawMessage[];

  const sessions = new Map<Who, Promise<E2eeSession>>();
  const sessionFor = (who: Who) => {
    let s = sessions.get(who);
    if (!s) {
      s = E2eeSession.open({
        userId: expected.users[who].userId,
        password: expected.users[who].e2eePassword,
        keys: rest(who, 'e2e.fetchMyKeys.json') as { public_key: string; private_key: string },
      });
      sessions.set(who, s);
    }
    return s;
  };
  const keyringFor = async (who: Who, room: 'group' | 'dm'): Promise<RoomKeyring | undefined> => {
    const sub = subscription(who, room);
    return sub ? (await sessionFor(who)).keyringFor(sub) : undefined;
  };

  describe(`real-client ground truth, Rocket.Chat ${expected.rcVersion}`, () => {
    for (const who of ['alice', 'bob', 'admin'] as const) {
      it(`${who}: the captured passphrase unlocks the stored private key (format v2)`, async () => {
        const keys = rest(who, 'e2e.fetchMyKeys.json') as { private_key: string };
        expect(decodeStoredPrivateKey(keys.private_key, expected.users[who].userId)).toMatchObject({
          version: 'v2',
          iterations: 100_000,
        });
        const session = await sessionFor(who);
        expect(session.state).toEqual({ status: 'ready', privateKeyFormat: 'v2' });
      });

      it(`${who}: a wrong passphrase is reported as wrong-password`, async () => {
        const session = await E2eeSession.open({
          userId: expected.users[who].userId,
          password: `${expected.users[who].e2eePassword} x`,
          keys: rest(who, 'e2e.fetchMyKeys.json') as { public_key: string; private_key: string },
        });
        expect(session.state).toMatchObject({ status: 'unavailable', reason: 'wrong-password' });
      });
    }

    it('room keys: members hold the post-reset key as current and the pre-reset key in oldRoomKeys', async () => {
      const { beforeReset, afterReset } = expected.rooms.group.keyIds;
      for (const who of ['alice', 'bob'] as const) {
        const ring = await keyringFor(who, 'group');
        expect(ring?.status).toBe('ok');
        expect(ring?.current?.keyId).toBe(afterReset);
        expect(ring?.current?.algorithm).toBe('A256GCM');
        expect([...(ring?.old.keys() ?? [])]).toEqual([beforeReset]);
        expect(ring?.problems).toEqual([]);
      }
      const adminRing = await keyringFor('admin', 'group');
      expect(adminRing?.current?.keyId).toBe(afterReset);
      expect(adminRing?.old.size).toBe(0);
    });

    for (const m of expected.messages) {
      const readers: Who[] = m.room === 'dm' ? ['alice', 'bob'] : ['alice', 'bob', 'admin'];
      for (const who of readers) {
        const canRead = !(who === 'admin' && m.phase === 'pre-reset');
        it(`${m.label}: ${who} ${canRead ? 'decrypts it exactly' : 'gets an explicit room-key-missing reason'}`, async () => {
          const raw = history(who, m.room).find((x) => x._id === m.msgId);
          expect(raw, `message ${m.msgId} in ${who}'s history`).toBeDefined();
          if (!raw) return;
          expect(raw.t).toBe('e2e');
          const result = await decryptMessage(raw, await keyringFor(who, m.room));
          if (!canRead) {
            expect(result.decryption).toMatchObject({
              state: 'undecryptable',
              reason: 'room-key-missing',
              kid: expected.rooms.group.keyIds.beforeReset,
            });
            expect(result.message.msg).toBe('');
            return;
          }
          expect(result.decryption).toMatchObject({ state: 'decrypted', codec: 'rc.v2.aes-sha2' });
          expect(result.message.msg).toBe(m.text);
          if (m.tmid) expect(result.message.tmid).toBe(m.tmid);
          if (m.originalText) {
            expect(result.message.editedAt).toBeTruthy();
            expect(result.message.msg).not.toBe(m.originalText);
          }
          if (m.quoteOfLabel) {
            const quoted = expected.messages.find((q) => q.label === m.quoteOfLabel);
            // The client prepends `[ ](<permalink>?msg=<id>)` and encrypts it; the server copy does not reveal it.
            expect(result.message.msg.startsWith('[ ](')).toBe(true);
            expect(result.message.msg).toContain(`?msg=${quoted?.msgId}`);
            expect(JSON.stringify(raw)).not.toContain(quoted?.msgId ?? '#');
          }
        });
      }

      it(`${m.label}: raw MongoDB document decrypts to the same result as the REST copy`, async () => {
        const raw = mongoMessages.find((x) => x._id === m.msgId);
        expect(raw).toBeDefined();
        if (!raw) return;
        const result = await decryptMessage(raw, await keyringFor(m.sender === 'admin' ? 'admin' : 'alice', m.room));
        expect(result.message.msg).toBe(m.text);
      });
    }

    for (const m of expected.messages.filter((x) => x.file)) {
      it(`${m.label}: encrypted upload decrypts byte-for-byte with SHA-256 verified`, async () => {
        const raw = history('alice', m.room).find((x) => x._id === m.msgId) as RawMessage;
        const { message } = await decryptMessage(raw, await keyringFor('alice', m.room));
        const att = (message.attachments as Array<Record<string, unknown>>)[0] as {
          title: string;
          fileId: string;
          encryption: { key: JsonWebKey; iv: string };
          hashes: { sha256: string };
        };
        const file = message.file as { name: string; type: string; _id: string };
        expect(att.title).toBe(m.file?.name);
        expect(file.name).toBe(m.file?.name);
        expect(file.type).toBe(m.file?.type);
        const cipher = new Uint8Array(readFileSync(join(dir, 'files', `${att.fileId}.bin`)));
        const plain = await decryptFile(cipher, att.encryption, att.hashes.sha256);
        expect(plain.integrity).toBe('verified');
        expect(Buffer.from(plain.bytes).equals(readFileSync(join(dir, m.file?.contentFixture ?? '')))).toBe(true);
        // The server only ever saw an opaque blob with a hashed name.
        expect(raw.file).toMatchObject({ type: 'application/octet-stream' });
        expect((raw.file as { name: string }).name).toMatch(/^[0-9a-f]{64}$/);
      });
    }

    it('upload records (groups.files / im.files): encrypted metadata decrypts to the real name and type', async () => {
      for (const room of ['group', 'dm'] as const) {
        const listing = rest('alice', room === 'group' ? 'group.groups.files.json' : 'dm.im.files.json');
        const files = (listing.files ?? []) as Array<{ _id: string; name: string; content?: unknown }>;
        const expectedNames = expected.messages.filter((x) => x.room === room && x.file).map((x) => x.file?.name);
        expect(files.length).toBe(expectedNames.length);
        const ring = await keyringFor('alice', room);
        for (const f of files) {
          const { content } = await decryptWithKeyring(f.content as never, ring);
          expect(expectedNames).toContain(content.name);
          expect(content).toHaveProperty('encryption.iv');
        }
      }
    });

    it('what the real web client rendered matches our plaintext (and its failures match ours)', async () => {
      // en.i18n.json at 8.9.0
      const NOT_YET_DECRYPTED = 'This message is end-to-end encrypted. To view it, you must enter your encryption key';
      const KEY_ERROR = 'This message is end-to-end encrypted and cannot be decrypted due to incorrect encryption key';
      let compared = 0;
      let preResetReadAfterReset = 0;
      for (const [who, phases] of Object.entries(expected.renderedByRealClient) as [
        Who,
        Record<string, Record<string, string>>,
      ][]) {
        for (const [capturePhase, byId] of Object.entries(phases)) {
          for (const [id, renderedText] of Object.entries(byId)) {
            const m = expected.messages.find((x) => x.msgId === id);
            if (!m || renderedText.startsWith(NOT_YET_DECRYPTED)) continue; // client had not decrypted it yet
            if (who === 'admin' && m.phase === 'pre-reset') {
              // We report room-key-missing; the official client shows its "incorrect encryption key" text.
              expect(renderedText).toBe(KEY_ERROR);
              continue;
            }
            expect(renderedText.startsWith(KEY_ERROR), `${who} ${capturePhase} ${m.label}`).toBe(false);
            const ours = m.quoteOfLabel ? m.text.replace(/^\[ \]\([^)]*\)\n/, '') : m.text;
            expect(normalize(renderedText), `${who} ${capturePhase} ${m.label}`).toContain(
              normalize(ours).slice(0, 40),
            );
            compared++;
            if (capturePhase === 'post-reset' && m.phase === 'pre-reset') preResetReadAfterReset++;
          }
        }
      }
      expect(compared).toBeGreaterThanOrEqual(10);
      // The official client, like us, reads pre-reset history through oldRoomKeys.
      expect(preResetReadAfterReset).toBeGreaterThanOrEqual(3);
    });
  });
}
