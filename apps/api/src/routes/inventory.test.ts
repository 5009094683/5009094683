import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestHotel,
  createTestUser,
  createTestVilla,
  type TestHotel,
  type TestVilla,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let admin: TestClient;
let hotel: TestHotel;
let villa: TestVilla;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await ctx.admin();
  hotel = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 2, deluxeRooms: 1 });
  villa = await createTestVilla(ctx.t.db, ctx.org, { name: 'Casa Mar' });
});
afterAll(async () => {
  await ctx.close();
});

const stdRoom = (checkIn: string, checkOut: string) => ({
  roomTypeId: hotel.standard.roomType.id,
  ratePlanId: hotel.standard.ratePlan.id,
  checkIn,
  checkOut,
  adults: 2,
});

describe('property setup over the API', () => {
  it('creates a property with room types, units and rate plans, then reads it back', async () => {
    const created = await admin.post('/properties', {
      code: 'goa1',
      name: 'Sea Breeze Candolim',
      kind: 'hotel',
      stateCode: '30',
      gstin: '30ABCDE1234F1Z5',
    });
    expect(created.statusCode).toBe(201);
    const propertyId = created.json().id;
    expect(created.json().code).toBe('GOA1');

    const type = await admin.post(`/properties/${propertyId}/room-types`, {
      code: 'SEA',
      name: 'Sea View Room',
    });
    expect(type.statusCode).toBe(201);
    const roomTypeId = type.json().id;
    for (const name of ['201', '202']) {
      expect(
        (await admin.post(`/properties/${propertyId}/units`, { roomTypeId, name })).statusCode,
      ).toBe(201);
    }
    const plan = await admin.post(`/properties/${propertyId}/rate-plans`, {
      roomTypeId,
      code: 'SEA-BAR',
      name: 'Flexible',
      baseRate: 800_000,
    });
    expect(plan.statusCode).toBe(201);

    // A plan that follows another needs no base rate of its own; any other plan does.
    const follower = { roomTypeId, code: 'SEA-NRF', name: 'Non-refundable' };
    const noRate = await admin.post(`/properties/${propertyId}/rate-plans`, follower);
    expect(noRate.statusCode).toBe(400);
    expect(noRate.json().error.message).toMatch(/base rate/);
    const derived = await admin.post(`/properties/${propertyId}/rate-plans`, {
      ...follower,
      parentRatePlanId: plan.json().id,
      derivedPercentBp: -1000,
    });
    expect(derived.statusCode).toBe(201);
    const quoted = (
      await admin.get(
        `/properties/${propertyId}/rates?from=2027-01-01&to=2027-01-02&ratePlanIds=${derived.json().id}`,
      )
    ).json();
    expect(quoted.days[0].rate).toBe(720_000);

    const config = (await admin.get(`/properties/${propertyId}`)).json();
    expect(config.property.name).toBe('Sea Breeze Candolim');
    expect(config.roomTypes[0].units.map((u: { name: string }) => u.name)).toEqual(['201', '202']);
    expect(config.roomTypes[0].ratePlans[0]).toMatchObject({
      code: 'SEA-BAR',
      isDefault: true,
      currency: 'INR',
    });

    const availability = (
      await admin.get(`/properties/${propertyId}/availability?from=2027-01-01&to=2027-01-03`)
    ).json();
    expect(availability.days.map((d: { available: number }) => d.available)).toEqual([2, 2]);

    // Duplicate codes and malformed tax numbers are refused with a clear reason.
    expect(
      (await admin.post('/properties', { code: 'GOA1', name: 'Dup', kind: 'hotel' })).statusCode,
    ).toBe(409);
    const badGst = await admin.post('/properties', {
      code: 'GOA2',
      name: 'Bad',
      kind: 'hotel',
      gstin: 'NOTAGSTIN',
    });
    expect(badGst.statusCode).toBe(400);
    expect(badGst.json().error.message).toMatch(/GSTIN/);
  });

  it('sets rates in bulk and quotes a stay', async () => {
    const base = `/properties/${hotel.property.id}`;
    const set = await admin.post(`${base}/rates`, {
      ratePlanId: hotel.standard.ratePlan.id,
      from: '2027-02-01',
      to: '2027-02-08',
      daysOfWeek: [5, 6],
      change: { rate: 600_000, minStayArrival: 2 },
    });
    expect(set.json()).toEqual({ daysChanged: 2 });

    const calendar = (
      await admin.get(
        `${base}/rates?from=2027-02-04&to=2027-02-07&ratePlanIds=${hotel.standard.ratePlan.id}`,
      )
    ).json();
    expect(calendar.days.map((d: { rate: number }) => d.rate)).toEqual([450_000, 600_000, 600_000]);

    const quote = (
      await admin.post(`${base}/quote`, {
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: '2027-02-05',
        checkOut: '2027-02-06',
        adults: 2,
      })
    ).json();
    expect(quote.total).toBe(600_000);
    expect(quote.violations[0]).toMatchObject({ code: 'min_stay', date: '2027-02-05' });

    const invalid = await admin.get(`${base}/rates?from=2027-02-30&to=2027-03-02`);
    expect(invalid.statusCode).toBe(400);
  });

  it('keeps every setting it is sent, and says so when one cannot be kept', async () => {
    const base = `/properties/${hotel.property.id}`;
    const settings = {
      knowledge: 'Breakfast is from 7:30 to 10:30. Parking is behind the building.',
      pricingAutopilotRoomTypes: [hotel.standard.roomType.id],
      pricingMaxChangePercent: 30,
      pricingRounding: 10_000,
      pricingEvents: [
        { from: '2027-12-24', to: '2027-12-31', name: 'Christmas', upliftPercent: 30 },
      ],
    };
    const saved = await admin.patch(base, { settings });
    expect(saved.statusCode).toBe(200);
    // What was sent is what is kept: nothing is dropped on the way.
    expect(saved.json().settings).toMatchObject(settings);
    expect((await admin.get(base)).json().property.settings).toMatchObject(settings);

    // Settings merge key by key: changing one leaves the others alone.
    const one = await admin.patch(base, { settings: { pricingMaxChangePercent: 25 } });
    expect(one.json().settings).toMatchObject({ ...settings, pricingMaxChangePercent: 25 });

    const backwards = await admin.patch(base, {
      settings: { pricingEvents: [{ from: '2027-12-31', to: '2027-12-24', name: 'Backwards' }] },
    });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().error.message).toBe('"Backwards" ends before it begins');
    // A room type of another property cannot be put on autopilot here.
    const elsewhere = await createTestHotel(ctx.t.db, ctx.org);
    const foreign = await admin.patch(base, {
      settings: { pricingAutopilotRoomTypes: [elsewhere.standard.roomType.id] },
    });
    expect(foreign.statusCode).toBe(400);
    // A setting nobody has heard of is refused, not silently forgotten.
    const unknown = await admin.patch(base, { settings: { pricingMagic: true } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain('pricingMagic');

    // What the booking site could not use is refused rather than saved and ignored.
    const colour = await admin.patch(base, { settings: { brandColor: 'teal' } });
    expect(colour.statusCode).toBe(400);
    expect(colour.json().error.message).toBe(
      'settings.brandColor: Give the colour as a code like #1f6f5c',
    );
    const photo = await admin.patch(base, { settings: { photos: ['pool.jpg'] } });
    expect(photo.statusCode).toBe(400);
    expect(photo.json().error.message).toMatch(/starting with https:\/\//);
    const look = await admin.patch(base, {
      settings: {
        brandColor: '#1F6F5C',
        photos: ['https://images.example.com/pool.jpg'],
        bookingEngineEnabled: true,
        invoicePrefix: 'SB',
        childMaxAge: 12,
      },
    });
    expect(look.statusCode).toBe(200);
    // The property's own page on the booking site, for the back office to link to.
    expect((await admin.get(base)).json().bookingSiteUrl).toBe(
      `http://localhost:3001/${hotel.property.code.toLowerCase()}`,
    );
    // A colour is cleared with nothing; a value that has no empty form is taken away with null.
    const cleared = await admin.patch(base, {
      settings: {
        brandColor: '',
        invoicePrefix: null,
        childMaxAge: null,
        bookingEngineEnabled: false,
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings).toMatchObject({ brandColor: '', bookingEngineEnabled: false });
    expect(cleared.json().settings).not.toHaveProperty('invoicePrefix');
    expect(cleared.json().settings).not.toHaveProperty('childMaxAge');
    expect((await admin.get(base)).json().bookingSiteUrl).toBeNull();

    // Food is taxed at 5%, or at 18% where the hotel is "specified premises": the rule
    // follows the setting, unless the accountant has since set the rule by hand.
    const foodRate = async () =>
      (
        (await admin.get(`${base}/tax-rules`)).json().rules as {
          category: string;
          slabs: { rateBp: number }[];
        }[]
      ).find((rule) => rule.category === 'food')!.slabs[0]!.rateBp;
    expect(await foodRate()).toBe(500);
    await admin.patch(base, { settings: { specifiedPremises: true } });
    expect(await foodRate()).toBe(1800);
    await admin.patch(base, { settings: { specifiedPremises: false } });
    expect(await foodRate()).toBe(500);
    const byHand = await admin.put(`${base}/tax-rules/food`, {
      name: 'GST on food and beverage',
      serviceCode: '996331',
      slabs: [{ upTo: null, rateBp: 1200 }],
      components: [
        { code: 'CGST', shareBp: 5000 },
        { code: 'SGST', shareBp: 5000 },
      ],
    });
    expect(byHand.statusCode, byHand.body).toBe(200);
    await admin.patch(base, { settings: { specifiedPremises: true } });
    expect(await foodRate()).toBe(1200);
  });
});

describe('reservations over the API', () => {
  it('creates, changes and cancels a reservation', async () => {
    const created = await admin.post('/reservations', {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: { firstName: 'Meera', lastName: 'Nair', email: 'meera@example.com' },
      rooms: [stdRoom('2027-03-10', '2027-03-12')],
      notes: 'Anniversary',
    });
    expect(created.statusCode).toBe(201);
    const reservation = created.json();
    expect(reservation).toMatchObject({
      status: 'confirmed',
      guestName: 'Meera Nair',
      totalAmount: 900_000,
    });
    // The organisation id is internal and never leaves the API.
    expect(reservation.orgId).toBeUndefined();

    const fetched = await admin.get(`/reservations/${reservation.id}`);
    expect(fetched.json().code).toBe(reservation.code);

    const moved = await admin.patch(
      `/reservations/${reservation.id}/rooms/${reservation.rooms[0].id}`,
      {
        checkOut: '2027-03-13',
        expectedVersion: reservation.version,
      },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.json().reservation.checkOut).toBe('2027-03-13');

    const stale = await admin.patch(`/reservations/${reservation.id}`, {
      notes: 'Changed from a stale screen',
      expectedVersion: reservation.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_version');

    const search = (
      await admin.get(`/reservations?search=nair&propertyIds=${hotel.property.id}`)
    ).json();
    expect(search.reservations.map((x: { id: string }) => x.id)).toEqual([reservation.id]);

    const cancelled = await admin.post(`/reservations/${reservation.id}/cancel`, {
      reason: 'Plans changed',
    });
    expect(cancelled.json().status).toBe('cancelled');
  });

  it('holds rooms until a time the caller chooses, moves it, and confirms', async () => {
    const hold = {
      propertyId: hotel.property.id,
      status: 'tentative',
      source: 'phone',
      guest: { firstName: 'Option', lastName: 'Holder' },
      rooms: [stdRoom('2027-06-10', '2027-06-12')],
    };
    const until = new Date(Date.now() + 30 * 3_600_000).toISOString();
    const held = await admin.post('/reservations', { ...hold, holdUntil: until });
    expect(held.statusCode).toBe(201);
    expect(held.json()).toMatchObject({ status: 'tentative', holdExpiresAt: until });

    const later = new Date(Date.now() + 60 * 3_600_000).toISOString();
    const moved = await admin.patch(`/reservations/${held.json().id}`, { holdUntil: later });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().holdExpiresAt).toBe(later);

    // Never past the day of arrival, never in the past, and never without a time zone.
    const tooLate = await admin.patch(`/reservations/${held.json().id}`, {
      holdUntil: '2027-06-11T09:00:00+05:30',
    });
    expect(tooLate.statusCode).toBe(400);
    expect(tooLate.json().error.message).toContain('day of arrival at the latest');
    for (const holdUntil of ['2020-01-01T00:00:00Z', '2027-06-09T12:00', 'tomorrow']) {
      expect((await admin.post('/reservations', { ...hold, holdUntil })).statusCode).toBe(400);
    }
    // A confirmed reservation has no hold to give an end to.
    const confirmedWithHold = await admin.post('/reservations', {
      ...hold,
      status: 'confirmed',
      holdUntil: until,
    });
    expect(confirmedWithHold.statusCode).toBe(400);

    const confirmed = await admin.post(`/reservations/${held.json().id}/confirm`, {});
    expect(confirmed.json()).toMatchObject({ status: 'confirmed', holdExpiresAt: null });
    const afterwards = await admin.patch(`/reservations/${held.json().id}`, { holdUntil: later });
    expect(afterwards.statusCode).toBe(409);
  });

  it('answers 409 with the sold-out nights when there is no room', async () => {
    for (let i = 0; i < 2; i++) {
      const ok = await admin.post('/reservations', {
        propertyId: hotel.property.id,
        guest: { firstName: `Guest${i}` },
        rooms: [stdRoom('2027-04-01', '2027-04-03')],
      });
      expect(ok.statusCode).toBe(201);
    }
    const full = await admin.post('/reservations', {
      propertyId: hotel.property.id,
      guest: { firstName: 'Late' },
      rooms: [stdRoom('2027-04-02', '2027-04-04')],
    });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatchObject({
      code: 'no_availability',
      message: 'No availability on 2027-04-02',
    });
    expect(full.json().error.details.nights).toEqual([
      { roomTypeId: hotel.standard.roomType.id, date: '2027-04-02', overbooked: 1 },
    ]);
  });

  it('shows stays and blocks on the calendar and refuses a block over a booking', async () => {
    const booking = await admin.post('/reservations', {
      propertyId: villa.property.id,
      guest: { firstName: 'Villa', lastName: 'Guest' },
      rooms: [
        {
          roomTypeId: villa.whole.roomType.id,
          ratePlanId: villa.whole.ratePlan.id,
          checkIn: '2027-05-10',
          checkOut: '2027-05-14',
          adults: 4,
        },
      ],
    });
    expect(booking.statusCode).toBe(201);

    const clash = await admin.post('/blocks', {
      propertyId: villa.property.id,
      unitId: villa.whole.units[0]!.id,
      kind: 'owner_stay',
      startDate: '2027-05-13',
      endDate: '2027-05-16',
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('unit_occupied');
    expect(clash.json().error.message).toContain(booking.json().code);

    const block = await admin.post('/blocks', {
      propertyId: villa.property.id,
      unitId: villa.whole.units[0]!.id,
      kind: 'owner_stay',
      startDate: '2027-05-14',
      endDate: '2027-05-16',
      reason: 'Owner weekend',
    });
    expect(block.statusCode).toBe(201);

    const calendar = (
      await admin.get(`/calendar?from=2027-05-09&to=2027-05-17&propertyIds=${villa.property.id}`)
    ).json();
    const property = calendar.properties[0];
    expect(property.stays[0]).toMatchObject({
      checkIn: '2027-05-10',
      checkOut: '2027-05-14',
      unitId: villa.whole.units[0]!.id,
    });
    expect(property.blocks[0]).toMatchObject({ kind: 'owner_stay', reason: 'Owner weekend' });
    expect(property.roomTypes[0].days.map((d: { available: number }) => d.available)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 1,
    ]);

    const released = await admin.post(`/blocks/${block.json().id}/release`);
    expect(released.json().releasedAt).not.toBeNull();
  });
});

describe('permissions on inventory routes', () => {
  it('confines a property-scoped user to their property', async () => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role: 'front_desk',
      propertyId: hotel.property.id,
    });
    const staff = await ctx.login(user.email);

    const list = (await staff.get('/properties')).json();
    expect(list.properties.map((p: { id: string }) => p.id)).toEqual([hotel.property.id]);

    // Their own property works.
    const ok = await staff.post('/reservations', {
      propertyId: hotel.property.id,
      guest: { firstName: 'Own' },
      rooms: [stdRoom('2027-06-01', '2027-06-02')],
    });
    expect(ok.statusCode).toBe(201);

    // Another property of the same organisation is off limits, for reads and writes alike.
    expect((await staff.get(`/properties/${villa.property.id}`)).statusCode).toBe(403);
    expect(
      (await staff.get(`/calendar?from=2027-06-01&to=2027-06-05&propertyIds=${villa.property.id}`))
        .statusCode,
    ).toBe(403);
    const other = await staff.post('/reservations', {
      propertyId: villa.property.id,
      guest: { firstName: 'Other' },
      rooms: [
        {
          roomTypeId: villa.whole.roomType.id,
          checkIn: '2027-06-01',
          checkOut: '2027-06-02',
          adults: 2,
        },
      ],
    });
    expect(other.statusCode).toBe(403);

    // Without naming properties, lists show only what they may see.
    const calendar = (await staff.get('/calendar?from=2027-06-01&to=2027-06-05')).json();
    expect(calendar.properties.map((p: { id: string }) => p.id)).toEqual([hotel.property.id]);
    const villaBooking = await admin.post('/reservations', {
      propertyId: villa.property.id,
      guest: { firstName: 'Hidden', lastName: 'FromStaff' },
      rooms: [
        {
          roomTypeId: villa.whole.roomType.id,
          checkIn: '2027-06-10',
          checkOut: '2027-06-12',
          adults: 2,
        },
      ],
    });
    expect((await staff.get(`/reservations/${villaBooking.json().id}`)).statusCode).toBe(403);
    const search = (await staff.get('/reservations?search=FromStaff')).json();
    expect(search.reservations).toEqual([]);

    // Front desk may not change rates or property setup, or add properties.
    expect(
      (
        await staff.post(`/properties/${hotel.property.id}/rates`, {
          ratePlanId: hotel.standard.ratePlan.id,
          from: '2027-06-01',
          to: '2027-06-02',
          change: { rate: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await staff.patch(`/properties/${hotel.property.id}`, { name: 'Renamed' })).statusCode,
    ).toBe(403);
    expect(
      (await staff.post('/properties', { code: 'NEW', name: 'New', kind: 'hotel' })).statusCode,
    ).toBe(403);
  });

  it('requires the override permission to book past capacity', async () => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role: 'front_desk',
      propertyId: hotel.property.id,
    });
    const staff = await ctx.login(user.email);
    const full = {
      propertyId: hotel.property.id,
      guest: { firstName: 'Overflow' },
      rooms: [stdRoom('2027-04-02', '2027-04-03')],
      force: true,
    };
    const refused = await staff.post('/reservations', full);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/past capacity/);

    const forced = await admin.post('/reservations', full);
    expect(forced.statusCode).toBe(201);
    expect(forced.json().overbooked).toBe(true);

    const alerts = (await admin.get('/alerts')).json().alerts;
    const alert = alerts.find((a: { entityId: string }) => a.entityId === forced.json().id);
    expect(alert).toMatchObject({ kind: 'overbooking', severity: 'critical', status: 'open' });
    // The property-scoped user sees alerts of their own property.
    expect(
      (await staff.get('/alerts')).json().alerts.some((a: { id: string }) => a.id === alert.id),
    ).toBe(true);
    expect((await admin.post(`/alerts/${alert.id}/acknowledge`)).json().status).toBe(
      'acknowledged',
    );
  });

  it('limits a property manager from creating properties but lets them manage their own', async () => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role: 'general_manager',
      propertyId: hotel.property.id,
    });
    const gm = await ctx.login(user.email);
    expect(
      (await gm.post('/properties', { code: 'GM1', name: 'Mine', kind: 'hotel' })).statusCode,
    ).toBe(403);
    expect(
      (await gm.patch(`/properties/${hotel.property.id}`, { phone: '+91 832 000 000' })).statusCode,
    ).toBe(200);
    expect(
      (await gm.patch(`/properties/${villa.property.id}`, { phone: '+91 832 000 000' })).statusCode,
    ).toBe(403);
  });
});

