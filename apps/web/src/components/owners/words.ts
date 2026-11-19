import type { ComponentProps } from 'react';
import { addDays, monthOf, todayIn } from '@pms/domain/shared';
import type { Badge } from '@/components/ui/misc';
import { formatDate, formatMoney, formatMonth, plural } from '@/lib/format';
import { percentText } from './money';
import type {
  Contract,
  ContractModel,
  ExpenseCategory,
  FeeBasis,
  Statement,
  StatementStatus,
} from './types';

type Tone = NonNullable<ComponentProps<typeof Badge>['tone']>;

export const MODEL_LABELS: Record<ContractModel, string> = {
  revenue_share: 'Share of revenue',
  fixed_rent: 'Fixed rent',
};

export const MODEL_HELP: Record<ContractModel, string> = {
  revenue_share:
    'The owner receives the room revenue of the nights guests stayed, less the management fee, the tax on that fee, and the costs charged to them.',
  fixed_rent:
    'The owner receives the same rent every month, whatever the villa earns. In a month the contract covers only partly, the rent is in proportion to the days it covers. Costs charged to the owner are still taken off.',
};

export const BASIS_LABELS: Record<FeeBasis, string> = {
  gross: 'Room revenue as sold',
  net: 'Room revenue after commission',
};

export const BASIS_HELP: Record<FeeBasis, string> = {
  gross:
    'The fee is worked out on the full room revenue, before any commission to booking sites or travel agents.',
  net: 'Commission to booking sites and travel agents is taken off the room revenue first, and the fee is worked out on what is left.',
};

/** What the fee is a share of, to follow a percentage: "of room revenue after commission". */
export function basisWords(basis: FeeBasis): string {
  return basis === 'net' ? 'of room revenue after commission' : 'of room revenue';
}

type Terms = Pick<Contract, 'model' | 'managementFeeBp' | 'feeBasis' | 'fixedRent' | 'currency'>;

/** A contract's model and fee in a few words: "20% of room revenue", "Fixed rent of ₹1,50,000 a month". */
export function feeWords(contract: Terms): string {
  if (contract.model === 'fixed_rent') {
    return contract.fixedRent === null
      ? 'Fixed rent'
      : `Fixed rent of ${formatMoney(contract.fixedRent, contract.currency)} a month`;
  }
  return `${percentText(contract.managementFeeBp)}% ${basisWords(contract.feeBasis)}`;
}

/** How many nights the owner may stay and how far ahead they must ask. */
export function ownerStayWords(
  contract: Pick<Contract, 'ownerNightsPerYear' | 'ownerStayNoticeDays'>,
): string {
  if (contract.ownerNightsPerYear === 0) return 'Not included in this contract';
  const nights =
    contract.ownerNightsPerYear === null
      ? 'No limit on nights'
      : `Up to ${plural(contract.ownerNightsPerYear, 'night')} a year`;
  const notice =
    contract.ownerStayNoticeDays === 0
      ? 'no notice needed'
      : `asked for at least ${plural(contract.ownerStayNoticeDays, 'day')} ahead`;
  return `${nights}, ${notice}`;
}

/** The dates a contract covers: "From 1 Jun 2026, until further notice". */
export function periodWords(contract: Pick<Contract, 'startsOn' | 'endsOn'>): string {
  return contract.endsOn
    ? `${formatDate(contract.startsOn)} to ${formatDate(contract.endsOn)}`
    : `From ${formatDate(contract.startsOn)}, until further notice`;
}

/** What a contract is for, on one line. A unit that bears the property's name is not said twice. */
export function villaName(villa: { propertyName: string; unitName: string | null }): string {
  if (!villa.unitName || villa.unitName === villa.propertyName) return villa.propertyName;
  return `${villa.propertyName} · ${villa.unitName}`;
}

export type ContractState = 'current' | 'upcoming' | 'ended';

export function contractState(
  contract: Pick<Contract, 'startsOn' | 'endsOn'>,
  today: string,
): ContractState {
  if (contract.endsOn && contract.endsOn < today) return 'ended';
  if (contract.startsOn > today) return 'upcoming';
  return 'current';
}

export function contractStateWords(contract: Pick<Contract, 'startsOn' | 'endsOn'>, today: string) {
  const state = contractState(contract, today);
  if (state === 'ended') return `Ended ${formatDate(contract.endsOn ?? today)}`;
  if (state === 'upcoming') return `Starts ${formatDate(contract.startsOn)}`;
  return contract.endsOn ? `Ends ${formatDate(contract.endsOn)}` : 'Current';
}

export const CONTRACT_STATE_TONES: Record<ContractState, Tone> = {
  current: 'success',
  upcoming: 'info',
  ended: 'neutral',
};

export const STATUS_LABELS: Record<StatementStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  paid: 'Paid',
};

export const STATUS_TONES: Record<StatementStatus, Tone> = {
  draft: 'warning',
  issued: 'info',
  paid: 'success',
};

export const STATUSES = Object.keys(STATUS_LABELS) as StatementStatus[];

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  maintenance: 'Repairs and maintenance',
  utilities: 'Utilities',
  supplies: 'Supplies',
  cleaning: 'Cleaning',
  other: 'Other',
};

export const CATEGORIES = Object.keys(CATEGORY_LABELS) as ExpenseCategory[];

/** The viewer's own calendar date, for wording such as "current" and "ended". The server judges every rule. */
export function localToday(): string {
  return todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** `2026-10` from a date in that month. */
export const monthKey = (date: string): string => date.slice(0, 7);

/** `October 2026` from `2026-10`. */
export const monthLabel = (month: string): string => formatMonth(`${month}-01`);

export function isMonth(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The first day of a month and the first day of the next. */
export const monthBounds = (month: string): { start: string; end: string } =>
  monthOf(`${month}-01`);

export function shiftMonth(month: string, by: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The month a statement is for: "October 2026". */
export const statementMonth = (statement: Pick<Statement, 'periodStart'>): string =>
  formatMonth(statement.periodStart);

/** The days a statement covers: "1 Oct 2026 to 31 Oct 2026". */
export function statementPeriod(statement: Pick<Statement, 'periodStart' | 'periodEnd'>): string {
  return `${formatDate(statement.periodStart)} to ${formatDate(addDays(statement.periodEnd, -1))}`;
}

const timestampDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** The day of a moment in time, in the viewer's own time zone: `2 Nov 2026`. */
export const formatDayOf = (timestamp: string): string => timestampDate.format(new Date(timestamp));
