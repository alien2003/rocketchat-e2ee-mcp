# ADR 0002: `node:sqlite` instead of `better-sqlite3`

- Status: accepted
- Date: 2026-10-15
- Refines: ADR 0001 §2

## Context

rc-mcp keeps a local full-text index of decrypted messages. It needs:

- SQLite with **FTS5**;
- the `unicode61` tokenizer with `remove_diacritics`, so that "deploiement" finds "déploiement";
- `snippet()` and `bm25()`.

The package is meant to run as `npx -y rocketchat-e2ee-mcp` on developer machines and CI runners. Many of those have
no C/C++ toolchain, and some platform/Node combinations have no prebuilt binaries.

Two candidates:

- **`better-sqlite3`**: mature, fast, synchronous API, FTS5 included. It is a native addon, so it needs a prebuilt
  binary for the exact platform and Node ABI, or a local compile.
- **`node:sqlite`**: built into Node (`DatabaseSync`), synchronous API close to better-sqlite3's, no install step.
  It is newer, and its feature set depends on how Node compiled SQLite.

## Decision

Use `node:sqlite` and require `engines.node >= 24`. The project pins Node 24.22.0 through mise.

Verified on this repository's pinned runtime with a throwaway in-memory database:

| Check | Result |
| --- | --- |
| `process.version` | `v24.22.0` |
| `sqlite_version()` | `3.53.4` |
| `pragma_compile_options` containing `ENABLE_FTS5` | present |
| `CREATE VIRTUAL TABLE … USING fts5(x, tokenize='unicode61 remove_diacritics 2')` | works |
| `MATCH 'cafe deploi*'` against "Café déploiement runbook" | matches; accents folded, prefix query works |
| `snippet(t, 0, '«', '»', '…', 8)` / `bm25(t)` | `«Café» «déploiement» runbook` / a numeric rank |
| `ExperimentalWarning` on stderr | none printed |

The index uses exactly these features (`src/index/db.ts`):

- an FTS5 external-content table over `messages.search_text`, kept in sync by triggers;
- `snippet` and `bm25` in `IndexStore.search`;
- WAL mode for on-disk databases;
- `:memory:` for `RC_MCP_EPHEMERAL=1`.

## Consequences

- **No native dependency.** Runtime dependencies stay at three (`@modelcontextprotocol/sdk`, `zod`, `commander`).
  `npx` needs no compiler, and there is no prebuilt-binary matrix to maintain.
- **Node 24 is the floor, but nothing enforces it at startup.** npm and npx only warn about an `engines` mismatch
  (unless `engine-strict` is set) and then run the bin. rc-mcp has no version check of its own: on a Node version
  without `node:sqlite`, the CLI fails while importing `node:sqlite` at startup, before any rc-mcp code runs.
  `rc-mcp doctor` reports "rc-mcp needs Node.js 24 or newer" only on an older Node that can load the CLI at all.
- **FTS5 depends on Node's SQLite build.** Every Node version the project supports must keep `ENABLE_FTS5`. The
  unit tests open a real `node:sqlite` index and run FTS queries (`test/unit/index/index-sync.test.ts`), so CI on
  the pinned Node detects a regression.
- **Swapping back is contained, but not one file.** The `node:sqlite` API is used in `src/index/db.ts` (open,
  pragmas, migrations) and `src/index/store.ts` (`DatabaseSync` / `SQLInputValue` types, prepared statements).
  `getFile` in `src/mcp/operations.ts` runs one prepared query through `app.store.db`. better-sqlite3's API has the
  same shape (`prepare().run/get/all`, `exec`), so a swap touches these three files and the dependency list.
- **Younger module.** `node:sqlite` has a shorter track record than better-sqlite3. rc-mcp uses only its basic
  surface: `exec`, `prepare().run/get/all`, and transactions as explicit `BEGIN` / `COMMIT` / `ROLLBACK`
  (`IndexStore.transaction`).
