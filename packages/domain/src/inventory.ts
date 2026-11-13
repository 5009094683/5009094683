import { sql, type SQL } from 'drizzle-orm';
import { INVENTORY_HOLDING_STATUSES, sqlList, type DbOrTx, type Transaction } from '@pms/db';
import { resolveAlert } from './alerts';
import {
  datesToRanges,
  diffDays,
  eachDate,
  mergeRanges,
  type DateRange,
  type DateString,
} from './dates';
import { DomainError, validationError } from './errors';
import { assignWaitingRooms, settleOverbookedReservations } from './occupancy';
import { emit, type OutboxEvent } from './outbox';
import { dateArray, uuidArray } from './sqlx';

/**
 * The inventory ledger.
 *
 * `inventory_days` holds one row per room type per night. Its counts are never
 * incremented or decremented; they are recomputed from the rows that cause
 * them (reservation rooms, blocks, unit occupancy) inside the same transaction
 * as the change, while the affected ledger rows are locked. That gives three
 * properties:
 *
 *  - Two transactions that touch the same room type and night run one after
 *    the other, so the second sees the first's booking before deciding.
 *  - The counts cannot drift from their sources, because every write rebuilds
 *    them from scratch.
 *  - Availability changes are known exactly, so exactly those date ranges are
 *    queued for the channels, in the same transaction.
 *
 * All code that creates, moves or removes a reservation room, a block or a
 * unit goes through `withInventoryLock`.
 */

export interface InventoryScope {
  roomTypeId: string;
  range: DateRange;
}

export interface LedgerRow {
  roomTypeId: string;
  propertyId: string;
  date: DateString;
  total: number;
  sold: number;
  blocked: number;
  outOfOrder: number;
  linked: number;
  overbooked: number;
}

export function availableOf(
  row: Pick<LedgerRow, 'total' | 'sold' | 'blocked' | 'outOfOrder' | 'linked'>,
): number {
  return row.total - row.sold - row.blocked - row.outOfOrder - row.linked;
}

export interface OverbookedNight {
  roomTypeId: string;
  date: DateString;
  /** How many reservations exceed capacity on this night after the change. */
  overbooked: number;
}

export interface InventoryOutcome<T> {
  value: T;
  /** Nights whose overbooked count rose because of this change (only possible when allowed). */
  newlyOverbooked: OverbookedNight[];
  /** Ledger rows whose values changed. */
  changed: LedgerRow[];
}

interface Segment {
  room_type_id: string;
  d_from: DateString;
  d_to: DateString;
}

type RawLedgerRow = {
  room_type_id: string;
  property_id: string;
  date: string;
  total: number;
  sold: number;
  blocked: number;
  out_of_order: number;
  linked: number;
  overbooked: number;
};

const MAX_SEGMENT_DAYS = 1100;
const HOLDING = sqlList(INVENTORY_HOLDING_STATUSES);

function toLedgerRow(r: RawLedgerRow): LedgerRow {
  return {
    roomTypeId: r.room_type_id,
    propertyId: r.property_id,
    date: r.date,
    total: r.total,
    sold: r.sold,
    blocked: r.blocked,
    outOfOrder: r.out_of_order,
    linked: r.linked,
    overbooked: r.overbooked,
  };
}

const key = (roomTypeId: string, date: string) => `${roomTypeId}|${date}`;

/**
 * Room types whose availability depends on each other through linked units
 * (a villa sold whole and by bedroom). Given some room types, returns for
 * every room type of the same properties the set it is linked with, itself
 * included: the group that must be locked and recomputed together.
 */
export async function linkedRoomTypeGroups(
  tx: DbOrTx,
  roomTypeIds: string[],
): Promise<Map<string, Set<string>>> {
  const groups = new Map<string, Set<string>>();
  if (roomTypeIds.length === 0) return groups;
  const { rows } = await tx.execute<{ parent_type: string; child_type: string }>(sql`
    SELECT DISTINCT p.room_type_id AS parent_type, c.room_type_id AS child_type
    FROM units c
    JOIN units p ON p.id = c.parent_unit_id
    WHERE c.active AND p.active
      AND c.property_id IN (SELECT property_id FROM room_types WHERE id = ANY(${uuidArray(roomTypeIds)}))
  `);
  // Union the linked types into connected groups.
  for (const { parent_type: a, child_type: b } of rows) {
    const merged = new Set([...(groups.get(a) ?? [a]), ...(groups.get(b) ?? [b])]);
    for (const member of merged) groups.set(member, merged);
  }
  return groups;
}

