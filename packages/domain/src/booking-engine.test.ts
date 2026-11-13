import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alerts, folioLines, paymentOrders, promoCodes, reservations } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import {
  cancelGuestBooking,
  cancellationCharge,
  cancellationTerms,
  createBooking,
  createPaymentLink,
  getGuestBooking,
  getPublicProperty,
  listPublicProperties,
  paymentOrdersToCheck,
  searchStay,
  syncGuestPayments,
  syncPaymentOrder,
  type BookingRequest,
  type StaySearch,
} from './booking-engine';
import { addDays, todayIn } from './dates';
import { DomainError } from './errors';
import { reservationBalance } from './folios';
import { guestToken, readGuestToken } from './guest-links';
import { getAvailability } from './inventory';
import { MockGateway } from './payments/mock';
import { applyPromo, createPromo, deletePromo, promoProblem, type PromoRow } from './promos';
import { createRatePlan, updateProperty, updateRatePlan } from './properties';
import { setRates } from './rates';
import {
  cancelReservation,
  createReservation,
  expireHolds,
  loadReservation,
  reinstateReservation,
} from './reservations';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';

let t: TestDatabase;
let org: TestOrg;
let gateway: MockGateway;

const today = todayIn('Asia/Kolkata');
const day = (offset: number) => addDays(today, offset);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  gateway = new MockGateway(t.db, 'http://localhost:3000/api');
});
afterAll(async () => {
  await t.drop();
});

/** A hotel that takes bookings on the website. */
async function bookableHotel(
  settings: Parameters<typeof updateProperty>[3]['settings'] = {},
  rooms: { standardRooms?: number; deluxeRooms?: number } = {},
): Promise<TestHotel> {
  const hotel = await createTestHotel(t.db, org, rooms);
  await updateProperty(t.db, org.admin, hotel.property.id, {
    settings: { bookingEngineEnabled: true, ...settings },
  });
  return hotel;
}

const request = (
  hotel: TestHotel,
  from: number,
  to: number,
  extra: Partial<BookingRequest> = {},
): BookingRequest => ({
  propertyCode: hotel.property.code,
  checkIn: day(from),
  checkOut: day(to),
  rooms: [
    {
      roomTypeId: hotel.standard.roomType.id,
      ratePlanId: hotel.standard.ratePlan.id,
      adults: 2,
    },
  ],
  guest: { firstName: 'Meera', lastName: 'Nair', email: `meera.${from}.${to}@example.com` },
  acceptTerms: true,
  ...extra,
});

const available = async (hotel: TestHotel, from: number, to: number) =>
  (
    await getAvailability(t.db, {
      propertyId: hotel.property.id,
      range: { from: day(from), to: day(to) },
      roomTypeIds: [hotel.standard.roomType.id],
    })
  ).map((d) => d.available);

const standardOf = (hotel: TestHotel, search: StaySearch) =>
  search.offers.find((o) => o.roomType.id === hotel.standard.roomType.id)!;

const orderOf = async (reservationCode: string) => {
  const [row] = await t.db
    .select({ order: paymentOrders })
    .from(paymentOrders)
    .innerJoin(reservations, eq(reservations.id, paymentOrders.reservationId))
    .where(eq(reservations.code, reservationCode));
  return row!.order;
};

describe('promotional codes', () => {
  it('takes a percentage off every night and spreads a fixed amount across them', () => {
    expect(applyPromo({ kind: 'percent', value: 1000 }, [450_000, 500_000])).toEqual({
      nightly: [405_000, 450_000],
      discount: 95_000,
    });
    const fixed = applyPromo({ kind: 'amount', value: 100_000 }, [450_000, 450_000, 100_000]);
    expect(fixed.discount).toBe(100_000);
    expect(fixed.nightly.reduce((a, b) => a + b, 0)).toBe(900_000);
    // Never below zero, however large the code.
    expect(applyPromo({ kind: 'amount', value: 999_999_999 }, [450_000, 100])).toEqual({
      nightly: [0, 0],
      discount: 450_100,
    });
  });

  it('says in plain words why a code does not apply', () => {
    const promo = {
      active: true,
      propertyId: null,
      bookFrom: null,
      bookTo: new Date('2026-01-01T00:00:00Z'),
      maxUses: 2,
      usedCount: 0,
      minNights: 2,
      stayFrom: '2026-12-01',
      stayTo: '2026-12-31',
      ratePlanIds: null,
      kind: 'percent',
      value: 1000,
      currency: null,
    } as PromoRow;
    const context = {
      propertyId: 'p',
      ratePlanId: 'r',
      checkIn: '2026-12-10',
      checkOut: '2026-12-12',
      nights: 2,
      currency: 'INR',
      now: new Date('2025-12-01T00:00:00Z'),
    };
    expect(promoProblem(promo, context)).toBeNull();
    expect(promoProblem(null, context)).toMatch(/not valid/);
    expect(promoProblem(promo, { ...context, now: new Date('2026-02-01T00:00:00Z') })).toMatch(
      /expired/,
    );
    expect(promoProblem({ ...promo, usedCount: 2 }, context)).toMatch(/used/);
    expect(promoProblem(promo, { ...context, nights: 1 })).toMatch(/at least 2 nights/);
    expect(
      promoProblem(promo, { ...context, checkIn: '2026-12-30', checkOut: '2027-01-02' }),
    ).toMatch(/these dates/);
    expect(promoProblem({ ...promo, ratePlanIds: ['other'] }, context)).toMatch(/this rate/);
  });
});

