# CLAUDE.md

Guidance for AI coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

`rocketchat-e2ee-mcp` (CLI `rc-mcp`) is a **read-only** MCP server (stdio) and CLI that lets Claude Code browse and
search a Rocket.Chat workspace, including end-to-end encrypted rooms, by decrypting locally with the user's own PAT
and E2EE password. Pinned to Rocket.Chat 8.9.0. Architecture and the reasons behind it:
[docs/adr/0001-architecture.md](docs/adr/0001-architecture.md). Read it before changing `src/`.

## Hard invariants

1. **Read-only.** Never add a code path that changes server state. `RcClient.get()` only accepts endpoints in
   `ENDPOINTS` (`src/rc-api/schemas.ts`); keep it that way.
2. **stdout is the MCP channel.** `rc-mcp serve` must never write to stdout except JSON-RPC from the SDK.
3. **No guessed crypto, no circular crypto tests.** Port from the Rocket.Chat client source; prove against real-client
   fixtures or upstream vectors only.
4. **Secrets never hit disk, logs or errors.** Only throwaway keys from the local stack enter the repository.

## Commands

All tooling comes from mise (`.mise.toml`). Setup: `mise install && mise run setup`.

| Command | Notes |
| ------- | ----- |
| `mise run test` | Unit tests, offline. Must always pass. Same as `vitest run --project unit`. |
| `mise run check` | `lint` and `typecheck`, then the unit tests. |
| `mise run typecheck` | `tsc -p tsconfig.json --noEmit` (TypeScript 7). |
| `mise run lint` / `mise run lint:fix` | Biome check / apply fixes and formatting. |
| `mise run build` | `tsc -p tsconfig.build.json` into `dist/`. |
| `mise run dev` | `node --watch src/cli/main.ts serve`. |
| `node src/cli/main.ts <cmd>` | Run the CLI from source (`serve`, `doctor`, `sync`, `search`, `export`, `purge`). |
| `mise run rc:up` / `rc:down` / `rc:logs` | Compose stack (Rocket.Chat + MongoDB). See "Shared stack" below. |
| `mise run test:integration` | Needs the stack and a recorded ground-truth run (`rc:up`, then `test:ground-truth` once). Uses alice, bob, carol and the admin `rcadmin`. |
| `mise run test:ground-truth` | Drives the real web client (Playwright) against the stack, then decrypts the capture. |
| `mise run fixtures:generate` | Rewrites `test/fixtures/$RC_VERSION/`. Only on purpose; see below. |
| `mise run clean` | Deletes containers, volumes, all of `.local/`, `dist/`, `node_modules/`. Destructive. |

Outside a mise-activated shell, prefix tools with `mise exec --` (e.g. `mise exec -- vitest run --project unit`).
Several tasks in one call are separated with `:::` (`mise run lint ::: typecheck`); `mise run lint typecheck` would
pass `typecheck` to `lint` as an argument.
`RC_MCP_LOG_LEVEL=debug` shows logs during tests (they are silenced otherwise by `test/support/setup-quiet.ts`).

Before finishing a change: `mise run check` (lint, typecheck, unit tests).

## Layout

