import { scrubSecrets } from '../logger.ts';

export type RcErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'too-large';

/** Any failure talking to Rocket.Chat. Messages never contain credentials (they are scrubbed). */
export class RcApiError extends Error {
  override name = 'RcApiError';
  readonly code: RcErrorCode;
  readonly endpoint: string;
  readonly status: number | undefined;
  /** Rocket.Chat's `errorType` / `error` when present (e.g. "error-not-allowed"). */
  readonly rcError: string | undefined;

  constructor(
    code: RcErrorCode,
    endpoint: string,
    message: string,
    options: { status?: number; rcError?: string; cause?: unknown } = {},
  ) {
    super(scrubSecrets(message), options.cause ? { cause: options.cause } : undefined);
    this.code = code;
    this.endpoint = endpoint;
    this.status = options.status;
    this.rcError = options.rcError ? scrubSecrets(options.rcError) : undefined;
  }

  /** Short, safe description for logs, CLI output and MCP error payloads. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      endpoint: this.endpoint,
      ...(this.status ? { status: this.status } : {}),
      ...(this.rcError ? { rcError: this.rcError } : {}),
      message: this.message,
    };
  }
}

export function codeForStatus(status: number): RcErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'bad-request';
}
