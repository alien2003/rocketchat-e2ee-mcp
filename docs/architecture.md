# Architecture

rc-mcp is a read-only MCP server (stdio) and CLI. It reads a Rocket.Chat workspace over REST with the user's
personal access token (PAT). It decrypts end-to-end encrypted rooms locally with the user's own keys, and keeps a
full-text index of the plaintext in SQLite.

- **Decisions:** ADR [0001](adr/0001-architecture.md) (overall architecture), [0002](adr/0002-node-sqlite.md) (SQLite),
  [0003](adr/0003-ground-truth-testing.md) (testing), [0004](adr/0004-read-only-and-suggested-keys.md) (read-only
  surface and key handling).
- **Crypto formats:** [e2ee-protocol.md](e2ee-protocol.md).

## Module map

| Module | Responsibility |
| --- | --- |
| `src/cli/main.ts` | `rc-mcp` entry point (commander). Sets `umask 077`. Commands: `serve` (default), `doctor`, `sync`, `search`, `export`, `purge`. Maps errors to exit codes. |
| `src/cli/doctor.ts` | Checks config, server, token, E2EE key state and per-room readability, without printing secrets. |
| `src/cli/export.ts` | Writes a room or thread as Markdown. |
| `src/cli/output.ts` | **The only module that writes to stdout**, used only by non-`serve` commands. |
| `src/config.ts` | Configuration from environment variables and an optional JSON file that must be mode 0600 (`RC_MCP_CONFIG` or `$XDG_CONFIG_HOME/rc-mcp/config.json`). Environment variables override the file. Registers secrets with the logger. |
| `src/logger.ts` | JSON-lines logger that writes **only to stderr**. Scrubs secrets by key name and by value. |
| `src/version.ts` | `VERSION`, `USER_AGENT`. |
| `src/app.ts` | Wiring: `RcClient`, lazy `E2eeSession`, `IndexStore`, `Syncer`. Room-list refresh with a max age. `soft()`: optional network work that degrades to the local index, with a 30 s circuit breaker. The interactive client profile used by `serve`. |
| `src/index.ts` | Programmatic API (re-exports). |
| `src/rc-api/client.ts` | `RcClient`: `get()` for allowlisted endpoints only; `download()` for `/file-upload/...`; `serverInfo()`; `paginate()`. Handles rate limits, retries and timeouts, and records the server clock (`serverNow`). |
| `src/rc-api/schemas.ts` | zod schemas for every response, the `ENDPOINTS` allowlist, and `FORBIDDEN_ENDPOINTS` with the reason for each. |
| `src/rc-api/errors.ts` | `RcApiError` with codes `unauthorized`, `forbidden`, `not-found`, `bad-request`, `rate-limited`, `server-error`, `timeout`, `network`, `invalid-response`, `too-large`. |
| `src/e2ee/encoding.ts` | Base64 (strict), Latin-1 "binary strings" (`Binary.decode` / `encode`), hex. |
| `src/e2ee/ejson.ts` | Read-only EJSON reviver (`$date`, `$binary`, ...). |
| `src/e2ee/private-key.ts` | Stored private key v1/v2 → PBKDF2 → RSA-OAEP private key. |
| `src/e2ee/room-key.ts` | Splits and unwraps `prefix + base64(RSA ciphertext)` room keys (A256GCM / A128CBC). |
| `src/e2ee/keyring.ts` | Per-room keyring from `E2EKey`, `E2ESuggestedKey`, `oldRoomKeys` and `suggestedOldRoomKeys`. Provides `keyStatus` and the client's key selection order. |
| `src/e2ee/content.ts` | Versioned content codecs (`rc.v1.aes-sha2`, `rc.v2.aes-sha2`, bare legacy string) and AES decryption into EJSON. |
| `src/e2ee/message.ts` | Raw message → `{message, decryption}`. Handles `e2e`, `message_pinned_e2e`, removed files and failure reasons. |
| `src/e2ee/file.ts` | AES-CTR file decryption and the SHA-256 check. |
| `src/e2ee/session.ts` | `E2eeSession`: the unlocked private key and the cached keyrings, **in memory only**. |
| `src/e2ee/errors.ts` | `E2eeError` and the failure reasons. |
| `src/e2ee/webcrypto.ts` | `globalThis.crypto.subtle` handle and types. |
| `src/index/db.ts` | Opens `node:sqlite` (file or `:memory:`). Enforces 0700/0600 permissions, WAL mode and schema migrations. |
| `src/index/store.ts` | `IndexStore`: rooms, messages, sync state, FTS5 search (`snippet`, `bm25`), deletes. |
| `src/index/convert.ts` | Raw REST message → `MessageRecord`: decrypts, and strips per-file keys from attachments. |
| `src/index/sync.ts` | `Syncer`: room refresh, backfill, incremental sync, deletions, retry of undecryptable messages. |
| `src/mcp/server.ts` | `McpServer`: registers the 8 tools and the `rocketchat://room/{rid}` resource. Maps every error to one shape. |
| `src/mcp/operations.ts` | Tool implementations, shared with the CLI. Syncs on demand before reading, answers from the index when Rocket.Chat is unreachable, validates and normalises dates. |
| `src/mcp/format.ts` | LLM-facing JSON shapes, permalinks, quote parsing, `REASON_HINTS`. |
| `src/mcp/stdio.ts` | Stdio transport, signal and stdin-EOF shutdown, background warm-up. |

