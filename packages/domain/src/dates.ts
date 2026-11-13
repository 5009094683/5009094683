import { validationError } from './errors';

/**
 * Stay dates are calendar dates in the property's own time zone, carried as
 * `YYYY-MM-DD` strings end to end. They are never converted to JS Date
 * objects in local time, which would shift them across time zones.
 */
export type DateString = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function toEpochDay(date: DateString): number {
  const m = DATE_RE.exec(date);
  if (!m) throw validationError(`Invalid date "${date}", expected YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw validationError(`Invalid date "${date}"`);
  }
  return ms / DAY_MS;
}

function fromEpochDay(day: number): DateString {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function isValidDate(value: unknown): value is DateString {
  if (typeof value !== 'string') return false;
  try {
    toEpochDay(value);
    return true;
  } catch {
    return false;
  }
}

export function assertDate(value: string): DateString {
  toEpochDay(value);
  return value;
}

export function addDays(date: DateString, days: number): DateString {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function diffDays(from: DateString, to: DateString): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Every date in the half-open range [from, to). */
export function eachDate(from: DateString, to: DateString): DateString[] {
  const start = toEpochDay(from);
  const end = toEpochDay(to);
  const out: DateString[] = [];
  for (let d = start; d < end; d++) out.push(fromEpochDay(d));
  return out;
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: DateString): number {
  return new Date(toEpochDay(date) * DAY_MS).getUTCDay();
}

export function minDate(a: DateString, b: DateString): DateString {
  return a <= b ? a : b;
}

export function maxDate(a: DateString, b: DateString): DateString {
  return a >= b ? a : b;
}

/** Today's calendar date in an IANA time zone. */
export function todayIn(timezone: string, now: Date = new Date()): DateString {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Wall-clock hour and minute in an IANA time zone. */
export function timeIn(timezone: string, now: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get('hour'), minute: get('minute') };
}

export interface DateRange {
  /** Inclusive. */
  from: DateString;
  /** Exclusive. */
  to: DateString;
}

export function assertRange(from: string, to: string, what = 'date range'): DateRange {
  assertDate(from);
  assertDate(to);
  if (to <= from) throw validationError(`The ${what} must end after it starts`);
  return { from, to };
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.from < b.to && b.from < a.to;
}

/** Merges overlapping or touching ranges into the fewest ranges covering the same dates. */
export function mergeRanges(ranges: DateRange[]): DateRange[] {
  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: DateRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Groups a sorted or unsorted list of dates into consecutive half-open ranges. */
export function datesToRanges(dates: DateString[]): DateRange[] {
  const days = [...new Set(dates)].map(toEpochDay).sort((a, b) => a - b);
  const out: DateRange[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const d of days) {
    if (start === undefined || prev === undefined) {
      start = d;
    } else if (d !== prev + 1) {
      out.push({ from: fromEpochDay(start), to: fromEpochDay(prev + 1) });
      start = d;
    }
    prev = d;
  }
  if (start !== undefined && prev !== undefined) {
    out.push({ from: fromEpochDay(start), to: fromEpochDay(prev + 1) });
  }
  return out;
}

/** PostgreSQL daterange literal for a half-open range. */
export function toDateRangeLiteral(range: DateRange): string {
  return `[${range.from},${range.to})`;
}

export function parseDateRangeLiteral(literal: string): DateRange {
  const m = /^[[(](\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})[\])]$/.exec(literal);
  if (!m || !m[1] || !m[2]) throw validationError(`Invalid date range "${literal}"`);
  return { from: m[1], to: m[2] };
}