/**
 * Stays that should have a physical unit but have none (they arrived over
 * capacity) and overlap the given nights. If this change frees a unit they
 * can take it, so their own dates are locked along with the change.
 */
async function waitingStayScopes(tx: DbOrTx, segments: Segment[]): Promise<InventoryScope[]> {
  const { rows } = await tx.execute<{
    room_type_id: string;
    check_in: string;
    check_out: string;
  }>(sql`
    SELECT DISTINCT rr.room_type_id, rr.check_in::text, rr.check_out::text
    FROM reservation_rooms rr
    JOIN room_types rt ON rt.id = rr.room_type_id AND rt.assignment = 'at_booking'
    JOIN unnest(
           ${uuidArray(segments.map((s) => s.room_type_id))},
           ${dateArray(segments.map((s) => s.d_from))},
           ${dateArray(segments.map((s) => s.d_to))}
         ) AS s(room_type_id, d_from, d_to)
      ON s.room_type_id = rr.room_type_id AND rr.check_in < s.d_to AND rr.check_out > s.d_from
    WHERE rr.unit_id IS NULL AND rr.status IN (${sql.raw(HOLDING)})
  `);
  return rows.map((r) => ({
    roomTypeId: r.room_type_id,
    range: { from: r.check_in, to: r.check_out },
  }));
}

function toSegments(scopes: InventoryScope[]): Segment[] {
  const byType = new Map<string, DateRange[]>();
  for (const scope of scopes) {
    const nights = diffDays(scope.range.from, scope.range.to);
    if (nights <= 0) throw validationError('A date range must end after it starts');
    if (nights > MAX_SEGMENT_DAYS)
      throw validationError(`A date range may span at most ${MAX_SEGMENT_DAYS} days`);
    const list = byType.get(scope.roomTypeId) ?? [];
    list.push(scope.range);
    byType.set(scope.roomTypeId, list);
  }
  const segments: Segment[] = [];
  for (const roomTypeId of [...byType.keys()].sort()) {
    for (const range of mergeRanges(byType.get(roomTypeId)!)) {
      segments.push({ room_type_id: roomTypeId, d_from: range.from, d_to: range.to });
    }
  }
  return segments;
}

/**
 * Every (room type, night) of the segments as a row source `d`. The pairs are
 * expanded here and sent as two array parameters, rather than generated in
 * SQL, so the planner knows exactly how many nights it is joining against.
 */
function nightRows(segments: Segment[]): SQL {
  // Segments that share a date range (the usual case: one stay and its linked
  // room types, or a whole horizon) become one types x dates product.
  const groups = new Map<string, { from: DateString; to: DateString; typeIds: string[] }>();
  for (const segment of segments) {
    const groupKey = `${segment.d_from}|${segment.d_to}`;
    const group = groups.get(groupKey) ?? { from: segment.d_from, to: segment.d_to, typeIds: [] };
    group.typeIds.push(segment.room_type_id);
    groups.set(groupKey, group);
  }
  const parts = [...groups.values()].map(
    (g) => sql`
      SELECT t.room_type_id, n.date
      FROM unnest(${uuidArray(g.typeIds)}) AS t(room_type_id)
      CROSS JOIN unnest(${dateArray(eachDate(g.from, g.to))}) AS n(date)`,
  );
  return sql`(${sql.join(parts, sql` UNION ALL `)}) AS d`;
}

/**
 * The counts the ledger should hold for every night in `segments`, derived
 * from reservations, blocks and occupancy. `linkedTypes` limits the linked-
 * unit scan to room types that actually have linked units.
 */
