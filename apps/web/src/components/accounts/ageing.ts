import type { StatementEntry } from './types';

export interface AgeBand {
  label: string;
  /** Oldest age in days that falls in this band. */
  from: number;
  amount: number;
}

const BANDS: Pick<AgeBand, 'label' | 'from'>[] = [
  { label: '0 to 30 days', from: 0 },
  { label: '31 to 60 days', from: 31 },
  { label: '61 to 90 days', from: 61 },
  { label: 'Over 90 days', from: 91 },
];

export interface Ageing {
  bands: AgeBand[];
  /** What is owed in all: the bands added up. */
  owed: number;
  /** Paid beyond what was billed: the company is in credit by this much. */
  inCredit: number;
}

/**
 * How old the unpaid part of an account is. Payments settle the oldest bills
 * first, so what is left unpaid is the newest of what was billed.
 *
 * Each property keeps its own account, and a payment into one settles only
 * that one, so the accounts are worked out one by one and then added up.
 */
export function ageAccounts(entries: StatementEntry[]): Ageing {
  const bands: AgeBand[] = BANDS.map((band) => ({ ...band, amount: 0 }));
  let inCredit = 0;

  const accounts = new Map<string, StatementEntry[]>();
  for (const entry of entries) {
    const account = accounts.get(entry.folioId);
    if (account) account.push(entry);
    else accounts.set(entry.folioId, [entry]);
  }

  for (const account of accounts.values()) {
    let paid = account.reduce((sum, entry) => sum + Math.max(0, -entry.amount), 0);
    // Entries arrive oldest first; sorting again keeps that true whatever the caller did.
    const bills = account
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const bill of bills) {
      const settled = Math.min(paid, bill.amount);
      paid -= settled;
      const unpaid = bill.amount - settled;
      if (unpaid === 0) continue;
      // An entry dated on a hotel day that the calendar has not reached yet is new, not negative.
      const age = Math.max(0, bill.ageDays);
      const band = bands.findLast((candidate) => age >= candidate.from) ?? bands[0]!;
      band.amount += unpaid;
    }
    inCredit += paid;
  }

  return { bands, owed: bands.reduce((sum, band) => sum + band.amount, 0), inCredit };
}
