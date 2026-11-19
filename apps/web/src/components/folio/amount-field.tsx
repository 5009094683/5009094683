'use client';

import type { ReactNode } from 'react';
import { Field, Input } from '@/components/ui/field';

/** An amount typed in major units (rupees, with decimals). Callers convert it with `parseAmount`. */
export function AmountField({
  label,
  currency,
  value,
  onChange,
  error,
  hint,
  autoFocus,
  className,
}: {
  label: string;
  currency: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: ReactNode;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <Field label={`${label} (${currency})`} error={error} hint={hint} className={className}>
      {(props) => (
        <Input
          {...props}
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          className="tabular"
        />
      )}
    </Field>
  );
}

export const AMOUNT_ERROR = 'Enter an amount above zero.';
