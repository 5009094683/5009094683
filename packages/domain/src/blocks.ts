import { and, asc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import {
  inventoryBlocks,
  roomTypes,
  units,
  type BlockKind,
  type BlockSource,
  type DbOrTx,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { assertRange, diffDays, type DateRange, type DateString } from './dates';
import { invalidState, notFound, validationError } from './errors';
import { withInventoryLock, type InventoryScope } from './inventory';
import { occupancyConflicts, occupyUnit, releaseOccupancy, unitOccupiedError } from './occupancy';
import { emit } from './outbox';
import { requireProperty } from './properties';
import { transact } from './sqlx';

export type BlockRow = typeof inventoryBlocks.$inferSelect;

const MAX_BLOCK_DAYS = 730;

export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  block: 'Blocked',
  maintenance: 'Out of order',
  owner_stay: 'Owner stay',
  hold: 'Held',
};

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
}

function validateBlockRange(from: string, to: string): DateRange {
  const range = assertRange(from, to, 'block');
  if (diffDays(range.from, range.to) > MAX_BLOCK_DAYS) {
    throw validationError(`A block may span at most ${MAX_BLOCK_DAYS} days`);
  }
  return range;
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
): Promise<BlockRow> {
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

    const scopes: InventoryScope[] = [{ roomTypeId, range }];
    const outcome = await withInventoryLock(tx, actor.orgId, scopes, options, async () => {
      if (unitId) {
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
      return block!;
    });

    const block = outcome.value;
    await writeAudit(tx, actor, {
      action: 'block.created',
      entityType: 'block',
      entityId: block.id,
      propertyId: input.propertyId,
      summary: `${BLOCK_KIND_LABELS[input.kind]}: ${label}, ${range.from} to ${range.to}`,
      changes: { reason: input.reason ?? null, overbookedNights: outcome.newlyOverbooked.length },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'block.created',
        propertyId: input.propertyId,
        payload: { blockId: block.id, unitId, roomTypeId, from: range.from, to: range.to },
      },
    ]);
    return block;
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
): Promise<BlockRow> {
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

    const scopes: InventoryScope[] = [
      { roomTypeId: before.roomTypeId, range: { from: before.startDate, to: before.endDate } },
      { roomTypeId: before.roomTypeId, range },
    ];
    const outcome = await withInventoryLock(tx, actor.orgId, scopes, options, async () => {
      await releaseOccupancy(tx, { blockId });
      if (before.unitId) {
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
      return after!;
    });
    const after = outcome.value;
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
      },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'block.updated',
        propertyId: before.propertyId,
        payload: { blockId, unitId: before.unitId },
      },
    ]);
    return after;
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
      [{ roomTypeId: before.roomTypeId, range: { from: before.startDate, to: before.endDate } }],
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
