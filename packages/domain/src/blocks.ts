import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  inventoryBlocks,
  reservationRooms,
  roomTypes,
  units,
  type BlockKind,
  type BlockSource,
  type DbOrTx,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import { BLOCK_KIND_LABELS } from './block-labels';
import type { Actor } from './context';
import { assertRange, diffDays, type DateRange, type DateString } from './dates';
import { invalidState, notFound, validationError } from './errors';
import { withInventoryLock, type InventoryScope } from './inventory';
import {
  findFreeUnits,
  occupancyConflicts,
  occupyUnit,
  releaseOccupancy,
  unitOccupiedError,
} from './occupancy';
import { emit, type OutboxEvent } from './outbox';
import { requireProperty } from './properties';
import { transact } from './sqlx';

export type BlockRow = typeof inventoryBlocks.$inferSelect;

const MAX_BLOCK_DAYS = 730;

export { BLOCK_KIND_LABELS };

export interface CreateBlockInput {
  propertyId: string;
  /** Block one physical unit. Either this or `roomTypeId` with a quantity. */
  unitId?: string | null;
  /** Take a number of rooms of a type off sale without naming units. */
  roomTypeId?: string;
  quantity?: number;
  kind: BlockKind;
  startDate: DateString;
  /** Exclusive: the first night back on sale. */
  endDate: DateString;
  reason?: string | null;
  notes?: string | null;
  source?: BlockSource;
  connectionId?: string | null;
  externalRef?: string | null;
  ownerId?: string | null;
  groupId?: string | null;
}

export interface BlockOptions {
  /** Allow the block even if it leaves existing reservations without a room (they are flagged overbooked). */
  allowOverbooking?: boolean;
  /**
   * When the unit already has upcoming stays on these dates, move them to
   * another free room of the same type (or leave them unassigned if none is
   * free) instead of refusing the block. Only for room types sold by count,
   * where rooms are interchangeable, and never for guests who have checked in.
   */
  relocateStays?: boolean;
}

export interface RelocatedStay {
  reservationId: string;
  code: string;
  guestName: string;
  /** Null when no other room was free: the stay now waits unassigned. */
  toUnit: string | null;
}

export type BlockResult = BlockRow & { relocated: RelocatedStay[] };

function validateBlockRange(from: string, to: string): DateRange {
  const range = assertRange(from, to, 'block');
  if (diffDays(range.from, range.to) > MAX_BLOCK_DAYS) {
    throw validationError(`A block may span at most ${MAX_BLOCK_DAYS} days`);
  }
  return range;
}

interface MovableStay {
  id: string;
  reservationId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  code: string;
  guestName: string;
}

/** Stays assigned to a unit that overlap `range` and may still be given another room. */
async function movableStays(tx: DbOrTx, unitId: string, range: DateRange): Promise<MovableStay[]> {
  const { rows } = await tx.execute<{
    id: string;
    reservation_id: string;
    room_type_id: string;
    check_in: string;
    check_out: string;
    code: string;
    guest_name: string;
  }>(sql`
    SELECT rr.id, rr.reservation_id, rr.room_type_id, rr.check_in::text, rr.check_out::text, r.code, r.guest_name
    FROM reservation_rooms rr
    JOIN reservations r ON r.id = rr.reservation_id
    JOIN room_types rt ON rt.id = rr.room_type_id AND rt.assignment = 'at_check_in'
    WHERE rr.unit_id = ${unitId}
      AND rr.status IN ('tentative', 'confirmed')
      AND rr.check_in < ${range.to}::date AND rr.check_out > ${range.from}::date
    ORDER BY rr.check_in, rr.id
  `);
  return rows.map((r) => ({
    id: r.id,
    reservationId: r.reservation_id,
    roomTypeId: r.room_type_id,
    checkIn: r.check_in,
    checkOut: r.check_out,
    code: r.code,
    guestName: r.guest_name,
  }));
}

