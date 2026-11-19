import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  inventoryDays,
  outbox,
  reservationRooms,
  reservations,
  unitOccupancy,
} from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createBlock, releaseBlock, updateBlock } from './blocks';
import { addDays, eachDate } from './dates';
import { DomainError } from './errors';
import { findLedgerMismatches, getAvailability } from './inventory';
import { createUnit, updateUnit } from './properties';
import {
  cancelReservation,
  createReservation,
  loadReservation,
  reinstateReservation,
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
  type TestVilla,
} from './testing';

let t: TestDatabase;
let org: TestOrg;

beforeAll(async () => {
  // Concurrency tests open many transactions at once.
  t = await createTestDatabase({ max: 30 });
  org = await createTestOrg(t.db);
});
afterAll(async () => {
  await t.drop();
});

let guestSeq = 0;
function booking(
  propertyId: string,
  type: TestRoomType,
  checkIn: string,
  checkOut: string,
  extra: Partial<CreateReservationInput> = {},
): CreateReservationInput {
  guestSeq++;
  return {
    propertyId,
    source: 'direct',
    guest: {
      firstName: 'Guest',
      lastName: `Number${guestSeq}`,
      email: `guest${guestSeq}@example.com`,
    },
    rooms: [
      { roomTypeId: type.roomType.id, ratePlanId: type.ratePlan.id, checkIn, checkOut, adults: 2 },
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

async function available(
  propertyId: string,
  roomTypeId: string,
  from: string,
  to: string,
): Promise<number[]> {
  const days = await getAvailability(t.db, {
    propertyId,
    range: { from, to },
    roomTypeIds: [roomTypeId],
  });
  return days.map((d) => d.available);
}

/** The promises the ledger makes, checked against the database itself. */
async function expectLedgerSound(propertyId: string, from = '2026-11-01', to = '2028-06-01') {
  expect(await findLedgerMismatches(t.db, { propertyId, range: { from, to } })).toEqual([]);
  const { rows: oversold } = await t.db.execute(sql`
    SELECT 1 FROM inventory_days
    WHERE property_id = ${propertyId} AND sold + blocked + out_of_order + linked > total LIMIT 1`);
  expect(oversold).toHaveLength(0);
  const { rows: overlaps } = await t.db.execute(sql`
    SELECT 1 FROM unit_occupancy a JOIN unit_occupancy b
      ON a.unit_id = b.unit_id AND a.id < b.id AND a.stay && b.stay
    WHERE a.property_id = ${propertyId} LIMIT 1`);
  expect(overlaps).toHaveLength(0);
}

describe('hotel inventory (sold by room type)', () => {
  let hotel: TestHotel;
  beforeAll(async () => {
    hotel = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 2 });
  });

  it('starts fully available and takes a room off sale for the nights of a stay only', async () => {
    const { property, standard } = hotel;
    expect(await available(property.id, standard.roomType.id, '2027-01-10', '2027-01-15')).toEqual([
      3, 3, 3, 3, 3,
    ]);

    const r = await createReservation(
      t.db,
      org.admin,
      booking(property.id, standard, '2027-01-11', '2027-01-13'),
    );
    expect(r.status).toBe('confirmed');
    expect(r.nights).toBe(2);
    expect(r.totalAmount).toBe(900_000);
    // The departure day (13th) is free again: someone else can arrive that day.
    expect(await available(property.id, standard.roomType.id, '2027-01-10', '2027-01-15')).toEqual([
      3, 2, 2, 3, 3,
    ]);
    await expectLedgerSound(property.id);
  });

  it('refuses a booking when no room is left and leaves nothing behind', async () => {
    const { property, deluxe } = hotel;
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-02-01', '2027-02-04'),
    );
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-02-02', '2027-02-05'),
    );
    const countBefore = (
      await t.db.select().from(reservations).where(eq(reservations.propertyId, property.id))
    ).length;

    // Needs the 3rd and 4th, but both rooms are taken on the 2nd and 3rd.
    const err = await errorOf(
      createReservation(t.db, org.admin, booking(property.id, deluxe, '2027-01-31', '2027-02-04')),
    );
    expect(err.code).toBe('no_availability');
    expect(err.details?.nights).toEqual([
      { roomTypeId: deluxe.roomType.id, date: '2027-02-02', overbooked: 1 },
      { roomTypeId: deluxe.roomType.id, date: '2027-02-03', overbooked: 1 },
    ]);

    const countAfter = (
      await t.db.select().from(reservations).where(eq(reservations.propertyId, property.id))
    ).length;
    expect(countAfter).toBe(countBefore);
    expect(await available(property.id, deluxe.roomType.id, '2027-01-31', '2027-02-06')).toEqual([
      2, 1, 0, 0, 1, 2,
    ]);
    await expectLedgerSound(property.id);
  });

  it('lets exactly as many concurrent bookings through as there are rooms', async () => {
    const { property, standard } = hotel;
    const attempts = 20;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        createReservation(
          t.db,
          org.admin,
          booking(property.id, standard, '2027-03-05', '2027-03-08'),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(attempts - 3);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(DomainError);
      expect((f.reason as DomainError).code).toBe('no_availability');
    }
    expect(await available(property.id, standard.roomType.id, '2027-03-04', '2027-03-09')).toEqual([
      3, 0, 0, 0, 3,
    ]);
    const days = await t.db
      .select()
      .from(inventoryDays)
      .where(
        and(
          eq(inventoryDays.roomTypeId, standard.roomType.id),
          eq(inventoryDays.date, '2027-03-06'),
        ),
      );
    expect(days[0]).toMatchObject({ total: 3, sold: 3, overbooked: 0 });
    await expectLedgerSound(property.id);
  });

  it('holds under concurrent bookings whose dates only partly overlap', async () => {
    const { property, deluxe } = hotel;
    // 30 stays of 1-4 nights scattered over a week, two rooms.
    const requests = Array.from({ length: 30 }, (_, i) => {
      const start = addDays('2027-04-01', i % 7);
      return booking(property.id, deluxe, start, addDays(start, 1 + (i % 4)));
    });
    const results = await Promise.allSettled(
      requests.map((r) => createReservation(t.db, org.admin, r)),
    );
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as DomainError).code).toBe('no_availability');
    }
    const days = await getAvailability(t.db, {
      propertyId: property.id,
      range: { from: '2027-04-01', to: '2027-04-12' },
      roomTypeIds: [deluxe.roomType.id],
    });
    for (const day of days) {
      expect(day.sold).toBeLessThanOrEqual(2);
      expect(day.overbooked).toBe(0);
      expect(day.available).toBeGreaterThanOrEqual(0);
    }
    await expectLedgerSound(property.id);
  });

  it('moves inventory when a stay is moved, extended, shortened or changes room type', async () => {
    const { property, standard, deluxe } = hotel;
    const r = await createReservation(
      t.db,
      org.admin,
      booking(property.id, standard, '2027-05-10', '2027-05-12'),
    );
    const roomId = r.rooms[0]!.id;
    const std = (from: string, to: string) =>
      available(property.id, standard.roomType.id, from, to);

    expect(await std('2027-05-09', '2027-05-15')).toEqual([3, 2, 2, 3, 3, 3]);

    // Extend by two nights: the existing nights keep their price, new nights are priced from the plan.
    let changed = await updateReservationRoom(t.db, org.admin, r.id, roomId, {
      checkOut: '2027-05-14',
    });
    expect(changed.reservation.totalAmount).toBe(4 * 450_000);
    expect(await std('2027-05-09', '2027-05-15')).toEqual([3, 2, 2, 2, 2, 3]);

    // Shorten from the front.
    changed = await updateReservationRoom(t.db, org.admin, r.id, roomId, { checkIn: '2027-05-12' });
    expect(changed.reservation.checkIn).toBe('2027-05-12');
    expect(await std('2027-05-09', '2027-05-15')).toEqual([3, 3, 3, 2, 2, 3]);

    // Move the whole stay a month later.
    changed = await updateReservationRoom(t.db, org.admin, r.id, roomId, {
      checkIn: '2027-06-12',
      checkOut: '2027-06-14',
    });
    expect(changed.reservation).toMatchObject({ checkIn: '2027-06-12', checkOut: '2027-06-14' });
    expect(await std('2027-05-09', '2027-05-15')).toEqual([3, 3, 3, 3, 3, 3]);
    expect(await std('2027-06-11', '2027-06-15')).toEqual([3, 2, 2, 3]);

    // Upgrade to deluxe: standard is released, deluxe is taken, the default deluxe plan prices it.
    changed = await updateReservationRoom(t.db, org.admin, r.id, roomId, {
      roomTypeId: deluxe.roomType.id,
    });
    expect(changed.reservation.rooms[0]).toMatchObject({
      roomTypeName: 'Deluxe Room',
      ratePlanName: 'Deluxe Room flexible',
    });
    expect(changed.reservation.totalAmount).toBe(2 * 700_000);
    expect(await std('2027-06-11', '2027-06-15')).toEqual([3, 3, 3, 3]);
    expect(await available(property.id, deluxe.roomType.id, '2027-06-11', '2027-06-15')).toEqual([
      2, 1, 1, 2,
    ]);
    await expectLedgerSound(property.id);
  });

  it('refuses an extension into a sold-out night and keeps the original stay', async () => {
    const { property, deluxe } = hotel;
    const a = await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-07-01', '2027-07-03'),
    );
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-07-03', '2027-07-05'),
    );
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-07-03', '2027-07-05'),
    );

    const err = await errorOf(
      updateReservationRoom(t.db, org.admin, a.id, a.rooms[0]!.id, { checkOut: '2027-07-04' }),
    );
    expect(err.code).toBe('no_availability');
    const unchanged = await loadReservation(t.db, org.orgId, a.id);
    expect(unchanged.checkOut).toBe('2027-07-03');
    expect(unchanged.version).toBe(a.version);
    await expectLedgerSound(property.id);
  });

  it('frees the room on cancellation, and refuses to reinstate once it is sold again', async () => {
    const { property, deluxe } = hotel;
    const a = await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-08-01', '2027-08-03'),
    );
    const b = await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-08-01', '2027-08-03'),
    );
    expect(await available(property.id, deluxe.roomType.id, '2027-08-01', '2027-08-03')).toEqual([
      0, 0,
    ]);

    const cancelled = await cancelReservation(t.db, org.admin, a.id, {
      reason: 'Guest changed plans',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBe('Guest changed plans');
    expect(await available(property.id, deluxe.roomType.id, '2027-08-01', '2027-08-03')).toEqual([
      1, 1,
    ]);

    // Cancelling again is harmless (channels repeat messages).
    expect((await cancelReservation(t.db, org.admin, a.id)).status).toBe('cancelled');

    // Someone else takes the freed room; the cancelled stay can no longer come back.
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-08-02', '2027-08-03'),
    );
    expect((await errorOf(reinstateReservation(t.db, org.admin, a.id))).code).toBe(
      'no_availability',
    );

    await cancelReservation(t.db, org.admin, b.id);
    const back = await reinstateReservation(t.db, org.admin, a.id);
    expect(back.status).toBe('confirmed');
    expect(back.cancelledAt).toBeNull();
    await expectLedgerSound(property.id);
  });

  it('queues exactly the changed nights for the channels, in the same transaction', async () => {
    const { property, standard } = hotel;
    await t.db.delete(outbox);
    const r = await createReservation(
      t.db,
      org.admin,
      booking(property.id, standard, '2027-09-10', '2027-09-13'),
    );
    let events = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.availability'));
    expect(events.map((e) => e.payload)).toEqual([
      { roomTypeId: standard.roomType.id, from: '2027-09-10', to: '2027-09-13' },
    ]);

    // Moving one night later changes only the first and the new last night.
    await t.db.delete(outbox);
    await updateReservationRoom(t.db, org.admin, r.id, r.rooms[0]!.id, {
      checkIn: '2027-09-11',
      checkOut: '2027-09-14',
    });
    events = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.availability'));
    expect(
      events.map((e) => e.payload).sort((a, b) => String(a.from).localeCompare(String(b.from))),
    ).toEqual([
      { roomTypeId: standard.roomType.id, from: '2027-09-10', to: '2027-09-11' },
      { roomTypeId: standard.roomType.id, from: '2027-09-13', to: '2027-09-14' },
    ]);

    // A refused booking queues nothing.
    await t.db.delete(outbox);
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, standard, '2027-09-11', '2027-09-12'),
    );
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, standard, '2027-09-11', '2027-09-12'),
    );
    await t.db.delete(outbox);
    await errorOf(
      createReservation(
        t.db,
        org.admin,
        booking(property.id, standard, '2027-09-11', '2027-09-12'),
      ),
    );
    expect(await t.db.select().from(outbox)).toHaveLength(0);
  });

  it('records a channel booking that arrives over capacity, flags it, and settles when room frees up', async () => {
    const { property, deluxe } = hotel;
    const a = await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-10-01', '2027-10-03'),
    );
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-10-01', '2027-10-03'),
    );

    // Two channels sold the last room at the same moment: the second booking is already
    // confirmed to its guest, so it must be recorded, not rejected.
    const forced = await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-10-02', '2027-10-04', {
        source: 'ota',
        channelCode: 'BDC',
      }),
      { allowOverbooking: true },
    );
    expect(forced.overbooked).toBe(true);
    const [day] = await t.db
      .select()
      .from(inventoryDays)
      .where(
        and(eq(inventoryDays.roomTypeId, deluxe.roomType.id), eq(inventoryDays.date, '2027-10-02')),
      );
    // Capacity is never exceeded in the ledger; the excess is counted separately.
    expect(day).toMatchObject({ total: 2, sold: 2, overbooked: 1 });
    expect(await available(property.id, deluxe.roomType.id, '2027-10-01', '2027-10-05')).toEqual([
      0, 0, 1, 2,
    ]);

    const open = await t.db
      .select()
      .from(alerts)
      .where(eq(alerts.dedupeKey, `overbooking:${forced.id}`));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'overbooking', severity: 'critical', status: 'open' });
    expect(open[0]!.title).toContain('Deluxe Room');

    // Staff cannot add to the problem without the override.
    expect(
      (
        await errorOf(
          createReservation(
            t.db,
            org.admin,
            booking(property.id, deluxe, '2027-10-02', '2027-10-03'),
          ),
        )
      ).code,
    ).toBe('no_availability');

    // An unrelated change on a night that is not overbooked still works.
    await updateReservationRoom(t.db, org.admin, forced.id, forced.rooms[0]!.id, {
      checkOut: '2027-10-05',
    });

    // One of the earlier guests cancels: the overbooking is gone, the flag and the alert clear.
    await cancelReservation(t.db, org.admin, a.id);
    expect((await loadReservation(t.db, org.orgId, forced.id)).overbooked).toBe(false);
    const [resolved] = await t.db
      .select()
      .from(alerts)
      .where(eq(alerts.dedupeKey, `overbooking:${forced.id}`));
    expect(resolved!.status).toBe('resolved');
    await expectLedgerSound(property.id);
  });

  it('takes rooms off sale with blocks and puts them back on release', async () => {
    const { property, standard } = hotel;
    const std = () => available(property.id, standard.roomType.id, '2027-11-01', '2027-11-06');
    expect(await std()).toEqual([3, 3, 3, 3, 3]);

    // Two rooms held back for a wedding party, without naming rooms.
    const hold = await createBlock(t.db, org.admin, {
      propertyId: property.id,
      roomTypeId: standard.roomType.id,
      quantity: 2,
      kind: 'hold',
      startDate: '2027-11-02',
      endDate: '2027-11-04',
      reason: 'Sharma wedding',
    });
    expect(await std()).toEqual([3, 1, 1, 3, 3]);

    // One specific room out of order.
    const maintenance = await createBlock(t.db, org.admin, {
      propertyId: property.id,
      unitId: standard.units[0]!.id,
      kind: 'maintenance',
      startDate: '2027-11-03',
      endDate: '2027-11-05',
      reason: 'AC repair',
    });
    expect(await std()).toEqual([3, 1, 0, 2, 3]);
    const [day] = await t.db
      .select()
      .from(inventoryDays)
      .where(
        and(
          eq(inventoryDays.roomTypeId, standard.roomType.id),
          eq(inventoryDays.date, '2027-11-03'),
        ),
      );
    expect(day).toMatchObject({ total: 3, blocked: 2, outOfOrder: 1, sold: 0 });

    expect(
      (
        await errorOf(
          createReservation(
            t.db,
            org.admin,
            booking(property.id, standard, '2027-11-03', '2027-11-04'),
          ),
        )
      ).code,
    ).toBe('no_availability');

    // Resizing a block moves its effect.
    await updateBlock(t.db, org.admin, hold.id, { endDate: '2027-11-03' });
    expect(await std()).toEqual([3, 1, 2, 2, 3]);

    await releaseBlock(t.db, org.admin, hold.id);
    await releaseBlock(t.db, org.admin, maintenance.id);
    await releaseBlock(t.db, org.admin, maintenance.id);
    expect(await std()).toEqual([3, 3, 3, 3, 3]);
    await expectLedgerSound(property.id);
  });

  it('refuses a block that would leave existing reservations without a room, unless forced', async () => {
    const { property, deluxe } = hotel;
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-12-01', '2027-12-03'),
    );
    const second = await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2027-12-01', '2027-12-03'),
    );
    const input = {
      propertyId: property.id,
      unitId: deluxe.units[0]!.id,
      kind: 'maintenance' as const,
      startDate: '2027-12-02',
      endDate: '2027-12-04',
      reason: 'Burst pipe',
    };
    // Both rooms have a guest on those nights: the room cannot simply be closed.
    const occupied = await errorOf(createBlock(t.db, org.admin, input));
    expect(occupied.code).toBe('unit_occupied');
    // Moving that guest does not help either, because the other room is taken too.
    expect((await errorOf(createBlock(t.db, org.admin, input, { relocateStays: true }))).code).toBe(
      'no_availability',
    );

    // An emergency closure goes through and exposes the shortfall instead of hiding it.
    const block = await createBlock(t.db, org.admin, input, {
      relocateStays: true,
      allowOverbooking: true,
    });
    expect(block.relocated).toHaveLength(1);
    expect(block.relocated[0]!.toUnit).toBeNull();
    const [day] = await t.db
      .select()
      .from(inventoryDays)
      .where(
        and(eq(inventoryDays.roomTypeId, deluxe.roomType.id), eq(inventoryDays.date, '2027-12-02')),
      );
    expect(day).toMatchObject({ total: 2, outOfOrder: 1, sold: 1, overbooked: 1 });
    await cancelReservation(t.db, org.admin, second.id);
    await expectLedgerSound(property.id);
  });

  it('never puts two stays in the same physical room, but allows back-to-back stays', async () => {
    const { property, standard } = hotel;
    const room101 = standard.units[0]!.id;
    const a = await createReservation(t.db, org.admin, {
      ...booking(property.id, standard, '2028-01-10', '2028-01-12'),
      rooms: [
        {
          roomTypeId: standard.roomType.id,
          ratePlanId: standard.ratePlan.id,
          unitId: room101,
          checkIn: '2028-01-10',
          checkOut: '2028-01-12',
          adults: 2,
        },
      ],
    });
    expect(a.rooms[0]!.unitName).toBe('STD-101');

    const b = await createReservation(
      t.db,
      org.admin,
      booking(property.id, standard, '2028-01-11', '2028-01-13'),
    );
    // B overlaps A, so it is given one of the other rooms.
    expect(b.rooms[0]!.unitId).not.toBeNull();
    expect(b.rooms[0]!.unitId).not.toBe(room101);

    const err = await errorOf(
      updateReservationRoom(t.db, org.admin, b.id, b.rooms[0]!.id, { unitId: room101 }),
    );
    expect(err.code).toBe('unit_occupied');
    expect(err.message).toContain('STD-101');
    expect(err.message).toContain(a.code);

    // Arriving the day the other guest leaves is fine.
    const c = await createReservation(t.db, org.admin, {
      ...booking(property.id, standard, '2028-01-12', '2028-01-14'),
      rooms: [
        {
          roomTypeId: standard.roomType.id,
          ratePlanId: standard.ratePlan.id,
          unitId: room101,
          checkIn: '2028-01-12',
          checkOut: '2028-01-14',
          adults: 2,
        },
      ],
    });
    expect(c.rooms[0]!.unitId).toBe(room101);

    // A unit of another room type is refused.
    const wrong = await errorOf(
      updateReservationRoom(t.db, org.admin, b.id, b.rooms[0]!.id, {
        unitId: hotel.deluxe.units[0]!.id,
      }),
    );
    expect(wrong.code).toBe('validation');

    // Extending A into C's dates moves A to the remaining free room rather than double-booking 101.
    const extended = await updateReservationRoom(t.db, org.admin, a.id, a.rooms[0]!.id, {
      checkOut: '2028-01-13',
    });
    expect(extended.unitReleased).toBe(false);
    expect(extended.movedToUnit).toMatch(/^STD-10[23]$/);
    expect(extended.reservation.rooms[0]!.unitId).not.toBe(room101);
    expect(extended.reservation.rooms[0]!.unitId).not.toBe(b.rooms[0]!.unitId);
    await expectLedgerSound(property.id);
  });

  it('gives each booking the room it fits best, keeping long gaps free', async () => {
    const h = await createTestHotel(t.db, org, { standardRooms: 2, name: 'Best Fit Hotel' });
    const unitOf = async (checkIn: string, checkOut: string) =>
      (
        await createReservation(
          t.db,
          org.admin,
          booking(h.property.id, h.standard, checkIn, checkOut),
        )
      ).rooms[0]!.unitName;

    const first = await unitOf('2027-01-10', '2027-01-11');
    // Each later stay slots in flush against an existing one in the same room.
    expect(await unitOf('2027-01-12', '2027-01-13')).toBe(first);
    expect(await unitOf('2027-01-11', '2027-01-12')).toBe(first);
    // ...which leaves the other room free for a stay spanning all of those nights.
    const long = await unitOf('2027-01-10', '2027-01-13');
    expect(long).not.toBeNull();
    expect(long).not.toBe(first);
    await expectLedgerSound(h.property.id);
  });

  it('still accepts a booking when no single room is free for the whole stay', async () => {
    const h = await createTestHotel(t.db, org, { standardRooms: 2, name: 'Fragmented Hotel' });
    const inRoom = (unitId: string, checkIn: string, checkOut: string) => ({
      ...booking(h.property.id, h.standard, checkIn, checkOut),
      rooms: [
        {
          roomTypeId: h.standard.roomType.id,
          ratePlanId: h.standard.ratePlan.id,
          unitId,
          checkIn,
          checkOut,
          adults: 2,
        },
      ],
    });
    await createReservation(
      t.db,
      org.admin,
      inRoom(h.standard.units[0]!.id, '2027-02-10', '2027-02-12'),
    );
    await createReservation(
      t.db,
      org.admin,
      inRoom(h.standard.units[1]!.id, '2027-02-12', '2027-02-14'),
    );

    // One room is free every night of 11-13, but not the same room: the hotel
    // has the capacity, so the booking is taken and a room move sorts it out later.
    const split = await createReservation(
      t.db,
      org.admin,
      booking(h.property.id, h.standard, '2027-02-11', '2027-02-13'),
    );
    expect(split.status).toBe('confirmed');
    expect(split.rooms[0]!.unitId).toBeNull();
    expect(split.overbooked).toBe(false);
    expect(
      await available(h.property.id, h.standard.roomType.id, '2027-02-10', '2027-02-14'),
    ).toEqual([1, 0, 0, 1]);
    await expectLedgerSound(h.property.id);
  });

  it('leaves rooms unassigned until check-in when the room type is set that way', async () => {
    const h = await createTestHotel(t.db, org, {
      standardRooms: 2,
      name: 'Run Of House',
      autoAssign: false,
    });
    const r = await createReservation(
      t.db,
      org.admin,
      booking(h.property.id, h.standard, '2027-03-01', '2027-03-03'),
    );
    expect(r.rooms[0]!.unitId).toBeNull();
    expect(
      await available(h.property.id, h.standard.roomType.id, '2027-03-01', '2027-03-03'),
    ).toEqual([1, 1]);
  });

  it('moves upcoming stays to another room when their room is taken out of order', async () => {
    const h = await createTestHotel(t.db, org, { standardRooms: 3, name: 'Relocation Hotel' });
    const room = h.standard.units[0]!;
    const stay = await createReservation(t.db, org.admin, {
      ...booking(h.property.id, h.standard, '2027-04-10', '2027-04-13'),
      rooms: [
        {
          roomTypeId: h.standard.roomType.id,
          ratePlanId: h.standard.ratePlan.id,
          unitId: room.id,
          checkIn: '2027-04-10',
          checkOut: '2027-04-13',
          adults: 2,
        },
      ],
    });
    const input = {
      propertyId: h.property.id,
      unitId: room.id,
      kind: 'maintenance' as const,
      startDate: '2027-04-11',
      endDate: '2027-04-12',
      reason: 'Leak',
    };
    const refused = await errorOf(createBlock(t.db, org.admin, input));
    expect(refused.code).toBe('unit_occupied');
    expect(refused.message).toContain(stay.code);

    const block = await createBlock(t.db, org.admin, input, { relocateStays: true });
    expect(block.relocated).toEqual([
      {
        reservationId: stay.id,
        code: stay.code,
        guestName: stay.guestName,
        toUnit: expect.stringMatching(/^STD-10[23]$/),
      },
    ]);
    const moved = await loadReservation(t.db, org.orgId, stay.id);
    expect(moved.rooms[0]!.unitName).toBe(block.relocated[0]!.toUnit);
    // The guest keeps the whole stay; only the room changed.
    expect(moved).toMatchObject({
      checkIn: '2027-04-10',
      checkOut: '2027-04-13',
      status: 'confirmed',
    });
    expect(
      await available(h.property.id, h.standard.roomType.id, '2027-04-10', '2027-04-13'),
    ).toEqual([2, 1, 2]);
    await expectLedgerSound(h.property.id);
  });

  it('raises availability when a room is added and refuses to retire a room that is needed', async () => {
    const { property, deluxe } = hotel;
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2028-02-01', '2028-02-02'),
    );
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2028-02-01', '2028-02-02'),
    );
    expect(await available(property.id, deluxe.roomType.id, '2028-02-01', '2028-02-03')).toEqual([
      0, 2,
    ]);

    const extra = await createUnit(t.db, org.admin, property.id, {
      roomTypeId: deluxe.roomType.id,
      name: 'DLX-109',
    });
    expect(await available(property.id, deluxe.roomType.id, '2028-02-01', '2028-02-03')).toEqual([
      1, 3,
    ]);

    await createReservation(
      t.db,
      org.admin,
      booking(property.id, deluxe, '2028-02-01', '2028-02-02'),
    );
    // The new room now has a guest of its own, so it cannot be retired.
    const occupied = await errorOf(
      updateUnit(t.db, org.admin, property.id, extra.id, { active: false }),
    );
    expect(occupied.code).toBe('conflict');
    expect(occupied.message).toMatch(/upcoming bookings/);
    await expectLedgerSound(property.id);
  });

  it('refuses to retire a room when the remaining rooms could not hold the bookings', async () => {
    // Sold by count with no rooms assigned: the check is on capacity, not on a particular room.
    const h = await createTestHotel(t.db, org, {
      standardRooms: 2,
      name: 'Capacity Hotel',
      autoAssign: false,
    });
    for (let i = 0; i < 2; i++) {
      await createReservation(
        t.db,
        org.admin,
        booking(h.property.id, h.standard, '2028-02-01', '2028-02-02'),
      );
    }
    const err = await errorOf(
      updateUnit(t.db, org.admin, h.property.id, h.standard.units[1]!.id, { active: false }),
    );
    expect(err.code).toBe('no_availability');
    expect(
      await available(h.property.id, h.standard.roomType.id, '2028-02-01', '2028-02-03'),
    ).toEqual([0, 2]);
    await expectLedgerSound(h.property.id);
  });
});

