'use client';

import { Field, Input, Select } from '@/components/ui/field';
import { AMOUNT_ERROR, AmountField } from './amount-field';
import {
  CARD_NUMBER_ERROR,
  REFERENCE_HINT,
  STAFF_METHODS,
  looksLikeCardNumber,
  parseAmount,
} from './labels';
import type { PaymentMethod } from './types';

/** A payment as it is being typed. The amount is in major units. */
export interface PaymentDraft {
  method: PaymentMethod;
  amount: string;
  reference: string;
}

export interface PaymentErrors {
  amount?: string;
  reference?: string;
}

/** The amount in minor units when the draft can be sent, else what is wrong with it. */
export function checkPayment(
  draft: PaymentDraft,
  currency: string,
): { amount: number; errors: null } | { amount: null; errors: PaymentErrors } {
  const amount = parseAmount(draft.amount, currency);
  const errors: PaymentErrors = {};
  if (amount === null) errors.amount = AMOUNT_ERROR;
  if (looksLikeCardNumber(draft.reference)) errors.reference = CARD_NUMBER_ERROR;
  if (amount === null || errors.reference) return { amount: null, errors };
  return { amount, errors: null };
}

/** How the money was paid, how much, and the reference staff can find it by. */
export function PaymentFields({
  draft,
  currency,
  onChange,
  errors,
  amountHint,
  autoFocus,
  noReferenceHint,
}: {
  draft: PaymentDraft;
  currency: string;
  onChange: (draft: PaymentDraft) => void;
  errors?: PaymentErrors;
  amountHint?: string;
  autoFocus?: boolean;
  /** For the second and later payments on one form, where the hint is already shown above. */
  noReferenceHint?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Paid by">
        {(props) => (
          <Select
            {...props}
            value={draft.method}
            onChange={(e) => onChange({ ...draft, method: e.target.value as PaymentMethod })}
          >
            {STAFF_METHODS.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <AmountField
        label="Amount"
        currency={currency}
        value={draft.amount}
        onChange={(amount) => onChange({ ...draft, amount })}
        error={errors?.amount}
        hint={amountHint}
        autoFocus={autoFocus}
      />
      <Field
        label="Reference"
        optional
        className="col-span-2"
        hint={noReferenceHint ? undefined : REFERENCE_HINT}
        error={errors?.reference}
      >
        {(props) => (
          <Input
            {...props}
            value={draft.reference}
            onChange={(e) => onChange({ ...draft, reference: e.target.value })}
            maxLength={120}
            autoComplete="off"
          />
        )}
      </Field>
    </div>
  );
}
