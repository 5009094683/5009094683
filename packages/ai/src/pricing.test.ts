import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, outbox, rateDays, rateRecommendations } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import {
  addDays,
  cancelReservation,
  createRatePlan,
  createReservation,
  getRateCalendar,
  todayIn,
  updateProperty,
  updateRatePlan,
} from '@pms/domain';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from '@pms/domain/testing';
import {
  applyRecommendations,
  assessDemand,
  dismissRecommendations,
  generateRecommendations,
  listRecommendations,
  recommendRate,
} from './pricing';

let t: TestDatabase;
let org: TestOrg;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
});
afterAll(async () => {
  await t.drop();
});

const book = (hotel: TestHotel, from: number, to: number, rooms = 1) =>
  createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: 'phone',
    guest: { firstName: 'Guest', lastName: `${from}-${to}` },
    rooms: Array.from({ length: rooms }, () => ({
      roomTypeId: hotel.standard.roomType.id,
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(from),
      checkOut: day(to),
      adults: 2,
    })),
  });

describe('the demand model', () => {
  const quiet = { capacity: 10, sold: 0, lead: 30, baseline: 0.5, pickupShare: 0.38 };

  it('raises the rate when a night is filling and lowers it when it is not', () => {
    const empty = assessDemand(quiet);
    const filling = assessDemand({ ...quiet, sold: 6 });
    const full = assessDemand({ ...quiet, sold: 10 });
    expect(empty.forecast).toBeLessThan(filling.forecast);
    expect(filling.forecast).toBeLessThanOrEqual(1);
    expect(full.forecast).toBe(1);
    expect(empty.effectBp).toBeLessThan(0);
    expect(filling.effectBp).toBeGreaterThan(0);
    expect(full.effectBp).toBeGreaterThanOrEqual(filling.effectBp);
    // Every move comes with its reason in words.
    expect(filling.drivers[0]!.label).toMatch(/^Expected to be \d+% full$/);
    expect(empty.drivers.map((d) => d.label)).toContain('Booking slower than usual');
  });

  it('knows the same bookings mean more far ahead than close in', () => {
    const farAhead = assessDemand({ ...quiet, sold: 4, lead: 90, pickupShare: 0.12 });
    const closeIn = assessDemand({ ...quiet, sold: 4, lead: 3, pickupShare: 0.85 });
    expect(farAhead.forecast).toBeGreaterThan(closeIn.forecast);
    expect(farAhead.drivers.map((d) => d.label)).toContain(
      'Booking faster than usual for this far ahead',
    );
  });

  it('adds the plain rules: an event, unsold rooms at the last minute, the last room', () => {
    const event = assessDemand({
      ...quiet,
      sold: 5,
      event: { name: 'Sunburn festival', upliftPercent: 20 },
    });
    expect(event.drivers).toContainEqual({ label: 'Sunburn festival', effectBp: 2000 });
    const tonight = assessDemand({ ...quiet, sold: 2, lead: 0, pickupShare: 1 });
    expect(tonight.drivers).toContainEqual({
      label: 'Rooms still unsold for tonight',
      effectBp: -1000,
    });
    const lastRoom = assessDemand({ ...quiet, sold: 9, lead: 20, pickupShare: 0.5 });
    expect(lastRoom.drivers).toContainEqual({ label: 'Last room of this kind', effectBp: 500 });
    // Nothing to sell, nothing to say.
    expect(assessDemand({ ...quiet, capacity: 0 })).toMatchObject({ effectBp: 0, drivers: [] });
  });

  it('keeps every suggested rate inside the limits', () => {
    const limits = {
      baseRate: 450_000,
      floorRate: null,
      ceilingRate: null,
      maxChangePercent: 40,
      rounding: 5_000,
    };
    expect(recommendRate(0, limits)).toBe(450_000);
    expect(recommendRate(1_000, limits)).toBe(495_000);
    // 12.3% up is 505,350: rounded to the nearest fifty rupees.
    expect(recommendRate(1_230, limits)).toBe(505_000);
    // Never more than the allowed swing, whatever the model says.
    expect(recommendRate(9_000, limits)).toBe(630_000);
    expect(recommendRate(-9_000, limits)).toBe(270_000);
    // The owner's floor and ceiling win.
    expect(recommendRate(-9_000, { ...limits, floorRate: 400_000 })).toBe(400_000);
    expect(recommendRate(9_000, { ...limits, ceilingRate: 500_000 })).toBe(500_000);
    expect(recommendRate(3_000, { ...limits, floorRate: 400_000, ceilingRate: 500_000 })).toBe(
      500_000,
    );
  });
});

