import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, outbox } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { getCalendar } from './calendar';
import { createCompany } from './companies';
import { DomainError } from './errors';
import {
  addGroupHold,
  addRoomingList,
  cancelGroup,
  changeGroupHold,
  createGroup,
  getGroup,
  getGroupAvailability,
  listGroups,
  releaseDueGroupRooms,
  releaseGroupRooms,
  removeGroupHold,
  setReservationGroup,
  updateGroup,
} from './groups';
import { findLedgerMismatches, getAvailability } from './inventory';
import {
  cancelReservation,
  createReservation,
  loadReservation,
  updateReservationRoom,
  type CreateReservationInput,
} from './reservations';
import {
  createTestHotel,
  createTestOrg,
  createTestVilla,
  type TestHotel,
  type TestOrg,
  type TestRoomType,
} from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;

beforeAll(async () => {
  t = await createTestDatabase({ max: 20 });
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 6, deluxeRooms: 2 });
});
afterAll(async () => {
  await t.drop();
});

let seq = 0;
function booking(
  type: TestRoomType,
  checkIn: string,
  checkOut: string,
  extra: Partial<CreateReservationInput> = {},
): CreateReservationInput {
  seq++;
  return {
    propertyId: hotel.property.id,
    source: 'direct',
    guest: { firstName: 'Guest', lastName: `Number${seq}`, email: `g${seq}@example.com` },
    rooms: [
      { roomTypeId: type.roomType.id, ratePlanId: type.ratePlan.id, checkIn, checkOut, adults: 1 },
    ],
    ...extra,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to fail').toBeInstanceOf(DomainError);
  return err as DomainError;
}

async function available(type: TestRoomType, from: string, to: string): Promise<number[]> {
  const days = await getAvailability(t.db, {
    propertyId: hotel.property.id,
    range: { from, to },
    roomTypeIds: [type.roomType.id],
  });
  return days.map((d) => d.available);
}

async function expectLedgerSound(): Promise<void> {
  expect(
    await findLedgerMismatches(t.db, {
      propertyId: hotel.property.id,
      range: { from: '2027-01-01', to: '2028-03-01' },
    }),
  ).toEqual([]);
  const { rows } = await t.db.execute(sql`
    SELECT 1 FROM inventory_days
    WHERE property_id = ${hotel.property.id} AND sold + blocked + out_of_order + linked > total
    LIMIT 1`);
  expect(rows).toHaveLength(0);
}

describe('group bookings', () => {
  it('holds rooms out of general sale, and the group books from its own hold', async () => {
    const { property, standard } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Mehta wedding',
      contactName: 'Asha Mehta',
      contactEmail: 'asha@example.com',
      cutoffDate: '2027-02-20',
      holds: [
        { roomTypeId: standard.roomType.id, from: '2027-03-10', to: '2027-03-13', quantity: 4 },
      ],
    });
    expect(group.code).toMatch(/^G[A-Z2-9]{5}$/);
    expect(group).toMatchObject({
      status: 'open',
      from: '2027-03-10',
      to: '2027-03-13',
      heldNights: 12,
      bookedNights: 0,
      leftNights: 12,
      bookings: 0,
    });
    expect(group.holds).toEqual([
      expect.objectContaining({ roomTypeName: 'Standard Room', quantity: 4, from: '2027-03-10' }),
    ]);
    // Six rooms, four held: two left for everyone else, and the channels are told.
    expect(await available(standard, '2027-03-09', '2027-03-14')).toEqual([6, 2, 2, 2, 6]);
    const pushes = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.propertyId, property.id), eq(outbox.kind, 'ari.availability')));
    expect(pushes.map((p) => p.payload)).toContainEqual({
      roomTypeId: standard.roomType.id,
      from: '2027-03-10',
      to: '2027-03-13',
    });
    const before = pushes.length;

    // A guest of the wedding books two nights: it uses a held room, so what
    // everyone else can book does not move, and nothing is sent to the channels.
    const stay = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-03-10', '2027-03-12', { groupId: group.id }),
    );
    expect(stay.group).toEqual({ id: group.id, code: group.code, name: 'Mehta wedding' });
    expect(await available(standard, '2027-03-09', '2027-03-14')).toEqual([6, 2, 2, 2, 6]);
    const after = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.propertyId, property.id), eq(outbox.kind, 'ari.availability')));
    expect(after).toHaveLength(before);

    const detail = await getGroup(t.db, org.orgId, group.id);
    expect(detail).toMatchObject({ heldNights: 12, bookedNights: 2, leftNights: 10, bookings: 1 });
    expect(detail.nights.map((n) => [n.date, n.held, n.booked, n.left])).toEqual([
      ['2027-03-10', 4, 1, 3],
      ['2027-03-11', 4, 1, 3],
      ['2027-03-12', 4, 0, 4],
    ]);
    expect(detail.reservations).toEqual([
      expect.objectContaining({
        code: stay.code,
        status: 'confirmed',
        totalAmount: stay.totalAmount,
      }),
    ]);
    await expectLedgerSound();
  });

  it('lets the group book when nothing is left for anyone else', async () => {
    const { property, standard } = hotel;
    const [group] = await listGroups(t.db, org.orgId, { propertyId: property.id });
    // The two rooms outside the hold are sold.
    await createReservation(t.db, org.admin, booking(standard, '2027-03-10', '2027-03-13'));
    await createReservation(t.db, org.admin, booking(standard, '2027-03-10', '2027-03-13'));
    expect(await available(standard, '2027-03-10', '2027-03-13')).toEqual([0, 0, 0]);

    // The public cannot book...
    const refused = await errorOf(
      createReservation(t.db, org.admin, booking(standard, '2027-03-11', '2027-03-12')),
    );
    expect(refused.code).toBe('no_availability');
    // ...but the group still sees, and can book, its own rooms.
    const own = await getGroupAvailability(t.db, org.orgId, group!.id, {
      propertyId: property.id,
      range: { from: '2027-03-10', to: '2027-03-13' },
      roomTypeIds: [standard.roomType.id],
    });
    expect(own.map((d) => d.available)).toEqual([3, 3, 4]);
    await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-03-11', '2027-03-13', { groupId: group!.id }),
    );
    expect((await getGroup(t.db, org.orgId, group!.id)).nights.map((n) => n.left)).toEqual([
      3, 2, 3,
    ]);
    await expectLedgerSound();
  });

  it('gives a cancelled booking’s room back to the hold, not to general sale', async () => {
    const { property, standard } = hotel;
    const [group] = await listGroups(t.db, org.orgId, { propertyId: property.id });
    const detail = await getGroup(t.db, org.orgId, group!.id);
    const first = detail.reservations.find((r) => r.checkIn === '2027-03-10')!;
    await cancelReservation(t.db, org.admin, first.id, { reason: 'Cannot come' });
    expect(await available(standard, '2027-03-10', '2027-03-13')).toEqual([0, 0, 0]);
    const after = await getGroup(t.db, org.orgId, group!.id);
    expect(after.nights.map((n) => n.left)).toEqual([4, 3, 3]);
    expect(after.bookings).toBe(1);
    expect(after.reservations.map((r) => r.status).sort()).toEqual(['cancelled', 'confirmed']);
    await expectLedgerSound();
  });

  it('follows a group booking when its dates change', async () => {
    const { standard } = hotel;
    const [group] = await listGroups(t.db, org.orgId, { propertyId: hotel.property.id });
    const detail = await getGroup(t.db, org.orgId, group!.id);
    const stay = detail.reservations.find((r) => r.status === 'confirmed')!;
    const full = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-03-12', '2027-03-13', { groupId: group!.id }),
    );
    // 11th and 12th -> 10th and 11th.
    const room = (await getGroup(t.db, org.orgId, group!.id)).reservations.find(
      (r) => r.id === stay.id,
    )!;
    expect(room.checkIn).toBe('2027-03-11');
    const { reservation } = await updateReservationRoom(
      t.db,
      org.admin,
      stay.id,
      (await loadReservation(t.db, org.orgId, stay.id)).rooms[0]!.id,
      { checkIn: '2027-03-10', checkOut: '2027-03-12' },
    );
    expect(reservation.checkIn).toBe('2027-03-10');
    expect((await getGroup(t.db, org.orgId, group!.id)).nights.map((n) => n.left)).toEqual([
      3, 3, 3,
    ]);
    expect(await available(standard, '2027-03-10', '2027-03-13')).toEqual([0, 0, 0]);
    await cancelReservation(t.db, org.admin, full.id, {});
    await expectLedgerSound();
  });

  it('books beyond the hold from general sale, and only if rooms are free there', async () => {
    const { property, deluxe, standard } = hotel;
    const [group] = await listGroups(t.db, org.orgId, { propertyId: property.id });
    // Deluxe rooms are not held at all: a group booking takes one like anyone would.
    await createReservation(
      t.db,
      org.admin,
      booking(deluxe, '2027-03-10', '2027-03-12', { groupId: group!.id }),
    );
    expect(await available(deluxe, '2027-03-10', '2027-03-12')).toEqual([1, 1]);
    // A night after the hold ends, with rooms free: fine. The 9th to the 10th
    // is before the hold and has rooms too.
    await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-03-09', '2027-03-10', { groupId: group!.id }),
    );
    expect(await available(standard, '2027-03-09', '2027-03-10')).toEqual([5]);
    await expectLedgerSound();
  });

  it('never lets the group take more than it holds plus what is free', async () => {
    const { property, deluxe } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Board offsite',
      holds: [
        { roomTypeId: deluxe.roomType.id, from: '2027-05-01', to: '2027-05-03', quantity: 1 },
      ],
    });
    await createReservation(t.db, org.admin, booking(deluxe, '2027-05-01', '2027-05-03'));
    expect(await available(deluxe, '2027-05-01', '2027-05-03')).toEqual([0, 0]);
    await createReservation(
      t.db,
      org.admin,
      booking(deluxe, '2027-05-01', '2027-05-03', { groupId: group.id }),
    );
    const refused = await errorOf(
      createReservation(
        t.db,
        org.admin,
        booking(deluxe, '2027-05-01', '2027-05-02', { groupId: group.id }),
      ),
    );
    expect(refused.code).toBe('no_availability');
    await expectLedgerSound();
  });

  it('holds more or fewer rooms, and refuses a hold the hotel cannot honour', async () => {
    const { property, standard, deluxe } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Sales conference',
      holds: [
        { roomTypeId: standard.roomType.id, from: '2027-06-01', to: '2027-06-04', quantity: 2 },
      ],
    });
    const refused = await errorOf(
      addGroupHold(t.db, org.admin, group.id, {
        roomTypeId: deluxe.roomType.id,
        from: '2027-06-01',
        to: '2027-06-04',
        quantity: 3,
      }),
    );
    expect(refused.message).toBe('Quantity must be between 1 and 2');

    const more = await addGroupHold(t.db, org.admin, group.id, {
      roomTypeId: deluxe.roomType.id,
      from: '2027-06-02',
      to: '2027-06-04',
      quantity: 2,
    });
    expect(more.holds).toHaveLength(2);
    expect(await available(deluxe, '2027-06-01', '2027-06-04')).toEqual([2, 0, 0]);

    const hold = more.holds.find((h) => h.roomTypeId === standard.roomType.id)!;
    const changed = await changeGroupHold(t.db, org.admin, group.id, hold.id, { quantity: 5 });
    expect(changed.heldNights).toBe(5 * 3 + 2 * 2);
    expect(await available(standard, '2027-06-01', '2027-06-04')).toEqual([1, 1, 1]);
    // Seven is more rooms than the hotel has.
    const tooMany = await errorOf(
      changeGroupHold(t.db, org.admin, group.id, hold.id, { quantity: 7 }),
    );
    expect(tooMany.message).toBe('Quantity must be between 1 and 6');
    // With a room sold to someone else, all six can no longer be held.
    const outsider = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-06-02', '2027-06-03'),
    );
    const taken = await errorOf(
      changeGroupHold(t.db, org.admin, group.id, hold.id, { quantity: 6 }),
    );
    expect(taken.code).toBe('no_availability');
    await cancelReservation(t.db, org.admin, outsider.id, {});

    const fewer = await removeGroupHold(
      t.db,
      org.admin,
      group.id,
      more.holds.find((h) => h.roomTypeId === deluxe.roomType.id)!.id,
    );
    expect(fewer.holds).toHaveLength(1);
    expect(await available(deluxe, '2027-06-01', '2027-06-04')).toEqual([2, 2, 2]);
    // A hold of another group cannot be touched through this one.
    const other = (await listGroups(t.db, org.orgId, { propertyId: property.id })).find(
      (g) => g.name === 'Mehta wedding',
    )!;
    const foreign = (await getGroup(t.db, org.orgId, other.id)).holds[0]!;
    expect((await errorOf(removeGroupHold(t.db, org.admin, group.id, foreign.id))).code).toBe(
      'not_found',
    );
    await expectLedgerSound();
  });

  it('refuses a hold when the rooms are already sold, and saves nothing', async () => {
    const { property, deluxe } = hotel;
    await createReservation(t.db, org.admin, booking(deluxe, '2027-07-01', '2027-07-03'));
    const refused = await errorOf(
      createGroup(t.db, org.admin, {
        propertyId: property.id,
        name: 'Too late',
        holds: [
          { roomTypeId: deluxe.roomType.id, from: '2027-07-01', to: '2027-07-03', quantity: 2 },
        ],
      }),
    );
    expect(refused.code).toBe('no_availability');
    const groups = await listGroups(t.db, org.orgId, { propertyId: property.id, status: 'all' });
    expect(groups.map((g) => g.name)).not.toContain('Too late');
  });

  it('books a rooming list in one go, or not at all', async () => {
    const { property, standard } = hotel;
    const company = await createCompany(t.db, org.admin, {
      name: 'Northwind Travel',
      kind: 'travel_agent',
    });
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Northwind tour',
      companyId: company.id,
      holds: [
        { roomTypeId: standard.roomType.id, from: '2027-08-01', to: '2027-08-03', quantity: 3 },
      ],
    });
    expect(group.company).toMatchObject({ name: 'Northwind Travel' });

    // Seven guests for a hotel of six rooms: nobody is booked.
    const seven = Array.from({ length: 7 }, (_, i) => ({ firstName: 'Tourist', lastName: `${i}` }));
    const refused = await errorOf(
      addRoomingList(t.db, org.admin, group.id, {
        roomTypeId: standard.roomType.id,
        ratePlanId: standard.ratePlan.id,
        checkIn: '2027-08-01',
        checkOut: '2027-08-03',
        guests: seven,
      }),
    );
    expect(refused.code).toBe('no_availability');
    expect((await getGroup(t.db, org.orgId, group.id)).reservations).toHaveLength(0);

    // Four guests: three from the hold, one from general sale, at the agreed rate.
    const { reservations, group: after } = await addRoomingList(t.db, org.admin, group.id, {
      roomTypeId: standard.roomType.id,
      ratePlanId: standard.ratePlan.id,
      checkIn: '2027-08-01',
      checkOut: '2027-08-03',
      nightlyRate: 300_000,
      guests: [
        { firstName: 'Lena', lastName: 'Ortiz', email: 'lena@example.com' },
        { firstName: 'Marek', lastName: 'Nowak' },
        { firstName: 'Sofia', lastName: 'Rossi' },
        { firstName: 'Tom', lastName: 'Baker' },
      ],
    });
    expect(reservations).toHaveLength(4);
    expect(reservations.map((r) => r.totalAmount)).toEqual([600_000, 600_000, 600_000, 600_000]);
    expect(reservations[0]).toMatchObject({
      guestName: 'Lena Ortiz',
      source: 'corporate',
      company: { name: 'Northwind Travel' },
      group: { name: 'Northwind tour' },
    });
    expect(after).toMatchObject({ bookings: 4, bookedNights: 8, leftNights: 0, value: 2_400_000 });
    // A single booking made for the group is for the same company, unless it names another.
    const one = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-08-03', '2027-08-04', { groupId: group.id }),
    );
    expect(one.company?.name).toBe('Northwind Travel');
    const own = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-08-03', '2027-08-04', { groupId: group.id, companyId: null }),
    );
    expect(own.company).toBeNull();
    expect(await available(standard, '2027-08-01', '2027-08-03')).toEqual([2, 2]);
    await expectLedgerSound();
  });

  it('releases what is left on request and at the cut-off, keeping the bookings', async () => {
    const { property, standard } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Alumni reunion',
      cutoffDate: '2027-08-31',
      holds: [
        { roomTypeId: standard.roomType.id, from: '2027-09-10', to: '2027-09-12', quantity: 5 },
      ],
    });
    await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-09-10', '2027-09-12', { groupId: group.id }),
    );
    expect(await available(standard, '2027-09-10', '2027-09-12')).toEqual([1, 1]);

    // On the cut-off day itself the rooms are still held. (The wedding's cut-off
    // passed months ago, so that one goes now.)
    const early = await releaseDueGroupRooms(t.db, new Date('2027-08-31T12:00:00Z'));
    expect(early.map((g) => g.name)).toEqual(['Mehta wedding']);
    // 18:30 UTC is midnight in India: the day after the cut-off has begun.
    expect(await releaseDueGroupRooms(t.db, new Date('2027-08-31T18:31:00Z'))).toEqual([
      { groupId: group.id, name: 'Alumni reunion' },
    ]);
    const after = await getGroup(t.db, org.orgId, group.id);
    expect(after).toMatchObject({ status: 'closed', heldNights: 0, bookings: 1, bookedNights: 2 });
    expect(after.releasedAt).toBeInstanceOf(Date);
    expect(after.from).toBe('2027-09-10');
    expect(await available(standard, '2027-09-10', '2027-09-12')).toEqual([5, 5]);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, group.id), eq(auditLog.action, 'group.released')));
    expect(entry).toMatchObject({
      actorType: 'system',
      summary: 'Cut-off reached for group Alumni reunion: 8 unbooked room nights went back on sale',
    });
    // Running it again does nothing.
    expect(await releaseDueGroupRooms(t.db, new Date('2027-09-02T00:00:00Z'))).toEqual([]);

    // A closed group still takes bookings, from general sale, and can hold rooms again.
    await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-09-10', '2027-09-11', { groupId: group.id }),
    );
    const again = await addGroupHold(t.db, org.admin, group.id, {
      roomTypeId: standard.roomType.id,
      from: '2027-09-10',
      to: '2027-09-12',
      quantity: 4,
    });
    expect(again).toMatchObject({ status: 'open', releasedAt: null });
    // Both bookings count against the new hold on the 10th.
    expect(again.nights.map((n) => [n.date, n.held, n.booked, n.left])).toEqual([
      ['2027-09-10', 4, 2, 2],
      ['2027-09-11', 4, 1, 3],
    ]);
    expect(await available(standard, '2027-09-10', '2027-09-12')).toEqual([2, 2]);

    const manual = await releaseGroupRooms(t.db, org.admin, group.id);
    expect(manual.status).toBe('closed');
    expect(await available(standard, '2027-09-10', '2027-09-12')).toEqual([4, 5]);
    await expectLedgerSound();
  });

  it('cancels a group only once its bookings are cancelled', async () => {
    const { property, standard } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Film crew',
      holds: [
        { roomTypeId: standard.roomType.id, from: '2027-10-01', to: '2027-10-05', quantity: 3 },
      ],
    });
    const stay = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-10-01', '2027-10-05', { groupId: group.id }),
    );
    const refused = await errorOf(cancelGroup(t.db, org.admin, group.id));
    expect(refused.message).toBe('One booking of this group still stands. Cancel it first.');
    await cancelReservation(t.db, org.admin, stay.id, {});
    const cancelled = await cancelGroup(t.db, org.admin, group.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', heldNights: 0 });
    expect(await available(standard, '2027-10-01', '2027-10-05')).toEqual([6, 6, 6, 6]);
    // No new booking, and no new hold, for an event that is off.
    const late = await errorOf(
      createReservation(
        t.db,
        org.admin,
        booking(standard, '2027-10-01', '2027-10-02', { groupId: group.id }),
      ),
    );
    expect(late.message).toBe('Film crew has been cancelled, so it cannot take bookings');
    expect(
      (
        await errorOf(
          addGroupHold(t.db, org.admin, group.id, {
            roomTypeId: standard.roomType.id,
            from: '2027-10-01',
            to: '2027-10-02',
            quantity: 1,
          }),
        )
      ).code,
    ).toBe('invalid_state');
    expect(
      (await listGroups(t.db, org.orgId, { propertyId: property.id })).map((g) => g.name),
    ).not.toContain('Film crew');
    expect(
      (await listGroups(t.db, org.orgId, { propertyId: property.id, status: 'cancelled' })).map(
        (g) => g.name,
      ),
    ).toEqual(['Film crew']);
  });

  it('moves an existing booking into a group and out again', async () => {
    const { property, standard } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Yoga retreat',
      holds: [
        { roomTypeId: standard.roomType.id, from: '2027-11-01', to: '2027-11-03', quantity: 5 },
      ],
    });
    const stay = await createReservation(
      t.db,
      org.admin,
      booking(standard, '2027-11-01', '2027-11-03'),
    );
    expect(await available(standard, '2027-11-01', '2027-11-03')).toEqual([0, 0]);
    // Joining the group, it uses a held room: its own room goes back on sale.
    const joined = await setReservationGroup(t.db, org.admin, stay.id, group.id);
    expect(joined.group?.name).toBe('Yoga retreat');
    expect(joined.version).toBe(stay.version + 1);
    expect(await available(standard, '2027-11-01', '2027-11-03')).toEqual([1, 1]);
    expect((await getGroup(t.db, org.orgId, group.id)).leftNights).toBe(8);

    // Leaving it needs a room from general sale again, which someone has just taken.
    await createReservation(t.db, org.admin, booking(standard, '2027-11-01', '2027-11-03'));
    const stuck = await errorOf(setReservationGroup(t.db, org.admin, stay.id, null));
    expect(stuck.code).toBe('no_availability');
    expect((await getGroup(t.db, org.orgId, group.id)).bookings).toBe(1);
    await expectLedgerSound();
  });

  it('checks names, dates, the cut-off and the kind of room', async () => {
    const { property, standard } = hotel;
    const base = { propertyId: property.id, name: 'Checks', holds: [] };
    expect((await errorOf(createGroup(t.db, org.admin, { ...base, name: '  ' }))).message).toBe(
      'Give the group a name',
    );
    const hold = {
      roomTypeId: standard.roomType.id,
      from: '2027-12-10',
      to: '2027-12-12',
      quantity: 1,
    };
    expect(
      (
        await errorOf(
          createGroup(t.db, org.admin, { ...base, holds: [hold], cutoffDate: '2027-12-11' }),
        )
      ).message,
    ).toBe('The cut-off date cannot be after the first night held');
    expect(
      (await errorOf(createGroup(t.db, org.admin, { ...base, holds: [{ ...hold, quantity: 0 }] })))
        .message,
    ).toBe('Hold at least one room');
    expect(
      (
        await errorOf(
          createGroup(t.db, org.admin, { ...base, holds: [{ ...hold, to: hold.from }] }),
        )
      ).code,
    ).toBe('validation');

    // A villa is one unit, booked by name: it cannot be held by number.
    const villa = await createTestVilla(t.db, org);
    const refused = await errorOf(
      createGroup(t.db, org.admin, {
        propertyId: villa.property.id,
        name: 'Villa party',
        holds: [{ ...hold, roomTypeId: villa.whole.roomType.id }],
      }),
    );
    expect(refused.message).toMatch(/is booked unit by unit, so it cannot be held by number/);
    // A booking cannot join a group of another property.
    const group = await createGroup(t.db, org.admin, { ...base, name: 'Hotel only' });
    const elsewhere = await errorOf(
      createReservation(t.db, org.admin, {
        propertyId: villa.property.id,
        source: 'direct',
        guest: { firstName: 'Wrong', lastName: 'Place' },
        rooms: [
          {
            roomTypeId: villa.whole.roomType.id,
            ratePlanId: villa.whole.ratePlan.id,
            checkIn: '2027-12-10',
            checkOut: '2027-12-12',
            adults: 2,
          },
        ],
        groupId: group.id,
      }),
    );
    expect(elsewhere.message).toBe('This group is at another property');
    // Another organisation cannot see the group at all.
    const stranger = await createTestOrg(t.db);
    expect((await errorOf(getGroup(t.db, stranger.orgId, group.id))).code).toBe('not_found');
  });

  it('renames the group on the calendar and keeps the cut-off sensible', async () => {
    const { property, standard } = hotel;
    const group = await createGroup(t.db, org.admin, {
      propertyId: property.id,
      name: 'Book club',
      cutoffDate: '2028-01-05',
      holds: [
        { roomTypeId: standard.roomType.id, from: '2028-01-10', to: '2028-01-12', quantity: 2 },
      ],
    });
    const renamed = await updateGroup(t.db, org.admin, group.id, {
      name: 'Readers’ weekend',
      contactPhone: ' +91 98765 43210 ',
      notes: '',
    });
    expect(renamed).toMatchObject({ name: 'Readers’ weekend', contactPhone: '+91 98765 43210' });
    const calendar = await getCalendar(t.db, org.orgId, {
      propertyIds: [property.id],
      range: { from: '2028-01-09', to: '2028-01-13' },
    });
    expect(calendar.properties[0]!.blocks).toEqual([
      expect.objectContaining({
        kind: 'hold',
        reason: 'Readers’ weekend',
        quantity: 2,
        groupId: group.id,
      }),
    ]);
    expect(
      (await errorOf(updateGroup(t.db, org.admin, group.id, { cutoffDate: '2028-01-11' }))).message,
    ).toBe('The cut-off date cannot be after the first night held');
    // An earlier hold pulls a later cut-off back to its first night.
    const earlier = await addGroupHold(t.db, org.admin, group.id, {
      roomTypeId: standard.roomType.id,
      from: '2028-01-03',
      to: '2028-01-04',
      quantity: 1,
    });
    expect(earlier.cutoffDate).toBe('2028-01-03');
    // Nothing changed: no audit entry.
    const before = await t.db.select().from(auditLog).where(eq(auditLog.entityId, group.id));
    await updateGroup(t.db, org.admin, group.id, { name: 'Readers’ weekend' });
    const after = await t.db.select().from(auditLog).where(eq(auditLog.entityId, group.id));
    expect(after).toHaveLength(before.length);
  });
});
