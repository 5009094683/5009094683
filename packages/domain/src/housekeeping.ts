import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  housekeepingTasks,
  properties,
  units,
  users,
  type DbOrTx,
  type HousekeepingStatus,
  type HousekeepingTaskKind,
  type Priority,
  type TaskStatus,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import type { DateString } from './dates';
import { invalidState, notFound, validationError } from './errors';
import { businessDateOf } from './folios';
import { emit } from './outbox';
import { transact } from './sqlx';

export type HousekeepingTaskRow = typeof housekeepingTasks.$inferSelect;

/**
 * Writes the cleaning list for a day from who is leaving and who is staying:
 * a departure clean for each room whose guest leaves that day, a stay-over
 * service for each room whose guest stays on. A room that someone arrives
 * into the same day is marked high priority. Running it again adds only what
 * is new, and never touches work already started.
 */
export async function generateHousekeepingTasks(
  tx: Transaction,
  propertyId: string,
  date: DateString,
): Promise<number> {
  const result = await tx.execute(sql`
    INSERT INTO housekeeping_tasks (property_id, unit_id, date, kind, priority)
    SELECT ${propertyId}, rr.unit_id, ${date}::date,
           CASE WHEN rr.check_out = ${date}::date THEN 'departure' ELSE 'stayover' END,
           CASE WHEN rr.check_out = ${date}::date AND EXISTS (
                  SELECT 1 FROM reservation_rooms a
                  WHERE a.unit_id = rr.unit_id AND a.check_in = ${date}::date
                    AND a.status IN ('confirmed', 'in_house'))
                THEN 'high' ELSE 'normal' END
    FROM reservation_rooms rr
    WHERE rr.property_id = ${propertyId} AND rr.unit_id IS NOT NULL
      AND rr.status IN ('in_house', 'confirmed')
      AND rr.check_in < ${date}::date AND rr.check_out >= ${date}::date
    ON CONFLICT (unit_id, date, kind) DO NOTHING
  `);
  return result.rowCount ?? 0;
}

export interface HousekeepingUnit {
  unitId: string;
  unitName: string;
  roomTypeName: string;
  floor: string | null;
  status: HousekeepingStatus;
  /** What is happening in the room today. */
  occupancy: 'vacant' | 'occupied' | 'departing' | 'arriving' | 'turnover' | 'blocked';
  guestName: string | null;
  /** When the guest staying or arriving leaves. */
  departs: DateString | null;
  tasks: (HousekeepingTaskRow & { assignedToName: string | null })[];
}

export interface HousekeepingBoard {
  date: DateString;
  units: HousekeepingUnit[];
  counts: Record<HousekeepingStatus, number> & { tasksOpen: number; tasksDone: number };
}

