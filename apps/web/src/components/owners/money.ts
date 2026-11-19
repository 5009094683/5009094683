import { currencyExponent, decimalToMinor, minorToDecimal } from '@pms/domain/shared';

/** Money as a statement shows it, with every decimal place: `₹94,337.00` from 9433700. */
export function money(amount: number, currency: string): string {
  const digits = currencyExponent(currency);
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount / 10 ** digits);
  } catch {
    return `${currency} ${minorToDecimal(amount, currency)}`;
  }
}

/** An amount with its sign always shown, for adjustments: `+₹500.00`, `-₹1,200.00`. */
export function signedMoney(amount: number, currency: string): string {
  return amount > 0 ? `+${money(amount, currency)}` : money(amount, currency);
}

/**
 * What someone typed into an amount box, in minor units, without passing
 * through floating point. Thousands separators are accepted, more decimal
 * places than the currency has are not. Null for anything else.
 */
export function parseAmount(text: string, currency: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  const places = currencyExponent(currency);
  const plain = places > 0 ? new RegExp(`^\\d+(\\.\\d{1,${places}})?$`) : /^\d+$/;
  if (!plain.test(cleaned)) return null;
  return decimalToMinor(cleaned, currency);
}

/** An amount as text for an amount box: `150000` or `1500.50`. */
export function amountText(amount: number, currency: string): string {
  return minorToDecimal(amount, currency).replace(/\.0+$/, '');
}

/** A percentage from basis points: `20` from 2000, `12.5` from 1250. */
export function percentText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = String(Math.abs(bp % 100))
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Basis points from a typed percentage with up to two decimals: 1250 from `12.5`. Null when it is not one. */
export function parsePercent(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