describe('cancellation terms', () => {
  it('works out what cancelling costs on a given day', () => {
    const nights = [450_000, 500_000, 450_000];
    const flexible = { freeCancelDays: 3, penalty: 'first_night' as const };
    expect(cancellationTerms(flexible, '2026-12-10')).toMatchObject({
      freeUntil: '2026-12-07',
      text: 'Free cancellation until 7 December 2026. After that, the first night is charged.',
    });
    expect(cancellationCharge(flexible, '2026-12-10', nights, '2026-12-07')).toBe(0);
    expect(cancellationCharge(flexible, '2026-12-10', nights, '2026-12-08')).toBe(450_000);
    expect(
      cancellationCharge(
        { freeCancelDays: 1, penalty: 'percent', penaltyPercent: 50 },
        '2026-12-10',
        nights,
        '2026-12-10',
      ),
    ).toBe(700_000);
    expect(cancellationCharge({ nonRefundable: true }, '2026-12-10', nights, '2026-01-01')).toBe(
      1_400_000,
    );
    // No terms entered: free until the arrival day itself, then the first night.
    expect(cancellationCharge({}, '2026-12-10', nights, '2026-12-10')).toBe(0);
    expect(cancellationCharge(undefined, '2026-12-10', nights, '2026-12-11')).toBe(450_000);
  });
});

describe('guest links', () => {
  it('opens only the booking it was made for, and stops working when revoked', async () => {
    const hotel = await bookableHotel({ bookingPayment: 'none' });
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 30, 32));
    const claims = readGuestToken(booked.token)!;
    expect(claims.version).toBe(1);
    expect((await getGuestBooking(t.db, booked.token)).code).toBe(booked.code);

    // A token altered in any character, or cut short, is refused like one that never existed.
    const flipped =
      booked.token.slice(0, 5) + (booked.token[5] === 'A' ? 'B' : 'A') + booked.token.slice(6);
    for (const bad of [flipped, booked.token.slice(0, -1), 'x.y', '', `${booked.token}.z`]) {
      await expect(getGuestBooking(t.db, bad)).rejects.toMatchObject({ code: 'not_found' });
    }
    // Long after the stay the link has lapsed.
    expect(readGuestToken(booked.token, new Date(Date.now() + 200 * 86_400_000))).toBeNull();

    await t.db
      .update(reservations)
      .set({ guestTokenVersion: 2 })
      .where(eq(reservations.id, claims.reservationId));
    await expect(getGuestBooking(t.db, booked.token)).rejects.toMatchObject({ code: 'not_found' });
    const [row] = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.id, claims.reservationId));
    expect((await getGuestBooking(t.db, guestToken(row!))).code).toBe(booked.code);
  });
});

