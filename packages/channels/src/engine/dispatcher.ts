import { eq, sql } from 'drizzle-orm';
import {
  channelConnections,
  channelRateMappings,
  channelRoomMappings,
  properties,
  type Database,
  type Transaction,
} from '@pms/db';
import {
  addDays,
  emit,
  getAvailability,
  getRateCalendar,
  maxDate,
  mergeRanges,
  minDate,
  parsePgTimestamp,
  raiseAlert,
  resolveAlert,
  todayIn,
  type DateRange,
  type DateString,
} from '@pms/domain';
import {
  ARI_ADAPTER_KINDS,
  ChannelError,
  type AriBatch,
  type AvailabilityUpdate,
  type RestrictionUpdate,
} from '../adapter';
import { adapterFor, writeSyncLog, type ConnectionRow } from './connections';

export type DispatchOutcome =
  /** Values were sent and accepted. */
  | 'pushed'
  /** Nothing was waiting. */
  | 'idle'
  /** Another worker holds this connection, or it is switched off. */
  | 'skipped'
  /** Inside a back-off or rate-limit pause. */
  | 'deferred'
  /** The channel did not accept the push; it will be retried. */
  | 'failed';

export interface DispatchResult {
  connectionId: string;
  outcome: DispatchOutcome;
  items?: number;
  full?: boolean;
  error?: string;
}

/** Failures in a row before the connection is marked as failing and an alert is raised. */
const FAILURES_BEFORE_ALERT = 3;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_QUEUE_ROWS = 5000;

function backoffMs(failures: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, failures - 1));
  // Jitter keeps many connections that failed together from retrying together.
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Collapses consecutive days that carry the same value into inclusive ranges. */
export function compressDays<T>(
  days: { date: DateString; value: T }[],
  same: (a: T, b: T) => boolean,
): { from: DateString; to: DateString; value: T }[] {
  const out: { from: DateString; to: DateString; value: T }[] = [];
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === day.date && same(last.value, day.value)) {
      last.to = day.date;
    } else {
      out.push({ from: day.date, to: day.date, value: day.value });
    }
  }
  return out;
}

/** A night without a price is never offered for sale, whatever its stop-sell flag says. */
export function effectiveStopSell(day: { stopSell: boolean; rate: number }): boolean {
  return day.stopSell || day.rate <= 0;
}

function inRanges(date: DateString, ranges: DateRange[]): boolean {
  return ranges.some((r) => date >= r.from && date < r.to);
}

/** Clips ranges to the window channels accept: from today to the end of the property's horizon. */
function clip(ranges: DateRange[], window: DateRange): DateRange[] {
  return mergeRanges(
    ranges
      .map((r) => ({ from: maxDate(r.from, window.from), to: minDate(r.to, window.to) }))
      .filter((r) => r.from < r.to),
  );
}

interface Work {
  full: boolean;
  /** Work-list rows this dispatch covers; removed once the channel accepts the push. */
  queueIds: number[];
  /** For a full sync: every row up to this id is covered. */
  queueUpTo: number | null;
  oldestChange: Date | null;
  roomRanges: Map<string, DateRange[]>;
  rateRanges: Map<string, DateRange[]>;
}

async function gatherWork(
  tx: Transaction,
  connection: ConnectionRow,
  window: DateRange,
  roomMap: Map<string, string>,
  rateMap: Map<string, string>,
): Promise<Work> {
  const work: Work = {
    full: connection.fullSyncRequestedAt !== null,
    queueIds: [],
    queueUpTo: null,
    oldestChange: null,
    roomRanges: new Map(),
    rateRanges: new Map(),
  };
  if (work.full) {
    const { rows } = await tx.execute<{ max: string | null; oldest: string | null }>(
      sql`SELECT max(id)::text AS max, min(changed_at)::text AS oldest FROM sync_queue WHERE connection_id = ${connection.id}`,
    );
    work.queueUpTo = rows[0]?.max ? Number(rows[0].max) : null;
    work.oldestChange = parsePgTimestamp(rows[0]?.oldest ?? null);
    for (const roomTypeId of roomMap.keys()) work.roomRanges.set(roomTypeId, [window]);
    for (const ratePlanId of rateMap.keys()) work.rateRanges.set(ratePlanId, [window]);
    return work;
  }
  const { rows } = await tx.execute<{
    id: string;
    kind: 'availability' | 'restrictions';
    room_type_id: string;
    rate_plan_id: string | null;
    date_from: string;
    date_to: string;
    changed_at: string;
  }>(sql`
    SELECT id, kind, room_type_id, rate_plan_id, date_from::text, date_to::text, changed_at::text
    FROM sync_queue WHERE connection_id = ${connection.id}
    ORDER BY id LIMIT ${MAX_QUEUE_ROWS}
  `);
  for (const row of rows) {
    work.queueIds.push(Number(row.id));
    const changedAt = parsePgTimestamp(row.changed_at)!;
    if (!work.oldestChange || changedAt < work.oldestChange) work.oldestChange = changedAt;
    const range = { from: row.date_from, to: row.date_to };
    if (row.kind === 'availability') {
      // A mapping removed since the change was queued simply drops out here.
      if (!roomMap.has(row.room_type_id)) continue;
      work.roomRanges.set(row.room_type_id, [
        ...(work.roomRanges.get(row.room_type_id) ?? []),
        range,
      ]);
    } else if (row.rate_plan_id && rateMap.has(row.rate_plan_id)) {
      work.rateRanges.set(row.rate_plan_id, [
        ...(work.rateRanges.get(row.rate_plan_id) ?? []),
        range,
      ]);
    }
  }
  for (const [id, ranges] of work.roomRanges) work.roomRanges.set(id, clip(ranges, window));
  for (const [id, ranges] of work.rateRanges) work.rateRanges.set(id, clip(ranges, window));
  return work;
}

