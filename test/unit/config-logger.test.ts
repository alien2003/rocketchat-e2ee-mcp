import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { createLogger, registerSecret, scrubSecrets, setLogLevel, setLogSink } from '../../src/logger.ts';
import { VERSION } from '../../src/version.ts';
import { REPO_ROOT } from '../support/stack.ts';

const baseEnv = { HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent/cfg', XDG_DATA_HOME: '/nonexistent/data' };

describe('config', () => {
  it('reads env vars, trims the URL and defaults to the XDG data dir', () => {
    const c = loadConfig({
      env: {
        ...baseEnv,
        RC_URL: 'https://chat.example.com/',
        RC_USER_ID: 'u',
        RC_AUTH_TOKEN: 't0ken-value',
        RC_E2EE_PASSWORD: 'pw words',
      },
    });
    expect(c).toMatchObject({
      url: 'https://chat.example.com',
      userId: 'u',
      e2eePassword: 'pw words',
      ephemeral: false,
      logLevel: 'info',
    });
    expect(c.dataDir).toBe('/nonexistent/data/rc-mcp');
  });

  it('reports missing settings without echoing values', () => {
    expect(() => loadConfig({ env: { ...baseEnv, RC_URL: 'https://x' } })).toThrow(/RC_USER_ID, RC_AUTH_TOKEN/);
    expect(() => loadConfig({ env: { ...baseEnv, RC_URL: 'ftp://x', RC_USER_ID: 'u', RC_AUTH_TOKEN: 't' } })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ env: { ...baseEnv, RC_MCP_LOG_LEVEL: 'loud' }, requireCredentials: false })).toThrow(
      /RC_MCP_LOG_LEVEL/,
    );
  });

  it('accepts a 0600 config file and refuses group/world-readable ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcmcp-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({ url: 'https://c.example', userId: 'u', authToken: 'secret-token', ephemeral: true }),
    );
    chmodSync(file, 0o600);
    const c = loadConfig({ env: { ...baseEnv, RC_MCP_CONFIG: file } });
    expect(c).toMatchObject({ url: 'https://c.example', ephemeral: true, configFile: file });
    // env overrides the file
    expect(loadConfig({ env: { ...baseEnv, RC_MCP_CONFIG: file, RC_URL: 'https://env.example' } }).url).toBe(
      'https://env.example',
    );
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      expect(() => loadConfig({ env: { ...baseEnv, RC_MCP_CONFIG: file } })).toThrow(/chmod 600/);
    }
    writeFileSync(file, JSON.stringify({ url: 'x', pasword: 'typo' }));
    chmodSync(file, 0o600);
    expect(() => loadConfig({ env: { ...baseEnv, RC_MCP_CONFIG: file } })).toThrow(/unexpected fields/);
  });
});

describe('logger', () => {
  it('writes JSON lines to its sink, redacting secret keys and registered secret values', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    setLogLevel('debug');
    registerSecret('super-secret-value');
    const log = createLogger({ name: 't' });
    log.info('token super-secret-value leaked?', {
      authToken: 'abc',
      nested: { password: 'p', ok: 'fine' },
      e2ePassword: 'x',
    });
    log.debug('debug line');
    setLogLevel('warn');
    log.info('suppressed');
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      level: 'info',
      msg: 'token [REDACTED] leaked?',
      authToken: '[REDACTED]',
      e2ePassword: '[REDACTED]',
    });
    expect(parsed[0].nested).toEqual({ password: '[REDACTED]', ok: 'fine' });
    expect(scrubSecrets('x super-secret-value y')).toBe('x [REDACTED] y');
    setLogLevel('info');
  });
});

describe('package', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
