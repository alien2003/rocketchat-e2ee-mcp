/**
 * Read-only Rocket.Chat REST client authenticated with a Personal Access Token.
 *
 * - Only `GET` requests to the allowlisted endpoints in ./schemas.ts (+ authenticated file downloads). There is
 *   deliberately no generic request method, so no code path can issue a write.
 * - Responses are validated with zod; failures become typed `RcApiError`s with credential-free messages.
 * - Rate limits: Rocket.Chat limits per client IP and route and reports `X-RateLimit-Remaining` and
 *   `X-RateLimit-Reset` (absolute epoch ms; no Retry-After). We pause a route when it is exhausted, retry 429s
 *   after the reset (with jitter), and serialise requests per route.
 */
import type { z } from 'zod';
import { createLogger, type Logger, registerSecret } from '../logger.ts';
import { USER_AGENT } from '../version.ts';
import { codeForStatus, RcApiError } from './errors.ts';
import { ENDPOINTS, type EndpointName, type EndpointResponse, ServerInfo } from './schemas.ts';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface RcClientOptions {
  url: string;
  userId: string;
  authToken: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors. */
  maxRetries?: number;
  /** Give up instead of sleeping longer than this for a rate limit. */
  maxRateLimitWaitMs?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DownloadResult {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RcClient {
  readonly baseUrl: string;
  private readonly userId: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** route -> epoch ms before which we should not call it again */
  private readonly pausedUntil = new Map<string, number>();
  /** route -> tail of the per-route queue */
  private readonly queues = new Map<string, Promise<unknown>>();
  private lastServerDate: number | undefined;
  private requestCount = 0;

  constructor(options: RcClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.userId = options.userId;
    this.authToken = options.authToken;
    registerSecret(options.authToken);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 120_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = options.logger ?? createLogger({ name: 'rc-api' });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Server clock from the most recent `Date` response header (ms), used as a sync watermark. */
  get serverNow(): number | undefined {
    return this.lastServerDate;
  }

  get requestsMade(): number {
    return this.requestCount;
  }

  private authHeaders(): Record<string, string> {
    return { 'x-user-id': this.userId, 'x-auth-token': this.authToken };
  }

  /** GET one allowlisted endpoint under /api/v1 and validate the response. */
  async get<K extends EndpointName>(endpoint: K, params: QueryParams = {}): Promise<EndpointResponse<K>> {
    if (!Object.hasOwn(ENDPOINTS, endpoint)) {
      throw new RcApiError('bad-request', endpoint, `endpoint ${endpoint} is not on the read-only allowlist`);
    }
    if (endpoint === 'im.files' && (!params.roomId || 'username' in params)) {
      // im.* endpoints can create a DM when not given an existing DM room id.
      throw new RcApiError('bad-request', endpoint, 'im.files requires the roomId of an existing DM');
    }
    const json = await this.request(endpoint, `/api/v1/${endpoint}`, params);
    const schema = ENDPOINTS[endpoint] as unknown as z.ZodType<EndpointResponse<K>>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RcApiError(
        'invalid-response',
        endpoint,
        `unexpected response shape from ${endpoint}: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`,
      );
    }
    return parsed.data;
  }

  /** GET /api/info (server version; more detail when authenticated). */
  async serverInfo(): Promise<z.infer<typeof ServerInfo>> {
    const json = await this.request('info', '/api/info', {});
    return ServerInfo.parse(json);
  }

  private request(route: string, path: string, params: QueryParams): Promise<unknown> {
    const run = async () => this.requestWithRetry(route, path, params);
    const tail = this.queues.get(route) ?? Promise.resolve();
    const next = tail.then(run, run);
    this.queues.set(
      route,
      next.catch(() => undefined),
    );
    return next;
  }

  private buildUrl(path: string, params: QueryParams): string {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async waitForRoute(route: string): Promise<void> {
    const until = this.pausedUntil.get(route);
    if (until === undefined) return;
    const wait = until - this.now();
    if (wait > 0) {
      if (wait > this.maxRateLimitWaitMs) {
        throw new RcApiError('rate-limited', route, `rate limited; retry after ${Math.ceil(wait / 1000)}s`, {
          status: 429,
        });
      }
      this.log.debug('waiting for rate limit window', { route, waitMs: wait });
      await this.sleep(wait);
    }
    this.pausedUntil.delete(route);
  }

  private noteRateLimitHeaders(route: string, headers: Headers): void {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (headers.has('x-ratelimit-remaining') && remaining <= 0 && Number.isFinite(reset) && reset > this.now()) {
      this.pausedUntil.set(route, reset + 50);
    }
  }

  private backoff(attempt: number): number {
    const base = Math.min(30_000, 500 * 2 ** attempt);
    return base + Math.floor(Math.random() * 250);
  }

  private async requestWithRetry(route: string, path: string, params: QueryParams): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.waitForRoute(route);
      const url = this.buildUrl(path, params);
      const started = this.now();
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { ...this.authHeaders(), accept: 'application/json', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        if (attempt < this.maxRetries) {
          const wait = this.backoff(attempt++);
          this.log.warn('request failed, retrying', { route, attempt, waitMs: wait, error: String(error) });
          await this.sleep(wait);
          continue;
        }
        throw new RcApiError(
          isTimeout ? 'timeout' : 'network',
          route,
          isTimeout ? `request to ${route} timed out after ${this.timeoutMs}ms` : `network error calling ${route}`,
          { cause: error },
        );
      }
      const date = Date.parse(res.headers.get('date') ?? '');
      if (Number.isFinite(date)) this.lastServerDate = date;
      this.noteRateLimitHeaders(route, res.headers);
      this.log.debug('rest', { route, status: res.status, ms: this.now() - started });

      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const wait = Number.isFinite(reset) && reset > this.now() ? reset - this.now() + 100 : this.backoff(attempt);
        if (attempt >= this.maxRetries || wait > this.maxRateLimitWaitMs) {
          await res.body?.cancel();
          throw new RcApiError(
            'rate-limited',
            route,
            `rate limited by Rocket.Chat; retry after ${Math.ceil(wait / 1000)}s`,
            {
              status: 429,
            },
          );
        }
        attempt++;
        this.log.info('rate limited, backing off', { route, waitMs: wait, attempt });
        await res.body?.cancel();
        this.pausedUntil.set(route, this.now() + wait);
        continue;
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        await res.body?.cancel();
        await this.sleep(this.backoff(attempt++));
        continue;
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (error) {
        throw new RcApiError(
          res.ok ? 'invalid-response' : codeForStatus(res.status),
          route,
          `non-JSON response from ${route} (HTTP ${res.status})`,
          { status: res.status, cause: error },
        );
      }
      const obj = (body ?? {}) as { success?: boolean; error?: unknown; errorType?: unknown; message?: unknown };
      if (!res.ok || obj.success === false) {
        // Keep only machine-style ids such as "error-not-allowed"; free-text errors can echo request data.
        const candidate = typeof obj.errorType === 'string' ? obj.errorType : obj.error;
        const rcError = typeof candidate === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(candidate) ? candidate : undefined;
        const code = res.ok ? 'bad-request' : codeForStatus(res.status);
        throw new RcApiError(code, route, describeFailure(route, res.status, rcError), {
          status: res.status,
          ...(rcError ? { rcError } : {}),
        });
      }
      return body;
    }
  }

  /**
   * Downloads an upload (`/file-upload/<id>/<name>`) with the PAT headers. Redirects to another origin (S3/GCS
   * signed URLs) are followed WITHOUT credentials.
   */
  async download(path: string, maxBytes = 50 * 1024 * 1024): Promise<DownloadResult> {
    const route = 'file-upload';
    if (!/^\/file-upload\/[^/]+\/[^?#]*$/.test(path) || path.includes('..')) {
      throw new RcApiError('bad-request', route, 'refusing to download a path outside /file-upload/');
    }
    let url = new URL(this.baseUrl + path);
    for (let hop = 0; hop < 5; hop++) {
      const sameOrigin = url.origin === new URL(this.baseUrl).origin;
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { ...(sameOrigin ? this.authHeaders() : {}), 'user-agent': USER_AGENT },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs * 4),
        });
      } catch (error) {
        throw new RcApiError('network', route, 'network error downloading file', { cause: error });
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location') as string, url);
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new RcApiError(codeForStatus(res.status), route, `file download failed (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel();
        throw new RcApiError('too-large', route, `file is ${declared} bytes (limit ${maxBytes})`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new RcApiError('too-large', route, `file exceeds the ${maxBytes} byte limit`);
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      return { bytes, contentType: res.headers.get('content-type') ?? undefined };
    }
    throw new RcApiError('network', route, 'too many redirects downloading file');
  }
}

function describeFailure(route: string, status: number, rcError: string | undefined): string {
  if (status === 401) return 'authentication failed: check RC_USER_ID / RC_AUTH_TOKEN (personal access token)';
  if (status === 403) return `not allowed to call ${route}${rcError ? ` (${rcError})` : ''}`;
  if (rcError === 'totp-required') {
    return `${route} requires two-factor authentication; recreate the PAT with "Ignore Two Factor Authentication"`;
  }
  return `${route} failed (HTTP ${status}${rcError ? `, ${rcError}` : ''})`;
}

/** Iterates an offset/count paginated endpoint. */
export async function* paginate<K extends EndpointName, T>(
  client: RcClient,
  endpoint: K,
  params: QueryParams,
  pick: (response: EndpointResponse<K>) => { items: T[]; total?: number | undefined },
  pageSize = 100,
): AsyncGenerator<T> {
  let offset = 0;
  for (;;) {
    const response = await client.get(endpoint, { ...params, count: pageSize, offset });
    const { items, total } = pick(response);
    for (const item of items) yield item;
    offset += items.length;
    if (items.length < pageSize || (total !== undefined && offset >= total) || items.length === 0) return;
  }
}