function span(ranges: Iterable<DateRange[]>): DateRange | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const list of ranges) {
    for (const r of list) {
      from = from === null ? r.from : minDate(from, r.from);
      to = to === null ? r.to : maxDate(to, r.to);
    }
  }
  return from && to ? { from, to } : null;
}

/**
 * Reads the values the channel should now hold for the ranges in `work`.
 * These are read at send time, which is what makes a retry or a late
 * dispatch correct: it always carries the latest state, not the state at
 * the time of the change.
 */
async function buildBatch(
  tx: Transaction,
  connection: ConnectionRow,
  currency: string,
  work: Work,
  roomMap: Map<string, string>,
  rateMap: Map<string, string>,
): Promise<AriBatch> {
  const availability: AvailabilityUpdate[] = [];
  const roomSpan = span(work.roomRanges.values());
  if (roomSpan) {
    const days = await getAvailability(tx, {
      propertyId: connection.propertyId,
      range: roomSpan,
      roomTypeIds: [...work.roomRanges.keys()],
    });
    for (const [roomTypeId, ranges] of work.roomRanges) {
      const mine = days
        .filter((d) => d.roomTypeId === roomTypeId && inRanges(d.date, ranges))
        .map((d) => ({ date: d.date, value: Math.max(0, d.available) }));
      for (const run of compressDays(mine, (a, b) => a === b)) {
        availability.push({
          roomTypeId,
          externalRoomTypeId: roomMap.get(roomTypeId)!,
          dateFrom: run.from,
          dateTo: run.to,
          availability: run.value,
        });
      }
    }
  }

  const restrictions: RestrictionUpdate[] = [];
  const rateSpan = span(work.rateRanges.values());
  if (rateSpan) {
    const days = await getRateCalendar(tx, {
      propertyId: connection.propertyId,
      range: rateSpan,
      ratePlanIds: [...work.rateRanges.keys()],
    });
    type Value = Omit<
      RestrictionUpdate,
      'ratePlanId' | 'externalRatePlanId' | 'dateFrom' | 'dateTo' | 'currency'
    >;
    for (const [ratePlanId, ranges] of work.rateRanges) {
      const mine = days
        .filter((d) => d.ratePlanId === ratePlanId && inRanges(d.date, ranges))
        .map((d) => ({
          date: d.date,
          value: {
            rate: d.rate,
            minStayArrival: d.minStayArrival,
            minStayThrough: d.minStayThrough,
            maxStay: d.maxStay,
            closedToArrival: d.closedToArrival,
            closedToDeparture: d.closedToDeparture,
            stopSell: effectiveStopSell(d),
          } satisfies Value,
        }));
      const same = (a: Value, b: Value) =>
        a.rate === b.rate &&
        a.minStayArrival === b.minStayArrival &&
        a.minStayThrough === b.minStayThrough &&
        a.maxStay === b.maxStay &&
        a.closedToArrival === b.closedToArrival &&
        a.closedToDeparture === b.closedToDeparture &&
        a.stopSell === b.stopSell;
      for (const run of compressDays(mine, same)) {
        restrictions.push({
          ratePlanId,
          externalRatePlanId: rateMap.get(ratePlanId)!,
          dateFrom: run.from,
          dateTo: run.to,
          currency,
          ...run.value,
        });
      }
    }
  }
  return { availability, restrictions, full: work.full };
}

