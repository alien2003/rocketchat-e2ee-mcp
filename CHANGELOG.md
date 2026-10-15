# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-15

First release: a read-only MCP server (stdio) and CLI, `rc-mcp`, that lets Claude Code browse and search a
Rocket.Chat workspace, including end-to-end encrypted rooms, decrypting locally with the user's own keys. Tested
against Rocket.Chat 8.9.0.

### Added

#### E2EE codecs

- WebCrypto port of the Rocket.Chat 8.9.0 client's E2EE code (`apps/meteor/client/lib/e2ee`), decrypt side only,
  with versioned codecs so new formats are additive.
- Stored private key formats v1 (`$binary`, AES-CBC, 1000 PBKDF2 iterations, user id as salt) and v2 (AES-GCM,
  100000 iterations, `v2:<userId>:<uuid>` salt). Password and salt bytes are Latin-1, as in the official client;
  passwords with characters above U+00FF are rejected with `unsupported-password`.
- Room keys unwrapped with RSA-OAEP-SHA256 from `E2EKey`, `oldRoomKeys` and `E2ESuggestedKey` (A256GCM and legacy
  A128CBC). Key selection follows the client: the `oldRoomKeys` entry whose id matches the message's key id, else the
  current key, so messages from before a room-key reset stay readable.
- `suggestedOldRoomKeys` are used when only a suggested key is present and the subscription has no `oldRoomKeys` of
  its own, mirroring the server's accept rule, so history from before a reset is readable in the `suggested` state.
- Message content `rc.v2.aes-sha2` (AES-GCM-256), `rc.v1.aes-sha2` (AES-CBC-128) and the legacy bare-string `msg`;
  quotes, attachments and file metadata from the encrypted EJSON payload. As in the client, a legacy bare-string
  payload contributes only its text, `removed-file` attachments on the server copy stay removed, and invalid UTF-8
  is decoded with U+FFFD instead of failing.
