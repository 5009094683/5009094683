import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookingRevisions, guests, reservations } from '@pms/db';
import { createTestHotel, type TestHotel } from '@pms/domain/testing';
import {
  ariRequests,
  connectionOf,
  day,
  goLive,
  guestBooks,
  liveHotel,
  liveVilla,
  openAlerts,
  reservationFor,
  shownEverywhere,
  shownOn,
  startStack,
  waitFor,
  type ConnectedProperty,
  type Stack,
} from './harness';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

const std = (hotel: TestHotel) => hotel.standard.roomType.id;
const dlx = (hotel: TestHotel) => hotel.deluxe.roomType.id;

const bookDirect = async (hotel: TestHotel, checkIn: string, checkOut: string) => {
  const res = await stack.admin.post('/reservations', {
    propertyId: hotel.property.id,
    source: 'phone',
    guest: { firstName: 'Kabir', lastName: 'Sethi' },
    rooms: [
      {
        roomTypeId: std(hotel),
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn,
        checkOut,
        adults: 2,
      },
    ],
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string };
};

describe('going live through the API', () => {
  it('sets the property up in the channel manager and restates the horizon in two calls', async () => {
    const hotel = await createTestHotel(stack.api.t.db, stack.api.org, {
      standardRooms: 4,
      deluxeRooms: 2,
    });
    // Something already sold before the connection exists.
    await bookDirect(hotel, day(5), day(7));
    const before = stack.sim.state.requestLog.length;
    const live = await goLive(stack, hotel.property.id);

    // The property, its room types and its rate plans now exist on the other side, mapped one to one.
    const sim = stack.sim.state;
    expect(sim.properties.get(live.externalPropertyId)).toMatchObject({
      title: hotel.property.name,
      currency: 'INR',
    });
    expect(sim.roomTypes.get(live.rooms[std(hotel)]!)).toMatchObject({
      title: 'Standard Room',
      countOfRooms: 4,
    });
    expect(sim.ratePlans.get(live.rates[hotel.standard.ratePlan.id]!)).toMatchObject({
      title: 'Standard Room flexible',
    });

    // The channel manager asks for a full sync to be exactly one availability and one rates call.
    const ari = ariRequests(stack, before);
    expect(ari.map((r) => r.path).sort()).toEqual(['/availability', '/restrictions']);
    expect(ari.every((r) => r.status === 200)).toBe(true);

    // 500 days, and every site shows it.
    expect(shownEverywhere(stack, live, std(hotel), day(0))).toEqual([4, 4, 4, 4, 4]);
    expect(shownEverywhere(stack, live, std(hotel), day(5))).toEqual([3, 3, 3, 3, 3]);
    expect(shownEverywhere(stack, live, std(hotel), day(499))).toEqual([4, 4, 4, 4, 4]);
    expect(shownOn(stack, live, 'BDC', std(hotel), day(500))).toBeNull();
    expect(sim.restrictionOn(live.rates[hotel.standard.ratePlan.id]!, day(30))).toMatchObject({
      rate: 450_000,
      minStayArrival: 1,
      stopSell: false,
    });

    // One account-wide webhook, switched on, carrying the shared secret.
    const [webhook] = [...sim.webhooks.values()];
    expect(webhook).toMatchObject({
      isActive: true,
      isGlobal: true,
      callbackUrl: `${stack.apiUrl}/webhooks/channex`,
    });
    expect(webhook!.eventMask.split(';')).toContain('booking');
    expect(webhook!.eventMask.split(';')).not.toContain('ari');

    const connection = await connectionOf(stack, live.connectionId);
    expect(connection).toMatchObject({
      status: 'active',
      mappedRoomTypes: 2,
      mappedRatePlans: 2,
      pendingChanges: 0,
    });
  });

  it('is repeatable: setting up again reuses what exists', async () => {
    const { hotel, live } = await liveHotel(stack);
    const roomTypes = stack.sim.state.roomTypes.size;
    const res = await stack.admin.post(
      `/channels/connections/${live.connectionId}/channex/provision`,
    );
    expect(res.json()).toMatchObject({
      propertyCreated: false,
      roomTypesCreated: 0,
      ratePlansCreated: 0,
    });
    expect(stack.sim.state.roomTypes.size).toBe(roomTypes);
    expect(hotel.property.id).toBe(live.propertyId);
  });

  it('reports the sync worker as running', async () => {
    const res = await stack.admin.get('/channels/status');
    expect(res.json()).toMatchObject({
      channex: { configured: true, webhookSecured: true },
      worker: { alive: true },
    });
  });
});

describe('a change in the PMS reaches every site', () => {
  let hotel: TestHotel;
  let live: ConnectedProperty;
  beforeAll(async () => {
    ({ hotel, live } = await liveHotel(stack, { standardRooms: 3, deluxeRooms: 2 }));
  });

  it('closes a sold room everywhere within seconds, and reopens it on cancellation', async () => {
    const started = Date.now();
    const reservation = await bookDirect(hotel, day(10), day(12));
    await waitFor('all sites to show one room fewer', () =>
      shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 2),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(shownEverywhere(stack, live, std(hotel), day(11))).toEqual([2, 2, 2, 2, 2]);
    expect(shownEverywhere(stack, live, std(hotel), day(12))).toEqual([3, 3, 3, 3, 3]);

    await stack.admin.post(`/reservations/${reservation.id}/cancel`, { reason: 'Guest called' });
    await waitFor('the room to be back on sale', () =>
      shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 3),
    );
  });

  it('closes blocked dates everywhere', async () => {
    const res = await stack.admin.post('/blocks', {
      propertyId: hotel.property.id,
      roomTypeId: dlx(hotel),
      quantity: 2,
      kind: 'maintenance',
      startDate: day(20),
      endDate: day(22),
      reason: 'Deep cleaning',
    });
    expect(res.statusCode).toBe(201);
    await waitFor('the block to reach every site', () =>
      shownEverywhere(stack, live, dlx(hotel), day(20)).every((v) => v === 0),
    );
    expect(shownEverywhere(stack, live, dlx(hotel), day(22))).toEqual([2, 2, 2, 2, 2]);

    await stack.admin.post(`/blocks/${(res.json() as { id: string }).id}/release`);
    await waitFor('the dates to reopen', () =>
      shownEverywhere(stack, live, dlx(hotel), day(20)).every((v) => v === 2),
    );
  });

  it('sends rate and restriction changes', async () => {
    const res = await stack.admin.post(`/properties/${hotel.property.id}/rates`, {
      ratePlanId: hotel.standard.ratePlan.id,
      from: day(40),
      to: day(43),
      change: { rate: 610_000, minStayArrival: 2, closedToArrival: true },
    });
    expect(res.statusCode).toBe(200);
    const external = live.rates[hotel.standard.ratePlan.id]!;
    await waitFor(
      'the new rate at the channel manager',
      () => stack.sim.state.restrictionOn(external, day(41)).rate === 610_000,
    );
    expect(stack.sim.state.restrictionOn(external, day(40))).toMatchObject({
      rate: 610_000,
      minStayArrival: 2,
      closedToArrival: true,
    });
    expect(stack.sim.state.restrictionOn(external, day(43)).rate).toBe(450_000);
  });
});