describe('what the booking site shows', () => {
  it('lists only properties that take website bookings, and only rates sold there', async () => {
    const open = await bookableHotel({ description: 'By the sea', amenities: ['Pool'] });
    const closed = await createTestHotel(t.db, org);
    await createRatePlan(t.db, org.admin, open.property.id, {
      roomTypeId: open.standard.roomType.id,
      code: 'STD-CORP',
      name: 'Corporate',
      baseRate: 300_000,
      publicBookable: false,
    });

    const listed = await listPublicProperties(t.db, org.orgId);
    expect(listed.map((p) => p.code)).toContain(open.property.code);
    expect(listed.map((p) => p.code)).not.toContain(closed.property.code);
    await expect(getPublicProperty(t.db, org.orgId, closed.property.code)).rejects.toMatchObject({
      code: 'not_found',
    });
    const detail = await getPublicProperty(t.db, org.orgId, open.property.code.toLowerCase());
    expect(detail).toMatchObject({
      description: 'By the sea',
      amenities: ['Pool'],
      payment: { mode: 'full' },
    });
    expect(detail.roomTypes.map((r) => r.name)).toEqual(['Deluxe Room', 'Standard Room']);

    const found = await searchStay(t.db, org.orgId, {
      propertyCode: open.property.code,
      checkIn: day(10),
      checkOut: day(12),
      adults: 2,
    });
    const standard = found.offers.find((o) => o.roomType.id === open.standard.roomType.id)!;
    expect(standard.available).toBe(3);
    expect(standard.plans.map((p) => p.name)).toEqual(['Standard Room flexible']);
    // Two nights at 4,500 with 5% GST.
    expect(standard.plans[0]).toMatchObject({
      subtotal: 900_000,
      discount: 0,
      taxes: 45_000,
      total: 945_000,
      payNow: 945_000,
      bookable: true,
    });
  });

  it('prices extra guests, leaves out rooms that are too small, and reports rules that rule a stay out', async () => {
    const hotel = await bookableHotel();
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: hotel.standard.ratePlan.id,
      range: { from: day(20), to: day(22) },
      change: { minStayArrival: 3 },
    });
    const three = await searchStay(t.db, org.orgId, {
      propertyCode: hotel.property.code,
      checkIn: day(20),
      checkOut: day(22),
      adults: 3,
      children: 1,
    });
    const standard = three.offers.find((o) => o.roomType.id === hotel.standard.roomType.id)!;
    // One extra adult at 1,000 and one extra child at 500 a night on top of 4,500.
    expect(standard.plans[0]!.nightly.map((n) => n.amount)).toEqual([600_000, 600_000]);
    expect(standard.plans[0]).toMatchObject({ bookable: false });
    expect(standard.plans[0]!.reason).toMatch(/at least 3 nights/);

    const crowd = await searchStay(t.db, org.orgId, {
      propertyCode: hotel.property.code,
      checkIn: day(20),
      checkOut: day(22),
      adults: 4,
    });
    expect(crowd.offers).toEqual([]);

    await expect(
      searchStay(t.db, org.orgId, {
        propertyCode: hotel.property.code,
        checkIn: day(-1),
        checkOut: day(2),
        adults: 2,
      }),
    ).rejects.toThrow(/in the past/);
    await expect(
      searchStay(t.db, org.orgId, {
        propertyCode: hotel.property.code,
        checkIn: day(5),
        checkOut: day(50),
        adults: 2,
      }),
    ).rejects.toThrow(/more than 30 nights/);
  });
});

