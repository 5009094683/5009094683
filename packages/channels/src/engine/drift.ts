import { eq, sql } from 'drizzle-orm';
import { channelConnections, channelRoomMappings, properties, type Database } from '@pms/db';
import {
  addDays,
  datesToRanges,
  emit,
  getAvailability,
  getRateCalendar,
  minDate,
  raiseAlert,
  resolveAlert,
  todayIn,
  type DateRange,
  type DateString,
} from '@pms/domain';
import { ARI_ADAPTER_KINDS, type RemoteAri, type RemoteRestriction } from '../adapter';
import { adapterFor, writeSyncLog, type ConnectionRow } from './connections';
import { effectiveStopSell } from './dispatcher';

export interface DriftCell {
  kind: 'availability' | 'restrictions';
  roomTypeId: string;
  ratePlanId: string | null;
  date: DateString;
  /** Which value differs: `availability`, `rate`, `stopSell` and so on. */
  field: string;
  local: number | boolean | null;
  /** Null when the channel reported nothing for the date. */
  remote: number | boolean | null;
}

export interface DriftResult {
  connectionId: string;
  outcome: 'checked' | 'skipped' | 'failed';
  /** Values compared. */
  compared: number;
  /** Values the channel holds differently from the PMS, confirmed by a second look. */
  drifted: number;
  sample: DriftCell[];
  error?: string;
}

export interface DriftOptions {
  /** How far ahead to compare. Near dates are where a wrong value costs a booking. */
  days?: number;
  now?: Date;
  /** Pause before the confirming second look, so pushes in flight can land. */
  confirmDelayMs?: number;
}

const DEFAULT_DAYS = 60;
const SAMPLE_SIZE = 20;

interface Mappings {
  rooms: { roomTypeId: string; externalId: string }[];
  rates: { ratePlanId: string; externalId: string; roomTypeId: string }[];
}

async function loadMappings(db: Database, connectionId: string): Promise<Mappings> {
  const rooms = await db
    .select({
      roomTypeId: channelRoomMappings.roomTypeId,
      externalId: channelRoomMappings.externalRoomTypeId,
    })
    .from(channelRoomMappings)
    .where(eq(channelRoomMappings.connectionId, connectionId));
  const { rows: rates } = await db.execute<{
    rate_plan_id: string;
    external_id: string;
    room_type_id: string;
  }>(sql`
    SELECT m.rate_plan_id, m.external_rate_plan_id AS external_id, p.room_type_id
    FROM channel_rate_mappings m JOIN rate_plans p ON p.id = m.rate_plan_id
    WHERE m.connection_id = ${connectionId}
  `);
  return {
    rooms,
    rates: rates.map((r) => ({
      ratePlanId: r.rate_plan_id,
      externalId: r.external_id,
      roomTypeId: r.room_type_id,
    })),
  };
}

/** Dates with a change still on its way to the channel. Differences there are expected, not drift. */
async function pendingCells(
  db: Database,
  connection: ConnectionRow,
): Promise<(cell: DriftCell) => boolean> {
  const { rows } = await db.execute<{
    kind: string;
    room_type_id: string;
    rate_plan_id: string | null;
    date_from: string;
    date_to: string;
  }>(sql`
    SELECT kind, room_type_id, rate_plan_id, date_from::text, date_to::text
    FROM sync_queue WHERE connection_id = ${connection.id}
    UNION ALL
    SELECT CASE kind WHEN 'ari.availability' THEN 'availability' ELSE 'restrictions' END,
           (payload->>'roomTypeId')::uuid, (payload->>'ratePlanId')::uuid,
           payload->>'from', payload->>'to'
    FROM outbox WHERE property_id = ${connection.propertyId} AND kind IN ('ari.availability', 'ari.restrictions')
  `);
  return (cell) =>
    rows.some(
      (r) =>
        r.kind === cell.kind &&
        (cell.kind === 'availability'
          ? r.room_type_id === cell.roomTypeId
          : r.rate_plan_id === cell.ratePlanId) &&
        cell.date >= r.date_from &&
        cell.date < r.date_to,
    );
}

const RESTRICTION_FIELDS = [
  'rate',
  'minStayArrival',
  'minStayThrough',
  'maxStay',
  'closedToArrival',
  'closedToDeparture',
  'stopSell',
] as const satisfies readonly (keyof RemoteRestriction)[];