## Data flow

```
                 env / 0600 config file (PAT, E2EE password)
                                  │
                                  ▼
  Rocket.Chat  ◄─── GET only ── rc-api/client.ts ── zod-validated JSON ──┐
  REST API         (allowlist,                                          │
  /file-upload/     PAT headers,                                        │
                    rate limits)                                        ▼
                                  e2e.fetchMyKeys ──► e2ee/session.ts (private key, in memory)
                                  subscriptions.get ─► e2ee/keyring.ts (room keys, in memory)
                                  rooms.history /
                                  chat.syncMessages ─► index/convert.ts ─► e2ee/message.ts (decrypt)
                                                               │
                                                               ▼   plaintext + metadata, no keys
                                                     index/store.ts  (SQLite + FTS5, 0600)
                                                               │
                         ┌─────────────────────────────────────┴──────────────────────┐
                         ▼                                                            ▼
              mcp/operations.ts ─► mcp/format.ts ─► mcp/server.ts           cli/main.ts (doctor, sync,
                         │                               │ stdio JSON-RPC    search, export, purge)
                         │                               ▼                            │
                         │                         MCP client / LLM                   ▼
                         │                                                    stdout (non-serve only)
                         └─► get_file: chat.getMessage → decrypt content → download /file-upload/…
                                     → AES-CTR decrypt + SHA-256 → inline text / image, a 0600 file,
                                       or (ephemeral) an inline blob
```

Reads are served from the index. Each tool first brings the rooms it touches up to date, and falls back to live
REST when the index is cold:

