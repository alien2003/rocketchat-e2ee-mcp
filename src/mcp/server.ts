/**
 * MCP server (stdio). All tools are read-only; descriptions are written for an LLM deciding which tool to call.
 * Errors use one shape: { "error": { "code", "message", "hint"? } } with isError: true.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { App } from '../app.ts';
import { isE2eeError } from '../e2ee/errors.ts';
import { createLogger, scrubSecrets } from '../logger.ts';
import { RcApiError } from '../rc-api/errors.ts';
import { VERSION } from '../version.ts';
import { formatMessage, REASON_HINTS } from './format.ts';
import {
  getFile,
  getMessage,
  getMessages,
  getThread,
  getUser,
  listRooms,
  search,
  syncRooms,
  ToolError,
} from './operations.ts';

const log = createLogger({ name: 'mcp' });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toErrorPayload(error: unknown): { code: string; message: string; hint?: string } {
  if (error instanceof ToolError)
    return { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) };
  if (error instanceof RcApiError) {
    const hint =
      error.code === 'unauthorized'
        ? 'Check RC_USER_ID / RC_AUTH_TOKEN (a Rocket.Chat account E2E key reset also revokes PATs). Run `rc-mcp doctor`.'
        : error.code === 'rate-limited'
          ? 'Rocket.Chat rate limit hit; wait and retry, or ask an admin to raise API_Enable_Rate_Limiter limits.'
          : error.code === 'network' || error.code === 'timeout'
            ? 'Rocket.Chat is unreachable: check RC_URL and the network. Run `rc-mcp doctor`.'
            : undefined;
    return { code: `rocketchat-${error.code}`, message: error.message, ...(hint ? { hint } : {}) };
  }
  if (isE2eeError(error))
    return { code: `e2ee-${error.reason}`, message: error.message, hint: REASON_HINTS[error.reason] };
  return { code: 'internal-error', message: scrubSecrets(error instanceof Error ? error.message : String(error)) };
}

function fail(error: unknown): CallToolResult {
  const payload = toErrorPayload(error);
  log.warn('tool failed', { code: payload.code, message: payload.message });
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: payload }, null, 2) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

const roomRef = z
  .string()
  .min(1)
  .describe('Room id, room name (e.g. "dev-handbook"), display name, or "@username" for a direct message.');
const isoDate = z
  .string()
  .describe('ISO-8601 date or date-time, e.g. "2026-03-01" (midnight UTC) or "2026-03-01T14:00:00+02:00".');

export function createServer(app: App): McpServer {
  const server = new McpServer(
    { name: 'rocketchat-e2ee', version: VERSION, title: 'Rocket.Chat (E2EE-aware, read-only)' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        'Read-only access to a Rocket.Chat workspace, including end-to-end encrypted rooms (decrypted locally).',
        'Typical flow: list_rooms -> search (full-text over the local index, with room/user/date filters) ->',
        'get_message / get_thread / get_messages to read context -> get_file for attachments.',
        'Team documentation, decisions and how-tos often live in threads: when a hit has reply_count or thread_id,',
        'read the whole thread with get_thread. Messages that cannot be decrypted are returned with an',
        '`undecryptable.reason` and hint instead of text; never guess their content.',
        'Nothing here can send, edit or react to messages.',
      ].join(' '),
    },
  );

  server.registerTool(
    'list_rooms',
    {
      title: 'List rooms',
      description:
        'List the rooms (channels, private groups, direct messages) this account belongs to, with type, whether the room is end-to-end encrypted, the E2EE key status (ok | suggested | missing | undecryptable | not-encrypted | e2ee-unavailable), last activity and how much of it is indexed locally. Use it to find room ids/names for the other tools.',
      inputSchema: {
        filter: z.string().optional().describe('Case-insensitive substring of the room name or topic.'),
        type: z
          .enum(['all', 'channel', 'private-group', 'direct-message'])
          .optional()
          .describe('Restrict to one room type.'),
        encrypted_only: z.boolean().optional().describe('Only end-to-end encrypted rooms.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rooms to return (default 200).'),
      },
      annotations: READ_ONLY,
    },
    wrap((args) => listRooms(app, args)),
  );

  server.registerTool(
    'get_messages',
    {
      title: 'Read messages in a room',
      description:
        'Read messages of one room, decrypted, oldest-first within the returned page (newest page by default). Each message has id, ts, author, text, thread_id/reply_count, attachments and a permalink. Page backwards with `before` = the returned `older_than_cursor`. Thread replies are excluded unless include_thread_replies is true (use get_thread for a whole thread). The room is synced incrementally before reading.',
      inputSchema: {
        room: roomRef,
        before: isoDate
          .optional()
          .describe('Only messages strictly before this instant (pass older_than_cursor to page back).'),
        after: isoDate.optional().describe('Only messages at or after this instant.'),
        limit: z.number().int().min(1).max(200).optional().describe('Messages to return (default 30, max 200).'),
        include_thread_replies: z.boolean().optional().describe('Also include replies that live in threads.'),
      },
      annotations: READ_ONLY,
    },
    wrap((args) => getMessages(app, args)),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a thread',
      description:
        'Read a whole thread: the root message and all replies in chronological order, decrypted. Accepts the root message id, any reply id, or a pasted Rocket.Chat thread/message URL. Threads are where most how-tos and decisions are discussed.',
      inputSchema: {
        thread_id: z.string().optional().describe('Root message id (or any reply id) of the thread.'),
        url: z
          .string()
          .optional()
          .describe('A Rocket.Chat URL such as https://chat.example.com/group/ops/thread/<id>.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Maximum replies (default 500).'),
      },
      annotations: READ_ONLY,
    },
    wrap((args) => getThread(app, args)),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get one message',
      description:
        'Fetch a single message by id or by a pasted Rocket.Chat permalink (…?msg=<id>), decrypted. Messages that quote other messages list them in `quotes`, and the quoted messages are resolved and returned in `quoted_messages`.',
      inputSchema: {
        id: z.string().optional().describe('Message id.'),
        url: z.string().optional().describe('A Rocket.Chat message URL containing ?msg=<id>.'),
        resolve_quotes: z.boolean().optional().describe('Resolve quoted messages (default true).'),
      },
      annotations: READ_ONLY,
    },
    wrap((args) => getMessage(app, args)),
  );

  server.registerTool(
    'search',
    {
      title: 'Search messages',
      description:
        'Full-text search over the locally indexed, decrypted messages of all rooms (including end-to-end encrypted ones). All words must match; accents are ignored; append * for prefix search (deploy*). Filter by rooms, authors (usernames), date range or thread. Results include a «highlighted» snippet, thread info and permalink. When specific unencrypted rooms are given, the Rocket.Chat server search is also queried and merged (`source`: index | server | index+server). Stale rooms are synced first unless refresh=false; if Rocket.Chat is unreachable the local index still answers and `notes` says so.',
      inputSchema: {
        query: z.string().min(1).describe('Words to search for, e.g. "deploy runbook" or "postgres failover".'),
        rooms: z.array(roomRef).optional().describe('Limit to these rooms.'),
        from: z.array(z.string()).optional().describe('Limit to messages by these usernames.'),
        after: isoDate.optional().describe('Only messages at or after this instant.'),
        before: isoDate.optional().describe('Only messages strictly before this instant.'),
        thread_id: z.string().optional().describe('Limit to one thread (root id).'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 20).'),
        include_server_search: z
          .boolean()
          .optional()
          .describe(
            'Also query Rocket.Chat server search for unencrypted rooms (default: only when `rooms` is given; unencrypted rooms are indexed locally anyway).',
          ),
        refresh: z.boolean().optional().describe('Sync stale rooms before searching (default true).'),
      },
      annotations: READ_ONLY,
    },
    wrap((args) => search(app, args)),
  );

  server.registerTool(
    'sync',
    {
      title: 'Sync the local index',
      description:
        'Fetch new, edited and deleted messages into the local index of decrypted messages, for one room or for all rooms. Older history is backfilled in chunks of up to max_messages (default 2000) per room per call: if `note` says history is incomplete, call again. Returns what changed per room. Only reads from Rocket.Chat.',
      inputSchema: {
        room: roomRef.optional().describe('Sync only this room (default: all rooms that changed).'),
        full: z.boolean().optional().describe('Discard the local copy and re-index from scratch.'),
        max_messages: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe('Backfill at most this many older messages per room in this call.'),
      },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    wrap((args) => syncRooms(app, args)),
  );

  server.registerTool(
    'get_file',
    {
      title: 'Get an attachment',
      description:
        "Download an attachment and decrypt it locally if it was uploaded to an encrypted room (integrity checked against the uploader's SHA-256). Text-like files (markdown, code, json, csv, txt…) up to max_inline_bytes are returned as text; images up to 4 MiB as images; other files are saved to the private data directory and the path is returned (in ephemeral mode they are returned inline as a binary resource instead, never written to disk). Identify the file by file_id (from a message's attachments) or by message_id.",
      inputSchema: {
        file_id: z.string().optional().describe('The attachment file_id.'),
        message_id: z.string().optional().describe('The message carrying the file.'),
        max_inline_bytes: z
          .number()
          .int()
          .min(0)
          .max(1048576)
          .optional()
          .describe('Inline text limit (default 262144).'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const res = await getFile(app, args);
        const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(res.meta, null, 2) }];
        if (res.text !== undefined) content.push({ type: 'text', text: res.text });
        if (res.image) content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType });
        if (res.blob) {
          content.push({
            type: 'resource',
            resource: {
              uri: `rocketchat://file/${String(res.meta.file_id)}`,
              mimeType: res.blob.mimeType,
              blob: res.blob.data,
            },
          });
        }
        return { content };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_user',
    {
      title: 'Look up a user',
      description:
        'Look up a Rocket.Chat user by username or id: display name, status, status text, bio, roles and timezone offset when visible to this account.',
      inputSchema: {
        username: z.string().optional().describe('Username, with or without @.'),
        user_id: z.string().optional().describe('User id.'),
      },
      annotations: READ_ONLY,
    },
    wrap((args) => getUser(app, args)),
  );

  // Rooms as resources: rocketchat://room/<rid> -> recent decrypted messages as a Markdown transcript.
  server.registerResource(
    'room',
    new ResourceTemplate('rocketchat://room/{rid}', {
      list: async () => {
        try {
          await app.refreshRooms();
        } catch (error) {
          log.warn('could not list rooms for resources', { error: toErrorPayload(error) });
        }
        return {
          resources: app.store.listRooms().map((r) => ({
            uri: `rocketchat://room/${r.rid}`,
            name: r.displayName,
            description: `${r.t === 'd' ? 'Direct message' : r.t === 'p' ? 'Private group' : 'Channel'}${r.encrypted ? ' (end-to-end encrypted)' : ''}`,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    { title: 'Rocket.Chat room', description: 'Recent messages of a room (decrypted)', mimeType: 'text/markdown' },
    async (uri, variables) => {
      const rid = String(variables.rid);
      const page = await getMessages(app, { room: rid, limit: 50 });
      const room = app.store.getRoom(rid);
      const lines = [`# ${room?.displayName ?? rid}`, ''];
      for (const m of page.messages) {
        const body = m.undecryptable ? `_[undecryptable: ${m.undecryptable.reason}]_` : m.text;
        lines.push(
          `**${m.author}** · ${m.ts}${m.reply_count ? ` · ${m.reply_count} replies (thread ${m.id})` : ''}`,
          '',
          body,
          '',
        );
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }] };
    },
  );

  return server;
}

export { formatMessage };