async function clearWork(tx: Transaction, connectionId: string, work: Work): Promise<void> {
  if (work.full) {
    if (work.queueUpTo !== null) {
      await tx.execute(
        sql`DELETE FROM sync_queue WHERE connection_id = ${connectionId} AND id <= ${work.queueUpTo}`,
      );
    }
    return;
  }
  if (work.queueIds.length > 0) {
    await tx.execute(
      sql`DELETE FROM sync_queue WHERE id IN (${sql.join(
        work.queueIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
}

/**
 * Sends one connection's pending changes (or its whole horizon, when a full
 * sync was requested) to its channel.
 *
 * Only one worker dispatches a connection at a time, so the channel receives
 * a connection's pushes in the order they were built. Work-list rows are
 * removed only after the channel accepts the push; on failure they stay and
 * the connection backs off.
 */
export async function dispatchConnection(
  db: Database,
  connectionId: string,
  now: Date = new Date(),
): Promise<DispatchResult> {
  return db.transaction(async (tx) => {
    const { rows: lock } = await tx.execute<{ ok: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${`pms-sync:${connectionId}`})) AS ok`,
    );
    if (!lock[0]?.ok) return { connectionId, outcome: 'skipped' };

    const [connection] = await tx
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connectionId));
    if (!connection || (connection.status !== 'active' && connection.status !== 'error')) {
      return { connectionId, outcome: 'skipped' };
    }
    if (connection.nextAttemptAt && connection.nextAttemptAt > now)
      return { connectionId, outcome: 'deferred' };
    const adapter = adapterFor(connection);
    if (!adapter.capabilities.ari) return { connectionId, outcome: 'skipped' };

    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, connection.propertyId));
    if (!property) return { connectionId, outcome: 'skipped' };
    const today = todayIn(property.timezone, now);
    const window: DateRange = {
      from: today,
      to: addDays(today, Math.min(property.inventoryHorizonDays, adapter.horizonDays ?? Infinity)),
    };

    const roomMap = new Map(
      (
        await tx
          .select()
          .from(channelRoomMappings)
          .where(eq(channelRoomMappings.connectionId, connectionId))
      ).map((m) => [m.roomTypeId, m.externalRoomTypeId]),
    );
    const rateMap = new Map(
      (
        await tx
          .select()
          .from(channelRateMappings)
          .where(eq(channelRateMappings.connectionId, connectionId))
      ).map((m) => [m.ratePlanId, m.externalRatePlanId]),
    );

    const work = await gatherWork(tx, connection, window, roomMap, rateMap);
    if (!work.full && work.queueIds.length === 0) return { connectionId, outcome: 'idle' };

    const batch = await buildBatch(tx, connection, property.currency, work, roomMap, rateMap);
    const items = batch.availability.length + batch.restrictions.length;
    if (items === 0) {
      // Everything queued lay outside the sellable window (past dates, beyond the horizon).
      await clearWork(tx, connectionId, work);
      if (work.full) {
        await tx
          .update(channelConnections)
          .set({ fullSyncRequestedAt: null, lastFullSyncAt: now })
          .where(eq(channelConnections.id, connectionId));
      }
      return { connectionId, outcome: 'idle' };
    }

    const started = Date.now();
    const operation = work.full ? 'ari.full_sync' : 'ari.push';
    try {
      const result = await adapter.pushAri(batch);
      await clearWork(tx, connectionId, work);
      await tx
        .update(channelConnections)
        .set({
          status: 'active',
          lastPushAt: now,
          lastSuccessAt: now,
          lastError: null,
          consecutiveFailures: 0,
          nextAttemptAt:
            adapter.minPushIntervalMs > 0
              ? new Date(now.getTime() + adapter.minPushIntervalMs)
              : null,
          ...(work.full ? { fullSyncRequestedAt: null, lastFullSyncAt: now } : {}),
        })
        .where(eq(channelConnections.id, connectionId));
      await writeSyncLog(tx, {
        connectionId,
        propertyId: connection.propertyId,
        direction: 'out',
        operation,
        status: 'ok',
        itemCount: items,
        durationMs: Date.now() - started,
        lagMs: work.oldestChange
          ? Math.max(0, now.getTime() - work.oldestChange.getTime())
          : undefined,
        detail: {
          availability: batch.availability.length,
          restrictions: batch.restrictions.length,
          references: result.references.slice(0, 20),
          warnings: result.warnings.slice(0, 20),
        },
      });
      await resolveAlert(tx, connection.orgId, `sync_failure:${connectionId}`);
      if (result.warnings.length > 0) {
        await raiseAlert(tx, {
          orgId: connection.orgId,
          propertyId: connection.propertyId,
          kind: 'sync_failure',
          severity: 'warning',
          title: `${property.name}: ${result.warnings.length} value(s) did not reach the channels as set`,
          body: result.warnings.slice(0, 5).join('\n'),
          entityType: 'channel_connection',
          entityId: connectionId,
          dedupeKey: `sync_warning:${connectionId}`,
        });
      } else {
        await resolveAlert(tx, connection.orgId, `sync_warning:${connectionId}`);
      }
      if (connection.status === 'error' || work.full) {
        await emit(tx, connection.orgId, [
          { kind: 'sync.updated', propertyId: connection.propertyId, payload: { connectionId } },
        ]);
      }
      return { connectionId, outcome: 'pushed', items, full: work.full };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = !(err instanceof ChannelError) || err.retryable;
      const failures = connection.consecutiveFailures + 1;
      const wait =
        err instanceof ChannelError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : retryable
            ? backoffMs(failures)
            : MAX_BACKOFF_MS;
      const rateLimited = err instanceof ChannelError && err.status === 429;
      // Being asked to slow down is the channel working as designed, not a failure of the connection.
      const failing = !rateLimited && (!retryable || failures >= FAILURES_BEFORE_ALERT);
      await tx
        .update(channelConnections)
        .set({
          status: failing ? 'error' : connection.status,
          lastError: message.slice(0, 1000),
          lastErrorAt: now,
          consecutiveFailures: rateLimited ? connection.consecutiveFailures : failures,
          nextAttemptAt: new Date(now.getTime() + wait),
        })
        .where(eq(channelConnections.id, connectionId));
      await writeSyncLog(tx, {
        connectionId,
        propertyId: connection.propertyId,
        direction: 'out',
        operation,
        status: retryable ? 'retry' : 'error',
        itemCount: items,
        durationMs: Date.now() - started,
        error: message,
        detail: { retryInMs: wait, status: err instanceof ChannelError ? err.status : undefined },
      });
      if (failing) {
        await raiseAlert(tx, {
          orgId: connection.orgId,
          propertyId: connection.propertyId,
          kind: 'sync_failure',
          severity: 'critical',
          title: `${property.name}: updates are not reaching the booking channels`,
          body:
            `${message}\n\n` +
            (retryable
              ? `${failures} attempts have failed. The system keeps retrying; availability on the channels may be out of date until it succeeds.`
              : 'This will not fix itself: check the connection settings. Availability on the channels may be out of date.'),
          entityType: 'channel_connection',
          entityId: connectionId,
          dedupeKey: `sync_failure:${connectionId}`,
          metadata: { failures, retryable },
        });
        if (connection.status !== 'error') {
          await emit(tx, connection.orgId, [
            { kind: 'sync.updated', propertyId: connection.propertyId, payload: { connectionId } },
          ]);
        }
      }
      return { connectionId, outcome: 'failed', items, full: work.full, error: message };
    }
  });
}