describe('booking and paying', () => {
  it('holds the room, takes the payment, and confirms', async () => {
    const hotel = await bookableHotel({}, { standardRooms: 2 });
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 10, 12));
    expect(booked).toMatchObject({ status: 'tentative', total: 945_000, payNow: 945_000 });
    expect(booked.payment!.checkoutUrl).toMatch(/\/public\/mock-pay\/mock_/);
    // The hold takes the room off sale at once, for everyone.
    expect(await available(hotel, 10, 12)).toEqual([1, 1]);

    const waiting = await getGuestBooking(t.db, booked.token);
    expect(waiting).toMatchObject({ status: 'tentative', total: 945_000, paid: 0 });
    expect(waiting.pendingPayment).toMatchObject({ amount: 945_000 });

    // Coming back without paying changes nothing.
    expect((await syncGuestPayments(t.db, gateway, booked.token)).status).toBe('tentative');

    const order = await orderOf(booked.code);
    expect(await gateway.complete(order.providerOrderId, 'paid')).toBe(true);
    const paid = await syncGuestPayments(t.db, gateway, booked.token);
    expect(paid).toMatchObject({
      status: 'confirmed',
      total: 945_000,
      paid: 945_000,
      balance: 0,
      pendingPayment: null,
    });

    // The gateway's webhook and the worker may both report the same payment again: recorded once.
    const again = await syncPaymentOrder(t.db, gateway, order.id);
    expect(again).toMatchObject({ settled: false, order: { status: 'paid' } });
    const [reservation] = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.code, booked.code));
    expect(await reservationBalance(t.db, reservation!.id)).toBe(-945_000);
    const lines = await t.db
      .select()
      .from(folioLines)
      .where(eq(folioLines.propertyId, hotel.property.id));
    expect(lines.filter((l) => l.kind === 'payment')).toHaveLength(1);
    expect(reservation).toMatchObject({ source: 'website', status: 'confirmed' });
    expect(await available(hotel, 10, 12)).toEqual([1, 1]);
  });

  it('never sells the last room twice, and gives it back when a hold runs out', async () => {
    const hotel = await bookableHotel({ bookingHoldMinutes: 10 }, { standardRooms: 1 });
    const first = await createBooking(t.db, gateway, org.orgId, request(hotel, 14, 16));
    await expect(
      createBooking(
        t.db,
        gateway,
        org.orgId,
        request(hotel, 15, 17, {
          guest: { firstName: 'Other', lastName: 'Guest', email: 'other@example.com' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'no_availability' });

    // Nobody pays. Eleven minutes later the hold has lapsed and the room is on sale again.
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await expireHolds(t.db, org.admin, later)).toBeGreaterThanOrEqual(1);
    expect(await available(hotel, 14, 16)).toEqual([1, 1]);
    const order = await orderOf(first.code);
    const closed = await syncPaymentOrder(
      t.db,
      gateway,
      order.id,
      new Date(later.getTime() + 180_000),
    );
    expect(closed.order.status).toBe('expired');
    // And the payment page no longer takes money for it.
    expect(await gateway.complete(order.providerOrderId, 'paid')).toBe(false);
    expect((await getGuestBooking(t.db, first.token)).status).toBe('cancelled');
  });

  it('takes the rooms again for a payment that arrives after the hold ran out, if they are still free', async () => {
    const hotel = await bookableHotel({ bookingHoldMinutes: 10 }, { standardRooms: 1 });
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 18, 20));
    const order = await orderOf(booked.code);
    const later = new Date(Date.now() + 11 * 60_000);
    await expireHolds(t.db, org.admin, later);
    expect(await available(hotel, 18, 20)).toEqual([1, 1]);

    await gateway.complete(order.providerOrderId, 'paid');
    const outcome = await syncPaymentOrder(t.db, gateway, order.id, later);
    expect(outcome).toMatchObject({ settled: true, refunded: false });
    expect(await getGuestBooking(t.db, booked.token)).toMatchObject({
      status: 'confirmed',
      paid: 945_000,
    });
    expect(await available(hotel, 18, 20)).toEqual([0, 0]);
  });

  it('refunds a payment that arrives after the rooms were sold to someone else, and tells staff', async () => {
    const hotel = await bookableHotel({ bookingHoldMinutes: 10 }, { standardRooms: 1 });
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 22, 24));
    const order = await orderOf(booked.code);
    const later = new Date(Date.now() + 11 * 60_000);
    await expireHolds(t.db, org.admin, later);
    await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: { firstName: 'Walk', lastName: 'In' },
      rooms: [
        {
          roomTypeId: hotel.standard.roomType.id,
          ratePlanId: hotel.standard.ratePlan.id,
          checkIn: day(22),
          checkOut: day(24),
          adults: 1,
        },
      ],
    });

    await gateway.complete(order.providerOrderId, 'paid');
    const outcome = await syncPaymentOrder(t.db, gateway, order.id, later);
    expect(outcome).toMatchObject({ settled: true, refunded: true });
    const after = await getGuestBooking(t.db, booked.token);
    // Money in, money out: the guest owes nothing and is owed nothing.
    expect(after).toMatchObject({ status: 'cancelled', paid: 0 });
    const raised = await t.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.kind, 'payment_unplaced'), eq(alerts.propertyId, hotel.property.id)));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.body).toMatch(/refunded automatically/);
    // The other guest's room is untouched.
    expect(await available(hotel, 22, 24)).toEqual([0, 0]);
  });

  it('takes a deposit when the property asks for one, and nothing when guests pay on arrival', async () => {
    const deposit = await bookableHotel({ bookingPayment: 'deposit', depositPercent: 20 });
    const held = await createBooking(t.db, gateway, org.orgId, request(deposit, 10, 12));
    expect(held).toMatchObject({ status: 'tentative', total: 945_000, payNow: 189_000 });
    const order = await orderOf(held.code);
    await gateway.complete(order.providerOrderId, 'paid');
    expect(await syncGuestPayments(t.db, gateway, held.token)).toMatchObject({
      status: 'confirmed',
      paid: 189_000,
      balance: 756_000,
    });

    // A non-refundable rate is paid in full whatever the property's setting.
    const nonRefundable = await createRatePlan(t.db, org.admin, deposit.property.id, {
      roomTypeId: deposit.standard.roomType.id,
      code: 'STD-NRF',
      name: 'Non-refundable',
      baseRate: 400_000,
      cancellationPolicy: { nonRefundable: true },
    });
    const full = await createBooking(
      t.db,
      gateway,
      org.orgId,
      request(deposit, 13, 14, {
        rooms: [
          { roomTypeId: deposit.standard.roomType.id, ratePlanId: nonRefundable.id, adults: 2 },
        ],
      }),
    );
    expect(full).toMatchObject({ total: 420_000, payNow: 420_000 });

    const onArrival = await bookableHotel({ bookingPayment: 'none' });
    const confirmed = await createBooking(t.db, gateway, org.orgId, request(onArrival, 10, 12));
    expect(confirmed).toMatchObject({ status: 'confirmed', payNow: 0, payment: null });
    expect(await getGuestBooking(t.db, confirmed.token)).toMatchObject({
      status: 'confirmed',
      paid: 0,
      balance: 945_000,
    });
  });

  it('applies a promotional code to the price, and counts the use once the booking is paid', async () => {
    const hotel = await bookableHotel();
    const promo = await createPromo(t.db, org.admin, {
      code: 'monsoon10',
      kind: 'percent',
      value: 1000,
      maxUses: 1,
    });
    expect(promo.code).toBe('MONSOON10');
    await expect(
      createPromo(t.db, org.admin, { code: 'Monsoon10', kind: 'percent', value: 500 }),
    ).rejects.toThrow(/already exists/);

    const found = await searchStay(t.db, org.orgId, {
      propertyCode: hotel.property.code,
      checkIn: day(10),
      checkOut: day(12),
      adults: 2,
      promoCode: 'Monsoon10',
    });
    expect(found.promo).toMatchObject({ code: 'MONSOON10', label: '10% off', applied: true });
    expect(standardOf(hotel, found).plans[0]).toMatchObject({
      subtotal: 900_000,
      discount: 90_000,
      taxes: 40_500,
      total: 850_500,
    });
    const wrong = await searchStay(t.db, org.orgId, {
      propertyCode: hotel.property.code,
      checkIn: day(10),
      checkOut: day(12),
      adults: 2,
      promoCode: 'NOPE',
    });
    expect(wrong.promo).toMatchObject({ applied: false, reason: 'This code is not valid' });
    expect(standardOf(hotel, wrong).plans[0]!.total).toBe(945_000);
    await expect(
      createBooking(t.db, gateway, org.orgId, request(hotel, 10, 12, { promoCode: 'NOPE' })),
    ).rejects.toThrow(/not valid/);

    const booked = await createBooking(
      t.db,
      gateway,
      org.orgId,
      request(hotel, 10, 12, { promoCode: 'monsoon10' }),
    );
    expect(booked).toMatchObject({ total: 850_500, payNow: 850_500 });
    const used = async () =>
      (await t.db.select().from(promoCodes).where(eq(promoCodes.id, promo.id)))[0]!.usedCount;
    expect(await used()).toBe(0);
    const order = await orderOf(booked.code);
    await gateway.complete(order.providerOrderId, 'paid');
    await syncPaymentOrder(t.db, gateway, order.id);
    await syncPaymentOrder(t.db, gateway, order.id);
    expect(await used()).toBe(1);
    const [reservation] = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.code, booked.code));
    expect(reservation).toMatchObject({
      promoCode: 'MONSOON10',
      discountAmount: 90_000,
      totalAmount: 810_000,
    });

    // The one use is gone.
    const spent = await searchStay(t.db, org.orgId, {
      propertyCode: hotel.property.code,
      checkIn: day(14),
      checkOut: day(16),
      adults: 2,
      promoCode: 'MONSOON10',
    });
    expect(spent.promo).toMatchObject({ applied: false });
    expect(spent.promo!.reason).toMatch(/used as many times/);

    // A code a booking was made with is kept for the record, even once that booking is cancelled.
    await expect(deletePromo(t.db, org.admin, promo.id)).rejects.toThrow(
      new RegExp(`used for booking ${booked.code}.*Switch it off instead`),
    );
    // Cancelling gives the use back, so the next guest can have it; reinstating takes it again.
    await cancelReservation(t.db, org.admin, reservation!.id, { reason: 'Guest changed plans' });
    expect(await used()).toBe(0);
    const again = await searchStay(t.db, org.orgId, {
      propertyCode: hotel.property.code,
      checkIn: day(14),
      checkOut: day(16),
      adults: 2,
      promoCode: 'MONSOON10',
    });
    expect(again.promo).toMatchObject({ applied: true });
    await reinstateReservation(t.db, org.admin, reservation!.id);
    expect(await used()).toBe(1);

    // One that was never used can simply go.
    const unused = await createPromo(t.db, org.admin, {
      code: 'NEVER',
      kind: 'percent',
      value: 500,
    });
    await deletePromo(t.db, org.admin, unused.id);
    expect(await t.db.select().from(promoCodes).where(eq(promoCodes.id, unused.id))).toEqual([]);
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(deletePromo(t.db, rival.admin, promo.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses what the website must not sell', async () => {
    const hotel = await bookableHotel();
    const corporate = await createRatePlan(t.db, org.admin, hotel.property.id, {
      roomTypeId: hotel.standard.roomType.id,
      code: 'STD-CORP',
      name: 'Corporate',
      baseRate: 100,
      publicBookable: false,
    });
    const tries: [Partial<BookingRequest>, RegExp][] = [
      [{ acceptTerms: false }, /accept the booking terms/],
      [{ guest: { firstName: 'A', lastName: 'B', email: 'not-an-email' } }, /valid email/],
      [
        {
          rooms: [{ roomTypeId: hotel.standard.roomType.id, ratePlanId: corporate.id, adults: 2 }],
        },
        /not sold on the website/,
      ],
      [
        {
          rooms: [
            {
              roomTypeId: hotel.standard.roomType.id,
              ratePlanId: hotel.standard.ratePlan.id,
              adults: 9,
            },
          ],
        },
        /at most 3 adults/,
      ],
      [{ rooms: [] }, /at least one room/],
    ];
    for (const [extra, message] of tries) {
      await expect(
        createBooking(t.db, gateway, org.orgId, request(hotel, 10, 12, extra)),
      ).rejects.toThrow(message);
    }
    // Nothing was held by any of them.
    expect(await available(hotel, 10, 12)).toEqual([3, 3]);

    // A rate plan taken off the website mid-session is refused at booking.
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      publicBookable: false,
    });
    await expect(createBooking(t.db, gateway, org.orgId, request(hotel, 10, 12))).rejects.toThrow(
      /not sold on the website/,
    );
  });

  it('limits how many unpaid bookings one guest can hold at a time', async () => {
    const hotel = await bookableHotel({}, { standardRooms: 6 });
    const guest = { firstName: 'Busy', lastName: 'Booker', email: 'busy@example.com' };
    for (let i = 0; i < 3; i++) {
      await createBooking(t.db, gateway, org.orgId, request(hotel, 10 + i, 12 + i, { guest }));
    }
    await expect(
      createBooking(t.db, gateway, org.orgId, request(hotel, 20, 22, { guest })),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await paymentOrdersToCheck(t.db, 'mock', new Date(Date.now() + 120_000))).not.toEqual(
      [],
    );
  });
});

