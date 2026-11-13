import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outbox } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { DomainError } from './errors';
import { createRatePlan, updateRatePlan } from './properties';
import {
  getRateCalendar,
  nightlyCharge,
  quoteStay,
  restrictionViolations,
  setRates,
} from './rates';
import { createReservation } from './reservations';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org);
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

const rates = async (ratePlanId: string, from: string, to: string) =>
  (
    await getRateCalendar(t.db, {
      propertyId: hotel.property.id,
      range: { from, to },
      ratePlanIds: [ratePlanId],
    })
  ).map((d) => d.rate);

describe('rates and restrictions', () => {
  it('uses the plan default until a day is given its own rate', async () => {
    const plan = hotel.standard.ratePlan;
    expect(await rates(plan.id, '2027-01-01', '2027-01-04')).toEqual([450_000, 450_000, 450_000]);

    const result = await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-01-02', to: '2027-01-03' },
      change: { rate: 600_000 },
    });
    expect(result.daysChanged).toBe(1);
    const days = await getRateCalendar(t.db, {
      propertyId: hotel.property.id,
      range: { from: '2027-01-01', to: '2027-01-04' },
      ratePlanIds: [plan.id],
    });
    expect(days.map((d) => [d.rate, d.rateOverridden])).toEqual([
      [450_000, false],
      [600_000, true],
      [450_000, false],
    ]);

    // Clearing the override returns the day to the plan default.
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-01-02', to: '2027-01-03' },
      change: { rate: null },
    });
    expect(await rates(plan.id, '2027-01-01', '2027-01-04')).toEqual([450_000, 450_000, 450_000]);
  });

  it('applies a bulk change only to the chosen weekdays', async () => {
    const plan = hotel.standard.ratePlan;
    // February 2027: the 5th and 6th are Friday and Saturday.
    const result = await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-02-01', to: '2027-02-15' },
      daysOfWeek: [5, 6],
      change: { rate: 550_000, minStayArrival: 2 },
    });
    expect(result.daysChanged).toBe(4);
    const days = await getRateCalendar(t.db, {
      propertyId: hotel.property.id,
      range: { from: '2027-02-04', to: '2027-02-08' },
      ratePlanIds: [plan.id],
    });
    expect(days.map((d) => [d.date, d.rate, d.minStayArrival])).toEqual([
      ['2027-02-04', 450_000, 1],
      ['2027-02-05', 550_000, 2],
      ['2027-02-06', 550_000, 2],
      ['2027-02-07', 450_000, 1],
    ]);

    // Setting the same values again changes nothing and queues nothing.
    await t.db.delete(outbox);
    const again = await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-02-01', to: '2027-02-15' },
      daysOfWeek: [5, 6],
      change: { rate: 550_000, minStayArrival: 2 },
    });
    expect(again.daysChanged).toBe(0);
    expect(await t.db.select().from(outbox)).toHaveLength(0);
  });

  it('prices a derived plan off its parent and queues both plans for the channels', async () => {
    const parent = hotel.deluxe.ratePlan;
    const derived = await createRatePlan(t.db, org.admin, hotel.property.id, {
      roomTypeId: hotel.deluxe.roomType.id,
      code: 'DLX-NRF',
      name: 'Deluxe non-refundable',
      baseRate: 0,
      parentRatePlanId: parent.id,
      derivedPercentBp: -1000,
      cancellationPolicy: { nonRefundable: true },
    });
    expect(await rates(derived.id, '2027-03-01', '2027-03-03')).toEqual([630_000, 630_000]);

    await t.db.delete(outbox);
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: parent.id,
      range: { from: '2027-03-01', to: '2027-03-02' },
      change: { rate: 800_000 },
    });
    expect(await rates(derived.id, '2027-03-01', '2027-03-03')).toEqual([720_000, 630_000]);
    const queued = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.restrictions'));
    expect(queued.map((e) => e.payload.ratePlanId).sort()).toEqual([parent.id, derived.id].sort());
    expect(
      queued.every((e) => e.payload.from === '2027-03-01' && e.payload.to === '2027-03-02'),
    ).toBe(true);

    // A derived plan cannot be given its own rate, and derivations cannot loop.
    const err = await errorOf(
      setRates(t.db, org.admin, {
        propertyId: hotel.property.id,
        ratePlanId: derived.id,
        range: { from: '2027-03-01', to: '2027-03-02' },
        change: { rate: 100_000 },
      }),
    );
    expect(err.code).toBe('validation');
    const loop = await errorOf(
      updateRatePlan(t.db, org.admin, hotel.property.id, parent.id, {
        parentRatePlanId: derived.id,
      }),
    );
    expect(loop.message).toMatch(/loop/);

    // Restrictions remain the derived plan's own.
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: derived.id,
      range: { from: '2027-03-01', to: '2027-03-02' },
      change: { stopSell: true },
    });
    const [day] = await getRateCalendar(t.db, {
      propertyId: hotel.property.id,
      range: { from: '2027-03-01', to: '2027-03-02' },
      ratePlanIds: [derived.id],
    });
    expect(day).toMatchObject({ stopSell: true, rate: 720_000 });
  });

  it('queues the whole horizon when a plan default changes', async () => {
    await t.db.delete(outbox);
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      baseRate: 480_000,
    });
    const queued = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.restrictions'));
    expect(queued).toHaveLength(1);
    const days = Math.round(
      (Date.parse(String(queued[0]!.payload.to)) - Date.parse(String(queued[0]!.payload.from))) /
        86_400_000,
    );
    expect(days).toBe(hotel.property.inventoryHorizonDays);

    // A change that does not affect price or restrictions queues nothing.
    await t.db.delete(outbox);
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      description: 'Best available rate',
    });
    expect(
      await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.restrictions')),
    ).toHaveLength(0);
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      baseRate: 450_000,
    });
  });

  it('rejects invalid rate changes', async () => {
    const base = { propertyId: hotel.property.id, ratePlanId: hotel.standard.ratePlan.id };
    const cases = [
      { ...base, range: { from: '2027-04-01', to: '2027-04-02' }, change: {} },
      { ...base, range: { from: '2027-04-01', to: '2027-04-02' }, change: { rate: -1 } },
      { ...base, range: { from: '2027-04-01', to: '2027-04-02' }, change: { rate: 10.5 } },
      { ...base, range: { from: '2027-04-01', to: '2027-04-02' }, change: { minStayArrival: 0 } },
      { ...base, range: { from: '2027-04-02', to: '2027-04-01' }, change: { rate: 1 } },
      {
        ...base,
        range: { from: '2027-04-01', to: '2027-04-02' },
        daysOfWeek: [7],
        change: { rate: 1 },
      },
    ];
    for (const input of cases)
      expect((await errorOf(setRates(t.db, org.admin, input))).code).toBe('validation');
  });
});

