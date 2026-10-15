/**
 * Incremental per-room sync (ADR 0001 §6):
 *   rooms + key status   subscriptions.get + rooms.get (2 calls for everything)
 *   backfill             rooms.history cursor pages (newest -> oldest), resumable
 *   incremental          chat.syncMessages?lastUpdate=… (updated + deleted in one call)
 * Cursors are exclusive on millisecond timestamps, so every request overlaps by 1 ms and writes are idempotent.
 */
import { E2eeError } from '../e2ee/errors.ts';
import type { RoomKeyring } from '../e2ee/keyring.ts';
import type { E2eeSession } from '../e2ee/session.ts';
import { createLogger } from '../logger.ts';
import type { RcClient } from '../rc-api/client.ts';

/** The subset of the REST client the syncer needs (lets tests substitute a fake server). */
export type RcReader = Pick<RcClient, 'get' | 'serverNow'>;

import type { Message, Room, Subscription } from '../rc-api/schemas.ts';
import { convertMessage } from './convert.ts';
import type { IndexStore, RoomRecord } from './store.ts';

const log = createLogger({ name: 'sync' });

/** Rocket.Chat purges its deletion trash after 30 days; older cursors cannot see deletions any more. */
const TRASH_TTL_MS = 29 * 24 * 3600 * 1000;
const WATERMARK_MARGIN_MS = 5000;

export interface SyncOptions {
  /** Stop backfilling this room after this many messages in this call (resumes next time). */
  maxMessages?: number;
  /** Drop the room's local copy and start over. */
  full?: boolean;
}

export interface SyncReport {
  rid: string;
  room: string;
  inserted: number;
  updated: number;
  deleted: number;
  undecryptable: number;
  backfillComplete: boolean;
  fullResync: boolean;
  skipped?: 'unchanged';
  error?: string;
}

export interface SyncAllOptions extends SyncOptions {
  rids?: string[];
  /** Skip rooms whose server-side `_updatedAt` did not move since their last sync (fast; may miss old edits). */
  skipUnchanged?: boolean;
}

export function displayNameFor(sub: Subscription | undefined, room: Room | undefined): string {
  if (sub?.t === 'd' || room?.t === 'd') {
    return sub?.fname || sub?.name || room?.usernames?.join(', ') || room?._id || 'direct message';
  }
  return sub?.fname || room?.fname || sub?.name || room?.name || room?._id || sub?.rid || 'unknown';
}

export class Syncer {
  private readonly client: RcReader;
  private readonly session: E2eeSession;
  private readonly store: IndexStore;
  private readonly pageSize: number;
  private subs = new Map<string, Subscription>();
  private rooms = new Map<string, Room>();

  constructor(client: RcReader, session: E2eeSession, store: IndexStore, options: { pageSize?: number } = {}) {
    this.client = client;
    this.session = session;
    this.store = store;
    this.pageSize = options.pageSize ?? 100;
  }

  /** Refreshes room list + key status. */
  async refreshRooms(): Promise<RoomRecord[]> {
    const [subs, rooms] = await Promise.all([this.client.get('subscriptions.get'), this.client.get('rooms.get')]);
    this.subs = new Map(subs.update.map((s) => [s.rid, s]));
    this.rooms = new Map(rooms.update.map((r) => [r._id, r]));
    const records: RoomRecord[] = [];
    for (const sub of subs.update) {
      const room = this.rooms.get(sub.rid);
      const record = await this.roomRecord(sub, room);
      this.store.upsertRoom(record);
      records.push(record);
    }
    const gone = this.store.retainRooms(records.map((r) => r.rid));
    if (gone.length) log.info('removed rooms no longer subscribed', { count: gone.length });
    return records;
  }

