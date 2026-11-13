import { and, asc, desc, eq, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  companies,
  inventoryBlocks,
  properties,
  reservationGroups,
  reservationRooms,
  reservations,
  roomTypes,
  type DbOrTx,
  type GroupStatus,
  type ReservationSource,
  type ReservationStatus,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import { createBlock, releaseBlock, updateBlock, type BlockOptions } from './blocks';
import type { Actor } from './context';
import { systemActor } from './context';
import { randomCode } from './crypto';
import { assertRange, eachDate, todayIn, type DateString } from './dates';
import type { DateRange } from './dates';
import { invalidState, notFound, validationError } from './errors';
import { groupOf, requireOpenGroup, type GroupRow } from './group-access';
import {
  getAvailability,
  withInventoryLock,
  type AvailabilityDay,
  type InventoryScope,
} from './inventory';
import { emit } from './outbox';
import { requireProperty } from './properties';
import {
  createReservation,
  loadReservation,
  lockReservation,
  type ReservationDetail,
  type ReservationOptions,
} from './reservations';
import { transact } from './sqlx';

export { requireOpenGroup, type GroupRow };

const MAX_HOLDS = 40;
const MAX_ROOMING_LIST = 100;

/** Statuses in which a booking uses one of the rooms held for its group. */
const USING: readonly ReservationStatus[] = ['tentative', 'confirmed', 'in_house', 'checked_out'];

export interface GroupHoldInput {
  roomTypeId: string;
  /** First night held. */
  from: DateString;
  /** The morning the rooms are given up: the first night not held. */
  to: DateString;
  /** How many rooms of the type to hold. */
  quantity: number;
}

export interface CreateGroupInput {
  propertyId: string;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  /** Rooms the group has not booked by the end of this day go back on general sale. */
  cutoffDate?: DateString | null;
  companyId?: string | null;
  notes?: string | null;
  holds: GroupHoldInput[];
}

export interface GroupPatch {
  name?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  cutoffDate?: DateString | null;
  companyId?: string | null;
  notes?: string | null;
}

export interface GroupHold {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  from: DateString;
  to: DateString;
  quantity: number;
}

/** One room type on one night: what is held, what the group has booked, what is left to book. */
export interface GroupNight {
  roomTypeId: string;
  date: DateString;
  held: number;
  booked: number;
  /** Held rooms nobody in the group has booked yet. */
  left: number;
}

export interface GroupBooking {
  id: string;
  code: string;
  guestName: string;
  status: ReservationStatus;
  checkIn: DateString;
  checkOut: DateString;
  rooms: { roomTypeId: string; roomTypeName: string; unitName: string | null }[];
  /** Room charges before tax. */
  totalAmount: number;
}

export interface GroupTotals {
  /** Room nights held, counting each room on each night. */
  heldNights: number;
  /** Room nights the group's bookings take up, on held nights or not. */
  bookedNights: number;
  /** Held room nights still waiting for a booking. */
  leftNights: number;
  bookings: number;
  /** Room charges before tax of the bookings that stand. */
  value: number;
}

export interface GroupSummary extends GroupTotals {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  status: GroupStatus;
  contactName: string | null;
  cutoffDate: DateString | null;
  /** First night and departure morning across the held rooms and the bookings. */
  from: DateString | null;
  to: DateString | null;
  currency: string;
}

export interface GroupDetail extends GroupSummary {
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  company: { id: string; name: string; kind: string } | null;
  releasedAt: Date | null;
  createdAt: Date;
  holds: GroupHold[];
  nights: GroupNight[];
  reservations: GroupBooking[];
}

// ---------------------------------------------------------------------------
// Loading

/** The property a group belongs to, for permission checks. */
export async function groupPropertyId(db: DbOrTx, orgId: string, groupId: string): Promise<string> {
  return (await groupOf(db, orgId, groupId)).group.propertyId;
}

async function holdsOf(
  db: DbOrTx,
  groupIds: string[],
): Promise<(GroupHold & { groupId: string })[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({ block: inventoryBlocks, roomTypeName: roomTypes.name })
    .from(inventoryBlocks)
    .innerJoin(roomTypes, eq(roomTypes.id, inventoryBlocks.roomTypeId))
    .where(
      and(
        inArray(inventoryBlocks.groupId, groupIds),
        eq(inventoryBlocks.kind, 'hold'),
        isNull(inventoryBlocks.unitId),
        isNull(inventoryBlocks.releasedAt),
      ),
    )
    .orderBy(asc(inventoryBlocks.startDate), asc(roomTypes.sortOrder), asc(roomTypes.name));
  return rows.map(({ block, roomTypeName }) => ({
    groupId: block.groupId!,
    id: block.id,
    roomTypeId: block.roomTypeId,
    roomTypeName,
    from: block.startDate,
    to: block.endDate,
    quantity: block.quantity,
  }));
}

interface BookedRoom {
  groupId: string;
  reservationId: string;
  roomTypeId: string;
  roomTypeName: string;
  unitName: string | null;
  checkIn: DateString;
  checkOut: DateString;
  status: ReservationStatus;
}

async function roomsOf(db: DbOrTx, groupIds: string[]): Promise<BookedRoom[]> {
  if (groupIds.length === 0) return [];
  const { rows } = await db.execute<{
    group_id: string;
    reservation_id: string;
    room_type_id: string;
    room_type_name: string;
    unit_name: string | null;
    check_in: string;
    check_out: string;
    status: ReservationStatus;
  }>(sql`
    SELECT r.group_id, rr.reservation_id, rr.room_type_id, rt.name AS room_type_name,
           u.name AS unit_name, rr.check_in::text, rr.check_out::text, rr.status
    FROM reservations r
    JOIN reservation_rooms rr ON rr.reservation_id = r.id
    JOIN room_types rt ON rt.id = rr.room_type_id
    LEFT JOIN units u ON u.id = rr.unit_id
    WHERE r.group_id IN (${sql.join(
      groupIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    ORDER BY rr.position, rr.id
  `);
  return rows.map((r) => ({
    groupId: r.group_id,
    reservationId: r.reservation_id,
    roomTypeId: r.room_type_id,
    roomTypeName: r.room_type_name,
    unitName: r.unit_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    status: r.status,
  }));
}

/** Per room type and night: rooms held, rooms booked by the group, and what is left of the hold. */
function nightsOf(holds: GroupHold[], rooms: BookedRoom[]): GroupNight[] {
  const cells = new Map<string, GroupNight>();
  const cell = (roomTypeId: string, date: DateString): GroupNight => {
    const key = `${roomTypeId}|${date}`;
    let night = cells.get(key);
    if (!night) {
      night = { roomTypeId, date, held: 0, booked: 0, left: 0 };
      cells.set(key, night);
    }
    return night;
  };
  for (const hold of holds) {
    for (const date of eachDate(hold.from, hold.to))
      cell(hold.roomTypeId, date).held += hold.quantity;
  }
  for (const room of rooms) {
    if (!USING.includes(room.status)) continue;
    for (const date of eachDate(room.checkIn, room.checkOut)) cell(room.roomTypeId, date).booked++;
  }
  const nights = [...cells.values()];
  for (const night of nights) night.left = Math.max(0, night.held - night.booked);
  return nights.sort(
    (a, b) => a.date.localeCompare(b.date) || a.roomTypeId.localeCompare(b.roomTypeId),
  );
}

function groupTotals(
  nights: GroupNight[],
  bookings: { status: ReservationStatus; totalAmount: number }[],
): GroupTotals {
  const standing = bookings.filter((b) => USING.includes(b.status));
  return {
    heldNights: nights.reduce((sum, n) => sum + n.held, 0),
    bookedNights: nights.reduce((sum, n) => sum + n.booked, 0),
    leftNights: nights.reduce((sum, n) => sum + n.left, 0),
    bookings: standing.length,
    value: standing.reduce((sum, b) => sum + b.totalAmount, 0),
  };
}

function spanOf(
  holds: GroupHold[],
  rooms: BookedRoom[],
): { from: DateString | null; to: DateString | null } {
  const live = rooms.filter((r) => USING.includes(r.status));
  const starts = [...holds.map((h) => h.from), ...live.map((r) => r.checkIn)].sort();
  const ends = [...holds.map((h) => h.to), ...live.map((r) => r.checkOut)].sort();
  return { from: starts[0] ?? null, to: ends[ends.length - 1] ?? null };
}

export interface GroupFilter {
  propertyId: string;
  /** Leave out for groups that are still open. */
  status?: GroupStatus | 'all';
  /** Part of the group's name, code or contact. */
  search?: string;
}

export async function listGroups(
  db: DbOrTx,
  orgId: string,
  filter: GroupFilter,
): Promise<GroupSummary[]> {
  const property = await requireProperty(db, orgId, filter.propertyId);
  const status = filter.status ?? 'open';
  const term = filter.search?.trim();
  const rows = await db
    .select()
    .from(reservationGroups)
    .where(
      and(
        eq(reservationGroups.propertyId, property.id),
        status === 'all' ? undefined : eq(reservationGroups.status, status),
        term
          ? or(
              ilike(reservationGroups.name, `%${term}%`),
              ilike(reservationGroups.code, `%${term}%`),
              ilike(reservationGroups.contactName, `%${term}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(reservationGroups.createdAt))
    .limit(200);
  const ids = rows.map((g) => g.id);
  // One after the other: this may run inside a transaction, which has one connection.
  const holds = await holdsOf(db, ids);
  const rooms = await roomsOf(db, ids);
  const amounts = ids.length
    ? await db
        .select({
          groupId: reservations.groupId,
          status: reservations.status,
          totalAmount: reservations.totalAmount,
        })
        .from(reservations)
        .where(inArray(reservations.groupId, ids))
    : [];
  const summaries = rows.map((group) => {
    const groupHolds = holds.filter((h) => h.groupId === group.id);
    const groupRooms = rooms.filter((r) => r.groupId === group.id);
    return {
      id: group.id,
      propertyId: group.propertyId,
      code: group.code,
      name: group.name,
      status: group.status,
      contactName: group.contactName,
      cutoffDate: group.cutoffDate,
      currency: property.currency,
      ...spanOf(groupHolds, groupRooms),
      ...groupTotals(
        nightsOf(groupHolds, groupRooms),
        amounts.filter((a) => a.groupId === group.id),
      ),
    };
  });
  // Soonest first; groups with no dates left (everything released) go last.
  return summaries.sort((a, b) => (a.from ?? '9999').localeCompare(b.from ?? '9999'));
}

export async function getGroup(db: DbOrTx, orgId: string, groupId: string): Promise<GroupDetail> {
  const { group, currency } = await groupOf(db, orgId, groupId);
  const holds = await holdsOf(db, [group.id]);
  const rooms = await roomsOf(db, [group.id]);
  const bookingRows = await db
    .select({
      id: reservations.id,
      code: reservations.code,
      guestName: reservations.guestName,
      status: reservations.status,
      checkIn: reservations.checkIn,
      checkOut: reservations.checkOut,
      totalAmount: reservations.totalAmount,
    })
    .from(reservations)
    .where(eq(reservations.groupId, group.id))
    .orderBy(asc(reservations.checkIn), asc(reservations.guestName), asc(reservations.id));
  const [company = null] = group.companyId
    ? await db
        .select({ id: companies.id, name: companies.name, kind: companies.kind })
        .from(companies)
        .where(eq(companies.id, group.companyId))
    : [];
  const nights = nightsOf(holds, rooms);
  const bookings: GroupBooking[] = bookingRows.map((b) => ({
    ...b,
    rooms: rooms
      .filter((r) => r.reservationId === b.id)
      .map((r) => ({
        roomTypeId: r.roomTypeId,
        roomTypeName: r.roomTypeName,
        unitName: r.unitName,
      })),
  }));
  return {
    id: group.id,
    propertyId: group.propertyId,
    code: group.code,
    name: group.name,
    status: group.status,
    contactName: group.contactName,
    contactEmail: group.contactEmail,
    contactPhone: group.contactPhone,
    cutoffDate: group.cutoffDate,
    notes: group.notes,
    company,
    releasedAt: group.releasedAt,
    createdAt: group.createdAt,
    currency,
    ...spanOf(holds, rooms),
    ...groupTotals(nights, bookings),
    holds: holds.map(({ groupId: _groupId, ...hold }) => hold),
    nights,
    reservations: bookings,
  };
}

/**
 * Rooms of each type and night that only this group may still book: what is
 * left of its hold. Added to general availability when a booking is being
 * made for the group.
 */
export async function groupRoomsLeft(
  db: DbOrTx,
  orgId: string,
  groupId: string,
): Promise<GroupNight[]> {
  const { group } = await groupOf(db, orgId, groupId);
  const holds = await holdsOf(db, [group.id]);
  const rooms = await roomsOf(db, [group.id]);
  return nightsOf(holds, rooms).filter((n) => n.left > 0);
}

/** Availability as the group sees it: what anyone may book, plus what is left of its own hold. */
export async function getGroupAvailability(
  db: DbOrTx,
  orgId: string,
  groupId: string,
  params: { propertyId: string; range: DateRange; roomTypeIds?: string[] },
): Promise<AvailabilityDay[]> {
  await requireOpenGroup(db, orgId, groupId, params.propertyId);
  const days = await getAvailability(db, params);
  const left = await groupRoomsLeft(db, orgId, groupId);
  const own = new Map(left.map((n) => [`${n.roomTypeId}|${n.date}`, n.left]));
  return days.map((day) => ({
    ...day,
    available: day.available + (own.get(`${day.roomTypeId}|${day.date}`) ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Writing

async function newGroupCode(tx: DbOrTx, propertyId: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `G${randomCode(5)}`;
    const [clash] = await tx
      .select({ id: reservationGroups.id })
      .from(reservationGroups)
      .where(and(eq(reservationGroups.propertyId, propertyId), eq(reservationGroups.code, code)));
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique group code');
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function validateName(name: string): string {
  const text = name.trim();
  if (!text) throw validationError('Give the group a name');
  if (text.length > 120) throw validationError('The name may be at most 120 characters');
  return text;
}

function validateHold(hold: GroupHoldInput): void {
  assertRange(hold.from, hold.to, 'held dates');
  if (!Number.isInteger(hold.quantity) || hold.quantity < 1) {
    throw validationError('Hold at least one room');
  }
}

/** A cut-off after the first held night would release rooms the group is already sleeping in. */
function validateCutoff(cutoff: DateString | null, firstNight: DateString | null): void {
  if (cutoff && firstNight && cutoff > firstNight) {
    throw validationError('The cut-off date cannot be after the first night held');
  }
}

async function requireActiveCompany(tx: DbOrTx, orgId: string, companyId: string): Promise<void> {
  const [company] = await tx
    .select({ active: companies.active })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)));
  if (!company) throw notFound('Company', companyId);
  if (!company.active) throw validationError('This company is no longer in use');
}

/** Rooms can be held by number only where they are sold by number. */
async function requireCountSold(tx: DbOrTx, propertyId: string, roomTypeId: string): Promise<void> {
  const [roomType] = await tx
    .select({ name: roomTypes.name, assignment: roomTypes.assignment })
    .from(roomTypes)
    .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId)));
  if (!roomType) throw notFound('Room type', roomTypeId);
  if (roomType.assignment === 'at_booking') {
    throw validationError(
      `${roomType.name} is booked unit by unit, so it cannot be held by number. Book it for the group instead.`,
    );
  }
}

async function touch(tx: Transaction, orgId: string, group: GroupRow): Promise<void> {
  await tx
    .update(reservationGroups)
    .set({ updatedAt: new Date() })
    .where(eq(reservationGroups.id, group.id));
  await emit(tx, orgId, [
    { kind: 'group.updated', propertyId: group.propertyId, payload: { groupId: group.id } },
  ]);
}

/**
 * Starts a group booking and takes its rooms out of general sale. The hold
 * reaches the booking channels like any other block; if the rooms are not
 * free, nothing is saved.
 */
export async function createGroup(
  db: DbOrTx,
  actor: Actor,
  input: CreateGroupInput,
  options: Pick<BlockOptions, 'allowOverbooking'> = {},
): Promise<GroupDetail> {
  const name = validateName(input.name);
  if (input.holds.length > MAX_HOLDS) {
    throw validationError(`A group may hold at most ${MAX_HOLDS} sets of rooms`);
  }
  input.holds.forEach(validateHold);
  validateCutoff(input.cutoffDate ?? null, input.holds.map((h) => h.from).sort()[0] ?? null);

  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, input.propertyId);
    if (input.companyId) await requireActiveCompany(tx, actor.orgId, input.companyId);
    const [group] = await tx
      .insert(reservationGroups)
      .values({
        propertyId: property.id,
        code: await newGroupCode(tx, property.id),
        name,
        contactName: cleanText(input.contactName),
        contactEmail: cleanText(input.contactEmail),
        contactPhone: cleanText(input.contactPhone),
        cutoffDate: input.cutoffDate ?? null,
        companyId: input.companyId ?? null,
        notes: cleanText(input.notes),
        createdBy: actor.userId ?? null,
      })
      .returning();
    for (const hold of input.holds) {
      await requireCountSold(tx, property.id, hold.roomTypeId);
      await createBlock(
        tx,
        actor,
        {
          propertyId: property.id,
          roomTypeId: hold.roomTypeId,
          quantity: hold.quantity,
          kind: 'hold',
          startDate: hold.from,
          endDate: hold.to,
          reason: name,
          groupId: group!.id,
        },
        options,
      );
    }
    await writeAudit(tx, actor, {
      action: 'group.created',
      entityType: 'group',
      entityId: group!.id,
      propertyId: property.id,
      summary: `Started group ${name} (${group!.code})`,
      changes: {
        holds: input.holds.map((h) => ({ from: h.from, to: h.to, rooms: h.quantity })),
        cutoffDate: input.cutoffDate ?? null,
      },
    });
    await emit(tx, actor.orgId, [
      { kind: 'group.updated', propertyId: property.id, payload: { groupId: group!.id } },
    ]);
    return getGroup(tx, actor.orgId, group!.id);
  });
}

export async function updateGroup(
  db: DbOrTx,
  actor: Actor,
  groupId: string,
  patch: GroupPatch,
): Promise<GroupDetail> {
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    const set: Partial<typeof reservationGroups.$inferInsert> = {};
    if (patch.name !== undefined) set.name = validateName(patch.name);
    if (patch.contactName !== undefined) set.contactName = cleanText(patch.contactName);
    if (patch.contactEmail !== undefined) set.contactEmail = cleanText(patch.contactEmail);
    if (patch.contactPhone !== undefined) set.contactPhone = cleanText(patch.contactPhone);
    if (patch.notes !== undefined) set.notes = cleanText(patch.notes);
    if (patch.companyId !== undefined) {
      if (patch.companyId && patch.companyId !== group.companyId) {
        await requireActiveCompany(tx, actor.orgId, patch.companyId);
      }
      set.companyId = patch.companyId;
    }
    if (patch.cutoffDate !== undefined) {
      const holds = await holdsOf(tx, [group.id]);
      validateCutoff(patch.cutoffDate, holds.map((h) => h.from).sort()[0] ?? null);
      set.cutoffDate = patch.cutoffDate;
    }
    const changed = Object.entries(set).filter(
      ([key, value]) => value !== (group as Record<string, unknown>)[key],
    );
    if (changed.length === 0) return getGroup(tx, actor.orgId, groupId);
    await tx.update(reservationGroups).set(set).where(eq(reservationGroups.id, groupId));
    if (set.name && set.name !== group.name) {
      // The calendar labels held rooms with the group's name.
      await tx
        .update(inventoryBlocks)
        .set({ reason: set.name })
        .where(and(eq(inventoryBlocks.groupId, groupId), isNull(inventoryBlocks.releasedAt)));
    }
    await writeAudit(tx, actor, {
      action: 'group.updated',
      entityType: 'group',
      entityId: groupId,
      propertyId: group.propertyId,
      summary: `Changed ${changed.map(([key]) => key).join(', ')} of group ${group.name}`,
      changes: Object.fromEntries(
        changed.map(([key, value]) => [
          key,
          { from: (group as Record<string, unknown>)[key], to: value },
        ]),
      ),
    });
    await touch(tx, actor.orgId, group);
    return getGroup(tx, actor.orgId, groupId);
  });
}

async function requireHold(tx: DbOrTx, group: GroupRow, blockId: string): Promise<void> {
  const [block] = await tx
    .select({ id: inventoryBlocks.id })
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.id, blockId),
        eq(inventoryBlocks.groupId, group.id),
        isNull(inventoryBlocks.releasedAt),
      ),
    );
  if (!block) throw notFound('Held rooms', blockId);
}

/** Holds more rooms for the group. A group whose rooms had been released holds rooms again. */
export async function addGroupHold(
  db: DbOrTx,
  actor: Actor,
  groupId: string,
  hold: GroupHoldInput,
  options: Pick<BlockOptions, 'allowOverbooking'> = {},
): Promise<GroupDetail> {
  validateHold(hold);
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    if (group.status === 'cancelled') throw invalidState('This group has been cancelled');
    const holds = await holdsOf(tx, [group.id]);
    if (holds.length >= MAX_HOLDS) {
      throw validationError(`A group may hold at most ${MAX_HOLDS} sets of rooms`);
    }
    await requireCountSold(tx, group.propertyId, hold.roomTypeId);
    await createBlock(
      tx,
      actor,
      {
        propertyId: group.propertyId,
        roomTypeId: hold.roomTypeId,
        quantity: hold.quantity,
        kind: 'hold',
        startDate: hold.from,
        endDate: hold.to,
        reason: group.name,
        groupId: group.id,
      },
      options,
    );
    const set: Partial<typeof reservationGroups.$inferInsert> = {};
    if (group.status === 'closed') {
      set.status = 'open';
      set.releasedAt = null;
    }
    // A cut-off that would now fall after the first held night no longer makes sense.
    const first = [hold.from, ...holds.map((h) => h.from)].sort()[0]!;
    if (group.cutoffDate && group.cutoffDate > first) set.cutoffDate = first;
    if (Object.keys(set).length > 0) {
      await tx.update(reservationGroups).set(set).where(eq(reservationGroups.id, group.id));
    }
    await touch(tx, actor.orgId, group);
    return getGroup(tx, actor.orgId, groupId);
  });
}

/** Changes how many rooms are held, or for which nights. */
export async function changeGroupHold(
  db: DbOrTx,
  actor: Actor,
  groupId: string,
  blockId: string,
  patch: { from?: DateString; to?: DateString; quantity?: number },
  options: Pick<BlockOptions, 'allowOverbooking'> = {},
): Promise<GroupDetail> {
  if (patch.quantity !== undefined && (!Number.isInteger(patch.quantity) || patch.quantity < 1)) {
    throw validationError('Hold at least one room');
  }
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    await requireHold(tx, group, blockId);
    await updateBlock(
      tx,
      actor,
      blockId,
      { startDate: patch.from, endDate: patch.to, quantity: patch.quantity },
      options,
    );
    await touch(tx, actor.orgId, group);
    return getGroup(tx, actor.orgId, groupId);
  });
}

/** Gives up one set of held rooms. The group's bookings stay as they are. */
export async function removeGroupHold(
  db: DbOrTx,
  actor: Actor,
  groupId: string,
  blockId: string,
): Promise<GroupDetail> {
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    await requireHold(tx, group, blockId);
    await releaseBlock(tx, actor, blockId);
    await touch(tx, actor.orgId, group);
    return getGroup(tx, actor.orgId, groupId);
  });
}

async function releaseHolds(
  tx: Transaction,
  actor: Actor,
  group: GroupRow,
  status: 'closed' | 'cancelled',
): Promise<number> {
  const holds = await holdsOf(tx, [group.id]);
  const rooms = await roomsOf(tx, [group.id]);
  const left = nightsOf(holds, rooms).reduce((sum, n) => sum + n.left, 0);
  for (const hold of holds) await releaseBlock(tx, actor, hold.id);
  await tx
    .update(reservationGroups)
    .set({ status, releasedAt: new Date() })
    .where(eq(reservationGroups.id, group.id));
  return left;
}

/**
 * Puts the rooms nobody in the group has booked back on general sale. The
 * bookings already made are kept, and more can still be added from whatever
 * is free.
 */
export async function releaseGroupRooms(
  db: DbOrTx,
  actor: Actor,
  groupId: string,
  reason: 'manual' | 'cutoff' = 'manual',
): Promise<GroupDetail> {
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    if (group.status !== 'open') return getGroup(tx, actor.orgId, groupId);
    const left = await releaseHolds(tx, actor, group, 'closed');
    await writeAudit(tx, actor, {
      action: 'group.released',
      entityType: 'group',
      entityId: group.id,
      propertyId: group.propertyId,
      summary:
        reason === 'cutoff'
          ? `Cut-off reached for group ${group.name}: ${left} unbooked room nights went back on sale`
          : `Released the unbooked rooms of group ${group.name} (${left} room nights)`,
      changes: { reason, roomNights: left },
    });
    await emit(tx, actor.orgId, [
      { kind: 'group.updated', propertyId: group.propertyId, payload: { groupId: group.id } },
    ]);
    return getGroup(tx, actor.orgId, groupId);
  });
}

/**
 * Calls the event off: the held rooms go back on sale. Bookings that still
 * stand have to be cancelled one by one first, because each has its own
 * payments and cancellation terms.
 */
export async function cancelGroup(db: DbOrTx, actor: Actor, groupId: string): Promise<GroupDetail> {
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    if (group.status === 'cancelled') return getGroup(tx, actor.orgId, groupId);
    const [standing] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        and(
          eq(reservations.groupId, group.id),
          inArray(reservations.status, ['tentative', 'confirmed', 'in_house']),
        ),
      );
    if ((standing?.n ?? 0) > 0) {
      throw invalidState(
        standing!.n === 1
          ? 'One booking of this group still stands. Cancel it first.'
          : `${standing!.n} bookings of this group still stand. Cancel them first.`,
      );
    }
    await releaseHolds(tx, actor, group, 'cancelled');
    await writeAudit(tx, actor, {
      action: 'group.cancelled',
      entityType: 'group',
      entityId: group.id,
      propertyId: group.propertyId,
      summary: `Cancelled group ${group.name} (${group.code})`,
    });
    await emit(tx, actor.orgId, [
      { kind: 'group.updated', propertyId: group.propertyId, payload: { groupId: group.id } },
    ]);
    return getGroup(tx, actor.orgId, groupId);
  });
}

/**
 * Moves a booking into a group, or out of it. Its nights are rebuilt, because
 * a booking in a group uses the group's held rooms and one outside does not.
 */
export async function setReservationGroup(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  groupId: string | null,
  options: Pick<ReservationOptions, 'allowOverbooking'> = {},
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(tx, actor.orgId, reservationId);
    if (reservation.groupId === groupId) return loadReservation(tx, actor.orgId, reservationId);
    const group = groupId
      ? await requireOpenGroup(tx, actor.orgId, groupId, reservation.propertyId)
      : null;
    const rooms = await tx
      .select({
        roomTypeId: reservationRooms.roomTypeId,
        checkIn: reservationRooms.checkIn,
        checkOut: reservationRooms.checkOut,
      })
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId));
    const scopes: InventoryScope[] = rooms.map((r) => ({
      roomTypeId: r.roomTypeId,
      range: { from: r.checkIn, to: r.checkOut },
    }));
    await withInventoryLock(tx, actor.orgId, scopes, options, async () => {
      await tx
        .update(reservations)
        .set({ groupId, version: sql`${reservations.version} + 1` })
        .where(eq(reservations.id, reservationId));
    });
    const before = reservation.groupId
      ? (await groupOf(tx, actor.orgId, reservation.groupId)).group
      : null;
    await writeAudit(tx, actor, {
      action: 'reservation.updated',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: group
        ? `Added reservation ${reservation.code} to group ${group.name}`
        : `Took reservation ${reservation.code} out of group ${before?.name ?? ''}`.trim(),
      changes: { group: { from: before?.code ?? null, to: group?.code ?? null } },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: reservation.propertyId,
        payload: { reservationId, code: reservation.code },
      },
      ...[before, group]
        .filter((g): g is GroupRow => g !== null)
        .map((g) => ({
          kind: 'group.updated' as const,
          propertyId: g.propertyId,
          payload: { groupId: g.id },
        })),
    ]);
    return loadReservation(tx, actor.orgId, reservationId);
  });
}

export interface RoomingListInput {
  roomTypeId: string;
  ratePlanId?: string | null;
  checkIn: DateString;
  checkOut: DateString;
  adults?: number;
  /** Charge per room per night in minor units, before tax. Leave out to price from the rate plan. */
  nightlyRate?: number;
  source?: ReservationSource;
  /** One booking is made for each: a room each. */
  guests: { firstName: string; lastName?: string; email?: string | null; phone?: string | null }[];
}

/**
 * Books a room for each guest of a rooming list, all or none: if the rooms
 * run out part-way, no booking is made and the list can be corrected.
 */
export async function addRoomingList(
  db: DbOrTx,
  actor: Actor,
  groupId: string,
  input: RoomingListInput,
  options: Pick<ReservationOptions, 'allowOverbooking'> = {},
): Promise<{ group: GroupDetail; reservations: ReservationDetail[] }> {
  if (input.guests.length === 0) throw validationError('Add at least one guest');
  if (input.guests.length > MAX_ROOMING_LIST) {
    throw validationError(`A rooming list may have at most ${MAX_ROOMING_LIST} guests at a time`);
  }
  const range = assertRange(input.checkIn, input.checkOut, 'stay');
  const nights = eachDate(range.from, range.to).length;
  return transact(db, async (tx) => {
    const { group } = await groupOf(tx, actor.orgId, groupId, true);
    if (group.status === 'cancelled') throw invalidState('This group has been cancelled');
    const made: ReservationDetail[] = [];
    for (const guest of input.guests) {
      if (!guest.firstName.trim()) throw validationError('Every guest needs a name');
      made.push(
        await createReservation(
          tx,
          actor,
          {
            propertyId: group.propertyId,
            source: input.source ?? (group.companyId ? 'corporate' : 'direct'),
            guest: {
              firstName: guest.firstName.trim(),
              lastName: guest.lastName?.trim() || undefined,
              email: guest.email?.trim() || null,
              phone: guest.phone?.trim() || null,
            },
            rooms: [
              {
                roomTypeId: input.roomTypeId,
                ratePlanId: input.ratePlanId ?? null,
                checkIn: range.from,
                checkOut: range.to,
                adults: input.adults ?? 1,
                ...(input.nightlyRate !== undefined
                  ? { nightlyRates: Array.from({ length: nights }, () => input.nightlyRate!) }
                  : {}),
              },
            ],
            groupId: group.id,
          },
          options,
        ),
      );
    }
    await touch(tx, actor.orgId, group);
    return { group: await getGroup(tx, actor.orgId, groupId), reservations: made };
  });
}

/**
 * Releases the unbooked rooms of every group whose cut-off day has passed,
 * judged by the date at the group's own property. Returns the groups released.
 */
export async function releaseDueGroupRooms(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<{ groupId: string; name: string }[]> {
  // The widest candidate set first (a day ahead of UTC covers every zone),
  // then each one against its property's own calendar day.
  const horizon = new Date(now.getTime() + 36 * 3600_000).toISOString().slice(0, 10);
  const due = await db
    .select({
      id: reservationGroups.id,
      name: reservationGroups.name,
      cutoffDate: reservationGroups.cutoffDate,
      orgId: properties.orgId,
      timezone: properties.timezone,
    })
    .from(reservationGroups)
    .innerJoin(properties, eq(properties.id, reservationGroups.propertyId))
    .where(and(eq(reservationGroups.status, 'open'), lte(reservationGroups.cutoffDate, horizon)))
    .limit(200);
  const released: { groupId: string; name: string }[] = [];
  for (const group of due) {
    // Bookings made on the cut-off day itself still count.
    if (!group.cutoffDate || group.cutoffDate >= todayIn(group.timezone, now)) continue;
    await releaseGroupRooms(db, systemActor(group.orgId, 'group-cutoff'), group.id, 'cutoff');
    released.push({ groupId: group.id, name: group.name });
  }
  return released;
}
