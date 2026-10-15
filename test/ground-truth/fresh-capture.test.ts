/**
 * Ground-truth layer: decrypt a capture produced minutes ago by `scripts/generate-fixtures.ts` driving the real
 * web client of the running compose stack (`mise run test:ground-truth` does both steps).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFixtureSuite, hasFixtures } from '../support/fixture-suite.ts';
import { REPO_ROOT } from '../support/stack.ts';

const dir = join(REPO_ROOT, '.local', 'ground-truth', process.env.RC_VERSION ?? '8.9.0');

describe('fresh real-client capture', () => {
  it(`exists in ${dir}`, () => {
    expect(hasFixtures(dir)).toBe(true);
  });
});

if (hasFixtures(dir)) describeFixtureSuite(dir);
