import { addDays, dayOfWeek, eachDate } from '@pms/domain/shared';
import type { Block, Calendar, Contract, Stay } from './types';

/**
 * What a night is, as the owner sees it. `unknown` is a night the calendar
 * has not been loaded for; `outside` is one the contract does not cover.
 */
export type NightKind = 'free' | 'guests' | 'own' | 'closed' | 'outside' | 'unknown';

const covers = (from: string, to: string, date: string): boolean => from <= date && date < to;

const inContract = (contract: Pick<Contract, 'startsOn' | 'endsOn'>, date: string) =>
  date >= contract.startsOn && (contract.endsOn === null || date <= contract.endsOn);

/** The guest stays and closures of one villa. */
export function ofVilla(calendar: Calendar | undefined, contractId: string) {
  return {
    stays: (calendar?.stays ?? []).filter((stay) => stay.contractId === contractId),
    blocks: (calendar?.blocks ?? []).filter((block) => block.contractId === contractId),
  };
}

/**
 * What each night of a villa is between two dates. A villa let by the bedroom
 * counts as having guests when any of its rooms has.
 */
export function nightKinds(
  contract: Pick<Contract, 'startsOn' | 'endsOn'>,
  calendar: Calendar | undefined,
  stays: Stay[],
  blocks: Block[],
  from: string,
  to: string,
): Map<string, NightKind> {
  const kinds = new Map<string, NightKind>();
  for (const date of eachDate(from, to)) {
    let kind: NightKind;
    if (!inContract(contract, date)) kind = 'outside';
    else if (!calendar || date < calendar.from || date >= calendar.to) kind = 'unknown';
    else if (blocks.some((b) => b.kind === 'owner_stay' && covers(b.startDate, b.endDate, date))) {
      kind = 'own';
    } else if (stays.some((s) => covers(s.checkIn, s.checkOut, date))) kind = 'guests';
    else if (blocks.some((b) => covers(b.startDate, b.endDate, date))) kind = 'closed';
    else kind = 'free';
    kinds.set(date, kind);
  }
  return kinds;
}

/** The weeks of a month, Monday first. Days of the months either side are null. */
export function weeksOf(monthStart: string, monthEnd: string): (string | null)[][] {
  const days: (string | null)[] = eachDate(monthStart, monthEnd);
  // Monday is 1 in `dayOfWeek`; Sunday, 0, goes last.
  const lead = (dayOfWeek(monthStart) + 6) % 7;
  const cells = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/**
 * The latest day the owner could leave after arriving on `arrival`: the first
 * night after it that is not free. Nights that have not been loaded are taken
 * to be free, and the server has the last word.
 */
export function latestDeparture(
  kinds: Map<string, NightKind>,
  arrival: string,
  horizon: string,
): string {
  let date = addDays(arrival, 1);
  while (date < horizon) {
    const kind = kinds.get(date);
    if (kind !== undefined && kind !== 'free' && kind !== 'unknown') return date;
    date = addDays(date, 1);
  }
  return horizon;
}