/** Every unit of a property with its cleaning state, what is happening in it today, and the day's tasks. */
export async function housekeepingBoard(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  date?: DateString,
): Promise<HousekeepingBoard> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  const day = date ?? businessDateOf(property);
  const { rows } = await db.execute<{
    unit_id: string;
    unit_name: string;
    room_type_name: string;
    floor: string | null;
    status: HousekeepingStatus;
    staying: string | null;
    staying_out: string | null;
    departing: string | null;
    arriving: string | null;
    arriving_out: string | null;
    blocked: boolean;
  }>(sql`
    SELECT u.id AS unit_id, u.name AS unit_name, rt.name AS room_type_name, u.floor,
           u.housekeeping_status AS status,
           stay.guest AS staying, stay.check_out::text AS staying_out,
           dep.guest AS departing, arr.guest AS arriving, arr.check_out::text AS arriving_out,
           EXISTS (SELECT 1 FROM inventory_blocks b
                   WHERE b.unit_id = u.id AND b.released_at IS NULL
                     AND b.start_date <= ${day}::date AND b.end_date > ${day}::date) AS blocked
    FROM units u
    JOIN room_types rt ON rt.id = u.room_type_id
    LEFT JOIN LATERAL (
      SELECT coalesce(rr.guest_name, r.guest_name) AS guest, rr.check_out
      FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id
      WHERE rr.unit_id = u.id AND rr.status = 'in_house' AND rr.check_out > ${day}::date
      LIMIT 1) stay ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(rr.guest_name, r.guest_name) AS guest
      FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id
      WHERE rr.unit_id = u.id AND rr.status IN ('in_house', 'checked_out') AND rr.check_out = ${day}::date
      LIMIT 1) dep ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(rr.guest_name, r.guest_name) AS guest, rr.check_out
      FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id
      WHERE rr.unit_id = u.id AND rr.status = 'confirmed' AND rr.check_in = ${day}::date
      LIMIT 1) arr ON true
    WHERE u.property_id = ${propertyId} AND u.active
    ORDER BY rt.sort_order, rt.name, u.sort_order, u.name
  `);
  const tasks = await db
    .select({ task: housekeepingTasks, assignedToName: users.name })
    .from(housekeepingTasks)
    .leftJoin(users, eq(users.id, housekeepingTasks.assignedTo))
    .where(and(eq(housekeepingTasks.propertyId, propertyId), eq(housekeepingTasks.date, day)))
    .orderBy(asc(housekeepingTasks.createdAt));
  const counts = {
    clean: 0,
    dirty: 0,
    inspected: 0,
    out_of_service: 0,
    tasksOpen: 0,
    tasksDone: 0,
  };
  for (const { task } of tasks) {
    if (task.status === 'done' || task.status === 'skipped') counts.tasksDone++;
    else counts.tasksOpen++;
  }
  const list: HousekeepingUnit[] = rows.map((r) => {
    counts[r.status]++;
    const occupancy: HousekeepingUnit['occupancy'] = r.blocked
      ? 'blocked'
      : r.departing && r.arriving
        ? 'turnover'
        : r.departing
          ? 'departing'
          : r.staying
            ? 'occupied'
            : r.arriving
              ? 'arriving'
              : 'vacant';
    return {
      unitId: r.unit_id,
      unitName: r.unit_name,
      roomTypeName: r.room_type_name,
      floor: r.floor,
      status: r.status,
      occupancy,
      guestName: r.staying ?? r.departing ?? r.arriving,
      departs: r.staying_out ?? r.arriving_out,
      tasks: tasks
        .filter((t) => t.task.unitId === r.unit_id)
        .map((t) => ({ ...t.task, assignedToName: t.assignedToName })),
    };
  });
  return { date: day, units: list, counts };
}

/** Makes the day's cleaning list now (the night audit does it every morning). */
export async function refreshHousekeepingTasks(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
): Promise<number> {
  return transact(db, async (tx) => {
    const [property] = await tx
      .select()
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.orgId, actor.orgId)));
    if (!property) throw notFound('Property', propertyId);
    const added = await generateHousekeepingTasks(tx, propertyId, businessDateOf(property));
    if (added > 0) await emit(tx, actor.orgId, [{ kind: 'task.updated', propertyId, payload: {} }]);
    return added;
  });
}

export interface NewTaskInput {
  propertyId: string;
  unitId: string;
  kind: HousekeepingTaskKind;
  date?: DateString;
  priority?: Priority;
  assignedTo?: string | null;
  notes?: string | null;
}

export async function createHousekeepingTask(
  db: DbOrTx,
  actor: Actor,
  input: NewTaskInput,
): Promise<HousekeepingTaskRow> {
  return transact(db, async (tx) => {
    const [row] = await tx
      .select({ unit: units, property: properties })
      .from(units)
      .innerJoin(properties, eq(properties.id, units.propertyId))
      .where(
        and(
          eq(units.id, input.unitId),
          eq(units.propertyId, input.propertyId),
          eq(properties.orgId, actor.orgId),
        ),
      );
    if (!row) throw notFound('Unit', input.unitId);
    const date = input.date ?? businessDateOf(row.property);
    const [task] = await tx
      .insert(housekeepingTasks)
      .values({
        propertyId: input.propertyId,
        unitId: input.unitId,
        date,
        kind: input.kind,
        priority: input.priority ?? 'normal',
        assignedTo: input.assignedTo ?? null,
        notes: input.notes?.trim() || null,
      })
      .onConflictDoNothing()
      .returning();
    if (!task) {
      throw validationError(`${row.unit.name} already has that task for ${date}`);
    }
    await emit(tx, actor.orgId, [
      { kind: 'task.updated', propertyId: input.propertyId, payload: {} },
    ]);
    return task;
  });
}

