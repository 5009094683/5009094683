import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, guests, reservations } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { getCalendar } from './calendar';
import { createBlock } from './blocks';
import { DomainError } from './errors';
import { revealGuestIdNumber, updateGuest } from './guests';
import { getAvailability } from './inventory';
import {
  addReservationRoom,
  cancelReservation,
  confirmReservation,
  createReservation,
  expireHolds,
  listReservations,
  loadReservation,
  markNoShow,
  updateReservation,
  updateReservationRoom,
} from './reservations';
import {
  createTestHotel,
  createTestOrg,
  createTestVilla,
  type TestHotel,
  type TestOrg,
} from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 2 });
});
afterAll(async () => {
  await t.drop();
});

async function errorOf(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

const std = (checkIn: string, checkOut: string, adults = 2) => ({
  roomTypeId: hotel.standard.roomType.id,
  ratePlanId: hotel.standard.ratePlan.id,
  checkIn,
  checkOut,
  adults,
});
const dlx = (checkIn: string, checkOut: string, adults = 2) => ({
  roomTypeId: hotel.deluxe.roomType.id,
  ratePlanId: hotel.deluxe.ratePlan.id,
  checkIn,
  checkOut,
  adults,
});
const availability = async (roomTypeId: string, from: string, to: string) =>
  (
    await getAvailability(t.db, {
      propertyId: hotel.property.id,
      range: { from, to },
      roomTypeIds: [roomTypeId],
    })
  ).map((d) => d.available);

describe('reservation lifecycle', () => {
  it('books several rooms at once, all or nothing', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: {
        firstName: 'Anita',
        lastName: 'Desai',
        email: 'anita@example.com',
        phone: '+91 98200 12345',
      },
      rooms: [
        std('2027-01-10', '2027-01-13'),
        std('2027-01-10', '2027-01-12', 3),
        dlx('2027-01-11', '2027-01-13'),
      ],
      specialRequests: 'Adjoining rooms if possible',
    });
    expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(r.rooms).toHaveLength(3);
    expect(r).toMatchObject({
      checkIn: '2027-01-10',
      checkOut: '2027-01-13',
      adults: 7,
      guestName: 'Anita Desai',
    });
    // 3 + 2 standard nights (one with an extra adult) and 2 deluxe nights.
    expect(r.totalAmount).toBe(3 * 450_000 + 2 * 550_000 + 2 * 700_000);
    expect(r.guest).toMatchObject({ email: 'anita@example.com', phone: '+919820012345' });

    // Asking for more deluxe rooms than exist fails the whole booking, including its standard rooms.
    const before = await availability(hotel.standard.roomType.id, '2027-01-10', '2027-01-13');
    const err = await errorOf(
      createReservation(t.db, org.admin, {
        propertyId: hotel.property.id,
        source: 'phone',
        guest: { firstName: 'Too', lastName: 'Many' },
        rooms: [
          std('2027-01-11', '2027-01-12'),
          dlx('2027-01-11', '2027-01-12'),
          dlx('2027-01-11', '2027-01-12'),
        ],
      }),
    );
    expect(err.code).toBe('no_availability');
    expect(await availability(hotel.standard.roomType.id, '2027-01-10', '2027-01-13')).toEqual(
      before,
    );
  });

  it('cancels one room of several and keeps the rest', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'direct',
      guest: { firstName: 'Group', lastName: 'Lead' },
      rooms: [dlx('2027-02-01', '2027-02-03'), dlx('2027-02-01', '2027-02-04')],
    });
    expect(await availability(hotel.deluxe.roomType.id, '2027-02-01', '2027-02-04')).toEqual([
      0, 0, 1,
    ]);

    const partial = await cancelReservation(t.db, org.admin, r.id, { roomIds: [r.rooms[1]!.id] });
    expect(partial.status).toBe('confirmed');
    expect(partial.rooms.map((x) => x.status)).toEqual(['confirmed', 'cancelled']);
    expect(partial).toMatchObject({
      checkOut: '2027-02-03',
      totalAmount: 2 * 700_000,
      cancelledAt: null,
    });
    expect(await availability(hotel.deluxe.roomType.id, '2027-02-01', '2027-02-04')).toEqual([
      1, 1, 2,
    ]);

    const full = await cancelReservation(t.db, org.admin, r.id, { reason: 'Trip postponed' });
    expect(full.status).toBe('cancelled');
    expect(full.cancelledAt).not.toBeNull();
    expect(await availability(hotel.deluxe.roomType.id, '2027-02-01', '2027-02-04')).toEqual([
      2, 2, 2,
    ]);
  });

  it('adds a room to an existing reservation', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'direct',
      guest: { firstName: 'Family', lastName: 'Trip' },
      rooms: [std('2027-03-01', '2027-03-03')],
    });
    const more = await addReservationRoom(t.db, org.admin, r.id, dlx('2027-03-01', '2027-03-04'));
    expect(more.rooms).toHaveLength(2);
    expect(more).toMatchObject({ checkOut: '2027-03-04', totalAmount: 2 * 450_000 + 3 * 700_000 });
    expect(more.version).toBeGreaterThan(r.version);
  });

  it('holds inventory for a tentative booking and releases it when the hold lapses', async () => {
    const hold = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      status: 'tentative',
      source: 'website',
      guest: { firstName: 'Web', lastName: 'Shopper' },
      rooms: [dlx('2027-04-01', '2027-04-03'), dlx('2027-04-01', '2027-04-03')],
    });
    expect(hold.status).toBe('tentative');
    expect(hold.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await availability(hotel.deluxe.roomType.id, '2027-04-01', '2027-04-03')).toEqual([
      0, 0,
    ]);

    // Not yet due: nothing happens.
    expect(await expireHolds(t.db, org.admin)).toBe(0);
    expect(await expireHolds(t.db, org.admin, new Date(Date.now() + 16 * 60_000))).toBe(1);
    expect((await loadReservation(t.db, org.orgId, hold.id)).status).toBe('cancelled');
    expect(await availability(hotel.deluxe.roomType.id, '2027-04-01', '2027-04-03')).toEqual([
      2, 2,
    ]);

    // A hold that was paid in time is confirmed and no longer expires.
    const paid = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      status: 'tentative',
      source: 'website',
      guest: { firstName: 'Web', lastName: 'Buyer' },
      rooms: [dlx('2027-04-01', '2027-04-03')],
    });
    const confirmed = await confirmReservation(t.db, org.admin, paid.id);
    expect(confirmed).toMatchObject({ status: 'confirmed', holdExpiresAt: null });
    expect(await expireHolds(t.db, org.admin, new Date(Date.now() + 60 * 60_000))).toBe(0);
    expect(await availability(hotel.deluxe.roomType.id, '2027-04-01', '2027-04-03')).toEqual([
      1, 1,
    ]);
  });

  it('releases the room when a guest does not show up', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'ota',
      channelCode: 'BDC',
      guest: { firstName: 'Never', lastName: 'Arrived' },
      rooms: [dlx('2027-05-01', '2027-05-04')],
    });
    const noShow = await markNoShow(t.db, org.admin, r.id);
    expect(noShow.status).toBe('no_show');
    expect(await availability(hotel.deluxe.roomType.id, '2027-05-01', '2027-05-04')).toEqual([
      2, 2, 2,
    ]);
    expect((await errorOf(markNoShow(t.db, org.admin, r.id))).code).toBe('invalid_state');
  });

  it('rejects a change based on a stale copy of the reservation', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'direct',
      guest: { firstName: 'Two', lastName: 'Editors' },
      rooms: [std('2027-06-01', '2027-06-03')],
    });
    const first = await updateReservation(
      t.db,
      org.admin,
      r.id,
      { notes: 'Late arrival' },
      { expectedVersion: r.version },
    );
    expect(first.version).toBe(r.version + 1);

    const stale = await errorOf(
      updateReservationRoom(
        t.db,
        org.admin,
        r.id,
        r.rooms[0]!.id,
        { checkOut: '2027-06-04' },
        { expectedVersion: r.version },
      ),
    );
    expect(stale.code).toBe('stale_version');
    expect(stale.details?.currentVersion).toBe(first.version);
    expect((await loadReservation(t.db, org.orgId, r.id)).checkOut).toBe('2027-06-03');
  });

  it('validates stays and party sizes', async () => {
    const base = {
      propertyId: hotel.property.id,
      source: 'direct' as const,
      guest: { firstName: 'V' },
    };
    const cases = [
      { ...base, rooms: [] },
      { ...base, rooms: [std('2027-07-03', '2027-07-03')] },
      { ...base, rooms: [std('2027-07-03', '2027-07-01')] },
      { ...base, rooms: [std('2027-02-30', '2027-03-02')] },
      { ...base, rooms: [std('2027-07-01', '2028-08-01')] },
      { ...base, rooms: [{ ...std('2027-07-01', '2027-07-02'), adults: 0 }] },
      { ...base, rooms: [{ ...std('2027-07-01', '2027-07-02'), adults: 4 }] },
      {
        ...base,
        rooms: [{ ...std('2027-07-01', '2027-07-02'), ratePlanId: hotel.deluxe.ratePlan.id }],
      },
      { ...base, rooms: [{ ...std('2027-07-01', '2027-07-03'), nightlyRates: [100] }] },
      { ...base, guest: {}, rooms: [std('2027-07-01', '2027-07-02')] },
    ];
    for (const input of cases) {
      expect((await errorOf(createReservation(t.db, org.admin, input))).code).toBe('validation');
    }
    // A channel sends whatever party size the guest typed; that must not block the booking.
    const ota = await createReservation(
      t.db,
      org.admin,
      {
        ...base,
        source: 'ota',
        channelCode: 'EXP',
        rooms: [{ ...std('2027-07-01', '2027-07-02'), adults: 6 }],
      },
      { skipOccupancyLimits: true },
    );
    expect(ota.adults).toBe(6);
  });

  it('keeps channel prices when nightly rates are given', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'ota',
      channelCode: 'AGO',
      externalId: 'AGO-555',
      commissionAmount: 150_000,
      paymentCollect: 'channel',
      guest: { firstName: 'Channel', lastName: 'Guest' },
      rooms: [{ ...std('2027-08-01', '2027-08-03'), nightlyRates: [410_000, 430_000] }],
    });
    expect(r.rooms[0]!.nights).toEqual([
      { date: '2027-08-01', amount: 410_000 },
      { date: '2027-08-02', amount: 430_000 },
    ]);
    expect(r).toMatchObject({
      totalAmount: 840_000,
      commissionAmount: 150_000,
      paymentCollect: 'channel',
    });

    // Extending keeps the agreed nights and prices only the new one from the plan.
    const longer = await updateReservationRoom(t.db, org.admin, r.id, r.rooms[0]!.id, {
      checkOut: '2027-08-04',
    });
    expect(longer.reservation.rooms[0]!.nights.map((n) => n.amount)).toEqual([
      410_000, 430_000, 450_000,
    ]);
  });
});

