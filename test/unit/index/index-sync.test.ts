import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { E2eeSession } from '../../../src/e2ee/session.ts';
import { openDatabase } from '../../../src/index/db.ts';
import { IndexStore, toFtsQuery } from '../../../src/index/store.ts';
import { Syncer } from '../../../src/index/sync.ts';
import { FakeRc } from '../../support/fake-rc.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const DIR = join(REPO_ROOT, 'test', 'fixtures', '8.9.0');
const stores: IndexStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

async function setup(who: 'alice' | 'admin' = 'alice', opts: { password?: string | null; pageSize?: number } = {}) {
  const rc = new FakeRc(DIR, who);
  const keys = await rc.get('e2e.fetchMyKeys');
  const session = await E2eeSession.open({
    userId: rc.userId,
    password: opts.password === null ? undefined : (opts.password ?? rc.password),
    keys,
  });
  const store = new IndexStore(openDatabase({ dataDir: '', ephemeral: true }).db);
  stores.push(store);
  const syncer = new Syncer(rc, session, store, { pageSize: opts.pageSize ?? 100 });
  return { rc, session, store, syncer };
}

describe('index + sync', () => {
  it('syncs every room and stores decrypted messages with key status', async () => {
    const { rc, store, syncer } = await setup();
    const reports = await syncer.syncAll();
    expect(reports.every((r) => r.backfillComplete && !r.error)).toBe(true);
    const rooms = store.listRooms();
    expect(rooms.map((r) => r.keyStatus).sort()).toEqual(['ok', 'ok']);
    for (const m of rc.expected.messages.filter((x) => x.room === 'group' || x.room === 'dm')) {
      const stored = store.getMessage(m.msgId);
      expect(stored?.text, m.label).toBe(m.text);
      expect(stored?.decryption.state).toBe('decrypted');
      if (m.tmid) expect(stored?.tmid).toBe(m.tmid);
    }
    expect(store.countMessages().undecryptable).toBe(0);
  });

  it('never persists per-file encryption keys', async () => {
    const { rc, store, syncer } = await setup();
    await syncer.syncAll();
    const fileMsg = rc.expected.messages.find((m) => m.file);
    const stored = store.getMessage(fileMsg?.msgId ?? '');
    expect(stored?.attachments[0]).toMatchObject({ title: fileMsg?.file?.name, encrypted: true });
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM messages').all());
    expect(dump).not.toMatch(/"kty"\s*:\s*"oct"|"encryption"|A256CTR/);
  });

  it('full-text search: diacritics, prefixes, user/date/room/thread filters, snippets', async () => {
    const { rc, store, syncer } = await setup();
    await syncer.syncAll();
    const label = (id: string) => rc.expected.messages.find((m) => m.msgId === id)?.label;
    expect(store.search('runbook').map((h) => label(h.message.id))).toContain('M1-plain');
    expect(store.search('cafe').map((h) => label(h.message.id))).toEqual(['M2-long']);
    expect(store.search('escalat*').length).toBeGreaterThanOrEqual(2);
    expect(store.search('runbook', { usernames: ['bob'] }).every((h) => h.message.username === 'bob')).toBe(true);
    expect(store.search('runbook', { rids: [rc.expected.rooms.dm.rid] })).toEqual([]);
    expect(store.search('runbook', { before: '2000-01-01' })).toEqual([]);
    const m1 = rc.expected.messages.find((m) => m.label === 'M1-plain');
    const inThread = store.search('version', { threadId: m1?.msgId });
    expect(inThread.length).toBeGreaterThanOrEqual(1);
    expect(store.search('runbook')[0]?.snippet).toMatch(/«runbook»/i);
    // file names and captions are searchable
    expect(store.search('checklist').length).toBeGreaterThanOrEqual(1);
    expect(toFtsQuery('foo "bar" OR baz*')).toBe('"foo" "bar" "OR" "baz"*');
    expect(store.search('NEAR(')).toEqual([]);
  });

  it('backfill pages with cursors, honours maxMessages and resumes', async () => {
    const { rc, store, syncer } = await setup('alice', { pageSize: 3 });
    await syncer.refreshRooms();
    const group = rc.expected.rooms.group.rid;
    const total = rc.messages.get(group)?.length ?? 0;
    const first = await syncer.syncRoom(group, { maxMessages: 4 });
    expect(first.backfillComplete).toBe(false);
    expect(store.countMessages(group).total).toBeGreaterThanOrEqual(4);
    const second = await syncer.syncRoom(group);
    expect(second.backfillComplete).toBe(true);
    expect(store.countMessages(group).total).toBe(total);
    const historyCalls = rc.calls.filter((c) => c.endpoint === 'rooms.history');
    expect(historyCalls.length).toBeGreaterThanOrEqual(Math.ceil(total / 3));
  });

  it('incremental sync picks up new and deleted messages with one call per room', async () => {
    const { rc, store, syncer } = await setup();
    const p2 = rc.expected.messages.find((m) => m.label === 'P2-alice-post-reset')?.msgId ?? '';
    const d1 = rc.expected.messages.find((m) => m.label === 'D1-dm')?.msgId ?? '';
    rc.hide([p2]);
    await syncer.syncAll();
    expect(store.getMessage(p2)).toBeUndefined();
    rc.reveal([p2]);
    rc.delete(d1);
    rc.calls.length = 0;
    const reports = await syncer.syncAll();
    expect(reports.reduce((n, r) => n + r.inserted, 0)).toBe(1);
    expect(reports.reduce((n, r) => n + r.deleted, 0)).toBe(1);
    expect(store.getMessage(p2)?.text).toMatch(/^Post-reset \(alice\)/);
    expect(store.getMessage(d1)).toBeUndefined();
    expect(rc.calls.filter((c) => c.endpoint === 'chat.syncMessages')).toHaveLength(2);
    expect(rc.calls.filter((c) => c.endpoint === 'rooms.history')).toHaveLength(0);
  });

  it('stores undecryptable messages with a reason and retries them when keys become available', async () => {
    const locked = await setup('alice', { password: null });
    await locked.syncer.syncAll();
    expect(locked.store.listRooms().every((r) => r.keyStatus === 'e2ee-unavailable')).toBe(true);
    const counts = locked.store.countMessages();
    expect(counts.undecryptable).toBeGreaterThan(10);
    const sample = locked.store.getMessage(locked.rc.expected.messages[0]?.msgId ?? '');
    expect(sample?.decryption).toMatchObject({ state: 'undecryptable', reason: 'no-room-key' });
    expect(sample?.text).toBe('');

    // Same index, now with the password: stored ciphertext is retried locally.
    const rc = locked.rc;
    const session = await E2eeSession.open({
      userId: rc.userId,
      password: rc.password,
      keys: await rc.get('e2e.fetchMyKeys'),
    });
    const syncer = new Syncer(rc, session, locked.store);
    await syncer.syncAll();
    expect(locked.store.countMessages().undecryptable).toBe(0);
    expect(locked.store.getMessage(rc.expected.messages[0]?.msgId ?? '')?.text).toBe(rc.expected.messages[0]?.text);
  });

  it('admin: pre-reset messages are kept as undecryptable with room-key-missing, post-reset ones decrypt', async () => {
    const { rc, store, syncer } = await setup('admin');
    await syncer.syncAll();
    for (const m of rc.expected.messages.filter((x) => x.room === 'group')) {
      const stored = store.getMessage(m.msgId);
      if (m.phase === 'pre-reset') {
        expect(stored?.decryption).toMatchObject({ state: 'undecryptable', reason: 'room-key-missing' });
      } else {
        expect(stored?.text, m.label).toBe(m.text);
      }
    }
  });

  it('on-disk index is private (0700 dir, 0600 file)', () => {
    if (process.platform === 'win32') return;
    const dir = join(mkdtempSync(join(tmpdir(), 'rcmcp-')), 'data');
    const { db, path } = openDatabase({ dataDir: dir, ephemeral: false });
    db.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path ?? '').mode & 0o777).toBe(0o600);
  });
});
