# ADR 0001: Architecture and key decisions for v0.1

- Status: accepted
- Date: 2026-10-15
- Pinned Rocket.Chat: 8.9.0 (MongoDB 8.0)

## Context

Teams keep how-tos, decisions and runbooks in Rocket.Chat threads, often in end-to-end encrypted (E2EE) private
groups and DMs. The server only stores ciphertext for those rooms, so neither server-side search nor Rocket.Chat's
own (enterprise, server-side) MCP endpoint can read them. We want Claude Code to browse and search that content,
which means decrypting **on the user's machine with the user's own keys**, exactly like the official web client.

Constraints that shape everything below:

- **Read-only.** v1 must not mutate server state in any way (no sending, reacting, marking read, accepting suggested
  keys, creating DMs, logging out...).
- **No guessed crypto.** Every format detail is taken from the Rocket.Chat client source at the pinned tag and
  proven against artifacts produced by the real web client (see ADR 0003).
- **stdio MCP.** stdout belongs to the JSON-RPC protocol; any stray write breaks the session.
- **Secrets** (PAT, E2EE password) only come from the environment or a 0600 file and are never persisted or logged.

## Decision

### Layers

```
src/
  config.ts, logger.ts       env/0600-file config; JSON-lines logger -> stderr only, secret scrubbing
  rc-api/                    REST client: PAT headers, allowlisted GET endpoints, zod-validated responses,
                             pagination helpers, 429/X-RateLimit-* backoff, timeouts, typed errors
  e2ee/                      WebCrypto port of apps/meteor/client/lib/e2ee: versioned codecs for the stored
                             private key, room keys (E2EKey / oldRoomKeys / E2ESuggestedKey), message content,
                             encrypted uploads; a per-room keyring; explicit failure reasons
  index/                     node:sqlite + FTS5 store of decrypted messages, per-room sync cursors, purge
  mcp/                       @modelcontextprotocol/sdk server over stdio: tools, resources, error mapping
  cli/                       commander-based `rc-mcp` (serve | doctor | sync | search | export | purge)
```

Data flow: `rc-api` fetches raw documents -> `e2ee` turns them into `DecryptedMessage | UndecryptableMessage` ->
`index` stores plaintext + FTS -> `mcp`/`cli` read from the index (and live REST when the index is cold).

### Key decisions

1. **Runtime: Node 24 LTS, TypeScript 7 (`tsc`), ESM, erasable syntax only.** Pinned via mise. Sources use
   `.ts` import specifiers with `rewriteRelativeImportExtensions`, so `node src/cli/main.ts` runs directly in dev
   (type stripping) and `tsc` emits plain JS for the package. No bundler.

2. **SQLite: `node:sqlite`, not `better-sqlite3`.** Verified in this repo on Node 24.22: SQLite 3.53 compiled with
   `ENABLE_FTS5`, `unicode61 remove_diacritics`, `snippet()` and `bm25()` all work, and no experimental warning is
   printed. It removes the only native dependency, so `npx rocketchat-e2ee-mcp` needs no compiler or prebuilt
   binary. Trade-off: the module is newer than better-sqlite3; the store sits behind a tiny interface
   (`src/index/db.ts`) so swapping is a one-file change. `engines.node >= 24`.

3. **WebCrypto only** (`globalThis.crypto.subtle`), no crypto libraries, so the browser client's code ports 1:1.
   Codecs are **versioned** (`rc.v1.aes-sha2`, `rc.v2.aes-sha2`; private key `$binary` v1 and `{iv,ciphertext,salt,
   iterations}` v2) behind a registry, so future formats are additive. Anything we cannot decrypt is returned as an
   `undecryptable` record with a machine-readable reason; nothing is dropped or invented.

