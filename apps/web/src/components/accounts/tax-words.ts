import { formatMoney } from '@/lib/format';
import { percentText } from './money';
import type { TaxCategory, TaxComponent, TaxSlab } from './types';

export const CATEGORIES: TaxCategory[] = ['room', 'food', 'service', 'extra', 'fee'];

export const CATEGORY_LABELS: Record<TaxCategory, string> = {
  room: 'Rooms',
  food: 'Food and drink',
  service: 'Services',
  extra: 'Extras',
  fee: 'Fees',
};

/** Which charges a category's rule is applied to, in the words the folio uses for them. */
export const CATEGORY_COVERS: Record<TaxCategory, string> = {
  room: 'Room nights.',
  food: 'Charges posted as “Food and drink”.',
  service: 'Charges posted as “Service”.',
  extra: 'Charges posted as “Extra”.',
  fee: 'Charges posted as “Fee”.',
};

/** Lowest price limit first, the rate with no limit last: the order the rates apply in. */
export function sortedSlabs(slabs: TaxSlab[]): TaxSlab[] {
  return [...slabs].sort(
    (a, b) => (a.upTo ?? Number.MAX_SAFE_INTEGER) - (b.upTo ?? Number.MAX_SAFE_INTEGER),
  );
}

const rateText = (bp: number): string => (bp === 0 ? 'no tax' : `${percentText(bp)}%`);

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Whether the rule charges anything at all. */
export function chargesTax(slabs: TaxSlab[]): boolean {
  return slabs.some((slab) => slab.rateBp > 0);
}

/** `5% when the room costs up to ₹7,500 a night, 18% above.` */
export function ratesInWords(category: TaxCategory, slabs: TaxSlab[], currency: string): string {
  const sorted = sortedSlabs(slabs);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return 'No rate is set.';
  if (!chargesTax(sorted)) return 'No tax.';
  if (sorted.length === 1) return `${percentText(first.rateBp)}% at any price.`;
  const limit = (slab: TaxSlab) => formatMoney(slab.upTo ?? 0, currency);
  const opening =
    category === 'room'
      ? `${rateText(first.rateBp)} when the room costs up to ${limit(first)} a night`
      : `${rateText(first.rateBp)} when the price is up to ${limit(first)}`;
  const between = sorted
    .slice(1, -1)
    .map((slab) => `${rateText(slab.rateBp)} up to ${limit(slab)}`);
  return sentence([opening, ...between, `${rateText(last.rateBp)} above`].join(', '));
}

/** `Split equally into CGST and SGST.` */
export function componentsInWords(components: TaxComponent[]): string {
  const [first, ...others] = components;
  if (!first) return '';
  if (others.length === 0) return `Shown on invoices as ${first.code}.`;
  if (others.every((component) => component.shareBp === first.shareBp)) {
    return `Split equally into ${list(components.map((component) => component.code))}.`;
  }
  return `Split into ${list(
    components.map((component) => `${component.code} (${percentText(component.shareBp)}%)`),
  )}.`;
}

/** India calls the service code on an invoice the SAC. */
export function serviceCodeLabel(country: string): string {
  return country.toUpperCase() === 'IN' ? 'SAC' : 'Service code';
}

/** The whole rule as staff would say it. */
export function ruleInWords(
  category: TaxCategory,
  rule: { slabs: TaxSlab[]; components: TaxComponent[]; serviceCode: string | null },
  currency: string,
  country: string,
): string {
  const parts = [ratesInWords(category, rule.slabs, currency)];
  if (chargesTax(rule.slabs)) parts.push(componentsInWords(rule.components));
  if (rule.serviceCode) parts.push(`${serviceCodeLabel(country)} ${rule.serviceCode}.`);
  return parts.filter(Boolean).join(' ');
}
