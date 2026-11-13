const exponents = new Map<string, number>();

/** Decimal places of a currency's minor unit: 2 for INR and USD, 0 for JPY, 3 for KWD. */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  let digits = exponents.get(code);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    exponents.set(code, digits);
  }
  return digits;
}

/**
 * Converts a decimal amount written as text ("1234.50") to minor units,
 * without passing through floating point. Returns null for anything that is
 * not a plain decimal number.
 */
export function decimalToMinor(
  value: string | number | null | undefined,
  currency: string,
): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const exponent = currencyExponent(currency);
  const whole = match[2]!;
  const fraction = (match[3] ?? '').padEnd(exponent + 1, '0');
  const kept = fraction.slice(0, exponent);
  const roundUp = Number(fraction[exponent] ?? '0') >= 5;
  const minor = Number(`${whole}${kept}`) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(minor)) return null;
  return match[1] ? -minor : minor;
}

/** Minor units as a decimal string with the currency's own number of places ("1234.50"). */
export function minorToDecimal(amount: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = amount < 0;
  const digits = String(Math.abs(Math.round(amount))).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** "INR 1234.50": unambiguous in logs, alerts and notes, where locale formatting is not wanted. */
export function formatMoney(amount: number, currency: string): string {
  return `${currency.toUpperCase()} ${minorToDecimal(amount, currency)}`;
}

/**
 * An amount as a guest reads it: "₹9,450", "$240.50". For messages and the
 * booking site; internal text uses `formatMoney`.
 */
export function displayMoney(amount: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const value = amount / 10 ** exponent;
  try {
    return new Intl.NumberFormat(currency.toUpperCase() === 'INR' ? 'en-IN' : 'en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(value) ? 0 : exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    return formatMoney(amount, currency);
  }
}