describe('villa inventory (single units, linked whole and by room)', () => {
  let single: TestVilla;
  let linked: TestVilla;
  beforeAll(async () => {
    single = await createTestVilla(t.db, org, { name: 'Casa Uno' });
    linked = await createTestVilla(t.db, org, { bedrooms: 3, name: 'Villa Azure' });
  });

  it('ties every villa booking to the unit and refuses overlapping stays', async () => {
    const { property, whole } = single;
    const a = await createReservation(
      t.db,
      org.admin,
      booking(property.id, whole, '2027-01-10', '2027-01-15'),
    );
    expect(a.rooms[0]!.unitName).toBe('Villa');

    const err = await errorOf(
      createReservation(t.db, org.admin, booking(property.id, whole, '2027-01-14', '2027-01-18')),
    );
    expect(err.code).toBe('no_availability');

    const next = await createReservation(
      t.db,
      org.admin,
      booking(property.id, whole, '2027-01-15', '2027-01-18'),
    );
    expect(next.rooms[0]!.unitId).toBe(whole.units[0]!.id);
    await expectLedgerSound(property.id);
  });

  it('lets exactly one of many simultaneous bookings take the villa', async () => {
    const { property, whole } = single;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        createReservation(t.db, org.admin, booking(property.id, whole, '2027-02-10', '2027-02-14')),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const occupancy = await t.db
      .select()
      .from(unitOccupancy)
      .where(eq(unitOccupancy.unitId, whole.units[0]!.id));
    expect(occupancy.filter((o) => o.stay === '[2027-02-10,2027-02-14)')).toHaveLength(1);
    await expectLedgerSound(property.id);
  });

  it('blocks dates on the villa and refuses a block over a booking', async () => {
    const { property, whole } = single;
    const block = await createBlock(t.db, org.admin, {
      propertyId: property.id,
      unitId: whole.units[0]!.id,
      kind: 'owner_stay',
      startDate: '2027-03-01',
      endDate: '2027-03-08',
      reason: 'Owner family visit',
    });
    expect(await available(property.id, whole.roomType.id, '2027-02-28', '2027-03-09')).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(
      (
        await errorOf(
          createReservation(
            t.db,
            org.admin,
            booking(property.id, whole, '2027-03-07', '2027-03-10'),
          ),
        )
      ).code,
    ).toBe('no_availability');

    await createReservation(
      t.db,
      org.admin,
      booking(property.id, whole, '2027-03-08', '2027-03-10'),
    );
    const clash = await errorOf(updateBlock(t.db, org.admin, block.id, { endDate: '2027-03-09' }));
    expect(clash.code).toBe('unit_occupied');

    await releaseBlock(t.db, org.admin, block.id);
    expect(await available(property.id, whole.roomType.id, '2027-03-01', '2027-03-08')).toEqual([
      1, 1, 1, 1, 1, 1, 1,
    ]);
    await expectLedgerSound(property.id);
  });

  it('closes the whole villa while a bedroom is booked, and every bedroom while the villa is booked', async () => {
    const { property, whole } = linked;
    const bedrooms = linked.bedrooms!;
    const villa = (from: string, to: string) => available(property.id, whole.roomType.id, from, to);
    const beds = (from: string, to: string) =>
      available(property.id, bedrooms.roomType.id, from, to);
    expect(await villa('2027-04-01', '2027-04-04')).toEqual([1, 1, 1]);
    expect(await beds('2027-04-01', '2027-04-04')).toEqual([3, 3, 3]);

    // One bedroom is booked for the 2nd.
    const bedroomStay = await createReservation(
      t.db,
      org.admin,
      booking(property.id, bedrooms, '2027-04-02', '2027-04-03'),
    );
    expect(bedroomStay.rooms[0]!.unitName).toMatch(/^Bedroom/);
    expect(await villa('2027-04-01', '2027-04-04')).toEqual([1, 0, 1]);
    expect(await beds('2027-04-01', '2027-04-04')).toEqual([3, 2, 3]);
    expect(
      (
        await errorOf(
          createReservation(
            t.db,
            org.admin,
            booking(property.id, whole, '2027-04-01', '2027-04-04'),
          ),
        )
      ).code,
    ).toBe('no_availability');

    // The villa is booked whole for the 10th-12th.
    const villaStay = await createReservation(
      t.db,
      org.admin,
      booking(property.id, whole, '2027-04-10', '2027-04-12'),
    );
    expect(await villa('2027-04-09', '2027-04-13')).toEqual([1, 0, 0, 1]);
    expect(await beds('2027-04-09', '2027-04-13')).toEqual([3, 0, 0, 3]);
    expect(
      (
        await errorOf(
          createReservation(
            t.db,
            org.admin,
            booking(property.id, bedrooms, '2027-04-11', '2027-04-12'),
          ),
        )
      ).code,
    ).toBe('no_availability');

    // Releasing either side reopens the other.
    await cancelReservation(t.db, org.admin, bedroomStay.id);
    expect(await villa('2027-04-01', '2027-04-04')).toEqual([1, 1, 1]);
    await cancelReservation(t.db, org.admin, villaStay.id);
    expect(await beds('2027-04-09', '2027-04-13')).toEqual([3, 3, 3, 3]);
    await expectLedgerSound(property.id);
  });

  it('queues both room types for the channels when either side changes', async () => {
    const { property, whole } = linked;
    const bedrooms = linked.bedrooms!;
    await t.db.delete(outbox);
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, bedrooms, '2027-05-02', '2027-05-04'),
    );
    const events = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.availability'));
    const byType = new Map(events.map((e) => [e.payload.roomTypeId, e.payload]));
    expect(byType.get(bedrooms.roomType.id)).toMatchObject({
      from: '2027-05-02',
      to: '2027-05-04',
    });
    expect(byType.get(whole.roomType.id)).toMatchObject({ from: '2027-05-02', to: '2027-05-04' });
  });

  it('never lets the villa and one of its bedrooms be sold for the same night, under concurrency', async () => {
    const { property, whole } = linked;
    const bedrooms = linked.bedrooms!;
    const requests = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 0
        ? booking(property.id, whole, '2027-06-10', '2027-06-13')
        : booking(
            property.id,
            bedrooms,
            addDays('2027-06-10', i % 3),
            addDays('2027-06-11', i % 3),
          ),
    );
    const results = await Promise.allSettled(
      requests.map((r) => createReservation(t.db, org.admin, r)),
    );
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const rooms = await t.db
      .select()
      .from(reservationRooms)
      .where(
        and(eq(reservationRooms.propertyId, property.id), eq(reservationRooms.status, 'confirmed')),
      );
    for (const date of eachDate('2027-06-10', '2027-06-13')) {
      const tonight = rooms.filter((r) => r.checkIn <= date && r.checkOut > date);
      const villaSold = tonight.filter((r) => r.roomTypeId === whole.roomType.id).length;
      const bedroomsSold = tonight.filter((r) => r.roomTypeId === bedrooms.roomType.id).length;
      expect(villaSold).toBeLessThanOrEqual(1);
      expect(bedroomsSold).toBeLessThanOrEqual(3);
      expect(villaSold === 1 && bedroomsSold > 0, `villa and bedroom both sold on ${date}`).toBe(
        false,
      );
    }
    await expectLedgerSound(property.id);
  });

  it('keeps a double-sold villa booking waiting and hands it the villa when the first one cancels', async () => {
    const { property, whole } = single;
    const first = await createReservation(
      t.db,
      org.admin,
      booking(property.id, whole, '2027-07-01', '2027-07-05'),
    );
    const second = await createReservation(
      t.db,
      org.admin,
      booking(property.id, whole, '2027-07-03', '2027-07-06', {
        source: 'ota',
        channelCode: 'ABB',
      }),
      { allowOverbooking: true },
    );
    expect(second.overbooked).toBe(true);
    expect(second.rooms[0]!.unitId).toBeNull();
    // The 5th has no clash, but the villa is still closed that night because the second stay holds it.
    expect(await available(property.id, whole.roomType.id, '2027-07-01', '2027-07-07')).toEqual([
      0, 0, 0, 0, 0, 1,
    ]);

    await cancelReservation(t.db, org.admin, first.id);
    const settled = await loadReservation(t.db, org.orgId, second.id);
    expect(settled.overbooked).toBe(false);
    expect(settled.rooms[0]!.unitId).toBe(whole.units[0]!.id);
    expect(await available(property.id, whole.roomType.id, '2027-07-01', '2027-07-07')).toEqual([
      1, 1, 0, 0, 0, 1,
    ]);
    await expectLedgerSound(property.id);
  });

  it('refuses to change how units are linked while they have upcoming stays', async () => {
    const { property } = linked;
    const bedrooms = linked.bedrooms!;
    await createReservation(
      t.db,
      org.admin,
      booking(property.id, bedrooms, '2027-08-01', '2027-08-03'),
    );
    const booked = (
      await t.db.select().from(unitOccupancy).where(eq(unitOccupancy.propertyId, property.id))
    ).find((o) => o.stay === '[2027-08-01,2027-08-03)')!;
    const err = await errorOf(
      updateUnit(t.db, org.admin, property.id, booked.unitId, { parentUnitId: null }),
    );
    expect(err.code).toBe('conflict');
  });
});

