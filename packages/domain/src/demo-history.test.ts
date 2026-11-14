import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  conversations,
  invoices,
  nightAudits,
  ownerStatements,
  properties,
  reservationRooms,
  reservations,
} from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { addDays, monthOf, todayIn } from './dates';
import { seedDemoHistory, type DemoHistorySummary } from './demo-history';
import { seedDemo } from './demo-seed';
import { getGroup, listGroups } from './groups';
import { findLedgerMismatches } from './inventory';
import { taxRegister } from './registers';
import { performanceReport, revenueReport } from './reports';

let t: TestDatabase;
let orgId: string;
let summary: DemoHistorySummary;
const today = todayIn('Asia/Kolkata');

beforeAll(async () => {
  t = await createTestDatabase();
  ({ orgId } = await seedDemo(t.db));
  summary = await seedDemoHistory(t.db, orgId, { days: 21 });
}, 240_000);
afterAll(async () => {
  await t.drop();
});

describe('three weeks of demo life', () => {
  it('ends on today at every property, with every night closed on the way', async () => {
    const all = await t.db.select().from(properties).where(eq(properties.orgId, orgId));
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.businessDate)).toEqual([today, today, today]);
    const audits = await t.db.select().from(nightAudits);
    expect(audits).toHaveLength(3 * 21);
    expect(audits.every((a) => a.status === 'completed')).toBe(true);
    expect(summary.stays).toBeGreaterThan(20);
    expect(summary.checkedOut).toBeGreaterThan(15);
    expect(summary.inHouse).toBeGreaterThan(0);
  });

  it('leaves nobody in a room past their departure, and no room double booked', async () => {
    const overdue = await t.db
      .select({ id: reservationRooms.id })
      .from(reservationRooms)
      .where(
        and(
          eq(reservationRooms.status, 'in_house'),
          sql`${reservationRooms.checkOut} < ${today}::date`,
        ),
      );
    expect(overdue).toEqual([]);
    const { rows: clashes } = await t.db.execute(sql`
      SELECT a.id FROM reservation_rooms a JOIN reservation_rooms b
        ON a.unit_id = b.unit_id AND a.id < b.id
       AND a.status IN ('confirmed', 'in_house', 'checked_out')
       AND b.status IN ('confirmed', 'in_house', 'checked_out')
       AND daterange(a.check_in, a.check_out) && daterange(b.check_in, b.check_out)
    `);
    expect(clashes).toEqual([]);
    const flagged = await t.db
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.overbooked, true));
    expect(flagged).toEqual([]);
  });

  it('has books that balance: whoever left has paid, or is on a company account', async () => {
    const { rows } = await t.db.execute<{ code: string; balance: string }>(sql`
      SELECT r.code, sum(l.amount + l.tax_amount)::text AS balance
      FROM reservations r
      JOIN folios f ON f.reservation_id = r.id AND f.kind = 'guest'
      JOIN folio_lines l ON l.folio_id = f.id AND l.voided_at IS NULL
      WHERE r.status = 'checked_out'
      GROUP BY r.code HAVING sum(l.amount + l.tax_amount) <> 0
    `);
    expect(rows).toEqual([]);
    const issued = await t.db.select().from(invoices);
    expect(issued.length).toBe(summary.invoices);
    expect(issued.length).toBeGreaterThan(10);
    // Numbers run without a gap within each property and series.
    const { rows: gaps } = await t.db.execute(sql`
      SELECT property_id, type, fiscal_year FROM invoices
      GROUP BY property_id, type, fiscal_year HAVING max(sequence) <> count(*)
    `);
    expect(gaps).toEqual([]);
  });

  it('gives the reports, the tax register and the owners something to show', async () => {
    const window = { propertyIds: 'all' as const, from: addDays(today, -21), to: today };
    const performance = await performanceReport(t.db, orgId, { ...window, groupBy: 'day' });
    expect(performance.total.sold).toBeGreaterThan(40);
    expect(performance.total.occupancyBp).toBeGreaterThan(1000);
    const takings = await revenueReport(t.db, orgId, window);
    expect(takings.total.room).toBeGreaterThan(0);
    expect(takings.total.food).toBeGreaterThan(0);
    expect(Object.keys(takings.total.payments).length).toBeGreaterThan(1);
    const register = await taxRegister(t.db, orgId, window);
    expect(register.total.invoices).toBe(summary.invoices);
    expect(register.total.total).toBeGreaterThan(0);

    const statements = await t.db.select().from(ownerStatements);
    expect(statements.map((s) => s.status).sort()).toEqual(['draft', 'issued']);
    expect(statements.find((s) => s.status === 'issued')!.number).toMatch(/^AZR\/OS\//);
    expect(statements[0]!.periodStart).toBe(monthOf(addDays(monthOf(today).start, -1)).start);
  });

  it('has two groups holding rooms at the hotel, each with a booking made', async () => {
    const [hotel] = await t.db.select().from(properties).where(eq(properties.code, 'GOA'));
    const groups = await listGroups(t.db, orgId, { propertyId: hotel!.id });
    expect(groups.map((g) => g.name)).toEqual([
      'Konkan Software Labs offsite',
      'Fernandes wedding',
    ]);
    for (const group of groups) {
      expect(group.heldNights).toBeGreaterThan(0);
      expect(group.bookings).toBeGreaterThan(0);
      expect(group.leftNights).toBeLessThan(group.heldNights);
    }
    // The rooms the offsite booked are billed to the company the group is for.
    const offsite = await getGroup(t.db, orgId, groups[0]!.id);
    expect(offsite.company?.name).toBe('Konkan Software Labs');
    expect(offsite.reservations.map((r) => r.guestName)).toEqual(['Ishaan Verma', 'Meera Pillai']);
    expect(
      await findLedgerMismatches(t.db, {
        propertyId: hotel!.id,
        range: { from: today, to: addDays(today, 60) },
      }),
    ).toEqual([]);
  });

  it('has messages waiting in the inbox and nothing alarming on the alert list', async () => {
    const threads = await t.db.select().from(conversations);
    expect(threads.length).toBe(summary.conversations);
    expect(threads.length).toBeGreaterThan(3);
    expect(threads.every((c) => c.unreadCount > 0)).toBe(true);
    const critical = await t.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.severity, 'critical'), eq(alerts.status, 'open')));
    expect(critical.map((a) => a.title)).toEqual([]);
  });
});
