# ADR 0004: Strictly read-only REST surface, suggested keys used locally, keys never stored

- Status: accepted
- Date: 2026-10-15
- Refines: ADR 0001 §4, §5 and §8

## Context

rc-mcp runs unattended inside an LLM agent with the user's own PAT and E2EE password. That makes three kinds of
mistake expensive:

1. **Changing server state.** Several Rocket.Chat 8.9.0 endpoints that look harmless mutate state:
   - `GET /api/v1/logout` revokes the calling token, PATs included;
   - `GET chat.ignoreUser` mutates the subscription;
   - `im.history` / `im.messages` (and the `dm.*` aliases), called with a username or with an id that is not a DM,
     can **create** a direct message.

   Accepting or rejecting a suggested room key (`e2e.acceptSuggestedGroupKey` / `e2e.rejectSuggestedGroupKey`)
   changes the user's subscription and the room's key queue.
2. **Changing the user's E2EE trust decisions.** In the official client, accepting a suggested key is a decision the
   user's own client makes (`rocketchat.e2e.ts:194-225`). Doing it from a second, headless client would change what
   the user's other sessions see.
3. **Leaking key material.** The PAT and E2EE password unlock everything. The private key, room keys and per-file
   keys decrypt every message the user can read, including past messages through `oldRoomKeys`. Unlike the plaintext
   index, keys are not needed after use.

A subscription can carry only `E2ESuggestedKey`, usually together with `suggestedOldRoomKeys` (the older keys the
sharing member re-wrapped). This happens when another member's client re-shared the room key (after a reset, after an
account key reset, or for a new member) but the user's official client has not run since. Refusing such keys would
leave those rooms unreadable until the user opens the official client.

## Decision

### 1. The REST client cannot express a write

- `RcClient` (`src/rc-api/client.ts`) has no generic request method.
- Its only network methods are:
  - `get(endpoint, params)`: a `GET` to `/api/v1/<endpoint>`;
  - `serverInfo()`: `GET /api/info`;
  - `download(path)`: a `GET` of `/file-upload/<id>/<name>`.
- `get()` refuses any name not in `ENDPOINTS` (`src/rc-api/schemas.ts`), and every allowlisted response has a zod
  schema. The allowlist:
  - `me`
  - `rooms.get`, `rooms.info`, `rooms.history`
  - `subscriptions.get`, `subscriptions.getOne`
  - `chat.syncMessages`, `chat.getMessage`, `chat.getThreadMessages`, `chat.getThreadsList`, `chat.search`
  - `users.info`
  - `e2e.fetchMyKeys`
  - `groups.files`, `channels.files`, `im.files`
- `im.files` additionally requires `roomId` and refuses a `username` parameter, so it can only address an existing
  DM.
- Messages are read through `rooms.history` / `chat.syncMessages`, which accept any room type by id, never through
  `im.*`.
- `FORBIDDEN_ENDPOINTS` documents the exclusions with their reasons: `logout`, `chat.ignoreUser`, `im.history`,
  `dm.history`, `im.messages`, `e2e.acceptSuggestedGroupKey`.
- `test/unit/rc-api/client.test.ts` asserts three things: no forbidden name is allowlisted, `RcClient`'s prototype
  has no `post`/`put`/`patch`/`delete` method, and refused calls never reach the network.
- Downloads:
  - only `/file-upload/<id>/<name>` paths without `..` are accepted;
  - redirects are followed manually, and the PAT headers go only to the configured origin, so a signed S3/GCS URL
    never receives them;
  - API requests use `redirect: 'error'`.
- Every MCP tool is annotated `readOnlyHint: true`, `destructiveHint: false`.

### 2. Suggested keys are used locally and never accepted