describe('database constraints (the last line of defence)', () => {
  it('rejects overlapping occupancy of a unit written directly with SQL', async () => {
    const villa = await createTestVilla(t.db, org, { name: 'Constraint Villa' });
    const r = await createReservation(
      t.db,
      org.admin,
      booking(villa.property.id, villa.whole, '2027-01-10', '2027-01-15'),
    );
    const insert = t.db.execute(sql`
      INSERT INTO unit_occupancy (property_id, unit_id, source_unit_id, stay, reservation_room_id)
      VALUES (${villa.property.id}, ${villa.whole.units[0]!.id}, ${villa.whole.units[0]!.id},
              '[2027-01-14,2027-01-16)'::daterange, ${r.rooms[0]!.id})`);
    await expect(insert).rejects.toMatchObject({
      cause: { code: '23P01', constraint: 'unit_no_overlap' },
    });
  });

  it('rejects a ledger row that sells more than exists', async () => {
    const hotel = await createTestHotel(t.db, org, { standardRooms: 2 });
    await createReservation(
      t.db,
      org.admin,
      booking(hotel.property.id, hotel.standard, '2027-01-10', '2027-01-11'),
    );
    const update = t.db.execute(sql`
      UPDATE inventory_days SET sold = 3
      WHERE room_type_id = ${hotel.standard.roomType.id} AND date = '2027-01-10'`);
    await expect(update).rejects.toMatchObject({
      cause: { code: '23514', constraint: 'not_oversold' },
    });
  });

  it('rejects occupancy recorded on a unit that has parts, and links deeper than one level', async () => {
    const villa = await createTestVilla(t.db, org, { bedrooms: 2, name: 'Guard Villa' });
    const r = await createReservation(
      t.db,
      org.admin,
      booking(villa.property.id, villa.bedrooms!, '2027-01-10', '2027-01-11'),
    );
    const onParent = t.db.execute(sql`
      INSERT INTO unit_occupancy (property_id, unit_id, source_unit_id, stay, reservation_room_id)
      VALUES (${villa.property.id}, ${villa.whole.units[0]!.id}, ${villa.whole.units[0]!.id},
              '[2027-02-01,2027-02-02)'::daterange, ${r.rooms[0]!.id})`);
    await expect(onParent).rejects.toMatchObject({
      cause: { constraint: 'unit_occupancy_atomic' },
    });

    const nested = t.db.execute(sql`
      UPDATE units SET parent_unit_id = ${villa.bedrooms!.units[0]!.id} WHERE id = ${villa.bedrooms!.units[1]!.id}`);
    await expect(nested).rejects.toMatchObject({ cause: { constraint: 'units_link_depth' } });
  });
});

