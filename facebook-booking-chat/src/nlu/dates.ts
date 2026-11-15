import type { Lang } from '../business/schema';
import { fold } from './text';

/** Calendar dates are plain "YYYY-MM-DD" strings; no clock time, no time zone. */
export type IsoDate = string;

const DAY_MS = 86_400_000;

function toUtc(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date: IsoDate): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** The calendar date it is now in the given time zone. */
export function todayIn(timezone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function makeDate(year: number, month: number, day: number): IsoDate | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return fromUtc(ms);
}

function fullYear(year: string | undefined): number | undefined {
  if (year === undefined || year === '') return undefined;
  const n = Number(year);
  return year.length <= 2 ? 2000 + n : n;
}

/**
 * A day and month, with or without a year. Without a year it is the next time
 * that date comes round, counted from `notBefore`.
 */
function resolveDate(
  day: number,
  month: number,
  year: number | undefined,
  notBefore: IsoDate,
): IsoDate | undefined {
  if (year !== undefined) return makeDate(year, month, day);
  const baseYear = Number(notBefore.slice(0, 4));
  const thisYear = makeDate(baseYear, month, day);
  if (thisYear !== undefined && thisYear >= notBefore) return thisYear;
  return makeDate(baseYear + 1, month, day) ?? thisYear;
}

/**
 * Two numbers written as a date. Day comes first, as written in Vietnam; only
 * when that cannot be a date ("11/20") are they read the other way round.
 */
function resolveNumeric(
  first: number,
  second: number,
  year: number | undefined,
  notBefore: IsoDate,
): IsoDate | undefined {
  if (second > 12 && first <= 12) return resolveDate(second, first, year, notBefore);
  return resolveDate(first, second, year, notBefore);
}

/** "the 20th", "ngày 20": that day of this month, or of next month if it has passed. */
function resolveBareDay(day: number, today: IsoDate): IsoDate | undefined {
  if (day < 1 || day > 31) return undefined;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const thisMonth = makeDate(year, month, day);
  if (thisMonth !== undefined && thisMonth >= today) return thisMonth;
  return month === 12 ? makeDate(year + 1, 1, day) : makeDate(year, month + 1, day);
}

// prettier-ignore
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MON =
  '(january|february|march|april|june|july|august|september|october|november|december|' +
  'jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)';
const D = '(\\d{1,2})';
const Y = '(\\d{4}|\\d{2})';
const TO = '\\s*(?:-|to|until|till|through|den|toi|~)\\s*(?:the\\s+)?';
// "May 2 people" asks for two people, not for the second of May.
const NOT_A_COUNT =
  '(?!\\s*(?:people|persons?|pax|bikes?|motorbikes?|scooters?|days?|nights?|of us|adults?|guests?))';

// prettier-ignore
const WEEKDAYS_EN: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// prettier-ignore
const WEEKDAYS_VI: Record<string, number> = {
  hai: 1, '2': 1, ba: 2, '3': 2, tu: 3, '4': 3, nam: 4, '5': 4, sau: 5, '6': 5, bay: 6, '7': 6,
};

// prettier-ignore
export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
  mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10,
};

const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

function toNumber(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : (NUMBER_WORDS[token] ?? NaN);
}

export interface DatesFound {
  /** First day. */
  start?: IsoDate;
  /** Last day, when the customer gave one ("20 to 22 Nov"). */
  end?: IsoDate;
  /** Length in days, when the customer gave one ("3 days", "2 nights"). */
  days?: number;
}

interface Mention {
  at: number;
  date: IsoDate;
  /** A weekday name is dropped when the message also gives a date: "Saturday 21 Nov". */
  weekday: boolean;
}

/**
 * Finds the dates and the length of stay a message speaks of. Understands
 * English and Vietnamese, with or without tone marks:
 *
 *   20/11 · 20/11/2026 · 20.11.2026 · 20 Nov · November 20th · ngày 20 tháng 11
 *   20-22/11 · 20 to 22 Nov · Nov 20-22 · từ 20 đến 22 tháng 11 · 20/11 - 22/11
 *   today · tomorrow · hôm nay · ngày mai · ngày kia · Saturday · thứ 7 tuần sau
 *   3 days · 2 nights · 3 ngày 2 đêm · a week · 3d2n
 */
