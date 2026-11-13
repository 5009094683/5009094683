import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alerts,
  bookingRevisions,
  channelConnections,
  guests,
  reservationRooms,
  reservations,
  syncLog,
} from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import {
  addDays,
  createReservation,
  getAvailability,
  loadReservation,
  todayIn,
  type DateString,
} from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestVilla,
  type TestHotel,
  type TestOrg,
} from '@pms/domain/testing';
import type { BookingEvent } from '../adapter';
import { bookingEvent, type FakeChannel, fakeChannelFor, useFakeChannels } from '../testing';
import {
  createConnection,
  getMappings,
  saveMappings,
  updateConnection,
  type ConnectionRow,
} from './connections';
import { dispatchDue } from './dispatcher';
import { pruneSyncHistory, UNUSED_MESSAGE_DAYS } from './health';
import {
  applyRevision,
  ingestBookingEvent,
  listRevisions,
  pullConnection,
  reprocessRevision,
  retryPendingRevisions,
} from './inbound';
import { routeOutbox } from './router';

let t: TestDatabase;
let org: TestOrg;

const TZ = 'Asia/Kolkata';
const day = (offset: number): DateString => addDays(todayIn(TZ), offset);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  useFakeChannels();
});
afterAll(async () => {
  await t.drop();
});

interface Connected {
  hotel: TestHotel;
  connection: ConnectionRow;
  channel: FakeChannel;
}

async function connectHotel(
  options: { standardRooms?: number; deluxeRooms?: number } = {},
): Promise<Connected> {
  const hotel = await createTestHotel(t.db, org, options);
  const created = await createConnection(t.db, org.admin, {
    propertyId: hotel.property.id,
    adapter: 'channex',
  });
  await saveMappings(t.db, org.admin, created.id, {
    roomTypes: [
      { roomTypeId: hotel.standard.roomType.id, externalId: 'ext-std' },
      { roomTypeId: hotel.deluxe.roomType.id, externalId: 'ext-dlx' },
    ],
    ratePlans: [
      { ratePlanId: hotel.standard.ratePlan.id, externalId: 'ext-std-bar' },
      { ratePlanId: hotel.deluxe.ratePlan.id, externalId: 'ext-dlx-bar' },
    ],
  });
  const connection = await updateConnection(t.db, org.admin, created.id, { status: 'active' });
  const channel = fakeChannelFor(connection.id);
  await sync();
  channel.pushes.length = 0;
  return { hotel, connection, channel };
}

async function sync(now: Date = new Date()) {
  await routeOutbox(t.db);
  return dispatchDue(t.db, now);
}

const stdRoom = (
  checkIn: DateString,
  checkOut: DateString,
  extra: Partial<BookingEvent['rooms'][number]> = {},
) => ({
  externalRoomTypeId: 'ext-std',
  externalRatePlanId: 'ext-std-bar',
  checkIn,
  checkOut,
  ...extra,
});

const available = async (hotel: TestHotel, roomTypeId: string, date: DateString) =>
  (
    await getAvailability(t.db, {
      propertyId: hotel.property.id,
      range: { from: date, to: addDays(date, 1) },
      roomTypeIds: [roomTypeId],
    })
  )[0]!.available;

const reservationFor = async (connectionId: string, bookingId: string) =>
  (
    await t.db
      .select()
      .from(reservations)
      .where(
        and(eq(reservations.connectionId, connectionId), eq(reservations.externalId, bookingId)),
      )
  )[0];

const revisionRow = async (id: string) =>
  (await t.db.select().from(bookingRevisions).where(eq(bookingRevisions.id, id)))[0]!;

const openAlerts = async (dedupeKey: string) =>
  (await t.db.select().from(alerts).where(eq(alerts.dedupeKey, dedupeKey))).filter(
    (a) => a.status !== 'resolved',
  );

