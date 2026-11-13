import { and, asc, eq, lte } from 'drizzle-orm';
import {
  organizations,
  PAYMENT_METHODS,
  properties,
  REPORT_FREQUENCIES,
  REPORT_KINDS,
  REPORT_PERIODS,
  reportSchedules,
  type DbOrTx,
  type ReportFrequency,
  type ReportKind,
  type ReportPeriod,
} from '@pms/db';
import { diff, writeAudit } from './audit';
import type { Actor } from './context';
import { toCsv, type CsvCell } from './csv';
import { addDays, dayOfWeek, monthOf, timeIn, todayIn, type DateString } from './dates';
import { notFound, validationError } from './errors';
import type { Mailer } from './mailer';
import { minorToDecimal } from './money';
import {
  agentCommissionReport,
  channelMixReport,
  paceReport,
  PERFORMANCE_GROUPINGS,
  performanceReport,
  revenueReport,
  type PerformanceGrouping,
  type ReportWindow,
} from './reports';
import { sourceName } from './source-labels';
import { transact } from './sqlx';

export type ReportScheduleRow = typeof reportSchedules.$inferSelect;

export const REPORT_TITLES: Record<ReportKind, string> = {
  performance: 'Occupancy and rates',
  channel_mix: 'Where bookings came from',
  pace: 'Pace',
  revenue: 'Charges and takings',
  agent_commission: 'Travel agent commission',
};

const percent = (bp: number | null): number | null => (bp === null ? null : bp / 100);

/** Any of the reports as rows for a spreadsheet: a heading row, the figures, and a total. */
export async function reportCsv(
  db: DbOrTx,
  orgId: string,
  kind: ReportKind,
  input: ReportWindow & { groupBy?: string; now?: Date },
): Promise<{ filename: string; csv: string }> {
  let rows: CsvCell[][];
  let currency: string | null;
  switch (kind) {
    case 'performance': {
      const groupBy = (PERFORMANCE_GROUPINGS as readonly string[]).includes(input.groupBy ?? '')
        ? (input.groupBy as PerformanceGrouping)
        : 'day';
      const report = await performanceReport(db, orgId, { ...input, groupBy });
      currency = report.currency;
      const money = moneyIn(currency);
      const line = (r: (typeof report.rows)[number]): CsvCell[] => [
        r.label,
        r.available,
        r.sold,
        percent(r.occupancyBp),
        money(r.roomRevenue),
        money(r.adr),
        money(r.revpar),
      ];
      rows = [
        [
          {
            day: 'Date',
            week: 'Week',
            month: 'Month',
            property: 'Property',
            room_type: 'Room type',
          }[groupBy],
          'Rooms available',
          'Rooms sold',
          'Occupancy %',
          'Room revenue',
          'Average rate',
          'Revenue per available room',
        ],
        ...report.rows.map(line),
        line(report.total),
      ];
      break;
    }
    case 'channel_mix': {
      const report = await channelMixReport(db, orgId, input);
      currency = report.currency;
      const money = moneyIn(currency);
      const line = (label: string, r: (typeof report)['total']): CsvCell[] => [
        label,
        r.reservations,
        r.roomNights,
        money(r.roomRevenue),
        money(r.commission),
        money(r.netRevenue),
        money(r.adr),
        percent(r.revenueShareBp),
        r.avgLeadDays,
        r.avgNights,
        percent(r.cancellationBp),
      ];
      rows = [
        [
          'Source',
          'Bookings',
          'Room nights',
          'Room revenue',
          'Commission',
          'Revenue after commission',
          'Average rate',
          'Share of revenue %',
          'Days booked ahead',
          'Nights per stay',
          'Cancelled %',
        ],
        ...report.rows.map((r) => line(sourceName(r.key), r)),
        line('Total', report.total),
      ];
      break;
    }
    case 'pace': {
      const report = await paceReport(db, orgId, {
        ...input,
        groupBy: input.groupBy === 'day' || input.groupBy === 'month' ? input.groupBy : undefined,
      });
      currency = report.currency;
      const money = moneyIn(currency);
      const line = (label: string, r: (typeof report)['total']): CsvCell[] => [
        label,
        r.available,
        r.sold,
        percent(r.occupancyBp),
        money(r.roomRevenue),
        money(r.adr),
        r.pickup7.roomNights,
        money(r.pickup7.roomRevenue),
        r.pickup30.roomNights,
        money(r.pickup30.roomRevenue),
        r.lastYear.soldThen,
        money(r.lastYear.roomRevenueThen),
        r.lastYear.soldFinal,
        money(r.lastYear.roomRevenueFinal),
      ];
      rows = [
        [
          report.groupBy === 'day' ? 'Date' : 'Month',
          'Rooms available',
          'Rooms sold',
          'Occupancy %',
          'Room revenue',
          'Average rate',
          'Room nights added in 7 days',
          'Revenue added in 7 days',
          'Room nights added in 30 days',
          'Revenue added in 30 days',
          'Last year at this point: rooms sold',
          'Last year at this point: revenue',
          'Last year in the end: rooms sold',
          'Last year in the end: revenue',
        ],
        ...report.rows.map((r) => line(r.period, r)),
        line('Total', report.total),
      ];
      break;
    }
    case 'revenue': {
      const report = await revenueReport(db, orgId, input);
      currency = report.currency;
      const money = moneyIn(currency);
      const line = (label: string, r: (typeof report)['total']): CsvCell[] => [
        label,
        money(r.room),
        money(r.food),
        money(r.service),
        money(r.other),
        money(r.discounts),
        money(r.tax),
        money(r.total),
        ...PAYMENT_METHODS.map((method) => money(r.payments[method] ?? 0)),
        money(r.paymentsTotal),
      ];
      rows = [
        [
          'Hotel day',
          'Rooms',
          'Food and drink',
          'Services',
          'Extras and fees',
          'Discounts',
          'Tax',
          'Total charged',
          ...PAYMENT_METHODS.map((method) => `Paid: ${method.replace('_', ' ')}`),
          'Total paid',
        ],
        ...report.days.map((d) => line(d.date, d)),
        line('Total', report.total),
      ];
      break;
    }
    case 'agent_commission': {
      const report = await agentCommissionReport(db, orgId, input);
      currency = report.currency;
      const money = moneyIn(currency);
      rows = [
        ['Travel agent', 'Commission %', 'Bookings', 'Room nights', 'Room revenue', 'Commission'],
        ...report.rows.map((r) => [
          r.name,
          r.commissionBp / 100,
          r.reservations,
          r.roomNights,
          money(r.roomRevenue),
          money(r.commission),
        ]),
        [
          'Total',
          null,
          report.total.reservations,
          report.total.roomNights,
          money(report.total.roomRevenue),
          money(report.total.commission),
        ],
      ];
      break;
    }
  }
  return {
    filename: `${kind.replace('_', '-')}-${input.from}-to-${addDays(input.to, -1)}.csv`,
    csv: toCsv([
      [REPORT_TITLES[kind]],
      [`${input.from} to ${addDays(input.to, -1)}`, currency ? `Amounts in ${currency}` : null],
      [],
      ...rows,
    ]),
  };
}