/** Compares what the PMS holds now with what the channel reported. */
async function compare(
  db: Database,
  connection: ConnectionRow,
  mappings: Mappings,
  window: DateRange,
  remote: RemoteAri,
): Promise<{ compared: number; cells: DriftCell[] }> {
  const cells: DriftCell[] = [];
  let compared = 0;

  if (mappings.rooms.length > 0) {
    const local = await getAvailability(db, {
      propertyId: connection.propertyId,
      range: window,
      roomTypeIds: mappings.rooms.map((m) => m.roomTypeId),
    });
    const externalOf = new Map(mappings.rooms.map((m) => [m.roomTypeId, m.externalId]));
    for (const day of local) {
      const theirs = remote.availability[externalOf.get(day.roomTypeId)!]?.[day.date];
      const ours = Math.max(0, day.available);
      compared++;
      if (theirs !== ours) {
        cells.push({
          kind: 'availability',
          roomTypeId: day.roomTypeId,
          ratePlanId: null,
          date: day.date,
          field: 'availability',
          local: ours,
          remote: theirs ?? null,
        });
      }
    }
  }

  if (mappings.rates.length > 0) {
    const local = await getRateCalendar(db, {
      propertyId: connection.propertyId,
      range: window,
      ratePlanIds: mappings.rates.map((m) => m.ratePlanId),
    });
    const rateOf = new Map(mappings.rates.map((m) => [m.ratePlanId, m]));
    for (const day of local) {
      const mapping = rateOf.get(day.ratePlanId)!;
      const theirs = remote.restrictions[mapping.externalId]?.[day.date];
      for (const field of RESTRICTION_FIELDS) {
        // A channel that does not report a field cannot be compared on it.
        if (theirs && theirs[field] === undefined) continue;
        // An unpriced night is sent closed and without a price, so there is no price to compare.
        if (field === 'rate' && day.rate <= 0) continue;
        compared++;
        const ours = field === 'stopSell' ? effectiveStopSell(day) : day[field];
        const value = theirs ? (theirs[field] ?? null) : null;
        if (!theirs || value !== ours) {
          cells.push({
            kind: 'restrictions',
            roomTypeId: mapping.roomTypeId,
            ratePlanId: day.ratePlanId,
            date: day.date,
            field,
            local: ours,
            remote: value,
          });
          // One differing field is enough to re-send the day.
          if (!theirs) break;
        }
      }
    }
  }
  return { compared, cells };
}

function spanOf(cells: DriftCell[]): DateRange {
  const dates = cells.map((c) => c.date).sort();
  return { from: dates[0]!, to: addDays(dates[dates.length - 1]!, 1) };
}

const cellKey = (c: DriftCell): string =>
  `${c.kind}|${c.roomTypeId}|${c.ratePlanId ?? ''}|${c.date}|${c.field}`;

/**
 * Compares what the channel holds with what the PMS holds for the coming
 * weeks, and re-sends whatever differs.
 *
 * Pushes are designed so this should never find anything; it exists because a
 * channel can lose an update, someone can edit values in the channel's own
 * screen, or a mapping can be changed on their side. A difference is only
 * counted after a second look confirms it, so a change that was on its way
 * during the first look is not mistaken for drift.
 */
