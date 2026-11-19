import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reservations } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createCompany } from './companies';
import { addDays, todayIn } from './dates';
import { postCharge, recordPayment } from './folios';
import { checkIn } from './frontdesk';
import { reportIssue } from './maintenance';
import {
  agentCommissionReport,
  channelMixReport,
  paceReport,
  performanceReport,
  revenueReport,
} from './reports';
import { cancelReservation, createReservation } from './reservations';
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

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

let seq = 0;
const book = (
  from: number,
  to: number,
  extra: Partial<Parameters<typeof createReservation>[2]> & { type?: 'standard' | 'deluxe' } = {},
  rooms = 1,
) => {
  const { type = 'standard', ...rest } = extra;
  return createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: 'phone',
    guest: { firstName: 'Guest', lastName: `Number${++seq}` },
    rooms: Array.from({ length: rooms }, () => ({
      roomTypeId: hotel[type].roomType.id,
      ratePlanId: hotel[type].ratePlan.id,
      checkIn: day(from),
      checkOut: day(to),
      adults: 2,
    })),
    ...rest,
  });
};

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  // Four standard rooms at 4,500 a night and one deluxe room at 7,000.
  hotel = await createTestHotel(t.db, org, { standardRooms: 4, deluxeRooms: 1 });
});
afterAll(async () => {
  await t.drop();
});

