/**
 * Ground-truth fixture generator.
 *
 * Drives the REAL Rocket.Chat web client (Playwright + headless Chromium) against the local compose stack so
 * that every cryptographic artifact (RSA key pairs, the 12-word E2EE passphrase, the encrypted private key,
 * room keys, message ciphertexts, encrypted uploads, the room-key reset) is produced by Rocket.Chat's own
 * client code. Our decryptor is then tested against these artifacts; nothing here encrypts anything itself.
 *
 * Scenario (selectors follow apps/meteor/tests/e2e page objects at the pinned tag):
 *   1. alice, bob and the workspace admin log in; the client generates keys; we read the passphrase from the
 *      "Save your new E2EE password" modal.
 *   2. alice creates an encrypted private group with bob and an encrypted DM with bob.
 *   3. Messages: plain, long multi-paragraph, markdown, a thread reply, an edit, a quote, text + image uploads.
 *   4. alice and bob go offline; the admin is invited, has no room key (WAITING_KEYS) and resets the room key
 *      from the room's "Disable E2E encryption" dialog ("Reset encryption keys").
 *   5. alice and bob come back, receive the new key from the admin's client, and post more messages
 *      (incl. a post-reset thread reply and upload).
 *   6. Dump raw REST responses, MongoDB documents and encrypted file bytes + the expected plaintext and what the
 *      real client rendered.
 *
 * Usage: node scripts/generate-fixtures.ts --out test/fixtures/8.9.0 [--headed]
 * All credentials involved are throwaway values from the local Docker stack.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Browser, type BrowserContext, chromium, expect, type Page } from '@playwright/test';
import {
  ADMIN,
  ApiError,
  api,
  bootstrapStack,
  type Json,
  type Session,
  writeStack,
} from '../test/support/bootstrap.ts';
import { REPO_ROOT, type StackState } from '../test/support/stack.ts';

const outArg = process.argv.indexOf('--out');
const OUT = resolve(
  REPO_ROOT,
  outArg > 0 ? (process.argv[outArg + 1] ?? '') : `test/fixtures/${process.env.RC_VERSION}`,
);
const HEADED = process.argv.includes('--headed');
const SHOTS = join(REPO_ROOT, '.local', 'ground-truth-shots');
const RUN_ID = Date.now().toString(36);
const GROUP_NAME = `handbook-${RUN_ID}`;

type Who = 'alice' | 'bob' | 'admin';

interface ExpectedMessage {
  label: string;
  room: 'group' | 'dm';
  sender: Who;
  phase: 'pre-reset' | 'post-reset';
  msgId: string;
  tmidLabel?: string;
  tmid?: string;
  text: string;
  originalText?: string;
  quoteOfLabel?: string;
  file?: { name: string; type: string; contentFixture: string; description?: string };
}

const expected: ExpectedMessage[] = [];
/** What the real web client displayed: rendered[who][phase][messageId] = innerText of the message body. */
const rendered: Record<string, Record<string, Record<string, string>>> = { alice: {}, bob: {}, admin: {} };
let phase: 'pre-reset' | 'post-reset' = 'pre-reset';

function step(msg: string) {
  console.error(`[gt ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ----------------------------------------------------------------------------------------------- texts

const TEXT = {
  plain: 'Deploy runbook: run `make deploy` from the release branch, then check /healthz on every node.',
  long: [
    'Incident review — database failover (long message for fixture coverage).',
    '',
    ...Array.from(
      { length: 18 },
      (_, i) =>
        `${i + 1}. The primary lost quorum at 02:${String(10 + i).padStart(2, '0')} UTC; replica r${i % 3} took over after the election timeout. Action item: tune electionTimeoutMillis and document the manual step-down procedure in the ops handbook so the on-call engineer does not have to rediscover it.`,
    ),
    '',
    'Unicode check: Grüße, café, naïve, 日本語, emoji 🚀 — and quotes "double" & \'single\'.',
  ].join('\n'),
  markdown: [
    '## Onboarding checklist',
    '',
    '- **VPN**: request access in the IT portal',
    '- _Docs_: start with the [architecture wiki](https://wiki.example.test/arch)',
    '- `ssh-keygen -t ed25519` then upload the public key',
    '',
    '```',
    'pnpm install --frozen-lockfile',
    'pnpm test',
    '```',
  ].join('\n'),
  threadReply: 'Thread reply: remember to bump the version in package.json before `make deploy`.',
  editOriginal: 'Staging credentials rotate every Friday at 17:00.',
  editFinal: 'Staging credentials rotate every Monday at 09:00 (edited).',
  quoteComment: 'Agreed, this is the canonical runbook. Pin it?',
  fileDescription: 'Release checklist v2',
  dm1: 'DM: the on-call rota lives in the ops handbook, section 4.',
  dm2: 'Thanks! I will add the pager escalation policy there too.',
  dmFileDescription: 'escalation policy draft',
  postResetAdmin: 'Post-reset (admin): room key was rotated. Retro notes go in this room from now on.',
  postResetAlice: 'Post-reset (alice): confirming I can read the new key. Decision: freeze deploys on Fridays.',
  postResetThread: 'Post-reset thread reply (bob): version bump is now automated by CI.',
  postResetFileDescription: 'post-reset upload',
};