/** Takes the given stays off their unit so the unit can be blocked. */
async function unseat(tx: Transaction, stays: MovableStay[]): Promise<void> {
  for (const stay of stays) {
    await releaseOccupancy(tx, { reservationRoomId: stay.id });
    await tx.update(reservationRooms).set({ unitId: null }).where(eq(reservationRooms.id, stay.id));
  }
}

/** Finds each unseated stay another free room of its type, where there is one. */
async function reseat(
  tx: Transaction,
  propertyId: string,
  stays: MovableStay[],
): Promise<RelocatedStay[]> {
  const relocated: RelocatedStay[] = [];
  for (const stay of stays) {
    const range = { from: stay.checkIn, to: stay.checkOut };
    const [free] = await findFreeUnits(tx, stay.roomTypeId, range);
    if (free) {
      await occupyUnit(tx, { propertyId, unitId: free.id, range, reservationRoomId: stay.id });
      await tx
        .update(reservationRooms)
        .set({ unitId: free.id })
        .where(eq(reservationRooms.id, stay.id));
    }
    relocated.push({
      reservationId: stay.reservationId,
      code: stay.code,
      guestName: stay.guestName,
      toUnit: free?.name ?? null,
    });
  }
  return relocated;
}

function relocationEvents(propertyId: string, relocated: RelocatedStay[]): OutboxEvent[] {
  return relocated.map((r) => ({
    kind: 'reservation.updated' as const,
    propertyId,
    payload: { reservationId: r.reservationId, code: r.code },
  }));
}

/**
 * Takes dates out of sale. The block, the unit occupancy, the rebuilt
 * availability and the channel update are one transaction.
 */
export async function createBlock(
  db: DbOrTx,
  actor: Actor,
  input: CreateBlockInput,
  options: BlockOptions = {},
): Promise<BlockResult> {
  const range = validateBlockRange(input.startDate, input.endDate);
  return transact(db, async (tx) => {
    await requireProperty(tx, actor.orgId, input.propertyId);

    let roomTypeId: string;
    let unitId: string | null = null;
    let quantity = 1;
    let label: string;
    if (input.unitId) {
      const [unit] = await tx
        .select()
        .from(units)
        .where(and(eq(units.id, input.unitId), eq(units.propertyId, input.propertyId)));
      if (!unit) throw notFound('Unit', input.unitId);
      roomTypeId = unit.roomTypeId;
      unitId = unit.id;
      label = unit.name;
    } else {
      if (!input.roomTypeId) throw validationError('Choose a unit or a room type to block');
      const [roomType] = await tx
        .select()
        .from(roomTypes)
        .where(and(eq(roomTypes.id, input.roomTypeId), eq(roomTypes.propertyId, input.propertyId)));
      if (!roomType) throw notFound('Room type', input.roomTypeId);
      if (roomType.assignment === 'at_booking') {
        throw validationError(`Choose which ${roomType.name} to block`);
      }
      quantity = input.quantity ?? 1;
      const active = await tx
        .select({ id: units.id })
        .from(units)
        .where(and(eq(units.roomTypeId, roomType.id), eq(units.active, true)));
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > active.length) {
        throw validationError(`Quantity must be between 1 and ${active.length}`);
      }
      roomTypeId = roomType.id;
      label = `${quantity} × ${roomType.name}`;
    }

    // Stays to be moved are read before locking so their own dates can be
    // locked too; the list is re-read under the lock before anything is moved.
    const candidates = options.relocateStays && unitId ? await movableStays(tx, unitId, range) : [];
    const scopes: InventoryScope[] = [
      { roomTypeId, range },
      ...candidates.map((s) => ({
        roomTypeId: s.roomTypeId,
        range: { from: s.checkIn, to: s.checkOut },
      })),
    ];
    const outcome = await withInventoryLock(tx, actor.orgId, scopes, options, async () => {
      let displaced: MovableStay[] = [];
      if (unitId) {
        if (options.relocateStays) {
          const lockedIds = new Set(candidates.map((c) => c.id));
          displaced = (await movableStays(tx, unitId, range)).filter((s) => lockedIds.has(s.id));
          await unseat(tx, displaced);
        }
        const conflicts = await occupancyConflicts(tx, unitId, range);
        if (conflicts.length > 0) throw unitOccupiedError(conflicts);
      }
      const [block] = await tx
        .insert(inventoryBlocks)
        .values({
          propertyId: input.propertyId,
          roomTypeId,
          unitId,
          kind: input.kind,
          startDate: range.from,
          endDate: range.to,
          quantity,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          source: input.source ?? 'manual',
          connectionId: input.connectionId ?? null,
          externalRef: input.externalRef ?? null,
          ownerId: input.ownerId ?? null,
          groupId: input.groupId ?? null,
          createdBy: actor.userId ?? null,
        })
        .returning();
      if (unitId)
        await occupyUnit(tx, { propertyId: input.propertyId, unitId, range, blockId: block!.id });
      const relocated = await reseat(tx, input.propertyId, displaced);
      return { block: block!, relocated };
    });

    const { block, relocated } = outcome.value;
    await writeAudit(tx, actor, {
      action: 'block.created',
      entityType: 'block',
      entityId: block.id,
      propertyId: input.propertyId,
      summary: `${BLOCK_KIND_LABELS[input.kind]}: ${label}, ${range.from} to ${range.to}`,
      changes: {
        reason: input.reason ?? null,
        overbookedNights: outcome.newlyOverbooked.length,
        relocated: relocated.map((r) => ({ reservation: r.code, to: r.toUnit })),
      },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'block.created',
        propertyId: input.propertyId,
        payload: { blockId: block.id, unitId, roomTypeId, from: range.from, to: range.to },
      },
      ...relocationEvents(input.propertyId, relocated),
    ]);
    return { ...block, relocated };
  });
}