  private async roomRecord(sub: Subscription, room: Room | undefined): Promise<RoomRecord> {
    const encrypted = Boolean(room?.encrypted || sub.E2EKey || sub.E2ESuggestedKey);
    let keyStatus: RoomRecord['keyStatus'] = 'not-encrypted';
    let keyDetail: string | null = null;
    if (encrypted) {
      if (!this.session.ready) {
        keyStatus = 'e2ee-unavailable';
        keyDetail = this.session.state.status === 'unavailable' ? this.session.state.reason : null;
      } else {
        const ring = await this.session.keyringFor(sub);
        keyStatus = ring.status;
        if (ring.status === 'missing') keyDetail = 'no room key shared with this account yet';
        if (ring.status === 'suggested')
          keyDetail = 'key offered by another member, not yet accepted (open the official client once)';
        if (ring.status === 'undecryptable') {
          keyDetail = ring.problems.map((p) => `${p.keyId || '(no id)'}: ${p.reason}`).join('; ');
        }
      }
    }
    return {
      rid: sub.rid,
      t: sub.t,
      name: sub.name ?? room?.name ?? null,
      fname: sub.fname ?? room?.fname ?? null,
      displayName: displayNameFor(sub, room),
      encrypted,
      keyStatus,
      keyDetail,
      topic: room?.topic ?? null,
      archived: Boolean(sub.archived || room?.archived),
      lastMessageAt: room?.lm ?? sub.ls ?? null,
      updatedAt: room?._updatedAt ?? sub._updatedAt ?? null,
    };
  }

  private async subscriptionFor(rid: string): Promise<Subscription | undefined> {
    const cached = this.subs.get(rid);
    if (cached) return cached;
    const res = await this.client.get('subscriptions.getOne', { roomId: rid });
    if (res.subscription) this.subs.set(rid, res.subscription);
    return res.subscription ?? undefined;
  }

  /** Keyring for a room, or undefined when E2EE is not available (messages are then reported undecryptable). */
  async keyringFor(rid: string): Promise<RoomKeyring | undefined> {
    if (!this.session.ready) return undefined;
    const sub = await this.subscriptionFor(rid);
    if (!sub) return undefined;
    return this.session.keyringFor(sub);
  }

  private async ingest(messages: Message[], keyring: RoomKeyring | undefined, report: SyncReport): Promise<void> {
    const converted = await Promise.all(messages.map((m) => convertMessage(m, keyring)));
    this.store.transaction(() => {
      for (const { record, deleted } of converted) {
        if (deleted) {
          if (this.store.deleteMessage(record.id)) report.deleted++;
          continue;
        }
        const result = this.store.upsertMessage(record);
        if (result === 'inserted') report.inserted++;
        if (result === 'updated') report.updated++;
        if (result !== 'unchanged' && record.decryption.state === 'undecryptable') report.undecryptable++;
      }
    });
  }

