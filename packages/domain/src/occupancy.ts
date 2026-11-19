import { and, eq, sql } from 'drizzle-orm';
import {
  INVENTORY_HOLDING_STATUSES,
  sqlList,
  unitOccupancy,
  units,
  type DbOrTx,
  type Transaction,
} from '@pms/db';
import { toDateRangeLiteral, type DateRange } from './dates';
import { DomainError } from './errors';
import { dateArray, uuidArray } from './sqlx';

const HOLDING = sqlList(INVENTORY_HOLDING_STATUSES);

/**
 * The physical units a sellable unit is made of: its active children when it
 * has any (a villa's bedrooms), otherwise the unit itself. Occupancy is always
 * recorded on these, which is what makes a villa and its bedrooms conflict.
 */
export async function atomicUnitsOf(tx: DbOrTx, unitId: string): Promise<string[]> {
  const children = await tx
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.parentUnitId, unitId), eq(units.active, true)));
  return children.length > 0 ? children.map((c) => c.id) : [unitId];
}

export interface FreeUnit {
  id: string;
  name: string;
  /** Empty nights between the previous stay and this one, and between this one and the next. */
  gapBefore: number;
  gapAfter: number;
}

/**
 * Units of a room type with no stay or block overlapping `range`, best fit
 * first: a unit where the stay starts or ends flush against a neighbouring
 * stay is preferred, which keeps long free stretches intact elsewhere.
 */