export interface BlockPatch {
  startDate?: DateString;
  endDate?: DateString;
  kind?: BlockKind;
  reason?: string | null;
  notes?: string | null;
  quantity?: number;
}

/** Moves, resizes or relabels a block. Old and new dates are rebuilt together. */
export async function updateBlock(
  db: DbOrTx,
  actor: Actor,
  blockId: string,
  patch: BlockPatch,
  options: BlockOptions = {},
): Promise<BlockResult> {
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.id, blockId))
      .for('update');
    if (!before) throw notFound('Block', blockId);
    await requireProperty(tx, actor.orgId, before.propertyId);
    if (before.releasedAt) throw invalidState('This block has already been released');
    const range = validateBlockRange(
      patch.startDate ?? before.startDate,
      patch.endDate ?? before.endDate,
    );
    if (patch.quantity !== undefined && before.unitId && patch.quantity !== 1) {
      throw validationError('A block on a single unit always has quantity 1');
    }

    const candidates =
      options.relocateStays && before.unitId ? await movableStays(tx, before.unitId, range) : [];
    const scopes: InventoryScope[] = [
      { roomTypeId: before.roomTypeId, range: { from: before.startDate, to: before.endDate } },
      { roomTypeId: before.roomTypeId, range },
      ...candidates.map((s) => ({
        roomTypeId: s.roomTypeId,
        range: { from: s.checkIn, to: s.checkOut },
      })),
    ];
    const outcome = await withInventoryLock(tx, actor.orgId, scopes, options, async () => {
      await releaseOccupancy(tx, { blockId });
      let displaced: MovableStay[] = [];
      if (before.unitId) {
        if (options.relocateStays) {
          const lockedIds = new Set(candidates.map((c) => c.id));
          displaced = (await movableStays(tx, before.unitId, range)).filter((s) =>
            lockedIds.has(s.id),
          );
          await unseat(tx, displaced);
        }
        const conflicts = await occupancyConflicts(tx, before.unitId, range, { blockId });
        if (conflicts.length > 0) throw unitOccupiedError(conflicts);
      }
      const [after] = await tx
        .update(inventoryBlocks)
        .set({
          startDate: range.from,
          endDate: range.to,
          kind: patch.kind ?? before.kind,
          reason: patch.reason !== undefined ? patch.reason : before.reason,
          notes: patch.notes !== undefined ? patch.notes : before.notes,
          quantity: patch.quantity ?? before.quantity,
        })
        .where(eq(inventoryBlocks.id, blockId))
        .returning();
      if (before.unitId) {
        await occupyUnit(tx, {
          propertyId: before.propertyId,
          unitId: before.unitId,
          range,
          blockId,
        });
      }
      const relocated = await reseat(tx, before.propertyId, displaced);
      return { block: after!, relocated };
    });
    const { block: after, relocated } = outcome.value;
    await writeAudit(tx, actor, {
      action: 'block.updated',
      entityType: 'block',
      entityId: blockId,
      propertyId: before.propertyId,
      summary: `Changed block to ${range.from} - ${range.to}`,
      changes: {
        from: {
          startDate: before.startDate,
          endDate: before.endDate,
          kind: before.kind,
          reason: before.reason,
        },
        to: {
          startDate: after.startDate,
          endDate: after.endDate,
          kind: after.kind,
          reason: after.reason,
        },
        relocated: relocated.map((r) => ({ reservation: r.code, to: r.toUnit })),
      },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'block.updated',
        propertyId: before.propertyId,
        payload: { blockId, unitId: before.unitId },
      },
      ...relocationEvents(before.propertyId, relocated),
    ]);
    return { ...after, relocated };
  });
}

