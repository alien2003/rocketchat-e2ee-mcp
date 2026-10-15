/**
 * Extracts the legacy-format (v1) E2EE test vectors that ship with Rocket.Chat's own Playwright suite, so our
 * decoder for formats that current clients no longer produce is still checked against real upstream data.
 *
 * Source (MIT, Rocket.Chat): apps/meteor/tests/e2e/fixtures/userStates.ts and
 * apps/meteor/tests/e2e/e2e-encryption/e2ee-legacy-format.spec.ts at the pinned tag, read from the shallow
 * clone in .local/rocket.chat (see CONTRIBUTING.md).
 *
 * Usage: node scripts/extract-upstream-vectors.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../test/support/stack.ts';

const RC = join(REPO_ROOT, '.local', 'rocket.chat', 'apps', 'meteor', 'tests', 'e2e');
const tag = process.env.RC_VERSION ?? 'unknown';

function grab(source: string, pattern: RegExp, what: string): string {
  const m = source.match(pattern);
  if (!m?.[1]) throw new Error(`could not find ${what}`);
  return m[1];
}

const userStates = readFileSync(join(RC, 'fixtures', 'userStates.ts'), 'utf8');
const legacySpec = readFileSync(join(RC, 'e2e-encryption', 'e2ee-legacy-format.spec.ts'), 'utf8');

const serverPrivateKey = grab(userStates, /server:\s*{\s*private_key:\s*'([^']+)'/s, 'server private_key');
const serverPublicKey = grab(userStates, /public_key:\s*'([^']+)'/s, 'server public_key');
const clientPrivateKey = grab(userStates, /client:\s*{\s*private_key:\s*'([^']+)'/s, 'client private_key');
const e2ePassword = grab(userStates, /e2ePassword:\s*'([^']+)'/, 'e2ePassword');
const kid = grab(legacySpec, /const kid = '([^']+)'/, 'kid');
const encryptedKey = grab(legacySpec, /const encryptedKey =\s*'([^']+)'/s, 'encryptedKey');
const encryptedMessage = grab(legacySpec, /const encryptedMessage =\s*'([^']+)'/s, 'encryptedMessage');
const expectedText = grab(legacySpec, /toHaveText\('([^']+)'\)/, 'expected text');

const out = {
  note: 'Public TEST vectors copied from Rocket.Chat (MIT) test fixtures. Not secrets.',
  source: {
    repository: 'https://github.com/RocketChat/Rocket.Chat',
    tag,
    files: [
      'apps/meteor/tests/e2e/fixtures/userStates.ts',
      'apps/meteor/tests/e2e/e2e-encryption/e2ee-legacy-format.spec.ts',
    ],
  },
  user: {
    // generateContext('userE2EE') uses the username as _id, which is the v1 PBKDF2 salt.
    userId: 'userE2EE',
    e2ePassword,
    storedPrivateKey: serverPrivateKey,
    publicKey: serverPublicKey,
    decryptedPrivateKeyJwk: clientPrivateKey,
  },
  room: {
    e2eKey: kid + encryptedKey,
    kid,
  },
  message: {
    // Legacy layout: the whole payload lives in `msg` (no `content` field).
    msg: kid + encryptedMessage,
    expectedText,
  },
};

const target = join(REPO_ROOT, 'test', 'fixtures', 'upstream', 'legacy-v1.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.error(`wrote ${target}`);