describe('a booking on a site reaches the PMS and closes the other sites', () => {
  let hotel: TestHotel;
  let live: ConnectedProperty;
  beforeAll(async () => {
    ({ hotel, live } = await liveHotel(stack, { standardRooms: 2, deluxeRooms: 1 }));
  });

  it('records the booking, acknowledges it, and keeps guest details the channel manager then withholds', async () => {
    const started = Date.now();
    const booking = guestBooks(
      stack,
      live,
      'BDC',
      {
        roomTypeId: std(hotel),
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(10),
        checkOut: day(13),
      },
      {
        guest: {
          name: 'Lena',
          surname: 'Fischer',
          mail: 'lena.fischer@guest.booking.example',
          phone: '+49 171 5550101',
        },
      },
    );
    const reservation = await waitFor('the reservation in the PMS', () =>
      reservationFor(stack, booking.code),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(reservation).toMatchObject({
      status: 'confirmed',
      channelCode: 'BDC',
      guestName: 'Lena Fischer',
      checkIn: day(10),
      checkOut: day(13),
      totalAmount: 3 * 450_000,
      overbooked: false,
    });

    // Acknowledged, so the channel manager stops re-sending it.
    await waitFor('the acknowledgement', () => stack.sim.state.feed().length === 0);
    // Once acknowledged the channel manager no longer gives out the guest's contact details...
    const revisionId = stack.sim.state.bookings.get(booking.id)!.revisionIds[0]!;
    const masked = stack.sim.state.revisionForApi(stack.sim.state.revisions.get(revisionId)!);
    expect((masked.customer as { mail: string | null }).mail).toBeNull();
    // ...but the PMS stored them before acknowledging.
    const [row] = await stack.api.t.db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservation.id));
    const [guest] = await stack.api.t.db.select().from(guests).where(eq(guests.id, row!.guestId!));
    expect(guest).toMatchObject({
      email: 'lena.fischer@guest.booking.example',
      phone: '+491715550101',
    });

    // No card data is kept, masked or otherwise.
    const [stored] = await stack.api.t.db
      .select()
      .from(bookingRevisions)
      .where(eq(bookingRevisions.externalRevisionId, revisionId));
    expect(JSON.stringify(stored!.raw)).not.toContain('411111');
    expect(stored!.raw).toMatchObject({ guarantee: { card_type: 'VI', last4: '1111' } });

    // The PMS restated the nights, and every site agrees.
    await waitFor('the other sites to close the room', () =>
      shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 1),
    );
    expect(shownEverywhere(stack, live, std(hotel), day(12))).toEqual([1, 1, 1, 1, 1]);
    expect(shownEverywhere(stack, live, std(hotel), day(13))).toEqual([2, 2, 2, 2, 2]);
  });

  it('moves the stay when the guest changes dates on the site, and frees it on cancellation', async () => {
    const booking = guestBooks(stack, live, 'EXP', {
      roomTypeId: dlx(hotel),
      ratePlanId: hotel.deluxe.ratePlan.id,
      checkIn: day(30),
      checkOut: day(32),
    });
    const created = await waitFor('the reservation', () => reservationFor(stack, booking.code));
    await waitFor('the room to close', () =>
      shownEverywhere(stack, live, dlx(hotel), day(30)).every((v) => v === 0),
    );

    stack.sim.state.modifyBooking(booking.id, { rooms: [{ checkIn: day(33), checkOut: day(35) }] });
    await waitFor(
      'the stay to move',
      async () => (await reservationFor(stack, booking.code))?.checkIn === day(33),
    );
    // The channel manager leaves availability alone on a change; it is the PMS that puts it right.
    await waitFor('the old nights to reopen and the new ones to close', () => {
      const old = shownEverywhere(stack, live, dlx(hotel), day(30));
      const now = shownEverywhere(stack, live, dlx(hotel), day(33));
      return old.every((v) => v === 1) && now.every((v) => v === 0);
    });

    stack.sim.state.cancelBooking(booking.id);
    await waitFor(
      'the cancellation',
      async () => (await reservationFor(stack, booking.code))?.status === 'cancelled',
    );
    await waitFor('the nights to reopen', () =>
      shownEverywhere(stack, live, dlx(hotel), day(33)).every((v) => v === 1),
    );
    expect((await reservationFor(stack, booking.code))!.id).toBe(created.id);
    expect(stack.sim.state.feed()).toHaveLength(0);
  });

  it('records both bookings when two sites sell the last room at once, and raises the alarm', async () => {
    // One standard room is left on day 10 to 13 (see the first test). Use fresh nights: two left.
    const first = guestBooks(stack, live, 'ABB', {
      roomTypeId: std(hotel),
      checkIn: day(50),
      checkOut: day(51),
    });
    const second = guestBooks(stack, live, 'AGO', {
      roomTypeId: std(hotel),
      checkIn: day(50),
      checkOut: day(51),
    });
    // A third site sells it again before the update reaches it.
    const third = guestBooks(
      stack,
      live,
      'MMT',
      { roomTypeId: std(hotel), checkIn: day(50), checkOut: day(51) },
      { force: true },
    );

    const all = await waitFor('all three reservations', async () => {
      const found = await Promise.all(
        [first, second, third].map((b) => reservationFor(stack, b.code)),
      );
      return found.every(Boolean) ? found : null;
    });
    expect(all.map((r) => r!.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(all.filter((r) => r!.overbooked)).toHaveLength(1);
    const alerts = await waitFor('the overbooking alert', async () => {
      const open = await openAlerts(stack, 'overbooking');
      return open.length > 0 ? open : null;
    });
    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    // Nothing more is offered for that night anywhere.
    await waitFor('the night to be closed everywhere', () =>
      shownEverywhere(stack, live, std(hotel), day(50)).every((v) => v === 0),
    );
  });
});

