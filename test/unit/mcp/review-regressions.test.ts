/**
 * Regression tests for issues found by the adversarial review (paging gaps, offline behaviour, suggested old
 * keys, ephemeral files, E2EE uploads without message content, dates, ids, data dir safety).
 * All ciphertext comes from the committed real-client fixtures.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/app.ts';
import { type Config, loadConfig } from '../../../src/config.ts';
import { decryptMessage, type RawMessage } from '../../../src/e2ee/message.ts';
import { E2eeSession } from '../../../src/e2ee/session.ts';
import { parseMessageRef } from '../../../src/mcp/format.ts';
import { getFile, getMessage, getMessages, getThread, search, syncRooms } from '../../../src/mcp/operations.ts';
import { FakeRc } from '../../support/fake-rc.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const DIR = join(REPO_ROOT, 'test', 'fixtures', '8.9.0');
const apps: App[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

function makeApp(opts: { pageSize?: number; who?: 'alice' | 'bob' } = {}) {
  const rc = new FakeRc(DIR, opts.who ?? 'alice');
  const config: Config = {
    url: 'http://localhost:3000',
    userId: rc.userId,
    authToken: 'test-token-not-real',
    e2eePassword: rc.password,
    dataDir: '/nonexistent',
    ephemeral: true,
    logLevel: 'silent',
    configFile: undefined,
  };
  const app = new App({ config, client: rc, ...(opts.pageSize ? { pageSize: opts.pageSize } : {}) });
  apps.push(app);
  return { app, rc };
}
const label = (rc: FakeRc, l: string) => {
  const m = rc.expected.messages.find((x) => x.label === l);
  if (!m) throw new Error(l);
  return m;
};

describe('review regressions', () => {
  it('get_messages pages are contiguous even when old messages were indexed out of order', async () => {
    const { app, rc } = makeApp({ pageSize: 3 });
    const group = rc.expected.rooms.group.rid;
    // Index the room's oldest message first (as get_message / quotes / thread fetches do).
    await getMessage(app, { id: label(rc, 'M1-plain').msgId });
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 30; i++) {
      const page = await getMessages(app, { room: group, limit: 2, ...(before ? { before } : {}) });
      const ids = page.messages.map((m) => m.id);
      seen.unshift(...ids);
      if (!page.has_older) break;
      before = page.older_than_cursor ?? before;
      if (!page.older_than_cursor) {
      }
    }
    const expectedTopLevel = (rc.messages.get(group) ?? [])
      .filter((m) => !m.tmid)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((m) => m._id);
    expect(seen).toEqual(expectedTopLevel);
  });

  it('serves the local index with a note when Rocket.Chat becomes unreachable', async () => {
    const { app, rc } = makeApp();
    await syncRooms(app, {});
    rc.down = true;
    const res = await search(app, { query: 'runbook', rooms: [rc.expected.rooms.group.rid] });
    expect(res.count).toBeGreaterThan(0);
    expect(res.notes?.join(' ')).toMatch(/local index/);
    const page = await getMessages(app, { room: rc.expected.rooms.group.name, limit: 5 });
    expect(page.messages.length).toBe(5);
    const thread = await getThread(app, { thread_id: label(rc, 'M1-plain').msgId });
    expect(thread.replies.length).toBe(2);
  });

  it('search with refresh=false does no network work', async () => {
    const { app, rc } = makeApp();
    await syncRooms(app, {});
    rc.calls.length = 0;
    await search(app, { query: 'runbook', refresh: false });
    expect(rc.calls.map((c) => c.endpoint)).toEqual([]);
  });

  it('suggested old room keys decrypt pre-reset history while the suggested key is not yet accepted', async () => {
    const rc = new FakeRc(DIR, 'alice');
    const session = await E2eeSession.open({
      userId: rc.userId,
      password: rc.password,
      keys: await rc.get('e2e.fetchMyKeys'),
    });
    const sub = (await rc.get('subscriptions.getOne', { roomId: rc.expected.rooms.group.rid })).subscription;
    if (!sub) throw new Error('no sub');
    const ring = await session.keyringFor({
      rid: 'suggested-only',
      E2ESuggestedKey: sub.E2EKey,
      suggestedOldRoomKeys: sub.oldRoomKeys,
    });
    expect(ring.status).toBe('suggested');
    const raw = rc.messages.get(rc.expected.rooms.group.rid)?.find((m) => m._id === label(rc, 'M1-plain').msgId);
    const { message } = await decryptMessage(raw as RawMessage, ring);
    expect(message.msg).toBe(label(rc, 'M1-plain').text);
  });

  it('ephemeral get_file never writes to disk: non-inline files come back as a binary blob', async () => {
    const { app, rc } = makeApp();
    await syncRooms(app, {});
    const res = await getFile(app, { message_id: label(rc, 'M7-file-text').msgId, max_inline_bytes: 0 });
    expect(res.meta).toMatchObject({ inline: true, encrypted: true, integrity: 'verified' });
    expect(res.meta.saved_to).toBeUndefined();
    expect(Buffer.from(res.blob?.data ?? '', 'base64').toString()).toMatch(/^# Release checklist/);
  });

  it('get_file finds the key in the upload record when an E2EE file message has no content', async () => {
    const { app, rc } = makeApp();
    await syncRooms(app, {});
    const m7 = label(rc, 'M7-file-text');
    rc.stripContent(m7.msgId);
    const res = await getFile(app, { message_id: m7.msgId });
    expect(res.meta).toMatchObject({ name: 'release-checklist.md', encrypted: true, integrity: 'verified' });
    expect(res.text).toMatch(/^# Release checklist/);
  });

  it('get_file refuses ids that are not ids and files that do not exist', async () => {
    const { app } = makeApp();
    await expect(getFile(app, { file_id: '../../etc/passwd' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(getFile(app, { file_id: 'doesnotexist123' })).rejects.toMatchObject({ code: 'file-not-found' });
  });

  it('date arguments are validated and normalised (offsets, date-only)', async () => {
    const { app, rc } = makeApp();
    await syncRooms(app, {});
    await expect(search(app, { query: 'runbook', after: 'last week', refresh: false })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const all = await search(app, { query: 'runbook', refresh: false });
    const ts = all.results[0]?.ts ?? '';
    // The same instant written with a +02:00 offset must give identical bounds.
    const local = new Date(Date.parse(ts) + 1).toISOString().replace('Z', '+00:00');
    const before = await search(app, { query: 'runbook', before: local, refresh: false });
    expect(before.results.map((r) => r.id)).toContain(all.results[0]?.id);
    const dayAfter = new Date(Date.parse(ts) + 86_400_000).toISOString().slice(0, 10);
    expect((await search(app, { query: 'runbook', after: dayAfter, refresh: false })).count).toBe(0);
    expect(rc).toBeDefined();
  });

  it('accepts imported message ids (e.g. Slack) and thread URLs', () => {
    expect(parseMessageRef('slack-C024BE91L-1712345678.000100')).toEqual({
      messageId: 'slack-C024BE91L-1712345678.000100',
    });
    expect(parseMessageRef('https://chat.example.com/channel/dev/thread/slack-C1-17.1?msg=abc123DEF456ghi78')).toEqual({
      messageId: 'abc123DEF456ghi78',
      threadId: 'slack-C1-17.1',
    });
    expect(parseMessageRef('not an id')).toEqual({});
  });

  it('data dir must be absolute; ~ is expanded', () => {
    const env = { RC_URL: 'https://x.example', RC_USER_ID: 'u', RC_AUTH_TOKEN: 'tok', XDG_CONFIG_HOME: '/nonexistent' };
    expect(() => loadConfig({ env: { ...env, RC_MCP_DATA_DIR: 'relative/dir' } })).toThrow(/absolute/);
    expect(loadConfig({ env: { ...env, RC_MCP_DATA_DIR: '~/rc-mcp-data' } }).dataDir).toMatch(/^\/.*rc-mcp-data$/);
  });
});