- Encrypted uploads: AES-CTR-256 decryption with the per-file key from the message (or, for E2EE file messages
  without encrypted content, from the room's upload record) and SHA-256 verification of the plaintext.
- Suggested room keys are used in memory only and never accepted on the server.
- Explicit failure reasons instead of dropped messages: `no-e2ee-password`, `no-user-keys`, `wrong-password`,
  `unsupported-password`, `no-room-key`, `room-key-missing`, `room-key-undecryptable`, `unsupported-algorithm`,
  `malformed-payload`, `decryption-failed`, `invalid-plaintext`, `file-key-missing`, `file-hash-mismatch`.

#### REST client

- Personal access token authentication and a strictly read-only client: GET requests to an explicit allowlist of
  endpoints plus authenticated file downloads, with no generic request method.
- Known dangerous endpoints documented and refused: `logout` (revokes the calling token, PATs included),
  `chat.ignoreUser`, `im.history` / `dm.history` / `im.messages` (can create a DM) and `e2e.acceptSuggestedGroupKey`.
- zod validation of every response, pagination helpers, per-request timeouts and typed errors.
- Rate-limit handling: `X-RateLimit-Remaining` / `X-RateLimit-Reset` tracking, 429 retries after the reset (backoff
  with jitter when no reset is given), and requests serialised per route.
- Two client profiles: the CLI waits patiently (30 s timeout, 5 retries, rate-limit waits up to 120 s), while
  `rc-mcp serve` uses 20 s, 2 retries and at most 45 s so tool calls don't stall.
- File downloads are capped at 50 MiB and follow up to 4 redirects; redirects to another origin get no credentials.

#### Index and sync

- Local index on `node:sqlite` with FTS5 (`unicode61 remove_diacritics 2`): AND search, prefix matching, accent
  folding, highlighted snippets. No native dependencies.
- Per-room sync: backfill through `rooms.history`; incremental updates and deletions through one unpaginated
  `chat.syncMessages?lastUpdate=…` call per room, with a watermark 5 s behind the server's `Date` header, 1 ms
  cursor overlap and idempotent upserts. Rooms whose watermark is older than 29 days are fully resynced, because
  Rocket.Chat purges its deleted-message trash after 30 days. Messages with `t: 'rm'` count as deleted.
- A sync of all rooms skips rooms whose server-side `_updatedAt` has not moved since the last sync.
- Messages that cannot be decrypted yet are retried locally, without REST calls, when the room's keys change.
- Private storage: 0700 data directory, 0600 database, umask 077 for SQLite's WAL/SHM files; `RC_MCP_EPHEMERAL=1`
  keeps the index in memory. Keys and passwords are never written to disk.

#### MCP server

- stdio MCP server with read-only tools, all annotated `readOnlyHint: true` and `destructiveHint: false`:
  `list_rooms`, `get_messages`, `get_thread`, `get_message`, `search`, `sync`, `get_file` and `get_user`.
- `get_messages` serves only the part of a room's history that is indexed without gaps and backfills older
  history on demand while paging back.
- Date arguments are validated, normalised to UTC and rejected with `invalid-argument` when invalid. `after` is
  inclusive and `before` exclusive; a date without a time means midnight UTC.
- `get_message` and `get_thread` accept pasted permalinks (`?msg=<id>`) and thread URLs (`/thread/<id>`), and any
  id-like message id, including ids of imported messages. Quotes are resolved into the quoted messages, each
  formatted with its own room.
- `get_thread` returns `total_replies`, `returned` and `truncated`, and fetches missing replies with
  `chat.getThreadMessages`, also for threads in rooms that are not indexed.
- `search` merges Rocket.Chat's server-side `chat.search` results for unencrypted rooms: by default only when
  `rooms` is given, otherwise with `include_server_search: true`. Server hits get the same author, date and thread
  filters; results are capped at `limit` (`more_available` when there were more); a rate-limited server search is
  skipped after 2 s with a note.
- `sync` backfills at most 2000 messages per room per call by default (`max_messages`) and reports `failed_rooms`.
- `get_file` returns text-like files up to `max_inline_bytes` (default 256 KiB) as text and images up to 4 MiB as
  MCP image content. Other files are saved with mode 0600 to `<dataDir>/files`, or, in ephemeral mode, returned
  inline as an MCP embedded resource (up to 10 MiB, else `file-too-large`).
- When Rocket.Chat is unreachable (network error, timeout, 5xx, 401 or 429) and the index has data, `list_rooms`,
  `get_messages`, `get_thread`, `get_message` (for indexed messages) and `search` answer from the index with a
  `notes` entry, and skip network work for 30 s after a failure. `list_rooms` reports `e2ee: "unknown (offline)"`
  when the keys cannot be fetched.
- Room resources at `rocketchat://room/{rid}` (Markdown transcript of the 50 most recent top-level messages).
- Structured errors (`{"error": {"code", "message", "hint"}}`) that never contain secrets, with hints for an
  unreachable server and for a PAT revoked by an account E2E key reset.

#### CLI

- `rc-mcp serve` (default), `doctor [--json]`, `sync [room] [--full] [--max-messages n] [--json]`,
  `search <query...>` with room, author and date filters, `export <room>` to Markdown (room or thread) and
  `purge [-y]`.
- `doctor` checks configuration, server reachability, the token, E2EE key state and which encrypted rooms are
  unreadable, and why. It exits with 1 only when a check fails; warnings don't change the exit code.
- `sync` backfills each room's whole history unless `--max-messages` is given, and exits with 1 when a room failed.
  Numeric options must be positive integers.
- `export --thread` must name a thread of the given room; `export -o` writes the file with mode 0600.
- `purge` deletes the index (`index.sqlite` with its `-wal` / `-shm` files) and the saved-files directory, and also
  works while `RC_MCP_EPHEMERAL` is set.
- Configuration from environment variables (`RC_URL`, `RC_USER_ID`, `RC_AUTH_TOKEN`, `RC_E2EE_PASSWORD`,
  `RC_MCP_DATA_DIR`, `RC_MCP_LOG_LEVEL`, `RC_MCP_EPHEMERAL`) or a JSON config file (`RC_MCP_CONFIG`) that must not be
  accessible by group or others.
- JSON-lines logging to stderr only, with secrets scrubbed by field name and by value.

#### Tests

- Unit layer (offline, 139 tests in 9 files): decryption of committed fixtures produced by the real Rocket.Chat 8.9.0
  web client and of Rocket.Chat's own legacy test vectors, failure modes on damaged fixtures, index and sync against
  a fake server serving the captures, MCP tools over an in-memory transport, and a stdout guard that spawns
  `rc-mcp serve`.
- Integration layer (21 tests in 3 files) against a disposable Docker/Podman compose stack (Rocket.Chat 8.9.0,
  MongoDB 8.0), as alice, bob, carol and the admin `rcadmin`, after a recorded ground-truth run: REST pagination,
  sync, downloads, a real `rc-mcp serve` over stdio, and the real REST rate limiter.
- Ground-truth layer: Playwright drives the real web client through E2EE setup, encrypted group and DM messages,
  threads, edits, quotes, uploads and a room-key reset, and the fresh capture is decrypted and compared with what
  was typed and what the client rendered.
- No test encrypts with our own code to prove compatibility.
- mise tasks for setup, development, checks (`check` runs lint, typecheck and the unit tests), the compose stack
  (with rootless Podman support) and fixture generation.

#### Documentation

- README; `docs/architecture.md`; ADRs 0001 (architecture and key decisions), 0002 (`node:sqlite`), 0003
  (ground-truth testing) and 0004 (read-only REST surface and suggested keys); E2EE protocol notes
  (`docs/e2ee-protocol.md`); CONTRIBUTING, SECURITY, CODE_OF_CONDUCT and CLAUDE.md for agentic contributors;
  `.env.example` and `.mcp.json.example` templates; GitHub issue and pull request templates.

### Security

- Ephemeral mode (`RC_MCP_EPHEMERAL=1`) writes nothing to disk: neither the index nor decrypted attachments, which
  `get_file` returns inline instead.
- `RC_MCP_DATA_DIR` / `dataDir` must be an absolute path (a leading `~` is expanded), so the plaintext index cannot
  land in whatever directory the MCP client started the server in.
- `rc-mcp purge` removes `<dataDir>/files` only when it contains rc-mcp's marker file (`.rc-mcp-files`), so an
  unrelated `files` directory is never deleted.
- `get_file` accepts only `file_id`s matching `[A-Za-z0-9_-]{1,64}`, sanitises the names of saved files, and never
  downloads a file it cannot tie to a message or to a room's upload list.
- `rc-mcp export -o` sets mode 0600 on the output file, also when the file already existed.
- Deleted messages: a message the server reports as hidden (`_hidden`) is returned as `message-deleted`. Deletions
  that Rocket.Chat hides without reporting them (`Message_KeepHistory` on, `Message_ShowDeletedStatus` off) stay in
  the local index until `rc-mcp sync <room> --full`; this limitation is documented in the README and SECURITY.md.

[Unreleased]: https://github.com/alien2003/rocketchat-e2ee-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alien2003/rocketchat-e2ee-mcp/releases/tag/v0.1.0
