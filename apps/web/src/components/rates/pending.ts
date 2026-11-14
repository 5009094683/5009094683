import { addDays, dayOfWeek } from '@pms/domain/shared';
import { formatDate, formatDay, formatMoney } from '@/lib/format';
import type { RateDay, RatePlan } from '@/lib/types';

/** What can be set on a rate plan for a run of dates. A field left out is not touched. */
export interface RateChangeBody {
  /** Null takes the day back to the plan's own rate. */
  rate?: number | null;
  minStayArrival?: number | null;
  minStayThrough?: number | null;
  /** Null removes the limit. */
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

/**
 * A change made on the rates screen that has not been saved yet. Changes are
 * held and saved together, so that the booking sites are told once about
 * everything that was changed in one sitting.
 */
export interface PendingChange {
  id: string;
  ratePlanId: string;
  from: string;
  /** The day after the last one. */
  to: string;
  /** Limited to these days of the week (0 is Sunday); absent means every day. */
  daysOfWeek?: number[];
  change: RateChangeBody;
}

export type NewChange = Omit<PendingChange, 'id'>;

const isOneDay = (change: NewChange): boolean =>
  !change.daysOfWeek && addDays(change.from, 1) === change.to;

let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Adds changes to the list. A second change to the same single day of the
 * same plan is folded into the first, so a cell edited twice is one change.
 */
export function addChanges(list: PendingChange[], added: NewChange[]): PendingChange[] {
  let next = list;
  for (const change of added) {
    if (Object.keys(change.change).length === 0) continue;
    const same = isOneDay(change)
      ? next.find(
          (other) =>
            other.ratePlanId === change.ratePlanId && other.from === change.from && isOneDay(other),
        )
      : undefined;
    next = same
      ? next.map((other) =>
          other === same ? { ...other, change: { ...other.change, ...change.change } } : other,
        )
      : [...next, { ...change, id: newId() }];
  }
  return next;
}

const covers = (change: PendingChange, planId: string, date: string): boolean =>
  change.ratePlanId === planId &&
  date >= change.from &&
  date < change.to &&
  (!change.daysOfWeek || change.daysOfWeek.includes(dayOfWeek(date)));

export interface ShownDay extends RateDay {
  /** The rate shown is one waiting to be saved. */
  ratePending: boolean;
  /** A restriction shown is one waiting to be saved. */
  restrictionsPending: boolean;
}

/** A day as it will be once the changes waiting are saved. */
export function withPending(day: RateDay, plan: RatePlan, pending: PendingChange[]): ShownDay {
  const shown: ShownDay = { ...day, ratePending: false, restrictionsPending: false };
  for (const { change } of pending.filter((c) => covers(c, plan.id, day.date))) {
    if (change.rate !== undefined) {
      shown.rate = change.rate ?? plan.baseRate;
      shown.rateOverridden = change.rate !== null;
      shown.ratePending = true;
    }
    if (change.minStayArrival !== undefined) {
      shown.minStayArrival = change.minStayArrival ?? plan.minStay;
    }
    if (change.minStayThrough !== undefined) {
      shown.minStayThrough = change.minStayThrough ?? plan.minStay;
    }
    if (change.maxStay !== undefined) shown.maxStay = change.maxStay ?? plan.maxStay;
    if (change.closedToArrival !== undefined) shown.closedToArrival = change.closedToArrival;
    if (change.closedToDeparture !== undefined) shown.closedToDeparture = change.closedToDeparture;
    if (change.stopSell !== undefined) shown.stopSell = change.stopSell;
    if (Object.keys(change).some((field) => field !== 'rate')) shown.restrictionsPending = true;
  }
  return shown;
}

/** Whether the plan this one takes its price from has a rate waiting to be saved on that day. */
export function parentRatePending(plan: RatePlan, date: string, pending: PendingChange[]): boolean {
  const parent = plan.parentRatePlanId;
  return (
    parent !== null && pending.some((c) => c.change.rate !== undefined && covers(c, parent, date))
  );
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `21 Nov 2027`, or `1 Nov – 10 Nov 2027`, with the weekdays when only some are meant. */
export function datesText(change: Pick<PendingChange, 'from' | 'to' | 'daysOfWeek'>): string {
  const last = addDays(change.to, -1);
  const span =
    last === change.from ? formatDate(last) : `${formatDay(change.from)} – ${formatDate(last)}`;
  if (!change.daysOfWeek || change.daysOfWeek.length === 7) return span;
  const days = [...change.daysOfWeek]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => WEEKDAY_NAMES[d])
    .join(', ');
  return `${span}, on ${days}`;
}

const onOff = (value: boolean): string => (value ? 'on' : 'off');

/** What a change sets, in words: `Rate ₹333`, `Minimum stay 3 nights`, `Stop sell on`. */
export function changeText(change: RateChangeBody, plan: RatePlan, currency: string): string[] {
  const out: string[] = [];
  if (change.rate !== undefined) {
    out.push(
      change.rate === null
        ? `Rate back to the plan's own (${formatMoney(plan.baseRate, currency)})`
        : `Rate ${formatMoney(change.rate, currency)}`,
    );
  }
  const nights = (n: number): string => `${n} ${n === 1 ? 'night' : 'nights'}`;
  if (change.minStayArrival !== undefined) {
    out.push(
      change.minStayArrival === null
        ? `Minimum stay back to the plan's own (${nights(plan.minStay)})`
        : `Minimum stay ${nights(change.minStayArrival)}`,
    );
  }
  if (change.maxStay !== undefined) {
    out.push(
      change.maxStay === null ? 'No maximum stay' : `Maximum stay ${nights(change.maxStay)}`,
    );
  }
  if (change.stopSell !== undefined) out.push(`Stop sell ${onOff(change.stopSell)}`);
  if (change.closedToArrival !== undefined) {
    out.push(`Closed to arrival ${onOff(change.closedToArrival)}`);
  }
  if (change.closedToDeparture !== undefined) {
    out.push(`Closed to departure ${onOff(change.closedToDeparture)}`);
  }
  return out;
}

/** The body of the one request that saves everything waiting. */
export function batchBody(pending: PendingChange[]): { changes: NewChange[] } {
  return { changes: pending.map(({ id: _id, ...change }) => change) };
}
