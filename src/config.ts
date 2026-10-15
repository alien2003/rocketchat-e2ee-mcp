import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isLogLevel, type LogLevel, registerSecret } from './logger.ts';

/**
 * Runtime configuration. Secrets (auth token, E2EE password) come from the environment or from an
 * optional config file that must not be readable by group/others (mode 0600). Nothing here is ever
 * written back to disk by the tool.
 */
export interface Config {
  url: string;
  userId: string;
  authToken: string;
  e2eePassword: string | undefined;
  dataDir: string;
  ephemeral: boolean;
  logLevel: LogLevel;
  configFile: string | undefined;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const FileConfigSchema = z
  .object({
    url: z.string().optional(),
    userId: z.string().optional(),
    authToken: z.string().optional(),
    e2eePassword: z.string().optional(),
    dataDir: z.string().optional(),
    ephemeral: z.boolean().optional(),
    logLevel: z.string().optional(),
  })
  .strict();

type FileConfig = z.infer<typeof FileConfigSchema>;

export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'rc-mcp', 'config.json');
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'rc-mcp');
}

function readConfigFile(path: string, explicit: boolean): FileConfig {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    if (explicit) throw new ConfigError(`Config file not found: ${path}`);
    return {};
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new ConfigError(
      `Config file ${path} is accessible by group/others (mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`Config file ${path} is not valid JSON`);
  }
  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config file ${path} has unexpected fields: ${result.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`,
    );
  }
  return result.data;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Allow missing credentials (e.g. for `purge`). */
  requireCredentials?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const explicitFile = env.RC_MCP_CONFIG;
  const configFile = explicitFile ? resolve(explicitFile) : defaultConfigFile(env);
  const file = readConfigFile(configFile, Boolean(explicitFile));

  const url = (env.RC_URL || file.url || '').trim().replace(/\/+$/, '');
  const userId = (env.RC_USER_ID || file.userId || '').trim();
  const authToken = (env.RC_AUTH_TOKEN || file.authToken || '').trim();
  const e2eePassword = env.RC_E2EE_PASSWORD || file.e2eePassword || undefined;
  registerSecret(authToken);
  registerSecret(e2eePassword);

  const logLevelRaw = (env.RC_MCP_LOG_LEVEL || file.logLevel || 'info').toLowerCase();
  if (!isLogLevel(logLevelRaw)) {
    throw new ConfigError(`RC_MCP_LOG_LEVEL must be one of debug, info, warn, error, silent (got "${logLevelRaw}")`);
  }

  if (options.requireCredentials !== false) {
    const missing = [!url && 'RC_URL', !userId && 'RC_USER_ID', !authToken && 'RC_AUTH_TOKEN'].filter(Boolean);
    if (missing.length) {
      throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`);
    }
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new Error('protocol');
    } catch {
      throw new ConfigError(`RC_URL is not a valid http(s) URL: ${url}`);
    }
  }

  return {
    url,
    userId,
    authToken,
    e2eePassword,
    dataDir: resolve(env.RC_MCP_DATA_DIR || file.dataDir || defaultDataDir(env)),
    ephemeral: parseBool(env.RC_MCP_EPHEMERAL) ?? file.ephemeral ?? false,
    logLevel: logLevelRaw,
    configFile: file && Object.keys(file).length ? configFile : undefined,
  };
}
