/**
 * Integration: Rocket.Chat's real REST rate limiter (disabled in the compose stack so the web client used for
 * fixtures is not throttled; switched on here at runtime). Observed on 8.9.0: enabling it at runtime works, but
 * the per-route default (10 calls / 60 s, keyed by client IP + route) only changes after a restart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RcClient } from '../../src/rc-api/client.ts';
import { api } from '../support/bootstrap.ts';
import { credentials, stackOrSkip } from './helpers.ts';

const { stack } = stackOrSkip();
const admin = { userId: stack.admin.userId, authToken: stack.admin.authToken };
const carol = credentials(stack, 'carol');
const setLimiter = (value: boolean) => api('settings/API_Enable_Rate_Limiter', { auth: admin, body: { value } });

beforeAll(async () => {
  await setLimiter(true);
  await new Promise((r) => setTimeout(r, 1000));
});
afterAll(async () => {
  await setLimiter(false);
});

describe('REST rate limiting (non-admin token)', () => {
  it('fails fast with a typed rate-limited error when the wait would exceed the configured cap', async () => {
    const impatient = new RcClient({
      url: stack.url,
      userId: carol.userId,
      authToken: carol.authToken,
      maxRateLimitWaitMs: 1000,
    });
    let error: unknown;
    for (let i = 0; i < 15 && !error; i++) {
      error = await impatient.get('me').then(
        () => undefined,
        (e: unknown) => e,
      );
    }
    expect(error).toMatchObject({ code: 'rate-limited' });
    expect(String((error as Error).message)).toMatch(/retry after \d+s/);
  });

  it('waits for X-RateLimit-Reset and then succeeds', async () => {
    const patient = new RcClient({ url: stack.url, userId: carol.userId, authToken: carol.authToken });
    const started = Date.now();
    for (let i = 0; i < 11; i++) {
      const res = await patient.get('users.info', { username: 'carol' });
      expect(res.user.username).toBe('carol');
    }
    // 10 calls fit in the window; the 11th had to wait for the window to reset.
    expect(Date.now() - started).toBeGreaterThan(5000);
  }, 120_000);
});