4. **Strictly read-only REST client.** `RcClient` exposes `get()` for an explicit allowlist of endpoints plus
   authenticated file downloads; there is no generic request method, so a write cannot be expressed. Notable
   exclusions found while reading the 8.9 source: `GET /api/v1/logout` revokes the PAT that calls it,
   `GET chat.ignoreUser` mutates, and `im.*`/`dm.*` called with a username (or an id that is not a DM rid) can
   **create** a DM. We therefore read messages through `rooms.history` / `chat.syncMessages`, which accept any
   room type by rid.

5. **Suggested room keys are used locally, never accepted.** When a subscription only has `E2ESuggestedKey`
   (another member's client re-shared the key, but this user's official client has not accepted it yet), we
   decrypt with it in memory and mark the room `keyStatus: "suggested"`. We never call
   `e2e.acceptSuggestedGroupKey`. `doctor` reports such rooms and tells the user to open the official client once.
   Trust is equivalent to the official client, which auto-accepts any suggested key that decrypts with the user's
   private key.

6. **Sync strategy** (cheapest correct endpoints, from the 8.9 source):
   - room + key metadata: one `subscriptions.get` (includes `E2EKey`, `oldRoomKeys`, `E2ESuggestedKey`) and one
     `rooms.get` (type, `encrypted`, `e2eKeyId`, last activity);
   - backfill: `rooms.history` cursor pages (count 100, newest first, 20 req/10 s server limit);
   - incremental: `chat.syncMessages` cursor mode (`type=UPDATED|DELETED`, `next=<epoch ms>`), which also
     yields edits and deletions; cursors are exclusive on millisecond timestamps, so we overlap by 1 ms and upsert
     idempotently by `_id`;
   - the update watermark for a fresh room is taken from the server's `Date` header at backfill start, so edits
     during a long backfill are not lost; deletion trash expires after 30 days, so a room whose cursor is older
     than that is fully resynced.

7. **Rate limits.** Rocket.Chat's limiter is keyed per client IP and route (default 10 calls/60 s; `rooms.history`
   20/10 s) and admins bypass it. The client honours `429`, reads `X-RateLimit-Reset` (absolute epoch ms; there is
   no `Retry-After`), adds jitter, and serialises requests per route.

8. **Plaintext index on disk** is the main security trade-off: needed for fast full-text search across rooms.
   Mitigations: file mode 0600 in a 0700 directory, XDG data dir by default (configurable), `RC_MCP_EPHEMERAL=1`
   for an in-memory index, `rc-mcp purge`, and prominent documentation. Keys and passwords are never written.

9. **Logging:** a 70-line JSON-lines logger writing only to stderr, with key-based and value-based secret
   scrubbing. Biome's `noConsole` rule and a test that spawns `rc-mcp serve` and checks every stdout line is
   JSON-RPC enforce the stdout rule.

10. **Test layers** (ADR 0003): unit (offline, crypto against committed real-client fixtures), integration (compose
    stack), ground truth (Playwright drives the real web client). No test encrypts with our code and decrypts with
    our code as evidence of compatibility.

### Dependencies (runtime: 3)

| Package | Why |
| --- | --- |
| `@modelcontextprotocol/sdk` | Official MCP implementation (required). It brings its own HTTP deps we do not use. |
| `zod` | Tool input schemas (SDK peer) and validation of REST responses at the trust boundary. |
| `commander` | Small, dependency-free CLI parser with subcommands and help output. |

Dev only: `typescript`, `@types/node`, `vitest` (tests), `@biomejs/biome` (lint+format, single binary),
`@playwright/test` (drives the real web client for fixtures). Considered and rejected: `better-sqlite3`
(native build), `pino` (writes to stdout by default; our needs fit in 70 lines), `undici` (Node's fetch suffices),
any JOSE/crypto library (WebCrypto covers RSA-OAEP, AES-GCM/CBC/CTR, PBKDF2).

## Consequences

- Rocket.Chat's E2EE trust boundary is extended to this machine and to the LLM provider for every room the user
  reads; documented prominently in README "Security model".
- Only rooms where the user holds (or has been offered) a room key are readable; others are listed with a reason.
- New Rocket.Chat versions need `mise run fixtures:generate` against the new tag before claiming support.