/** Puts blocked dates back on sale. Releasing twice is a no-op. */
export async function releaseBlock(db: DbOrTx, actor: Actor, blockId: string): Promise<BlockRow> {
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(inventoryBlocks)
      .where(eq(inventoryBlocks.id, blockId))
      .for('update');
    if (!before) throw notFound('Block', blockId);
    await requireProperty(tx, actor.orgId, before.propertyId);
    if (before.releasedAt) return before;
    const outcome = await withInventoryLock(
      tx,
      actor.orgId,
      [
        {
          roomTypeId: before.roomTypeId,
          range: { from: before.startDate, to: before.endDate },
        },
      ],
      { allowOverbooking: true },
      async () => {
        await releaseOccupancy(tx, { blockId });
        const [after] = await tx
          .update(inventoryBlocks)
          .set({ releasedAt: new Date(), releasedBy: actor.userId ?? null })
          .where(eq(inventoryBlocks.id, blockId))
          .returning();
        return after!;
      },
    );
    await writeAudit(tx, actor, {
      action: 'block.released',
      entityType: 'block',
      entityId: blockId,
      propertyId: before.propertyId,
      summary: `Released ${BLOCK_KIND_LABELS[before.kind].toLowerCase()} ${before.startDate} to ${before.endDate}`,
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'block.released',
        propertyId: before.propertyId,
        payload: { blockId, unitId: before.unitId },
      },
    ]);
    return outcome.value;
  });
}

/** Active blocks overlapping a date range. */
export async function listBlocks(
  db: DbOrTx,
  params: { propertyIds: string[]; range: DateRange; kinds?: BlockKind[] },
): Promise<BlockRow[]> {
  if (params.propertyIds.length === 0) return [];
  return db
    .select()
    .from(inventoryBlocks)
    .where(
      and(
        inArray(inventoryBlocks.propertyId, params.propertyIds),
        isNull(inventoryBlocks.releasedAt),
        lt(inventoryBlocks.startDate, params.range.to),
        gt(inventoryBlocks.endDate, params.range.from),
        params.kinds?.length ? inArray(inventoryBlocks.kind, params.kinds) : undefined,
      ),
    )
    .orderBy(asc(inventoryBlocks.startDate));
}
