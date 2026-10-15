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
import type { EndpointResponse } from './rc-api/schemas.ts';

const log = createLogger({ name: 'app' });

/** The REST surface the app needs; RcClient implements it, tests substitute a fake. */
export type RcApi = Pick<RcClient, 'get' | 'serverNow' | 'download' | 'serverInfo'>;

export interface AppOptions {
  config: Config;
  client?: RcApi;
}

export class App {
  readonly config: Config;
  readonly client: RcApi;
  readonly store: IndexStore;
  readonly dbPath: string | undefined;
  private sessionPromise: Promise<E2eeSession> | undefined;
  private mePromise: Promise<EndpointResponse<'me'>> | undefined;
  private syncerInstance: Syncer | undefined;
  private roomsRefreshedAt = 0;
  lastGlobalSyncAt = 0;

  constructor(options: AppOptions) {
    this.config = options.config;
    this.client =
      options.client ??
      new RcClient({ url: options.config.url, userId: options.config.userId, authToken: options.config.authToken });
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

  /** Unlocks E2EE once. Never rejects for E2EE problems; check `session.state`. */
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

  async syncer(): Promise<Syncer> {
    if (!this.syncerInstance) {
      this.syncerInstance = new Syncer(this.client, await this.session(), this.store);
    }
    return this.syncerInstance;
  }

  /** Refreshes the room list (2 REST calls) unless done within `maxAgeMs`. */
  async refreshRooms(maxAgeMs = 60_000): Promise<void> {
    if (Date.now() - this.roomsRefreshedAt < maxAgeMs && this.store.listRooms().length > 0) return;
    await (await this.syncer()).refreshRooms();
    this.roomsRefreshedAt = Date.now();
  }

  close(): void {
    this.store.close();
  }
}