describe('a new booking from a channel', () => {
  let c: Connected;
  beforeEach(async () => {
    c = await connectHotel({ standardRooms: 3, deluxeRooms: 2 });
  });

  it('becomes a reservation, takes the rooms, and is acknowledged', async () => {
    const event = bookingEvent({
      channelCode: 'BDC',
      channelReservationCode: '4521887766',
      totalAmount: 1_000_000,
      commissionAmount: 150_000,
      paymentCollect: 'channel',
      arrivalTime: '15:00',
      notes: 'Late arrival, quiet room please',
      guest: {
        firstName: 'Lena',
        lastName: 'Fischer',
        email: 'lena.f@guest.booking.example',
        phone: '+49 171 5550101',
        country: 'DE',
      },
      rooms: [
        stdRoom(day(10), day(12), {
          nightlyRates: { [day(10)]: 480_000, [day(11)]: 520_000 },
          adults: 2,
          children: 1,
        }),
      ],
    });
    c.channel.feed.push(event);
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');

    expect(result).toMatchObject({ status: 'applied', duplicate: false, acknowledged: true });
    expect(c.channel.acked).toEqual([event.revisionId]);
    expect(c.channel.feed).toHaveLength(0);

    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation).toMatchObject({
      status: 'confirmed',
      source: 'ota',
      channelCode: 'BDC',
      channelReservationCode: '4521887766',
      externalId: event.bookingId,
      guestName: 'Lena Fischer',
      checkIn: day(10),
      checkOut: day(12),
      totalAmount: 1_000_000,
      commissionAmount: 150_000,
      paymentCollect: 'channel',
      arrivalTime: '15:00',
      specialRequests: 'Late arrival, quiet room please',
      overbooked: false,
      needsReview: false,
    });
    expect(reservation.rooms[0]).toMatchObject({
      roomTypeId: c.hotel.standard.roomType.id,
      ratePlanId: c.hotel.standard.ratePlan.id,
      adults: 2,
      children: 1,
      nights: [
        { date: day(10), amount: 480_000 },
        { date: day(11), amount: 520_000 },
      ],
    });
    expect(reservation.guest).toMatchObject({
      email: 'lena.f@guest.booking.example',
      country: 'DE',
    });
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(2);

    const row = await revisionRow(result.id);
    expect(row).toMatchObject({ status: 'applied', receivedVia: 'webhook', channelCode: 'BDC' });
    expect(row.ackedAt).not.toBeNull();
    expect(row.raw).toEqual({ fake: true });
  });

  it('closes the dates on every channel within one sync', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    await sync();
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
    expect(c.channel.availabilityOn('ext-std', day(11))).toBe(2);
    expect(c.channel.availabilityOn('ext-std', day(12))).toBe(3);
  });

  it('is recorded once however many times it is delivered', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    const first = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    const again = await ingestBookingEvent(t.db, c.connection, event, 'poll');
    const [a, b] = await Promise.all([
      ingestBookingEvent(t.db, c.connection, event, 'webhook'),
      ingestBookingEvent(t.db, c.connection, event, 'poll'),
    ]);
    expect(again).toMatchObject({
      duplicate: true,
      status: 'applied',
      reservationId: first.reservationId,
    });
    expect(a.reservationId).toBe(first.reservationId);
    expect(b.reservationId).toBe(first.reservationId);
    const all = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.connectionId, c.connection.id));
    expect(all).toHaveLength(1);
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(2);
  });

  it('survives two workers receiving the same new booking at the same moment', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        ingestBookingEvent(t.db, c.connection, event, i % 2 ? 'poll' : 'webhook'),
      ),
    );
    expect(new Set(results.map((r) => r.reservationId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(2);
  });

  it('is never refused: with no room left it is recorded over capacity and staff are alerted', async () => {
    for (let i = 0; i < 3; i++) {
      await createReservation(t.db, org.admin, {
        propertyId: c.hotel.property.id,
        source: 'direct',
        guest: { firstName: 'Walk', lastName: `In ${i}` },
        rooms: [
          {
            roomTypeId: c.hotel.standard.roomType.id,
            checkIn: day(10),
            checkOut: day(11),
            adults: 1,
          },
        ],
      });
    }
    const event = bookingEvent({ channelCode: 'ABB', rooms: [stdRoom(day(10), day(11))] });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    expect(result).toMatchObject({ status: 'applied', acknowledged: true });
    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation.overbooked).toBe(true);
    const [alert] = await openAlerts(`overbooking:${reservation.id}`);
    expect(alert).toMatchObject({ kind: 'overbooking', severity: 'critical' });
    expect(alert!.body).toContain('ABB');
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(0);
  });

  it('spreads a room total over the nights when the channel gives no nightly prices', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(13), { amount: 1_000_000 })] });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation.rooms[0]!.nights.map((n) => n.amount)).toEqual([333_334, 333_333, 333_333]);
    expect(reservation.totalAmount).toBe(1_000_000);
  });

  it('prices from the PMS rate plan and asks for a check when the channel sold in another currency', async () => {
    const event = bookingEvent({
      currency: 'USD',
      totalAmount: 24_000,
      rooms: [stdRoom(day(10), day(12), { amount: 24_000 })],
    });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation.totalAmount).toBe(900_000);
    expect(reservation.needsReview).toBe(true);
    expect(reservation.reviewReason).toMatch(/Sold in USD/);
    expect(reservation.notes).toMatch(/USD 240\.00/);
  });

  it('keeps the booking when the rate plan is not mapped, using the channel’s prices', async () => {
    const event = bookingEvent({
      rooms: [
        stdRoom(day(10), day(11), { externalRatePlanId: 'some-promo-rate', amount: 399_900 }),
      ],
    });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation.rooms[0]).toMatchObject({ ratePlanId: null, amount: 399_900 });
    expect(reservation.needsReview).toBe(false);
  });

  it('accepts party sizes above the room’s own limits, as the guest entered them', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(11), { adults: 6, children: 3 })] });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    expect(result.status).toBe('applied');
    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation.rooms[0]).toMatchObject({ adults: 6, children: 3 });
  });

  it('does not merge different guests who share a channel’s generic address', async () => {
    const first = await ingestBookingEvent(
      t.db,
      c.connection,
      bookingEvent({
        guest: { firstName: 'Rahul', lastName: 'Mehta', email: 'noreply@ota.example' },
        rooms: [stdRoom(day(10), day(11))],
      }),
      'webhook',
    );
    const second = await ingestBookingEvent(
      t.db,
      c.connection,
      bookingEvent({
        guest: { firstName: 'Sofia', lastName: 'Alvarez', email: 'noreply@ota.example' },
        rooms: [stdRoom(day(12), day(13))],
      }),
      'webhook',
    );
    const a = await loadReservation(t.db, org.orgId, first.reservationId!);
    const b = await loadReservation(t.db, org.orgId, second.reservationId!);
    expect(a.guestName).toBe('Rahul Mehta');
    expect(b.guestName).toBe('Sofia Alvarez');
    expect(a.guestId).not.toBe(b.guestId);
    const profiles = await t.db
      .select()
      .from(guests)
      .where(eq(guests.email, 'noreply@ota.example'));
    expect(profiles).toHaveLength(2);
  });

  it('names the guest after the channel when the channel sent no name', async () => {
    const event = bookingEvent({
      channelCode: 'ABB',
      guest: { firstName: '', lastName: '', email: null },
      rooms: [stdRoom(day(10), day(11))],
    });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    const reservation = await loadReservation(t.db, org.orgId, result.reservationId!);
    expect(reservation.guestName).toBe('Guest (Airbnb)');
  });

  it('logs the booking for the sync monitor', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    const log = await t.db.select().from(syncLog).where(eq(syncLog.connectionId, c.connection.id));
    expect(
      log.some((l) => l.direction === 'in' && l.operation === 'booking.new' && l.status === 'ok'),
    ).toBe(true);
    const [summary] = await listRevisions(t.db, org.orgId, {
      propertyIds: 'all',
      connectionId: c.connection.id,
    });
    expect(summary).toMatchObject({
      id: result.id,
      kind: 'new',
      status: 'applied',
      guestName: 'Asha Rao',
      checkIn: day(10),
      checkOut: day(12),
      acknowledged: true,
      reservationId: result.reservationId,
    });
    expect(summary!.reservationCode).toMatch(/^[A-Z0-9]{8}$/);
  });
});

