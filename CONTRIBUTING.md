# Contributing to rocketchat-e2ee-mcp

Thanks for helping. This project is a read-only MCP server and CLI (`rc-mcp`) that decrypts end-to-end encrypted
Rocket.Chat rooms locally. Because it handles other people's encrypted messages, a few rules are stricter than usual.
Please read this file and [ADR 0001](docs/adr/0001-architecture.md) before a non-trivial change, and open an issue
first for anything large.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Read-only, always.** No code path may change server state: no sending, editing, reacting, marking read, accepting
  keys, creating DMs or logging out.
- **No guessed crypto.** Every format detail comes from the Rocket.Chat client source at the pinned tag and is proven
  against artifacts produced by the real web client. See [No circular crypto tests](#the-no-circular-crypto-tests-rule).
- **stdout belongs to MCP.** `rc-mcp serve` speaks JSON-RPC on stdout; one stray byte breaks the session.
- **Secrets are never persisted or logged**, and only throwaway keys from the local test stack ever enter the
  repository.

## Development setup

You need [mise](https://mise.jdx.dev). For the compose stack you also need Docker Engine or rootless Podman (plus
`curl`, which `scripts/compose.sh` uses to check the Podman socket). Everything else is pinned in `.mise.toml`
(Node 24.22.0, pnpm 12.11.2, docker-compose 5.6.0) and installed by mise:

```sh
mise install && mise run setup
```

`setup` runs `pnpm install --frozen-lockfile` and installs Playwright's headless Chromium shell into `node_modules`
(`PLAYWRIGHT_BROWSERS_PATH=0`), so nothing is written to `~/.cache`. `node_modules/.bin` is on `PATH` inside mise.

### Optional: keep the pnpm store inside the repository

Machine-specific overrides go in `.mise.local.toml`, which is gitignored. To keep pnpm's and npm's caches under
`.local/` instead of your home directory:

```toml
# .mise.local.toml
[env]
pnpm_config_store_dir = "{{config_root}}/.local/pnpm-store"
pnpm_config_cache_dir = "{{config_root}}/.local/pnpm-cache"
pnpm_config_state_dir = "{{config_root}}/.local/pnpm-state"
npm_config_cache = "{{config_root}}/.local/npm-cache"
```

### Running from source

Sources run directly with Node's type stripping; no build step is needed during development.

```sh
mise run dev                  # node --watch src/cli/main.ts serve  (MCP over stdio, restarts on change)
node src/cli/main.ts doctor   # any CLI command, straight from src/
mise run build                # tsc -p tsconfig.build.json -> dist/
```

### mise tasks

| Task | What it does |
| ---- | ------------ |
| `setup` | Install dependencies and the Playwright browser (inside the repo) |
| `dev` | Run the MCP server from source with auto-reload (stdio) |
| `build` | Compile TypeScript to `dist/` |
| `lint` / `lint:fix` | `biome check .` / `biome check --write .` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |
| `test` | Unit tests (offline) |
| `check` | `lint` and `typecheck`, then the unit tests |
| `test:integration` | Integration tests against the compose stack |
| `test:ground-truth` | Drive the real web client into a scratch dir, then decrypt that fresh capture |
| `fixtures:generate` | Regenerate the committed fixtures in `test/fixtures/$RC_VERSION` |
| `rc:up` / `rc:down` / `rc:logs` | Start + bootstrap / stop and drop volumes / follow logs of the compose stack |
| `clean` | Remove containers, volumes, the Podman API service, `.local`, `dist`, `node_modules`, `coverage` |

To run several tasks in one call, separate them with `:::`, as in `mise run lint ::: typecheck`. Without the
separator, `mise run lint typecheck` passes `typecheck` to `lint` as an argument.

`mise run clean` deletes all of `.local/`, including the Rocket.Chat source clone, `.local/stack.json` and, if you use
the snippet above, the in-repo pnpm store.

## Tests: three layers

| Layer | Command | Needs | What it proves |
| ----- | ------- | ----- | -------------- |
| Unit | `mise run test` | nothing (offline) | Decryption of the committed real-client fixtures (`test/fixtures/<version>/`) and Rocket.Chat's own legacy vectors (`test/fixtures/upstream/legacy-v1.json`); failure reasons on deliberately damaged fixtures; index and sync against a fake Rocket.Chat serving the captures (`test/support/fake-rc.ts`); MCP tools over the SDK's in-memory transport; config, logger and secret scrubbing; the stdout guard, which spawns `rc-mcp serve`. |
| Integration | `mise run test:integration` | running stack + a recorded ground-truth run | REST pagination, `chat.syncMessages`, encrypted downloads, all four stack accounts (alice, bob, carol and the admin `rcadmin`), a real `rc-mcp serve` driven over stdio by the MCP client SDK, and the real REST rate limiter (429 handling). |
| Ground truth | `mise run test:ground-truth` | running stack | Playwright drives the real web client to produce a fresh capture in `.local/ground-truth/$RC_VERSION`, then the shared fixture suite (`test/support/fixture-suite.ts`) decrypts it and compares with what was typed and what the real client rendered. |

The unit layer must pass on every commit. Run the other two whenever you touch `src/rc-api`, `src/index/sync.ts`,
`src/e2ee`, the MCP stdio wiring or anything version-specific. A full run:

```sh
mise run rc:up
mise run test:ground-truth   # also records the run in .local/stack.json, which integration tests need
mise run test:integration
mise run rc:down
```

Tests silence the logger; set `RC_MCP_LOG_LEVEL=debug` to see the JSON log lines on stderr. To run a subset, pass
paths to Vitest: `mise exec -- vitest run --project unit test/unit/e2ee`.

### The "no circular crypto tests" rule

No test may encrypt with our code and then decrypt with our code as evidence of compatibility.

A round trip only proves that the code agrees with itself. If we misread the protocol (password bytes encoded as UTF-8
instead of Latin-1, the wrong split between key id and wrapped key, the wrong IV length), the mistake is made on both
sides and the test passes while every real message fails. Evidence must come from outside our code:

1. **Real-client fixtures** in `test/fixtures/<version>/`, produced by `scripts/generate-fixtures.ts` driving
   Rocket.Chat's own web client: key pairs, the 12-word passphrase, stored private key, room keys, ciphertexts,
   encrypted uploads and a room-key reset, with the typed text and the rendered text as the expected values.
2. **Upstream test vectors** in `test/fixtures/upstream/legacy-v1.json`, extracted from Rocket.Chat's test suite for
   legacy formats current clients no longer produce.
3. **A fresh capture** from the ground-truth layer.

Negative tests damage those artifacts (flip bytes, wrong password, missing keys) instead of producing new ciphertext;
see `test/unit/e2ee/failure-modes.test.ts`. `src/e2ee` has no encrypt side at all. Generating a throwaway key to
exercise plumbing that never decrypts anything is fine; producing ciphertext is not. If you need a format the
fixtures do not cover, extend `scripts/generate-fixtures.ts` so the real client produces it.

## The compose stack

`docker/compose.yaml` (project name `rocketchat-e2ee-mcp`) runs Rocket.Chat `$RC_VERSION` and MongoDB 8.0 as a
single-node replica set. It is disposable and holds throwaway credentials only; never point it at, or reuse its values
for, a real workspace.

```sh
mise run rc:up     # scripts/compose.sh up -d, then node scripts/rc-bootstrap.ts
mise run rc:logs
mise run rc:down   # stops the stack and deletes its volumes
```

- Rocket.Chat listens on `http://localhost:3000`, bound to 127.0.0.1 (set `RC_PORT` to change the port).
  `http://localhost` is a browser secure context, which the E2EE web client requires.
- E2EE is on and new private groups and DMs are encrypted by default. Two-factor authentication is off. The REST
  rate limiter is **off**, because every Playwright browser shares 127.0.0.1; the integration tests switch it on at
  runtime.
- `scripts/rc-bootstrap.ts` waits for the server, logs in as the admin `rcadmin` (password from `RC_ADMIN_PASS`, with a
  throwaway default in `docker/compose.yaml`), creates the users `alice`, `bob` and `carol` with personal access
  tokens, and writes everything to `.local/stack.json` (mode 0600). Re-running it regenerates the tokens.
- To point `rc-mcp` at the stack, run `node scripts/stack-env.ts` after a ground-truth or fixtures run. It writes
  `.local/stack-<user>.config.json` (mode 0600) for alice, bob and carol, with the E2EE password for users that have
  one. Then:

  ```sh
  RC_MCP_CONFIG=.local/stack-alice.config.json node src/cli/main.ts doctor
  ```

`scripts/compose.sh` passes any arguments to compose, e.g. `scripts/compose.sh ps`. It uses the docker-compose v2+
binary from mise and falls back to `docker compose`.

### Podman

`scripts/compose.sh` works with rootless Podman without system services:

- Docker is used whenever a real Docker daemon is reachable. Podman is used when `docker` is the Podman shim, or when
  there is no `docker` command at all.
- For Podman it starts `podman system service --time=0` on a project-local socket, `.local/podman/podman.sock` (log in
  `.local/podman/service.log`), and sets `DOCKER_HOST` for that invocation only. Nothing is installed or enabled
  outside the repository.
- If `DOCKER_HOST` is already set, the script uses it unchanged.
- Stop the service with `scripts/compose.sh --stop-podman-service` (`mise run clean` does this too).
- Images are fully qualified (`docker.io/...`), so Podman does not need short-name resolution.

This has been verified with Podman 4.9.3 on WSL2.

## Supporting a new Rocket.Chat version

The committed fixtures are the proof that decryption works for a version. A new version is supported only after its
fixtures are captured and the suites pass. Rocket.Chat's git tags have no `v` prefix (for example `8.9.0`).

1. **Bump the version.** Set `RC_VERSION` in `.mise.toml` to the new tag. The compose image tag, the fixture directory
   and the ground-truth directory all derive from it. Also check `compatibleMongoVersions` in the new tag's
   `.github/workflows/ci.yml` and update the MongoDB image in `docker/compose.yaml` if it changed. Until step 3 is
   done, `mise run test` fails on purpose: it requires committed fixtures for the pinned version.
2. **Start a fresh stack** with the new image:

   ```sh
   mise run rc:down && mise run rc:up
   ```

3. **Capture fixtures** with the real web client:

   ```sh
   mise run fixtures:generate
   ```

   This writes `test/fixtures/$RC_VERSION/` (the directory is deleted and recreated). Keep the older version
   directories: the unit suite runs the shared fixture suite for every `test/fixtures/<x.y.z>/` directory, and some
   unit tests read `test/fixtures/8.9.0` directly. If the generator fails because the UI changed, update its
   selectors; they follow the page objects in `apps/meteor/tests/e2e` at the pinned tag. For debugging, run
   `node scripts/generate-fixtures.ts --out <dir> --headed`; screenshots and the browser console log go to
   `.local/ground-truth-shots/`.
4. **Run all three test layers** (`mise run test`, `mise run test:ground-truth`, `mise run test:integration`).
5. **Read what changed upstream.** Clone the new tag into `.local/rocket.chat` (gitignored), fetch the previous tag
   and diff the E2EE client code:

   ```sh
   rm -rf .local/rocket.chat
   git clone --depth 1 --branch <tag> https://github.com/RocketChat/Rocket.Chat.git .local/rocket.chat
   git -C .local/rocket.chat fetch --depth 1 origin tag <previous-tag>
   git -C .local/rocket.chat diff <previous-tag> <tag> -- apps/meteor/client/lib/e2ee apps/meteor/public/enc.js
   ```

   Also review `apps/meteor/server/api/v1` and `packages/rest-typings` for every endpoint in `ENDPOINTS`
   (`src/rc-api/schemas.ts`): still a GET, still free of side effects, same response shape. Port format changes into
   `src/e2ee` as new versioned codecs (additive, old formats keep working), with fixtures that exercise them.
6. **Refresh the upstream vectors** from the clone:

   ```sh
   node scripts/extract-upstream-vectors.ts
   ```

   It reads `apps/meteor/tests/e2e/fixtures/userStates.ts` and
   `apps/meteor/tests/e2e/e2e-encryption/e2ee-legacy-format.spec.ts` from `.local/rocket.chat` and rewrites
   `test/fixtures/upstream/legacy-v1.json`, recording `RC_VERSION` as the source tag (run it inside mise, e.g.
   `mise exec -- node scripts/extract-upstream-vectors.ts`, so the variable is set).
7. **Update the docs**: `docs/e2ee-protocol.md` (format details and the supported-formats matrix), the supported
   versions listed in the README, and `CHANGELOG.md` under `[Unreleased]`.
8. **Review the fixture diff** before committing: only throwaway users of the local stack (`@example.test`
   addresses), never anything from a real workspace. Commit the regenerated fixtures in a commit of their own.

## Coding conventions

- **TypeScript, strict.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
  `noUnusedLocals` / `noUnusedParameters` and friends (see `tsconfig.json`). `mise run typecheck` must pass.
- **Erasable syntax only** (`erasableSyntaxOnly`): Node runs `src/` by stripping types, so no `enum`, no `namespace`
  with runtime code, no constructor parameter properties, no `import x = require()`. Use union types and `as const`
  objects instead of enums.
- **`.ts` import specifiers** for relative imports (`import { log } from '../logger.ts'`); `tsc` rewrites them to `.js`
  in `dist/` (`rewriteRelativeImportExtensions`). Type-only imports use `import type` (`verbatimModuleSyntax`, Biome
  `useImportType`). Node built-ins use the `node:` prefix.
- **No `any`** (`noExplicitAny` is an error). Use `unknown` and validate with zod at trust boundaries; REST responses
  are validated in `src/rc-api/schemas.ts`. No non-null assertions (`!`) either.
- **No `console`** in `src/` (Biome `noConsole`; allowed in `scripts/` and `test/`). Log through `src/logger.ts`
  (`createLogger({ name })`), which writes JSON lines to **stderr** only and scrubs secrets. Register new secret values
  with `registerSecret`. User-facing CLI output goes through `src/cli/output.ts`, the only module allowed to write to
  stdout, and `rc-mcp serve` must never import it.
- **Biome** formats and lints: 2 spaces, 120 columns, single quotes, semicolons, trailing commas. `mise run lint:fix`
  applies it.
- **WebCrypto only** for cryptography; no crypto libraries. New runtime dependencies need a strong reason (there are
  three; see ADR 0001).
- **Errors are typed and safe to show**: machine-readable codes (`src/rc-api/errors.ts`, `src/e2ee/errors.ts`), never
  a secret or raw request data in a message.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`, imperative mood,
no trailing period. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`. Scopes follow
the layout: `e2ee`, `rc-api`, `index`, `mcp`, `cli`, `test(integration)`, `test(ground-truth)`. Examples from the
history:

```text
feat(e2ee): WebCrypto port of the Rocket.Chat 8.9 E2EE client codecs
feat(rc-api): read-only PAT REST client with rate-limit handling
test(integration): live-stack REST, sync, MCP stdio and rate-limit tests
```

Mark breaking changes with `!` (`feat(mcp)!: ...`) and a `BREAKING CHANGE:` footer.

## Pull request checklist

- [ ] `mise run check` passes (lint, typecheck and unit tests).
- [ ] Changes to `src/rc-api`, `src/index/sync.ts`, `src/e2ee` or the stdio wiring were also run through
      `mise run test:ground-truth` and `mise run test:integration`.
- [ ] Still read-only: any new endpoint is a GET, checked side-effect-free in the upstream source at the pinned tag,
      added to `ENDPOINTS` with a zod schema; dangerous neighbours go in `FORBIDDEN_ENDPOINTS`.
- [ ] No circular crypto tests; new crypto behaviour is covered by real-client fixtures or upstream vectors.
- [ ] Nothing new writes to stdout outside `src/cli/output.ts`; no `console` in `src/`.
- [ ] No real tokens, passwords, keys or messages in code, fixtures, logs, screenshots or the PR description.
- [ ] Docs updated where behaviour changed (README, `docs/`, ADRs), plus an entry under `[Unreleased]` in
      `CHANGELOG.md`.
- [ ] Commit messages follow Conventional Commits.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
