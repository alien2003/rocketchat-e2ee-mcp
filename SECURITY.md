# Security policy

rocketchat-e2ee-mcp (`rc-mcp`) decrypts end-to-end encrypted Rocket.Chat rooms on your machine with your own keys
and hands the plaintext to an MCP client. Security reports are very welcome.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

Fixes land in the latest 0.1.x release. Rocket.Chat 8.9.0 is the only server version tested against real-client
ground truth. Other server versions are untested; a report against one of them may first need fixtures for that
version (see [CONTRIBUTING.md](CONTRIBUTING.md#supporting-a-new-rocketchat-version)).

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

1. Open <https://github.com/alien2003/rocketchat-e2ee-mcp/security/advisories/new>
   (the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the issue, its impact and how to reproduce it.

Do **not** open a public issue, pull request or discussion for a vulnerability.

Please include:

- the `rc-mcp --version` output, `node --version`, the Rocket.Chat server version and your OS;
- steps to reproduce, preferably against the disposable compose stack in this repository (`mise run rc:up`), which
  only ever holds throwaway users and keys;
- what an attacker gains, and under which preconditions.

Never include real credentials or real content: no personal access tokens, E2EE passwords or passphrases, private
keys, room keys, `index.sqlite` files, decrypted messages, or unredacted `rc-mcp doctor` output from a real
workspace. If a report can only be shown with real data, describe it and we will work out a safe reproduction
together.

This is a volunteer-maintained project. Reports are handled on a best-effort basis: we acknowledge, assess, fix in a
patch release, publish a GitHub Security Advisory and credit the reporter unless you prefer to stay anonymous. There
is no bug bounty.

Vulnerabilities in Rocket.Chat itself (server, web client, its E2EE design) belong to Rocket.Chat. Their
`SECURITY.md` asks for reports through their HackerOne program (<https://hackerone.com/rocket_chat>) or to
security@rocket.chat.

## Scope

In scope, for example:

- **Secret leakage.** The PAT, E2EE password, private key, room keys or per-file keys ending up in logs, error
  messages, stdout, MCP responses or any file.
- **Server mutation.** Any way to make `rc-mcp` change server state: write requests, creating a DM, revoking a token,
  accepting a suggested room key, marking messages read. The REST client is designed so that none of these can be
  expressed (see "Threat model highlights").
- **Wrong plaintext.** Output attributed to the wrong room, author, thread or key; tampered ciphertext or files
  accepted (AES-GCM authentication, the SHA-256 check on encrypted uploads); undecryptable content shown as if it had
  been decrypted.
- **Local storage.** The index, its WAL/SHM files, saved files or exports readable by other local users; path
  traversal through attacker-chosen file names in `get_file` or `rc-mcp export`.
- **Protocol integrity.** Message content that can break or inject into the MCP JSON-RPC stream on stdout.
- **Reachable dependency vulnerabilities** in the three runtime dependencies (`@modelcontextprotocol/sdk`, `zod`,
  `commander`). The SDK also installs HTTP-transport and OAuth packages (Express, Hono, `cors`, `jose` and others);
  `rc-mcp` imports only the SDK's MCP server and stdio transport, which do not load them.

Out of scope (documented trade-offs, see the README "Security model"):

- The plaintext index existing on disk, readable by your own OS account. Use `RC_MCP_EPHEMERAL=1` or
  `rc-mcp purge` if that is not acceptable.
- Decrypted content being sent to your LLM provider. That is the purpose of the tool; it is a policy and consent
  question for every participant of the rooms you read.
- Attackers who already control your OS account, your Rocket.Chat account or the machine running `rc-mcp`.
- Weaknesses of Rocket.Chat's E2EE design that the official web client shares (report those to Rocket.Chat).
- Prompt injection by chat content as such. Messages are untrusted text and `rc-mcp` passes them through; it cannot
  write to Rocket.Chat, but your agent may have other tools. A report is in scope when chat content makes `rc-mcp`
  itself misbehave.
- The throwaway credentials in `docker/compose.yaml`, `test/support/` and `test/fixtures/`.

## Threat model highlights

- **Trust boundary.** Decrypting locally moves plaintext of E2EE rooms onto this machine and, through the MCP
  client, to the LLM provider. This extends the E2EE trust boundary for every participant of every room you read.
- **Read-only by construction.** `RcClient` exposes `get()` for an explicit allowlist of REST endpoints
  (`ENDPOINTS` in `src/rc-api/schemas.ts`) plus authenticated file downloads under `/file-upload/`; there is no
  generic request method. Endpoints with side effects are listed in `FORBIDDEN_ENDPOINTS` with the reason: `logout`
  (revokes the calling token, PATs included), `chat.ignoreUser` (a GET that mutates), `im.history` / `dm.history` /
  `im.messages` (can create a DM), `e2e.acceptSuggestedGroupKey`.
- **Suggested room keys** are used in memory only and never accepted on the server. The trust decision is the same
  one the official web client makes ([ADR 0001](docs/adr/0001-architecture.md), decision 5).
- **Secrets** come only from the environment or a JSON config file (`RC_MCP_CONFIG`) that `rc-mcp` refuses to read
  if group or others have any access to it (not checked on Windows). Secret values are registered with the logger
  and scrubbed from every log line and error message, in addition to scrubbing by field name.
- **Credentials go to `RC_URL` only.** File downloads follow up to 4 redirects to any host; redirects to another
  origin (for example signed storage URLs) are followed without the PAT headers. There is no allowlist of redirect
  targets: `rc-mcp` trusts the Rocket.Chat server it is configured for.
- **`get_file` inputs.** `file_id` must match `[A-Za-z0-9_-]{1,64}`, saved file names are sanitised, and a file is
  only downloaded when it can be tied to a message or to a room's upload list (otherwise `file-not-found`).
- **stdout** carries only MCP JSON-RPC in `rc-mcp serve`. Logs are JSON lines on stderr. A unit test spawns
  `rc-mcp serve` and fails if any stdout line is not JSON-RPC or if a secret appears in any output.
- **No guessed crypto.** Decryption is a WebCrypto port of the Rocket.Chat client at the pinned tag and is tested
  only against artifacts produced by the real web client and by Rocket.Chat's own test vectors. Anything that cannot
  be decrypted is reported with a machine-readable reason; nothing is dropped or invented.

## What rc-mcp stores

Data directory: `RC_MCP_DATA_DIR`, default `$XDG_DATA_HOME/rc-mcp` or `~/.local/share/rc-mcp`. It must be an
absolute path (a leading `~` is expanded; relative paths are rejected). The directory is created with mode 0700 and
the process runs with umask 077.

| What | Where | Contents |
| ---- | ----- | -------- |
| Index | `<dataDir>/index.sqlite` (0600) plus SQLite `-wal` / `-shm` files | **Plaintext** of decrypted messages, the FTS5 search index, room names and key status, authors, timestamps, attachment metadata (per-file keys stripped), sync cursors. For messages that could not be decrypted yet: the raw ciphertext document, kept so it can be retried when a key arrives. |
| Files from `get_file` | `<dataDir>/files/` (0700 directory with the marker file `.rc-mcp-files`, 0600 files) | Downloaded uploads (decrypted if encrypted) that are neither inline text nor images up to 4 MiB; those two are only returned to the MCP client. |
| Exports | the path given to `rc-mcp export -o` (set to 0600, also when the file already existed) | Markdown transcript of a room or thread. |

With `RC_MCP_EPHEMERAL=1` (or `"ephemeral": true` in the config file) nothing is written: the index lives in memory
and `get_file` returns other files inline as an MCP embedded resource (up to 10 MiB).
`rc-mcp purge` deletes `index.sqlite` and its `-wal` and `-shm` files, and `<dataDir>/files` only if it contains the
marker file. It also runs while `RC_MCP_EPHEMERAL` is set, so it can clean up after earlier non-ephemeral runs.

Messages deleted on the server are removed from the index when their room is next synced, with one exception: with
`Message_KeepHistory` on and `Message_ShowDeletedStatus` off, Rocket.Chat hides deleted messages without reporting
the deletion, so their plaintext stays in the index until `rc-mcp sync <room> --full` or `rc-mcp purge`.

**Never stored:** the PAT and the E2EE password (read from the environment or the config file, never written back),
the private key, room keys and per-file keys. `get_file` downloads and decrypts the upload again each time.

## Test fixtures contain throwaway keys only

`test/fixtures/<version>/` is captured by `scripts/generate-fixtures.ts`, which drives the real Rocket.Chat web client
against the disposable local compose stack. It contains E2EE passphrases, encrypted private keys, wrapped room keys,
ciphertexts and decrypted plaintexts of throwaway users (`alice`, `bob`, `rcadmin`, `@example.test` addresses) that
exist only in that stack. It contains no login passwords or tokens. `test/fixtures/upstream/legacy-v1.json` holds
public test vectors copied from Rocket.Chat's own test suite (MIT).

These values are published on purpose and are worthless outside the test stack. Do not report them as leaked
secrets. Conversely, never generate fixtures against, or copy data from, a real workspace, and never commit real
tokens, passwords, keys or messages anywhere in this repository.