export async function findFreeUnits(
  tx: DbOrTx,
  roomTypeId: string,
  range: DateRange,
): Promise<FreeUnit[]> {
  const literal = toDateRangeLiteral(range);
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    gap_before: number;
    gap_after: number;
  }>(sql`
    SELECT id, name, gap_before, gap_after FROM (
      SELECT u.id, u.name, u.sort_order,
             coalesce(${range.from}::date - (
               SELECT max(upper(o.stay)) FROM unit_occupancy o
               WHERE o.unit_id IN (SELECT a.id FROM units a WHERE a.id = u.id OR a.parent_unit_id = u.id)
                 AND upper(o.stay) <= ${range.from}::date), 9999)::int AS gap_before,
             coalesce((
               SELECT min(lower(o.stay)) FROM unit_occupancy o
               WHERE o.unit_id IN (SELECT a.id FROM units a WHERE a.id = u.id OR a.parent_unit_id = u.id)
                 AND lower(o.stay) >= ${range.to}::date) - ${range.to}::date, 9999)::int AS gap_after
      FROM units u
      WHERE u.room_type_id = ${roomTypeId} AND u.active
        AND NOT EXISTS (
          SELECT 1 FROM unit_occupancy o
          WHERE o.unit_id IN (SELECT a.id FROM units a WHERE a.active AND (a.id = u.id OR a.parent_unit_id = u.id))
            AND o.stay && ${literal}::daterange)
    ) free
    ORDER BY least(gap_before, gap_after), gap_before + gap_after, sort_order, name
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    gapBefore: r.gap_before,
    gapAfter: r.gap_after,
  }));
}

export interface OccupancyConflict {
  unitId: string;
  unitName: string;
  from: string;
  to: string;
  kind: 'reservation' | 'block';
  /** Reservation code or block reason, for the message shown to staff. */
  label: string | null;
}

/** What already occupies a unit (or its parts) during `range`. */
export async function occupancyConflicts(
  tx: DbOrTx,
  unitId: string,
  range: DateRange,
  exclude: { reservationRoomId?: string; blockId?: string } = {},
): Promise<OccupancyConflict[]> {
  const literal = toDateRangeLiteral(range);
  const { rows } = await tx.execute<{
    unit_id: string;
    unit_name: string;
    d_from: string;
    d_to: string;
    reservation_code: string | null;
    block_reason: string | null;
    block_kind: string | null;
    is_block: boolean;
  }>(sql`
    SELECT DISTINCT o.source_unit_id AS unit_id, su.name AS unit_name,
           lower(o.stay)::text AS d_from, upper(o.stay)::text AS d_to,
           r.code AS reservation_code, b.reason AS block_reason, b.kind AS block_kind,
           (o.block_id IS NOT NULL) AS is_block
    FROM unit_occupancy o
    JOIN units su ON su.id = o.source_unit_id
    LEFT JOIN reservation_rooms rr ON rr.id = o.reservation_room_id
    LEFT JOIN reservations r ON r.id = rr.reservation_id
    LEFT JOIN inventory_blocks b ON b.id = o.block_id
    WHERE o.unit_id IN (SELECT a.id FROM units a WHERE a.active AND (a.id = ${unitId} OR a.parent_unit_id = ${unitId}))
      AND o.stay && ${literal}::daterange
      AND (${exclude.reservationRoomId ?? null}::uuid IS NULL OR o.reservation_room_id IS DISTINCT FROM ${exclude.reservationRoomId ?? null}::uuid)
      AND (${exclude.blockId ?? null}::uuid IS NULL OR o.block_id IS DISTINCT FROM ${exclude.blockId ?? null}::uuid)
    ORDER BY d_from
  `);
  return rows.map((r) => ({
    unitId: r.unit_id,
    unitName: r.unit_name,
    from: r.d_from,
    to: r.d_to,
    kind: r.is_block ? 'block' : 'reservation',
    label: r.is_block ? (r.block_reason ?? r.block_kind) : r.reservation_code,
  }));
}

export function unitOccupiedError(conflicts: OccupancyConflict[]): DomainError {
  const first = conflicts[0];
  const what = first
    ? first.kind === 'reservation'
      ? `reservation ${first.label} (${first.from} to ${first.to})`
      : `a ${first.label ?? 'block'} (${first.from} to ${first.to})`
    : 'another stay';
  return new DomainError(
    'unit_occupied',
    `${first?.unitName ?? 'That unit'} is already taken by ${what}`,
    {
      conflicts,
    },
  );
}

/** Records that a unit is taken for `range`, on each of its atomic units. */
export async function occupyUnit(
  tx: Transaction,
  params: {
    propertyId: string;
    unitId: string;
    range: DateRange;
    reservationRoomId?: string;
    blockId?: string;
  },
): Promise<void> {
  const atoms = await atomicUnitsOf(tx, params.unitId);
  await tx.insert(unitOccupancy).values(
    atoms.map((atomId) => ({
      propertyId: params.propertyId,
      unitId: atomId,
      sourceUnitId: params.unitId,
      stay: toDateRangeLiteral(params.range),
      reservationRoomId: params.reservationRoomId ?? null,
      blockId: params.blockId ?? null,
    })),
  );
}

export async function releaseOccupancy(
  tx: Transaction,
  source: { reservationRoomId: string } | { blockId: string },
): Promise<void> {
  if ('reservationRoomId' in source) {
    await tx
      .delete(unitOccupancy)
      .where(eq(unitOccupancy.reservationRoomId, source.reservationRoomId));
  } else {
    await tx.delete(unitOccupancy).where(eq(unitOccupancy.blockId, source.blockId));
  }
}

/**
 * Gives a physical unit to reservation rooms that should have one but do not,
 * oldest first. This happens after an overbooking is resolved: the second
 * booking of a villa has no unit until the first one is cancelled or moved.
 * Only rooms whose whole stay lies inside the locked `segments` are touched.
 */
export async function assignWaitingRooms(
  tx: Transaction,
  segments: { room_type_id: string; d_from: string; d_to: string }[],
): Promise<number> {
  const { rows } = await tx.execute<{
    id: string;
    property_id: string;
    room_type_id: string;
    check_in: string;
    check_out: string;
  }>(sql`
    SELECT rr.id, rr.property_id, rr.room_type_id, rr.check_in::text, rr.check_out::text
    FROM reservation_rooms rr
    JOIN room_types rt ON rt.id = rr.room_type_id AND rt.assignment = 'at_booking'
    JOIN unnest(
           ${uuidArray(segments.map((s) => s.room_type_id))},
           ${dateArray(segments.map((s) => s.d_from))},
           ${dateArray(segments.map((s) => s.d_to))}
         ) AS s(room_type_id, d_from, d_to)
      ON s.room_type_id = rr.room_type_id AND rr.check_in >= s.d_from AND rr.check_out <= s.d_to
    WHERE rr.unit_id IS NULL AND rr.status IN (${sql.raw(HOLDING)})
    ORDER BY rr.created_at, rr.id
  `);
  let assigned = 0;
  for (const room of rows) {
    const range = { from: room.check_in, to: room.check_out };
    const [free] = await findFreeUnits(tx, room.room_type_id, range);
    if (!free) continue;
    await occupyUnit(tx, {
      propertyId: room.property_id,
      unitId: free.id,
      range,
      reservationRoomId: room.id,
    });
    await tx.execute(
      sql`UPDATE reservation_rooms SET unit_id = ${free.id}, updated_at = now() WHERE id = ${room.id}`,
    );
    assigned++;
  }
  return assigned;
}

/**
 * Clears the overbooked flag on reservations that now fit: no night of theirs
 * is over capacity and every room that needs a unit has one. Returns their ids.
 */
export async function settleOverbookedReservations(
  tx: Transaction,
  propertyIds: string[],
): Promise<string[]> {
  if (propertyIds.length === 0) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE reservations r SET overbooked = false, updated_at = now()
    WHERE r.overbooked
      AND r.property_id IN (${sql.join(
        propertyIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND NOT EXISTS (
        SELECT 1 FROM reservation_rooms rr
        JOIN inventory_days i
          ON i.room_type_id = rr.room_type_id AND i.date >= rr.check_in AND i.date < rr.check_out
        WHERE rr.reservation_id = r.id AND rr.status IN (${sql.raw(HOLDING)}) AND i.overbooked > 0)
      AND NOT EXISTS (
        SELECT 1 FROM reservation_rooms rr
        JOIN room_types rt ON rt.id = rr.room_type_id
        WHERE rr.reservation_id = r.id AND rr.status IN (${sql.raw(HOLDING)})
          AND rt.assignment = 'at_booking' AND rr.unit_id IS NULL)
    RETURNING r.id
  `);
  return rows.map((r) => r.id);
}
