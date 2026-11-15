import type { Lang, Service, ServiceOption } from '../business/schema';

export interface Quote {
  /** VND per motorbike per day, per person, or per passenger per day. Null: a person quotes. */
  unitPrice: number | null;
  total: number | null;
  depositPercent: number;
  deposit: number | null;
}

/** Tours are priced per person for the whole tour; rentals and Easy Rider per unit per day. */
export function quoteFor(
  service: Service,
  option: ServiceOption,
  days: number,
  quantity: number,
): Quote {
  const unitPrice = option.price;
  const total =
    unitPrice === null
      ? null
      : service.kind === 'tour'
        ? unitPrice * quantity
        : unitPrice * quantity * days;
  return {
    unitPrice,
    total,
    depositPercent: service.depositPercent,
    deposit: depositOf(total, service.depositPercent),
  };
}

/** The deposit, rounded to the nearest 1,000 VND. */
export function depositOf(total: number | null, percent: number): number | null {
  if (total === null || percent <= 0) return null;
  return Math.round((total * percent) / 100 / 1000) * 1000;
}

/** "1,500,000 VND" in English, "1.500.000 VND" in Vietnamese. */
export function formatMoney(amount: number, lang: Lang): string {
  const separator = lang === 'vi' ? '.' : ',';
  const digits = String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return `${digits} VND`;
}