export async function checkDrift(
  db: Database,
  connectionId: string,
  options: DriftOptions = {},
): Promise<DriftResult> {
  const now = options.now ?? new Date();
  const result: DriftResult = {
    connectionId,
    outcome: 'skipped',
    compared: 0,
    drifted: 0,
    sample: [],
  };
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId));
  if (!connection || connection.status !== 'active') return result;
  // A full sync is about to restate everything; comparing before it lands only finds what it will fix.
  if (connection.fullSyncRequestedAt) return result;
  const adapter = adapterFor(connection);
  if (!adapter.capabilities.ari || !adapter.fetchAri) return result;
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, connection.propertyId));
  if (!property) return result;

  const today = todayIn(property.timezone, now);
  const horizonEnd = addDays(
    today,
    Math.min(property.inventoryHorizonDays, adapter.horizonDays ?? Infinity),
  );
  const window: DateRange = {
    from: today,
    to: minDate(addDays(today, options.days ?? DEFAULT_DAYS), horizonEnd),
  };
  const mappings = await loadMappings(db, connectionId);
  if (mappings.rooms.length === 0 && mappings.rates.length === 0) return result;

  const fetchAri = adapter.fetchAri.bind(adapter);
  const started = Date.now();
  let confirmed: DriftCell[];
  try {
    const first = await compare(
      db,
      connection,
      mappings,
      window,
      await fetchAri(window, property.currency),
    );
    result.compared = first.compared;
    let candidates = first.cells;
    if (candidates.length > 0) {
      const pending = await pendingCells(db, connection);
      candidates = candidates.filter((c) => !pending(c));
    }
    if (candidates.length === 0) {
      confirmed = [];
    } else {
      if (options.confirmDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.confirmDelayMs));
      const span = spanOf(candidates);
      const second = await compare(
        db,
        connection,
        mappings,
        span,
        await fetchAri(span, property.currency),
      );
      const pending = await pendingCells(db, connection);
      const wanted = new Set(candidates.map(cellKey));
      confirmed = second.cells.filter((c) => wanted.has(cellKey(c)) && !pending(c));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeSyncLog(db, {
      connectionId,
      propertyId: connection.propertyId,
      direction: 'out',
      operation: 'drift.check',
      status: 'retry',
      durationMs: Date.now() - started,
      error: message,
    });
    return { ...result, outcome: 'failed', error: message };
  }

  result.outcome = 'checked';
  result.drifted = confirmed.length;
  result.sample = confirmed.slice(0, SAMPLE_SIZE);

  await db.transaction(async (tx) => {
    if (confirmed.length > 0) {
      // Queue the differing dates; the dispatcher re-sends their current values.
      const groups = new Map<
        string,
        {
          kind: DriftCell['kind'];
          roomTypeId: string;
          ratePlanId: string | null;
          dates: Set<string>;
        }
      >();
      for (const cell of confirmed) {
        const key = `${cell.kind}|${cell.roomTypeId}|${cell.ratePlanId ?? ''}`;
        const group = groups.get(key) ?? {
          kind: cell.kind,
          roomTypeId: cell.roomTypeId,
          ratePlanId: cell.ratePlanId,
          dates: new Set(),
        };
        group.dates.add(cell.date);
        groups.set(key, group);
      }
      const rows = [...groups.values()].flatMap((g) =>
        datesToRanges([...g.dates].sort()).map((r) => ({
          kind: g.kind,
          room_type_id: g.roomTypeId,
          rate_plan_id: g.ratePlanId,
          date_from: r.from,
          date_to: r.to,
        })),
      );
      await tx.execute(sql`
        INSERT INTO sync_queue (connection_id, kind, room_type_id, rate_plan_id, date_from, date_to)
        SELECT ${connectionId}, e.kind, e.room_type_id, e.rate_plan_id, e.date_from, e.date_to
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          AS e(kind text, room_type_id uuid, rate_plan_id uuid, date_from date, date_to date)
      `);
    }
    await tx
      .update(channelConnections)
      .set({ lastDriftCheckAt: now, lastDriftCount: confirmed.length })
      .where(eq(channelConnections.id, connectionId));
    await writeSyncLog(tx, {
      connectionId,
      propertyId: connection.propertyId,
      direction: 'out',
      operation: 'drift.check',
      status: 'ok',
      itemCount: confirmed.length,
      durationMs: Date.now() - started,
      detail: {
        compared: result.compared,
        drifted: confirmed.length,
        from: window.from,
        to: window.to,
        sample: result.sample.slice(0, 5),
      },
    });
    if (confirmed.length > 0) {
      const lines = result.sample
        .slice(0, 8)
        .map((c) => `${c.date} ${c.field}: PMS ${String(c.local)}, channel ${String(c.remote)}`);
      await raiseAlert(tx, {
        orgId: connection.orgId,
        propertyId: connection.propertyId,
        kind: 'sync_drift',
        severity: 'warning',
        title: `${property.name}: ${confirmed.length} value(s) on the channels did not match the PMS`,
        body:
          `${lines.join('\n')}${confirmed.length > lines.length ? '\n…' : ''}\n\n` +
          'The PMS values have been sent again. If this keeps happening, someone may be editing availability or rates directly in the channel manager or an extranet.',
        entityType: 'channel_connection',
        entityId: connectionId,
        dedupeKey: `sync_drift:${connectionId}`,
        metadata: { drifted: confirmed.length, sample: result.sample },
      });
    } else {
      await resolveAlert(tx, connection.orgId, `sync_drift:${connectionId}`);
    }
    await emit(tx, connection.orgId, [
      { kind: 'sync.updated', propertyId: connection.propertyId, payload: { connectionId } },
    ]);
  });
  return result;
}

export interface DriftSchedule {
  /** Compare again once the last comparison is this old. */
  maxAgeHours: number;
  /** Wait this long after a full sync, so the channel has processed it before being compared. */
  settleMinutes: number;
}

export const DEFAULT_DRIFT_SCHEDULE: DriftSchedule = { maxAgeHours: 24, settleMinutes: 10 };

/**
 * Connections due a comparison: never compared, compared too long ago, or
 * fully restated since the last comparison (so every full sync is verified).
 */
export async function connectionsDueForDriftCheck(
  db: Database,
  schedule: DriftSchedule = DEFAULT_DRIFT_SCHEDULE,
  now: Date = new Date(),
): Promise<string[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM channel_connections
    WHERE status = 'active' AND full_sync_requested_at IS NULL
      AND adapter IN (${sql.join(
        ARI_ADAPTER_KINDS.map((k) => sql`${k}`),
        sql`, `,
      )})
      AND (last_full_sync_at IS NULL
           OR last_full_sync_at < ${at} - make_interval(mins => ${schedule.settleMinutes}))
      AND (last_drift_check_at IS NULL
           OR last_drift_check_at < ${at} - make_interval(hours => ${schedule.maxAgeHours})
           OR last_drift_check_at < last_full_sync_at)
  `);
  return rows.map((r) => r.id);
}