describe('changes and cancellations', () => {
  let c: Connected;
  let original: BookingEvent;
  let reservationId: string;
  const t0 = new Date('2027-01-05T10:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  beforeEach(async () => {
    c = await connectHotel({ standardRooms: 3, deluxeRooms: 2 });
    original = bookingEvent({
      revisionAt: at(0),
      rooms: [stdRoom(day(10), day(12), { amount: 900_000, externalRoomRef: 'r1' })],
    });
    reservationId = (await ingestBookingEvent(t.db, c.connection, original, 'webhook'))
      .reservationId!;
  });

  const revise = (overrides: Parameters<typeof bookingEvent>[0]) =>
    bookingEvent({
      bookingId: original.bookingId,
      channelReservationCode: original.channelReservationCode,
      ...overrides,
    });

  it('moves the stay when the guest changes dates', async () => {
    const result = await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(5),
        rooms: [stdRoom(day(11), day(14), { amount: 1_500_000, externalRoomRef: 'r1' })],
      }),
      'webhook',
    );
    expect(result).toMatchObject({ status: 'applied', reservationId });
    const reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation).toMatchObject({
      checkIn: day(11),
      checkOut: day(14),
      totalAmount: 1_500_000,
      status: 'confirmed',
    });
    const std = c.hotel.standard.roomType.id;
    expect(await available(c.hotel, std, day(10))).toBe(3);
    expect(await available(c.hotel, std, day(11))).toBe(2);
    expect(await available(c.hotel, std, day(13))).toBe(2);
    expect(
      (await t.db.select().from(reservations).where(eq(reservations.connectionId, c.connection.id)))
        .length,
    ).toBe(1);
  });

  it('moves the booking to another room type when the guest upgrades', async () => {
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(5),
        rooms: [
          {
            externalRoomTypeId: 'ext-dlx',
            externalRatePlanId: 'ext-dlx-bar',
            checkIn: day(10),
            checkOut: day(12),
            amount: 1_400_000,
            externalRoomRef: 'r1',
          },
        ],
      }),
      'webhook',
    );
    const reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation.rooms).toHaveLength(1);
    expect(reservation.rooms[0]).toMatchObject({
      roomTypeId: c.hotel.deluxe.roomType.id,
      ratePlanId: c.hotel.deluxe.ratePlan.id,
      amount: 1_400_000,
    });
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(3);
    expect(await available(c.hotel, c.hotel.deluxe.roomType.id, day(10))).toBe(1);
  });

  it('adds and removes rooms of a multi-room booking', async () => {
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(5),
        rooms: [
          stdRoom(day(10), day(12), { amount: 900_000, externalRoomRef: 'r1' }),
          {
            externalRoomTypeId: 'ext-dlx',
            externalRatePlanId: 'ext-dlx-bar',
            checkIn: day(10),
            checkOut: day(12),
            amount: 1_400_000,
            externalRoomRef: 'r2',
          },
        ],
      }),
      'webhook',
    );
    let reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation.rooms.filter((r) => r.status === 'confirmed')).toHaveLength(2);
    expect(reservation.totalAmount).toBe(2_300_000);
    expect(await available(c.hotel, c.hotel.deluxe.roomType.id, day(10))).toBe(1);

    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(10),
        rooms: [
          {
            externalRoomTypeId: 'ext-dlx',
            externalRatePlanId: 'ext-dlx-bar',
            checkIn: day(10),
            checkOut: day(12),
            amount: 1_400_000,
            externalRoomRef: 'r2',
          },
        ],
      }),
      'webhook',
    );
    reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation.status).toBe('confirmed');
    expect(reservation.rooms.filter((r) => r.status === 'confirmed')).toHaveLength(1);
    expect(reservation.rooms.find((r) => r.status === 'confirmed')!.roomTypeId).toBe(
      c.hotel.deluxe.roomType.id,
    );
    expect(reservation.totalAmount).toBe(1_400_000);
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(3);
    expect(await available(c.hotel, c.hotel.deluxe.roomType.id, day(10))).toBe(1);
  });

  it('changes nothing when a revision repeats what is already recorded', async () => {
    const before = await loadReservation(t.db, org.orgId, reservationId);
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(5),
        rooms: [stdRoom(day(10), day(12), { amount: 900_000, externalRoomRef: 'r1' })],
      }),
      'webhook',
    );
    const after = await loadReservation(t.db, org.orgId, reservationId);
    expect(after.rooms[0]!.unitId).toBe(before.rooms[0]!.unitId);
    expect(after.totalAmount).toBe(before.totalAmount);
    expect(after.externalRevisionAt).toEqual(at(5));
  });

  it('releases the rooms on cancellation and tells the other channels', async () => {
    await sync();
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
    const result = await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'cancelled',
        revisionAt: at(5),
        rooms: [stdRoom(day(10), day(12), { externalRoomRef: 'r1' })],
      }),
      'webhook',
    );
    expect(result).toMatchObject({ status: 'applied', reservationId });
    const reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation.status).toBe('cancelled');
    expect(reservation.cancellationReason).toBe('Cancelled on Booking.com');
    await sync();
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(3);
  });

  it('brings the reservation back when the channel reinstates a cancelled booking', async () => {
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({ status: 'cancelled', revisionAt: at(5), rooms: [stdRoom(day(10), day(12))] }),
      'webhook',
    );
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(9),
        rooms: [stdRoom(day(10), day(12), { amount: 900_000, externalRoomRef: 'r1' })],
      }),
      'webhook',
    );
    const reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation.status).toBe('confirmed');
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(2);
  });

  it('ignores a revision older than one already applied', async () => {
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(10),
        rooms: [stdRoom(day(11), day(14), { externalRoomRef: 'r1' })],
      }),
      'webhook',
    );
    // An earlier change, delayed in transit, arrives afterwards.
    const stale = await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(5),
        rooms: [stdRoom(day(20), day(22), { externalRoomRef: 'r1' })],
      }),
      'poll',
    );
    expect(stale).toMatchObject({ status: 'superseded', acknowledged: true });
    const reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation).toMatchObject({ checkIn: day(11), checkOut: day(14) });
  });

  it('does not resurrect a booking when its cancellation overtakes an earlier change', async () => {
    await ingestBookingEvent(
      t.db,
      c.connection,
      revise({ status: 'cancelled', revisionAt: at(10), rooms: [stdRoom(day(10), day(12))] }),
      'webhook',
    );
    const late = await ingestBookingEvent(
      t.db,
      c.connection,
      revise({
        status: 'modified',
        revisionAt: at(5),
        rooms: [stdRoom(day(11), day(14), { externalRoomRef: 'r1' })],
      }),
      'poll',
    );
    expect(late.status).toBe('superseded');
    expect((await loadReservation(t.db, org.orgId, reservationId)).status).toBe('cancelled');
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(11))).toBe(3);
  });

  it('leaves a checked-in guest alone when the channel reports a cancellation', async () => {
    await t.db
      .update(reservationRooms)
      .set({ status: 'in_house' })
      .where(eq(reservationRooms.reservationId, reservationId));
    await t.db
      .update(reservations)
      .set({ status: 'in_house' })
      .where(eq(reservations.id, reservationId));
    const result = await ingestBookingEvent(
      t.db,
      c.connection,
      revise({ status: 'cancelled', revisionAt: at(5), rooms: [stdRoom(day(10), day(12))] }),
      'webhook',
    );
    expect(result.status).toBe('applied');
    const reservation = await loadReservation(t.db, org.orgId, reservationId);
    expect(reservation.status).toBe('in_house');
    expect(reservation.needsReview).toBe(true);
    expect(reservation.reviewReason).toMatch(/cancelled after the guest checked in/);
    expect(await openAlerts(`booking_review:${reservationId}`)).toHaveLength(1);
  });
});

