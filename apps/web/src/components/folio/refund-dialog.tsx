'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDay, formatMoney, fromMinor } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { AMOUNT_ERROR, AmountField } from './amount-field';
import {
  CARD_NUMBER_ERROR,
  REFERENCE_HINT,
  STAFF_METHODS,
  looksLikeCardNumber,
  parseAmount,
} from './labels';
import type { FolioLine, PaymentMethod } from './types';

/** Gives back all or part of a payment. The payment stays on the bill; the refund is a new entry. */
export function RefundDialog({
  line,
  credit,
  currency,
  onClose,
  onDone,
}: {
  /** The payment's entry on the folio. */
  line: FolioLine;
  /** How far the folio is in credit, in minor units; 0 when it is not. */
  credit: number;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const paid = -line.amount;
  // An overpayment is the usual reason: the amount starts at what the guest is owed.
  const [amount, setAmount] = useState(
    String(fromMinor(credit > 0 ? Math.min(paid, credit) : paid, currency)),
  );
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [reference, setReference] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const save = useAction(async (value: number) => {
    await api(`/payments/${line.paymentId}/refund`, {
      body: {
        amount: value,
        reason: reason.trim(),
        ...(method ? { method } : {}),
        reference: reference.trim() || null,
      },
    });
    toast.success(`Refund of ${formatMoney(value, currency)} recorded`);
    onDone();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = parseAmount(amount, currency);
    const tooMuch = value !== null && value > paid;
    const badReference = looksLikeCardNumber(reference);
    setAmountError(
      value === null
        ? AMOUNT_ERROR
        : tooMuch
          ? `No more than ${formatMoney(paid, currency)} was paid.`
          : null,
    );
    setReferenceError(badReference ? CARD_NUMBER_ERROR : null);
    setReasonError(reason.trim() ? null : 'Say why the money is being given back.');
    if (value === null || tooMuch || badReference || !reason.trim()) return;
    void save.run(value);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Refund payment"
      description={`${line.description}, ${formatDay(line.businessDate)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="folio-refund-form" variant="primary" loading={save.busy}>
            Record refund
          </Button>
        </>
      }
    >
      <form id="folio-refund-form" onSubmit={submit} className="flex flex-col gap-3">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <p className="text-[13px] text-ink-soft">
          {formatMoney(paid, currency)} was paid
          {credit > 0 && `, and the folio is ${formatMoney(credit, currency)} in credit`}. This
          records the refund on the bill. It does not send any money: give it back yourself, the way
          you record it here.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <AmountField
            label="Amount to refund"
            currency={currency}
            value={amount}
            onChange={(value) => {
              setAmount(value);
              setAmountError(null);
            }}
            error={amountError}
            autoFocus
          />
          <Field label="Refunded by">
            {(props) => (
              <Select
                {...props}
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod | '')}
              >
                <option value="">Same as paid</option>
                {STAFF_METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Reason" error={reasonError}>
          {(props) => (
            <Input
              {...props}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonError(null);
              }}
              maxLength={500}
              required
            />
          )}
        </Field>
        <Field label="Reference" optional hint={REFERENCE_HINT} error={referenceError}>
          {(props) => (
            <Input
              {...props}
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
                setReferenceError(null);
              }}
              maxLength={120}
              autoComplete="off"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
