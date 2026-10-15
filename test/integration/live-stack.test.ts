/**
 * Integration: the real REST client, sync, decryption and operations against Rocket.Chat in Docker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.ts';
import { getFile, getMessage, getThread, listRooms, search, syncRooms } from '../../src/mcp/operations.ts';
import { RcClient } from '../../src/rc-api/client.ts';
import { api } from '../support/bootstrap.ts';
import { appFor, clientFor, credentials, stackOrSkip } from './helpers.ts';

const { stack, expected } = stackOrSkip();
const GROUP = expected.rooms.group.rid;
const DM = expected.rooms.dm.rid;
const byLabel = (l: string) => {
  const m = expected.messages.find((x) => x.label === l);
  if (!m) throw new Error(l);
  return m;
};
const apps: App[] = [];
afterAll(() => {
  for (const a of apps) a.close();
});
const track = (a: App) => {
  apps.push(a);
  return a;
};

describe('REST client against Rocket.Chat', () => {
  const client = clientFor(stack, 'alice');

  it('authenticates with the PAT and reads the server clock', async () => {
    const me = await client.get('me');
    expect(me.username).toBe('alice');
    expect(client.serverNow).toBeGreaterThan(Date.parse('2026-01-01'));
  });

  it('rooms.history cursor pagination walks the whole room exactly once', async () => {
    const seen = new Set<string>();
    let previous: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await client.get('rooms.history', { roomId: GROUP, count: 3, ...(previous ? { previous } : {}) });
      for (const m of res.messages) seen.add(m._id);
      if (!res.cursor?.previous) break;
      previous = res.cursor.previous;
    }
    for (const m of expected.messages.filter((x) => x.room === 'group')) expect(seen.has(m.msgId), m.label).toBe(true);
  });

  it('chat.syncMessages (lastUpdate) returns updated and deleted arrays', async () => {
    const res = await client.get('chat.syncMessages', { roomId: GROUP, lastUpdate: new Date(0).toISOString() });
    expect(res.result.updated.length).toBeGreaterThanOrEqual(
      expected.messages.filter((m) => m.room === 'group').length,
    );
    expect(Array.isArray(res.result.deleted)).toBe(true);
  });

  it('downloads an encrypted upload with the PAT', async () => {
    const files = await client.get('groups.files', { roomId: GROUP, count: 50 });
    const f = files.files[0];
    expect(f?.path).toMatch(/^\/file-upload\//);
    const dl = await client.download(f?.path ?? '');
    expect(dl.bytes.length).toBe(f?.size);
  });

  it('a wrong token is a typed unauthorized error', async () => {
    const bad = new RcClient({
      url: stack.url,
      userId: stack.users.alice.userId,
      authToken: 'definitely-wrong-token',
      maxRetries: 0,
    });
    await expect(bad.get('me')).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
});

describe('end-to-end decryption through the app (alice)', () => {
  let app: App;
  beforeAll(async () => {
    app = track(appFor(stack, 'alice', expected));
    await syncRooms(app, {});
  });

  it('decrypts every ground-truth message, including post-reset ones', () => {
    for (const m of expected.messages) {
      expect(app.store.getMessage(m.msgId)?.text, m.label).toBe(m.text);
    }
  });

  it('lists rooms with key status ok', async () => {
    const res = await listRooms(app, {});
    const group = (res.rooms as Array<Record<string, unknown>>).find((r) => r.id === GROUP);
    expect(group).toMatchObject({ encrypted: true, key_status: 'ok', history_complete: true });
  });

  it('reads the thread whose replies span the room key reset', async () => {
    const res = await getThread(app, { thread_id: byLabel('M1-plain').msgId });
    expect(res.replies.map((r) => r.text)).toEqual([
      byLabel('M4-thread-reply').text,
      byLabel('P3-thread-post-reset').text,
    ]);
  });

  it('decrypts encrypted files downloaded from the server (pre- and post-reset)', async () => {
    for (const label of ['M7-file-text', 'P4-file-post-reset', 'D3-dm-file']) {
      const m = byLabel(label);
      const res = await getFile(app, { message_id: m.msgId });
      expect(res.meta).toMatchObject({ name: m.file?.name, encrypted: true, integrity: 'verified' });
      expect(res.text).toBe(
        readFileSync(join(stack.groundTruth?.fixtureDir ?? '', m.file?.contentFixture ?? ''), 'utf8'),
      );
    }
  });

  it('resolves quotes via get_message', async () => {
    const res = await getMessage(app, { id: byLabel('M6-quote').msgId });
    expect(res.quoted_messages?.[0]).toMatchObject({ id: byLabel('M1-plain').msgId });
  });
});

describe('other users', () => {
  it('admin: pre-reset messages are explicitly undecryptable, post-reset ones readable', async () => {
    const app = track(appFor(stack, 'admin', expected));
    await syncRooms(app, { room: GROUP });
    expect(app.store.getMessage(byLabel('M1-plain').msgId)?.decryption).toMatchObject({
      state: 'undecryptable',
      reason: 'room-key-missing',
    });
    expect(app.store.getMessage(byLabel('P2-alice-post-reset').msgId)?.text).toBe(byLabel('P2-alice-post-reset').text);
  });

  it('bob reads the DM', async () => {
    const app = track(appFor(stack, 'bob', expected));
    await syncRooms(app, { room: DM });
    expect(app.store.getMessage(byLabel('D1-dm').msgId)?.text).toBe(byLabel('D1-dm').text);
  });

  it('carol (no E2EE keys, not in the encrypted rooms) still reads public channels; server search is merged', async () => {
    const carol = credentials(stack, 'carol');
    const auth = { userId: carol.userId, authToken: carol.authToken };
    const marker = `wiki moved ${Date.now().toString(36)}`;
    // Test setup writes with carol's own token; rc-mcp itself never writes.
    await api('chat.postMessage', {
      auth,
      body: { channel: '#general', text: `Plain channel note: the ${marker} to wiki.example.test` },
    });
    const app = track(appFor(stack, 'carol', expected));
    const rooms = await listRooms(app, {});
    expect(rooms.e2ee).toMatchObject({ status: 'unavailable', reason: 'no-user-keys' });
    expect((rooms.rooms as Array<Record<string, unknown>>).some((r) => r.id === GROUP)).toBe(false);
    const fromServer = await search(app, { query: marker, refresh: false, include_server_search: true });
    expect(fromServer.results[0]).toMatchObject({ source: 'server' });
    const merged = await search(app, { query: marker, rooms: ['general'] });
    expect(merged.results[0]).toMatchObject({ source: 'index+server' });
  });
});
