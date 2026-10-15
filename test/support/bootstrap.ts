/**
 * Non-interactive bootstrap of the local compose stack (throwaway credentials only):
 *   1. waits until Rocket.Chat answers /api/info and the REST login route,
 *   2. logs in as the env-provisioned admin,
 *   3. ensures the test users exist and have a personal access token,
 *   4. writes everything to .local/stack.json (gitignored, mode 0600).
 *
 * Idempotent: re-running keeps users and regenerates their tokens.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readStack, STACK_FILE, type StackState, type StackUser, TEST_USERS } from './stack.ts';

export const STACK_URL = process.env.RC_TEST_URL ?? `http://localhost:${process.env.RC_PORT ?? '3000'}`;
export const ADMIN = { username: 'rcadmin', password: process.env.RC_ADMIN_PASS ?? 'throwaway-Admin-pass-1' };
const TOKEN_NAME = 'rc-mcp-tests';

export type Json = Record<string, unknown>;
export interface Session {
  userId: string;
  authToken: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: Json;
  constructor(message: string, status: number, body: Json) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Minimal REST helper for test tooling (the product uses src/rc-api). Retries on 429. */
export async function api(path: string, init: { method?: string; body?: unknown; auth?: Session } = {}): Promise<Json> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.auth) {
    headers['x-user-id'] = init.auth.userId;
    headers['x-auth-token'] = init.auth.authToken;
  }
  const method = init.method ?? (init.body ? 'POST' : 'GET');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${STACK_URL}/api/v1/${path}`, {
      method,
      headers,
      body: init.body ? JSON.stringify(init.body) : null,
    });
    if (res.status === 429 && attempt < 12) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const waitMs = Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() + 250 : 5000;
      console.error(`429 on ${path}, waiting ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 65_000)));
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || json.success === false) {
      throw new ApiError(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`, res.status, json);
    }
    return json;
  }
}

export async function waitForServer(timeoutMs = 600_000): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${STACK_URL}/api/info`);
      if (res.ok) {
        const info = (await res.json()) as { version?: string };
        // /api/info answers before the REST login route is ready on a cold start.
        const login = await fetch(`${STACK_URL}/api/v1/login`, { method: 'POST', body: '{}' });
        if (login.status !== 404 && login.status < 500) return info.version ?? 'unknown';
      }
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Rocket.Chat at ${STACK_URL} not ready after ${timeoutMs / 1000}s (${last})`);
}

export async function login(user: string, password: string): Promise<Session> {
  const res = await api('login', { body: { user, password } });
  const data = res.data as Session;
  return { userId: data.userId, authToken: data.authToken };
}

async function ensureUser(admin: Session, key: keyof typeof TEST_USERS): Promise<StackUser> {
  const spec = TEST_USERS[key];
  try {
    await api(`users.info?username=${encodeURIComponent(spec.username)}`, { auth: admin });
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 404)) throw error;
    await api('users.create', {
      auth: admin,
      body: {
        username: spec.username,
        name: spec.name,
        email: spec.email,
        password: spec.password,
        verified: true,
        joinDefaultChannels: true,
        requirePasswordChange: false,
        sendWelcomeEmail: false,
        roles: ['user'],
      },
    });
    console.error(`created user ${spec.username}`);
  }
  const session = await login(spec.username, spec.password);
  let token: string;
  try {
    const res = await api('users.generatePersonalAccessToken', {
      auth: session,
      body: { tokenName: TOKEN_NAME, bypassTwoFactor: true },
    });
    token = res.token as string;
  } catch {
    const res = await api('users.regeneratePersonalAccessToken', { auth: session, body: { tokenName: TOKEN_NAME } });
    token = res.token as string;
  }
  return { ...spec, userId: session.userId, pat: token };
}

export function writeStack(state: StackState): void {
  mkdirSync(dirname(STACK_FILE), { recursive: true });
  writeFileSync(STACK_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function bootstrapStack(): Promise<StackState> {
  const version = await waitForServer();
  console.error(`Rocket.Chat ${version} is up at ${STACK_URL}`);
  const admin = await login(ADMIN.username, ADMIN.password);
  const previous = readStack();
  const users = {
    alice: await ensureUser(admin, 'alice'),
    bob: await ensureUser(admin, 'bob'),
    carol: await ensureUser(admin, 'carol'),
  };
  // Keep E2EE passwords captured by an earlier fixture run against this same stack.
  for (const key of ['alice', 'bob', 'carol'] as const) {
    const prev = previous?.users?.[key];
    if (prev?.e2eePassword && prev.userId === users[key].userId) users[key].e2eePassword = prev.e2eePassword;
  }
  const sameStack = previous?.users?.alice?.userId === users.alice.userId;
  const state: StackState = {
    url: STACK_URL,
    rcVersion: version,
    admin: {
      ...ADMIN,
      ...admin,
      ...(sameStack && previous?.admin.e2eePassword ? { e2eePassword: previous.admin.e2eePassword } : {}),
    },
    users,
    ...(sameStack && previous?.groundTruth ? { groundTruth: previous.groundTruth } : {}),
  };
  writeStack(state);
  console.error(`wrote ${STACK_FILE} (users: ${Object.keys(users).join(', ')})`);
  return state;
}