describe('guests', () => {
  it('reuses one profile for a returning guest, matched by email then phone', async () => {
    const book = (guest: Record<string, string>, checkIn: string) =>
      createReservation(t.db, org.admin, {
        propertyId: hotel.property.id,
        source: 'direct',
        guest: { firstName: 'Rahul', lastName: 'Mehta', ...guest },
        rooms: [std(checkIn, checkIn.replace(/\d\d$/, '28'))],
      });
    const first = await book({ email: 'Rahul.Mehta@Example.com' }, '2027-09-01');
    const second = await book(
      { email: 'rahul.mehta@example.com', phone: '98200 55555' },
      '2027-10-01',
    );
    const third = await book({ phone: '9820055555' }, '2027-11-01');
    expect(second.guestId).toBe(first.guestId);
    expect(third.guestId).toBe(first.guestId);
    const [profile] = await t.db.select().from(guests).where(eq(guests.id, first.guestId!));
    // The phone number learned on the second booking was added to the profile.
    expect(profile).toMatchObject({ email: 'rahul.mehta@example.com', phone: '9820055555' });
  });

  it('encrypts identity numbers and records every time one is viewed', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'walk_in',
      guest: { firstName: 'Passport', lastName: 'Holder' },
      rooms: [std('2027-12-01', '2027-12-02')],
    });
    await updateGuest(t.db, org.admin, r.guestId!, { idType: 'passport', idNumber: 'Z1234567' });
    const [stored] = await t.db.select().from(guests).where(eq(guests.id, r.guestId!));
    expect(stored!.idNumberEnc).toBeTruthy();
    expect(stored!.idNumberEnc).not.toContain('Z1234567');

    expect((await loadReservation(t.db, org.orgId, r.id)).guest).toMatchObject({
      hasIdNumber: true,
      idType: 'passport',
    });
    expect(JSON.stringify(await loadReservation(t.db, org.orgId, r.id))).not.toContain('Z1234567');

    expect(await revealGuestIdNumber(t.db, org.admin, r.guestId!)).toBe('Z1234567');
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.entityId, r.guestId!));
    expect(audit.some((a) => a.action === 'guest.id_viewed')).toBe(true);
    // The audit entry for the update never contains the number itself.
    expect(JSON.stringify(audit)).not.toContain('Z1234567');
  });
});

