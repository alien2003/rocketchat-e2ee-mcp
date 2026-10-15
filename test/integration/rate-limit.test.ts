/**
 * Integration: Rocket.Chat's real REST rate limiter (disabled in the compose stack so the web client used for
 * fixtures is not throttled; switched on here at runtime).
 *
 * Observed on 8.9.0: on the very first boot of a fresh database no REST route gets a limiter rule (ApiClass reads
 * the default limits when the module loads, before the settings exist), so enabling the limiter has no effect
 * until the server restarts. The test restarts the disposable container once when it detects that state.
 * It uses rooms.history (explicit limit: 20 calls / 10 s per IP) on the default #general channel (id GENERAL).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RcClient } from '../../src/rc-api/client.ts';
import { api, waitForServer } from '../support/bootstrap.ts';
import { REPO_ROOT } from '../support/stack.ts';
import { credentials, stackOrSkip } from './helpers.ts';

const { stack } = stackOrSkip();
const admin = { userId: stack.admin.userId, authToken: stack.admin.authToken };
const carol = credentials(stack, 'carol');
const setLimiter = (value: boolean) => api('settings/API_Enable_Rate_Limiter', { auth: admin, body: { value } });
const ROOM = 'GENERAL';

async function limiterActive(): Promise<boolean> {
  const res = await fetch(`${stack.url}/api/v1/rooms.history?roomId=${ROOM}&count=1`, {
    headers: { 'x-user-id': carol.userId, 'x-auth-token': carol.authToken },
  });
  await res.body?.cancel();
  return res.headers.has('x-ratelimit-limit');
}

beforeAll(async () => {
  await setLimiter(true);
  await new Promise((r) => setTimeout(r, 1000));
  if (!(await limiterActive())) {
    const res = spawnSync(join(REPO_ROOT, 'scripts', 'compose.sh'), ['restart', 'rocketchat'], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`could not restart Rocket.Chat: ${res.stderr}`);
    await waitForServer();
    await new Promise((r) => setTimeout(r, 3000));
    if (!(await limiterActive())) throw new Error('REST rate limiter still inactive after a restart');
  }
  // Start from a fresh window.
  await new Promise((r) => setTimeout(r, 11_000));
}, 300_000);
afterAll(async () => {
  await setLimiter(false);
});

describe('REST rate limiting (non-admin token)', () => {
  it('fails fast with a typed rate-limited error when the wait would exceed the configured cap', async () => {
    const impatient = new RcClient({
      url: stack.url,
      userId: carol.userId,
      authToken: carol.authToken,
      maxRateLimitWaitMs: 500,
    });
    let error: unknown;
    for (let i = 0; i < 30 && !error; i++) {
      error = await impatient.get('rooms.history', { roomId: ROOM, count: 1 }).then(
        () => undefined,
        (e: unknown) => e,
      );
    }
    expect(error).toMatchObject({ code: 'rate-limited' });
    expect(String((error as Error).message)).toMatch(/retry after \d+s/);
  });

  it('waits for X-RateLimit-Reset and then succeeds', async () => {
    // Let the window used by the previous test expire.
    await new Promise((r) => setTimeout(r, 11_000));
    const patient = new RcClient({ url: stack.url, userId: carol.userId, authToken: carol.authToken });
    const started = Date.now();
    for (let i = 0; i < 25; i++) {
      const res = await patient.get('rooms.history', { roomId: ROOM, count: 1 });
      expect(Array.isArray(res.messages)).toBe(true);
    }
    // 20 calls fit in a 10 s window; the rest had to wait for the reset reported in X-RateLimit-Reset.
    expect(Date.now() - started).toBeGreaterThan(3000);
  }, 120_000);
});
