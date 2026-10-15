#!/usr/bin/env node
/**
 * rc-mcp — read-only, E2EE-aware Rocket.Chat MCP server and CLI.
 *
 *   rc-mcp [serve]          MCP server over stdio (default)
 *   rc-mcp doctor           connectivity, token, E2EE key state, unreadable rooms
 *   rc-mcp sync [room]      update the local index
 *   rc-mcp search <query>   full-text search the index
 *   rc-mcp export <room>    room or thread to Markdown
 *   rc-mcp purge            delete the local index
 */
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { App } from '../app.ts';
import { ConfigError, loadConfig } from '../config.ts';
import { DB_FILENAME } from '../index/db.ts';
import { log, setLogLevel } from '../logger.ts';
import { toErrorPayload } from '../mcp/server.ts';
import { VERSION } from '../version.ts';

// Everything rc-mcp writes (index, cached files) is private to the user, including SQLite's WAL/SHM files.
process.umask(0o077);

process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { error: toErrorPayload(error) });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log.error('unhandled rejection', { error: toErrorPayload(error) });
  process.exit(1);
});

function makeApp(options: { interactive?: boolean } = {}): App {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  return new App({ config, ...(options.interactive ? { interactive: true } : {}) });
}

/** Parses a positive integer option; commander's Number parser would silently accept NaN. */
function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

function fatal(error: unknown): never {
  if (error instanceof ConfigError) {
    process.stderr.write(`rc-mcp: ${error.message}\nSee \`rc-mcp --help\` and README "Configuration".\n`);
    process.exit(2);
  }
  const e = toErrorPayload(error);
  process.stderr.write(`rc-mcp: ${e.message}${e.hint ? `\n  → ${e.hint}` : ''}\n`);
  process.exit(1);
}

async function serve(): Promise<void> {
  const { serveStdio } = await import('../mcp/stdio.ts');
  await serveStdio(makeApp({ interactive: true }));
}

const program = new Command()
  .name('rc-mcp')
  .description('Read-only MCP server for Rocket.Chat that decrypts end-to-end encrypted rooms locally.')
  .version(VERSION)
  .showHelpAfterError()
  .configureOutput({ writeErr: (s) => process.stderr.write(s) });

program
  .command('serve', { isDefault: true })
  .description('run the MCP server over stdio (default)')
  .action(() => serve().catch(fatal));

program
  .command('doctor')
  .description('check connectivity, token, E2EE key state and which encrypted rooms are unreadable (and why)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    try {
      const { runDoctor, renderDoctor } = await import('./doctor.ts');
      const { out, outJson } = await import('./output.ts');
      const app = makeApp();
      const report = await runDoctor(app);
      if (opts.json) outJson(report);
      else out(renderDoctor(report));
      app.close();
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      fatal(error);
    }
  });

program
  .command('sync')
  .description('fetch new, edited and deleted messages into the local index')
  .argument('[room]', 'room id or name (default: all rooms)')
  .option('--full', 'discard the local copy and re-index from scratch')
  .addOption(
    new Option('--max-messages <n>', 'backfill at most n older messages per room (default: all)').argParser(
      positiveInt,
    ),
  )
  .option('--json', 'machine-readable output')
  .action(async (room: string | undefined, opts: { full?: boolean; maxMessages?: number; json?: boolean }) => {
    try {
      const { syncRooms } = await import('../mcp/operations.ts');
      const { out, outJson } = await import('./output.ts');
      const app = makeApp();
      const res = await syncRooms(app, {
        ...(room ? { room } : {}),
        full: opts.full ?? false,
        ...(opts.maxMessages ? { max_messages: opts.maxMessages } : { unbounded: true }),
      });
      if (opts.json) outJson(res);
      else {
        out(
          `checked ${res.rooms_checked} rooms: +${res.totals.new} new, ${res.totals.updated} updated, ${res.totals.deleted} deleted, ${res.totals.undecryptable} undecryptable`,
        );
        for (const r of res.rooms) {
          out(
            `  ${r.room}: +${r.new} ~${r.updated} -${r.deleted}${r.history_complete ? '' : ' (history incomplete)'}${r.error ? ` ERROR ${r.error}` : ''}`,
          );
        }
        if (res.note) out(res.note);
      }
      app.close();
      if (res.failed_rooms) process.exitCode = 1;
    } catch (error) {
      fatal(error);
    }
  });

