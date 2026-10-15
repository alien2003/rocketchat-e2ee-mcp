/**
 * `rc-mcp doctor`: connectivity, token, E2EE key state and per-room readability, without printing secrets.
 */
import { existsSync, statSync } from 'node:fs';
import type { App } from '../app.ts';
import type { Config } from '../config.ts';
import { decodeStoredPrivateKey } from '../e2ee/private-key.ts';
import { REASON_HINTS, roomTypeLabel } from '../mcp/format.ts';
import { toErrorPayload } from '../mcp/server.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  encryptedRooms: Array<{ name: string; type: string; keyStatus: string | null; detail?: string; action?: string }>;
}

function describeConfig(config: Config): Check[] {
  return [
    {
      name: 'config',
      status: 'ok',
      detail: `server ${config.url}, user id ${config.userId}, token set (${config.authToken.length} chars)`,
    },
    config.e2eePassword
      ? { name: 'e2ee password', status: 'ok', detail: 'RC_E2EE_PASSWORD is set (not shown)' }
      : {
          name: 'e2ee password',
          status: 'warn',
          detail: 'RC_E2EE_PASSWORD is not set: encrypted rooms will be listed but not decrypted',
          hint: REASON_HINTS['no-e2ee-password'],
        },
    {
      name: 'index',
      status: 'info',
      detail: config.ephemeral
        ? 'ephemeral: index kept in memory; get_file returns files inline instead of saving them'
        : `stored in ${config.dataDir} (plaintext of decrypted messages)`,
    },
  ];
}

