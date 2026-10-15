/**
 * Writes rc-mcp config files (mode 0600) for the throwaway users of the local compose stack:
 *   .local/stack-<user>.config.json   -> use with RC_MCP_CONFIG=.local/stack-alice.config.json rc-mcp doctor
 * Only for the local Docker stack; never put real credentials in the repository.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, requireStack } from '../test/support/stack.ts';

const stack = requireStack();
for (const who of ['alice', 'bob', 'carol'] as const) {
  const user = stack.users[who];
  const file = join(REPO_ROOT, '.local', `stack-${who}.config.json`);
  const config = {
    url: stack.url,
    userId: user.userId,
    authToken: user.pat,
    ...(user.e2eePassword ? { e2eePassword: user.e2eePassword } : {}),
    dataDir: join(REPO_ROOT, '.local', `dev-data-${who}`),
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.error(`wrote ${file}`);
}
