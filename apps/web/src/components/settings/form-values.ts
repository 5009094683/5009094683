import { fromMinor, toMinor } from '@/lib/format';

/** Empty text becomes null, which is how the API clears an optional field. */
export function textOrNull(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}

/** The whole number typed into a number input, or null when the input is empty. */
export function intOrNull(value: string): number | null {
  return value.trim() === '' ? null : Math.round(Number(value));
}

/** An amount typed in major units (4500 or 4500.50) as minor units, or null when empty. */
export function minorOrNull(value: string, currency: string): number | null {
  return value.trim() === '' ? null : toMinor(Number(value), currency);
}

/** A stored amount in minor units as the text to edit, in major units. */
export function majorText(amount: number | null, currency: string): string {
  return amount === null ? '' : String(fromMinor(amount, currency));
}

/**
 * The entries of `next` that differ from `before`. A PATCH built from this
 * carries only what the user changed, so the audit trail records exactly that
 * and the server does not redo work for fields that stayed the same.
 */
export function changedFields<T extends object>(
  before: { [K in keyof T]?: unknown },
  next: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(next[key] ?? null)) {
      out[key] = next[key];
    }
  }
  return out;
}

/**
 * Carries a form that is being edited over to newer server data: fields the
 * user has not touched take the new value, edited fields keep the edit. Without
 * this, saving would quietly undo a change someone else made in the meantime.
 */
export function rebase<T extends object>(values: T, before: T, after: T): T {
  const next = { ...values };
  for (const key of Object.keys(values) as (keyof T)[]) {
    if (JSON.stringify(values[key]) === JSON.stringify(before[key])) next[key] = after[key];
  }
  return next;
}

/** Splits a list typed with commas, semicolons, spaces or line breaks; drops blanks and repeats. */
export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
