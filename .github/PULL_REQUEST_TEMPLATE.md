## What and why

<!-- What does this change, and why? Link related issues (e.g. "Fixes #123"). -->

## How it was tested

<!-- Commands you ran and anything you checked by hand. For changes to the REST client, sync or E2EE code,
say whether you ran the stack-backed suites (`mise run rc:up`, `mise run test:ground-truth`,
`mise run test:integration`, then `mise run rc:down`). -->

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`).
- [ ] `mise run lint` and `mise run typecheck` pass.
- [ ] `mise run test` passes, and new or changed behaviour has unit tests.
- [ ] No circular crypto tests: no test encrypts with rc-mcp's own code to prove that rc-mcp decrypts correctly. Ciphertext comes from the real-client fixtures in `test/fixtures/<version>/` or Rocket.Chat's own vectors in `test/fixtures/upstream/`.
- [ ] No secrets or private data anywhere: no real tokens, passwords, keys, server URLs or chat content in code, fixtures, logs, screenshots or this description (placeholders and the throwaway compose-stack values only).
- [ ] Still read-only: no new Rocket.Chat endpoint that changes server state.
- [ ] Nothing new is written to stdout by `rc-mcp serve` (logs go to stderr).
- [ ] Docs are updated where behaviour, configuration, tools or CLI flags changed.