/** Connections with something to send whose pause (if any) has passed. */
export async function connectionsDue(db: Database, now: Date = new Date()): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM channel_connections c
    WHERE c.status IN ('active', 'error')
      AND c.adapter IN (${sql.join(
        ARI_ADAPTER_KINDS.map((k) => sql`${k}`),
        sql`, `,
      )})
      AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ${now.toISOString()}::timestamptz)
      AND (c.full_sync_requested_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM sync_queue q WHERE q.connection_id = c.id))
  `);
  return rows.map((r) => r.id);
}

/** When the next paused connection with pending work becomes due, so the worker can sleep until then. */
export async function nextDispatchAt(db: Database): Promise<Date | null> {
  const { rows } = await db.execute<{ at: string | null }>(sql`
    SELECT min(c.next_attempt_at)::text AS at FROM channel_connections c
    WHERE c.status IN ('active', 'error')
      AND c.next_attempt_at IS NOT NULL
      AND (c.full_sync_requested_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM sync_queue q WHERE q.connection_id = c.id))
  `);
  return parsePgTimestamp(rows[0]?.at ?? null);
}

/** Dispatches every due connection, a few at a time. */
export async function dispatchDue(
  db: Database,
  now: Date = new Date(),
  concurrency = 4,
): Promise<DispatchResult[]> {
  const ids = await connectionsDue(db, now);
  const results: DispatchResult[] = [];
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const id = ids[next++];
      if (!id) return;
      try {
        results.push(await dispatchConnection(db, id, now));
      } catch (err) {
        // A database fault while dispatching one connection must not stop the others.
        results.push({ connectionId: id, outcome: 'failed', error: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, run));
  return results;
}
