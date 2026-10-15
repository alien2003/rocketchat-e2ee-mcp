import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/app.ts';
import type { Config } from '../../../src/config.ts';
import { createServer } from '../../../src/mcp/server.ts';
import { FakeRc } from '../../support/fake-rc.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const DIR = join(REPO_ROOT, 'test', 'fixtures', '8.9.0');
const apps: App[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

async function connect(opts: { password?: string | null } = {}) {
  const rc = new FakeRc(DIR, 'alice');
  const config: Config = {
    url: 'http://localhost:3000',
    userId: rc.userId,
    authToken: 'test-token-not-real',
    e2eePassword: opts.password === null ? undefined : (opts.password ?? rc.password),
    dataDir: '/nonexistent',
    ephemeral: true,
    logLevel: 'silent',
    configFile: undefined,
  };
  const app = new App({ config, client: rc });
  apps.push(app);
  const server = createServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const first = content[0]?.text ?? '{}';
    return { isError: Boolean(res.isError), json: JSON.parse(first) as Record<string, unknown>, content };
  };
  return { rc, app, client, call };
}

const msg = (rc: FakeRc, label: string) => {
  const m = rc.expected.messages.find((x) => x.label === label);
  if (!m) throw new Error(label);
  return m;
};

describe('MCP tools', () => {
  it('exposes 8 read-only tools with descriptions and schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_file', 'get_message', 'get_messages', 'get_thread', 'get_user', 'list_rooms', 'search', 'sync'].sort(),
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect((t.description ?? '').length, t.name).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('list_rooms reports type, encryption and key status', async () => {
    const { call, rc } = await connect();
    const { json } = await call('list_rooms');
    expect(json.e2ee).toBe('unlocked');
    const rooms = json.rooms as Array<Record<string, unknown>>;
    expect(rooms.find((r) => r.id === rc.expected.rooms.group.rid)).toMatchObject({
      type: 'private-group',
      encrypted: true,
      key_status: 'ok',
    });
    expect(rooms.find((r) => r.id === rc.expected.rooms.dm.rid)).toMatchObject({
      type: 'direct-message',
      key_status: 'ok',
    });
  });

  it('get_messages returns decrypted messages oldest-first, by room name', async () => {
    const { call, rc } = await connect();
    const { json } = await call('get_messages', { room: rc.expected.rooms.group.name, limit: 50 });
    const messages = json.messages as Array<Record<string, unknown>>;
    expect(json.order).toBe('oldest-first');
    expect(messages.map((m) => m.id)).not.toContain(msg(rc, 'M4-thread-reply').msgId); // thread replies excluded
    const m1 = messages.find((m) => m.id === msg(rc, 'M1-plain').msgId);
    expect(m1).toMatchObject({
      text: msg(rc, 'M1-plain').text,
      author: 'Alice Anders (@alice)',
      encrypted: true,
      reply_count: 2,
    });
    expect(String(m1?.permalink)).toContain(`/group/${rc.expected.rooms.group.name}?msg=`);
    const ts = messages.map((m) => String(m.ts));
    expect([...ts].sort()).toEqual(ts);
  });

  it('get_thread accepts a pasted thread URL and returns root + replies across a key reset', async () => {
    const { call, rc } = await connect();
    const m1 = msg(rc, 'M1-plain');
    const url = `http://localhost:3000/group/${rc.expected.rooms.group.name}/thread/${m1.msgId}`;
    const { json } = await call('get_thread', { url });
    expect((json.root as Record<string, unknown>).text).toBe(m1.text);
    const replies = json.replies as Array<Record<string, unknown>>;
    expect(replies.map((r) => r.text)).toEqual([msg(rc, 'M4-thread-reply').text, msg(rc, 'P3-thread-post-reset').text]);
  });

  it('get_message resolves a permalink and the message it quotes', async () => {
    const { call, rc } = await connect();
    const quote = msg(rc, 'M6-quote');
    const { json } = await call('get_message', { url: `http://localhost:3000/group/x?msg=${quote.msgId}` });
    const message = json.message as Record<string, unknown>;
    expect(message.text).toBe('Agreed, this is the canonical runbook. Pin it?');
    expect(message.quotes).toEqual([{ message_id: msg(rc, 'M1-plain').msgId, url: expect.stringContaining('?msg=') }]);
    expect((json.quoted_messages as Array<Record<string, unknown>>)[0]?.text).toBe(msg(rc, 'M1-plain').text);
  });

  it('search finds encrypted content with filters and marks the source', async () => {
    const { call, rc } = await connect();
    const { json } = await call('search', { query: 'electionTimeoutMillis' });
    const results = json.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ id: msg(rc, 'M2-long').msgId, source: 'index', author: 'Bob Brown (@bob)' });
    expect(String(results[0]?.snippet)).toContain('«electionTimeoutMillis»');
    const { json: none } = await call('search', { query: 'runbook', from: ['carol'] });
    expect(none.count).toBe(0);
    const { json: inThread } = await call('search', { query: 'version', thread_id: msg(rc, 'M1-plain').msgId });
    expect((inThread.results as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('get_file returns decrypted text inline and images as image content', async () => {
    const { call, rc } = await connect();
    await call('sync');
    const text = await call('get_file', { message_id: msg(rc, 'M7-file-text').msgId });
    expect(text.json).toMatchObject({
      name: 'release-checklist.md',
      encrypted: true,
      integrity: 'verified',
      inline: true,
    });
    expect(text.content[1]?.text).toBe(readFileSync(join(DIR, 'plain', 'release-checklist.md'), 'utf8'));
    const image = await call('get_file', { message_id: msg(rc, 'M8-file-image').msgId });
    expect(image.json).toMatchObject({ name: 'diagram.png', type: 'image/png', inline: true });
    const img = image.content.find((c) => c.type === 'image');
    expect(Buffer.from(img?.data ?? '', 'base64').equals(readFileSync(join(DIR, 'plain', 'diagram.png')))).toBe(true);
  });

  it('sync reports per-room changes', async () => {
    const { call } = await connect();
    const { json } = await call('sync');
    expect((json.totals as Record<string, number>).new).toBeGreaterThan(10);
    const again = await call('sync');
    expect((again.json.totals as Record<string, number>).new).toBe(0);
  });

  it('get_user looks up users', async () => {
    const { call } = await connect();
    const { json } = await call('get_user', { username: '@bob' });
    expect(json).toMatchObject({ username: 'bob' });
  });

  it('errors use one shape with a code and hint', async () => {
    const { call } = await connect();
    const res = await call('get_messages', { room: 'no-such-room' });
    expect(res.isError).toBe(true);
    expect(res.json).toEqual({
      error: { code: 'room-not-found', message: expect.any(String), hint: expect.any(String) },
    });
    const bad = await call('get_message', {});
    expect(bad.json).toMatchObject({ error: { code: 'invalid-argument' } });
  });

  it('without the E2EE password, encrypted messages come back as undecryptable with a hint', async () => {
    const { call, rc } = await connect({ password: null });
    const rooms = await call('list_rooms');
    expect(rooms.json.e2ee).toMatchObject({ status: 'unavailable', reason: 'no-e2ee-password' });
    const { json } = await call('get_messages', { room: rc.expected.rooms.group.rid });
    const first = (json.messages as Array<Record<string, unknown>>)[0];
    expect(first).toMatchObject({ text: '', undecryptable: { reason: 'no-room-key' } });
  });

  it('exposes rooms as resources with a Markdown transcript', async () => {
    const { client, rc } = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(`rocketchat://room/${rc.expected.rooms.group.rid}`);
    const res = await client.readResource({ uri: `rocketchat://room/${rc.expected.rooms.dm.rid}` });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain(msg(rc, 'D1-dm').text);
  });
});
