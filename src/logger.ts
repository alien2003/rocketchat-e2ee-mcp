/**
 * Structured JSON-lines logger that only ever writes to stderr.
 *
 * stdout belongs to the MCP stdio protocol, so nothing in src/ may write there except the CLI output
 * helpers used by non-serve commands. Secrets are scrubbed twice: by key name (password, token, …) and by
 * value (every secret registered through `registerSecret` is replaced wherever it appears in a string).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SECRET_KEY_PATTERN =
  /pass(word|phrase)?|secret|token|authorization|private_?key|e2ekey|e2esuggestedkey|cookie|^k$|^d$|^p$|^q$|^dp$|^dq$|^qi$/i;

const registeredSecrets = new Set<string>();

/** Registers a secret value so it is redacted from every subsequent log line and error message. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 4) {
    registeredSecrets.add(value);
  }
}

/** Replaces every registered secret occurring in `text`. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return scrubSecrets(value);
  if (value instanceof Error) {
    return { name: value.name, message: scrubSecrets(value.message), ...('code' in value ? { code: value.code } : {}) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

type Sink = (line: string) => void;

let globalLevel: LogLevel = 'info';
let sink: Sink = (line) => {
  process.stderr.write(`${line}\n`);
};

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

/** Test hook: redirect log lines (still never to stdout). */
export function setLogSink(next: Sink): void {
  sink = next;
}

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVELS;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const emit = (level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[globalLevel]) return;
    const record = sanitize({ ...bindings, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ time: new Date().toISOString(), level, msg: scrubSecrets(msg), ...record }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (more) => createLogger({ ...bindings, ...more }),
  };
}

export const log = createLogger({ name: 'rc-mcp' });