describe('ledger invariants under a long random sequence of operations', () => {
  it('stays consistent with its sources after every step', async () => {
    const hotel = await createTestHotel(t.db, org, {
      standardRooms: 4,
      deluxeRooms: 2,
      name: 'Fuzz Hotel',
    });
    const villa = await createTestVilla(t.db, org, { bedrooms: 3, name: 'Fuzz Villa' });
    const targets: { propertyId: string; type: TestRoomType }[] = [
      { propertyId: hotel.property.id, type: hotel.standard },
      { propertyId: hotel.property.id, type: hotel.deluxe },
      { propertyId: villa.property.id, type: villa.whole },
      { propertyId: villa.property.id, type: villa.bedrooms! },
    ];

    // Deterministic pseudo-random sequence so a failure can be reproduced.
    let seed = 20261113;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // Take the high bits: the low bits of this generator repeat with a short period.
      return Math.floor((seed / 0x80000000) * n);
    };
    const live: { id: string; roomId: string; propertyId: string }[] = [];
    const blocks: string[] = [];
    const base = '2027-10-01';
    let succeeded = 0;
    let refused = 0;

    for (let step = 0; step < 120; step++) {
      const target = targets[rnd(targets.length)]!;
      const start = addDays(base, rnd(20));
      const end = addDays(start, 1 + rnd(5));
      const action = rnd(10);
      try {
        if (action < 5) {
          const force = rnd(8) === 0;
          const r = await createReservation(
            t.db,
            org.admin,
            booking(
              target.propertyId,
              target.type,
              start,
              end,
              force ? { source: 'ota', channelCode: 'BDC' } : {},
            ),
            { allowOverbooking: force },
          );
          live.push({ id: r.id, roomId: r.rooms[0]!.id, propertyId: target.propertyId });
        } else if (action < 7 && live.length > 0) {
          const [victim] = live.splice(rnd(live.length), 1);
          await cancelReservation(t.db, org.admin, victim!.id);
        } else if (action < 9 && live.length > 0) {
          const pick = live[rnd(live.length)]!;
          await updateReservationRoom(t.db, org.admin, pick.id, pick.roomId, {
            checkIn: start,
            checkOut: end,
          });
        } else if (blocks.length > 0 && rnd(2) === 0) {
          await releaseBlock(t.db, org.admin, blocks.splice(rnd(blocks.length), 1)[0]!);
        } else {
          const unit = target.type.units[rnd(target.type.units.length)]!;
          const block = await createBlock(t.db, org.admin, {
            propertyId: target.propertyId,
            unitId: unit.id,
            kind: rnd(2) === 0 ? 'maintenance' : 'block',
            startDate: start,
            endDate: end,
          });
          blocks.push(block.id);
        }
        succeeded++;
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        expect(['no_availability', 'unit_occupied']).toContain(err.code);
        refused++;
      }
      if (step % 10 === 9) {
        await expectLedgerSound(hotel.property.id, '2027-09-25', '2027-11-05');
        await expectLedgerSound(villa.property.id, '2027-09-25', '2027-11-05');
      }
    }
    // The sequence must exercise both outcomes to mean anything.
    expect(succeeded).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(10);
    await expectLedgerSound(hotel.property.id, '2027-09-25', '2027-11-05');
    await expectLedgerSound(villa.property.id, '2027-09-25', '2027-11-05');
  });
});
