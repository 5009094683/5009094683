import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  inventoryBlocks,
  maintenanceIssues,
  properties,
  units,
  users,
  type DbOrTx,
  type MaintenanceStatus,
  type Priority,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import { createBlock, releaseBlock, updateBlock } from './blocks';
import type { Actor } from './context';
import type { DateString } from './dates';
import { notFound, validationError } from './errors';
import { businessDateOf } from './folios';
import { emit } from './outbox';
import { transact } from './sqlx';

export type MaintenanceIssueRow = typeof maintenanceIssues.$inferSelect;

export interface MaintenanceIssueView extends MaintenanceIssueRow {
  unitName: string | null;
  assignedToName: string | null;
  /** The dates the unit is off sale for this, if it is. */
  offSale: { from: DateString; to: DateString } | null;
}

export interface ReportIssueInput {
  propertyId: string;
  unitId?: string | null;
  title: string;
  description?: string | null;
  priority?: Priority;
  assignedTo?: string | null;
  /**
   * Take the unit off sale for these dates (`to` is the first day it can be
   * sold again). The closure reaches the booking channels like any other.
   */
  offSale?: { from: DateString; to: DateString } | null;
}

/** Marks a unit out of service while a closure covers the current hotel day, and back when none does. */
async function syncServiceState(tx: Transaction, unitId: string): Promise<void> {
  const [row] = await tx
    .select({ unit: units, property: properties })
    .from(units)
    .innerJoin(properties, eq(properties.id, units.propertyId))
    .where(eq(units.id, unitId));
  if (!row) return;
  const today = businessDateOf(row.property);
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM maintenance_issues m JOIN inventory_blocks b ON b.id = m.block_id
    WHERE m.unit_id = ${unitId} AND m.status IN ('open', 'in_progress') AND b.released_at IS NULL
      AND b.start_date <= ${today}::date AND b.end_date > ${today}::date
    LIMIT 1
  `);
  const closed = rows.length > 0;
  if (closed && row.unit.housekeepingStatus !== 'out_of_service') {
    await tx
      .update(units)
      .set({ housekeepingStatus: 'out_of_service' })
      .where(eq(units.id, unitId));
  } else if (!closed && row.unit.housekeepingStatus === 'out_of_service') {
    // Work has finished: the room needs cleaning before a guest goes in.
    await tx.update(units).set({ housekeepingStatus: 'dirty' }).where(eq(units.id, unitId));
  }
}

/**
 * Records something that needs fixing. With `offSale` the unit is closed for
 * those dates in the same step: availability drops and the booking channels
 * are told, so a room with no water cannot be sold while it waits.
 *
 * In a hotel, guests already booked into that room are moved to another free
 * room of the same type. A villa with a booking on those dates is refused:
 * someone has to decide what happens to that guest first.
 */
export async function reportIssue(
  db: DbOrTx,
  actor: Actor,
  input: ReportIssueInput,
): Promise<MaintenanceIssueRow> {
  const title = input.title.trim();
  if (!title) throw validationError('Say what needs fixing');
  if (input.offSale && !input.unitId) {
    throw validationError('Choose the unit to take off sale');
  }
  return transact(db, async (tx) => {
    const [property] = await tx
      .select()
      .from(properties)
      .where(and(eq(properties.id, input.propertyId), eq(properties.orgId, actor.orgId)));
    if (!property) throw notFound('Property', input.propertyId);
    if (input.unitId) {
      const [unit] = await tx
        .select({ id: units.id })
        .from(units)
        .where(and(eq(units.id, input.unitId), eq(units.propertyId, input.propertyId)));
      if (!unit) throw notFound('Unit', input.unitId);
    }
    let blockId: string | null = null;
    if (input.offSale) {
      const block = await createBlock(
        tx,
        actor,
        {
          propertyId: input.propertyId,
          unitId: input.unitId,
          kind: 'maintenance',
          startDate: input.offSale.from,
          endDate: input.offSale.to,
          reason: title.slice(0, 200),
          source: 'system',
        },
        { relocateStays: true },
      );
      blockId = block.id;
    }
    const [issue] = await tx
      .insert(maintenanceIssues)
      .values({
        propertyId: input.propertyId,
        unitId: input.unitId ?? null,
        title: title.slice(0, 200),
        description: input.description?.trim() || null,
        priority: input.priority ?? 'normal',
        assignedTo: input.assignedTo ?? null,
        blockId,
        reportedBy: actor.userId ?? null,
        reportedByLabel: actor.label,
      })
      .returning();
    if (input.unitId) await syncServiceState(tx, input.unitId);
    await writeAudit(tx, actor, {
      action: 'maintenance.reported',
      entityType: 'maintenance_issue',
      entityId: issue!.id,
      propertyId: input.propertyId,
      summary: `Reported: ${title}${input.offSale ? ` (unit off sale ${input.offSale.from} to ${input.offSale.to})` : ''}`,
    });
    await emit(tx, actor.orgId, [
      { kind: 'task.updated', propertyId: input.propertyId, payload: { issueId: issue!.id } },
    ]);
    return issue!;
  });
}

export interface IssuePatch {
  title?: string;
  description?: string | null;
  priority?: Priority;
  status?: MaintenanceStatus;
  assignedTo?: string | null;
  resolution?: string | null;
  /** New closure dates; null puts the unit back on sale while the issue stays open. */
  offSale?: { from: DateString; to: DateString } | null;
}

/**
 * Updates an issue. Resolving or closing it puts the unit back on sale (and
 * tells the channels); the room is left needing a clean.
 */
export async function updateIssue(
  db: DbOrTx,
  actor: Actor,
  issueId: string,
  patch: IssuePatch,
): Promise<MaintenanceIssueRow> {
  return transact(db, async (tx) => {
    const [row] = await tx
      .select({ issue: maintenanceIssues })
      .from(maintenanceIssues)
      .innerJoin(properties, eq(properties.id, maintenanceIssues.propertyId))
      .where(and(eq(maintenanceIssues.id, issueId), eq(properties.orgId, actor.orgId)))
      .for('update', { of: maintenanceIssues });
    if (!row) throw notFound('Maintenance issue', issueId);
    const before = row.issue;
    const set: Partial<typeof maintenanceIssues.$inferInsert> = {};
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw validationError('Say what needs fixing');
      set.title = patch.title.trim().slice(0, 200);
    }
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.assignedTo !== undefined) set.assignedTo = patch.assignedTo;
    if (patch.resolution !== undefined) set.resolution = patch.resolution?.trim() || null;

    const finishing =
      patch.status !== undefined &&
      (patch.status === 'resolved' || patch.status === 'closed') &&
      before.status !== 'resolved' &&
      before.status !== 'closed';
    if (patch.status !== undefined) {
      set.status = patch.status;
      if (finishing) set.resolvedAt = new Date();
      if (patch.status === 'open' || patch.status === 'in_progress') set.resolvedAt = null;
    }

    let blockId = before.blockId;
    const [block] = blockId
      ? await tx.select().from(inventoryBlocks).where(eq(inventoryBlocks.id, blockId))
      : [];
    const blockLive = block && block.releasedAt === null;
    if (finishing || patch.offSale === null) {
      if (blockLive) await releaseBlock(tx, actor, block.id);
      if (patch.offSale === null) blockId = null;
    } else if (patch.offSale) {
      if (!before.unitId) throw validationError('This issue is not about a unit');
      if (blockLive) {
        await updateBlock(
          tx,
          actor,
          block.id,
          { startDate: patch.offSale.from, endDate: patch.offSale.to },
          { relocateStays: true },
        );
      } else {
        const created = await createBlock(
          tx,
          actor,
          {
            propertyId: before.propertyId,
            unitId: before.unitId,
            kind: 'maintenance',
            startDate: patch.offSale.from,
            endDate: patch.offSale.to,
            reason: (set.title ?? before.title).slice(0, 200),
            source: 'system',
          },
          { relocateStays: true },
        );
        blockId = created.id;
      }
    }
    set.blockId = blockId;

    const [after] = await tx
      .update(maintenanceIssues)
      .set(set)
      .where(eq(maintenanceIssues.id, issueId))
      .returning();
    if (before.unitId) await syncServiceState(tx, before.unitId);
    await writeAudit(tx, actor, {
      action: finishing ? 'maintenance.resolved' : 'maintenance.updated',
      entityType: 'maintenance_issue',
      entityId: issueId,
      propertyId: before.propertyId,
      summary: finishing ? `Resolved: ${before.title}` : `Updated: ${before.title}`,
      changes: { status: patch.status, offSale: patch.offSale },
    });
    await emit(tx, actor.orgId, [
      { kind: 'task.updated', propertyId: before.propertyId, payload: { issueId } },
    ]);
    return after!;
  });
}

export interface IssueFilter {
  propertyIds: string[] | 'all';
  /** `open` means not yet resolved. */
  status?: 'open' | 'done' | 'all';
  unitId?: string;
  limit?: number;
}

export async function listIssues(
  db: DbOrTx,
  orgId: string,
  filter: IssueFilter,
): Promise<MaintenanceIssueView[]> {
  if (filter.propertyIds !== 'all' && filter.propertyIds.length === 0) return [];
  const status = filter.status ?? 'open';
  const rows = await db
    .select({
      issue: maintenanceIssues,
      unitName: units.name,
      assignedToName: users.name,
      block: inventoryBlocks,
    })
    .from(maintenanceIssues)
    .innerJoin(properties, eq(properties.id, maintenanceIssues.propertyId))
    .leftJoin(units, eq(units.id, maintenanceIssues.unitId))
    .leftJoin(users, eq(users.id, maintenanceIssues.assignedTo))
    .leftJoin(inventoryBlocks, eq(inventoryBlocks.id, maintenanceIssues.blockId))
    .where(
      and(
        eq(properties.orgId, orgId),
        filter.propertyIds === 'all'
          ? undefined
          : inArray(maintenanceIssues.propertyId, filter.propertyIds),
        status === 'open'
          ? inArray(maintenanceIssues.status, ['open', 'in_progress'])
          : status === 'done'
            ? inArray(maintenanceIssues.status, ['resolved', 'closed'])
            : undefined,
        filter.unitId ? eq(maintenanceIssues.unitId, filter.unitId) : undefined,
      ),
    )
    .orderBy(
      sql`CASE ${maintenanceIssues.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
      desc(maintenanceIssues.createdAt),
    )
    .limit(Math.min(filter.limit ?? 200, 1000));
  return rows.map((r) => ({
    ...r.issue,
    unitName: r.unitName,
    assignedToName: r.assignedToName,
    offSale:
      r.block && r.block.releasedAt === null
        ? { from: r.block.startDate, to: r.block.endDate }
        : null,
  }));
}