describe('live updates', () => {
  it('streams changes to open screens, only for properties the viewer can see', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (ctx.app.server.address() as AddressInfo).port;
    const scoped = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role: 'front_desk',
      propertyId: hotel.property.id,
    });
    const staff = await ctx.login(scoped.email);

    const open = async (client: TestClient) => {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/live`, {
        headers: { cookie: client.cookie! },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const events: {
        kind: string;
        propertyId: string | null;
        payload?: Record<string, unknown>;
      }[] = [];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const data = chunk.split('\n').find((l) => l.startsWith('data: '));
              if (data) events.push(JSON.parse(data.slice(6)));
            }
          }
        } catch {
          // aborted
        }
      })();
      return { events, close: () => controller.abort() };
    };
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for live events');
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    const anonymous = await fetch(`http://127.0.0.1:${port}/live`);
    expect(anonymous.status).toBe(401);

    const adminStream = await open(admin);
    const staffStream = await open(staff);
    await waitFor(() => ctx.app.live.connections === 2);

    const hotelBooking = await admin.post('/reservations', {
      propertyId: hotel.property.id,
      guest: { firstName: 'Live', lastName: 'Hotel' },
      rooms: [stdRoom('2027-08-01', '2027-08-02')],
    });
    const villaBooking = await admin.post('/reservations', {
      propertyId: villa.property.id,
      guest: { firstName: 'Live', lastName: 'Villa' },
      rooms: [
        {
          roomTypeId: villa.whole.roomType.id,
          checkIn: '2027-08-01',
          checkOut: '2027-08-02',
          adults: 2,
        },
      ],
    });
    expect([hotelBooking.statusCode, villaBooking.statusCode]).toEqual([201, 201]);

    const created = (events: { kind: string; payload?: Record<string, unknown> }[]) =>
      events.filter((e) => e.kind === 'reservation.created').map((e) => e.payload?.reservationId);
    await waitFor(
      () => created(adminStream.events).length === 2 && created(staffStream.events).length === 1,
    );
    expect(created(adminStream.events).sort()).toEqual(
      [hotelBooking.json().id, villaBooking.json().id].sort(),
    );
    // The property-scoped user is told about the hotel booking only.
    expect(created(staffStream.events)).toEqual([hotelBooking.json().id]);
    expect(staffStream.events.every((e) => e.propertyId === hotel.property.id)).toBe(true);
    // Availability changes arrive too, so calendar counts update without a reload.
    expect(adminStream.events.some((e) => e.kind === 'ari.availability')).toBe(true);

    adminStream.close();
    staffStream.close();
    await waitFor(() => ctx.app.live.connections === 0);
  });
});