program
  .command('search')
  .description('full-text search over decrypted messages in the local index')
  .argument('<query...>', 'words to search for')
  .option('-r, --room <room...>', 'limit to rooms')
  .option('-f, --from <user...>', 'limit to authors (usernames)')
  .option('--after <date>', 'ISO date')
  .option('--before <date>', 'ISO date')
  .addOption(new Option('-n, --limit <n>', 'max results').argParser(positiveInt))
  .option('--no-refresh', 'do not sync stale rooms first')
  .option('--json', 'machine-readable output')
  .action(
    async (
      words: string[],
      opts: {
        room?: string[];
        from?: string[];
        after?: string;
        before?: string;
        limit?: number;
        refresh?: boolean;
        json?: boolean;
      },
    ) => {
      try {
        const { search } = await import('../mcp/operations.ts');
        const { out, outJson } = await import('./output.ts');
        const app = makeApp();
        const res = await search(app, {
          query: words.join(' '),
          ...(opts.room ? { rooms: opts.room } : {}),
          ...(opts.from ? { from: opts.from } : {}),
          ...(opts.after ? { after: opts.after } : {}),
          ...(opts.before ? { before: opts.before } : {}),
          ...(opts.limit ? { limit: opts.limit } : {}),
          refresh: opts.refresh !== false,
        });
        if (opts.json) outJson(res);
        else {
          for (const r of res.results) {
            out(
              `${r.ts.slice(0, 16).replace('T', ' ')}  ${r.room ?? r.room_id}  ${r.author}${r.thread_id ? '  [thread]' : ''}`,
            );
            out(`  ${(r.snippet || r.text).replace(/\n/g, ' ').slice(0, 300)}`);
            out(`  ${r.permalink}`);
          }
          out(`${res.count} result(s)`);
          for (const n of res.notes ?? []) out(`note: ${n}`);
        }
        app.close();
      } catch (error) {
        fatal(error);
      }
    },
  );

program
  .command('export')
  .description('export a room (or one thread) to Markdown with dates and authors')
  .argument('<room>', 'room id or name')
  .option('-t, --thread <id>', 'export only this thread (root message id)')
  .option('--since <date>', 'ISO date')
  .option('--until <date>', 'ISO date')
  .addOption(new Option('--format <format>', 'output format').choices(['md']).default('md'))
  .option('-o, --output <file>', 'write to a file (mode 0600) instead of stdout')
  .action(async (room: string, opts: { thread?: string; since?: string; until?: string; output?: string }) => {
    try {
      const { exportMarkdown } = await import('./export.ts');
      const { out } = await import('./output.ts');
      const app = makeApp();
      const res = await exportMarkdown(app, {
        room,
        ...(opts.thread ? { thread: opts.thread } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
      });
      if (opts.output) {
        writeFileSync(opts.output, res.markdown, { mode: 0o600 });
        chmodSync(opts.output, 0o600); // also when the file already existed

        process.stderr.write(`wrote ${res.count} messages to ${opts.output}\n`);
      } else {
        out(res.markdown);
      }
      app.close();
    } catch (error) {
      fatal(error);
    }
  });

program
  .command('purge')
  .description('delete the local index and cached files (does not touch Rocket.Chat)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(async (opts: { yes?: boolean }) => {
    try {
      const { out } = await import('./output.ts');
      const { FILES_MARKER } = await import('../mcp/operations.ts');
      // Purge what rc-mcp may have written under the data dir, also when currently running ephemeral.
      const config = loadConfig({ requireCredentials: false });
      const filesDir = join(config.dataDir, 'files');
      const targets = [
        join(config.dataDir, DB_FILENAME),
        join(config.dataDir, `${DB_FILENAME}-wal`),
        join(config.dataDir, `${DB_FILENAME}-shm`),
        // Only a files directory that rc-mcp created (marker file) is removed.
        ...(existsSync(join(filesDir, FILES_MARKER)) ? [filesDir] : []),
      ].filter((p) => existsSync(p));
      if (!targets.length) {
        out(`nothing to purge in ${config.dataDir}`);
        return;
      }
      if (!opts.yes) {
        if (!process.stdin.isTTY) throw new Error('refusing to purge without --yes in a non-interactive shell');
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const answer = await rl.question(`Delete ${targets.join(', ')}? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          out('aborted');
          return;
        }
      }
      for (const t of targets) rmSync(t, { recursive: true, force: true });
      out(`purged ${targets.length} item(s) from ${config.dataDir}`);
    } catch (error) {
      fatal(error);
    }
  });

program.parseAsync(process.argv).catch(fatal);
