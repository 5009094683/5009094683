import { CHANNEL_NAMES, SOURCE_LABELS } from '@pms/domain/shared';

const fractionDigitsCache = new Map<string, number>();

function fractionDigits(currency: string): number {
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    fractionDigitsCache.set(currency, digits);
  }
  return digits;
}

/** Converts minor units (paise, cents) to the major-unit number for display or editing. */
export function fromMinor(amount: number, currency: string): number {
  return amount / 10 ** fractionDigits(currency);
}

export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** fractionDigits(currency));
}

/** `₹4,500` from 450000. Whole amounts drop the decimals. */
export function formatMoney(
  amount: number,
  currency: string,
  options: { compact?: boolean } = {},
): string {
  const value = fromMinor(amount, currency);
  const whole = Number.isInteger(value);
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', {
      style: 'currency',
      currency,
      notation: options.compact ? 'compact' : 'standard',
      minimumFractionDigits: whole || options.compact ? 0 : fractionDigits(currency),
      maximumFractionDigits: options.compact ? 1 : fractionDigits(currency),
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

/** A bare number for dense grids: `4,500`. */
export function formatAmount(amount: number, currency: string): string {
  const value = fromMinor(amount, currency);
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', {
    maximumFractionDigits: 0,
  }).format(value);
}

function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

const dayMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayDayMonth = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const monthYear = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });

/** `12 Dec` */
export const formatDay = (date: string): string => dayMonth.format(parse(date));
/** `12 Dec 2026` */
export const formatDate = (date: string): string => dayMonthYear.format(parse(date));
/** `Sat 12 Dec` */
export const formatWeekday = (date: string): string => weekdayDayMonth.format(parse(date));
/** `December 2026` */
export const formatMonth = (date: string): string => monthYear.format(parse(date));
/** `Sat` */
export const formatWeekdayName = (date: string): string => weekdayShort.format(parse(date));

/** `12 – 15 Dec 2026`, or `30 Dec 2026 – 2 Jan 2027` across a year end. */
export function formatStay(checkIn: string, checkOut: string): string {
  const sameYear = checkIn.slice(0, 4) === checkOut.slice(0, 4);
  const sameMonth = sameYear && checkIn.slice(5, 7) === checkOut.slice(5, 7);
  if (sameMonth) return `${Number(checkIn.slice(8))} – ${formatDate(checkOut)}`;
  if (sameYear) return `${formatDay(checkIn)} – ${formatDate(checkOut)}`;
  return `${formatDate(checkIn)} – ${formatDate(checkOut)}`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** A timestamp in the viewer's own time zone: `13 Nov, 17:05`. */
export function formatDateTime(value: string | Date): string {
  return dateTime.format(typeof value === 'string' ? new Date(value) : value);
}

/** `3 min ago`, `2 h ago`, `5 d ago`. */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const then = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// One list of names for booking sites and sources, shared with what the server writes.
export { CHANNEL_NAMES, SOURCE_LABELS };

/** What to call where a reservation came from: the channel when there is one, else the source. */
export function sourceLabel(source: string, channelCode: string | null): string {
  if (channelCode) return CHANNEL_NAMES[channelCode.toUpperCase()] ?? channelCode;
  return SOURCE_LABELS[source] ?? source;
}

export const STATUS_LABELS: Record<string, string> = {
  tentative: 'Tentative',
  confirmed: 'Confirmed',
  in_house: 'In house',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};
