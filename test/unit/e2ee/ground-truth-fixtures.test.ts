/**
 * Offline layer: decrypt the committed fixtures that the real Rocket.Chat web client produced
 * (one directory per supported Rocket.Chat version under test/fixtures/).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFixtureSuite, hasFixtures } from '../../support/fixture-suite.ts';
import { REPO_ROOT } from '../../support/stack.ts';

const FIXTURES = join(REPO_ROOT, 'test', 'fixtures');
const versions = readdirSync(FIXTURES).filter((d) => /^\d+\.\d+\.\d+$/.test(d) && hasFixtures(join(FIXTURES, d)));

describe('committed ground-truth fixtures', () => {
  it('exist for the pinned Rocket.Chat version', () => {
    expect(versions).toContain(process.env.RC_VERSION ?? '8.9.0');
  });
});

for (const version of versions) {
  describeFixtureSuite(join(FIXTURES, version));
}