function computedLedger(segments: Segment[], linkedTypes: string[]): SQL {
  return sql`
    WITH days AS (
      SELECT d.room_type_id, d.date FROM ${nightRows(segments)}
    ),
    types AS (
      SELECT rt.id AS room_type_id, rt.property_id,
             (SELECT count(*) FROM units u WHERE u.room_type_id = rt.id AND u.active)::int AS total
      FROM room_types rt
      WHERE rt.id IN (SELECT room_type_id FROM days)
    ),
    sold AS (
      SELECT d.room_type_id, d.date, count(*)::int AS n
      FROM days d
      JOIN reservation_rooms rr
        ON rr.room_type_id = d.room_type_id
       AND rr.check_in <= d.date AND rr.check_out > d.date
       AND rr.status IN (${sql.raw(HOLDING)})
      GROUP BY 1, 2
    ),
    blk AS (
      SELECT d.room_type_id, d.date,
             coalesce(sum(b.quantity) FILTER (WHERE b.kind <> 'maintenance'), 0)::int AS blocked,
             coalesce(sum(b.quantity) FILTER (WHERE b.kind = 'maintenance'), 0)::int AS ooo
      FROM days d
      JOIN inventory_blocks b
        ON b.room_type_id = d.room_type_id
       AND b.start_date <= d.date AND b.end_date > d.date
       AND b.released_at IS NULL
      GROUP BY 1, 2
    ),
    linked AS (
      -- Units that cannot be sold because one of their component units is
      -- taken through a different unit (the villa is unsellable while a
      -- bedroom is booked, and each bedroom while the villa is).
      SELECT d.room_type_id, d.date, count(DISTINCT u.id)::int AS n
      FROM days d
      JOIN units u ON u.room_type_id = d.room_type_id AND u.active
      JOIN units atom ON atom.active AND (atom.parent_unit_id = u.id OR atom.id = u.id)
      JOIN unit_occupancy o
        ON o.unit_id = atom.id AND o.source_unit_id <> u.id AND o.stay @> d.date
      WHERE d.room_type_id = ANY(${uuidArray(linkedTypes)})
      GROUP BY 1, 2
    ),
    raw AS (
      SELECT d.room_type_id, t.property_id, d.date, t.total,
             coalesce(s.n, 0) AS sold_raw,
             coalesce(b.blocked, 0) AS blocked_raw,
             coalesce(b.ooo, 0) AS ooo_raw,
             coalesce(l.n, 0) AS linked_raw
      FROM days d
      JOIN types t ON t.room_type_id = d.room_type_id
      LEFT JOIN sold s ON s.room_type_id = d.room_type_id AND s.date = d.date
      LEFT JOIN blk b ON b.room_type_id = d.room_type_id AND b.date = d.date
      LEFT JOIN linked l ON l.room_type_id = d.room_type_id AND l.date = d.date
    ),
    -- Capacity is consumed in a fixed order: out of order, blocks, linked
    -- units, then guests. Whatever guests do not fit is counted as overbooked,
    -- which keeps "sold + blocked + out_of_order + linked <= total" true.
    c1 AS (SELECT *, least(ooo_raw, total) AS ooo FROM raw),
    c2 AS (SELECT *, least(blocked_raw, total - ooo) AS blocked FROM c1),
    c3 AS (SELECT *, least(linked_raw, total - ooo - blocked) AS linked FROM c2),
    computed AS (
      SELECT room_type_id, property_id, date, total,
             least(sold_raw, total - ooo - blocked - linked) AS sold,
             blocked, ooo AS out_of_order, linked,
             sold_raw - least(sold_raw, total - ooo - blocked - linked) AS overbooked
      FROM c3
    )`;
}

