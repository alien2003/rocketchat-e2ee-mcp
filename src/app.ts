/**
 * Wires config -> REST client -> E2EE session -> index -> syncer. Shared by the MCP server and the CLI.
 * Initialisation is lazy so `serve` answers `initialize` immediately and only talks to Rocket.Chat on demand.
 */
import { join } from 'node:path';
import type { Config } from './config.ts';
import { E2eeSession } from './e2ee/session.ts';
import { openDatabase } from './index/db.ts';
import { IndexStore } from './index/store.ts';
import { Syncer } from './index/sync.ts';
import { createLogger } from './logger.ts';
import { RcClient } from './rc-api/client.ts';
import { RcApiError } from './rc-api/errors.ts';
import type { EndpointResponse } from './rc-api/schemas.ts';

const log = createLogger({ name: 'app' });

/** The REST surface the app needs; RcClient implements it, tests substitute a fake. */
export type RcApi = Pick<RcClient, 'get' | 'serverNow' | 'download' | 'serverInfo'>;

/** After a connectivity failure, read paths skip network work for this long and serve the local index. */
const CIRCUIT_MS = 30_000;

export interface AppOptions {
  config: Config;
  client?: RcApi;
  /** Tool calls from an MCP client: fewer retries and shorter waits (the CLI is patient). */
  interactive?: boolean;
  /** rooms.history page size (tests use small pages). */
  pageSize?: number;
}

export type Soft<T> = { ok: true; value: T } | { ok: false; note: string };

/** Errors after which the local index can still answer (stale but useful). */
function isSoftFailure(error: unknown): error is RcApiError {
  return (
    error instanceof RcApiError &&
    ['network', 'timeout', 'server-error', 'unauthorized', 'rate-limited'].includes(error.code)
  );
}

export class App {
  readonly config: Config;
  readonly client: RcApi;
  readonly store: IndexStore;
  readonly dbPath: string | undefined;
  private sessionPromise: Promise<E2eeSession> | undefined;
  private mePromise: Promise<EndpointResponse<'me'>> | undefined;
  private syncerPromise: Promise<Syncer> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private readonly pageSize: number | undefined;
  private roomsRefreshedAt = 0;
  private failureAt = 0;
  private lastFailure: string | undefined;
  lastGlobalSyncAt = 0;

  constructor(options: AppOptions) {
    this.config = options.config;
    this.client =
      options.client ??
      new RcClient({
        url: options.config.url,
        userId: options.config.userId,
        authToken: options.config.authToken,
        ...(options.interactive ? { timeoutMs: 20_000, maxRetries: 2, maxRateLimitWaitMs: 45_000 } : {}),
      });
    this.pageSize = options.pageSize;
    const { db, path } = openDatabase({ dataDir: options.config.dataDir, ephemeral: options.config.ephemeral });
    this.store = new IndexStore(db);
    this.dbPath = path;
  }

  get siteUrl(): string {
    return this.config.url;
  }

  get filesDir(): string {
    return join(this.config.dataDir, 'files');
  }

  me(): Promise<EndpointResponse<'me'>> {
    this.mePromise ??= this.client.get('me').catch((error: unknown) => {
      this.mePromise = undefined;
      throw error;
    });
    return this.mePromise;
  }

  /** Unlocks E2EE once. Rejects only for REST failures; E2EE problems are reported via `session.state`. */
  session(): Promise<E2eeSession> {
    this.sessionPromise ??= (async () => {
      const keys = await this.client.get('e2e.fetchMyKeys');
      const session = await E2eeSession.open({ userId: this.config.userId, password: this.config.e2eePassword, keys });
      if (session.state.status === 'unavailable') {
        log.warn('E2EE unavailable; encrypted rooms will be listed but not decrypted', {
          reason: session.state.reason,
        });
      }
      return session;
    })().catch((error: unknown) => {
      this.sessionPromise = undefined;
      throw error;
    });
    return this.sessionPromise;
  }

  syncer(): Promise<Syncer> {
    this.syncerPromise ??= this.session()
      .then((session) => new Syncer(this.client, session, this.store, this.pageSize ? { pageSize: this.pageSize } : {}))
      .catch((error: unknown) => {
        this.syncerPromise = undefined;
        throw error;
      });
    return this.syncerPromise;
  }

  /** Refreshes the room list (2 REST calls) unless done within `maxAgeMs`; concurrent callers share one refresh. */
  refreshRooms(maxAgeMs = 60_000): Promise<void> {
    if (Date.now() - this.roomsRefreshedAt < maxAgeMs && this.store.listRooms().length > 0) return Promise.resolve();
    this.refreshPromise ??= (async () => {
      await (await this.syncer()).refreshRooms();
      this.roomsRefreshedAt = Date.now();
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /**
   * Runs optional network work for a read path. When Rocket.Chat is unreachable (or the token stopped working)
   * and the local index can still answer, returns a note instead of throwing, and skips further network work
   * for a short while so every call does not wait for timeouts.
   */
  async soft<T>(what: string, fn: () => Promise<T>): Promise<Soft<T>> {
    if (Date.now() - this.failureAt < CIRCUIT_MS) {
      return {
        ok: false,
        note: `skipped ${what}: Rocket.Chat was unreachable (${this.lastFailure}); results come from the local index and may be stale`,
      };
    }
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      if (!isSoftFailure(error)) throw error;
      this.failureAt = Date.now();
      this.lastFailure = `${error.code}: ${error.message}`;
      log.warn('serving from the local index', { what, error: error.toJSON() });
      return {
        ok: false,
        note: `could not ${what} (${error.code}: ${error.message}); results come from the local index and may be stale`,
      };
    }
  }

  /** True when the local index has rooms to answer from even if Rocket.Chat is unreachable. */
  get hasLocalData(): boolean {
    return this.store.listRooms().length > 0;
  }

  close(): void {
    this.store.close();
  }
}