describe('villas', () => {
  it('closes the villa on every site the moment it is booked on one', async () => {
    const { villa, live } = await liveVilla(stack);
    const whole = villa.whole.roomType.id;
    expect(shownEverywhere(stack, live, whole, day(15))).toEqual([1, 1, 1, 1, 1]);

    const booking = guestBooks(stack, live, 'ABB', {
      roomTypeId: whole,
      ratePlanId: villa.whole.ratePlan.id,
      checkIn: day(15),
      checkOut: day(19),
    });
    const reservation = await waitFor('the villa reservation', () =>
      reservationFor(stack, booking.code),
    );
    expect(reservation).toMatchObject({ channelCode: 'ABB', totalAmount: 4 * 2_500_000 });
    await waitFor('every site to show the villa as taken', () =>
      [15, 16, 17, 18].every((d) =>
        shownEverywhere(stack, live, whole, day(d)).every((v) => v === 0),
      ),
    );
    expect(shownEverywhere(stack, live, whole, day(19))).toEqual([1, 1, 1, 1, 1]);

    // An owner block does the same.
    const block = await stack.admin.post('/blocks', {
      propertyId: villa.property.id,
      unitId: villa.whole.units[0]!.id,
      kind: 'owner_stay',
      startDate: day(25),
      endDate: day(28),
    });
    expect(block.statusCode).toBe(201);
    await waitFor('the owner stay to close the villa', () =>
      shownEverywhere(stack, live, whole, day(26)).every((v) => v === 0),
    );
  });
});