async function recompute(
  tx: Transaction,
  segments: Segment[],
  linkedTypes: string[],
): Promise<LedgerRow[]> {
  const { rows } = await tx.execute<RawLedgerRow>(sql`
    ${computedLedger(segments, linkedTypes)}
    INSERT INTO inventory_days AS i
      (room_type_id, date, property_id, total, sold, blocked, out_of_order, linked, overbooked, updated_at)
    SELECT room_type_id, date, property_id, total, sold, blocked, out_of_order, linked, overbooked, now()
    FROM computed
    ON CONFLICT (room_type_id, date) DO UPDATE
      SET total = EXCLUDED.total, sold = EXCLUDED.sold, blocked = EXCLUDED.blocked,
          out_of_order = EXCLUDED.out_of_order, linked = EXCLUDED.linked,
          overbooked = EXCLUDED.overbooked, updated_at = now()
      WHERE (i.total, i.sold, i.blocked, i.out_of_order, i.linked, i.overbooked)
            IS DISTINCT FROM
            (EXCLUDED.total, EXCLUDED.sold, EXCLUDED.blocked, EXCLUDED.out_of_order, EXCLUDED.linked, EXCLUDED.overbooked)
    RETURNING i.room_type_id, i.property_id, i.date, i.total, i.sold, i.blocked, i.out_of_order, i.linked, i.overbooked
  `);
  return rows.map(toLedgerRow);
}

/**
 * Locks the ledger rows for `scopes` (and for room types linked to them),
 * runs `mutate`, then rebuilds those rows from their sources.
 *
 * Unless `allowOverbooking` is set, the transaction is rejected if the change
 * leaves any night more overbooked than before. Channel bookings set it: a
 * reservation an OTA has already confirmed to a guest must be recorded even
 * when it collides, and is flagged instead.
 *
 * Availability changes are written to the outbox inside the same transaction.
 */
export async function withInventoryLock<T>(
  tx: Transaction,
  orgId: string,
  scopes: InventoryScope[],
  options: { allowOverbooking?: boolean },
  mutate: () => Promise<T>,
): Promise<InventoryOutcome<T>> {
  if (scopes.length === 0) {
    return { value: await mutate(), newlyOverbooked: [], changed: [] };
  }

  const groups = await linkedRoomTypeGroups(tx, [...new Set(scopes.map((s) => s.roomTypeId))]);
  // A change to one room type changes the availability of every type linked to it.
  const withLinked = (list: InventoryScope[]): InventoryScope[] =>
    list.flatMap((scope) =>
      [...(groups.get(scope.roomTypeId) ?? [scope.roomTypeId])].map((roomTypeId) => ({
        roomTypeId,
        range: scope.range,
      })),
    );
  const expanded = withLinked(scopes);
  expanded.push(...withLinked(await waitingStayScopes(tx, toSegments(expanded))));
  const segments = toSegments(expanded);
  const linkedTypes = [...groups.keys()];

  // Make sure a row exists for every night, in a fixed order so that two
  // transactions creating the same rows cannot deadlock.
  const inserted = await tx.execute(sql`
    INSERT INTO inventory_days (room_type_id, date, property_id)
    SELECT d.room_type_id, d.date, rt.property_id
    FROM ${nightRows(segments)}
    JOIN room_types rt ON rt.id = d.room_type_id
    ORDER BY d.room_type_id, d.date
    ON CONFLICT (room_type_id, date) DO NOTHING
  `);

  const lockRows = async (): Promise<Map<string, LedgerRow>> => {
    const { rows } = await tx.execute<RawLedgerRow>(sql`
      SELECT i.room_type_id, i.property_id, i.date, i.total, i.sold, i.blocked, i.out_of_order, i.linked, i.overbooked
      FROM inventory_days i
      JOIN ${nightRows(segments)} ON d.room_type_id = i.room_type_id AND d.date = i.date
      ORDER BY i.room_type_id, i.date
      FOR UPDATE OF i
    `);
    return new Map(rows.map((r) => [key(r.room_type_id, r.date), toLedgerRow(r)]));
  };

  const before = await lockRows();
  if ((inserted.rowCount ?? 0) > 0) {
    // Freshly created rows hold zeros; bring them up to date so the
    // before/after comparison below reflects only this change.
    for (const row of await recompute(tx, segments, linkedTypes)) {
      before.set(key(row.roomTypeId, row.date), row);
    }
  }

  const value = await mutate();

  // Capacity freed by this change may let a waiting (overbooked) stay take a unit.
  const assignedWaiting = await assignWaitingRooms(tx, segments);

  const changed = await recompute(tx, segments, linkedTypes);

  const newlyOverbooked: OverbookedNight[] = [];
  let overbookingEased = assignedWaiting > 0;
  const availabilityChanged = new Map<string, { propertyId: string; dates: DateString[] }>();
  for (const row of changed) {
    const prev = before.get(key(row.roomTypeId, row.date));
    if (row.overbooked > (prev?.overbooked ?? 0)) {
      newlyOverbooked.push({
        roomTypeId: row.roomTypeId,
        date: row.date,
        overbooked: row.overbooked,
      });
    }
    if (row.overbooked < (prev?.overbooked ?? 0)) overbookingEased = true;
    if (!prev || availableOf(prev) !== availableOf(row)) {
      const entry = availabilityChanged.get(row.roomTypeId) ?? {
        propertyId: row.propertyId,
        dates: [],
      };
      entry.dates.push(row.date);
      availabilityChanged.set(row.roomTypeId, entry);
    }
  }

  newlyOverbooked.sort(
    (a, b) => a.roomTypeId.localeCompare(b.roomTypeId) || a.date.localeCompare(b.date),
  );

  if (newlyOverbooked.length > 0 && !options.allowOverbooking) {
    const dates = [...new Set(newlyOverbooked.map((n) => n.date))].sort();
    throw new DomainError(
      'no_availability',
      dates.length === 1
        ? `No availability on ${dates[0]}`
        : `No availability on ${dates.length} of the requested nights (${dates[0]} to ${dates[dates.length - 1]})`,
      { nights: newlyOverbooked },
    );
  }

  if (overbookingEased) {
    const propertyIds = [...new Set([...before.values()].map((r) => r.propertyId))];
    for (const reservationId of await settleOverbookedReservations(tx, propertyIds)) {
      await resolveAlert(tx, orgId, `overbooking:${reservationId}`);
    }
  }

  const events: OutboxEvent[] = [];
  for (const [roomTypeId, entry] of availabilityChanged) {
    for (const range of datesToRanges(entry.dates)) {
      events.push({ kind: 'ari.availability', propertyId: entry.propertyId, roomTypeId, range });
    }
  }
  await emit(tx, orgId, events);

  return { value, newlyOverbooked, changed };
}

