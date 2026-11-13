import type { MealPlan, Property } from './types';

const fractionDigitsCache = new Map<string, number>();

function fractionDigits(currency: string): number {
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    fractionDigitsCache.set(currency, digits);
  }
  return digits;
}

/** `₹9,450` from 945000 minor units. Whole amounts drop the decimals. */
export function formatMoney(amount: number, currency: string): string {
  const digits = fractionDigits(currency);
  const value = amount / 10 ** digits;
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

/** `1 night`, `3 nights`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `2 adults`, `2 adults, 1 child`. */
export function party(adults: number, children: number): string {
  const grownUps = count(adults, 'adult');
  return children > 0 ? `${grownUps}, ${count(children, 'child', 'children')}` : grownUps;
}

const MEAL_PLANS: Record<MealPlan, string> = {
  room_only: 'Room only',
  breakfast: 'Breakfast included',
  half_board: 'Breakfast and dinner included',
  full_board: 'All meals included',
  all_inclusive: 'All meals and drinks included',
};

export function mealPlanLabel(mealPlan: MealPlan | null): string | null {
  return mealPlan ? MEAL_PLANS[mealPlan] : null;
}

/** `Candolim, Goa` */
export function placeOf(property: Pick<Property, 'city' | 'state'>): string {
  return [property.city, property.state].filter(Boolean).join(', ');
}

export function kindLabel(kind: string): string {
  const words = kind.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `340 KB`, `1.2 MB` */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
