# Ground-truth fixtures — Rocket.Chat 8.9.0

**Throwaway test data.** Produced by `scripts/generate-fixtures.ts` driving the real Rocket.Chat web client
against the disposable local Docker stack (`docker/compose.yaml`). The E2EE passphrases, key pairs and room
keys in here exist only in that stack and protect only the synthetic messages listed in `expected.json`.
No access tokens are stored. Regenerate with `mise run fixtures:generate`.

- `expected.json` — what was typed (exact plaintext), message ids, key ids before/after the room key reset,
  captured passphrases, and what the real client rendered per phase.
- `rest/<user>/` — raw REST responses as each user (e2e.fetchMyKeys, subscriptions, history, sync, files).
- `mongo/` — raw MongoDB documents (canonical Extended JSON).
- `files/<id>.bin` — encrypted upload bytes as served; `plain/` — the original files.