function moneyIn(currency: string | null): (amount: number | null) => string | null {
  return (amount) => (amount === null || !currency ? null : minorToDecimal(amount, currency));
}

// ---------------------------------------------------------------------------
// Reports sent by email on a schedule

/** The dates a scheduled report covers when it runs on `today`. */
export function periodFor(
  period: ReportPeriod,
  today: DateString,
): { from: DateString; to: DateString } {
  switch (period) {
    case 'yesterday':
      return { from: addDays(today, -1), to: today };
    case 'last_7_days':
      return { from: addDays(today, -7), to: today };
    case 'last_30_days':
      return { from: addDays(today, -30), to: today };
    case 'month_to_date': {
      // On the first of a month there is nothing of it to report yet: the month just ended is sent.
      const month = monthOf(today);
      return month.start === today
        ? { from: monthOf(addDays(today, -1)).start, to: today }
        : { from: month.start, to: today };
    }
    case 'last_month': {
      const end = monthOf(today).start;
      return { from: monthOf(addDays(end, -1)).start, to: end };
    }
    case 'next_30_days':
      return { from: today, to: addDays(today, 30) };
    case 'next_90_days':
      return { from: today, to: addDays(today, 90) };
  }
}

interface When {
  frequency: ReportFrequency;
  weekday: number | null;
  dayOfMonth: number | null;
  hour: number;
}

