import { currencyExponent, decimalToMinor, minorToDecimal } from '@pms/domain/shared';

function numberFormat(currency: string, style: 'currency' | 'decimal'): Intl.NumberFormat {
  const digits = currencyExponent(currency);
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', {
    style,
    currency: style === 'currency' ? currency : undefined,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Money as accounts show it, with every decimal place: `₹4,500.00` from 450000. */
export function money(amount: number, currency: string): string {
  const value = amount / 10 ** currencyExponent(currency);
  try {
    return numberFormat(currency, 'currency').format(value);
  } catch {
    return `${currency} ${minorToDecimal(amount, currency)}`;
  }
}

/** The number alone, for a column whose heading names the currency: `4,500.00`. */
export function figure(amount: number, currency: string): string {
  const value = amount / 10 ** currencyExponent(currency);
  try {
    return numberFormat(currency, 'decimal').format(value);
  } catch {
    return minorToDecimal(amount, currency);
  }
}

/**
 * What someone typed into an amount box, in minor units. Thousands separators
 * are accepted. Null for anything that is not a plain amount of zero or more.
 */
export function parseAmount(text: string, currency: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  const minor = decimalToMinor(cleaned, currency);
  return minor !== null && minor >= 0 ? minor : null;
}

/** An amount as text for an amount box: `4500` or `4500.50`. */
export function amountText(amount: number, currency: string): string {
  return minorToDecimal(amount, currency).replace(/\.0+$/, '');
}

/** A percentage from basis points: `5` from 500, `2.5` from 250. */
export function percentText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = String(Math.abs(bp % 100))
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Basis points from a typed percentage with up to two decimals. Null when it is not one. */
export function parsePercent(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
