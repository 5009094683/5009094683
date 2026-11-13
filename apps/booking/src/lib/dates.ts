/**
 * Stay dates are calendar dates in the property's own time zone, carried as
 * `YYYY-MM-DD` strings. They are only ever turned into UTC instants to do
 * arithmetic, never into local time, which would shift them across time zones.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function epochDay(date: string): number | null {
  const match = DATE_RE.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = new Date(Date.UTC(year, month - 1, day));
  const real =
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day;
  return real ? instant.getTime() / DAY_MS : null;
}

/** Whether a value is a real calendar date written as `YYYY-MM-DD`. */
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && epochDay(value) !== null;
}

export function addDays(date: string, days: number): string {
  const day = epochDay(date);
  if (day === null) return date;
  return new Date((day + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function diffDays(from: string, to: string): number {
  const [a, b] = [epochDay(from), epochDay(to)];
  return a === null || b === null ? 0 : b - a;
}

/** The calendar date of an instant in an IANA time zone. */
export function dateIn(timezone: string, instant: Date = new Date()): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * `Thu 12 Dec 2026`. The names are our own rather than the platform's, so the
 * server and every browser write a date the same way.
 */
export function formatDate(date: string): string {
  const day = epochDay(date);
  if (day === null) return date;
  const instant = new Date(day * DAY_MS);
  return `${WEEKDAYS[instant.getUTCDay()]} ${instant.getUTCDate()} ${MONTHS[instant.getUTCMonth()]} ${instant.getUTCFullYear()}`;
}

/** `Thu 12 Dec`, for places where the year is plain from what surrounds it. */
export function formatDay(date: string): string {
  return formatDate(date).replace(/ \d{4}$/, '');
}

/** The date of a timestamp where the property is: `Thu 12 Dec 2026`. */
export function formatInstantDate(value: string, timezone: string): string {
  return formatDate(dateIn(timezone, new Date(value)));
}

/** The time of day of a timestamp where the property is: `14:25`. */
export function formatInstantTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

/**
 * The time of day of a timestamp on the reader's own clock: `14:25`. The
 * server's clock is not the reader's, so only call this in the browser.
 */
export function formatLocalTime(value: string | number): string {
  const instant = new Date(value);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(instant.getHours())}:${two(instant.getMinutes())}`;
}

/**
 * A moment on the reader's own clock: `14:25` when it falls on the reader's
 * today, `Mon 16 Nov, 14:25` otherwise. Browser only, like `formatLocalTime`.
 */
export function formatLocalMoment(value: string | number, now: number = Date.now()): string {
  const instant = new Date(value);
  const today = new Date(now);
  const time = formatLocalTime(value);
  const sameDay =
    instant.getFullYear() === today.getFullYear() &&
    instant.getMonth() === today.getMonth() &&
    instant.getDate() === today.getDate();
  return sameDay
    ? time
    : `${WEEKDAYS[instant.getDay()]} ${instant.getDate()} ${MONTHS[instant.getMonth()]}, ${time}`;
}
