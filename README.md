# rocketchat-e2ee-mcp

A read-only [MCP](https://modelcontextprotocol.io) server and CLI (`rc-mcp`) that lets Claude Code browse and
search a Rocket.Chat workspace, **including end-to-end encrypted (E2EE) rooms**. It decrypts on your machine with
your own keys (personal access token + E2EE password), the same way the official web client does, keeps a local
full-text index, and exposes rooms, threads, messages and files as MCP tools. It cannot send, edit, react, mark as
read or accept keys.

[![CI](https://github.com/alien2003/rocketchat-e2ee-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alien2003/rocketchat-e2ee-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)

**Contents:** [Why](#why) · [How it works](#how-it-works) · [Security model](#security-model) ·
[Limitations](#limitations) · [Quickstart](#quickstart) · [Tools](#tools) · [CLI](#cli) ·
[Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Development](#development) ·
[License](#license)

## Why

Teams keep how-tos, decisions and runbooks in chat threads instead of a wiki. Finding them later means scrolling
and guessing search terms. Many of the useful ones live in E2EE private groups and DMs, where the server only
stores ciphertext. Server-side tools therefore can't read them. That includes server-side search and Rocket.Chat's
own MCP endpoint, which ships with 8.9 as part of the enterprise AI add-on and runs on the server.

`rc-mcp` runs as you, on your machine. It reads the rooms you can already read, decrypts them locally, and lets
Claude search them, follow threads and quote them back to you with permalinks.

## How it works

### Key chain

The derivation is a port of the 8.9.0 web client (`apps/meteor/client/lib/e2ee`) to WebCrypto. Every step is
checked against data produced by the real client.

```text
RC_E2EE_PASSWORD   your E2EE password / generated passphrase, taken as Latin-1 bytes like the client does
   │
   │  PBKDF2-HMAC-SHA256 → 256-bit key
   │    stored key v2: salt "v2:<userId>:<uuid>", 100 000 iterations → AES-GCM
   │    stored key v1: salt "<userId>",             1 000 iterations → AES-CBC (legacy)
   ▼
AES master key ──decrypts──▶ your stored private key (e2e.fetchMyKeys → private_key)
   ▼
RSA-OAEP-2048 private key (JWK, kept in memory only)
   │
   │  RSA-OAEP-SHA256 unwraps, per room (from subscriptions.get):
   │    E2EKey            current room key
   │    oldRoomKeys[]     previous keys after room key resets (the server keeps at most 10)
   │    E2ESuggestedKey   key offered by another member: used in memory, never accepted
   │                      (with its suggestedOldRoomKeys[] when you have no oldRoomKeys)
   ▼
room keys          A256GCM (legacy A128CBC), picked per message by key id:
   │               the oldRoomKeys entry whose e2eKeyId matches, else the current key
   │
   │  rc.v2.aes-sha2  AES-GCM-256          rc.v1.aes-sha2 / bare `msg`  AES-CBC-128 (legacy)
   ▼
message content    EJSON { msg, attachments, file, files }
   │
   │  file messages carry a per-file AES-CTR-256 key, a 16-byte counter block
   │  and the SHA-256 of the plaintext inside the encrypted content
   ▼
attachment bytes   downloaded ciphertext → AES-CTR → SHA-256 verified
```

### Data flow

```text
Rocket.Chat server (stores only ciphertext for E2EE rooms)
   │  HTTPS GET to an allowlist of endpoints, PAT in X-User-Id / X-Auth-Token headers
   ▼
rc-api    zod-validated responses, honours 429 / X-RateLimit-*, serialised per route
   ▼
e2ee      decrypts with your keys in memory; failures become `undecryptable` + reason
   ▼
index     node:sqlite + FTS5: plaintext, search index, sync cursors
   │      <dataDir>/index.sqlite (0600), or RAM with RC_MCP_EPHEMERAL=1
   ▼
MCP tools over stdio  ·  rc-mcp CLI
   ▼
Claude Code ──▶ LLM provider (receives whatever the tools return)
```

- **Rooms and keys:** one `subscriptions.get` plus one `rooms.get`.
- **Backfill:** `rooms.history`, 100 messages per page, newest first.
- **Incremental:** `chat.syncMessages` returns new, edited and deleted messages, one call per changed room. Rooms
  whose last update did not move are skipped. Rocket.Chat purges its deletion log after 30 days, so a room whose
  cursor is older than 29 days gets a full resync.
- **Freshness:** there is no websocket and no background polling. Data syncs when a tool needs it:
  - `get_messages` and `get_thread` refresh a room whose last sync is older than 60 s. `get_messages` returns
    only history that the index holds without gaps; paging back with `before` backfills older messages as needed.
  - `search` with `rooms` refreshes those rooms the same way. Without `rooms`, it syncs changed rooms at most
    every 5 minutes. `refresh: false` skips all network work (no sync, and no server search unless
    `include_server_search: true` is passed explicitly).
- **Missing keys:** messages that can't be decrypted yet are kept as ciphertext. Once the room's keys change (for
  example after a member shares the key), the next sync of that room decrypts them again locally, without
  extra REST calls.
- **Cold index:** when the index lacks a message or a thread's replies, `get_message` and `get_thread` fetch them
  live (`chat.getMessage`, `chat.getThreadMessages`). `get_file` always downloads the file and re-derives its
  key, from the re-fetched message or, when no message is known, from the room's upload record, because per-file
  keys are never stored.
- **Server search:** for unencrypted rooms, `search` also queries Rocket.Chat's `chat.search` when you pass
  `rooms` (up to 10 of the named rooms), or, with `include_server_search: true`, for the 10 most recently active
  unencrypted rooms. It waits at most 2 s for a rate limit; otherwise it skips the server search and says so in
  `notes`.
- **Offline:** when Rocket.Chat can't be reached (network error, timeout, HTTP 5xx, 401 or 429) and the index
  already has data, `list_rooms`, `get_messages`, `get_thread`, `get_message` (for indexed messages) and `search`
  answer from the index and add a `notes` entry saying the results may be stale. After such a failure they skip
  their network work for 30 s.

Design: [docs/architecture.md](docs/architecture.md), the decision records starting at
[ADR 0001](docs/adr/0001-architecture.md), and the crypto formats in [docs/e2ee-protocol.md](docs/e2ee-protocol.md).

## Security model

> [!IMPORTANT]
> Rocket.Chat E2EE guarantees that only room members' devices see plaintext. `rc-mcp` adds two places where
> plaintext ends up: **a file on your disk** and **your LLM provider**. Read this section before you point it at
> a real workspace.

**Decrypted text goes to your LLM provider.** Every message, thread or file a tool returns becomes part of the
conversation. It is sent to the model provider your MCP client uses, and it sits in anything that client stores
itself. That widens the E2EE trust boundary for **every participant** of every room you read, and those people did
not opt in. Get the consent of the people in those rooms, follow your organisation's policy on confidential data and
AI tools, and leave out rooms where that isn't settled. Don't use it on rooms whose members expect their messages to
stay on their devices.

**The local index stores plaintext.** It is needed for fast full-text search across rooms.

- It lives in `<dataDir>/index.sqlite`, with SQLite's `-wal` and `-shm` files next to it. The directory is mode
  0700 and is tightened if it is wider. The files are 0600, and the process runs with `umask 077`, so new files
  are private to you too.
- The data directory must be an absolute path (a leading `~` is expanded). A relative path is rejected, so the
  index can't end up in whatever directory your MCP client started the server in.
- Mitigations:
  - `RC_MCP_EPHEMERAL=1` keeps the index in memory, and `get_file` then writes nothing to disk.
  - `rc-mcp purge` deletes the index and saved files. It also works while `RC_MCP_EPHEMERAL` is set, to remove
    what earlier non-ephemeral runs left behind.
  - `rc-mcp doctor` warns if the index file has become group- or world-readable.
  - Full-disk encryption is recommended.
- `get_file` returns text within `max_inline_bytes` and images up to 4 MiB inline, without writing them. Other
  files:
  - normal mode: saved (0600) to `<dataDir>/files/` (0700), and the path is returned; `rc-mcp purge` removes
    them;
  - ephemeral mode: returned inline as an MCP embedded resource (up to 10 MiB), never written to disk.
- `rc-mcp export` writes plaintext Markdown to stdout, or with `-o` to a file that it sets to mode 0600, also
  when the file already existed.

**Never stored:**

- your E2EE password;
- your private key, in either decrypted or stored form;
- room keys;
- per-file keys: `get_file` fetches and decrypts the message again each time;
- your access token.

Attachment metadata in the index has its key material stripped. For messages that couldn't be decrypted yet, the
index keeps the original ciphertext so they can be retried later.

**You only get what you can already read.**

- `rc-mcp` uses your PAT and your keys and sees only rooms your account belongs to.
- An encrypted room is readable only if your account holds its key, or was offered one (a suggested key).
  Suggested keys get the same trust as in the official client, which accepts any suggested key that decrypts with
  your private key. `rc-mcp` uses them in memory and never accepts them on the server.
- It can't read content from before you had the key, or content encrypted with a key older than the 10 the server
  keeps.

**Read-only by construction.**

- The REST client has no generic request method. It only issues `GET`s to a fixed allowlist of endpoints, plus
  authenticated downloads under `/file-upload/`.
- It avoids endpoints that change state even on `GET`:
  - `GET /api/v1/logout` revokes the calling token, PATs included;
  - `chat.ignoreUser` changes your subscription;
  - `im.history` / `im.messages` called with a username can create a DM;
  - `e2e.acceptSuggestedGroupKey` would accept a key on the server.
- Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`.

**Secrets handling.**

- **Where secrets come from:** the environment, or a config file that `rc-mcp` refuses to read unless only you can
  access it (mode 0600).
- **Logs:** JSON lines on stderr, with secrets scrubbed by key name and by value. Tool errors are scrubbed too.
- **Doctor:** shows only the token's length.
- **Where the token is sent:** to `RC_URL` only. File downloads follow up to 4 redirects to any host, and
  redirects to another origin are followed without credentials. Use an `https://` URL: `http://` is accepted for
  local testing but sends the token in cleartext.
- **Treat the PAT like a password.** Rocket.Chat tokens have no scopes, so a PAT can do anything your account can.
  Revoke it in *My Account → Personal Access Tokens* when you stop using `rc-mcp`.

**Chat content is untrusted input.** Anyone in a room you read can write text aimed at the model. `rc-mcp` itself
can't act on it, but other tools in the same Claude Code session might, such as the shell or file edits. Review
actions Claude proposes after reading chat content.

## Limitations

**Rocket.Chat versions**

| Rocket.Chat | Status | Evidence |
| --- | --- | --- |
| **8.9.0** | Tested | The committed fixtures in `test/fixtures/8.9.0` were captured by driving the real web client with Playwright. They cover E2EE setup, an encrypted group and DM, thread, edit, quote, text and image uploads, and a room key reset. Unit tests check that the decrypted output equals both the typed text and what the real client rendered. Integration tests run against an 8.9.0 server. |
| Legacy formats (older clients) | Formats verified | Private key v1, legacy bare-`msg` content (decoded with the `rc.v1.aes-sha2` codec) and A128CBC room keys with 12-character key ids are checked against Rocket.Chat's own test vectors; `rc.v1.aes-sha2` as a `content` object is ported from source (`test/fixtures/upstream/legacy-v1.json`). No older server was run. |
| Any other version | Untested | Likely to work if the formats and REST shapes are unchanged. Regenerate the fixtures to confirm (see [Development](#development)). |
| Matrix federation rooms (`m.megolm.v1.aes-sha2`) | Not supported | Messages come back as `undecryptable` with reason `unsupported-algorithm`. |

**Other limitations**

- **Old keys:** after room key resets the server keeps at most **10 old room keys** per member. Messages encrypted
  with an older key, or sent before you received the room key, report `room-key-missing`. The official client
  can't read them either.
- **Suggested keys** are used read-only in memory and never accepted on the server. Open the room once in the
  official client to accept the key; `rc-mcp doctor` lists the rooms where that is needed. When a suggested key
  comes with old keys (`suggestedOldRoomKeys`) and your subscription has no `oldRoomKeys`, those old keys are used
  too, as the server would adopt them on acceptance, so history from before a room key reset stays readable.
- **No key shared yet** (`no-room-key`): until another member's official client is online and shares the key,
  that room is unreadable.
- **Rate limits for non-admin tokens:** Rocket.Chat limits REST calls per client IP and route. The default is 10
  calls per 60 s; `rooms.history`, `chat.getThreadMessages` and `chat.getThreadsList` allow 20 per 10 s.
  - `rc-mcp` waits for the reset and retries. The CLI retries up to 5 times, gives up on a single wait longer
    than 120 s and times out a request after 30 s. The MCP server (`serve`) is less patient so tool calls don't
    stall: 2 retries, at most 45 s of waiting, 20 s timeout.
  - The first sync of a large workspace can take minutes. Running `rc-mcp sync` once from a terminal backfills
    every room completely, with the CLI's longer waits.
  - Other clients behind the same IP share the budget.
  - Roles with `api-bypass-rate-limit` (admin, bot, app by default) are not limited.
- **No live updates:** there is no push or websocket; data is synced when a tool runs (see
  [Data flow](#data-flow)).
- **Subscribed rooms only:** public channels you haven't joined are not listed.
- **Search coverage:**
  - Encrypted rooms are searchable only through the local index, and only for history that has been synced.
  - Undecryptable messages are not searchable.
  - Server-side search covers unencrypted rooms only and, by default, runs only when you pass `rooms` (see
    [Data flow](#data-flow)). Unencrypted rooms are in the local index anyway.
- **Files:**
  - Downloads are capped at 50 MiB.
  - Text is returned inline up to 256 KiB by default (`max_inline_bytes`, at most 1 MiB).
  - Images up to 4 MiB are returned as MCP image content and not saved.
  - Anything else is saved to disk. In ephemeral mode it is returned inline as an embedded resource instead, up
    to 10 MiB; larger files fail with `file-too-large`.
- **Deletions hidden by "Keep History":** with `Message_KeepHistory` on and `Message_ShowDeletedStatus` off,
  Rocket.Chat hides deleted messages without reporting the deletion through any sync endpoint. Such messages stay
  in the local index, and in search results, until you re-index the room with `rc-mcp sync <room> --full` (or
  the `sync` tool with `full: true`).
- **Account E2E key reset:** `users.resetE2EKey` invalidates all your login tokens, PATs included, and removes
  every room key from your subscriptions (`E2EKey`, `E2ESuggestedKey` and `oldRoomKeys`). Create a new PAT. After
  the official client has created your new keys, rooms show `missing` until a member re-shares the room key.
  History from before the reset is readable only if a member also re-shares the old keys
  (`suggestedOldRoomKeys`, which `rc-mcp` uses); otherwise it reports `room-key-missing`.
- **One account per server process.**
- **Platform:** Node.js 24 or newer is required (`node:sqlite`). Tested on Linux, including WSL2. On Windows the
  config-file and data-directory permission checks are skipped; `doctor`'s index-file mode check may still warn
  there.

## Quickstart

**Prerequisites**

- Node.js 24+ and [Claude Code](https://docs.claude.com/en/docs/claude-code).
- A Rocket.Chat account that has set up E2EE (logged in to the official client once with E2EE enabled), and its
  E2EE password.
- **A personal access token, created by hand in the Rocket.Chat UI:** avatar → *My Account* → *Personal Access
  Tokens*. Enter a name, set the two-factor option to **Ignore Two Factor Authentication**, then *Add*. Copy the
  **Token** and **Your user Id** shown in the dialog; the token is shown only once.
  - Without "Ignore Two Factor Authentication", calls can hit a 2FA challenge (`totp-required`).
  - Creating tokens needs the `create-personal-access-tokens` permission, which the `user` and `admin` roles have
    by default.

**Commands** (bash or zsh)

```sh
# 1. Credentials for this shell (see the note below to keep them out of shell history)
 export RC_URL=https://chat.example.com RC_USER_ID=<your-user-id> RC_AUTH_TOKEN=<your-pat> RC_E2EE_PASSWORD='<your E2EE password>'

# 2. Check connectivity, token, E2EE keys and which encrypted rooms are readable
npx -y rocketchat-e2ee-mcp doctor

# 3. Register the server with Claude Code (local scope)
claude mcp add rocketchat -e RC_URL="$RC_URL" -e RC_USER_ID="$RC_USER_ID" -e RC_AUTH_TOKEN="$RC_AUTH_TOKEN" -e RC_E2EE_PASSWORD="$RC_E2EE_PASSWORD" -- npx -y rocketchat-e2ee-mcp

# 4. Start Claude Code
claude
```

The leading space in step 1 keeps the line out of history in bash (`HISTCONTROL=ignorespace`) and zsh
(`setopt HIST_IGNORE_SPACE`). Alternatively read the secrets without echo: `read -rs RC_AUTH_TOKEN`,
`read -rs RC_E2EE_PASSWORD`, then `export RC_AUTH_TOKEN RC_E2EE_PASSWORD`.

Then ask, for example:

- *"Search Rocket.Chat for the deploy runbook and summarise the steps, with links."*
- *"Read this thread and list the decisions: https://chat.example.com/group/handbook/thread/&lt;id&gt;"*
- *"What did @bob write about electionTimeoutMillis?"*

A healthy `doctor` run looks like this:

```text
rc-mcp doctor

✓ config           server https://chat.example.com, user id <your-user-id>, token set (43 chars)
✓ e2ee password    RC_E2EE_PASSWORD is set (not shown)
· index            stored in /home/you/.local/share/rc-mcp (plaintext of decrypted messages)
✓ node             Node.js 24.22.0
✓ server           reachable, Rocket.Chat 8.9
✓ authentication   token valid for @alice (roles: user)
· rate limits      non-admin token: Rocket.Chat limits most REST routes to ~10 calls/min per IP by default; rc-mcp waits and retries
✓ e2ee keys        private key unlocked (stored format v2)
✓ rooms            3 subscribed rooms, 2 end-to-end encrypted
✓ encrypted rooms  all encrypted rooms are readable
✓ index file       /home/you/.local/share/rc-mcp/index.sqlite (mode 600): 0 messages in 3 rooms

Encrypted rooms:
  ✓ handbook [private-group] key: ok
  ✓ Bob Brown [direct-message] key: ok

Result: OK
```

`doctor` exits with 1 when a check fails (server unreachable, bad token, wrong E2EE password, …) and with 0
otherwise. Warnings, such as an unset E2EE password, unreadable or suggested-key rooms, or an index file with
widened permissions, are printed but don't change the exit code.

### Before the npm release

Until `rocketchat-e2ee-mcp` is published to npm, use one of these in place of `npx -y rocketchat-e2ee-mcp`, in
steps 3 and 4 and everywhere below:

- **GitHub release tarball:**

  ```sh
  npx -y https://github.com/alien2003/rocketchat-e2ee-mcp/releases/download/v0.1.0/rocketchat-e2ee-mcp-0.1.0.tgz
  ```

- **Source build** (needs [mise](https://mise.jdx.dev)):

  ```sh
  git clone https://github.com/alien2003/rocketchat-e2ee-mcp && cd rocketchat-e2ee-mcp
  mise install && mise run setup && mise run build
  ```

  Then run `node /path/to/rocketchat-e2ee-mcp/dist/cli/main.js`. With Claude Code, that is
  `claude mcp add rocketchat -e … -- node /path/to/rocketchat-e2ee-mcp/dist/cli/main.js`.

Once the package is on npm, you can pin a version with `npx -y rocketchat-e2ee-mcp@0.1.0`.

### Other ways to register with Claude Code

The syntax is `claude mcp add [options] <name> <commandOrUrl> [args...]`. Repeat `-e/--env KEY=value` for each
variable, and pick a scope with `-s/--scope local|user|project`.

**With literal values**, the same as step 4:

```sh
claude mcp add rocketchat -e RC_URL=https://chat.example.com -e RC_USER_ID=<id> -e RC_AUTH_TOKEN=<pat> -e RC_E2EE_PASSWORD='<e2ee password>' -- npx -y rocketchat-e2ee-mcp
```

Values passed with `-e` are stored in Claude Code's own configuration, outside your repository.

**Keep secrets in a 0600 config file instead**, so Claude Code's configuration holds only a path. See
[Configuration](#configuration) for the file format.

```sh
claude mcp add rocketchat -e RC_MCP_CONFIG="$HOME/.config/rc-mcp/config.json" -- npx -y rocketchat-e2ee-mcp
```

**Project scope, shared with your team.** `-s project` writes `.mcp.json` in your project, which you commit.
Never put secrets in it: Claude Code expands `${VAR}` in `.mcp.json` env values from the environment `claude`
starts in.

1. Either copy [`.mcp.json.example`](.mcp.json.example) to `.mcp.json`, or let Claude Code write it. Single quotes
   keep the shell from expanding `${…}`:

   ```sh
   claude mcp add rocketchat -s project -e RC_URL='${RC_URL}' -e RC_USER_ID='${RC_USER_ID}' -e RC_AUTH_TOKEN='${RC_AUTH_TOKEN}' -e RC_E2EE_PASSWORD='${RC_E2EE_PASSWORD}' -- npx -y rocketchat-e2ee-mcp
   ```

2. Each teammate exports their **own** `RC_*` values before starting `claude`, for example from a private `.env`
   loaded with `set -a; . ./.env; set +a` (see [`.env.example`](.env.example)). Each person reads only what their
   own account can read.

## Tools

All tools are read-only (`readOnlyHint: true`, `destructiveHint: false`) and return JSON text. You can refer to a
room by id, name (`handbook`), display name, or `@username` for a DM. Message ids can be any id-like token
(imported messages, for example from Slack, have longer ids), and pasted URLs with `?msg=<id>` or `/thread/<id>`
work wherever a message or thread id is expected (`get_message`, `get_thread`, `get_file.message_id`,
`search.thread_id`). `file_id` must be a bare file id.

**Dates** are ISO 8601: `2026-03-01` (midnight UTC), `2026-03-01T12:00:00Z` or `2026-03-01T14:00:00+02:00`. A
date-time without `Z` or an offset is read in the local time zone of the machine running `rc-mcp`. Values are
validated and converted to UTC; an invalid value returns `invalid-argument`. `after` is inclusive and `before` is
exclusive, so `before: "2026-03-01"` stops at 2026-03-01 00:00 UTC and leaves out 1 March. The CLI's `--after` /
`--since` and `--before` / `--until` work the same way.

| Tool | Parameters (`?` = optional) | Returns |
| --- | --- | --- |
| `list_rooms` | `filter?` (substring of name/topic), `type?` (`all` \| `channel` \| `private-group` \| `direct-message`), `encrypted_only?`, `limit?` (1–500, default 200) | `e2ee` (`"unlocked"`, `{status, reason, hint}`, or `"unknown (offline)"` when the keys couldn't be fetched), `count`, `rooms[]` with `id`, `name`, `type`, `encrypted`, `key_status` (`ok` \| `suggested` \| `missing` \| `undecryptable` \| `not-encrypted` \| `e2ee-unavailable`), `last_activity`, `indexed_messages`, `undecryptable_messages?`, `history_complete`, `last_synced`; `notes?` |
| `get_messages` | `room`, `before?` (exclusive), `after?` (inclusive), `limit?` (1–200, default 30), `include_thread_replies?` (default false) | One page, oldest first: `room`, `order`, `count`, `has_older`, `older_than_cursor` (pass it as `before` to page back), `messages[]`, `notes?`. Only history the index holds without gaps is returned; older history is backfilled as you page back. |
| `get_thread` | `thread_id?` (root or any reply id) or `url?` (pasted thread/message URL), `limit?` (1–1000, default 500) | `room`, `root`, `total_replies`, `returned`, `truncated?` (more replies than `limit`), `replies[]` in chronological order, `notes?`. Fetches `chat.getThreadMessages` when the index lacks replies, also for threads in rooms that aren't indexed. |
| `get_message` | `id?` or `url?` (permalink with `?msg=<id>`), `resolve_quotes?` (default true) | `message`, `quoted_messages?` (quotes resolved, each with its own room), `note?` when the message starts a thread, `notes?` |
| `search` | `query`, `rooms?`, `from?` (usernames), `after?` (inclusive), `before?` (exclusive), `thread_id?`, `limit?` (1–100, default 20), `include_server_search?` (default: true only when `rooms` is given), `refresh?` (default true) | `query`, `count`, `more_available?` (more hits than `limit`), `results[]` (message + `snippet` with «highlights» + `source`: `index` \| `server` \| `index+server`), `index {rooms, messages}`, `notes?`. Full-text search: every word must match, accents are ignored, `deploy*` matches as a prefix. Server hits get the same author, date and thread filters. |
| `sync` | `room?` (default: all rooms that changed), `full?` (re-index from scratch), `max_messages?` (1–100000, default 2000: older messages backfilled per room in this call) | `rooms_checked`, `totals {new, updated, deleted, undecryptable}`, `rooms[]` (changed rooms with `room`, `room_id`, `new`, `updated`, `deleted`, `undecryptable?`, `history_complete`, `full_resync?`, `error?`), `failed_rooms`, `unchanged_rooms`, `note?` (call again while history is incomplete) |
| `get_file` | `file_id?` and/or `message_id?`, `max_inline_bytes?` (0–1048576, default 262144) | Metadata first: `file_id`, `name`, `type`, `size`, `encrypted`, `integrity?` (encrypted files only: `verified` \| `unverified`), `message_id?`, `inline`, `saved_to?`. Then the text for text-like files within the limit, or an MCP image for images up to 4 MiB. Other files are saved (0600) and only the path is returned; in ephemeral mode they come back as an embedded resource (`rocketchat://file/<file_id>`, base64 `blob`, up to 10 MiB) and nothing is written. |
| `get_user` | `username?` (with or without `@`) or `user_id?` | `id`, `username`, `name`, `status`, `status_text?`, `bio?`, `roles?`, `utc_offset?`, `active?`, `type?` |

`get_file` only downloads a file it can find in a message or in a room's upload list (`groups.files`,
`channels.files`, `im.files`); anything else is `file-not-found`. `file_id` must match `[A-Za-z0-9_-]{1,64}`. If
you pass both ids, the message must carry that file.

**Resources:** `rocketchat://room/{rid}` returns a Markdown transcript of the room's 50 most recent top-level
messages, decrypted. Thread replies are left out; thread roots show their reply count and thread id. The resource
list contains every subscribed room.

**Message objects** have these fields:

- `id`, `room_id`, `room`, `ts`, `author`, `text`, `permalink`;
- `thread_id`, `reply_count`, `edited_at`, `system_type`;
- `quotes[]`, `attachments[]` (`file_id`, `name`, `type`, `size`, …), `encrypted`;
- `undecryptable {reason, hint, key_id?}` in place of text when a message can't be decrypted. Tools never guess
  that content.

**Errors** come back with `isError: true` and one shape:

```json
{ "error": { "code": "room-not-found", "message": "No room matching \"ops\" among the rooms this account is subscribed to.", "hint": "Call list_rooms to see room ids and names." } }
```

The codes are:

- `room-not-found`, `invalid-argument`, `message-deleted`;
- from `get_file`: `file-not-found`, `file-key-missing`, `file-too-large` (ephemeral mode), and `undecryptable`
  when the file's message or metadata can't be decrypted;
- `rocketchat-<code>`, for example `rocketchat-unauthorized`, `rocketchat-rate-limited`, `rocketchat-network` or
  `rocketchat-timeout`;
- `e2ee-<reason>`;
- `internal-error`.

Arguments that don't match a tool's schema (for example `limit: 1000`) are rejected by the MCP SDK before the tool
runs. That error is plain text, such as `MCP error -32602: Input validation error: …`, still with `isError: true`.

### Examples

These are abridged results from the 8.9.0 fixtures. The server URL and the room name (`handbook-mva1woss`) are
simplified.

`search` with `{ "query": "deploy runbook", "rooms": ["handbook"] }`:

```json
{
  "query": "deploy runbook",
  "count": 1,
  "results": [
    {
      "id": "Zd97mTM23F4efdEg8",
      "room_id": "6ad1459708d9d91a69c55ade",
      "room": "handbook",
      "ts": "2026-10-15T21:28:59.374Z",
      "author": "Alice Anders (@alice)",
      "text": "Deploy runbook: run `make deploy` from the release branch, then check /healthz on every node.",
      "reply_count": 2,
      "encrypted": true,
      "permalink": "https://chat.example.com/group/handbook?msg=Zd97mTM23F4efdEg8",
      "snippet": "«Deploy» «runbook»: run `make «deploy»` from the release branch, then check /healthz on every node.",
      "source": "index"
    }
  ],
  "index": { "rooms": 3, "messages": 19 }
}
```

`get_thread` with `{ "url": "https://chat.example.com/group/handbook/thread/Zd97mTM23F4efdEg8" }`. The first reply
was encrypted before a room key reset and the second one after it; both decrypt, the first via `oldRoomKeys`:

```json
{
  "room": { "id": "6ad1459708d9d91a69c55ade", "name": "handbook", "type": "private-group", "encrypted": true, "key_status": "ok" },
  "root": { "id": "Zd97mTM23F4efdEg8", "author": "Alice Anders (@alice)", "text": "Deploy runbook: run `make deploy` from the release branch, then check /healthz on every node.", "reply_count": 2 },
  "total_replies": 2,
  "returned": 2,
  "replies": [
    { "author": "Bob Brown (@bob)", "text": "Thread reply: remember to bump the version in package.json before `make deploy`.", "thread_id": "Zd97mTM23F4efdEg8" },
    { "author": "Bob Brown (@bob)", "text": "Post-reset thread reply (bob): version bump is now automated by CI.", "thread_id": "Zd97mTM23F4efdEg8" }
  ]
}
```

`get_file` with `{ "message_id": "<id of a file message>" }` returns two content items. The first is the metadata:

```json
{ "file_id": "<file id>", "name": "release-checklist.md", "type": "text/markdown", "size": 96, "encrypted": true, "integrity": "verified", "message_id": "<id>", "inline": true }
```

The second is the decrypted file text.

A message the account can't decrypt:

```json
{ "id": "<id>", "text": "", "encrypted": true, "undecryptable": { "reason": "room-key-missing", "hint": "Encrypted with a room key this account does not hold (e.g. sent before you got access, or before a room key reset older than the 10 kept keys).", "key_id": "<key id>" } }
```

## CLI

Every CLI command uses the same configuration as the server. The command is `rc-mcp` after
`npm install -g rocketchat-e2ee-mcp`. Otherwise run `npx -y rocketchat-e2ee-mcp <command>`, or
`node dist/cli/main.js <command>` from a source build.

```text
rc-mcp [serve]                       MCP server over stdio (the default command)
rc-mcp doctor [--json]               connectivity, token, E2EE key state, unreadable rooms and why
rc-mcp sync [room] [--full] [--max-messages <n>] [--json]
rc-mcp search <query...> [-r, --room <room...>] [-f, --from <user...>] [--after <date>] [--before <date>]
                         [-n, --limit <n>] [--no-refresh] [--json]
rc-mcp export <room> [-t, --thread <id>] [--since <date>] [--until <date>] [--format md] [-o, --output <file>]
rc-mcp purge [-y, --yes]
rc-mcp --version | --help
```

| Command | Notes |
| --- | --- |
| `serve` | Speaks MCP over stdio and logs only to stderr. Answers `initialize` right away, then unlocks keys and loads rooms in the background. |
| `doctor` | Never prints secrets. Exit code 1 means a check failed; warnings alone exit with 0. |
| `sync` | Without `room`, syncs all rooms that changed. Without `--max-messages` it backfills each room's whole history (the `sync` tool stops at 2000 messages per room per call). `--max-messages` limits backfill per room for this run; repeat until no room says `(history incomplete)`. `--full` discards the local copy and re-indexes. Exits with 1 if any room failed. |
| `search` | Put the query words before the options, because `-r` and `-f` take several values. By default it syncs stale rooms first; `--no-refresh` skips that and searches what is already indexed. |
| `export` | Markdown with dates and authors, for a room or for one thread of that room (`-t <root id>`). For encrypted rooms the header includes a warning line. `-o` writes the file with mode 0600, also when it already existed. |
| `purge` | Deletes `index.sqlite` and its `-wal` / `-shm` files in the data dir, and `files/` only if it carries rc-mcp's marker file `.rc-mcp-files`. Also works while `RC_MCP_EPHEMERAL` is set. Asks for confirmation; without a terminal it needs `--yes`. Doesn't need credentials and never contacts Rocket.Chat. |

Numeric options (`--max-messages`, `-n`) must be positive integers.

```sh
rc-mcp sync                                   # bring the index up to date
rc-mcp search postgres failover -r handbook -n 5
rc-mcp export handbook -t Zd97mTM23F4efdEg8 -o runbook.md
```

```text
2026-10-15 20:23  handbook  Alice Anders (@alice)
  «Deploy» «runbook»: run `make «deploy»` from the release branch, then check /healthz on every node.
  https://chat.example.com/group/handbook?msg=Zd97mTM23F4efdEg8
1 result(s)
```

The output above is from `rc-mcp search deploy runbook`.

Exit codes: `0` success, `1` error (also a failed `doctor` check or a room that failed in `sync`), `2`
configuration error.

## Configuration

Settings are read from environment variables and an optional JSON config file. **Environment variables take
precedence over the file.** `rc-mcp` does not read `.env` files by itself; see [`.env.example`](.env.example).

| Variable | Config file key | Default | Meaning |
| --- | --- | --- | --- |
| `RC_URL` | `url` | (required) | Server base URL, e.g. `https://chat.example.com`. `http(s)` only; trailing `/` is removed. |
| `RC_USER_ID` | `userId` | (required) | Your user id. It is shown with the token when you create a PAT. |
| `RC_AUTH_TOKEN` | `authToken` | (required) | Personal access token, created with "Ignore Two Factor Authentication". |
| `RC_E2EE_PASSWORD` | `e2eePassword` | unset | E2EE password or passphrase. Without it, encrypted rooms are listed but not decrypted. |
| `RC_MCP_DATA_DIR` | `dataDir` | `$XDG_DATA_HOME/rc-mcp`, else `~/.local/share/rc-mcp` | Where the index and saved files live. Must be an absolute path; a leading `~` is expanded. A relative path is a configuration error. |
| `RC_MCP_EPHEMERAL` | `ephemeral` (boolean) | `false` | `1`, `true`, `yes` or `on`: keep the index in memory only, and have `get_file` return files inline instead of saving them. |
| `RC_MCP_LOG_LEVEL` | `logLevel` | `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs are JSON lines on stderr. |
| `RC_MCP_CONFIG` | (none) | `$XDG_CONFIG_HOME/rc-mcp/config.json`, else `~/.config/rc-mcp/config.json` | Path to the config file. The default path is used only if the file exists; a path set here must exist. |

**Config file.** The file must not be readable or writable by group or others; `rc-mcp` refuses it otherwise and
tells you to run `chmod 600`. Unknown keys are rejected. `rc-mcp` never writes this file.

```sh
mkdir -p ~/.config/rc-mcp && install -m 600 /dev/null ~/.config/rc-mcp/config.json && $EDITOR ~/.config/rc-mcp/config.json
```

```json
{
  "url": "https://chat.example.com",
  "userId": "<your-user-id>",
  "authToken": "<your-personal-access-token>",
  "e2eePassword": "<your-e2ee-password>",
  "ephemeral": false,
  "logLevel": "info"
}
```

**Where data lives:**

| Path | Contents |
| --- | --- |
| `<dataDir>/` (0700) | Created on first run. Its permissions are tightened to 0700 if they are wider. |
| `<dataDir>/index.sqlite` (0600), plus `-wal` and `-shm` | Rooms, sync cursors, **decrypted message text**, the full-text index, and attachment metadata with keys stripped. Also the ciphertext of messages that couldn't be decrypted yet. |
| `<dataDir>/files/` (0700) | Attachments saved by `get_file` (0600), plus the marker file `.rc-mcp-files` that lets `rc-mcp purge` recognise the directory. Not used in ephemeral mode. |

**Removing local data:**

- `rc-mcp purge` (or `purge --yes` in scripts) deletes the index and saved files, also while `RC_MCP_EPHEMERAL`
  is set.
- `RC_MCP_EPHEMERAL=1` avoids writing the index and attachments at all; each server start then syncs from
  scratch.

## Troubleshooting

Run `rc-mcp doctor` first. It checks each step and says what to fix.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required configuration: RC_URL, …` or `RC_URL is not a valid http(s) URL` (exit code 2) | Variables not set in the environment the process runs in. When run through Claude Code, that is the `-e` values or `.mcp.json` env. | Set them (see [Configuration](#configuration)). For `.mcp.json`, export the `${VAR}`s before starting `claude`. |
| `Config file … is accessible by group/others (mode 644). Run: chmod 600 …` | The config file is readable by others. | `chmod 600 <file>` |
| `RC_MCP_DATA_DIR / dataDir must be an absolute path` (exit code 2) | A relative data directory. Values in a JSON config file or in `.mcp.json` env are not expanded by a shell. | Use an absolute path, or one starting with `~/`. |
| `Rocket.Chat is unreachable: check RC_URL and the network` (`rocketchat-network`, `rocketchat-timeout`); `notes` say results come from the local index and may be stale | The server can't be reached or didn't answer in time. Read tools keep answering from the index (also after HTTP 5xx, 401 or 429 errors) and skip network work for 30 s after a failure. | Check `RC_URL` and the network, then run `rc-mcp doctor`. |
| `authentication failed: check RC_USER_ID / RC_AUTH_TOKEN` (HTTP 401, `rocketchat-unauthorized`) | Wrong user id or token, or the PAT was revoked. An account E2E key reset (`users.resetE2EKey`) also deletes all your tokens, PATs included. | Check both values. Create a new PAT if needed. |
| `… requires two-factor authentication; recreate the PAT with "Ignore Two Factor Authentication"` (`totp-required`) | The PAT was created with "Require Two Factor Authentication". | Create a new PAT with **Ignore Two Factor Authentication**. |
| doctor: `e2ee keys … private key not unlocked: wrong-password` | `RC_E2EE_PASSWORD` doesn't decrypt your stored private key. | Use your **current** E2EE password, the one that unlocks E2EE in the official client. |
| doctor: `… unsupported-password` | The value has characters above U+00FF. The client uses the password as Latin-1 bytes and rejects such characters too, so this can't be your E2EE password. Often a copy/paste artefact, such as typographic quotes or dashes. | Re-enter the password exactly. |
| doctor: `RC_E2EE_PASSWORD is not set`; rooms show `e2ee-unavailable` | No `RC_E2EE_PASSWORD`. | Set it. Until then, encrypted rooms are listed but not decrypted. |
| doctor: `this account has no E2EE keys` (`no-user-keys`) | E2EE was never set up for this account. | Log in once with the official client and set up E2EE. |
| Room `key_status: missing`; messages show `no-room-key`; the official client shows "Check back later" | No member has shared the room key with your account yet. Keys are shared by another member's official client while it is online. | Ask a member to open the room in the official client. Then run `sync`: messages are retried automatically. |
| Room `key_status: suggested`; doctor `suggested keys` warning | Another member offered the key, and your official client hasn't accepted it yet. | It's readable already. Open the room once in the official client to accept the key; `rc-mcp` never accepts keys. |
| Old messages show `room-key-missing` | Encrypted with a key you never had (sent before you got access), a key older than the 10 the server keeps, or a key that was removed by an account E2E key reset and not re-shared. The official client shows "cannot be decrypted due to incorrect encryption key". | Can't be fixed on your side; that history is not readable with your keys. |
| Room `key_status: undecryptable` / `room-key-undecryptable` | A room key shared with your account doesn't unwrap with your current private key. | Ask a member to re-share by opening the room in the official client. |
| Slow responses; `rocketchat-rate-limited` / `rate limited by Rocket.Chat; retry after Ns` | A non-admin token hit the per-IP, per-route REST limit. | Wait; `rc-mcp` retries by itself. Run `rc-mcp sync` ahead of time so tools read from the index. Ask an admin to raise the limits instead of switching to an admin token. |
| `search` misses things you know exist | The room isn't fully indexed (`notes` / `history_complete: false`), messages are undecryptable, or `refresh: false` / `--no-refresh` was used. | Run `rc-mcp sync` (or the `sync` tool) until no room reports incomplete history, then search again. |
| `search` or `get_messages` shows a message that was deleted | The server uses "Keep History" without "Show Deleted Status", so the deletion is never reported (see [Limitations](#limitations)). | `rc-mcp sync <room> --full` |
| `get_file`: `file-too-large` | Ephemeral mode returns files inline only, up to 10 MiB. | Run without `RC_MCP_EPHEMERAL` to have large files saved to the data directory. |
| doctor: `index file … (mode 644)` warning | The index file's permissions were widened. | `chmod 600 <dataDir>/index.sqlite` |
| Claude Code reports the server failed or disconnected; JSON parse errors | Something wrote to stdout, or the process is waiting for input. On stdio, stdout belongs to the MCP protocol. Typical culprits: a wrapper script that prints, or `npx` without `-y` stopping at its install confirmation. | Launch `npx -y rocketchat-e2ee-mcp` or `node …/dist/cli/main.js` directly; never wrap `serve` in anything that prints to stdout. Use `RC_MCP_LOG_LEVEL=debug` for more detail (stderr). |
| npm warns `EBADENGINE`; startup fails with `ERR_UNKNOWN_BUILTIN_MODULE` for `node:sqlite`; doctor: `rc-mcp needs Node.js 24 or newer` | Older Node.js. npm only warns about the `engines` mismatch and runs the CLI anyway. | Install Node.js 24+. |
| Dev stack (`mise run rc:up`) on rootless Podman can't reach a Docker API | Compose needs a Docker-compatible socket. | Always go through `mise run rc:*` / `scripts/compose.sh`. It detects rootless Podman and starts a project-local API socket at `.local/podman/podman.sock`, with no system services. |

**Reason reference.** The first four reasons describe the account's E2EE state: they appear in `list_rooms`
(`e2ee.reason`), in a room's `key_detail`, in `rc-mcp doctor` and as `e2ee-<reason>` error codes. The others are
per-message `undecryptable.reason` values (and file errors).

| Reason | Meaning |
| --- | --- |
| `no-e2ee-password` | Account: `RC_E2EE_PASSWORD` is not set. |
| `no-user-keys` | Account: no E2EE key pair on the server. |
| `wrong-password` | Account: the password doesn't unlock the private key. |
| `unsupported-password` | Account: the password has characters the client can't use (above U+00FF). |
| `no-room-key` | No usable room key: none shared with this account yet, or E2EE is not unlocked (check `list_rooms` → `e2ee`). |
| `room-key-missing` | No key for the message's key id. |
| `room-key-undecryptable` | A shared room key doesn't unwrap with your current private key. |
| `unsupported-algorithm` | The format isn't implemented, e.g. Matrix megolm. |
| `malformed-payload` | Structurally invalid ciphertext. |
| `decryption-failed` | Wrong key or corrupted data. |
| `invalid-plaintext` | Decrypted bytes aren't a message payload. |
| `file-key-missing` | A file message carries no key. |
| `file-hash-mismatch` | The decrypted file doesn't match the uploader's SHA-256. |

## Development

```sh
mise install && mise run setup      # Node, pnpm, compose CLI; then dependencies + headless Chromium into node_modules
mise run check                      # lint + typecheck + unit tests
```

To run several tasks in one call, separate them with `:::`, as in `mise run lint ::: typecheck`. Without the
separator, `mise run lint typecheck` would pass `typecheck` to `lint` as an argument.

There are three test layers. No test encrypts with this project's code to prove compatibility.

- **Unit** (`mise run test`, offline):
  - crypto is checked against the committed real-client fixtures and Rocket.Chat's legacy vectors;
  - the index and sync run against a fake Rocket.Chat that serves the captured responses;
  - MCP tools are tested through an in-memory transport;
  - a guard checks that `rc-mcp serve` writes only JSON-RPC to stdout.
- **Integration** (`mise run rc:up`, then `mise run test:ground-truth` once, then `mise run test:integration`):
  runs against a Rocket.Chat 8.9.0 + MongoDB compose stack as alice, bob, carol and the admin `rcadmin`. The
  ground-truth run gives the users real E2EE keys and data and records itself in `.local/stack.json`, which the
  integration tests require. Covers REST pagination, `chat.syncMessages`, downloads, the real rate limiter, and
  `rc-mcp serve` over stdio driven by the MCP client SDK.
- **Ground truth** (`mise run test:ground-truth`): Playwright drives the real web client through E2EE setup,
  messages, uploads and a room key reset. The suite then checks that the decrypted output equals what was typed
  and what the client rendered.

Other tasks: `mise run dev` (server from source with auto-reload), `mise run build`, `mise run rc:down`,
`mise run fixtures:generate`.

**Supporting another Rocket.Chat version:**

1. Set `RC_VERSION` in `.mise.toml`.
2. Run `mise run rc:down && mise run rc:up && mise run fixtures:generate`, then the tests.
3. Read the source diff of `apps/meteor/client/lib/e2ee` between the two versions.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[docs/adr/0001-architecture.md](docs/adr/0001-architecture.md) for the design.

## License

[MIT](LICENSE) © alien2003
