import { addDays, diffDays, monthOf } from '@pms/domain/shared';
import { formatDate, formatDay, plural } from '@/lib/format';
import type { ReportKey } from './views';

export type PeriodKey =
  | 'this_month'
  | 'last_month'
  | 'last_30_days'
  | 'last_7_days'
  | 'this_year'
  | 'next_30_days'
  | 'next_90_days'
  | 'next_month'
  | 'custom';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_30_days: 'Last 30 days',
  last_7_days: 'Last 7 days',
  this_year: 'This year',
  next_30_days: 'Next 30 days',
  next_90_days: 'Next 90 days',
  next_month: 'Next month',
  custom: 'Custom',
};

const LOOKING_BACK: PeriodKey[] = [
  'this_month',
  'last_month',
  'last_30_days',
  'last_7_days',
  'this_year',
  'custom',
];
const LOOKING_AHEAD: PeriodKey[] = [
  'next_30_days',
  'next_90_days',
  'this_month',
  'next_month',
  'custom',
];

/** The periods offered for a report, the first being the one it opens with. Pace looks forward. */
export function periodsFor(view: ReportKey): PeriodKey[] {
  return view === 'pace' ? LOOKING_AHEAD : LOOKING_BACK;
}

/** A period as people read it: both dates are days it covers. */
export interface Span {
  from: string;
  to: string;
}

/**
 * The dates a named period covers on `today`. "Last" periods end yesterday and "next" periods
 * start today, as the same periods do in a scheduled email.
 */
export function presetSpan(period: Exclude<PeriodKey, 'custom'>, today: string): Span {
  const month = monthOf(today);
  switch (period) {
    case 'this_month':
      return { from: month.start, to: addDays(month.end, -1) };
    case 'last_month':
      return { from: monthOf(addDays(month.start, -1)).start, to: addDays(month.start, -1) };
    case 'last_30_days':
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case 'last_7_days':
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'next_30_days':
      return { from: today, to: addDays(today, 29) };
    case 'next_90_days':
      return { from: today, to: addDays(today, 89) };
    case 'next_month':
      return { from: month.end, to: addDays(monthOf(month.end).end, -1) };
  }
}

export function daysIn(span: Span): number {
  return diffDays(span.from, span.to) + 1;
}

/** `1 Nov to 30 Nov 2026`: the year is said once when both dates are in it. */
export function spanText(span: Span): string {
  if (span.from === span.to) return formatDate(span.from);
  const sameYear = span.from.slice(0, 4) === span.to.slice(0, 4);
  return `${sameYear ? formatDay(span.from) : formatDate(span.from)} to ${formatDate(span.to)}`;
}

export function daysText(span: Span): string {
  return plural(daysIn(span), 'day');
}

/** The dates a report answered for, as people read them. The server's `to` is the first day left out. */
export function reportSpan(report: { from: string; to: string }): Span {
  return { from: report.from, to: addDays(report.to, -1) };
}