describe('messages that arrive in the wrong order', () => {
  it('does not create a booking whose cancellation arrived first', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const t0 = new Date('2027-01-05T10:00:00Z');
    const created = bookingEvent({ revisionAt: t0, rooms: [stdRoom(day(10), day(12))] });
    const cancelled = bookingEvent({
      bookingId: created.bookingId,
      status: 'cancelled',
      revisionAt: new Date(t0.getTime() + 60_000),
      rooms: [stdRoom(day(10), day(12))],
    });
    expect(await ingestBookingEvent(t.db, c.connection, cancelled, 'webhook')).toMatchObject({
      status: 'applied',
      reservationId: null,
    });
    expect(await ingestBookingEvent(t.db, c.connection, created, 'poll')).toMatchObject({
      status: 'superseded',
    });
    expect(await reservationFor(c.connection.id, created.bookingId)).toBeUndefined();
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(3);
  });

  it('creates the booking from a change that arrives before the original', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const t0 = new Date('2027-01-05T10:00:00Z');
    const created = bookingEvent({ revisionAt: t0, rooms: [stdRoom(day(10), day(12))] });
    const modified = bookingEvent({
      bookingId: created.bookingId,
      status: 'modified',
      revisionAt: new Date(t0.getTime() + 60_000),
      rooms: [stdRoom(day(15), day(17))],
    });
    const first = await ingestBookingEvent(t.db, c.connection, modified, 'webhook');
    expect(first.status).toBe('applied');
    expect(await ingestBookingEvent(t.db, c.connection, created, 'poll')).toMatchObject({
      status: 'superseded',
    });
    const reservation = await loadReservation(t.db, org.orgId, first.reservationId!);
    expect(reservation).toMatchObject({ checkIn: day(15), checkOut: day(17) });
    expect(
      (await t.db.select().from(reservations).where(eq(reservations.connectionId, c.connection.id)))
        .length,
    ).toBe(1);
  });
});