describe('searching and the calendar view', () => {
  it('finds reservations by code, guest, channel reference and dates', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'ota',
      channelCode: 'BDC',
      externalId: 'chx-7781',
      channelReservationCode: '4081726354',
      guest: { firstName: 'Zubin', lastName: 'Contractor', email: 'zubin@example.org' },
      rooms: [std('2028-01-05', '2028-01-08')],
    });
    const find = async (filter: Parameters<typeof listReservations>[2]) =>
      (await listReservations(t.db, org.orgId, filter)).reservations.map((x) => x.id);

    expect(await find({ propertyIds: 'all', search: r.code.toLowerCase() })).toEqual([r.id]);
    expect(await find({ propertyIds: 'all', search: 'contractor' })).toEqual([r.id]);
    expect(await find({ propertyIds: 'all', search: '408172' })).toEqual([r.id]);
    expect(await find({ propertyIds: 'all', search: 'zubin@example' })).toEqual([r.id]);
    expect(await find({ propertyIds: [hotel.property.id], arrivingOn: '2028-01-05' })).toEqual([
      r.id,
    ]);
    expect(await find({ propertyIds: [hotel.property.id], departingOn: '2028-01-08' })).toEqual([
      r.id,
    ]);
    expect(
      await find({
        propertyIds: [hotel.property.id],
        staying: { from: '2028-01-07', to: '2028-01-08' },
      }),
    ).toEqual([r.id]);
    expect(
      await find({
        propertyIds: [hotel.property.id],
        staying: { from: '2028-01-09', to: '2028-01-12' },
      }),
    ).toEqual([]);
    // A user with access to no property sees nothing, whatever they search for.
    expect(await find({ propertyIds: [], search: r.code })).toEqual([]);

    const paged = await listReservations(t.db, org.orgId, { propertyIds: 'all', limit: 2 });
    expect(paged.reservations).toHaveLength(2);
    expect(paged.total).toBeGreaterThan(2);
  });

  it('assembles units, nightly availability, stays and blocks for the grid', async () => {
    const villa = await createTestVilla(t.db, org, { bedrooms: 2, name: 'Calendar Villa' });
    const stay = await createReservation(t.db, org.admin, {
      propertyId: villa.property.id,
      source: 'ota',
      channelCode: 'ABB',
      guest: { firstName: 'Calendar', lastName: 'Guest' },
      rooms: [
        {
          roomTypeId: villa.whole.roomType.id,
          ratePlanId: villa.whole.ratePlan.id,
          checkIn: '2027-01-11',
          checkOut: '2027-01-13',
          adults: 4,
        },
      ],
    });
    const block = await createBlock(t.db, org.admin, {
      propertyId: villa.property.id,
      unitId: villa.whole.units[0]!.id,
      kind: 'owner_stay',
      startDate: '2027-01-14',
      endDate: '2027-01-16',
      reason: 'Owner visit',
    });

    const view = await getCalendar(t.db, org.orgId, {
      propertyIds: [villa.property.id, hotel.property.id],
      range: { from: '2027-01-10', to: '2027-01-17' },
    });
    expect(view.dates).toHaveLength(7);
    expect(view.properties.map((p) => p.name)).toEqual(
      ['Calendar Villa', hotel.property.name].sort(),
    );

    const p = view.properties.find((x) => x.id === villa.property.id)!;
    const whole = p.roomTypes.find((x) => x.id === villa.whole.roomType.id)!;
    const beds = p.roomTypes.find((x) => x.id === villa.bedrooms!.roomType.id)!;
    expect(whole.units.map((u) => u.name)).toEqual(['Villa']);
    expect(beds.units.map((u) => u.name)).toEqual(['Bedroom 1', 'Bedroom 2']);
    expect(beds.units.every((u) => u.parentUnitId === villa.whole.units[0]!.id)).toBe(true);
    expect(whole.days.map((d) => d.available)).toEqual([1, 0, 0, 1, 0, 0, 1]);
    // The bedrooms are closed on exactly the nights the villa is taken.
    expect(beds.days.map((d) => d.available)).toEqual([2, 0, 0, 2, 0, 0, 2]);
    expect(whole.days[0]!.rate).toBe(2_500_000);

    expect(p.stays).toEqual([
      expect.objectContaining({
        reservationId: stay.id,
        unitId: villa.whole.units[0]!.id,
        channelCode: 'ABB',
        checkIn: '2027-01-11',
        checkOut: '2027-01-13',
        guestName: 'Calendar Guest',
      }),
    ]);
    expect(p.blocks).toEqual([
      expect.objectContaining({ id: block.id, kind: 'owner_stay', reason: 'Owner visit' }),
    ]);

    await expect(
      getCalendar(t.db, org.orgId, {
        propertyIds: [hotel.property.id],
        range: { from: '2027-01-01', to: '2027-08-01' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('writes an audit entry for every reservation change', async () => {
    const r = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'direct',
      guest: { firstName: 'Audit', lastName: 'Trail' },
      rooms: [std('2028-02-01', '2028-02-02')],
    });
    await updateReservation(t.db, org.admin, r.id, { notes: 'VIP' });
    await updateReservationRoom(t.db, org.admin, r.id, r.rooms[0]!.id, { checkOut: '2028-02-03' });
    await cancelReservation(t.db, org.admin, r.id, { reason: 'Test' });
    const entries = await t.db.select().from(auditLog).where(eq(auditLog.entityId, r.id));
    expect(entries.map((e) => e.action).sort()).toEqual([
      'reservation.cancelled',
      'reservation.created',
      'reservation.room_changed',
      'reservation.updated',
    ]);
    expect(
      entries.every((e) => e.propertyId === hotel.property.id && e.actorLabel === org.admin.label),
    ).toBe(true);
    const [row] = await t.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row!.cancellationReason).toBe('Test');
  });
});
