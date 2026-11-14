import { formatDate, formatDay, formatMoney, formatMonth, formatWeekday } from '@/lib/format';

/** Stands for a figure there is none of, such as an average rate when no room was sold. */
export const DASH = '–';

export interface Formats {
  currency: string;
  /** `₹4,500`. A dash for no amount. */
  money(amount: number | null): string;
  /** `₹4.5K`, for where there is little room. */
  shortMoney(amount: number): string;
  /** `+₹4,500` or `-₹300`: what was added or lost. */
  moneyChange(amount: number): string;
  /** `1,483` */
  count(value: number): string;
  /** `+13` or `-2` */
  countChange(value: number): string;
  /** `82.5%` from 8250 basis points. A dash for no share. */
  percent(basisPoints: number | null): string;
  /** `12.5`: an average, to one decimal place. A dash for none. */
  average(value: number | null): string;
}

/** Figures written the way amounts in `currency` are: Indian digit grouping for rupees. */
export function formatsFor(currency: string): Formats {
  const locale = currency === 'INR' ? 'en-IN' : 'en';
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const change = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  });
  const share = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const oneDecimal = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return {
    currency,
    money: (amount) => (amount === null ? DASH : formatMoney(amount, currency)),
    shortMoney: (amount) => formatMoney(amount, currency, { compact: true }),
    moneyChange: (amount) => `${amount > 0 ? '+' : ''}${formatMoney(amount, currency)}`,
    count: (value) => whole.format(value),
    countChange: (value) => change.format(value),
    percent: (basisPoints) => (basisPoints === null ? DASH : share.format(basisPoints / 10_000)),
    average: (value) => (value === null ? DASH : oneDecimal.format(value)),
  };
}

/** A rate agreed with someone, said exactly: `12.5%` from 1250 basis points, `10%` from 1000. */
export function rateText(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

/** `Sat 14 Nov`, with the year when the report runs across a year end. */
export function dayLabel(date: string, withYear: boolean): string {
  return withYear ? `${formatWeekday(date)} ${date.slice(0, 4)}` : formatWeekday(date);
}

/** `Week of 9 Nov`: weeks start on Monday. */
export function weekLabel(monday: string, withYear: boolean): string {
  return `Week of ${withYear ? formatDate(monday) : formatDay(monday)}`;
}

/** `November 2026` from `2026-11`. */
export function monthLabel(month: string): string {
  return formatMonth(`${month}-01`);
}

const shortMonth = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const shortMonthYear = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `Nov` from `2026-11`, or `Nov 2026` when months of more than one year are shown together. */
export function monthTick(month: string, withYear: boolean): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return (withYear ? shortMonthYear : shortMonth).format(date);
}

/** Whether a report's dates fall in more than one calendar year, so that dates need their year. */
export function spansYears(span: { from: string; to: string }): boolean {
  return span.from.slice(0, 4) !== span.to.slice(0, 4);
}
