/**
 * In-memory stand-in for the Rocket.Chat REST API, serving the real-client fixture dumps of one user with the
 * 8.9.0 semantics our sync relies on (rooms.history `previous` cursor = exclusive ms bound, newest first;
 * chat.syncMessages `lastUpdate` = updated + deleted since). It never encrypts anything: "new" messages are
 * real captured messages that were held back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryParams } from '../../src/rc-api/client.ts';
import { RcApiError } from '../../src/rc-api/errors.ts';
import type { EndpointName, EndpointResponse, Message } from '../../src/rc-api/schemas.ts';
import { ENDPOINTS } from '../../src/rc-api/schemas.ts';

type Who = 'alice' | 'bob' | 'admin';
const REST_NAME: Record<Who, string> = { alice: 'alice', bob: 'bob', admin: 'rcadmin' };

export interface FixtureExpected {
  rcVersion: string;
  users: Record<Who, { userId: string; username: string; e2eePassword: string }>;
  rooms: { group: { rid: string; name: string }; dm: { rid: string } };
  messages: Array<{
    label: string;
    room: 'group' | 'dm';
    sender: Who;
    phase: string;
    msgId: string;
    tmid?: string;
    text: string;
    file?: { name: string; type: string; contentFixture: string };
  }>;
}

export class FakeRc {
  readonly dir: string;
  readonly who: Who;
  readonly expected: FixtureExpected;
  private readonly rest: (file: string) => Record<string, unknown>;
  /** All messages per rid, as returned by the server. */
  readonly messages = new Map<string, Message[]>();
  private hidden = new Set<string>();
  private deleted: { _id: string; rid: string; _deletedAt: string }[] = [];
  clock = Date.parse('2030-01-01T00:00:00Z');
  calls: { endpoint: string; params: QueryParams }[] = [];

  constructor(dir: string, who: Who = 'alice') {
    this.dir = dir;
    this.who = who;
    this.expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as FixtureExpected;
    this.rest = (file) =>
      JSON.parse(readFileSync(join(dir, 'rest', REST_NAME[who], file), 'utf8')) as Record<string, unknown>;
    for (const room of ['group', 'dm'] as const) {
      const file = room === 'group' ? 'group.groups.history.json' : 'dm.im.history.json';
      const res = this.tryRest(file);
      const list = ((res?.messages ?? []) as Message[]).slice();
      if (list.length) this.messages.set(this.expected.rooms[room].rid, list);
    }
  }

  private tryRest(file: string): Record<string, unknown> | undefined {
    try {
      const r = this.rest(file);
      return 'error' in r ? undefined : r;
    } catch {
      return undefined;
    }
  }

  get serverNow(): number {
    return this.clock;
  }

  get userId(): string {
    return this.expected.users[this.who].userId;
  }

  get password(): string {
    return this.expected.users[this.who].e2eePassword;
  }

  /** Hide messages from history until `reveal` (simulates messages that arrive after the first sync). */
  hide(ids: string[]): void {
    for (const id of ids) this.hidden.add(id);
  }

  reveal(ids: string[]): void {
    for (const id of ids) {
      this.hidden.delete(id);
      for (const list of this.messages.values()) {
        const m = list.find((x) => x._id === id);
        if (m) m._updatedAt = new Date(this.clock).toISOString();
      }
    }
  }

  delete(id: string): void {
    for (const [rid, list] of this.messages) {
      const idx = list.findIndex((m) => m._id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
        this.deleted.push({ _id: id, rid, _deletedAt: new Date(this.clock).toISOString() });
      }
    }
  }

  private visible(rid: string): Message[] {
    return (this.messages.get(rid) ?? [])
      .filter((m) => !this.hidden.has(m._id))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }

  async get<K extends EndpointName>(endpoint: K, params: QueryParams = {}): Promise<EndpointResponse<K>> {
    this.calls.push({ endpoint, params });
    this.clock += 1000;
    const body = this.handle(endpoint, params);
    return ENDPOINTS[endpoint].parse(body) as EndpointResponse<K>;
  }

  private sub(kind: 'group' | 'dm') {
    return (this.tryRest(`${kind}.subscriptions.getOne.json`)?.subscription ?? null) as Record<string, unknown> | null;
  }

  private handle(endpoint: EndpointName, p: QueryParams): unknown {
    switch (endpoint) {
      case 'me':
        return this.rest('me.json');
      case 'e2e.fetchMyKeys':
        return this.rest('e2e.fetchMyKeys.json');
      case 'subscriptions.get':
        return { update: [this.sub('group'), this.sub('dm')].filter(Boolean), remove: [] };
      case 'subscriptions.getOne': {
        const kind = p.roomId === this.expected.rooms.dm.rid ? 'dm' : 'group';
        return { subscription: this.sub(kind) };
      }
      case 'rooms.get': {
        const rooms = (['group', 'dm'] as const)
          .map((k) => this.tryRest(`${k}.rooms.info.json`)?.room)
          .filter(Boolean)
          .map((r) => ({ ...(r as object), _updatedAt: new Date(this.clock).toISOString() }));
        return { update: rooms, remove: [] };
      }
      case 'rooms.info': {
        const kind = p.roomId === this.expected.rooms.dm.rid ? 'dm' : 'group';
        return this.tryRest(`${kind}.rooms.info.json`);
      }
      case 'rooms.history': {
        const all = this.visible(String(p.roomId));
        const count = Number(p.count ?? 20);
        const upper = p.previous ? Number(p.previous) : Number.POSITIVE_INFINITY;
        const page = all.filter((m) => Date.parse(m.ts) < upper).slice(0, count + 1);
        const more = page.length > count;
        const messages = page.slice(0, count);
        const oldest = messages.at(-1);
        return {
          messages,
          cursor: { next: null, previous: more && oldest ? String(Date.parse(oldest.ts)) : null },
        };
      }
      case 'chat.syncMessages': {
        const since = Date.parse(String(p.lastUpdate));
        const rid = String(p.roomId);
        return {
          result: {
            updated: this.visible(rid).filter((m) => Date.parse(m._updatedAt ?? m.ts) > since),
            deleted: this.deleted.filter((d) => d.rid === rid && Date.parse(d._deletedAt) > since),
          },
        };
      }
      case 'chat.getMessage': {
        for (const list of this.messages.values()) {
          const m = list.find((x) => x._id === p.msgId);
          if (m) return { message: m };
        }
        throw new RcApiError('bad-request', endpoint, 'message not found', { status: 400 });
      }
      case 'chat.getThreadMessages': {
        const all = [...this.messages.values()].flat().filter((m) => m.tmid === p.tmid);
        return {
          messages: all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
          count: all.length,
          offset: 0,
          total: all.length,
        };
      }
      case 'groups.files':
        return this.tryRest('group.groups.files.json') ?? { files: [] };
      case 'im.files':
        return this.tryRest('dm.im.files.json') ?? { files: [] };
      case 'users.info': {
        const user = Object.values(this.expected.users).find((u) => u.username === p.username || u.userId === p.userId);
        if (!user) throw new RcApiError('bad-request', endpoint, 'User not found.', { status: 400 });
        return { user: { _id: user.userId, username: user.username, name: user.username, status: 'online' } };
      }
      case 'chat.search': {
        return { messages: [] };
      }
      default:
        throw new RcApiError('bad-request', endpoint, `fake does not implement ${endpoint}`);
    }
  }

  async download(path: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string | undefined }> {
    const id = path.split('/')[2] ?? '';
    return {
      bytes: new Uint8Array(readFileSync(join(this.dir, 'files', `${id}.bin`))),
      contentType: 'application/octet-stream',
    };
  }

  async serverInfo() {
    return { version: this.expected.rcVersion };
  }
}
