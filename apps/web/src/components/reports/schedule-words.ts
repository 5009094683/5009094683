import { plural } from '@/lib/format';
import type { Property } from '@/lib/types';
import type { ReportFrequency, ReportKind, ReportPeriod, Schedule } from './types';

/** The reports by the names their tabs have. */
export const REPORT_LABELS: Record<ReportKind, string> = {
  performance: 'Performance',
  channel_mix: 'Where bookings come from',
  pace: 'Pace',
  revenue: 'Takings',
  agent_commission: 'Travel agents',
};

/** The dates a scheduled report covers, counted from the day it is sent. */
export const PERIOD_WORDS: Record<ReportPeriod, { label: string; covers: string }> = {
  yesterday: { label: 'Yesterday', covers: 'The day before the report is sent.' },
  last_7_days: { label: 'Last 7 days', covers: 'The 7 days before the day the report is sent.' },
  last_30_days: {
    label: 'Last 30 days',
    covers: 'The 30 days before the day the report is sent.',
  },
  month_to_date: {
    label: 'This month so far',
    covers:
      'From the 1st of the month to the day before the report is sent. Sent on the 1st, it covers the whole month just ended.',
  },
  last_month: { label: 'Last month', covers: 'The whole month before the report is sent.' },
  next_30_days: {
    label: 'Next 30 days',
    covers: 'The 30 days starting on the day the report is sent.',
  },
  next_90_days: {
    label: 'Next 90 days',
    covers: 'The 90 days starting on the day the report is sent.',
  },
};

export const PERIODS_BACK: ReportPeriod[] = [
  'yesterday',
  'last_7_days',
  'last_30_days',
  'month_to_date',
  'last_month',
];
export const PERIODS_AHEAD: ReportPeriod[] = ['next_30_days', 'next_90_days'];

export const FREQUENCY_LABELS: Record<ReportFrequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

/** Days of the week as the API numbers them (0 is Sunday), in the order a week is read. */
export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

/** The days of a month a report can go out on: every month has a 28th. */
export const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, index) => index + 1);
export const HOURS = Array.from({ length: 24 }, (_, index) => index);

/** `8:00`, `14:00` */
export function hourText(hour: number): string {
  return `${hour}:00`;
}

/** `1st`, `2nd`, `3rd`, `11th`, `22nd` */
export function ordinal(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
  return `${day}${suffix}`;
}

/** When a schedule goes out, in words: `Every Monday at 8:00`. */
export function whenText(
  schedule: Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth' | 'hour'>,
): string {
  const at = `at ${hourText(schedule.hour)}`;
  switch (schedule.frequency) {
    case 'daily':
      return `Every day ${at}`;
    case 'weekly': {
      const day = WEEKDAYS.find((weekday) => weekday.value === (schedule.weekday ?? 1));
      return `Every ${day?.label ?? 'week'} ${at}`;
    }
    case 'monthly':
      return `On the ${ordinal(schedule.dayOfMonth ?? 1)} of every month ${at}`;
  }
}

/** The properties a schedule covers, by name where there are few. */
export function coversText(
  schedule: Pick<Schedule, 'propertyIds'>,
  properties: Property[],
): string {
  const ids = schedule.propertyIds;
  if (ids === null || ids.length === 0) return 'All properties';
  const names = ids.map((id) => properties.find((p) => p.id === id)?.name);
  // A property the list does not have yet: say how many rather than leave a gap.
  if (names.length > 3 || names.some((name) => name === undefined)) {
    return plural(ids.length, 'property', 'properties');
  }
  return names.join(', ');
}

const runTime = (timeZone: string | undefined) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });

/**
 * `Mon 16 Nov, 8:00`, by the organisation's clock, which is the clock schedules run by. The
 * viewer's own clock when the organisation's time zone is not known.
 */
export function runTimeText(moment: string, timeZone: string | undefined): string {
  try {
    return runTime(timeZone).format(new Date(moment));
  } catch {
    return runTime(undefined).format(new Date(moment));
  }
}
