import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, reportSchedules } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { toCsv } from './csv';
import { addDays, todayIn } from './dates';
import { MemoryMailer, type Mailer } from './mailer';
import {
  createReportSchedule,
  deleteReportSchedule,
  listReportSchedules,
  nextRunAfter,
  periodFor,
  reportCsv,
  runDueReportSchedules,
  updateReportSchedule,
} from './report-exports';
import { createReservation } from './reservations';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 4, deluxeRooms: 1 });
  await createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: 'ota',
    channelCode: 'BDC',
    commissionAmount: 135_000,
    guest: { firstName: 'Asha', lastName: 'Rao' },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(1),
        checkOut: day(3),
        adults: 2,
      },
    ],
  });
});
afterAll(async () => {
  await t.drop();
});

describe('spreadsheet files', () => {
  it('quotes what needs quoting and defuses text a spreadsheet would run as a formula', () => {
    expect(
      toCsv([
        ['Name', 'Amount', 'Note'],
        ['Sharma, R', 1200.5, 'said "fine"'],
        ['=HYPERLINK("http://evil.example")', '-450.00', '+91 98000 12345'],
        ['@cmd', null, 'two\nlines'],
      ]),
    ).toBe(
      [
        'Name,Amount,Note',
        '"Sharma, R",1200.5,"said ""fine"""',
        '"\'=HYPERLINK(""http://evil.example"")",-450.00,\'+91 98000 12345',
        '\'@cmd,,"two\nlines"',
        '',
      ].join('\r\n'),
    );
  });

  it('writes a report with its heading, its rows and its total', async () => {
    const { filename, csv } = await reportCsv(t.db, org.orgId, 'performance', {
      propertyIds: 'all',
      from: day(1),
      to: day(3),
    });
    expect(filename).toBe(`performance-${day(1)}-to-${day(2)}.csv`);
    expect(csv.split('\r\n')).toEqual([
      'Occupancy and rates',
      `${day(1)} to ${day(2)},Amounts in INR`,
      '',
      'Date,Rooms available,Rooms sold,Occupancy %,Room revenue,Average rate,Revenue per available room',
      `${day(1)},5,1,20,4500.00,4500.00,900.00`,
      `${day(2)},5,1,20,4500.00,4500.00,900.00`,
      'Total,10,2,20,9000.00,4500.00,900.00',
      '',
    ]);
    const mix = await reportCsv(t.db, org.orgId, 'channel_mix', {
      propertyIds: 'all',
      from: day(1),
      to: day(3),
    });
    expect(mix.csv).toContain('Booking.com,1,2,9000.00,1350.00,7650.00,4500.00,100,1,2,0');
    for (const kind of ['pace', 'revenue', 'agent_commission'] as const) {
      const file = await reportCsv(t.db, org.orgId, kind, {
        propertyIds: 'all',
        from: day(1),
        to: day(3),
      });
      expect(file.csv.split('\r\n').length).toBeGreaterThan(4);
    }
  });
});