describe('bookings that need attention', () => {
  it('holds a booking for an unmapped room, and places it once the room is mapped', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 2, deluxeRooms: 1 });
    // A room that exists at the channel manager but that the PMS knows nothing about.
    const suite = stack.sim.state.createRoomType({
      propertyId: live.externalPropertyId,
      title: 'Garden Suite',
      countOfRooms: 1,
      occAdults: 2,
      occChildren: 0,
      occInfants: 0,
      defaultOccupancy: 2,
    });
    stack.sim.state.availability.get(suite.id)!.set(day(10), 1);
    stack.sim.state.distribute(suite.id, [day(10)]);
    const booking = guestBooks(stack, live, 'BDC', {
      roomTypeId: suite.id,
      checkIn: day(10),
      checkOut: day(11),
    });

    const alerts = await waitFor('the unmapped-booking alert', async () => {
      const open = await openAlerts(stack, 'unmapped_booking');
      return open.length > 0 ? open : null;
    });
    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    expect(await reservationFor(stack, booking.code)).toBeUndefined();
    // It was still acknowledged: the PMS has it and owns the problem.
    await waitFor(
      'the acknowledgement',
      () => stack.sim.state.feed(live.externalPropertyId).length === 0,
    );

    const revisions = (
      await stack.admin.get(`/channels/revisions?connectionId=${live.connectionId}&status=unmapped`)
    ).json() as {
      revisions: { id: string }[];
    };
    expect(revisions.revisions).toHaveLength(1);

    // Staff map the suite to the deluxe room type and re-apply.
    const mappings = (
      await stack.admin.get(`/channels/connections/${live.connectionId}/mappings`)
    ).json() as {
      roomTypes: { roomTypeId: string; externalId: string }[];
    };
    const put = await stack.admin.put(`/channels/connections/${live.connectionId}/mappings`, {
      roomTypes: [
        ...mappings.roomTypes.filter((m) => m.roomTypeId !== dlx(hotel)),
        { roomTypeId: dlx(hotel), externalId: suite.id },
      ],
    });
    expect(put.statusCode).toBe(200);
    const applied = await stack.admin.post(
      `/channels/revisions/${revisions.revisions[0]!.id}/reprocess`,
    );
    expect(applied.json()).toMatchObject({ status: 'applied' });
    expect(await reservationFor(stack, booking.code)).toMatchObject({
      status: 'confirmed',
      checkIn: day(10),
    });
    expect(await openAlerts(stack, 'unmapped_booking')).toHaveLength(0);
  });
});