const FILES = {
  checklist: {
    name: 'release-checklist.md',
    type: 'text/markdown',
    content: '# Release checklist\n\n1. Freeze main\n2. Tag vX.Y.Z\n3. Run `make deploy`\n4. Announce in #releases\n',
  },
  diagram: { name: 'diagram.png', type: 'image/png' },
  escalation: {
    name: 'escalation-policy.txt',
    type: 'text/plain',
    content: 'Escalation: L1 on-call (15 min) -> L2 team lead (30 min) -> L3 head of infra.\n',
  },
  postReset: {
    name: 'post-reset-notes.txt',
    type: 'text/plain',
    content: 'Uploaded after the room key reset. Ünïcödé ✓\n',
  },
};

// 1x1 transparent PNG (bytes are irrelevant to crypto; the client encrypts whatever it uploads).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// ----------------------------------------------------------------------------------------------- helpers

function writeJson(rel: string, data: unknown) {
  const path = join(OUT, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function poll<T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for: ${label}${lastError ? ` (${String(lastError)})` : ''}`);
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${RUN_ID}-${name}.png`) }).catch(() => undefined);
}

interface Actor {
  who: Who;
  username: string;
  password: string;
  session: Session;
  context: BrowserContext;
  page: Page;
  e2eePassword?: string;
}

async function newActor(
  browser: Browser,
  who: Who,
  username: string,
  password: string,
  session: Session,
): Promise<Actor> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    baseURL: process.env.RC_TEST_URL ?? 'http://localhost:3000',
  });
  // Turn on the client's own E2EE debug logger (apps/meteor/client/lib/e2ee/logger.ts) for diagnostics.
  await context.addInitScript(() =>
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      'rc-config-debug-e2e',
      'true',
    ),
  );
  context.on('console', (m) => {
    consoleLogs.push(`${new Date().toISOString().slice(11, 23)} [${who}] ${m.type()}: ${m.text().slice(0, 500)}`);
  });
  const page = await context.newPage();
  return { who, username, password, session, context, page };
}

const consoleLogs: string[] = [];