describe('cancelling online', () => {
  const pay = async (code: string) => {
    const order = await orderOf(code);
    await gateway.complete(order.providerOrderId, 'paid');
    await syncPaymentOrder(t.db, gateway, order.id);
  };

  it('returns everything inside the free period', async () => {
    const hotel = await bookableHotel();
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      cancellationPolicy: { freeCancelDays: 2, penalty: 'first_night' },
    });
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 10, 12));
    await pay(booked.code);
    const before = await getGuestBooking(t.db, booked.token);
    expect(before.cancellation).toMatchObject({ allowed: true, charge: 0, refund: 945_000 });
    // The page can show how much of the price is tax, and that nothing has been returned yet.
    expect(before).toMatchObject({ total: 945_000, tax: 45_000, paid: 945_000, refunded: 0 });

    const result = await cancelGuestBooking(t.db, gateway, booked.token);
    expect(result).toMatchObject({ charge: 0, refunded: 945_000, refundPending: 0 });
    expect(result.booking).toMatchObject({ status: 'cancelled', paid: 0, balance: 0 });
    // Opened again later, the booking still says what was returned.
    expect(await getGuestBooking(t.db, booked.token)).toMatchObject({
      status: 'cancelled',
      total: 0,
      tax: 0,
      paid: 0,
      refunded: 945_000,
    });
    expect(await available(hotel, 10, 12)).toEqual([3, 3]);
    await expect(cancelGuestBooking(t.db, gateway, booked.token)).rejects.toThrow(
      /already cancelled/,
    );
  });

  it('keeps the charge the rate sets after the free period, and returns the rest', async () => {
    const hotel = await bookableHotel();
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      cancellationPolicy: { freeCancelDays: 5, penalty: 'first_night' },
    });
    // Arriving in three days: the free period ended two days ago.
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 3, 5));
    await pay(booked.code);
    // The first night, 4,500, with 18% GST on the charge.
    expect((await getGuestBooking(t.db, booked.token)).cancellation).toMatchObject({
      allowed: true,
      charge: 531_000,
      refund: 414_000,
    });
    const result = await cancelGuestBooking(t.db, gateway, booked.token);
    expect(result).toMatchObject({ charge: 531_000, refunded: 414_000, refundPending: 0 });
    expect(result.booking).toMatchObject({
      status: 'cancelled',
      total: 531_000,
      tax: 81_000,
      paid: 531_000,
      refunded: 414_000,
      balance: 0,
    });
  });

  it('returns nothing on a non-refundable rate, and leaves channel bookings to the channel', async () => {
    const hotel = await bookableHotel();
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      cancellationPolicy: { nonRefundable: true },
    });
    const booked = await createBooking(t.db, gateway, org.orgId, request(hotel, 10, 11));
    await pay(booked.code);
    const result = await cancelGuestBooking(t.db, gateway, booked.token);
    // 4,500 at the 18% charged on fees comes to more than was paid with 5% room GST: nothing goes back.
    expect(result).toMatchObject({ refunded: 0, refundPending: 0 });
    expect(result.booking.status).toBe('cancelled');

    const ota = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'ota',
      channelCode: 'BDC',
      guest: { firstName: 'From', lastName: 'Booking' },
      rooms: [
        {
          roomTypeId: hotel.standard.roomType.id,
          ratePlanId: hotel.standard.ratePlan.id,
          checkIn: day(10),
          checkOut: day(12),
          adults: 2,
        },
      ],
    });
    const [row] = await t.db.select().from(reservations).where(eq(reservations.id, ota.id));
    const token = guestToken(row!);
    expect((await getGuestBooking(t.db, token)).cancellation).toMatchObject({
      allowed: false,
      reason: 'This booking was made on a booking site; please cancel it there',
    });
    await expect(cancelGuestBooking(t.db, gateway, token)).rejects.toBeInstanceOf(DomainError);
    expect((await loadReservation(t.db, org.orgId, ota.id)).status).toBe('confirmed');
  });
});