export function parseDates(text: string, today: IsoDate): DatesFound {
  let t = ` ${fold(text)} `;
  const found: DatesFound = {};
  const mentions: Mention[] = [];

  const consume = (pattern: RegExp, handle: (match: RegExpExecArray) => boolean): void => {
    const regex = new RegExp(pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(t)) !== null) {
      if (handle(match)) {
        t = t.slice(0, match.index) + ' '.repeat(match[0].length) + t.slice(regex.lastIndex);
      } else {
        regex.lastIndex = match.index + 1;
      }
    }
  };

  const mention = (at: number, date: IsoDate | undefined, weekday = false): boolean => {
    if (date === undefined) return false;
    mentions.push({ at, date, weekday });
    return true;
  };

  const comingWeekday = (weekday: number, nextWeek: boolean): IsoDate => {
    let date = addDays(today, 1);
    while (weekdayOf(date) !== weekday) date = addDays(date, 1);
    if (nextWeek) {
      // The Monday-to-Sunday week after the current one.
      const nextMonday = addDays(today, (8 - weekdayOf(today)) % 7 || 7);
      while (date < nextMonday) date = addDays(date, 7);
    }
    return date;
  };

  // Weekdays before day counts, so that "thứ 7 tuần sau" is not read as seven weeks.
  consume(
    /(?<![a-z])thu\s*(hai|ba|tu|nam|sau|bay|[2-7])(\s+tuan\s+(?:sau|toi))?(?![a-z0-9])/,
    (m) => mention(m.index, comingWeekday(WEEKDAYS_VI[m[1]!]!, m[2] !== undefined), true),
  );
  consume(/(?<![a-z])(?:chu nhat|cn)(\s+tuan\s+(?:sau|toi))?(?![a-z])/, (m) =>
    mention(m.index, comingWeekday(0, m[1] !== undefined), true),
  );
  consume(
    /(?<![a-z])(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(\s+next week)?(?![a-z])/,
    (m) => mention(m.index, comingWeekday(WEEKDAYS_EN[m[1]!]!, m[2] !== undefined), true),
  );

  // Day counts next, so that "3 ngày từ ngày 20/11" does not lose its "3 ngày".
  const setDays = (n: number, overwrite: boolean): boolean => {
    if (!Number.isFinite(n) || n < 1 || n > 365) return false;
    if (overwrite || found.days === undefined) found.days = n;
    return true;
  };
  consume(/(?<![\d/.a-z])(\d{1,2})\s*d\s*(\d{1,2})\s*n(?![a-z])/, (m) =>
    setDays(Number(m[1]), true),
  );
  consume(new RegExp(`(?<![\\d/.a-z])${NUM}\\s*-?\\s*(?:days?|ngay)(?![a-z])`), (m) =>
    setDays(toNumber(m[1]!), true),
  );
  consume(new RegExp(`(?<![\\d/.a-z])(?:${NUM}|a)\\s*(?:weeks?|tuan)(?![a-z])`), (m) =>
    setDays((m[1] === undefined ? 1 : toNumber(m[1])) * 7, false),
  );
  consume(new RegExp(`(?<![\\d/.a-z])${NUM}\\s*(?:nights?|dem)(?![a-z])`), (m) =>
    setDays(toNumber(m[1]!) + 1, false),
  );
  consume(
    /(?<![a-z])(?:(?:for|just) (?:a|the|one) day|half\s*(?:a\s*)?day|nua\s*ngay|trong ngay)(?![a-z])/,
    () => setDays(1, false),
  );

  // "ngày 20", "mùng 5", "on the 20th": a day with no month. Kept aside and
  // used only when the message names no fuller date.
  let bareDay: number | undefined;
  const viBare = /(?<![a-z])(?:ngay|mung|mong)\s*(\d{1,2})(?!\s*(?:thang|thg|[/.-]\s*\d)|\d)/.exec(
    t,
  );
  const enBare =
    /(?<![a-z])(?:on|from|starting|start|since|arrive|arriving)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)(?![a-z])/.exec(
      t,
    );
  if (viBare) bareDay = Number(viBare[1]);
  else if (enBare) bareDay = Number(enBare[1]);

  t = t.replace(/(\d)(?:st|nd|rd|th)(?![a-z])/g, '$1  ');
  t = t.replace(/(?<![a-z])ngay(\s+)(?=\d)/g, '    $1');

  const range = (start: IsoDate | undefined, endOf: (start: IsoDate) => IsoDate | undefined) => {
    if (start === undefined || found.start !== undefined) return false;
    const end = endOf(start);
    if (end === undefined || end < start) return false;
    found.start = start;
    found.end = end;
    return true;
  };
  const yearOf = (date: IsoDate) => Number(date.slice(0, 4));

  // 20-22/11 · 20 đến 22/11/2026
  consume(
    new RegExp(`(?<![\\d/.-])${D}${TO}${D}\\s*[/.]\\s*${D}(?:\\s*[/.]\\s*${Y})?(?![\\d/.])`),
    (m) =>
      range(resolveDate(Number(m[1]), Number(m[3]), fullYear(m[4]), today), (start) =>
        makeDate(yearOf(start), Number(m[3]), Number(m[2])),
      ),
  );
  // 20/11 - 22/11 · 20/11/2026 to 22/11/2026
  consume(
    new RegExp(
      `(?<![\\d/.-])${D}\\s*[/.]\\s*${D}(?:\\s*[/.]\\s*${Y})?${TO}${D}\\s*[/.]\\s*${D}(?:\\s*[/.]\\s*${Y})?(?![\\d/.])`,
    ),
    (m) =>
      range(resolveNumeric(Number(m[1]), Number(m[2]), fullYear(m[3]), today), (start) =>
        resolveNumeric(Number(m[4]), Number(m[5]), fullYear(m[6]), start),
      ),
  );
  // 20 to 22 Nov · 20-22 November 2026
  consume(
    new RegExp(`(?<![\\d/.-])${D}${TO}${D}\\s*(?:of\\s+)?${MON}(?![a-z])(?:\\s*,?\\s*(\\d{4}))?`),
    (m) =>
      range(resolveDate(Number(m[1]), MONTHS[m[3]!]!, fullYear(m[4]), today), (start) =>
        makeDate(yearOf(start), MONTHS[m[3]!]!, Number(m[2])),
      ),
  );
  // Nov 20-22 · November 20 to 22, 2026
  consume(new RegExp(`(?<![a-z])${MON}\\s*${D}${TO}${D}(?![\\d/.])(?:\\s*,?\\s*(\\d{4}))?`), (m) =>
    range(resolveDate(Number(m[2]), MONTHS[m[1]!]!, fullYear(m[4]), today), (start) =>
      makeDate(yearOf(start), MONTHS[m[1]!]!, Number(m[3])),
    ),
  );
  // 20 đến 22 tháng 11
  consume(
    new RegExp(
      `(?<![\\d/.-])${D}${TO}${D}\\s*(?:thang|thg)\\s*${D}(?:\\s*(?:nam\\s*)?(\\d{4}))?(?!\\d)`,
    ),
    (m) =>
      range(resolveDate(Number(m[1]), Number(m[3]), fullYear(m[4]), today), (start) =>
        makeDate(yearOf(start), Number(m[3]), Number(m[2])),
      ),
  );

  // 20/11/2026 · 20.11.2026 · 20-11-2026
  consume(new RegExp(`(?<![\\d/.-])${D}\\s?([/.-])\\s?${D}\\s?\\2\\s?${Y}(?![\\d/.-])`), (m) =>
    mention(m.index, resolveNumeric(Number(m[1]), Number(m[3]), fullYear(m[4]), today)),
  );
  // 20/11 (but not "24/7")
  consume(new RegExp(`(?<![\\d/.-])${D}\\s?/\\s?${D}(?![\\d/.-])`), (m) =>
    m[1] === '24' && m[2] === '7'
      ? false
      : mention(m.index, resolveNumeric(Number(m[1]), Number(m[2]), undefined, today)),
  );
  // 20.11 (two digits each side, so that "1.5" stays a number)
  consume(/(?<![\d/.-])(\d{2})\.(\d{2})(?![\d/.-])/, (m) =>
    mention(m.index, resolveNumeric(Number(m[1]), Number(m[2]), undefined, today)),
  );
  // 20 tháng 11 · 20 thg 11 năm 2026
  consume(
    new RegExp(`(?<![\\d/.-])${D}\\s*(?:thang|thg)\\s*${D}(?:\\s*(?:nam\\s*)?(\\d{4}))?(?!\\d)`),
    (m) => mention(m.index, resolveDate(Number(m[1]), Number(m[2]), fullYear(m[3]), today)),
  );
  // 20 Nov · 20 of November 2026
  consume(
    new RegExp(`(?<![\\d/.-])${D}\\s*(?:of\\s+)?${MON}(?![a-z])(?:\\s*,?\\s*(\\d{4}))?`),
    (m) => mention(m.index, resolveDate(Number(m[1]), MONTHS[m[2]!]!, fullYear(m[3]), today)),
  );
  // Nov 20 · November 20, 2026
  consume(
    new RegExp(`(?<![a-z])${MON}\\s*${D}(?![\\d/.])${NOT_A_COUNT}(?:\\s*,?\\s*(\\d{4}))?`),
    (m) => mention(m.index, resolveDate(Number(m[2]), MONTHS[m[1]!]!, fullYear(m[3]), today)),
  );

  consume(/(?<![a-z])(?:day after tomorrow|ngay kia|ngay mot)(?![a-z])/, (m) =>
    mention(m.index, addDays(today, 2)),
  );
  consume(
    /(?<![a-z])(?:tomorrow|tomorow|tommorow|tmrw|tmr|ngay mai|(?:sang|trua|chieu|toi|tu) mai|mai(?=\s+(?:di|nhan|lay|thue|dat|den|toi|em|minh|anh|chi|co|duoc)(?![a-z])))(?![a-z])/,
    (m) => mention(m.index, addDays(today, 1)),
  );
  consume(/(?<![a-z])(?:today|tonight|hom nay|bua nay|toi nay|chieu nay|sang nay)(?![a-z])/, (m) =>
    mention(m.index, today),
  );
  if (/^\s*mai\s*$/.test(t)) mention(0, addDays(today, 1));

  if (found.start === undefined) {
    const dated = mentions.some((m) => !m.weekday);
    const kept = mentions.filter((m) => !dated || !m.weekday).sort((a, b) => a.at - b.at);
    const first = kept[0];
    const second = kept[1];
    if (first) {
      found.start = first.date;
      if (second && second.date > first.date) found.end = second.date;
    } else if (bareDay !== undefined) {
      found.start = resolveBareDay(bareDay, today);
    }
  }

  if (found.start !== undefined && found.end !== undefined) {
    found.days = diffDays(found.start, found.end) + 1;
  }
  return found;
}

