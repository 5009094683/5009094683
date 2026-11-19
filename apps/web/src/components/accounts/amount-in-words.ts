import { currencyExponent } from '@pms/domain/shared';

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

type Scales = [size: number, name: string][];

/** India counts in lakh and crore: 12,34,56,789 is twelve crore thirty-four lakh. */
const INDIAN: Scales = [
  [10_000_000, 'crore'],
  [100_000, 'lakh'],
  [1_000, 'thousand'],
];
const WESTERN: Scales = [
  [1_000_000_000_000, 'trillion'],
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

function belowThousand(value: number): string {
  const parts: string[] = [];
  let rest = value;
  if (rest >= 100) {
    parts.push(`${ONES[Math.floor(rest / 100)]} hundred`);
    rest %= 100;
  }
  if (rest >= 20) {
    const tens = TENS[Math.floor(rest / 10)]!;
    parts.push(rest % 10 ? `${tens}-${ONES[rest % 10]}` : tens);
  } else if (rest > 0) {
    parts.push(ONES[rest]!);
  }
  return parts.join(' ');
}

function words(value: number, scales: Scales): string {
  if (value === 0) return ONES[0]!;
  const parts: string[] = [];
  let rest = value;
  for (const [size, name] of scales) {
    if (rest >= size) {
      parts.push(`${words(Math.floor(rest / size), scales)} ${name}`);
      rest %= size;
    }
  }
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** The currency's name as English writes it after a number: "US dollars", "euros". */
function currencyName(currency: string, count: number): string {
  try {
    const parts = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'name',
    }).formatToParts(count);
    return parts.find((part) => part.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/**
 * An amount in words, as printed under an invoice total. Rupees are written
 * the Indian way: "Rupees four thousand seven hundred twenty only". Other
 * currencies are written as on a cheque: "Two hundred forty US dollars and
 * 50/100 only".
 */
export function amountInWords(amount: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const scale = 10 ** exponent;
  const value = Math.abs(Math.round(amount));
  const major = Math.floor(value / scale);
  const minor = value % scale;

  if (currency === 'INR') {
    const paise =
      minor > 0 ? ` and ${words(minor, INDIAN)} ${minor === 1 ? 'paisa' : 'paise'}` : '';
    return `Rupees ${words(major, INDIAN)}${paise} only`;
  }
  const text = words(major, WESTERN);
  const fraction = minor > 0 ? ` and ${String(minor).padStart(exponent, '0')}/${scale}` : '';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} ${currencyName(currency, major)}${fraction} only`;
}
