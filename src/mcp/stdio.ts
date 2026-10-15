/**
 * Runs the MCP server on stdio. Nothing in this code path may write to stdout except the SDK transport.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { App } from '../app.ts';
import { createLogger } from '../logger.ts';
import { VERSION } from '../version.ts';
import { createServer, toErrorPayload } from './server.ts';

const log = createLogger({ name: 'serve' });

export async function serveStdio(app: App): Promise<void> {
  const server = createServer(app);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { why });
    await server.close().catch(() => undefined);
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin closed'));

  await server.connect(transport);
  log.info('rc-mcp MCP server ready on stdio', {
    version: VERSION,
    server: app.config.url,
    index: app.config.ephemeral ? 'memory' : app.dbPath,
  });

  // Warm up in the background: unlock keys and list rooms (2-3 REST calls), never blocking the protocol.
  void (async () => {
    try {
      await app.refreshRooms(0);
      log.info('rooms loaded', { rooms: app.store.listRooms().length });
    } catch (error) {
      log.warn('warm-up failed (tools will retry on demand)', { error: toErrorPayload(error) });
    }
  })();
}
