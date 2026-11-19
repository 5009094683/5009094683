import { CHANNEL_NAMES, addDays } from '@pms/domain/shared';
import { formatDate, formatWeekday, plural } from '@/lib/format';
import type { Contract, Statement } from './types';

/** How a booking came, in words an owner uses. Guests are never named. */
const SOURCE_WORDS: Record<string, string> = {
  direct: 'Booked directly',
  walk_in: 'Walk-in',
  phone: 'Booked by phone',
  website: 'Booked on the website',
  ota: 'Through a booking site',
  corporate: 'Company booking',
  travel_agent: 'Through a travel agent',
  owner: 'Booked for the owner',
  group: 'Group booking',
};

export function sourceWords(source: string): string {
  const site = CHANNEL_NAMES[source.toUpperCase()];
  if (site) return `Through ${site}`;
  return SOURCE_WORDS[source] ?? 'Guest booking';
}

/** `Sat 15 Nov to Tue 18 Nov 2026` */
export function stayDates(from: string, to: string): string {
  return `${formatWeekday(from)} to ${formatWeekday(to)} ${to.slice(0, 4)}`;
}

export const nightsText = (count: number): string => plural(count, 'night');

/** How an owner reads where a statement stands. */
export function payment(statement: Pick<Statement, 'status' | 'paidAt'>): {
  label: string;
  tone: 'info' | 'success';
} {
  return statement.status === 'paid'
    ? { label: 'Paid', tone: 'success' }
    : { label: 'Payment to follow', tone: 'info' };
}

/** The last day a contract covered, for one that has ended. */
export const endedOn = (contract: Pick<Contract, 'endsOn'>, today: string): string =>
  formatDate(contract.endsOn ?? addDays(today, -1));
