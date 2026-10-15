/**
 * stdout belongs to the MCP JSON-RPC protocol. These tests fail if anything else can write there.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../support/stack.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('stdout guard (static)', () => {
  const files = sourceFiles(join(REPO_ROOT, 'src'));

  it('no console.* anywhere in src/', () => {
    const offenders = files.filter((f) =>
      /\bconsole\.(log|info|warn|error|debug|trace|dir|table)\b/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('process.stdout is only touched by src/cli/output.ts', () => {
    const offenders = files.filter(
      (f) => /process\.stdout/.test(readFileSync(f, 'utf8')) && !f.endsWith(join('cli', 'output.ts')),
    );
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('the serve code path never imports the CLI output module', () => {
    const servePath = files.filter((f) => !f.includes(`${join('src', 'cli')}`) || f.endsWith('main.ts'));
    const offenders = servePath.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // main.ts only imports output.ts lazily inside non-serve commands.
      return f.endsWith('main.ts') ? /^import .*output\.ts/m.test(src) : /output\.ts/.test(src);
    });
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });
});

describe('stdout guard (dynamic): rc-mcp serve only emits JSON-RPC on stdout', () => {
  let server: Server;
  let url = '';
  beforeAll(async () => {
    // A fake Rocket.Chat that rejects the token, so every tool call fails and logs errors at debug level.
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'You must be logged in to do this.' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('handles initialize, tools/list and a failing tools/call with clean stdout and logs on stderr', async () => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'src', 'cli', 'main.ts'), 'serve'], {
      env: {
        ...process.env,
        RC_URL: url,
        RC_USER_ID: 'someone',
        RC_AUTH_TOKEN: 'not-a-real-token-123456',
        RC_E2EE_PASSWORD: 'not a real password',
        RC_MCP_EPHEMERAL: '1',
        RC_MCP_LOG_LEVEL: 'debug',
        RC_MCP_CONFIG: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const waitFor = async (pred: () => boolean, ms = 15_000) => {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > ms)
          throw new Error(`timeout; stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    await waitFor(() => stdout.includes('"id":1'));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitFor(() => stdout.includes('"id":2'));
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_rooms', arguments: {} } });
    await waitFor(() => stdout.includes('"id":3'));
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));

    const lines = stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    const call = lines.map((l) => JSON.parse(l)).find((m) => m.id === 3);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain('rocketchat-unauthorized');
    // Logging happened, on stderr, as JSON lines, without the secrets.
    const logLines = stderr.split('\n').filter(Boolean);
    expect(logLines.length).toBeGreaterThan(0);
    for (const l of logLines) expect(() => JSON.parse(l)).not.toThrow();
    expect(stderr + stdout).not.toContain('not-a-real-token-123456');
    expect(stderr + stdout).not.toContain('not a real password');
  }, 30_000);
});