function flushConsoleLogs() {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${RUN_ID}-console.log`), `${consoleLogs.join('\n')}\n`);
}

async function uiLogin(actor: Actor) {
  const { page } = actor;
  await page.goto('/home');
  const form = page.getByRole('form', { name: 'Login' });
  await form.getByRole('textbox', { name: /username/i }).fill(actor.username);
  await form.getByRole('textbox', { name: 'Password', exact: true }).fill(actor.password);
  await form.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create new' })).toBeVisible({ timeout: 60_000 });
  if (actor.who === 'admin') await dismissFingerprintPrompt(page, 10_000);
}

/** Admins may get the deployment-fingerprint prompt after the container is recreated (test stack only). */
async function dismissFingerprintPrompt(page: Page, waitMs: number) {
  const fingerprint = page.getByRole('dialog', { name: 'Unique ID change detected' });
  const shown = await fingerprint
    .waitFor({ state: 'visible', timeout: waitMs })
    .then(() => true)
    .catch(() => false);
  if (!shown) return;
  await fingerprint.getByRole('button', { name: 'Configuration update' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm configuration update' });
  await confirm.getByRole('button', { name: 'Confirm configuration update' }).click();
  await expect(confirm).not.toBeVisible({ timeout: 15_000 });
}

/** Completes E2EE setup in the real client and returns the generated passphrase from the modal. */
async function uiSetupE2EE(actor: Actor): Promise<string> {
  const { page } = actor;
  const banner = page.getByRole('button', { name: 'Save your new E2EE password' });
  await expect(banner).toBeVisible({ timeout: 60_000 });
  if (actor.who === 'admin') await dismissFingerprintPrompt(page, 1000);
  await banner.click();
  const dialog = page.getByRole('dialog', { name: 'Save your new E2EE password' });
  const password = ((await dialog.getByLabel('Your E2EE password is:').getByRole('code').textContent()) ?? '').trim();
  if (password.split(' ').length !== 12) throw new Error(`unexpected passphrase shape for ${actor.username}`);
  await dialog.getByRole('button', { name: 'I saved my password' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(banner).not.toBeVisible({ timeout: 30_000 });
  actor.e2eePassword = password;
  step(`${actor.username}: E2EE ready, passphrase captured`);
  return password;
}

/** Room E2EE state as seen by the real client (same technique as RC's own e2ee specs). */
function clientRoomState(page: Page, rid: string): Promise<string | undefined> {
  return page.evaluate(async (roomId) => {
    // biome-ignore lint/suspicious/noExplicitAny: Meteor's in-page module loader is untyped.
    const req = (globalThis as any).require as (id: string) => any;
    const { e2e } = req('/client/lib/e2ee/rocketchat.e2e.ts');
    const room = await e2e.getInstanceByRoomId(roomId);
    return room?.getState();
  }, rid);
}

async function waitRoomReady(actor: Actor, rid: string) {
  await poll(
    `${actor.username} room ${rid} READY`,
    async () => (await clientRoomState(actor.page, rid)) === 'READY',
    120_000,
  );
}

const mainList = (page: Page) => page.getByRole('list', { name: 'Message list', exact: true });
const mainItems = (page: Page) => mainList(page).locator('[role="listitem"][aria-roledescription="message"]');
const threadList = (page: Page) => page.getByRole('list', { name: 'Thread message list', exact: true });
const threadItems = (page: Page) =>
  threadList(page).locator('[role="listitem"][aria-roledescription="thread message"]');
const roomComposer = (page: Page) =>
  page.locator('footer[aria-label="Room composer"]').or(page.getByLabel('Room composer'));
const threadComposer = (page: Page) => page.locator('footer[aria-label="Thread composer"]');

async function lastMessageId(page: Page, thread = false): Promise<string> {
  const items = thread ? threadItems(page) : mainItems(page);
  await expect(items.last()).not.toHaveClass(/rcx-message--pending/, { timeout: 30_000 });
  const id = await items.last().getAttribute('id');
  if (!id) throw new Error('message has no id');
  return id;
}

async function sendMain(actor: Actor, text: string): Promise<string> {
  const { page } = actor;
  const input = roomComposer(page).locator('[name="msg"]').first();
  await expect(input).toBeEnabled({ timeout: 30_000 });
  const before = (await mainItems(page).count()) > 0 ? await mainItems(page).last().getAttribute('id') : null;
  await input.fill(text);
  await roomComposer(page).getByRole('button', { name: 'Send' }).first().click();
  await expect.poll(() => mainItems(page).last().getAttribute('id'), { timeout: 30_000 }).not.toEqual(before);
  return lastMessageId(page);
}

/** Finds a message in the (virtualized) main list, scrolling up until it is mounted. */
async function messageById(page: Page, id: string) {
  const loc = page.locator(`[role="listitem"][id="${id}"]`).first();
  for (let i = 0; i < 40 && (await loc.count()) === 0; i++) {
    await mainList(page).hover({ position: { x: 200, y: 80 } });
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(250);
  }
  await loc.scrollIntoViewIfNeeded();
  return loc;
}

async function openThread(actor: Actor, msgId: string) {
  const { page } = actor;
  const msg = await messageById(page, msgId);
  await msg.scrollIntoViewIfNeeded();
  await msg.hover();
  await msg.getByRole('button', { name: 'Reply in thread' }).click();
  await expect(threadComposer(page)).toBeVisible({ timeout: 30_000 });
}

async function sendThread(actor: Actor, tmid: string, text: string): Promise<string> {
  const { page } = actor;
  const input = threadComposer(page).locator('[name="msg"]');
  await expect(input).toBeEnabled({ timeout: 30_000 });
  // The thread list renders the root first; wait for it so it is not mistaken for the new reply.
  await expect(threadList(page).locator(`[id="${tmid}"]`)).toBeVisible({ timeout: 30_000 });
  const ids = async () => threadItems(page).evaluateAll((els) => els.map((e) => e.getAttribute('id')));
  const before = new Set(await ids());
  await input.fill(text);
  await threadComposer(page).getByRole('button', { name: 'Send' }).click();
  let created: string | undefined;
  await expect
    .poll(
      async () => {
        created = (await ids()).find((id): id is string => !!id && id !== tmid && !before.has(id));
        return created;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  const item = threadList(page).locator(`[id="${created}"]`);
  await expect(item).not.toHaveClass(/rcx-message--pending/, { timeout: 30_000 });
  return created as string;
}

async function closeThread(actor: Actor) {
  const { page } = actor;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

async function editMessage(actor: Actor, msgId: string, newText: string) {
  const { page } = actor;
  const msg = await messageById(page, msgId);
  await msg.hover();
  await msg.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .getByRole('menu', { name: 'More', exact: true })
    .getByRole('menuitem', { name: 'Edit', exact: true })
    .click();
  const input = roomComposer(page).locator('[name="msg"]').first();
  await input.fill(newText);
  await page.keyboard.press('Enter');
  await expect(msg.locator('[role="document"][aria-roledescription="message body"]')).toContainText(
    newText.slice(0, 30),
    { timeout: 30_000 },
  );
}

async function quoteMessage(actor: Actor, msgId: string, comment: string): Promise<string> {
  const { page } = actor;
  const msg = await messageById(page, msgId);
  await msg.hover();
  await msg.getByRole('button', { name: 'Quote' }).click();
  return sendMain(actor, comment);
}

async function uploadFile(
  actor: Actor,
  file: { name: string; type: string; buffer: Buffer },
  description: string,
): Promise<string> {
  const { page } = actor;
  const composer = roomComposer(page);
  const before = (await mainItems(page).count()) > 0 ? await mainItems(page).last().getAttribute('id') : null;
  await composer
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: file.name, mimeType: file.type, buffer: file.buffer });
  await expect(composer.getByRole('group', { name: file.name, exact: true })).toBeVisible({ timeout: 30_000 });
  await composer.locator('[name="msg"]').first().fill(description);
  await composer.getByRole('button', { name: 'Send' }).first().click();
  await expect.poll(() => mainItems(page).last().getAttribute('id'), { timeout: 60_000 }).not.toEqual(before);
  const id = await lastMessageId(page);
  await expect(mainItems(page).last().locator('.rcx-icon--name-key').first()).toBeVisible({ timeout: 30_000 });
  return id;
}

/** Full navigation (page reload). Never use it on a client that may be handing out room keys. */
async function goToGroup(actor: Actor, name: string, rid: string) {
  await actor.page.goto(`/group/${name}`);
  await waitInRoom(actor, rid);
}

/** Waits until the already-open room is usable, without reloading the page. */
async function waitInRoom(actor: Actor, rid: string) {
  await waitRoomReady(actor, rid);
  await expect(mainList(actor.page)).toBeVisible({ timeout: 60_000 });
}

/** In-app navigation through the sidebar (keeps the client and its key distribution running). */
async function openRoomFromSidebar(actor: Actor, label: string, rid: string) {
  await actor.page.getByRole('link', { name: label }).first().click();
  await waitInRoom(actor, rid);
}

const PLACEHOLDER = 'This message is end-to-end encrypted';

/**
 * Records what the real client displays for each message. Waits (bounded) for the client to finish decrypting,
 * unless `undecryptable` says the client is not expected to be able to (it then shows the placeholder).
 */
async function captureRendered(actor: Actor, ids: string[], undecryptable: string[] = []) {
  for (const id of ids) {
    const loc = actor.page.locator(`[id="${id}"]`).first();
    if ((await loc.count()) === 0) {
      await messageById(actor.page, id).catch(() => undefined);
      if ((await loc.count()) === 0) continue;
    }
    const body = loc.locator('[role="document"][aria-roledescription="message body"]').first();
    const read = async () => ((await body.count()) ? await body.innerText() : await loc.innerText());
    let text = await read();
    for (let i = 0; i < 30 && text.includes(PLACEHOLDER) && !undecryptable.includes(id); i++) {
      await actor.page.waitForTimeout(500);
      text = await read();
    }
    const byPhase = rendered[actor.who] ?? {};
    byPhase[phase] = { ...byPhase[phase], [id]: text };
    rendered[actor.who] = byPhase;
  }
}

// ----------------------------------------------------------------------------------------------- dumps

function mongoEval(script: string): unknown {
  const res = spawnSync(
    join(REPO_ROOT, 'scripts', 'compose.sh'),
    ['exec', '-T', 'mongodb', 'mongosh', '--quiet', 'rocketchat', '--eval', script],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(`mongosh failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function mongoFind(collection: string, filter: unknown, projection: unknown = {}): unknown {
  return mongoEval(
    `EJSON.stringify(db.getCollection(${JSON.stringify(collection)}).find(EJSON.parse(${JSON.stringify(
      JSON.stringify(filter),
    )}), ${JSON.stringify(projection)}).sort({ _id: 1 }).toArray(), null, 0, { relaxed: false })`,
  );
}

async function restDump(actor: { username: string; session: Session }, rooms: { group: string; dm: string }) {
  const auth = actor.session;
  const dir = `rest/${actor.username}`;
  writeJson(`${dir}/me.json`, pick(await api('me', { auth }), ['_id', 'username', 'name']));
  writeJson(`${dir}/e2e.fetchMyKeys.json`, await api('e2e.fetchMyKeys', { auth }));
  for (const [kind, rid] of Object.entries(rooms)) {
    const sub = await api(`subscriptions.getOne?roomId=${rid}`, { auth }).catch((e: unknown) => ({ error: String(e) }));
    writeJson(`${dir}/${kind}.subscriptions.getOne.json`, sub);
    writeJson(
      `${dir}/${kind}.rooms.info.json`,
      await api(`rooms.info?roomId=${rid}`, { auth }).catch((e: unknown) => ({ error: String(e) })),
    );
    const historyEndpoint = kind === 'dm' ? 'im.history' : 'groups.history';
    writeJson(
      `${dir}/${kind}.${historyEndpoint}.json`,
      await api(`${historyEndpoint}?roomId=${rid}&count=200`, { auth }).catch((e: unknown) => ({ error: String(e) })),
    );
    writeJson(
      `${dir}/${kind}.chat.syncMessages.json`,
      await api(`chat.syncMessages?roomId=${rid}&lastUpdate=${encodeURIComponent(new Date(0).toISOString())}`, {
        auth,
      }).catch((e: unknown) => ({ error: String(e) })),
    );
    const filesEndpoint = kind === 'dm' ? 'im.files' : 'groups.files';
    writeJson(
      `${dir}/${kind}.${filesEndpoint}.json`,
      await api(`${filesEndpoint}?roomId=${rid}&count=100`, { auth }).catch((e: unknown) => ({ error: String(e) })),
    );
  }
}

function pick(obj: Json, keys: string[]): Json {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

async function downloadFiles(auth: Session, rid: string, kind: string) {
  const endpoint = kind === 'dm' ? 'im.files' : 'groups.files';
  const res = await api(`${endpoint}?roomId=${rid}&count=100`, { auth });
  const files = (res.files ?? []) as Array<{ _id: string; name: string; url?: string; path?: string }>;
  for (const f of files) {
    const path = f.path ?? f.url ?? `/file-upload/${f._id}/${encodeURIComponent(f.name)}`;
    const url = new URL(path, process.env.RC_TEST_URL ?? 'http://localhost:3000');
    const r = await fetch(url, { headers: { 'x-user-id': auth.userId, 'x-auth-token': auth.authToken } });
    if (!r.ok) throw new Error(`download ${url} -> ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const filePath = join(OUT, 'files', `${f._id}.bin`);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, buf);
    step(`downloaded encrypted upload ${f._id} (${buf.length} bytes)`);
  }
}

// ----------------------------------------------------------------------------------------------- main

async function resetKeysIfPresent(stack: StackState): Promise<boolean> {
  const adminSession = { userId: stack.admin.userId, authToken: stack.admin.authToken };
  let didReset = false;
  const targets = [
    {
      name: 'alice',
      userId: stack.users.alice.userId,
      auth: { userId: stack.users.alice.userId, authToken: stack.users.alice.pat },
    },
    {
      name: 'bob',
      userId: stack.users.bob.userId,
      auth: { userId: stack.users.bob.userId, authToken: stack.users.bob.pat },
    },
    { name: 'rcadmin', userId: stack.admin.userId, auth: adminSession },
  ];
  for (const t of targets) {
    const keys = await api('e2e.fetchMyKeys', { auth: t.auth });
    if (keys.public_key || keys.private_key) {
      step(`resetting existing E2EE keys of ${t.name} (also revokes its tokens)`);
      await api('users.resetE2EKey', { auth: adminSession, body: { userId: t.userId } }).catch(
        async (error: unknown) => {
          if (error instanceof ApiError && t.name === 'rcadmin') {
            // admin may not reset itself through the admin path on every version; use the own-key variant
            await api('users.resetE2EKey', { auth: adminSession, body: {} });
            return;
          }
          throw error;
        },
      );
      didReset = true;
    }
  }
  return didReset;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  let stack = await bootstrapStack();
  if (await resetKeysIfPresent(stack)) {
    // Key resets wipe every login token of the user (incl. PATs): provision fresh ones.
    stack = await bootstrapStack();
  }

  const aliceSession = { userId: stack.users.alice.userId, authToken: stack.users.alice.pat };
  const bobSession = { userId: stack.users.bob.userId, authToken: stack.users.bob.pat };
  const adminSession = { userId: stack.admin.userId, authToken: stack.admin.authToken };

  // Groups from earlier runs are unreadable after the key resets above and only add client noise.
  {
    const groups = ((await api('groups.list?count=200', { auth: aliceSession })).groups ?? []) as Array<{
      _id: string;
      name: string;
    }>;
    for (const g of groups.filter((x) => x.name.startsWith('handbook-'))) {
      await api('groups.delete', { auth: aliceSession, body: { roomId: g._id } }).catch((e: unknown) =>
        step(`could not delete stale group ${g.name}: ${String(e).slice(0, 80)}`),
      );
    }
  }

  const browser = await chromium.launch({ headless: !HEADED });
  const alice = await newActor(browser, 'alice', 'alice', stack.users.alice.password, aliceSession);
  const bob = await newActor(browser, 'bob', 'bob', stack.users.bob.password, bobSession);
  const admin = await newActor(browser, 'admin', ADMIN.username, ADMIN.password, adminSession);

  try {
    // 1. E2EE setup for alice and bob through the real client.
    await uiLogin(alice);
    await uiSetupE2EE(alice);
    await uiLogin(bob);
    await uiSetupE2EE(bob);

    // 2a. alice creates the encrypted private group with bob.
    step(`creating encrypted private group ${GROUP_NAME}`);
    await alice.page.getByRole('button', { name: 'Create new' }).click();
    await alice.page.getByRole('menu', { name: 'Create new' }).getByRole('menuitem', { name: 'Channel' }).click();
    const createDialog = alice.page.getByRole('dialog', { name: 'Create channel' });
    await createDialog.getByRole('textbox', { name: 'Name' }).fill(GROUP_NAME);
    const members = createDialog.getByRole('combobox', { name: 'Members' });
    await members.click();
    await members.fill('bob', { force: true });
    await alice.page.getByRole('option', { name: 'bob' }).first().click();
    // Close the member suggestions popup before touching the rest of the form.
    await createDialog.getByRole('textbox', { name: 'Name' }).click();
    await expect(alice.page.getByRole('option').first())
      .not.toBeVisible({ timeout: 10_000 })
      .catch(async () => {
        await alice.page.keyboard.press('Tab');
      });
    await createDialog.getByRole('button', { name: 'Advanced settings', exact: true }).click();
    const encryptedToggle = createDialog.getByRole('checkbox', { name: 'Encrypted' });
    if (!(await encryptedToggle.isChecked())) await createDialog.locator('label', { hasText: 'Encrypted' }).click();
    await shot(alice.page, 'create-group');
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 30_000 });

    const groupInfo = await poll('group exists', async () => {
      const res = await api(`groups.info?roomName=${GROUP_NAME}`, { auth: aliceSession }).catch(() => undefined);
      return res?.group as Json | undefined;
    });
    const groupRid = groupInfo._id as string;
    if (!groupInfo.encrypted) throw new Error('group was not created encrypted');
    // The client navigates into the new room by itself and creates + distributes the room key there.
    await waitInRoom(alice, groupRid);
    const firstKeyId = await poll('group e2eKeyId', async () => {
      const room = (await api(`rooms.info?roomId=${groupRid}`, { auth: aliceSession })).room as Json;
      return room.e2eKeyId as string | undefined;
    });
    step(`group ${groupRid} key established (kid ${firstKeyId})`);
    await poll(
      'bob has a (suggested) group key',
      async () => {
        const sub = (await api(`subscriptions.getOne?roomId=${groupRid}`, { auth: bobSession })).subscription as Json;
        return Boolean(sub.E2EKey || sub.E2ESuggestedKey);
      },
      60_000,
    );
    await goToGroup(bob, GROUP_NAME, groupRid);
    step('bob received the group key');

    // 3. Messages in the group.
    const m1 = await sendMain(alice, TEXT.plain);
    expected.push({
      label: 'M1-plain',
      room: 'group',
      sender: 'alice',
      phase: 'pre-reset',
      msgId: m1,
      text: TEXT.plain,
    });
    await waitRoomReady(bob, groupRid);
    const m2 = await sendMain(bob, TEXT.long);
    expected.push({ label: 'M2-long', room: 'group', sender: 'bob', phase: 'pre-reset', msgId: m2, text: TEXT.long });
    const m3 = await sendMain(alice, TEXT.markdown);
    expected.push({
      label: 'M3-markdown',
      room: 'group',
      sender: 'alice',
      phase: 'pre-reset',
      msgId: m3,
      text: TEXT.markdown,
    });

    await bob.page.waitForTimeout(1500);
    await openThread(bob, m1);
    const m4 = await sendThread(bob, m1, TEXT.threadReply);
    expected.push({
      label: 'M4-thread-reply',
      room: 'group',
      sender: 'bob',
      phase: 'pre-reset',
      msgId: m4,
      tmidLabel: 'M1-plain',
      tmid: m1,
      text: TEXT.threadReply,
    });
    await closeThread(bob);

    const m5 = await sendMain(alice, TEXT.editOriginal);
    await editMessage(alice, m5, TEXT.editFinal);
    expected.push({
      label: 'M5-edited',
      room: 'group',
      sender: 'alice',
      phase: 'pre-reset',
      msgId: m5,
      text: TEXT.editFinal,
      originalText: TEXT.editOriginal,
    });

    await bob.page.waitForTimeout(1500);
    const m6 = await quoteMessage(bob, m1, TEXT.quoteComment);
    expected.push({
      label: 'M6-quote',
      room: 'group',
      sender: 'bob',
      phase: 'pre-reset',
      msgId: m6,
      // The client prepends a permalink to the quoted message and encrypts it together with the comment.
      text: `[ ](${stack.url}/group/${GROUP_NAME}?msg=${m1})\n${TEXT.quoteComment}`,
      quoteOfLabel: 'M1-plain',
    });

    const m7 = await uploadFile(
      alice,
      { name: FILES.checklist.name, type: FILES.checklist.type, buffer: Buffer.from(FILES.checklist.content) },
      TEXT.fileDescription,
    );
    expected.push({
      label: 'M7-file-text',
      room: 'group',
      sender: 'alice',
      phase: 'pre-reset',
      msgId: m7,
      text: TEXT.fileDescription,
      file: { name: FILES.checklist.name, type: FILES.checklist.type, contentFixture: 'plain/release-checklist.md' },
    });
    const m8 = await uploadFile(
      bob,
      { name: FILES.diagram.name, type: FILES.diagram.type, buffer: PNG_BYTES },
      'architecture diagram',
    );
    expected.push({
      label: 'M8-file-image',
      room: 'group',
      sender: 'bob',
      phase: 'pre-reset',
      msgId: m8,
      text: 'architecture diagram',
      file: { name: FILES.diagram.name, type: FILES.diagram.type, contentFixture: 'plain/diagram.png' },
    });

    // 2b + 3. Encrypted DM between alice and bob.
    step('creating encrypted DM alice <-> bob');
    // A DM from an earlier run would be reused, and its key was lost with the account key reset above.
    {
      const ims = ((await api('im.list?count=100', { auth: aliceSession })).ims ?? []) as Array<{
        _id: string;
        usernames?: string[];
      }>;
      for (const im of ims.filter((i) => i.usernames?.length === 2 && i.usernames.includes('bob'))) {
        await api('im.delete', { auth: adminSession, body: { roomId: im._id } });
        step(`deleted stale DM ${im._id} from an earlier run`);
      }
    }
    await alice.page.getByRole('button', { name: 'Create new' }).click();
    await alice.page
      .getByRole('menu', { name: 'Create new' })
      .getByRole('menuitem', { name: 'Direct message' })
      .click();
    const dmDialog = alice.page.getByRole('dialog', { name: 'New direct message' });
    const who = dmDialog.getByRole('combobox', { name: 'Select one or more people to message', exact: true });
    await who.click();
    await who.fill('bob');
    await alice.page.getByRole('option', { name: 'bob' }).first().click();
    await alice.page.keyboard.press('Tab');
    await dmDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dmDialog).not.toBeVisible({ timeout: 30_000 });
    const dmRid = await poll('dm exists', async () => {
      const res = await api('im.list?count=50', { auth: aliceSession });
      const ims = (res.ims ?? []) as Array<{ _id: string; usernames?: string[]; encrypted?: boolean }>;
      return ims.find((im) => im.usernames?.includes('bob') && im.usernames.includes('alice'))?._id;
    });
    await waitInRoom(alice, dmRid);
    await poll(
      'bob has a (suggested) DM key',
      async () => {
        const sub = (await api(`subscriptions.getOne?roomId=${dmRid}`, { auth: bobSession })).subscription as Json;
        return Boolean(sub.E2EKey || sub.E2ESuggestedKey);
      },
      60_000,
    );
    const d1 = await sendMain(alice, TEXT.dm1);
    expected.push({ label: 'D1-dm', room: 'dm', sender: 'alice', phase: 'pre-reset', msgId: d1, text: TEXT.dm1 });
    await bob.page.goto(`/direct/${dmRid}`);
    await waitInRoom(bob, dmRid);
    const d2 = await sendMain(bob, TEXT.dm2);
    expected.push({ label: 'D2-dm-reply', room: 'dm', sender: 'bob', phase: 'pre-reset', msgId: d2, text: TEXT.dm2 });
    const d3 = await uploadFile(
      bob,
      { name: FILES.escalation.name, type: FILES.escalation.type, buffer: Buffer.from(FILES.escalation.content) },
      TEXT.dmFileDescription,
    );
    expected.push({
      label: 'D3-dm-file',
      room: 'dm',
      sender: 'bob',
      phase: 'pre-reset',
      msgId: d3,
      text: TEXT.dmFileDescription,
      file: { name: FILES.escalation.name, type: FILES.escalation.type, contentFixture: 'plain/escalation-policy.txt' },
    });

    // What the real client rendered before the reset (both members).
    await openRoomFromSidebar(alice, GROUP_NAME, groupRid);
    await captureRendered(alice, [m1, m2, m3, m5, m6, m7, m8]);
    await bob.page.goto(`/direct/${dmRid}`);
    await captureRendered(bob, [d1, d2, d3]);

    // 4. alice + bob go offline; the admin joins without a key and resets the room key.
    await alice.page.close();
    await bob.page.close();
    await api('groups.invite', { auth: aliceSession, body: { roomId: groupRid, userId: stack.admin.userId } });
    step('admin invited to the group while no member is online');
    await uiLogin(admin);
    await uiSetupE2EE(admin);
    await admin.page.goto(`/group/${GROUP_NAME}`);
    // Without a room key the client shows "Check back later" instead of the message list.
    await expect(admin.page.getByText('Check back later')).toBeVisible({ timeout: 60_000 });
    await poll(
      'admin room WAITING_KEYS',
      async () => (await clientRoomState(admin.page, groupRid)) === 'WAITING_KEYS',
      60_000,
    );
    await shot(admin.page, 'admin-waiting-keys');
    const toolbar = admin.page.getByRole('toolbar', { name: 'Primary Room actions' });
    const disableBtn = toolbar.getByRole('button', { name: 'Disable E2E encryption' });
    if (await disableBtn.isVisible()) {
      await disableBtn.click();
    } else {
      await toolbar.getByRole('button', { name: 'Options' }).click();
      await admin.page.getByRole('menuitem', { name: 'Disable E2E encryption' }).click();
    }
    const disableDialog = admin.page.getByRole('dialog', { name: 'Disable encryption' });
    await expect(disableDialog).toBeVisible();
    await disableDialog.getByRole('button', { name: 'Reset encryption keys' }).click();
    await disableDialog.getByRole('button', { name: /^Reset .* encryption keys$/ }).click();
    const resetDialog = admin.page.getByRole('dialog', { name: 'Reset encryption keys' });
    await shot(admin.page, 'admin-reset-dialog');
    await resetDialog.getByRole('button', { name: 'Reset encryption keys' }).click();
    const secondKeyId = await poll('new group e2eKeyId', async () => {
      const room = (await api(`rooms.info?roomId=${groupRid}`, { auth: adminSession })).room as Json;
      return room.e2eKeyId !== firstKeyId ? (room.e2eKeyId as string) : undefined;
    });
    step(`room key reset by admin: ${firstKeyId} -> ${secondKeyId}`);
    await waitRoomReady(admin, groupRid);
    const p1 = await sendMain(admin, TEXT.postResetAdmin);
    expected.push({
      label: 'P1-admin-post-reset',
      room: 'group',
      sender: 'admin',
      phase: 'post-reset',
      msgId: p1,
      text: TEXT.postResetAdmin,
    });

    // 5. alice and bob return; the admin's client hands them the new key.
    alice.page = await alice.context.newPage();
    bob.page = await bob.context.newPage();
    await goToGroup(alice, GROUP_NAME, groupRid);
    await goToGroup(bob, GROUP_NAME, groupRid);
    step('alice and bob received the new room key');
    const p2 = await sendMain(alice, TEXT.postResetAlice);
    expected.push({
      label: 'P2-alice-post-reset',
      room: 'group',
      sender: 'alice',
      phase: 'post-reset',
      msgId: p2,
      text: TEXT.postResetAlice,
    });
    await bob.page.waitForTimeout(1500);
    await openThread(bob, m1);
    const p3 = await sendThread(bob, m1, TEXT.postResetThread);
    expected.push({
      label: 'P3-thread-post-reset',
      room: 'group',
      sender: 'bob',
      phase: 'post-reset',
      msgId: p3,
      tmidLabel: 'M1-plain',
      tmid: m1,
      text: TEXT.postResetThread,
    });
    await closeThread(bob);
    const p4 = await uploadFile(
      alice,
      { name: FILES.postReset.name, type: FILES.postReset.type, buffer: Buffer.from(FILES.postReset.content) },
      TEXT.postResetFileDescription,
    );
    expected.push({
      label: 'P4-file-post-reset',
      room: 'group',
      sender: 'alice',
      phase: 'post-reset',
      msgId: p4,
      text: TEXT.postResetFileDescription,
      file: { name: FILES.postReset.name, type: FILES.postReset.type, contentFixture: 'plain/post-reset-notes.txt' },
    });

    // What the real clients render after the reset, from a fresh page load (old messages via oldRoomKeys).
    phase = 'post-reset';
    for (const member of [alice, bob]) {
      await member.page.reload();
      await goToGroup(member, GROUP_NAME, groupRid);
      await member.page.waitForTimeout(3000);
      await captureRendered(member, [m1, m2, m3, m5, m6, m7, m8, p1, p2, p4]);
    }
    await admin.page.waitForTimeout(3000);
    await captureRendered(admin, [m1, m2, p1, p2, p4], [m1, m2]);
    await shot(alice.page, 'alice-final');
    await shot(admin.page, 'admin-final');

    // 6. Dumps.
    step(`writing fixtures to ${OUT}`);
    const rooms = { group: groupRid, dm: dmRid };
    await restDump({ username: 'alice', session: aliceSession }, rooms);
    await restDump({ username: 'bob', session: bobSession }, rooms);
    await restDump({ username: 'rcadmin', session: adminSession }, { group: groupRid, dm: dmRid });
    for (const e of expected) {
      writeJson(
        `rest/alice/chat.getMessage/${e.msgId}.json`,
        await api(`chat.getMessage?msgId=${e.msgId}`, { auth: aliceSession }),
      );
    }
    writeJson(
      `rest/alice/group.chat.getThreadMessages.${m1}.json`,
      await api(`chat.getThreadMessages?tmid=${m1}&count=100`, { auth: aliceSession }),
    );
    writeJson(
      `rest/alice/group.chat.getThreadsList.json`,
      await api(`chat.getThreadsList?rid=${groupRid}&count=100`, { auth: aliceSession }),
    );
    await downloadFiles(aliceSession, groupRid, 'group');
    await downloadFiles(aliceSession, dmRid, 'dm');

    const rids = [groupRid, dmRid];
    const uids = [stack.users.alice.userId, stack.users.bob.userId, stack.admin.userId];
    writeJson('mongo/rocketchat_message.json', mongoFind('rocketchat_message', { rid: { $in: rids } }));
    writeJson('mongo/rocketchat_subscription.json', mongoFind('rocketchat_subscription', { rid: { $in: rids } }));
    writeJson('mongo/rocketchat_room.json', mongoFind('rocketchat_room', { _id: { $in: rids } }));
    writeJson('mongo/rocketchat_uploads.json', mongoFind('rocketchat_uploads', { rid: { $in: rids } }));
    writeJson('mongo/users.json', mongoFind('users', { _id: { $in: uids } }, { _id: 1, username: 1, name: 1, e2e: 1 }));

    mkdirSync(join(OUT, 'plain'), { recursive: true });
    writeFileSync(join(OUT, 'plain', FILES.checklist.name), FILES.checklist.content);
    writeFileSync(join(OUT, 'plain', FILES.escalation.name), FILES.escalation.content);
    writeFileSync(join(OUT, 'plain', FILES.postReset.name), FILES.postReset.content);
    writeFileSync(join(OUT, 'plain', FILES.diagram.name), PNG_BYTES);

    writeJson('expected.json', {
      note: 'THROWAWAY test data generated by scripts/generate-fixtures.ts against the local Docker stack. Not real secrets.',
      rcVersion: process.env.RC_VERSION ?? stack.rcVersion,
      serverReportedVersion: stack.rcVersion,
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      url: stack.url,
      users: {
        alice: { userId: stack.users.alice.userId, username: 'alice', e2eePassword: alice.e2eePassword },
        bob: { userId: stack.users.bob.userId, username: 'bob', e2eePassword: bob.e2eePassword },
        admin: { userId: stack.admin.userId, username: ADMIN.username, e2eePassword: admin.e2eePassword },
      },
      rooms: {
        group: {
          rid: groupRid,
          name: GROUP_NAME,
          t: 'p',
          keyIds: { beforeReset: firstKeyId, afterReset: secondKeyId },
        },
        dm: { rid: dmRid, t: 'd' },
      },
      keyReset: { room: 'group', by: 'admin', oldKeyId: firstKeyId, newKeyId: secondKeyId },
      messages: expected,
      renderedByRealClient: rendered,
    });

    stack.users.alice.e2eePassword = alice.e2eePassword;
    stack.users.bob.e2eePassword = bob.e2eePassword;
    stack.admin.e2eePassword = admin.e2eePassword;
    stack.groundTruth = {
      runId: RUN_ID,
      fixtureDir: OUT,
      groupRoomId: groupRid,
      groupName: GROUP_NAME,
      dmRoomId: dmRid,
    };
    writeStack(stack);
    step(`done: ${expected.length} messages, fixtures in ${OUT}`);
  } catch (error) {
    for (const a of [alice, bob, admin]) {
      if (!a.page.isClosed()) await shot(a.page, `FAIL-${a.who}`);
    }
    throw error;
  } finally {
    flushConsoleLogs();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