describe('payment links', () => {
  it('lets staff ask a guest for money online, and records it on the folio when paid', async () => {
    const hotel = await bookableHotel();
    const reservation = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: { firstName: 'Phone', lastName: 'Caller', email: 'caller@example.com' },
      rooms: [
        {
          roomTypeId: hotel.deluxe.roomType.id,
          ratePlanId: hotel.deluxe.ratePlan.id,
          checkIn: day(8),
          checkOut: day(9),
          adults: 2,
        },
      ],
    });
    await expect(
      createPaymentLink(t.db, gateway, org.admin, reservation.id, { amount: 0 }),
    ).rejects.toThrow(/above zero/);
    const link = await createPaymentLink(t.db, gateway, org.admin, reservation.id, {
      amount: 300_000,
      description: 'Deposit',
    });
    expect(link.payUrl).toMatch(/\/booking\/[\w-]+\.[\w-]+\/pay\/[0-9a-f-]{36}$/);
    await gateway.complete(link.providerOrderId, 'paid');
    const outcome = await syncPaymentOrder(t.db, gateway, link.id);
    expect(outcome).toMatchObject({ settled: true, order: { status: 'paid' } });
    expect(await reservationBalance(t.db, reservation.id)).toBe(-300_000);
    expect((await loadReservation(t.db, org.orgId, reservation.id)).status).toBe('confirmed');
  });
});