describe('revisions of one booking arriving together', () => {
  it('applies them one at a time and ends on the newest', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const t0 = new Date('2027-01-05T10:00:00Z');
    const created = bookingEvent({ revisionAt: t0, rooms: [stdRoom(day(10), day(12))] });
    const modified = bookingEvent({
      bookingId: created.bookingId,
      status: 'modified',
      revisionAt: new Date(t0.getTime() + 1000),
      rooms: [stdRoom(day(15), day(18))],
    });
    const cancelledOther = bookingEvent({ rooms: [stdRoom(day(10), day(11))] });
    const results = await Promise.all([
      ingestBookingEvent(t.db, c.connection, created, 'webhook'),
      ingestBookingEvent(t.db, c.connection, modified, 'webhook'),
      ingestBookingEvent(t.db, c.connection, cancelledOther, 'webhook'),
    ]);
    expect(results.map((r) => r.status).filter((s) => s === 'failed')).toEqual([]);
    const all = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.connectionId, c.connection.id));
    expect(all).toHaveLength(2);
    const reservation = (await reservationFor(c.connection.id, created.bookingId))!;
    expect(reservation).toMatchObject({ checkIn: day(15), checkOut: day(18), status: 'confirmed' });
    const std = c.hotel.standard.roomType.id;
    expect(await available(c.hotel, std, day(10))).toBe(2);
    expect(await available(c.hotel, std, day(11))).toBe(3);
    expect(await available(c.hotel, std, day(16))).toBe(2);
  });
});