describe('rate suggestions for a property', () => {
  it('suggests higher rates for nights that are filling, with reasons, and changes nothing by itself', async () => {
    const hotel = await createTestHotel(t.db, org, { standardRooms: 4, deluxeRooms: 1 });
    // Three of four standard rooms gone, six weeks out.
    await book(hotel, 42, 44, 3);
    const run = await generateRecommendations(t.db, hotel.property.id);
    expect(run.created).toBeGreaterThan(0);
    expect(run.autoApplied).toBe(0);

    const all = await listRecommendations(t.db, org.orgId, { propertyId: hotel.property.id });
    const busy = all.find(
      (r) => r.ratePlanId === hotel.standard.ratePlan.id && r.date === day(42),
    )!;
    expect(busy).toMatchObject({
      currentRate: 450_000,
      roomTypeName: 'Standard Room',
      confidence: 'low',
      status: 'pending',
      occupancyBp: 7_500,
    });
    expect(busy.recommendedRate).toBeGreaterThan(450_000);
    expect(busy.recommendedRate % 5_000).toBe(0);
    expect(busy.drivers.length).toBeGreaterThan(0);
    // Quiet nights go the other way.
    const quiet = all.find(
      (r) => r.ratePlanId === hotel.standard.ratePlan.id && r.date === day(20),
    )!;
    expect(quiet.recommendedRate).toBeLessThan(450_000);

    // Nothing was changed: the rates are as they were.
    const calendar = await getRateCalendar(t.db, {
      propertyId: hotel.property.id,
      range: { from: day(42), to: day(43) },
      ratePlanIds: [hotel.standard.ratePlan.id],
    });
    expect(calendar[0]!.rate).toBe(450_000);

    // Running again changes nothing and adds nothing.
    const again = await generateRecommendations(t.db, hotel.property.id);
    expect(again).toMatchObject({ created: 0, superseded: 0 });
  });

  it('applies what a person approves, in as few rate changes as possible, and tells the channels', async () => {
    const hotel = await createTestHotel(t.db, org, { standardRooms: 4, deluxeRooms: 1 });
    await book(hotel, 30, 34, 3);
    await generateRecommendations(t.db, hotel.property.id);
    const picked = (
      await listRecommendations(t.db, org.orgId, {
        propertyId: hotel.property.id,
        from: day(30),
        to: day(34),
      })
    ).filter((r) => r.ratePlanId === hotel.standard.ratePlan.id);
    expect(picked).toHaveLength(4);
    await t.db.delete(outbox);

    const applied = await applyRecommendations(
      t.db,
      org.admin,
      picked.map((r) => r.id),
    );
    expect(applied).toBe(4);
    const days = await t.db
      .select()
      .from(rateDays)
      .where(eq(rateDays.ratePlanId, hotel.standard.ratePlan.id));
    expect(new Set(days.map((d) => d.date))).toEqual(new Set([day(30), day(31), day(32), day(33)]));
    for (const d of days) {
      expect(d.rate).toBe(picked.find((p) => p.date === d.date)!.recommendedRate);
    }
    // The changes are queued for the booking sites like any rate change.
    const queued = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.restrictions'));
    expect(queued.length).toBeGreaterThan(0);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'pricing.recommendations_applied'),
          eq(auditLog.propertyId, hotel.property.id),
        ),
      );
    expect(audit).toMatchObject([{ summary: 'Applied 4 suggested rates' }]);

    // Applying twice does nothing; a dismissed suggestion cannot be applied later.
    expect(await applyRecommendations(t.db, org.admin, [picked[0]!.id])).toBe(0);
    const other = (
      await listRecommendations(t.db, org.orgId, { propertyId: hotel.property.id })
    )[0]!;
    expect(await dismissRecommendations(t.db, org.admin, [other.id])).toBe(1);
    expect(await applyRecommendations(t.db, org.admin, [other.id])).toBe(0);
    // Another organisation's suggestions are not there to be applied.
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(applyRecommendations(t.db, rival.admin, [picked[1]!.id])).rejects.toMatchObject({
      code: 'not_found',
    });

    // With the rate now what was suggested, the next run has nothing more to say about those nights.
    await generateRecommendations(t.db, hotel.property.id);
    const after = await listRecommendations(t.db, org.orgId, {
      propertyId: hotel.property.id,
      from: day(30),
      to: day(34),
    });
    expect(after.filter((r) => r.ratePlanId === hotel.standard.ratePlan.id)).toEqual([]);
  });

  it('withdraws a suggestion when the picture changes', async () => {
    const hotel = await createTestHotel(t.db, org, { standardRooms: 4, deluxeRooms: 1 });
    const stay = await book(hotel, 50, 51, 3);
    await generateRecommendations(t.db, hotel.property.id);
    const before = (
      await listRecommendations(t.db, org.orgId, {
        propertyId: hotel.property.id,
        from: day(50),
        to: day(51),
      })
    ).find((r) => r.ratePlanId === hotel.standard.ratePlan.id)!;
    expect(before.recommendedRate).toBeGreaterThan(450_000);

    await cancelReservation(t.db, org.admin, stay.id, { reason: 'Group fell through' });
    const run = await generateRecommendations(t.db, hotel.property.id);
    expect(run.superseded).toBeGreaterThanOrEqual(1);
    const [old] = await t.db
      .select()
      .from(rateRecommendations)
      .where(eq(rateRecommendations.id, before.id));
    expect(old!.status).toBe('superseded');
    const now = (
      await listRecommendations(t.db, org.orgId, {
        propertyId: hotel.property.id,
        from: day(50),
        to: day(51),
      })
    ).find((r) => r.ratePlanId === hotel.standard.ratePlan.id);
    expect(now!.recommendedRate).toBeLessThan(450_000);
  });

  it('runs on autopilot only for room types switched to it, and only inside a floor and a ceiling', async () => {
    const hotel = await createTestHotel(t.db, org, { standardRooms: 4, deluxeRooms: 2 });
    await updateProperty(t.db, org.admin, hotel.property.id, {
      settings: {
        pricingAutopilotRoomTypes: [hotel.standard.roomType.id, hotel.deluxe.roomType.id],
        pricingEvents: [{ from: day(60), to: day(61), name: 'Carnival', upliftPercent: 25 }],
      },
    });
    // The standard plan is fenced in; the deluxe plan has no ceiling, so autopilot leaves it alone.
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.standard.ratePlan.id, {
      floorRate: 400_000,
      ceilingRate: 520_000,
    });
    await updateRatePlan(t.db, org.admin, hotel.property.id, hotel.deluxe.ratePlan.id, {
      floorRate: 600_000,
    });
    // A plan that follows another is never priced on its own.
    const follower = await createRatePlan(t.db, org.admin, hotel.property.id, {
      roomTypeId: hotel.standard.roomType.id,
      code: 'STD-NRF',
      name: 'Non-refundable',
      baseRate: 0,
      parentRatePlanId: hotel.standard.ratePlan.id,
      derivedPercentBp: -1000,
    });
    await book(hotel, 60, 62, 4);

    const run = await generateRecommendations(t.db, hotel.property.id);
    expect(run.autoApplied).toBeGreaterThan(0);
    const rows = await t.db
      .select()
      .from(rateRecommendations)
      .where(eq(rateRecommendations.propertyId, hotel.property.id));
    expect(rows.some((r) => r.ratePlanId === follower.id)).toBe(false);
    const standard = rows.filter((r) => r.ratePlanId === hotel.standard.ratePlan.id);
    expect(standard.every((r) => r.status === 'applied' && r.appliedVia === 'autopilot')).toBe(
      true,
    );
    expect(
      standard.every((r) => r.recommendedRate >= 400_000 && r.recommendedRate <= 520_000),
    ).toBe(true);
    // The sold-out carnival nights hit the ceiling, with the event named among the reasons.
    const carnival = standard.find((r) => r.date === day(60))!;
    expect(carnival.recommendedRate).toBe(520_000);
    expect(carnival.drivers.map((d) => d.label)).toContain('Carnival');
    const deluxe = rows.filter((r) => r.ratePlanId === hotel.deluxe.ratePlan.id);
    expect(deluxe.length).toBeGreaterThan(0);
    expect(deluxe.every((r) => r.status === 'pending')).toBe(true);
    expect(deluxe.every((r) => r.recommendedRate >= 600_000)).toBe(true);

    // The applied rates are in force, and the follower moved with them.
    const calendar = await getRateCalendar(t.db, {
      propertyId: hotel.property.id,
      range: { from: day(60), to: day(61) },
      ratePlanIds: [hotel.standard.ratePlan.id, follower.id],
    });
    expect(calendar.find((c) => c.ratePlanId === hotel.standard.ratePlan.id)!.rate).toBe(520_000);
    expect(calendar.find((c) => c.ratePlanId === follower.id)!.rate).toBe(468_000);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'rates.updated'), eq(auditLog.propertyId, hotel.property.id)));
    expect(audit.some((a) => a.actorLabel === 'system:pricing-autopilot')).toBe(true);
  });
});