/** The moment that is `hour`:00 on `date` by the clock of `timezone`. */
function atHour(date: DateString, hour: number, timezone: string): Date {
  // Start from the same wall-clock time in UTC, then correct by the zone's offset at that moment.
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const shown = timeIn(timezone, guess);
  const shownDate = todayIn(timezone, guess);
  const drift =
    (Date.parse(`${shownDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 60_000 +
    (shown.hour - hour) * 60 +
    shown.minute;
  return new Date(guess.getTime() - drift * 60_000);
}

/** The next time a schedule is due after `after`, by the organisation's clock. */
export function nextRunAfter(when: When, after: Date, timezone: string): Date {
  let date = todayIn(timezone, after);
  for (let i = 0; i < 400; i++) {
    const fits =
      when.frequency === 'daily' ||
      (when.frequency === 'weekly' && dayOfWeek(date) === (when.weekday ?? 1)) ||
      (when.frequency === 'monthly' && Number(date.slice(8, 10)) === (when.dayOfMonth ?? 1));
    if (fits) {
      const at = atHour(date, when.hour, timezone);
      if (at.getTime() > after.getTime()) return at;
    }
    date = addDays(date, 1);
  }
  throw new Error('No next run could be found for this schedule');
}

export interface ReportScheduleInput {
  name: string;
  report: ReportKind;
  groupBy?: string | null;
  /** Null: every property of the organisation. */
  propertyIds?: string[] | null;
  period: ReportPeriod;
  frequency: ReportFrequency;
  weekday?: number | null;
  dayOfMonth?: number | null;
  hour?: number;
  recipients: string[];
  active?: boolean;
}

interface CleanSchedule extends When {
  name: string;
  report: ReportKind;
  groupBy: string | null;
  propertyIds: string[] | null;
  period: ReportPeriod;
  recipients: string[];
  active: boolean;
}

async function cleanSchedule(
  tx: DbOrTx,
  orgId: string,
  input: ReportScheduleInput,
): Promise<CleanSchedule> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw validationError('Give the schedule a name');
  if (!REPORT_KINDS.includes(input.report)) throw validationError('Choose a report');
  if (!REPORT_PERIODS.includes(input.period)) throw validationError('Choose the dates to cover');
  if (!REPORT_FREQUENCIES.includes(input.frequency)) throw validationError('Choose how often');
  const hour = input.hour ?? 7;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw validationError('The hour must be between 0 and 23');
  }
  const weekday = input.frequency === 'weekly' ? (input.weekday ?? 1) : null;
  if (weekday !== null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) {
    throw validationError('Choose a day of the week');
  }
  const dayOfMonth = input.frequency === 'monthly' ? (input.dayOfMonth ?? 1) : null;
  if (dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw validationError(
      'The day of the month must be between 1 and 28, so that every month has it',
    );
  }
  const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))].filter(
    Boolean,
  );
  if (recipients.length === 0) throw validationError('Add at least one email address');
  if (recipients.length > 20) throw validationError('A report goes to at most 20 addresses');
  for (const address of recipients) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      throw validationError(`"${address}" is not an email address`);
    }
  }
  let propertyIds: string[] | null = null;
  if (input.propertyIds && input.propertyIds.length > 0) {
    propertyIds = [...new Set(input.propertyIds)];
    const found = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.orgId, orgId));
    const known = new Set(found.map((p) => p.id));
    const unknown = propertyIds.find((id) => !known.has(id));
    if (unknown) throw notFound('Property', unknown);
  }
  let groupBy: string | null = null;
  if (input.report === 'performance') {
    groupBy = (PERFORMANCE_GROUPINGS as readonly string[]).includes(input.groupBy ?? '')
      ? input.groupBy!
      : 'day';
  } else if (input.report === 'pace') {
    groupBy = input.groupBy === 'day' || input.groupBy === 'month' ? input.groupBy : null;
  }
  return {
    name,
    report: input.report,
    groupBy,
    propertyIds,
    period: input.period,
    frequency: input.frequency,
    weekday,
    dayOfMonth,
    hour,
    recipients,
    active: input.active ?? true,
  };
}

async function timezoneOf(tx: DbOrTx, orgId: string): Promise<string> {
  const [org] = await tx
    .select({ timezone: organizations.defaultTimezone })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.timezone ?? 'UTC';
}

export async function createReportSchedule(
  db: DbOrTx,
  actor: Actor,
  input: ReportScheduleInput,
  now: Date = new Date(),
): Promise<ReportScheduleRow> {
  return transact(db, async (tx) => {
    const values = await cleanSchedule(tx, actor.orgId, input);
    const [row] = await tx
      .insert(reportSchedules)
      .values({
        ...values,
        orgId: actor.orgId,
        createdBy: actor.userId ?? null,
        nextRunAt: nextRunAfter(values, now, await timezoneOf(tx, actor.orgId)),
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'report_schedule.created',
      entityType: 'report_schedule',
      entityId: row!.id,
      summary: `Scheduled the report "${row!.name}" to ${row!.recipients.join(', ')}`,
      changes: { report: row!.report, frequency: row!.frequency, recipients: row!.recipients },
    });
    return row!;
  });
}

async function requireSchedule(
  tx: DbOrTx,
  orgId: string,
  scheduleId: string,
): Promise<ReportScheduleRow> {
  const [row] = await tx
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.orgId, orgId)));
  if (!row) throw notFound('Report schedule', scheduleId);
  return row;
}

export async function updateReportSchedule(
  db: DbOrTx,
  actor: Actor,
  scheduleId: string,
  patch: Partial<ReportScheduleInput>,
  now: Date = new Date(),
): Promise<ReportScheduleRow> {
  return transact(db, async (tx) => {
    const before = await requireSchedule(tx, actor.orgId, scheduleId);
    const values = await cleanSchedule(tx, actor.orgId, {
      name: patch.name ?? before.name,
      report: patch.report ?? before.report,
      groupBy: patch.groupBy === undefined ? before.groupBy : patch.groupBy,
      propertyIds: patch.propertyIds === undefined ? before.propertyIds : patch.propertyIds,
      period: patch.period ?? before.period,
      frequency: patch.frequency ?? before.frequency,
      weekday: patch.weekday === undefined ? before.weekday : patch.weekday,
      dayOfMonth: patch.dayOfMonth === undefined ? before.dayOfMonth : patch.dayOfMonth,
      hour: patch.hour ?? before.hour,
      recipients: patch.recipients ?? before.recipients,
      active: patch.active ?? before.active,
    });
    const [row] = await tx
      .update(reportSchedules)
      .set({
        ...values,
        nextRunAt: nextRunAfter(values, now, await timezoneOf(tx, actor.orgId)),
      })
      .where(eq(reportSchedules.id, scheduleId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'report_schedule.updated',
      entityType: 'report_schedule',
      entityId: scheduleId,
      summary: `Changed the scheduled report "${row!.name}"`,
      changes: diff(before, values),
    });
    return row!;
  });
}

export async function deleteReportSchedule(
  db: DbOrTx,
  actor: Actor,
  scheduleId: string,
): Promise<void> {
  await transact(db, async (tx) => {
    const before = await requireSchedule(tx, actor.orgId, scheduleId);
    await tx.delete(reportSchedules).where(eq(reportSchedules.id, scheduleId));
    await writeAudit(tx, actor, {
      action: 'report_schedule.deleted',
      entityType: 'report_schedule',
      entityId: scheduleId,
      summary: `Stopped the scheduled report "${before.name}"`,
    });
  });
}

export async function listReportSchedules(db: DbOrTx, orgId: string): Promise<ReportScheduleRow[]> {
  return db
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.orgId, orgId))
    .orderBy(asc(reportSchedules.name));
}

/** Works a schedule's report out for the dates it covers today and sends it. */
export async function sendScheduledReport(
  db: DbOrTx,
  mailer: Mailer,
  schedule: ReportScheduleRow,
  now: Date = new Date(),
): Promise<{ status: 'sent' | 'failed' | 'not_configured'; error?: string }> {
  const timezone = await timezoneOf(db, schedule.orgId);
  const window = periodFor(schedule.period, todayIn(timezone, now));
  try {
    if (!mailer.configured) {
      return {
        status: 'not_configured',
        error: 'No mail server is configured, so the report could not be sent.',
      };
    }
    const { filename, csv } = await reportCsv(db, schedule.orgId, schedule.report, {
      propertyIds: schedule.propertyIds ?? 'all',
      ...window,
      groupBy: schedule.groupBy ?? undefined,
      now,
    });
    const span = `${window.from} to ${addDays(window.to, -1)}`;
    await mailer.send({
      to: schedule.recipients,
      subject: `${schedule.name}: ${span}`,
      text: `${REPORT_TITLES[schedule.report]} for ${span} is attached.\n\nThis report is sent ${
        { daily: 'every day', weekly: 'every week', monthly: 'every month' }[schedule.frequency]
      }. To change or stop it, open Reports in the property management system.`,
      attachments: [{ filename, content: csv, contentType: 'text/csv; charset=utf-8' }],
    });
    return { status: 'sent' };
  } catch (err) {
    return {
      status: 'failed',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }
}

/**
 * Sends every scheduled report that is due. Run by the worker. Each schedule
 * is claimed with a row lock, so two workers never send the same report, and
 * its next time is set whether or not the sending worked: a report that
 * failed is not sent late, it is sent next time.
 */
export async function runDueReportSchedules(
  db: DbOrTx,
  mailer: Mailer,
  now: Date = new Date(),
): Promise<{ sent: number; failed: number }> {
  const outcome = { sent: 0, failed: 0 };
  for (let i = 0; i < 100; i++) {
    const done = await transact(db, async (tx) => {
      const [schedule] = await tx
        .select()
        .from(reportSchedules)
        .where(and(eq(reportSchedules.active, true), lte(reportSchedules.nextRunAt, now)))
        .orderBy(asc(reportSchedules.nextRunAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!schedule) return true;
      const result = await sendScheduledReport(tx, mailer, schedule, now);
      if (result.status === 'sent') outcome.sent++;
      else outcome.failed++;
      await tx
        .update(reportSchedules)
        .set({
          lastRunAt: now,
          lastStatus: result.status,
          lastError: result.error ?? null,
          nextRunAt: nextRunAfter(schedule, now, await timezoneOf(tx, schedule.orgId)),
        })
        .where(eq(reportSchedules.id, schedule.id));
      return false;
    });
    if (done) break;
  }
  return outcome;
}