describe('occupancy, average rate and revenue per available room', () => {
  beforeAll(async () => {
    // Two standard rooms for two nights, by phone.
    await book(10, 12, {}, 2);
    // The deluxe room for two nights from Booking.com, which keeps 15%.
    await book(11, 13, {
      type: 'deluxe',
      source: 'ota',
      channelCode: 'BDC',
      commissionAmount: 210_000,
    });
    // Neither a cancelled booking nor a hold that is not yet a booking counts as sold.
    const cancelled = await book(10, 11, { source: 'website' });
    await cancelReservation(t.db, org.admin, cancelled.id, { reason: 'Change of plans' });
    await book(10, 11, { status: 'tentative', holdExpiresAt: new Date(Date.now() + 600_000) });
  });

  it('counts each night from the reservations as they stand', async () => {
    const report = await performanceReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(10),
      to: day(13),
    });
    expect(report).toMatchObject({ currency: 'INR', groupBy: 'day' });
    expect(report.rows).toEqual([
      {
        key: day(10),
        label: day(10),
        available: 5,
        sold: 2,
        occupancyBp: 4_000,
        roomRevenue: 900_000,
        adr: 450_000,
        revpar: 180_000,
      },
      {
        key: day(11),
        label: day(11),
        available: 5,
        sold: 3,
        occupancyBp: 6_000,
        roomRevenue: 1_600_000,
        adr: 533_333,
        revpar: 320_000,
      },
      {
        key: day(12),
        label: day(12),
        available: 5,
        sold: 1,
        occupancyBp: 2_000,
        roomRevenue: 700_000,
        adr: 700_000,
        revpar: 140_000,
      },
    ]);
    expect(report.total).toEqual({
      key: 'total',
      label: 'Total',
      available: 15,
      sold: 6,
      occupancyBp: 4_000,
      roomRevenue: 3_200_000,
      adr: 533_333,
      revpar: 213_333,
    });
  });

  it('groups the same figures by room type, by property and by month', async () => {
    const window = { propertyIds: 'all' as const, from: day(10), to: day(13) };
    const byType = await performanceReport(t.db, org.orgId, { ...window, groupBy: 'room_type' });
    expect(byType.rows.map((r) => [r.label, r.available, r.sold, r.roomRevenue])).toEqual([
      ['Deluxe Room', 3, 2, 1_400_000],
      ['Standard Room', 12, 4, 1_800_000],
    ]);
    const byProperty = await performanceReport(t.db, org.orgId, { ...window, groupBy: 'property' });
    expect(byProperty.rows).toMatchObject([
      { key: hotel.property.id, label: hotel.property.name, sold: 6 },
    ]);
    const byMonth = await performanceReport(t.db, org.orgId, { ...window, groupBy: 'month' });
    expect(byMonth.rows.reduce((sum, r) => sum + r.sold, 0)).toBe(6);
    expect(byMonth.rows.every((r) => /^\d{4}-\d{2}$/.test(r.key))).toBe(true);
    const byWeek = await performanceReport(t.db, org.orgId, { ...window, groupBy: 'week' });
    expect(byWeek.rows.reduce((sum, r) => sum + r.roomRevenue, 0)).toBe(3_200_000);
    // Every week starts on a Monday.
    for (const row of byWeek.rows) {
      expect(new Date(`${row.key}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it('does not count a room closed for repair as one that could have been sold', async () => {
    await reportIssue(t.db, org.admin, {
      propertyId: hotel.property.id,
      unitId: hotel.standard.units[3]!.id,
      title: 'Leaking tap',
      offSale: { from: day(12), to: day(13) },
    });
    const report = await performanceReport(t.db, org.orgId, {
      propertyIds: [hotel.property.id],
      from: day(12),
      to: day(13),
    });
    expect(report.total).toMatchObject({ available: 4, sold: 1, occupancyBp: 2_500 });
  });

  it('shows only the properties asked for, and refuses to add up two currencies', async () => {
    expect(
      await performanceReport(t.db, org.orgId, { propertyIds: [], from: day(10), to: day(13) }),
    ).toMatchObject({ currency: null, rows: [], total: { available: 0, sold: 0, adr: null } });
    const rival = await createTestOrg(t.db, 'Rival');
    expect(
      (
        await performanceReport(t.db, rival.orgId, {
          propertyIds: [hotel.property.id],
          from: day(10),
          to: day(13),
        })
      ).rows,
    ).toEqual([]);

    const abroad = await createTestOrg(t.db, 'Two Currencies');
    await createTestHotel(t.db, abroad);
    const villa = await createTestVilla(t.db, abroad);
    await t.db.execute(
      // A property priced in another currency.
      `UPDATE properties SET currency = 'USD' WHERE id = '${villa.property.id}'`,
    );
    await expect(
      performanceReport(t.db, abroad.orgId, { propertyIds: 'all', from: day(10), to: day(13) }),
    ).rejects.toThrow(/different currencies \((INR, USD|USD, INR)\)/);
    await expect(
      performanceReport(t.db, org.orgId, { propertyIds: 'all', from: day(10), to: day(900) }),
    ).rejects.toThrow(/at most 800 days/);
    await expect(
      performanceReport(t.db, org.orgId, { propertyIds: 'all', from: day(10), to: day(10) }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('where the business came from', () => {
  it('shows room nights, revenue, commission and cancellations by booking site and source', async () => {
    const report = await channelMixReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(10),
      to: day(13),
    });
    expect(report.rows.map((r) => r.key)).toEqual(['phone', 'BDC', 'website']);
    const [phone, bdc, website] = report.rows;
    // The website's one booking for these dates was cancelled: it sold nothing, and it is
    // listed all the same, because that is where the cancellation came from.
    expect(website).toEqual({
      key: 'website',
      channelCode: null,
      source: 'website',
      reservations: 0,
      roomNights: 0,
      roomRevenue: 0,
      commission: 0,
      netRevenue: 0,
      adr: null,
      revenueShareBp: 0,
      avgLeadDays: null,
      avgNights: null,
      cancellationBp: 10_000,
    });
    expect(phone).toEqual({
      key: 'phone',
      channelCode: null,
      source: 'phone',
      reservations: 1,
      roomNights: 4,
      roomRevenue: 1_800_000,
      commission: 0,
      netRevenue: 1_800_000,
      adr: 450_000,
      revenueShareBp: 5_625,
      avgLeadDays: 10,
      avgNights: 2,
      cancellationBp: 0,
    });
    expect(bdc).toMatchObject({
      channelCode: 'BDC',
      source: null,
      reservations: 1,
      roomNights: 2,
      roomRevenue: 1_400_000,
      commission: 210_000,
      netRevenue: 1_190_000,
      revenueShareBp: 4_375,
      avgLeadDays: 11,
    });
    expect(report.total).toMatchObject({
      reservations: 2,
      roomNights: 6,
      roomRevenue: 3_200_000,
      commission: 210_000,
      netRevenue: 2_990_000,
      adr: 533_333,
      // One of the three bookings due to arrive in the period was cancelled; the hold is not a booking.
      cancellationBp: 3_333,
    });
  });

  it('charges only the part of a commission that belongs to the nights in the period', async () => {
    const oneNight = await channelMixReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(11),
      to: day(12),
    });
    expect(oneNight.rows.find((r) => r.key === 'BDC')).toMatchObject({
      roomNights: 1,
      roomRevenue: 700_000,
      commission: 105_000,
    });
  });
});

describe('pace', () => {
  it('shows what is on the books and how much of it came in lately', async () => {
    // A booking made 20 days ago, and one made 3 days ago, for the same future night.
    const older = await book(40, 41);
    const newer = await book(40, 41);
    const dropped = await book(40, 41);
    const backdate = (id: string, days: number) =>
      t.db.execute(
        `UPDATE reservations SET created_at = now() - interval '${days} days' WHERE id = '${id}';
         UPDATE reservation_rooms SET created_at = now() - interval '${days} days' WHERE reservation_id = '${id}'`,
      );
    await backdate(older.id, 20);
    await backdate(newer.id, 3);
    // Booked 40 days ago and cancelled 2 days ago: on the books a week ago, gone now.
    await backdate(dropped.id, 40);
    await cancelReservation(t.db, org.admin, dropped.id);
    await t.db
      .update(reservations)
      .set({ cancelledAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(reservations.id, dropped.id));

    const report = await paceReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(40),
      to: day(42),
    });
    expect(report.groupBy).toBe('day');
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({
      period: day(40),
      available: 5,
      sold: 2,
      roomRevenue: 900_000,
      occupancyBp: 4_000,
      adr: 450_000,
      // A week ago: the older booking and the one since cancelled. One came, one went.
      pickup7: { roomNights: 0, roomRevenue: 0 },
      // A month ago: only the one since cancelled.
      pickup30: { roomNights: 1, roomRevenue: 450_000 },
      lastYear: { soldThen: 0, roomRevenueThen: 0, soldFinal: 0, roomRevenueFinal: 0 },
    });
    expect(report.rows[1]).toMatchObject({ period: day(41), sold: 0, adr: null });
    expect(report.total).toMatchObject({ available: 10, sold: 2, pickup30: { roomNights: 1 } });

    // Longer periods are shown by month.
    const season = await paceReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(0),
      to: day(120),
    });
    expect(season.groupBy).toBe('month');
    expect(season.rows.every((r) => /^\d{4}-\d{2}$/.test(r.period))).toBe(true);
    await expect(
      paceReport(t.db, org.orgId, { propertyIds: 'all', from: day(0), to: day(500) }),
    ).rejects.toThrow(/at most 400 days/);
  });

  it('compares with the same nights a year earlier', async () => {
    // A stay a year ago (52 weeks, so the same weekday), booked 30 days before it.
    const lastYear = await createReservation(t.db, org.admin, {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: { firstName: 'Last', lastName: 'Year' },
      rooms: [
        {
          roomTypeId: hotel.standard.roomType.id,
          ratePlanId: hotel.standard.ratePlan.id,
          checkIn: day(60 - 364),
          checkOut: day(61 - 364),
          adults: 2,
        },
      ],
    });
    await t.db.execute(
      `UPDATE reservations SET created_at = now() - interval '334 days' WHERE id = '${lastYear.id}';
       UPDATE reservation_rooms SET created_at = now() - interval '334 days', status = 'checked_out'
         WHERE reservation_id = '${lastYear.id}';
       UPDATE reservations SET status = 'checked_out' WHERE id = '${lastYear.id}'`,
    );
    const report = await paceReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(60),
      to: day(61),
    });
    // A year ago today that night had nothing on the books yet; it ended with one room sold.
    expect(report.rows[0]!.lastYear).toEqual({
      soldThen: 0,
      roomRevenueThen: 0,
      soldFinal: 1,
      roomRevenueFinal: 450_000,
    });
  });
});

describe('charges and takings', () => {
  it('adds up each hotel day from the folios', async () => {
    const stay = await book(0, 2);
    const dinner = await postCharge(t.db, org.admin, {
      reservationId: stay.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 120_000,
    });
    await postCharge(t.db, org.admin, {
      reservationId: stay.id,
      kind: 'extra',
      description: 'Airport transfer',
      unitAmount: 250_000,
    });
    await postCharge(t.db, org.admin, {
      reservationId: stay.id,
      kind: 'discount',
      description: 'Goodwill',
      unitAmount: 20_000,
      discountOn: 'food',
    });
    await recordPayment(t.db, org.admin, {
      folioId: dinner.folioId,
      method: 'upi',
      amount: 200_000,
    });
    await recordPayment(t.db, org.admin, {
      folioId: dinner.folioId,
      method: 'cash',
      amount: 50_000,
    });

    const report = await revenueReport(t.db, org.orgId, {
      propertyIds: [hotel.property.id],
      from: day(0),
      to: day(1),
    });
    expect(report.days).toHaveLength(1);
    const [first] = report.days;
    expect(first).toMatchObject({
      date: today,
      room: 0,
      food: 120_000,
      service: 0,
      other: 250_000,
      discounts: -20_000,
      payments: { upi: 200_000, cash: 50_000 },
      paymentsTotal: 250_000,
    });
    expect(first!.tax).toBeGreaterThan(0);
    expect(first!.total).toBe(350_000 + first!.tax);
    expect(report.total).toEqual({
      room: first!.room,
      food: first!.food,
      service: first!.service,
      other: first!.other,
      discounts: first!.discounts,
      tax: first!.tax,
      total: first!.total,
      payments: first!.payments,
      paymentsTotal: first!.paymentsTotal,
    });
  });
});

describe('travel agent commission', () => {
  it('is earned on the nights a guest actually stayed', async () => {
    const agent = await createCompany(t.db, org.admin, {
      kind: 'travel_agent',
      name: 'Goa Getaways',
      commissionBp: 1_000,
    });
    const arrived = await book(0, 2, { source: 'travel_agent', companyId: agent.id });
    await checkIn(t.db, org.admin, arrived.id, { allowDirty: true });
    // A booking still to come has earned nothing yet.
    await book(20, 22, { source: 'travel_agent', companyId: agent.id });

    const report = await agentCommissionReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(0),
      to: day(30),
    });
    expect(report.rows).toEqual([
      {
        companyId: agent.id,
        name: 'Goa Getaways',
        commissionBp: 1_000,
        reservations: 1,
        roomNights: 2,
        roomRevenue: 900_000,
        commission: 90_000,
      },
    ]);
    expect(report.total).toEqual({
      reservations: 1,
      roomNights: 2,
      roomRevenue: 900_000,
      commission: 90_000,
    });
    // In the channel report the agent's share shows as the cost of that business.
    const mix = await channelMixReport(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(0),
      to: day(2),
    });
    expect(mix.rows.find((r) => r.key === 'travel_agent')).toMatchObject({
      roomRevenue: 900_000,
      commission: 90_000,
      netRevenue: 810_000,
    });
  });
});
