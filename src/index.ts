/** Programmatic API (the CLI is the primary interface; see README). */
export { App, type RcApi } from './app.ts';
export { type Config, loadConfig } from './config.ts';
export * as e2ee from './e2ee/index.ts';
export { IndexStore } from './index/store.ts';
export { Syncer } from './index/sync.ts';
export { createServer } from './mcp/server.ts';
export { RcApiError, RcClient } from './rc-api/index.ts';
export { VERSION } from './version.ts';