- When a subscription has no usable `E2EKey` (none, or one that does not unwrap with the user's private key) but has
  an `E2ESuggestedKey`, the keyring unwraps the suggested key in memory and uses it as the room's current key
  (`src/e2ee/keyring.ts`). The room's `key_status` becomes `suggested`.
- While the suggested key is in use and the subscription has no `oldRoomKeys`, the keyring also unwraps
  `suggestedOldRoomKeys` as old keys, read-only. This mirrors the server's accept rule: on acceptance,
  `suggestedOldRoomKeys` become `oldRoomKeys` only when the subscription has none (`handleSuggestedGroupKey.ts:29`).
  History from before a room key reset, or from before an account key reset, is therefore readable in the
  `suggested` state, as it will be once the official client accepts the key.
- rc-mcp never calls `e2e.acceptSuggestedGroupKey` or `e2e.rejectSuggestedGroupKey`. Neither is on the allowlist,
  and neither could be sent, because both are POSTs.
- `doctor`, `list_rooms` and the room's `key_detail` tell the user that the key was offered by another member and
  not yet accepted, and that opening the official client once accepts it.
- **Trust is equivalent to the official client.** For a subscription with a suggested key and no current key, the
  official client accepts the suggested key as soon as it unwraps with the user's private key. It performs no other
  check (`rocketchat.e2e.ts:194-225`, `rocketchat.e2e.room.ts:387-428`). rc-mcp applies the same condition and only
  skips the server-side bookkeeping.
- When the subscription also has an `E2EKey` that unwraps, rc-mcp uses it and its `oldRoomKeys`, and ignores the
  suggestion.

### 3. Keys and passwords are never stored

- **Secrets** (PAT, E2EE password) come only from the environment or from the optional config file, which must be
  mode 0600 or it is refused (`src/config.ts`). rc-mcp never writes them anywhere. They are registered with the
  logger, which redacts them by value from every log line and error message (`src/logger.ts`).
- **The private key, room keys and keyrings** exist only in process memory, inside `E2eeSession`
  (`src/e2ee/session.ts`). They are derived again on each start from `e2e.fetchMyKeys` and the password.
- **Per-file keys** are dropped before anything is persisted. `sanitizeAttachment` (`src/index/convert.ts`) keeps
  `encrypted: true` instead of the `encryption` object, and `test/unit/index/index-sync.test.ts` asserts that the
  messages table contains no JWK, no `encryption` object and no `A256CTR`. `get_file` therefore re-fetches the
  message with `chat.getMessage`, decrypts its content again to obtain the file key, downloads the ciphertext, and
  decrypts it. For an E2EE file message without encrypted content, it decrypts the key from the room's upload
  record (`groups.files` / `im.files` / `channels.files`) instead.
- **What the index does store:**
  - decrypted text and attachment metadata;
  - the key id (`kid`) a message was encrypted with;
  - for messages that are still undecryptable, their raw **ciphertext** document (`pending_raw`), so they can be
    retried locally when a key arrives. A ciphertext document contains no keys.

## Consequences

- **Server state is untouched.** rc-mcp cannot log the user out, create DMs, mark messages read, accept or reject
  keys, or send anything.
- **Some flows need the official client.** The account must have set up E2EE once (`no-user-keys` otherwise). A
  suggested key stays pending on the server until the official client accepts it.
- **A suggested key can disappear.** A room key reset, for example, unsets `E2ESuggestedKey` and
  `suggestedOldRoomKeys` without archiving them.
  - Messages already in the index stay readable there.
  - Messages that are fetched again later and need that key (an edit, or a full resync) are stored as
    `room-key-missing` (or `no-room-key` when the subscription then holds no key at all). Stored undecryptable
    messages are retried locally whenever the room's keyring changes, so they become readable again once a
    matching key is offered.
- **Every process start costs one PBKDF2 run** (100 000 iterations for v2 backups) and the RSA unwraps of the room
  keys in use. Nothing makes this cheaper by caching keys on disk.
- **New endpoints are a deliberate change.** Adding one means adding it to `ENDPOINTS` with a schema, after checking
  in the Rocket.Chat source that the `GET` has no side effects.