- `get_message` / `get_thread` fetch `chat.getMessage` when the message is not indexed.
- `get_thread` also fetches `chat.getThreadMessages` when the root's `tcount` exceeds the indexed replies.
- `search` merges server `chat.search` results for unencrypted rooms when `rooms` is given or
  `include_server_search` is true (see [On-demand sync](#syncall-and-on-demand-sync)).

When Rocket.Chat cannot be reached, the read tools answer from the index instead
(see [Offline operation](#offline-operation-and-the-circuit-breaker)).

`app.ts` initialises lazily, so `serve` answers `initialize` immediately. After connecting, a background warm-up
unlocks the keys and loads the room list, about three REST calls. A failed warm-up is logged, and tools retry on
demand.

## Sync algorithm

### Rooms and key status

`Syncer.refreshRooms` makes one `subscriptions.get` and one `rooms.get` call. It produces one room record per
subscription:

- **Encrypted** means `room.encrypted`, or the subscription carries `E2EKey` or `E2ESuggestedKey`.
- **`key_status`** is one of:
  - `ok`: an accepted current key (`E2EKey`) that unwraps;
  - `suggested`: no usable `E2EKey`, but a suggested key that unwraps. Its `suggestedOldRoomKeys` are used as old
    keys when the subscription has no `oldRoomKeys` (ADR 0004);
  - `missing`: no key;
  - `undecryptable`: no usable current or suggested key, and some wrapped key did not unwrap with the user's private
    key;
  - `not-encrypted`;
  - `e2ee-unavailable`: no password, wrong password, or no keys on the account.
- Rooms the user is no longer subscribed to are removed, together with their messages (`retainRooms`).

The app refreshes the room list at most once per 60 s. `list_rooms` without a filter uses 15 s.

### Per-room cursors (`sync_state`)

| Column | Meaning |
| --- | --- |
| `backfill_cursor` | Epoch-ms string passed as `rooms.history?previous=`. It is an exclusive upper bound on `ts`, and the backfill walks from newest to oldest. |
| `backfill_done` | 1 once `rooms.history` returns no `cursor.previous` or an empty page. |
| `updated_cursor` | Epoch-ms watermark for `chat.syncMessages?lastUpdate=` (server clock). |
| `deleted_cursor` | Set to `updated_cursor` when the backfill starts and not used afterwards: deletions arrive in the same `chat.syncMessages` call as updates. |
| `last_sync_at` | ISO time of the last completed `syncRoom`. |

### `syncRoom(rid)`

1. **Full resync** (drop the room's messages and cursors) when any of these holds:
   - `--full` / `full: true` was requested;
   - `updated_cursor` is more than 29 days behind the server clock (Rocket.Chat expires deleted-message records
     after 30 days, so older deletions can no longer be seen);
   - a sync state exists without any cursor.
2. **Keyring:** built from the subscription, or none when E2EE is unavailable. Stored undecryptable messages are
   then retried locally, but only when the keyring (current key id and old key ids) differs from the one used for
   the previous retry of that room in this process. While undecryptable, a message keeps its raw ciphertext
   document in `pending_raw` so that it can be decrypted locally once a key arrives, without refetching.
3. **Incremental step** (when `updated_cursor` is set):
   - Call `chat.syncMessages?roomId=…&lastUpdate=<updated_cursor − 1 ms>`. The server returns messages with
     `_updatedAt > lastUpdate` and deletions with `_deletedAt > lastUpdate`, unpaginated, in one call.
   - Upsert `updated`. A message with `t: 'rm'` (deleted-status tombstone) is deleted from the index.
   - Delete every id in `deleted`.
   - New `updated_cursor` = max(old value, server `Date` header − 5 s). The 5 s margin covers writes stamped
     slightly earlier that commit after the read; the overlap is re-fetched idempotently. Only when the response has
     no `Date` header is the newest `_updatedAt` / `_deletedAt` seen, minus 5 s, used instead.
4. **Backfill step**, while not `backfill_done` and fewer than `max_messages` were fetched in this call:
   - Call `rooms.history?roomId=…&count=100[&previous=<backfill_cursor>]`.
   - On the very first page, set `updated_cursor` and `deleted_cursor` to the server clock (from the `Date` header)
     minus 5 s. Anything edited or deleted while a long backfill runs is then picked up by the next incremental
     step.
   - Ingest the page.
   - If there is no `cursor.previous` or the page is empty, set `backfill_done`.
   - Otherwise the next cursor is the oldest `ts` on the page + 1 ms, so messages sharing that millisecond are not
     skipped. If adding 1 ms would not move the cursor backwards, the cursor is the oldest `ts` itself, so the walk
     always progresses.
5. Save `last_sync_at`.

The 1 ms overlaps are safe because every write is an idempotent upsert keyed by message `_id`
(`INSERT … ON CONFLICT (id) DO UPDATE`). The upsert reports `inserted`, `updated` or `unchanged`; it compares
`_updatedAt`, text and decryption state.

### `syncAll` and on-demand sync

`syncAll` refreshes the rooms, then syncs each room in turn:

- With `skipUnchanged`, it skips rooms whose history is complete and whose server `_updatedAt` is older than the
  room's `updated_cursor`. Both values come from the server clock.
- A failing room is reported with its error, and the other rooms continue.

The `sync` tool backfills at most `max_messages` (default 2000) per room per call; its result says when history is
still incomplete and counts `failed_rooms`. `rc-mcp sync` without `--max-messages` backfills everything, and exits
with code 1 when a room failed.

Tools sync on demand:

- **`get_messages`** (and the room resource):
  - When the room's last sync is older than 60 s, it runs one `syncRoom` (incremental step plus a backfill of up
    to max(2 × `limit`, 200) messages).
  - It then backfills older history only, without repeating the incremental call, until the requested page lies
    inside the contiguously indexed range, for up to 25 rounds.
  - **Frontier rule:** it never returns rows older than the backfill frontier (`backfill_cursor` − 1 ms, or no
    limit once `backfill_done`). Rows beyond it, for example messages indexed by `get_message` or a thread fetch,
    are shown only once the backfill reaches them, so a page never looks complete when it has gaps. `has_older`
    stays true while older history is not indexed, and a note says so when a page reaches the frontier.
  - `before` is exclusive and `after` inclusive (`ts >= after`). Dates are parsed, rejected with
    `invalid-argument` when invalid, and normalised to UTC ISO; a date-only value means midnight UTC. `search` and
    `export --since` / `--until` use the same rules.
- **`get_thread`**: when the room is indexed and its last sync is older than 60 s, it runs the incremental step
  only (or a first backfill of up to 200 messages for a room never synced). It fetches `chat.getThreadMessages` in
  pages of 100 when the root's `tcount` exceeds the indexed replies. For a room that is not in the index, the
  replies are returned from memory and not stored. The result has `total_replies`, `returned` and, when `limit`
  cut the list, `truncated`.
- **`search`** (unless `refresh: false`, which makes no network calls unless `include_server_search: true` is passed):
  - with `rooms`, it syncs each named room whose last sync is older than 60 s, up to 2000 messages per room;
  - without `rooms`, it runs `syncAll` with `skipUnchanged`, up to 2000 messages per room, at most once every
    5 minutes.
  - **Server search** (`chat.search`, unencrypted rooms only) runs by default only when `rooms` is given, otherwise
    only with `include_server_search: true`. It queries up to 10 unencrypted rooms (the named ones, or the 10 most
    recently active), applies the `from`, `after`, `before` and `thread_id` filters, and waits at most 2 s for a
    rate limit. When a call is rate-limited or Rocket.Chat is unreachable, it stops and adds a note. Merged results
    are capped at `limit`; `more_available: true` says that some were cut.

### Offline operation and the circuit breaker

Read paths run their network work through `App.soft` (`src/app.ts`):

- When a call fails with `network`, `timeout`, `server-error`, `unauthorized` or `rate-limited` and the index has
  rooms, the tool answers from the index and adds a `notes` entry saying the results may be stale.
- For 30 s after such a failure, read paths skip network work and say so in `notes`, so each call does not wait
  for timeouts again.
- This covers `list_rooms`, `get_messages`, `get_thread`, `get_message` for messages already in the index, and
  `search`. `list_rooms` reports `e2ee: "unknown (offline)"` when the keys cannot be fetched.
- With an empty index, the error is returned as usual. `sync`, `get_file`, `get_user` and messages that are not
  indexed need the server.

`rc-mcp serve` builds its REST client with an interactive profile: 20 s request timeout, 2 retries, at most 45 s
of rate-limit wait. The other CLI commands keep the defaults (30 s, 5 retries, 120 s).

### Files (`get_file`)

1. **Locate.** `file_id` must match `[A-Za-z0-9_-]{1,64}`. With `message_id`, or a message found in the index by
   `file_id`, the message is fetched again with `chat.getMessage` and decrypted, because file keys are never stored.
   If that message does not carry the requested file, the result is `file-not-found`.
2. **Key.** The per-file key comes from the decrypted message. An E2EE file message without encrypted content takes
   it from the room's upload record (`groups.files` / `im.files` / `channels.files`). A file that neither the index
   nor a given message knows is looked up in the upload lists of up to 30 rooms; if it is not found there, the
   result is `file-not-found`. Nothing is downloaded blind.
3. **Download and decrypt.** `/file-upload/<id>/<name>` with the PAT, at most 50 MiB. Encrypted files are
   decrypted with AES-CTR and checked against the uploader's SHA-256 (`integrity`: `verified` or `unverified`,
   reported for encrypted files only).
4. **Return.**
   - Text-like files (by MIME type or extension) up to `max_inline_bytes` (default 256 KiB) come back as text.
   - Images up to 4 MiB come back as MCP image content. They are not saved.
   - Other files are saved to `<dataDir>/files/<fileId>-<sanitised name>` with mode 0600, in a 0700 directory
     that carries the marker file `.rc-mcp-files`; the path is returned as `saved_to`.
   - In ephemeral mode nothing is written: such files come back inline as an MCP embedded resource
     (`rocketchat://file/<id>`) up to 10 MiB, and larger ones fail with `file-too-large`.

`rc-mcp purge` deletes `index.sqlite` (with its WAL/SHM files) and the files directory, the latter only when it
carries the marker. It also works while `RC_MCP_EPHEMERAL` is set, to clean up data from earlier on-disk runs.

## Index schema (schema version 1)

| Table | Contents |
| --- | --- |
| `meta` | `schema_version`. A database written by a newer rc-mcp is refused, with the hint to run `rc-mcp purge`. |
| `rooms` | `rid`, `t`, `name`, `fname`, `display_name`, `encrypted`, `key_status`, `key_detail`, `topic`, `archived`, `last_message_at`, `updated_at` |
| `sync_state` | The cursors above, one row per room. |
| `messages` | `id`, `rid`, `tmid`, `t`, `ts`, `updated_at`, `edited_at`, author (`user_id`, `username`, `user_name`), decrypted `text`, `encrypted`, `decryption_state` (`plaintext` / `decrypted` / `undecryptable`), `failure_reason`, `failure_detail`, `kid`, `attachments_json`, `file_json`, `tcount`, `search_text`, `pending_raw` |
| `messages_fts` | FTS5 external-content table over `messages.search_text`, tokenizer `unicode61 remove_diacritics 2`. Kept in sync by insert, update and delete triggers. |

The table has indexes on `(rid, ts)`, `(tmid, ts)` and `username`, and a partial index on rows with `pending_raw`.

- **`search_text`** holds the message text plus attachment titles, descriptions, quote texts and file names. It is
  filled only for normal and encrypted messages, pins and `discussion-created`; other system messages are not
  searchable.
- **`attachments_json`** keeps decrypted attachment metadata (`title`, `type`, `description`, `text`, `fileId`,
  `fileName`, `mimeType`, `size`, `encrypted`, `imageDimensions`, quote author and link). The per-file
  `encryption` key and IV are dropped (`sanitizeAttachment`), so the index never holds file keys.
- **Search** uses `toFtsQuery`:
  - every token must match (AND);
  - a trailing `*` keeps prefix matching;
  - accents are folded;
  - results come ranked by `bm25` with a `snippet()` highlighted with `«»`.

## Threat model summary

**Assets**

- The PAT and the E2EE password.
- The RSA private key, room keys and file keys. They live in process memory only.
- Decrypted plaintext: in the index, in files saved by `get_file`, and in the LLM context.
- The integrity of the user's Rocket.Chat state.

**Trust boundaries**

| Party | Trusted for | Not trusted for |
| --- | --- | --- |
| Rocket.Chat server | Availability and metadata | Confidentiality of E2EE rooms, which is the point of E2EE. Every response is schema-validated. |
| Local user account | Holding the index and secrets | n/a. Other local users are kept out by 0700/0600 modes and `umask 077`. |
| MCP client and LLM provider | Receiving what the user asks for | **Decrypted text sent to the model leaves the E2EE boundary for every participant of the rooms read.** This is documented prominently; the user must have the consent to do it. |

**Threats and mitigations**

| Threat | Mitigation |
| --- | --- |
| Accidentally changing server state (logout, accepting keys, creating DMs) | `get()` on an explicit allowlist only. No generic request method. A list of forbidden endpoints with reasons. `im.files` only with an existing DM id. See ADR 0004. |
| Secrets in logs, errors or tool output | Logger redacts by key pattern and by registered value (PAT, E2EE password). `RcApiError` messages are scrubbed, and only machine-style server error ids (e.g. `error-not-allowed`) are kept. Config errors never include the token or the password. |
| Credentials sent to another origin | API calls use `redirect: 'error'`. Downloads follow redirects manually (at most 5 hops) and send PAT headers only to the configured origin. Download paths must match `/file-upload/<id>/<name>` with no `..`. Redirect targets are not otherwise restricted: the server is trusted to redirect only to its file storage. |
| Plaintext at rest | 0700 data directory, 0600 database (and WAL/SHM through the umask), 0600 saved files in a 0700 files directory. `RC_MCP_EPHEMERAL=1` keeps the index in memory, and `get_file` then writes nothing to disk. `rc-mcp purge` removes the index, WAL/SHM and the marked files directory. Keys and passwords are never written (ADR 0004). |
| Malicious or compromised server or member | Not mitigated beyond the official client. The protocol has no signatures: a room key only has to unwrap with the user's private key, and message authenticity rests on the room key. Whoever controls the server database can substitute room keys and inject messages that decrypt correctly. rc-mcp inherits this. |
| Prompt injection through chat content | rc-mcp has no write tools; every tool is annotated `readOnlyHint: true`. Injected text cannot make rc-mcp change Rocket.Chat. The MCP client's other tools are outside rc-mcp's control. |
| Resource exhaustion | Downloads are capped at 50 MiB. REST requests time out after 30 s (20 s in `serve`), downloads after four times that. `get_messages` returns at most 200 messages per call. `search` caps its `limit` at 100. The `sync` tool backfills at most 2000 messages per room per call by default. Inline images are capped at 4 MiB and ephemeral inline files at 10 MiB. |
| Supply chain | Three runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `commander`). No native modules; SQLite is built into Node. |

**Residual risks:**

- Plaintext stays on disk until purged.
- With `Message_KeepHistory` on and `Message_ShowDeletedStatus` off, Rocket.Chat hides deleted messages without
  reporting them through any sync endpoint. Such messages stay in the index until `rc-mcp sync --full`
  ([e2ee-protocol.md §10](e2ee-protocol.md#10-deletion-semantics)).
- Content shared with the LLM provider cannot be recalled.
- Rocket.Chat's own E2EE limits apply: no forward secrecy across the kept old room keys, and file sizes and thread
  structure are visible to the server.

## Error handling

**REST** (`src/rc-api/client.ts`):

- Network errors, timeouts and HTTP 5xx are retried up to 5 times (2 in `serve`). The backoff is exponential,
  500 ms·2ⁿ capped at 30 s, plus up to 250 ms of jitter.
- On HTTP 429 the client waits until `X-RateLimit-Reset` (absolute epoch ms) + 100 ms, or backs off when the header
  is missing. It gives up with `rate-limited` when the wait would exceed 120 s (45 s in `serve`, 2 s for the
  optional server-search calls) or the retries are exhausted.
- When a response reports `X-RateLimit-Remaining: 0`, that route is paused until its reset.
- Requests are serialised per route.
- A non-JSON success body, or a body that fails its zod schema, raises `invalid-response`.
- HTTP 401 and `totp-required` get specific messages: check the PAT, or recreate it with
  "Ignore Two Factor Authentication".

**E2EE:**

- Unlocking never throws for expected conditions. `E2eeSession.open` returns `unavailable` with a reason, and
  encrypted rooms are still listed.
- A message that cannot be decrypted is stored and returned as `undecryptable` with a reason, a hint and the key id.
  Nothing is dropped or guessed.

**Sync:** per-room failures go into the sync report, and the remaining rooms continue.

**MCP tools** (`src/mcp/server.ts`):

- Every tool returns either JSON text or `isError: true` with `{"error": {"code", "message", "hint"?}}`.
- `code` is one of:
  - a `ToolError` code: `room-not-found`, `invalid-argument`, `message-deleted`, `file-not-found`,
    `file-key-missing`, `file-too-large`, `undecryptable`;
  - `rocketchat-<RcApiError code>`, with hints for `unauthorized` (a Rocket.Chat account E2E key reset also
    revokes PATs), `rate-limited`, and `network` / `timeout` ("Rocket.Chat is unreachable: check RC_URL and the
    network");
  - `e2ee-<failure reason>`;
  - `internal-error`, with its message scrubbed.
- Arguments that fail a tool's input schema (for example `limit` above its maximum) are rejected by the MCP SDK
  before the tool runs. That error is plain text (`MCP error -32602: Input validation error: …`) with
  `isError: true`, not the JSON shape above.

**CLI** (`src/cli/main.ts`):

- Configuration errors exit with code 2. Other errors exit with code 1, printing the message and hint to stderr.
- `doctor` exits with code 1 only when a check fails; warnings do not change the exit code. `sync` exits with
  code 1 when a room failed.
- Numeric options must be positive integers.
- Uncaught exceptions and unhandled rejections are logged and exit with code 1.

## Logging and the stdout rule

In `rc-mcp serve`, **stdout is the MCP JSON-RPC channel**. A single stray byte corrupts the session.

**Logger** (`src/logger.ts`):

- Writes JSON lines `{"time", "level", "msg", ...fields}` to stderr only.
- Levels are `debug`, `info`, `warn`, `error` and `silent`, set by `RC_MCP_LOG_LEVEL` (default `info`).
- Field values whose key matches `password`, `passphrase`, `secret`, `token`, `authorization`, `private_key`,
  `E2EKey`, `E2ESuggestedKey`, `cookie` or a JWK private member name (`d`, `p`, `q`, `dp`, `dq`, `qi`, `k`) are
  replaced by `[REDACTED]`.
- Every string is also scrubbed of registered secret values.

**Stdout:**

- Only `src/cli/output.ts` writes to stdout, and only the non-`serve` commands load it, lazily.
- CLI error text goes to stderr.

**Enforced by:**

- Biome's `noConsole` rule as an error in `src/` (`biome.json`);
- `test/unit/stdout-guard.test.ts`. Its static part checks that there is no `console.*` in `src/`, that only
  `output.ts` touches `process.stdout`, and that the serve path never imports `output.ts`. Its dynamic part spawns
  `rc-mcp serve`, drives `initialize`, `tools/list` and a failing `tools/call`, and asserts that every stdout line
  is JSON-RPC while the logs appear on stderr.

Never wrap `rc-mcp serve` in tools that print to stdout.

## Test layers

| Layer | Command | Needs | What it covers |
| --- | --- | --- | --- |
| Unit (139 tests in 9 files, offline) | `mise run test` | Nothing | Crypto against committed real-client fixtures (`test/fixtures/8.9.0`) and upstream legacy vectors (`test/fixtures/upstream/legacy-v1.json`). E2EE failure modes. Index and sync against `test/support/fake-rc.ts`, which serves the captured REST dumps with 8.9.0 cursor semantics. MCP tools through the SDK's `InMemoryTransport`. REST client: allowlist, forbidden endpoints, rate limits, scrubbing. Config and logger. Stdout guard. |
| Integration (21 tests in 3 files) | `mise run test:integration` | Compose stack (`mise run rc:up`) and a recorded ground-truth run (`mise run test:ground-truth` or `mise run fixtures:generate`, once) | The real REST client, pagination, `chat.syncMessages`, downloads, the accounts alice, bob, carol and the admin (`rcadmin`), the real `rc-mcp serve` over stdio with the MCP client SDK, and the real 429 limiter (enabled at runtime; the stack starts with it off). |
| Ground truth | `mise run test:ground-truth` | Compose stack and Playwright Chromium | Drives the real web client into `.local/ground-truth/$RC_VERSION`, then runs the same fixture assertions on that fresh capture. See ADR 0003. |

`mise run check` runs lint, typecheck and the unit tests. To run several tasks in one call, separate them with
`:::` (`mise run lint ::: typecheck`); `mise run lint typecheck` would pass `typecheck` as an argument to `lint`.