  async syncRoom(rid: string, options: SyncOptions = {}): Promise<SyncReport> {
    const roomRecord = this.store.getRoom(rid);
    const report: SyncReport = {
      rid,
      room: roomRecord?.displayName ?? rid,
      inserted: 0,
      updated: 0,
      deleted: 0,
      undecryptable: 0,
      backfillComplete: false,
      fullResync: false,
    };
    let state = this.store.getSyncState(rid);
    const now = this.client.serverNow ?? Date.now();
    if (
      options.full ||
      (state?.updatedCursor && now - state.updatedCursor > TRASH_TTL_MS) ||
      (state && !state.backfillDone && !state.backfillCursor && !state.updatedCursor)
    ) {
      this.store.resetRoomMessages(rid);
      state = undefined;
      report.fullResync = true;
    }
    state ??= {
      rid,
      backfillCursor: null,
      backfillDone: false,
      updatedCursor: null,
      deletedCursor: null,
      lastSyncAt: null,
    };

    let keyring: RoomKeyring | undefined;
    try {
      keyring = await this.keyringFor(rid);
    } catch (error) {
      if (!(error instanceof E2eeError)) throw error;
    }

    await this.retryUndecryptable(rid, keyring, report);

    // 1) incremental changes since the watermark
    if (state.updatedCursor !== null) {
      const res = await this.client.get('chat.syncMessages', {
        roomId: rid,
        lastUpdate: new Date(state.updatedCursor - 1).toISOString(),
      });
      await this.ingest(res.result.updated, keyring, report);
      for (const d of res.result.deleted) {
        if (this.store.deleteMessage(d._id)) report.deleted++;
      }
      const seen = [
        ...res.result.updated.map((m) => Date.parse(m._updatedAt ?? m.ts)),
        ...res.result.deleted.map((d) => Date.parse(String(d._deletedAt ?? ''))),
      ].filter(Number.isFinite);
      const server = this.client.serverNow;
      state.updatedCursor = Math.max(state.updatedCursor, ...seen, ...(server ? [server - WATERMARK_MARGIN_MS] : []));
      this.store.saveSyncState(state);
    }

    // 2) backfill older history
    let fetched = 0;
    const max = options.maxMessages ?? Number.POSITIVE_INFINITY;
    while (!state.backfillDone && fetched < max) {
      const res = await this.client.get('rooms.history', {
        roomId: rid,
        count: this.pageSize,
        ...(state.backfillCursor ? { previous: state.backfillCursor } : {}),
      });
      if (state.updatedCursor === null) {
        // Anything modified after this point is picked up by the incremental step.
        state.updatedCursor = (this.client.serverNow ?? Date.now()) - WATERMARK_MARGIN_MS;
        state.deletedCursor = state.updatedCursor;
      }
      await this.ingest(res.messages, keyring, report);
      fetched += res.messages.length;
      const tsList = res.messages.map((m) => Date.parse(m.ts)).filter(Number.isFinite);
      if (!res.cursor?.previous || res.messages.length === 0 || tsList.length === 0) {
        state.backfillDone = true;
        state.backfillCursor = null;
      } else {
        const oldest = Math.min(...tsList);
        const previousCursor = state.backfillCursor ? Number(state.backfillCursor) : Number.POSITIVE_INFINITY;
        // Overlap by 1 ms so messages sharing the boundary millisecond are not skipped (upserts dedupe them),
        // but always make progress.
        const next = oldest + 1 < previousCursor ? oldest + 1 : oldest;
        state.backfillCursor = String(next);
      }
      this.store.saveSyncState(state);
    }
    report.backfillComplete = state.backfillDone;
    state.lastSyncAt = new Date().toISOString();
    this.store.saveSyncState(state);
    return report;
  }

  async syncAll(options: SyncAllOptions = {}): Promise<SyncReport[]> {
    const records = await this.refreshRooms();
    const wanted = options.rids ? records.filter((r) => options.rids?.includes(r.rid)) : records;
    const reports: SyncReport[] = [];
    for (const room of wanted) {
      const state = this.store.getSyncState(room.rid);
      if (
        options.skipUnchanged &&
        state?.backfillDone &&
        state.lastSyncAt &&
        room.updatedAt &&
        Date.parse(room.updatedAt) < Date.parse(state.lastSyncAt) - WATERMARK_MARGIN_MS
      ) {
        reports.push({
          rid: room.rid,
          room: room.displayName,
          inserted: 0,
          updated: 0,
          deleted: 0,
          undecryptable: 0,
          backfillComplete: true,
          fullResync: false,
          skipped: 'unchanged',
        });
        continue;
      }
      try {
        reports.push(await this.syncRoom(room.rid, options));
      } catch (error) {
        log.warn('room sync failed', { rid: room.rid, error: error instanceof Error ? error.message : String(error) });
        reports.push({
          rid: room.rid,
          room: room.displayName,
          inserted: 0,
          updated: 0,
          deleted: 0,
          undecryptable: 0,
          backfillComplete: false,
          fullResync: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return reports;
  }

  /** Retries stored undecryptable messages locally when the keyring now holds a key that may open them. */
  private async retryUndecryptable(rid: string, keyring: RoomKeyring | undefined, report: SyncReport): Promise<void> {
    if (!keyring) return;
    const pending = this.store.pendingUndecryptable(rid);
    if (!pending.length) return;
    const held = new Set(keyring.keyIds);
    const candidates = pending.filter((p) => !p.kid || held.has(p.kid) || keyring.current);
    for (const p of candidates) {
      const { record } = await convertMessage(p.raw as Message, keyring);
      if (record.decryption.state !== 'decrypted') continue;
      this.store.upsertMessage(record);
      report.updated++;
    }
  }
}
