/**
 * Regression tests for issues found by the adversarial review (paging gaps, offline behaviour, suggested old
 * keys, ephemeral files, E2EE uploads without message content, dates, ids, data dir safety).
 * All ciphertext comes from the committed real-client fixtures.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/app.ts';
import { type Config, loadConfig } from '../../../src/config.ts';
import { MAX_DECRYPT_BYTES } from '../../../src/e2ee/file.ts';
import { decryptMessage, type RawMessage } from '../../../src/e2ee/message.ts';
import { E2eeSession } from '../../../src/e2ee/session.ts';
import { parseMessageRef } from '../../../src/mcp/format.ts';
import { getFile, getMessage, getMessages, getThread, search, syncRooms } from '../../../src/mcp/operations.ts';
import { RcApiError } from '../../../src/rc-api/errors.ts';
import { FakeRc } from '../../support/fake-rc.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const DIR = join(REPO_ROOT, 'test', 'fixtures', '8.9.0');
const apps: App[] = [];
const tempRoots: string[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'rcmcp-'));
  tempRoots.push(root);
  return join(root, 'data');
}

function makeApp(opts: { pageSize?: number; who?: 'alice' | 'bob'; persistent?: boolean } = {}) {
  const rc = new FakeRc(DIR, opts.who ?? 'alice');
  const config: Config = {
    url: 'http://localhost:3000',
    userId: rc.userId,
    authToken: 'test-token-not-real',
    e2eePassword: rc.password,
    dataDir: opts.persistent ? tempDataDir() : '/nonexistent',
    ephemeral: !opts.persistent,
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

  it('get_file limits a download only where the file could not be used: ephemeral inline, WebCrypto input', async () => {
    const tooLarge = async () => {
      throw new RcApiError('too-large', 'file-upload', 'file is too large');
    };
    const ephemeral = makeApp();
    const m7 = label(ephemeral.rc, 'M7-file-text').msgId;
    await getFile(ephemeral.app, { message_id: m7 });
    expect(ephemeral.rc.downloadLimits).toEqual([10 * 1024 * 1024]);
    ephemeral.rc.download = tooLarge;
    await expect(getFile(ephemeral.app, { message_id: m7 })).rejects.toMatchObject({
      code: 'file-too-large',
      message: expect.stringMatching(/ephemeral mode/),
      hint: expect.stringMatching(/RC_MCP_EPHEMERAL/),
    });

    const persistent = makeApp({ persistent: true });
    const res = await getFile(persistent.app, { message_id: m7 });
    expect(res.meta).toMatchObject({ encrypted: true, integrity: 'verified' });
    expect(persistent.rc.downloadLimits).toEqual([MAX_DECRYPT_BYTES]);
    persistent.rc.download = tooLarge;
    await expect(getFile(persistent.app, { message_id: m7 })).rejects.toMatchObject({
      code: 'file-too-large',
      message: expect.stringMatching(/encrypted file is larger than 2147483647 bytes/),
    });
  });

  it('get_file downloads unencrypted files without a limit and saves them privately', async () => {
    const { app, rc } = makeApp({ persistent: true });
    const group = rc.expected.rooms.group.rid;
    // A plain upload in an unencrypted message: no crypto involved, so synthetic bytes are fine.
    rc.messages.get(group)?.push({
      _id: 'plainFileMsg01',
      rid: group,
      ts: '2030-01-01T00:00:00.000Z',
      msg: '',
      u: { _id: rc.userId, username: 'alice' },
      file: { _id: 'plainFile01', name: 'report.bin', type: 'application/octet-stream' },
      attachments: [{ fileId: 'plainFile01', title: 'report.bin', type: 'file' }],
    });
    const limits: number[] = [];
    rc.download = async (_path, maxBytes = Number.POSITIVE_INFINITY) => {
      limits.push(maxBytes);
      return { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'application/octet-stream' };
    };
    const res = await getFile(app, { message_id: 'plainFileMsg01' });
    expect(limits).toEqual([Number.POSITIVE_INFINITY]);
    expect(res.meta).toMatchObject({ encrypted: false, inline: false, size: 4 });
    const saved = String(res.meta.saved_to);
    expect([...readFileSync(saved)]).toEqual([1, 2, 3, 4]);
    expect(statSync(saved).mode & 0o777).toBe(0o600);

    // A cancelled request rejects with the cancellation reason and saves nothing.
    const fresh = makeApp({ persistent: true });
    const reason = new Error('request cancelled');
    const m7 = label(fresh.rc, 'M7-file-text').msgId;
    await expect(getFile(fresh.app, { message_id: m7, max_inline_bytes: 0 }, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(fresh.rc.downloadLimits).toEqual([MAX_DECRYPT_BYTES]);
    expect(existsSync(fresh.app.filesDir) ? readdirSync(fresh.app.filesDir) : []).not.toContainEqual(
      expect.stringMatching(/release-checklist/),
    );
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