/** Rebuilds ledger rows without changing anything else, e.g. after the unit count changed. */
export async function refreshInventory(
  tx: Transaction,
  orgId: string,
  scopes: InventoryScope[],
  options: { allowOverbooking?: boolean } = { allowOverbooking: true },
): Promise<InventoryOutcome<void>> {
  return withInventoryLock(tx, orgId, scopes, options, async () => undefined);
}

export interface AvailabilityDay extends Omit<LedgerRow, 'propertyId'> {
  available: number;
}

/**
 * Availability per room type per night. Nights that have no ledger row yet
 * (nothing has ever touched them) are reported as fully available.
 */
export async function getAvailability(
  db: DbOrTx,
  params: { propertyId: string; range: DateRange; roomTypeIds?: string[] },
): Promise<AvailabilityDay[]> {
  const nights = diffDays(params.range.from, params.range.to);
  if (nights <= 0) throw validationError('The date range must end after it starts');
  if (nights > MAX_SEGMENT_DAYS)
    throw validationError(`A date range may span at most ${MAX_SEGMENT_DAYS} days`);
  const typeFilter = params.roomTypeIds
    ? sql`AND rt.id = ANY(${uuidArray(params.roomTypeIds)})`
    : sql``;
  const { rows } = await db.execute<RawLedgerRow>(sql`
    SELECT rt.id AS room_type_id, rt.property_id, g::date AS date,
           coalesce(i.total, (SELECT count(*) FROM units u WHERE u.room_type_id = rt.id AND u.active))::int AS total,
           coalesce(i.sold, 0) AS sold, coalesce(i.blocked, 0) AS blocked,
           coalesce(i.out_of_order, 0) AS out_of_order, coalesce(i.linked, 0) AS linked,
           coalesce(i.overbooked, 0) AS overbooked
    FROM room_types rt
    CROSS JOIN generate_series(${params.range.from}::date, ${params.range.to}::date - 1, interval '1 day') g
    LEFT JOIN inventory_days i ON i.room_type_id = rt.id AND i.date = g::date
    WHERE rt.property_id = ${params.propertyId} AND rt.active ${typeFilter}
    ORDER BY rt.sort_order, rt.name, rt.id, g
  `);
  return rows.map((r) => {
    const row = toLedgerRow(r);
    return {
      roomTypeId: row.roomTypeId,
      date: row.date,
      total: row.total,
      sold: row.sold,
      blocked: row.blocked,
      outOfOrder: row.outOfOrder,
      linked: row.linked,
      overbooked: row.overbooked,
      available: availableOf(row),
    };
  });
}

