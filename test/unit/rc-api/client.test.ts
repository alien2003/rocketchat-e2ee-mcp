import { describe, expect, it } from 'vitest';
import { RcClient } from '../../../src/rc-api/client.ts';
import { RcApiError } from '../../../src/rc-api/errors.ts';
import { ENDPOINTS, FORBIDDEN_ENDPOINTS } from '../../../src/rc-api/schemas.ts';

const TOKEN = 'pat-token-SECRET-123456';

interface Call {
  url: string;
  init: RequestInit;
}

function harness(responses: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error('no more mock responses');
    return next(call);
  }) as typeof fetch;
  const client = new RcClient({
    url: 'https://chat.example.test/',
    userId: 'u1',
    authToken: TOKEN,
    fetch: fetchMock,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    maxRetries: 3,
  });
  return { client, calls, sleeps, advance: (ms: number) => (clock += ms), now: () => clock };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('RcClient', () => {
  it('sends PAT headers with GET only and serialises query params', async () => {
    const h = harness([() => json({ _id: 'u1', username: 'alice', success: true })]);
    const me = await h.client.get('me');
    expect(me.username).toBe('alice');
    const call = h.calls[0];
    expect(call?.url).toBe('https://chat.example.test/api/v1/me');
    expect(call?.init.method).toBe('GET');
    expect(call?.init.headers).toMatchObject({ 'x-user-id': 'u1', 'x-auth-token': TOKEN });
    expect(call?.init.body).toBeUndefined();

    const h2 = harness([() => json({ messages: [], cursor: { next: null, previous: null } })]);
    await h2.client.get('rooms.history', { roomId: 'r1', count: 100, previous: '123', skip: undefined });
    expect(h2.calls[0]?.url).toBe('https://chat.example.test/api/v1/rooms.history?roomId=r1&count=100&previous=123');
  });

  // All harnesses start their fake clock at the same instant, so reset times can be computed up front.
  const T0 = 1_000_000;

  it('honours 429 using X-RateLimit-Reset (absolute epoch ms) and retries', async () => {
    const h = harness([
      () =>
        json({ success: false }, 429, {
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(T0 + 7000),
        }),
      () => json({ _id: 'u1', username: 'alice' }),
    ]);
    const me = await h.client.get('me');
    expect(me._id).toBe('u1');
    expect(h.calls).toHaveLength(2);
    const waited = h.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(7000);
    expect(waited).toBeLessThan(8000);
  });

  it('pauses a route proactively when X-RateLimit-Remaining hits 0', async () => {
    const h = harness([
      () => json({ _id: 'u1' }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(T0 + 5000) }),
      () => json({ _id: 'u1' }),
    ]);
    await h.client.get('me');
    expect(h.sleeps).toEqual([]);
    await h.client.get('me');
    expect(h.sleeps.length).toBe(1);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(4900);
  });

  it('gives up with rate-limited when the wait exceeds the cap', async () => {
    const h = harness([() => json({ success: false }, 429, { 'x-ratelimit-reset': String(T0 + 10 * 60_000) })]);
    await expect(h.client.get('me')).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
  });

  it('maps 401 to a typed error whose message never contains the token', async () => {
    const h = harness([() => json({ success: false, error: `You must be logged in ${TOKEN}` }, 401)]);
    const error = await h.client.get('me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RcApiError);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(JSON.stringify((error as RcApiError).toJSON())).not.toContain(TOKEN);
  });

  it('maps success:false bodies and errorType', async () => {
    const h = harness([() => json({ success: false, errorType: 'error-room-not-found', error: 'x' }, 400)]);
    await expect(h.client.get('rooms.info', { roomId: 'nope' })).rejects.toMatchObject({
      code: 'bad-request',
      rcError: 'error-room-not-found',
    });
  });

  it('explains totp-required errors', async () => {
    const h = harness([() => json({ success: false, errorType: 'totp-required' }, 400)]);
    await expect(h.client.get('me')).rejects.toThrow(/Ignore Two Factor Authentication/);
  });

  it('rejects responses that do not match the schema', async () => {
    const h = harness([() => json({ messages: 'nope' })]);
    await expect(h.client.get('rooms.history', { roomId: 'r' })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('retries 5xx and network errors, then fails with a typed error', async () => {
    const h = harness([
      () => json({}, 502),
      () => {
        throw new TypeError('fetch failed');
      },
      () => json({ _id: 'u1' }),
    ]);
    await expect(h.client.get('me')).resolves.toMatchObject({ _id: 'u1' });
    const h2 = harness(
      Array.from({ length: 4 }, () => () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(h2.client.get('me')).rejects.toMatchObject({ code: 'network' });
  });

  it('only exposes allowlisted endpoints and refuses DM-creating im.* calls', async () => {
    const h = harness([]);
    await expect(h.client.get('logout' as never)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(h.client.get('im.files', { username: 'bob' })).rejects.toThrow(/existing DM/);
    for (const forbidden of Object.keys(FORBIDDEN_ENDPOINTS)) {
      expect(Object.keys(ENDPOINTS)).not.toContain(forbidden);
    }
    expect(h.calls).toHaveLength(0);
    // The class has no way to issue anything but GET.
    const proto = Object.getOwnPropertyNames(RcClient.prototype);
    expect(proto.filter((m) => /^(post|put|patch|delete)/i.test(m))).toEqual([]);
  });

  it('downloads uploads with credentials only on the Rocket.Chat origin', async () => {
    const h = harness([
      () => new Response(null, { status: 302, headers: { location: 'https://bucket.s3.example/obj?sig=1' } }),
      () => new Response(new Uint8Array([1, 2, 3])),
    ]);
    const out = await h.client.download('/file-upload/abc/0123abcd');
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(h.calls[0]?.init.headers).toMatchObject({ 'x-auth-token': TOKEN });
    expect(JSON.stringify(h.calls[1]?.init.headers)).not.toContain(TOKEN);
    await expect(h.client.download('/api/v1/logout')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(h.client.download('/file-upload/../api')).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('enforces the download size limit', async () => {
    const h = harness([() => new Response(new Uint8Array(10), { headers: { 'content-length': '10' } })]);
    await expect(h.client.download('/file-upload/a/b', 5)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('records the server clock from the Date header', async () => {
    const h = harness([() => json({ _id: 'u1' }, 200, { date: 'Thu, 15 Oct 2026 20:00:00 GMT' })]);
    await h.client.get('me');
    expect(h.client.serverNow).toBe(Date.parse('2026-10-15T20:00:00Z'));
  });
});