describe('the dates a scheduled report covers', () => {
  it('counts from the day it runs', () => {
    const on = '2026-11-13';
    expect(periodFor('yesterday', on)).toEqual({ from: '2026-11-12', to: '2026-11-13' });
    expect(periodFor('last_7_days', on)).toEqual({ from: '2026-11-06', to: '2026-11-13' });
    expect(periodFor('last_30_days', on)).toEqual({ from: '2026-10-14', to: '2026-11-13' });
    expect(periodFor('month_to_date', on)).toEqual({ from: '2026-11-01', to: '2026-11-13' });
    expect(periodFor('last_month', on)).toEqual({ from: '2026-10-01', to: '2026-11-01' });
    expect(periodFor('next_30_days', on)).toEqual({ from: '2026-11-13', to: '2026-12-13' });
    expect(periodFor('next_90_days', on)).toEqual({ from: '2026-11-13', to: '2027-02-11' });
    // On the first of a month, "month to date" is the month that has just ended.
    expect(periodFor('month_to_date', '2027-01-01')).toEqual({
      from: '2026-12-01',
      to: '2027-01-01',
    });
    expect(periodFor('last_month', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2027-01-01' });
  });

  it('finds the next time by the organisation\u2019s clock', () => {
    const daily = { frequency: 'daily' as const, weekday: null, dayOfMonth: null, hour: 7 };
    // 13 November 2026, 05:00 in India: today's seven o'clock is still to come.
    expect(nextRunAfter(daily, new Date('2026-11-12T23:30:00Z'), 'Asia/Kolkata')).toEqual(
      new Date('2026-11-13T01:30:00Z'),
    );
    // At seven exactly it has just run: the next is tomorrow.
    expect(nextRunAfter(daily, new Date('2026-11-13T01:30:00Z'), 'Asia/Kolkata')).toEqual(
      new Date('2026-11-14T01:30:00Z'),
    );
    // Mondays at nine, asked on a Friday.
    expect(
      nextRunAfter(
        { frequency: 'weekly', weekday: 1, dayOfMonth: null, hour: 9 },
        new Date('2026-11-13T06:00:00Z'),
        'Asia/Kolkata',
      ),
    ).toEqual(new Date('2026-11-16T03:30:00Z'));
    // The first of the month at six, in a zone behind UTC.
    expect(
      nextRunAfter(
        { frequency: 'monthly', weekday: null, dayOfMonth: 1, hour: 6 },
        new Date('2026-11-13T06:00:00Z'),
        'America/New_York',
      ),
    ).toEqual(new Date('2026-12-01T11:00:00Z'));
  });
});

describe('reports sent on a schedule', () => {
  const input = {
    name: 'Morning figures',
    report: 'performance' as const,
    period: 'next_30_days' as const,
    frequency: 'daily' as const,
    hour: 7,
    recipients: ['GM@example.com', 'gm@example.com', ' owner@example.com '],
  };

  it('checks what it is given', async () => {
    await expect(
      createReportSchedule(t.db, org.admin, { ...input, recipients: [] }),
    ).rejects.toThrow(/at least one email address/);
    await expect(
      createReportSchedule(t.db, org.admin, { ...input, recipients: ['not an address'] }),
    ).rejects.toThrow(/is not an email address/);
    await expect(
      createReportSchedule(t.db, org.admin, { ...input, frequency: 'monthly', dayOfMonth: 31 }),
    ).rejects.toThrow(/between 1 and 28/);
    await expect(
      createReportSchedule(t.db, org.admin, { ...input, propertyIds: [org.adminUserId] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(
      createReportSchedule(t.db, rival.admin, { ...input, propertyIds: [hotel.property.id] }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('sends each due report once, as an attachment, and plans the next', async () => {
    const mailer = new MemoryMailer();
    const createdAt = new Date('2026-11-12T23:30:00Z');
    const schedule = await createReportSchedule(t.db, org.admin, input, createdAt);
    expect(schedule).toMatchObject({
      recipients: ['gm@example.com', 'owner@example.com'],
      groupBy: 'day',
      propertyIds: null,
      active: true,
      lastRunAt: null,
    });
    expect(schedule.nextRunAt).toEqual(new Date('2026-11-13T01:30:00Z'));
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'report_schedule.created'));
    // Who a report goes to is on record.
    expect(audit!.summary).toBe(
      'Scheduled the report "Morning figures" to gm@example.com, owner@example.com',
    );

    // Not yet due.
    expect(await runDueReportSchedules(t.db, mailer, new Date('2026-11-13T01:00:00Z'))).toEqual({
      sent: 0,
      failed: 0,
    });
    const due = new Date('2026-11-13T01:31:00Z');
    expect(await runDueReportSchedules(t.db, mailer, due)).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toEqual(['gm@example.com', 'owner@example.com']);
    expect(mail.subject).toBe('Morning figures: 2026-11-13 to 2026-12-12');
    expect(mail.attachments).toMatchObject([
      {
        filename: 'performance-2026-11-13-to-2026-12-12.csv',
        contentType: 'text/csv; charset=utf-8',
      },
    ]);
    expect(String(mail.attachments![0]!.content).split('\r\n')[0]).toBe('Occupancy and rates');
    const [after] = await t.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, schedule.id));
    expect(after).toMatchObject({ lastStatus: 'sent', lastError: null, lastRunAt: due });
    expect(after!.nextRunAt).toEqual(new Date('2026-11-14T01:30:00Z'));
    // Run again a moment later: nothing more goes out.
    expect(await runDueReportSchedules(t.db, mailer, new Date('2026-11-13T01:32:00Z'))).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(mailer.sent).toHaveLength(1);

    // A schedule that is switched off is not sent; one that is changed is planned afresh.
    await updateReportSchedule(t.db, org.admin, schedule.id, { active: false }, due);
    expect(await runDueReportSchedules(t.db, mailer, new Date('2026-11-15T00:00:00Z'))).toEqual({
      sent: 0,
      failed: 0,
    });
    const weekly = await updateReportSchedule(
      t.db,
      org.admin,
      schedule.id,
      { active: true, frequency: 'weekly', weekday: 1, hour: 9, period: 'last_7_days' },
      due,
    );
    expect(weekly).toMatchObject({ frequency: 'weekly', weekday: 1, dayOfMonth: null });
    expect(weekly.nextRunAt).toEqual(new Date('2026-11-16T03:30:00Z'));
    await deleteReportSchedule(t.db, org.admin, schedule.id);
    expect(await listReportSchedules(t.db, org.orgId)).toEqual([]);
  });

  it('says why when a report could not be sent, and tries again at the next time', async () => {
    const created = new Date('2026-11-12T23:30:00Z');
    const schedule = await createReportSchedule(t.db, org.admin, input, created);
    const noServer: Mailer = { configured: false, send: async () => ({ delivered: false }) };
    const due = new Date('2026-11-13T02:00:00Z');
    expect(await runDueReportSchedules(t.db, noServer, due)).toEqual({ sent: 0, failed: 1 });
    let [row] = await t.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, schedule.id));
    expect(row).toMatchObject({
      lastStatus: 'not_configured',
      lastError: 'No mail server is configured, so the report could not be sent.',
    });
    expect(row!.nextRunAt).toEqual(new Date('2026-11-14T01:30:00Z'));

    const broken: Mailer = {
      configured: true,
      send: async () => {
        throw new Error('Connection refused by the mail server');
      },
    };
    expect(await runDueReportSchedules(t.db, broken, new Date('2026-11-14T01:30:00Z'))).toEqual({
      sent: 0,
      failed: 1,
    });
    [row] = await t.db.select().from(reportSchedules).where(eq(reportSchedules.id, schedule.id));
    expect(row).toMatchObject({
      lastStatus: 'failed',
      lastError: 'Connection refused by the mail server',
    });
    await deleteReportSchedule(t.db, org.admin, schedule.id);
  });
});