describe('bookings that cannot be placed', () => {
  it('holds a booking for an unmapped room, alerts, and applies it once the room is mapped', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const event = bookingEvent({
      rooms: [
        {
          externalRoomTypeId: 'ext-suite',
          externalRatePlanId: 'ext-suite-bar',
          checkIn: day(10),
          checkOut: day(12),
          amount: 2_000_000,
        },
      ],
    });
    const result = await ingestBookingEvent(t.db, c.connection, event, 'webhook');
    // Stored and acknowledged: the PMS now owns the problem, the channel need not resend.
    expect(result).toMatchObject({ status: 'unmapped', reservationId: null, acknowledged: true });
    const key = `unmapped_booking:${c.connection.id}:${event.bookingId}`;
    const [alert] = await openAlerts(key);
    expect(alert).toMatchObject({ kind: 'unmapped_booking', severity: 'critical' });
    expect(alert!.body).toContain('ext-suite');

    const mappings = await getMappings(t.db, c.connection.id);
    await saveMappings(t.db, org.admin, c.connection.id, {
      roomTypes: [
        ...mappings.roomTypes.filter((m) => m.externalId !== 'ext-dlx'),
        { roomTypeId: c.hotel.deluxe.roomType.id, externalId: 'ext-suite' },
      ],
    });
    // Saving the mapping is enough: the held booking is tried again by itself.
    expect(await retryPendingRevisions(t.db)).toMatchObject({ applied: 1, failed: 0 });
    const applied = await reprocessRevision(t.db, org.admin, result.id);
    expect(applied).toMatchObject({ status: 'applied', changed: false });
    const reservation = await loadReservation(t.db, org.orgId, applied.reservationId!);
    expect(reservation.rooms[0]!.roomTypeId).toBe(c.hotel.deluxe.roomType.id);
    expect(await openAlerts(key)).toHaveLength(0);
    // A calendar or mailbox connection sends nothing, so saving never asks it to send everything.
    const [after] = await t.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, c.connection.id));
    expect(after!.fullSyncRequestedAt).not.toBeNull();
    // Applying it again does nothing.
    expect(await reprocessRevision(t.db, org.admin, result.id)).toMatchObject({ changed: false });
  });

  it('drops the contents of a booking message nobody acted on, once it is old', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const unused = bookingEvent({
      guest: { firstName: 'Noor', lastName: 'Unmapped', email: 'noor@example.com' },
      rooms: [
        {
          externalRoomTypeId: 'ext-nowhere',
          externalRatePlanId: 'ext-nowhere-bar',
          checkIn: day(10),
          checkOut: day(12),
          amount: 1_000_000,
        },
      ],
    });
    const held = await ingestBookingEvent(t.db, c.connection, unused, 'webhook');
    const booked = await ingestBookingEvent(
      t.db,
      c.connection,
      bookingEvent({
        rooms: [
          {
            externalRoomTypeId: 'ext-std',
            externalRatePlanId: 'ext-std-bar',
            checkIn: day(20),
            checkOut: day(21),
            amount: 450_000,
          },
        ],
      }),
      'webhook',
    );
    expect(booked.status).toBe('applied');
    const age = (id: string, days: number) =>
      t.db
        .update(bookingRevisions)
        .set({ receivedAt: new Date(Date.now() - days * 86_400_000) })
        .where(eq(bookingRevisions.id, id));
    const row = async (id: string) =>
      (await t.db.select().from(bookingRevisions).where(eq(bookingRevisions.id, id)))[0]!;

    // Young, or the record of a reservation: kept as received.
    await age(held.id, UNUSED_MESSAGE_DAYS - 1);
    await age(booked.id, UNUSED_MESSAGE_DAYS + 30);
    await pruneSyncHistory(t.db);
    expect(JSON.stringify(await row(held.id))).toContain('noor@example.com');
    expect((await row(booked.id)).raw).not.toEqual({ erased: true });

    await age(held.id, UNUSED_MESSAGE_DAYS + 1);
    expect(await pruneSyncHistory(t.db)).toBeGreaterThanOrEqual(1);
    const emptied = await row(held.id);
    expect(emptied.raw).toEqual({ erased: true });
    expect(emptied.event).toEqual({ bookingId: unused.bookingId, status: 'new' });
    expect(JSON.stringify(emptied)).not.toContain('Noor');
    // The same message arriving again is still recognised, and it can no longer be applied.
    expect(await ingestBookingEvent(t.db, c.connection, unused, 'webhook')).toMatchObject({
      id: held.id,
      duplicate: true,
      status: 'unmapped',
      reservationId: null,
    });
    expect((await row(held.id)).raw).toEqual({ erased: true });
    await expect(reprocessRevision(t.db, org.admin, held.id)).rejects.toThrow(
      /no longer kept, so it cannot be applied again/,
    );
  });

  it('alerts and retries when a booking cannot be applied, and recovers when it can', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    // The channel sends a stay that ends the day it starts: nothing can be made of it.
    const bad: BookingEvent = { ...event, rooms: [{ ...event.rooms[0]!, checkOut: day(10) }] };
    const result = await ingestBookingEvent(t.db, c.connection, bad, 'webhook');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/unusable dates/);
    expect(result.acknowledged).toBe(true);

    const row = await revisionRow(result.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    const key = `inbound_failure:${c.connection.id}:${event.bookingId}`;
    const [alert] = await openAlerts(key);
    expect(alert).toMatchObject({ kind: 'inbound_failure', severity: 'critical' });

    // Not due yet: left alone.
    expect(await retryPendingRevisions(t.db)).toMatchObject({ applied: 0, failed: 0 });
    // Due, and still broken: counted and rescheduled.
    expect(await retryPendingRevisions(t.db, new Date(Date.now() + 60_000))).toMatchObject({
      failed: 1,
    });
    expect((await revisionRow(result.id)).attempts).toBe(2);

    // The channel sends a corrected revision; it applies and clears the alert.
    const fixed = bookingEvent({
      bookingId: event.bookingId,
      status: 'modified',
      revisionAt: new Date(event.revisionAt.getTime() + 1000),
      rooms: [stdRoom(day(10), day(12))],
    });
    expect(await ingestBookingEvent(t.db, c.connection, fixed, 'webhook')).toMatchObject({
      status: 'applied',
    });
    expect(await openAlerts(key)).toHaveLength(0);
    // The broken one is now simply out of date.
    expect(await retryPendingRevisions(t.db, new Date(Date.now() + 3600_000))).toMatchObject({
      applied: 1,
    });
    expect((await revisionRow(result.id)).status).toBe('superseded');
  });

  it('stops retrying after the last attempt and says so', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    const bad: BookingEvent = { ...event, rooms: [{ ...event.rooms[0]!, checkOut: day(10) }] };
    const result = await ingestBookingEvent(t.db, c.connection, bad, 'webhook');
    for (let i = 0; i < 5; i++) await applyRevision(t.db, result.id);
    const row = await revisionRow(result.id);
    expect(row.attempts).toBe(6);
    expect(row.nextAttemptAt).toBeNull();
    const [alert] = await openAlerts(`inbound_failure:${c.connection.id}:${event.bookingId}`);
    expect(alert!.body).toMatch(/retries are exhausted/);
    expect(await retryPendingRevisions(t.db, new Date(Date.now() + 86_400_000))).toMatchObject({
      applied: 0,
      failed: 0,
    });
  });
});