export async function runDoctor(app: App): Promise<DoctorReport> {
  const checks: Check[] = [...describeConfig(app.config)];
  const encryptedRooms: DoctorReport['encryptedRooms'] = [];
  const add = (c: Check) => checks.push(c);
  const major = Number(process.versions.node.split('.')[0]);
  add({
    name: 'node',
    status: major >= 24 ? 'ok' : 'fail',
    detail: `Node.js ${process.versions.node}`,
    ...(major < 24 ? { hint: 'rc-mcp needs Node.js 24 or newer' } : {}),
  });

  try {
    const info = await app.client.serverInfo();
    add({ name: 'server', status: 'ok', detail: `reachable, Rocket.Chat ${info.version ?? 'unknown version'}` });
  } catch (error) {
    const e = toErrorPayload(error);
    add({ name: 'server', status: 'fail', detail: e.message, hint: 'Check RC_URL and network access.' });
    return { ok: false, checks, encryptedRooms };
  }

  try {
    const me = await app.me();
    const roles = me.roles?.join(', ') || 'none';
    add({
      name: 'authentication',
      status: 'ok',
      detail: `token valid for @${me.username ?? me._id} (roles: ${roles})`,
    });
    if (me.active === false) add({ name: 'account', status: 'fail', detail: 'account is deactivated' });
    if (me.roles?.includes('admin')) {
      add({ name: 'rate limits', status: 'info', detail: 'admin role: REST rate limits are bypassed' });
    } else {
      add({
        name: 'rate limits',
        status: 'info',
        detail:
          'non-admin token: Rocket.Chat limits most REST routes to ~10 calls/min per IP by default; rc-mcp waits and retries',
      });
    }
  } catch (error) {
    const e = toErrorPayload(error);
    add({ name: 'authentication', status: 'fail', detail: e.message, ...(e.hint ? { hint: e.hint } : {}) });
    return { ok: false, checks, encryptedRooms };
  }

  try {
    const keys = await app.client.get('e2e.fetchMyKeys');
    if (!keys.private_key) {
      add({
        name: 'e2ee keys',
        status: 'warn',
        detail: 'this account has no E2EE keys',
        hint: REASON_HINTS['no-user-keys'],
      });
    } else {
      const format = decodeStoredPrivateKey(keys.private_key, app.config.userId).version;
      const session = await app.session();
      if (session.state.status === 'ready') {
        add({ name: 'e2ee keys', status: 'ok', detail: `private key unlocked (stored format ${format})` });
      } else {
        add({
          name: 'e2ee keys',
          status: session.state.reason === 'no-e2ee-password' ? 'warn' : 'fail',
          detail: `private key not unlocked: ${session.state.reason}`,
          hint: REASON_HINTS[session.state.reason],
        });
      }
    }
  } catch (error) {
    const e = toErrorPayload(error);
    add({ name: 'e2ee keys', status: 'fail', detail: e.message, ...(e.hint ? { hint: e.hint } : {}) });
  }

  try {
    await app.refreshRooms(0);
    const rooms = app.store.listRooms();
    const enc = rooms.filter((r) => r.encrypted);
    add({
      name: 'rooms',
      status: 'ok',
      detail: `${rooms.length} subscribed rooms, ${enc.length} end-to-end encrypted`,
    });
    for (const r of enc) {
      const action =
        r.keyStatus === 'suggested'
          ? 'Readable now. Open this room once in the official client to accept the offered key (rc-mcp never accepts keys).'
          : r.keyStatus === 'missing'
            ? 'Unreadable: no member has shared the room key with this account yet. Ask a member to open the room in the official client while you are logged in there.'
            : r.keyStatus === 'undecryptable'
              ? 'Unreadable: the shared key does not match your current key pair (keys were reset). Ask a member to re-share by opening the room.'
              : r.keyStatus === 'e2ee-unavailable'
                ? 'Unreadable until the E2EE private key is unlocked (see e2ee keys above).'
                : undefined;
      encryptedRooms.push({
        name: r.displayName,
        type: roomTypeLabel(r.t),
        keyStatus: r.keyStatus,
        ...(r.keyDetail ? { detail: r.keyDetail } : {}),
        ...(action ? { action } : {}),
      });
    }
    const unreadable = enc.filter((r) => r.keyStatus !== 'ok' && r.keyStatus !== 'suggested').length;
    const suggested = enc.filter((r) => r.keyStatus === 'suggested').length;
    if (unreadable)
      add({
        name: 'encrypted rooms',
        status: 'warn',
        detail: `${unreadable} encrypted room(s) cannot be read (see list)`,
      });
    if (suggested)
      add({
        name: 'suggested keys',
        status: 'warn',
        detail: `${suggested} room(s) only have a not-yet-accepted key; open them once in the official client`,
      });
    if (enc.length && !unreadable && !suggested)
      add({ name: 'encrypted rooms', status: 'ok', detail: 'all encrypted rooms are readable' });
  } catch (error) {
    const e = toErrorPayload(error);
    add({ name: 'rooms', status: 'fail', detail: e.message, ...(e.hint ? { hint: e.hint } : {}) });
  }

  if (app.dbPath && existsSync(app.dbPath)) {
    const mode = statSync(app.dbPath).mode & 0o777;
    const stats = app.store.stats();
    add({
      name: 'index file',
      status: mode & 0o077 ? 'warn' : 'ok',
      detail: `${app.dbPath} (mode ${mode.toString(8)}): ${stats.messages} messages in ${stats.rooms} rooms`,
      ...(mode & 0o077 ? { hint: `chmod 600 ${app.dbPath}` } : {}),
    });
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks, encryptedRooms };
}

export function renderDoctor(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  const lines = ['rc-mcp doctor', ''];
  for (const c of report.checks) {
    lines.push(`${icon[c.status]} ${c.name.padEnd(16)} ${c.detail}`);
    if (c.hint) lines.push(`  ${''.padEnd(16)} → ${c.hint}`);
  }
  if (report.encryptedRooms.length) {
    lines.push('', 'Encrypted rooms:');
    for (const r of report.encryptedRooms) {
      const mark = r.keyStatus === 'ok' ? '✓' : r.keyStatus === 'suggested' ? '!' : '✗';
      lines.push(`  ${mark} ${r.name} [${r.type}] key: ${r.keyStatus}${r.detail ? ` (${r.detail})` : ''}`);
      if (r.action) lines.push(`      → ${r.action}`);
    }
  }
  lines.push('', report.ok ? 'Result: OK' : 'Result: problems found');
  return lines.join('\n');
}
