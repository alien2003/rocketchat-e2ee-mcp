/**
 * Shared helpers for integration tests against the compose stack (`mise run rc:up`, then
 * `mise run test:ground-truth` or `fixtures:generate` so the users have real E2EE keys and data).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '../../src/app.ts';
import type { Config } from '../../src/config.ts';
import { RcClient } from '../../src/rc-api/client.ts';
import type { FixtureExpected } from '../support/fake-rc.ts';
import { readStack, type StackState } from '../support/stack.ts';

export function stackOrSkip(): { stack: StackState; expected: FixtureExpected } {
  const stack = readStack();
  if (!stack?.groundTruth) {
    throw new Error(
      'No ground-truth run recorded in .local/stack.json. Run `mise run rc:up && mise run test:ground-truth` first.',
    );
  }
  const expected = JSON.parse(
    readFileSync(join(stack.groundTruth.fixtureDir, 'expected.json'), 'utf8'),
  ) as FixtureExpected;
  return { stack, expected };
}

export type StackWho = 'alice' | 'bob' | 'carol' | 'admin';

export function credentials(stack: StackState, who: StackWho, expected?: FixtureExpected) {
  if (who === 'admin') {
    return {
      userId: stack.admin.userId,
      authToken: stack.admin.authToken,
      e2eePassword: expected?.users.admin.e2eePassword ?? stack.admin.e2eePassword,
    };
  }
  const u = stack.users[who];
  return { userId: u.userId, authToken: u.pat, e2eePassword: u.e2eePassword };
}

export function clientFor(stack: StackState, who: StackWho): RcClient {
  const c = credentials(stack, who);
  return new RcClient({ url: stack.url, userId: c.userId, authToken: c.authToken });
}

export function appFor(
  stack: StackState,
  who: StackWho,
  expected?: FixtureExpected,
  overrides: Partial<Config> = {},
): App {
  const c = credentials(stack, who, expected);
  const config: Config = {
    url: stack.url,
    userId: c.userId,
    authToken: c.authToken,
    e2eePassword: c.e2eePassword,
    dataDir: '/nonexistent',
    ephemeral: true,
    logLevel: 'silent',
    configFile: undefined,
    ...overrides,
  };
  return new App({ config });
}