describe('fetching bookings', () => {
  let c: Connected;
  beforeEach(async () => {
    c = await connectHotel({ standardRooms: 3 });
  });

  it('pulls everything waiting, applies it in order and acknowledges each', async () => {
    const t0 = new Date('2027-01-05T10:00:00Z');
    const a = bookingEvent({ revisionAt: t0, rooms: [stdRoom(day(10), day(12))] });
    const b = bookingEvent({
      revisionAt: new Date(t0.getTime() + 1000),
      rooms: [stdRoom(day(10), day(11))],
    });
    const bCancel = bookingEvent({
      bookingId: b.bookingId,
      status: 'cancelled',
      revisionAt: new Date(t0.getTime() + 2000),
      rooms: [stdRoom(day(10), day(11))],
    });
    c.channel.feed.push(a, b, bCancel);
    const result = await pullConnection(t.db, c.connection.id);
    expect(result).toMatchObject({ outcome: 'pulled', received: 3, fresh: 3 });
    expect(c.channel.acked).toEqual([a.revisionId, b.revisionId, bCancel.revisionId]);
    expect(c.channel.feed).toHaveLength(0);
    expect(await available(c.hotel, c.hotel.standard.roomType.id, day(10))).toBe(2);
    expect((await reservationFor(c.connection.id, b.bookingId))!.status).toBe('cancelled');
    expect(
      (
        await t.db
          .select()
          .from(channelConnections)
          .where(eq(channelConnections.id, c.connection.id))
      )[0]!.lastPullAt,
    ).not.toBeNull();

    // Nothing waiting: a quiet no-op.
    expect(await pullConnection(t.db, c.connection.id)).toMatchObject({
      outcome: 'pulled',
      received: 0,
    });
  });

  it('acknowledges again when the first acknowledgement was lost', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    c.channel.feed.push(event);
    c.channel.failAck = new Error('The channel answered 500');
    const first = await pullConnection(t.db, c.connection.id);
    expect(first.results[0]).toMatchObject({ status: 'applied', acknowledged: false });
    expect(c.channel.feed).toHaveLength(1);

    // The channel still lists it, so the next pull sees it again: recorded once, acknowledged now.
    c.channel.failAck = null;
    const second = await pullConnection(t.db, c.connection.id);
    expect(second.results[0]).toMatchObject({
      duplicate: true,
      status: 'applied',
      acknowledged: true,
    });
    expect(c.channel.feed).toHaveLength(0);
    expect(
      (await t.db.select().from(reservations).where(eq(reservations.connectionId, c.connection.id)))
        .length,
    ).toBe(1);
  });

  it('retries acknowledgements in the background and alerts if they keep failing', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    c.channel.feed.push(event);
    c.channel.failAck = new Error('The channel answered 500');
    await pullConnection(t.db, c.connection.id);
    for (let i = 0; i < 4; i++) await retryPendingRevisions(t.db);
    expect(await openAlerts(`ack_failure:${c.connection.id}`)).toHaveLength(1);
    c.channel.failAck = null;
    expect(await retryPendingRevisions(t.db)).toMatchObject({ acknowledged: 1 });
    expect(c.channel.acked).toEqual([event.revisionId]);
    expect(await openAlerts(`ack_failure:${c.connection.id}`)).toHaveLength(0);
  });

  it('finishes a booking that was stored just before a worker died', async () => {
    const event = bookingEvent({ rooms: [stdRoom(day(10), day(12))] });
    const { raw, revisionAt, ...rest } = event;
    await t.db.insert(bookingRevisions).values({
      connectionId: c.connection.id,
      externalRevisionId: event.revisionId,
      externalBookingId: event.bookingId,
      channelCode: event.channelCode,
      receivedVia: 'webhook',
      receivedAt: new Date(Date.now() - 5 * 60_000),
      revisionAt,
      raw,
      event: { ...rest, revisionAt: revisionAt.toISOString() },
    });
    expect(await retryPendingRevisions(t.db)).toMatchObject({ applied: 1, acknowledged: 1 });
    expect(await reservationFor(c.connection.id, event.bookingId)).toMatchObject({
      status: 'confirmed',
    });
    expect(c.channel.acked).toEqual([event.revisionId]);
  });

  it('alerts when bookings cannot be fetched, escalates if it lasts, and clears on recovery', async () => {
    const key = `pull_failure:${c.connection.id}`;
    c.channel.failPull = new Error('connect ETIMEDOUT');
    expect(await pullConnection(t.db, c.connection.id)).toMatchObject({
      outcome: 'failed',
      error: 'connect ETIMEDOUT',
    });
    expect((await openAlerts(key))[0]).toMatchObject({
      kind: 'inbound_failure',
      severity: 'warning',
    });

    await pullConnection(t.db, c.connection.id, 'poll', new Date(Date.now() + 45 * 60_000));
    expect((await openAlerts(key))[0]).toMatchObject({ severity: 'critical', occurrences: 2 });

    c.channel.failPull = null;
    expect(await pullConnection(t.db, c.connection.id)).toMatchObject({ outcome: 'pulled' });
    expect(await openAlerts(key)).toHaveLength(0);
  });

  it('does not fetch for a connection that is switched off', async () => {
    await updateConnection(t.db, org.admin, c.connection.id, { status: 'paused' });
    expect(await pullConnection(t.db, c.connection.id)).toMatchObject({ outcome: 'skipped' });
    expect(c.channel.pullCount).toBe(0);
  });
});

