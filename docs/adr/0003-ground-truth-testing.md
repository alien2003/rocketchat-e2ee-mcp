# ADR 0003: Ground-truth testing against the real web client

- Status: accepted
- Date: 2026-10-15
- Refines: ADR 0001 §10

## Context

rc-mcp re-implements the decrypt side of Rocket.Chat's E2EE. There is no normative specification:

- the public specification page disagrees with the 8.9.0 source on several points
  ([e2ee-protocol.md §11](../e2ee-protocol.md#11-discrepancies-with-public-docs));
- formats changed silently between releases (PR #36942 introduced `rc.v2.aes-sha2` and v2 private-key backups
  without a changelog entry).

A test that encrypts with our own code and decrypts with our own code is **circular**. It passes whenever our two
halves agree, even if both disagree with Rocket.Chat. The same applies to fixtures that we hand-craft from our
reading of the source. Only artifacts produced by Rocket.Chat's own code prove compatibility.

Three facts make such artifacts practical:

- the official web client runs in a browser;
- a disposable Rocket.Chat 8.9.0 + MongoDB stack runs locally (`docker/compose.yaml`);
- Rocket.Chat's own repository ships test vectors for the legacy formats that current clients no longer write.

## Decision

1. **Capture ground truth by driving the real web client.** `scripts/generate-fixtures.ts` uses Playwright with
   headless Chromium (`@playwright/test`). It follows the selectors of Rocket.Chat's own e2e page objects at the
   pinned tag. Run it with `mise run fixtures:generate`. The scenario:
   1. alice, bob and the admin log in, and the client generates their keys. The E2EE passphrase is read from the
      "Save your new E2EE password" modal.
   2. alice creates an encrypted private group with bob through the UI, and an encrypted DM with bob.
   3. Messages: plain text, a long multi-paragraph Unicode text, Markdown, a thread reply, an edit, a quote, and text
      and image uploads.
   4. alice and bob go offline. The admin is invited without a room key (`WAITING_KEYS`) and resets the room key from
      the room's "Disable E2E encryption" dialog ("Reset encryption keys").
   5. alice and bob come back and receive the new key. More messages follow, including a post-reset thread reply
      and an upload.
   6. Dump, per user: the REST responses, the MongoDB documents (canonical Extended JSON), the encrypted file bytes,
      the exact typed plaintext, and what the real client rendered in each phase.
2. **Assert against what was typed and what the client showed.** `test/support/fixture-suite.ts` checks:
   - the captured passphrases unlock the stored private keys (format v2), and a wrong passphrase is reported as
     `wrong-password`;
   - members hold the post-reset key as current and the pre-reset key in `oldRoomKeys`;
   - every message decrypts to exactly the typed text for each user who can read it. Users who cannot read it get
     the explicit `room-key-missing` reason;
   - the raw MongoDB document of each message decrypts to the same result as its REST copy;
   - uploads decrypt byte for byte with SHA-256 verified, and upload records decrypt to the real name and type;
   - our output matches the real client's rendering, failures included: the admin's client shows
     "cannot be decrypted due to incorrect encryption key" for pre-reset messages.
3. **No circular crypto tests.** Nothing in `test/` encrypts with rc-mcp code to prove compatibility. Negative
   tests corrupt captured data:
   - flip ciphertext bits (AES-GCM authentication fails);
   - flip file bytes (SHA-256 mismatch);
   - present bob's wrapped key to alice;
   - present a captured key as `E2ESuggestedKey`.

   See `test/unit/e2ee/failure-modes.test.ts`.
4. **Legacy formats from upstream vectors.** `scripts/extract-upstream-vectors.ts` copies public test vectors (MIT)
   from `apps/meteor/tests/e2e/fixtures/userStates.ts` and `apps/meteor/tests/e2e/e2e-encryption/e2ee-legacy-format.spec.ts`
   at the pinned tag into `test/fixtures/upstream/legacy-v1.json`. They contain:
   - a v1 `$binary` private key;
   - a 12-character key id (`32c9e7917b78`) with an A128CBC room key;
   - a bare `msg` payload whose plaintext uses `text`.

   `test/unit/e2ee/upstream-legacy.test.ts` checks them.
5. **Three layers.**
   - **Unit** (offline, every commit): runs the suite on the committed capture.
   - **Integration:** runs rc-mcp's real REST client and the real `rc-mcp serve` against the stack, as alice, bob,
     carol and the admin (`rcadmin`). It reuses the keys and messages of the last ground-truth run, so it needs
     `mise run test:ground-truth` (or `fixtures:generate`) once after `mise run rc:up`.
   - **Ground truth:** `mise run test:ground-truth` makes a fresh capture into `.local/ground-truth/$RC_VERSION`
     and runs the same suite on it, so the committed fixtures can be re-proven at any time.

### What is committed

| Path | Content |
| --- | --- |
| `test/fixtures/8.9.0/README.md` | Written by the generator: the layout below and the notice that the data is throwaway test data |
| `test/fixtures/8.9.0/expected.json` | Run metadata, user ids and captured passphrases, room ids, key ids before and after the reset, every typed message (label, sender, phase, id, thread, exact text, original text of the edit, quoted message, file), and the text the real client rendered, per user and phase |
| `test/fixtures/8.9.0/rest/<user>/` | Raw REST responses for alice, bob and the admin: `me`, `e2e.fetchMyKeys`, `subscriptions.getOne`, room info, history, `chat.syncMessages`, file listings; plus thread endpoints and `chat.getMessage` for alice |
| `test/fixtures/8.9.0/mongo/` | `rocketchat_message`, `rocketchat_subscription`, `rocketchat_room`, `rocketchat_uploads`, and `users` (projected to `_id`, `username`, `name`, `e2e`) |
| `test/fixtures/8.9.0/files/<id>.bin` | Encrypted upload bytes as served |
| `test/fixtures/8.9.0/plain/` | The original files that were uploaded |
| `test/fixtures/upstream/legacy-v1.json` | Upstream legacy vectors, with their source files and tag |

The fixture data is **throwaway**:

- The passphrases, key pairs and room keys exist only in the disposable local stack. They protect only the
  synthetic messages listed in `expected.json` (see its `note`).
- No access tokens are stored. `me.json` is reduced to `_id`, `username` and `name`.
- The generator writes `README.md` into its output directory (`scripts/generate-fixtures.ts`). The committed
  capture is regenerated from a fresh stack so that it includes this file.
- Fresh captures (`.local/ground-truth/`), screenshots and the stack's credentials stay under the gitignored
  `.local/`.

## Consequences

- **Every supported-version claim is backed by a capture of that version.** A new Rocket.Chat release means:
  set `RC_VERSION`, run `mise run rc:down && mise run rc:up && mise run fixtures:generate`, run the tests, and diff
  `apps/meteor/client/lib/e2ee` between the tags.
- **The generator depends on the web UI.** Selectors follow upstream page objects but can break with UI changes.
  That breakage is acceptable: it happens in tooling, not in the product.
- **The compose stack runs with the REST rate limiter off** (`OVERWRITE_SETTING_API_Enable_Rate_Limiter: "false"`).
  All Playwright browsers share 127.0.0.1, and the default limit of 10 calls per minute per IP and route would
  throttle them. The integration layer enables the limiter at runtime to test rc-mcp's 429 handling. Observed on
  8.9.0: on the first boot of a fresh database no REST route gets a limiter rule (the API class reads the default
  limits before the settings exist), so the test restarts the disposable Rocket.Chat container once when enabling
  the limiter produces no `X-RateLimit-*` headers.
- **Some formats have no captured artifact yet:** `rc.v1.aes-sha2` as a `content` object, `rc.v2` with an A128CBC
  key, encrypted pins, `t: 'rm'` tombstones, `removed-file` attachments, `suggestedOldRoomKeys`. Their handling is
  ported from source only (the `suggestedOldRoomKeys` path is unit-tested by presenting captured `oldRoomKeys` in
  that field) and is listed as such in
  [e2ee-protocol.md §13](../e2ee-protocol.md#13-how-this-is-verified).
- **Committed fixtures contain real-format key material** (stored private keys, wrapped room keys and their
  passphrases). Secret scanners may flag them. They are labelled as test data in `expected.json` and in the
  generated README.
