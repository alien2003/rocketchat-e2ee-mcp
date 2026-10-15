/**
 * Integration: the real `rc-mcp serve` process over stdio, driven by the official MCP client SDK, against the
 * compose stack. Verifies every tool returns decrypted content, incl. a post-reset message and an encrypted file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../support/stack.ts';
import { credentials, stackOrSkip } from './helpers.ts';

const { stack, expected } = stackOrSkip();
const byLabel = (l: string) => {
  const m = expected.messages.find((x) => x.label === l);
  if (!m) throw new Error(l);
  return m;
};

const BIN = process.env.RC_MCP_BIN ?? join(REPO_ROOT, 'src', 'cli', 'main.ts');
let client: Client;
let stderr = '';

beforeAll(async () => {
  const alice = credentials(stack, 'alice');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'serve'],
    env: {
      PATH: process.env.PATH ?? '',
      RC_URL: stack.url,
      RC_USER_ID: alice.userId,
      RC_AUTH_TOKEN: alice.authToken,
      RC_E2EE_PASSWORD: alice.e2eePassword ?? '',
      RC_MCP_EPHEMERAL: '1',
      RC_MCP_LOG_LEVEL: 'info',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d) => (stderr += String(d)));
  client = new Client({ name: 'integration-test', version: '0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string; data?: string }>;
  if (res.isError) throw new Error(`${name} failed: ${content[0]?.text}`);
  return { json: JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>, content };
}

describe('rc-mcp serve over stdio (real process, real Rocket.Chat)', () => {
  it('lists the 8 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
  });

  it('list_rooms -> sync -> get_messages returns decrypted text', async () => {
    const rooms = await call('list_rooms', { encrypted_only: true });
    expect((rooms.json.rooms as unknown[]).length).toBeGreaterThanOrEqual(2);
    const sync = await call('sync');
    expect((sync.json.totals as Record<string, number>).undecryptable).toBe(0);
    const page = await call('get_messages', { room: expected.rooms.group.name, limit: 100 });
    const texts = (page.json.messages as Array<{ text: string }>).map((m) => m.text);
    expect(texts).toContain(byLabel('P1-admin-post-reset').text);
    expect(texts).toContain(byLabel('M2-long').text);
  });

  it('search finds content of encrypted rooms', async () => {
    const res = await call('search', { query: 'freeze deploys Fridays' });
    expect((res.json.results as Array<{ id: string }>)[0]?.id).toBe(byLabel('P2-alice-post-reset').msgId);
  });

  it('get_thread, get_message (URL) and get_user', async () => {
    const thread = await call('get_thread', { thread_id: byLabel('M1-plain').msgId });
    expect((thread.json.replies as unknown[]).length).toBe(2);
    const url = `${stack.url}/group/${expected.rooms.group.name}?msg=${byLabel('M5-edited').msgId}`;
    const msg = await call('get_message', { url });
    expect((msg.json.message as { text: string; edited_at?: string }).text).toBe(byLabel('M5-edited').text);
    expect((msg.json.message as { edited_at?: string }).edited_at).toBeTruthy();
    const user = await call('get_user', { username: 'bob' });
    expect(user.json.username).toBe('bob');
  });

  it('get_file decrypts an encrypted upload made after the key reset', async () => {
    const m = byLabel('P4-file-post-reset');
    const res = await call('get_file', { message_id: m.msgId });
    expect(res.json).toMatchObject({ name: m.file?.name, encrypted: true, integrity: 'verified' });
    expect(res.content[1]?.text).toBe(
      readFileSync(join(stack.groundTruth?.fixtureDir ?? '', m.file?.contentFixture ?? ''), 'utf8'),
    );
  });

  it('logged only to stderr', () => {
    expect(stderr).toContain('MCP server ready');
    expect(stderr).not.toContain(credentials(stack, 'alice').authToken);
  });
});
