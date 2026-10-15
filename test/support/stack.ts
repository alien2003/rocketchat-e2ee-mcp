/**
 * Shared description of the local compose test stack (throwaway credentials only).
 * Written by scripts/rc-bootstrap.ts and scripts/generate-fixtures.ts into .local/stack.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STACK_FILE = join(REPO_ROOT, '.local', 'stack.json');

export interface StackUser {
  username: string;
  name: string;
  email: string;
  password: string;
  userId: string;
  /** Personal access token (throwaway, local stack only). */
  pat: string;
  /** E2EE password captured from the web client's "Save your encryption password" modal. */
  e2eePassword?: string;
}

export interface StackState {
  url: string;
  rcVersion: string;
  admin: { username: string; password: string; userId: string; authToken: string; e2eePassword?: string };
  users: Record<'alice' | 'bob' | 'carol', StackUser>;
  /** Filled in by the ground-truth generator. */
  groundTruth?: {
    runId: string;
    fixtureDir: string;
    groupRoomId: string;
    groupName: string;
    dmRoomId: string;
  };
}

export const TEST_USERS = {
  alice: { username: 'alice', name: 'Alice Anders', email: 'alice@example.test', password: 'throwaway-Alice-pass-1' },
  bob: { username: 'bob', name: 'Bob Brown', email: 'bob@example.test', password: 'throwaway-Bob-pass-1' },
  carol: { username: 'carol', name: 'Carol Chen', email: 'carol@example.test', password: 'throwaway-Carol-pass-1' },
} as const;

export function readStack(): StackState | undefined {
  if (!existsSync(STACK_FILE)) return undefined;
  return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as StackState;
}

export function requireStack(): StackState {
  const stack = readStack();
  if (!stack) {
    throw new Error(`No ${STACK_FILE}. Run \`mise run rc:up\` first.`);
  }
  return stack;
}