export interface TaskPatch {
  status?: TaskStatus;
  assignedTo?: string | null;
  priority?: Priority;
  notes?: string | null;
}

/**
 * Updates a cleaning task. Finishing one updates the room: a clean makes it
 * clean, an inspection makes it inspected. A room that is not clean cannot be
 * marked as inspected.
 */
export async function updateHousekeepingTask(
  db: DbOrTx,
  actor: Actor,
  taskId: string,
  patch: TaskPatch,
): Promise<HousekeepingTaskRow> {
  return transact(db, async (tx) => {
    const [row] = await tx
      .select({ task: housekeepingTasks })
      .from(housekeepingTasks)
      .innerJoin(properties, eq(properties.id, housekeepingTasks.propertyId))
      .where(and(eq(housekeepingTasks.id, taskId), eq(properties.orgId, actor.orgId)))
      .for('update', { of: housekeepingTasks });
    if (!row) throw notFound('Task', taskId);
    const before = row.task;
    const set: Partial<typeof housekeepingTasks.$inferInsert> = {};
    if (patch.assignedTo !== undefined) set.assignedTo = patch.assignedTo;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
    if (patch.status !== undefined && patch.status !== before.status) {
      set.status = patch.status;
      if (patch.status === 'in_progress') set.startedAt = before.startedAt ?? new Date();
      if (patch.status === 'done') {
        set.completedAt = new Date();
        set.completedBy = actor.userId ?? null;
        const [unit] = await tx
          .select()
          .from(units)
          .where(eq(units.id, before.unitId))
          .for('update');
        if (before.kind === 'inspection') {
          if (unit!.housekeepingStatus === 'dirty') {
            throw invalidState(`${unit!.name} has not been cleaned; it cannot pass inspection yet`);
          }
          await tx
            .update(units)
            .set({ housekeepingStatus: 'inspected' })
            .where(eq(units.id, before.unitId));
        } else if (unit!.housekeepingStatus !== 'out_of_service') {
          await tx
            .update(units)
            .set({ housekeepingStatus: 'clean' })
            .where(eq(units.id, before.unitId));
        }
      }
      if (patch.status === 'pending') {
        set.startedAt = null;
        set.completedAt = null;
        set.completedBy = null;
      }
    }
    if (Object.keys(set).length === 0) return before;
    const [after] = await tx
      .update(housekeepingTasks)
      .set(set)
      .where(eq(housekeepingTasks.id, taskId))
      .returning();
    await emit(tx, actor.orgId, [
      { kind: 'task.updated', propertyId: before.propertyId, payload: { taskId } },
      { kind: 'unit.updated', propertyId: before.propertyId, payload: { unitId: before.unitId } },
    ]);
    return after!;
  });
}

/** Sets a room's cleaning state by hand. */
export async function setHousekeepingStatus(
  db: DbOrTx,
  actor: Actor,
  unitIds: string[],
  status: Exclude<HousekeepingStatus, 'out_of_service'>,
): Promise<number> {
  if (unitIds.length === 0) return 0;
  return transact(db, async (tx) => {
    const rows = await tx
      .select({ unit: units })
      .from(units)
      .innerJoin(properties, eq(properties.id, units.propertyId))
      .where(and(inArray(units.id, unitIds), eq(properties.orgId, actor.orgId)));
    if (rows.length !== unitIds.length) throw notFound('Unit');
    const changeable = rows.filter(
      (r) => r.unit.housekeepingStatus !== 'out_of_service' && r.unit.housekeepingStatus !== status,
    );
    if (changeable.length === 0) return 0;
    await tx
      .update(units)
      .set({ housekeepingStatus: status })
      .where(
        inArray(
          units.id,
          changeable.map((r) => r.unit.id),
        ),
      );
    const propertyIds = [...new Set(changeable.map((r) => r.unit.propertyId))];
    for (const propertyId of propertyIds) {
      await writeAudit(tx, actor, {
        action: 'housekeeping.status_set',
        entityType: 'unit',
        propertyId,
        summary: `Marked ${changeable
          .filter((r) => r.unit.propertyId === propertyId)
          .map((r) => r.unit.name)
          .join(', ')} as ${status}`,
      });
      await emit(tx, actor.orgId, [{ kind: 'unit.updated', propertyId, payload: {} }]);
    }
    return changeable.length;
  });
}