describe('villas', () => {
  it('records a second booking for the same villa nights as an overbooking, never drops it', async () => {
    const villa = await createTestVilla(t.db, org);
    const created = await createConnection(t.db, org.admin, {
      propertyId: villa.property.id,
      adapter: 'channex',
    });
    await saveMappings(t.db, org.admin, created.id, {
      roomTypes: [{ roomTypeId: villa.whole.roomType.id, externalId: 'ext-villa' }],
      ratePlans: [{ ratePlanId: villa.whole.ratePlan.id, externalId: 'ext-villa-bar' }],
    });
    const connection = await updateConnection(t.db, org.admin, created.id, { status: 'active' });
    const room = {
      externalRoomTypeId: 'ext-villa',
      externalRatePlanId: 'ext-villa-bar',
      checkIn: day(10),
      checkOut: day(13),
    };

    const airbnb = await ingestBookingEvent(
      t.db,
      connection,
      bookingEvent({ channelCode: 'ABB', rooms: [room] }),
      'webhook',
    );
    const bookingCom = await ingestBookingEvent(
      t.db,
      connection,
      bookingEvent({ channelCode: 'BDC', rooms: [room] }),
      'webhook',
    );
    expect(airbnb.status).toBe('applied');
    expect(bookingCom.status).toBe('applied');

    const first = await loadReservation(t.db, org.orgId, airbnb.reservationId!);
    const second = await loadReservation(t.db, org.orgId, bookingCom.reservationId!);
    expect(first.rooms[0]!.unitId).toBe(villa.whole.units[0]!.id);
    expect(first.overbooked).toBe(false);
    // The villa is one unit: the second booking has nowhere to go and is flagged for staff.
    expect(second.rooms[0]!.unitId).toBeNull();
    expect(second.overbooked).toBe(true);
    expect(await openAlerts(`overbooking:${second.id}`)).toHaveLength(1);
  });
});