export interface LedgerMismatch {
  roomTypeId: string;
  date: DateString;
  stored: Omit<LedgerRow, 'roomTypeId' | 'propertyId' | 'date'> | null;
  expected: Omit<LedgerRow, 'roomTypeId' | 'propertyId' | 'date'>;
}

/**
 * Compares the stored ledger with what its sources imply, without writing.
 * An empty result is the invariant the ledger promises; anything else means a
 * write bypassed `withInventoryLock`.
 */
export async function findLedgerMismatches(
  db: DbOrTx,
  params: { propertyId: string; range: DateRange },
): Promise<LedgerMismatch[]> {
  const { rows: types } = await db.execute<{ id: string }>(
    sql`SELECT id FROM room_types WHERE property_id = ${params.propertyId}`,
  );
  if (types.length === 0) return [];
  const typeIds = types.map((t) => t.id);
  const groups = await linkedRoomTypeGroups(db, typeIds);
  const segments: Segment[] = typeIds
    .sort()
    .map((id) => ({ room_type_id: id, d_from: params.range.from, d_to: params.range.to }));
  const { rows } = await db.execute<
    RawLedgerRow & {
      s_total: number | null;
      s_sold: number | null;
      s_blocked: number | null;
      s_out_of_order: number | null;
      s_linked: number | null;
      s_overbooked: number | null;
    }
  >(sql`
    ${computedLedger(segments, [...groups.keys()])}
    SELECT c.room_type_id, c.property_id, c.date, c.total, c.sold, c.blocked, c.out_of_order, c.linked, c.overbooked,
           i.total AS s_total, i.sold AS s_sold, i.blocked AS s_blocked,
           i.out_of_order AS s_out_of_order, i.linked AS s_linked, i.overbooked AS s_overbooked
    FROM computed c
    LEFT JOIN inventory_days i ON i.room_type_id = c.room_type_id AND i.date = c.date
    WHERE (i.room_type_id IS NULL AND (c.sold > 0 OR c.blocked > 0 OR c.out_of_order > 0 OR c.linked > 0 OR c.overbooked > 0))
       OR (i.room_type_id IS NOT NULL AND
           (i.total, i.sold, i.blocked, i.out_of_order, i.linked, i.overbooked)
           IS DISTINCT FROM (c.total, c.sold, c.blocked, c.out_of_order, c.linked, c.overbooked))
    ORDER BY c.room_type_id, c.date
  `);
  return rows.map((r) => ({
    roomTypeId: r.room_type_id,
    date: r.date,
    stored:
      r.s_total === null
        ? null
        : {
            total: r.s_total,
            sold: r.s_sold ?? 0,
            blocked: r.s_blocked ?? 0,
            outOfOrder: r.s_out_of_order ?? 0,
            linked: r.s_linked ?? 0,
            overbooked: r.s_overbooked ?? 0,
          },
    expected: {
      total: r.total,
      sold: r.sold,
      blocked: r.blocked,
      outOfOrder: r.out_of_order,
      linked: r.linked,
      overbooked: r.overbooked,
    },
  }));
}

/** Rebuilds the ledger for a property and date range from its sources. Used by the repair job. */
export async function rebuildLedger(
  tx: Transaction,
  orgId: string,
  params: { propertyId: string; range: DateRange },
): Promise<LedgerRow[]> {
  const { rows } = await tx.execute<{ id: string }>(
    sql`SELECT id FROM room_types WHERE property_id = ${params.propertyId}`,
  );
  if (rows.length === 0) return [];
  const outcome = await refreshInventory(
    tx,
    orgId,
    rows.map((r) => ({ roomTypeId: r.id, range: params.range })),
  );
  return outcome.changed;
}