describe('quoting a stay', () => {
  it('charges supplements for guests beyond the included occupancy', () => {
    const plan = { includedOccupancy: 2, extraAdultRate: 100_000, extraChildRate: 50_000 };
    expect(nightlyCharge(450_000, plan, 2, 0)).toBe(450_000);
    expect(nightlyCharge(450_000, plan, 3, 0)).toBe(550_000);
    expect(nightlyCharge(450_000, plan, 2, 2)).toBe(550_000);
    // A child takes the place of the second adult at no extra charge.
    expect(nightlyCharge(450_000, plan, 1, 1)).toBe(450_000);
    expect(nightlyCharge(450_000, plan, 1, 2)).toBe(500_000);
  });

  it('totals the nightly rates and reports broken restrictions', async () => {
    const plan = hotel.standard.ratePlan;
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-05-10', to: '2027-05-11' },
      change: { rate: 500_000, closedToArrival: true },
    });
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-05-12', to: '2027-05-13' },
      change: { minStayThrough: 3, closedToDeparture: true },
    });

    const quote = await quoteStay(t.db, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      checkIn: '2027-05-10',
      checkOut: '2027-05-12',
      adults: 3,
    });
    expect(quote.nights).toEqual([
      { date: '2027-05-10', amount: 600_000 },
      { date: '2027-05-11', amount: 550_000 },
    ]);
    expect(quote.total).toBe(1_150_000);
    expect(quote.violations.map((v) => v.code).sort()).toEqual([
      'closed_to_arrival',
      'closed_to_departure',
    ]);

    const ok = await quoteStay(t.db, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      checkIn: '2027-05-11',
      checkOut: '2027-05-14',
      adults: 2,
    });
    expect(ok.violations).toEqual([]);
    const short = await quoteStay(t.db, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      checkIn: '2027-05-11',
      checkOut: '2027-05-13',
      adults: 2,
    });
    expect(short.violations.map((v) => v.code)).toEqual(['min_stay']);
  });

  it('checks each kind of restriction on the right day', () => {
    const day = (
      date: string,
      extra: Partial<Parameters<typeof restrictionViolations>[0][number]> = {},
    ) => ({
      ratePlanId: 'p',
      date,
      rate: 100,
      minStayArrival: 1,
      minStayThrough: 1,
      maxStay: null,
      closedToArrival: false,
      closedToDeparture: false,
      stopSell: false,
      rateOverridden: false,
      ...extra,
    });
    const codes = (days: ReturnType<typeof day>[], from: string, to: string) =>
      restrictionViolations(days, from, to).map((v) => `${v.code}@${v.date}`);

    expect(
      codes([day('2027-06-01'), day('2027-06-02'), day('2027-06-03')], '2027-06-01', '2027-06-03'),
    ).toEqual([]);
    expect(
      codes(
        [day('2027-06-01'), day('2027-06-02', { stopSell: true }), day('2027-06-03')],
        '2027-06-01',
        '2027-06-03',
      ),
    ).toEqual(['stop_sell@2027-06-02']);
    // Closed to arrival only matters on the arrival day; staying through it is allowed.
    expect(
      codes(
        [day('2027-06-01'), day('2027-06-02', { closedToArrival: true }), day('2027-06-03')],
        '2027-06-01',
        '2027-06-03',
      ),
    ).toEqual([]);
    expect(
      codes(
        [day('2027-06-01', { maxStay: 1 }), day('2027-06-02'), day('2027-06-03')],
        '2027-06-01',
        '2027-06-03',
      ),
    ).toEqual(['max_stay@2027-06-01']);
    // A stop-sell on the departure day does not affect a stay that leaves that morning.
    expect(
      codes(
        [day('2027-06-01'), day('2027-06-02'), day('2027-06-03', { stopSell: true })],
        '2027-06-01',
        '2027-06-03',
      ),
    ).toEqual([]);
  });

  it('enforces restrictions for guest self-service but lets staff book through them', async () => {
    const plan = hotel.deluxe.ratePlan;
    await setRates(t.db, org.admin, {
      propertyId: hotel.property.id,
      ratePlanId: plan.id,
      range: { from: '2027-07-01', to: '2027-07-05' },
      change: { minStayArrival: 3 },
    });
    const input = {
      propertyId: hotel.property.id,
      source: 'website' as const,
      guest: { firstName: 'Web', lastName: 'Guest', email: 'web.guest@example.com' },
      rooms: [
        {
          roomTypeId: hotel.deluxe.roomType.id,
          ratePlanId: plan.id,
          checkIn: '2027-07-01',
          checkOut: '2027-07-02',
          adults: 2,
        },
      ],
    };
    const err = await errorOf(
      createReservation(t.db, org.admin, input, { enforceRestrictions: true }),
    );
    expect(err.code).toBe('restriction_violated');
    expect(err.message).toContain('at least 3 nights');

    const staff = await createReservation(t.db, org.admin, { ...input, source: 'phone' });
    expect(staff.status).toBe('confirmed');
  });
});