describe('the sync monitor', () => {
  it('shows what arrived and what was sent', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 2 });
    const booking = guestBooks(stack, live, 'BDC', {
      roomTypeId: std(hotel),
      checkIn: day(10),
      checkOut: day(11),
    });
    await waitFor('the reservation', () => reservationFor(stack, booking.code));
    await waitFor('the push', () =>
      shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 1),
    );
    await waitFor(
      'the work list to empty',
      async () => (await connectionOf(stack, live.connectionId)).pendingChanges === 0,
    );

    const revisions = (
      await stack.admin.get(`/channels/revisions?connectionId=${live.connectionId}`)
    ).json() as {
      revisions: Record<string, unknown>[];
    };
    expect(revisions.revisions[0]).toMatchObject({
      kind: 'new',
      status: 'applied',
      acknowledged: true,
      channelCode: 'BDC',
      receivedVia: 'webhook',
      checkIn: day(10),
    });
    const detail = (await stack.admin.get(`/channels/connections/${live.connectionId}`)).json() as {
      connection: Record<string, unknown>;
      log: { direction: string; operation: string; status: string }[];
    };
    expect(detail.connection).toMatchObject({
      status: 'active',
      lastError: null,
      consecutiveFailures: 0,
    });
    expect(detail.connection.lastPushAt).not.toBeNull();
    expect(
      detail.log.some(
        (l) => l.direction === 'in' && l.operation === 'booking.new' && l.status === 'ok',
      ),
    ).toBe(true);
    expect(
      detail.log.some(
        (l) => l.direction === 'out' && l.operation === 'ari.push' && l.status === 'ok',
      ),
    ).toBe(true);
    expect(detail.log.some((l) => l.operation === 'ari.full_sync')).toBe(true);
    // Secrets never leave the server.
    expect(JSON.stringify(detail)).not.toContain('secretsEnc');
  });

  it('is only visible to people with the permission, for their own properties', async () => {
    const { live } = await liveHotel(stack);
    const anonymous = stack.api.anonymous();
    expect((await anonymous.get('/channels/connections')).statusCode).toBe(401);
    expect((await anonymous.get(`/channels/connections/${live.connectionId}`)).statusCode).toBe(
      401,
    );
    expect(
      (await anonymous.post(`/channels/connections/${live.connectionId}/full-sync`)).statusCode,
    ).toBe(401);
    // Someone who may only read cannot change a connection.
    const reader = await stack.api.t.db.transaction(async () => {
      const { createTestUser } = await import('@pms/domain/testing');
      return createTestUser(stack.api.t.db, stack.api.org.orgId, { role: 'read_only' });
    });
    const client = await stack.api.login(reader.email);
    expect((await client.get(`/channels/connections/${live.connectionId}`)).statusCode).toBe(200);
    expect(
      (await client.post(`/channels/connections/${live.connectionId}/full-sync`)).statusCode,
    ).toBe(403);
    expect(
      (await client.patch(`/channels/connections/${live.connectionId}`, { status: 'paused' }))
        .statusCode,
    ).toBe(403);
    expect((await client.post('/channels/channex/webhook')).statusCode).toBe(403);
  });
});