/** A lone day number given in answer to "which date?": "20", "the 20th". */
export function parseBareDay(text: string, today: IsoDate): IsoDate | undefined {
  const match = /^(?:on\s+)?(?:the\s+)?(?:ngay\s+|mung\s+)?(\d{1,2})(?:st|nd|rd|th)?$/.exec(
    fold(text).replace(/[.!]+$/, ''),
  );
  return match ? resolveBareDay(Number(match[1]), today) : undefined;
}

/**
 * The one number in a short answer: "ok 3", "3 then", "make it 2 please".
 * Undefined when the answer is longer or names more than one number.
 */
export function loneNumber(text: string): number | undefined {
  const folded = fold(text);
  if (folded.split(' ').length > 5) return undefined;
  const numbers = folded.match(/(?<![\d/.:,-])\d{1,2}(?![\d/.:,-]|(?:st|nd|rd|th)?[a-z])/g) ?? [];
  const ordinals = folded.match(/(?<![\d/.:,-])\d{1,2}(?=(?:st|nd|rd|th)(?![a-z]))/g) ?? [];
  const all = [...numbers, ...ordinals];
  return all.length === 1 ? Number(all[0]) : undefined;
}

/**
 * A day of the month named loosely in answer to "which date?": "ok then the
 * 25th", "25 nhé". Tried only after the stricter readings have found nothing.
 */
export function parseLooseDay(text: string, today: IsoDate): IsoDate | undefined {
  const day = loneNumber(text);
  return day === undefined ? undefined : resolveBareDay(day, today);
}

const WEEKDAY_NAMES: Record<Lang, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  vi: ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'],
};
// prettier-ignore
const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 20 Nov 2026" · "Thứ sáu, 20/11/2026" */
export function formatDate(date: IsoDate, lang: Lang): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAY_NAMES[lang][weekdayOf(date)]!;
  if (lang === 'vi') {
    return `${weekday}, ${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  }
  return `${weekday} ${day} ${MONTH_NAMES_EN[month - 1]} ${year}`;
}