```text
src/
  config.ts          env vars + optional 0600 JSON config (RC_MCP_CONFIG); registers secrets with the logger
  logger.ts          JSON lines to stderr only; scrubs secrets by key name and by registered value
  app.ts             wiring (config, REST client, E2EE session, index, syncer)
  rc-api/            read-only REST client: allowlist + zod schemas (schemas.ts), rate limits, typed errors
  e2ee/              WebCrypto port of apps/meteor/client/lib/e2ee (decrypt only): private-key, room-key,
                     keyring, content, message, file, encoding (Latin-1 / base64), ejson, errors (failure reasons)
  index/             node:sqlite + FTS5 store (db.ts schema, store.ts upserts), convert.ts, sync.ts
  mcp/               server.ts (tools, resources, error mapping), operations.ts, format.ts, stdio.ts
  cli/               main.ts (commander), doctor.ts, export.ts, output.ts (the only stdout writer)
test/
  unit/              offline; the default test layer
  integration/       against the compose stack
  ground-truth/      decrypts a fresh real-client capture in .local/ground-truth/$RC_VERSION
  fixtures/<x.y.z>/  committed real-client capture (rest/, mongo/, files/, plain/, expected.json)
  fixtures/upstream/ legacy-v1.json, Rocket.Chat's own legacy test vectors (MIT)
  support/           fixture-suite.ts (shared assertions), fake-rc.ts, bootstrap.ts, stack.ts
scripts/             compose.sh, rc-bootstrap.ts, generate-fixtures.ts, extract-upstream-vectors.ts, stack-env.ts
docker/compose.yaml  disposable Rocket.Chat $RC_VERSION + MongoDB 8.0 (replica set rs0)
docs/adr/            architecture decision records
.local/              gitignored scratch: stack.json, Rocket.Chat source clone, Podman socket, dev data
```

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess`; ESM; Node 24 runs `src/` directly via type stripping, so
  **erasable syntax only**: no `enum`, no runtime `namespace`, no constructor parameter properties.
- Relative imports use **`.ts` specifiers** (`'../logger.ts'`); `import type` for types; `node:` prefix for built-ins.
- **No `any`** (use `unknown` + zod), no non-null assertions, **no `console`** in `src/` (Biome errors). Use
  `createLogger({ name })` from `src/logger.ts`; it writes to stderr. Register new secret values with `registerSecret`.
- Biome style: 2 spaces, 120 columns, single quotes, semicolons, trailing commas.
- WebCrypto only; no crypto libraries. Only three runtime dependencies (`@modelcontextprotocol/sdk`, `zod`,
  `commander`); do not add more without a strong reason.
- Decryption failures become `undecryptable` records with a reason from `src/e2ee/errors.ts`; never drop or invent
  content.
- Conventional Commits, scoped by area: `feat(e2ee): ...`, `fix(rc-api): ...`, `test(integration): ...`.

## Gotchas

- **stdout rule.** Only `src/cli/output.ts` may touch `process.stdout`, and only non-`serve` commands import it
  (lazily, inside their action). `test/unit/stdout-guard.test.ts` checks this statically (no `console.*` in `src/`, no
  `process.stdout` outside `output.ts`, `main.ts` must not import `output.ts` at top level) and dynamically (spawns
  `rc-mcp serve`, requires every stdout line to be JSON-RPC). Diagnostics go to stderr.
- **No circular crypto tests.** Never encrypt with our code to test our decryption: a misread format would pass on
  both sides. Use `test/fixtures/<version>/`, `test/fixtures/upstream/legacy-v1.json` or a fresh capture; for
  negative tests, damage those artifacts. `src/e2ee` deliberately has no encrypt side. If a case is not covered,
  extend `scripts/generate-fixtures.ts` so the real web client produces it.
- **Never call mutating endpoints**, including GETs with side effects. Listed in `FORBIDDEN_ENDPOINTS`:
  - `GET /api/v1/logout` revokes the calling token, **including PATs**.
  - `im.history`, `dm.history`, `im.messages` (and other `im.*`/`dm.*` calls) given a username or a non-DM id can
    **create a DM**. Read messages with `rooms.history` / `chat.syncMessages`; `im.files` only with an existing DM
    `roomId` (enforced in `RcClient.get`).
  - `GET chat.ignoreUser` mutates the subscription.
  - `e2e.acceptSuggestedGroupKey` mutates subscriptions; suggested keys are used in memory only.
  Any new endpoint must be checked side-effect-free in the 8.9.0 source (`apps/meteor/server/api/v1`) before it
  goes into `ENDPOINTS`.
- **Password and salt bytes are Latin-1**, not UTF-8: the client's `Binary.decode` maps one UTF-16 code unit to one
  byte. Use `binaryStringToBytes` from `src/e2ee/encoding.ts`, never `TextEncoder`, for PBKDF2 inputs. Characters
  above U+00FF raise `unsupported-password`.
- **Wrapped room keys** (`E2EKey`, `E2ESuggestedKey`, `oldRoomKeys[].E2EKey`) are a key-id prefix followed by
  base64 of the 256-byte RSA ciphertext, which is always **344 chars**. Split from the end (`slice(0, -344)`); the
  prefix is a 36-char UUID for current keys and 12 chars for legacy ones, so never assume its length.
- **Rate limits.** Rocket.Chat limits per client IP and route, by default 10 calls per 60 s (`rooms.history`,
  `chat.getThreadMessages`, `chat.getThreadsList`: 20 per 10 s); admins bypass. `X-RateLimit-Reset` is absolute
  epoch ms and there is no `Retry-After`. Prefer one call for many rooms (`subscriptions.get`, `rooms.get`) over
  per-room calls. The compose stack disables the limiter; `test/integration/rate-limit.test.ts` enables it at
  runtime and disables it in `afterAll`, so an interrupted run can leave it on.
- **Account E2E key reset** (`users.resetE2EKey`) wipes all of the user's login tokens, PATs included, and unsets
  `E2EKey`, `E2ESuggestedKey` and `oldRoomKeys` on all of the user's subscriptions. Pre-reset history is readable
  again only if a member re-shares old keys (`suggestedOldRoomKeys`, used by `src/e2ee/keyring.ts`). The fixture
  generator resets the test users' keys when they already have some, then re-bootstraps fresh tokens.
- **node:sqlite upserts must use `INSERT ... ON CONFLICT DO UPDATE`**, never `INSERT OR REPLACE`, for tables with
  triggers. REPLACE deletes the old row without firing the delete trigger (recursive triggers are off), so the
  external-content FTS5 table (`messages_fts`, kept in sync by triggers in `src/index/db.ts`) would keep stale
  entries.
- **Podman.** `scripts/compose.sh` detects rootless Podman and starts a project-local API socket at
  `.local/podman/podman.sock` (log in `.local/podman/service.log`); a reachable Docker daemon wins; an existing
  `DOCKER_HOST` is respected. Always go through `scripts/compose.sh` (or the `rc:*` tasks), not plain
  `docker compose`. Stop the socket with `scripts/compose.sh --stop-podman-service`.
- **umask.** `src/cli/main.ts` sets `process.umask(0o077)` so the index, its WAL/SHM files and saved files stay
  private. Keep new files written by the tool at 0600 in 0700 directories.
- **Local data.** The data dir must be absolute (`src/config.ts` expands a leading `~` and rejects relative
  paths). In ephemeral mode nothing may be written to disk: `get_file` returns files inline (embedded resource)
  instead of saving them. `rc-mcp purge` removes `<dataDir>/files` only when it contains the `.rc-mcp-files`
  marker (`FILES_MARKER` in `src/mcp/operations.ts`); keep writing that marker if you change where files go.

## Shared stack, worktrees and fixtures

- The compose stack is **one per machine**: fixed project name `rocketchat-e2ee-mcp`, port 3000 on 127.0.0.1 (unless
  `RC_PORT` is set). Every checkout and worktree talks to the same containers and volumes. Do not run `rc:down`,
  `rc:up`, `test:ground-truth`, `fixtures:generate` or `clean` when another session may be using the stack; ask
  first.
- Each checkout has its own gitignored `.local/` (including `stack.json` with the throwaway users' tokens and the
  `groundTruth` record). Re-running the bootstrap regenerates PATs and the generator resets E2E keys, so another
  checkout's `.local/stack.json` goes stale. Integration tests read the current checkout's `.local/stack.json`: run
  them where `rc:up` + `test:ground-truth` last ran.
- Worktrees live under `.claude/worktrees/` (gitignored). `.mise.local.toml` is gitignored too, so copy it into a new
  worktree if you want the in-repo pnpm store; mise may ask you to `mise trust` the worktree's config.
- `mise run fixtures:generate` **deletes and rewrites** `test/fixtures/$RC_VERSION/` with new random keys, ids and
  passphrases: a large diff. Only regenerate on purpose (new Rocket.Chat version or a scenario change), commit it on
  its own, and keep older version directories (the unit suite runs every `test/fixtures/<x.y.z>/`, and several unit
  tests read `test/fixtures/8.9.0` directly). The full new-version procedure, including
  `node scripts/extract-upstream-vectors.ts` after cloning the tag into `.local/rocket.chat`, is in CONTRIBUTING.md
  under "Supporting a new Rocket.Chat version".
- The pinned Rocket.Chat source can be cloned into `.local/rocket.chat` for reading
  (`git clone --depth 1 --branch 8.9.0 https://github.com/RocketChat/Rocket.Chat.git .local/rocket.chat`). E2EE client
  code is in `apps/meteor/client/lib/e2ee`, REST endpoints in `apps/meteor/server/api/v1`.
- **Fixtures are throwaway-only.** They contain E2EE passphrases and key material of the stack's test users, never
  anything from a real workspace. Never point the generator, `stack-env.ts` or tests at a real server, and never
  write real-looking tokens or passwords anywhere; use obvious placeholders such as `<pat>`.
