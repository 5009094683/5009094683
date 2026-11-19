'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { AMOUNT_ERROR, AmountField } from './amount-field';
import { CHARGE_OPTIONS, KIND_LABELS, TAXED_KINDS, lineTotal, parseAmount } from './labels';
import type { Folio, FolioLine, TaxedKind } from './types';

/** Posts a charge, or takes a discount off, on a folio. The server works out the tax. */
export function ChargeDialog({
  mode,
  reservationId,
  folio,
  folios,
  currency,
  onClose,
  onDone,
}: {
  mode: 'charge' | 'discount';
  reservationId: string;
  /** The folio to post to. Absent while the reservation has none: the server then opens the guest folio. */
  folio?: Folio;
  /** The reservation's folios, to say where a kind of charge normally goes. */
  folios: Folio[];
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const discount = mode === 'discount';
  const [kind, setKind] = useState<TaxedKind>(discount ? 'room' : 'food');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);

  const unitAmount = parseAmount(amount, currency);
  const count = Math.max(1, Math.round(Number(quantity)) || 1);
  const usual = folio
    ? folios.find((f) => f.id !== folio.id && f.status === 'open' && f.routes.includes(kind))
    : undefined;

  const save = useAction(async (unit: number) => {
    const line = await api<FolioLine>(
      folio ? `/folios/${folio.id}/charges` : `/reservations/${reservationId}/charges`,
      {
        body: discount
          ? {
              kind: 'discount',
              description: description.trim(),
              unitAmount: unit,
              discountOn: kind,
            }
          : { kind, description: description.trim(), unitAmount: unit, quantity: count },
      },
    );
    if (discount) {
      toast.success(
        'Discount added',
        `${line.description}: ${formatMoney(-lineTotal(line), currency)} taken off, tax included`,
      );
    } else {
      toast.success(
        'Charge added',
        `${line.description}: ${formatMoney(lineTotal(line), currency)} with tax`,
      );
    }
    onDone();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const blank = !description.trim();
    setAmountError(unitAmount === null ? AMOUNT_ERROR : null);
    setDescriptionError(
      !blank ? null : discount ? 'Say why the discount is given.' : 'Say what the charge is for.',
    );
    if (unitAmount === null || blank) return;
    void save.run(unitAmount);
  };

  const changeDescription = (value: string) => {
    setDescription(value);
    setDescriptionError(null);
  };

  const changeAmount = (value: string) => {
    setAmount(value);
    setAmountError(null);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={discount ? 'Add discount' : 'Add charge'}
      description={folio ? `On ${folio.label}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="folio-charge-form" variant="primary" loading={save.busy}>
            {discount ? 'Add discount' : 'Add charge'}
          </Button>
        </>
      }
    >
      <form id="folio-charge-form" onSubmit={submit} className="flex flex-col gap-3">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {discount ? (
          <>
            <AmountField
              label="Amount to take off, before tax"
              currency={currency}
              value={amount}
              onChange={changeAmount}
              error={amountError}
              autoFocus
            />
            <Field label="Applies to" hint="The tax on that kind of charge comes off with it.">
              {(props) => (
                <Select
                  {...props}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as TaxedKind)}
                >
                  {TAXED_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {KIND_LABELS[value]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reason" error={descriptionError}>
              {(props) => (
                <Input
                  {...props}
                  value={description}
                  onChange={(e) => changeDescription(e.target.value)}
                  maxLength={300}
                  required
                />
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="What is it for">
              {(props) => (
                <Select
                  {...props}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as TaxedKind)}
                  autoFocus
                >
                  {CHARGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Description" error={descriptionError}>
              {(props) => (
                <Input
                  {...props}
                  value={description}
                  onChange={(e) => changeDescription(e.target.value)}
                  placeholder={CHARGE_OPTIONS.find((o) => o.value === kind)?.example}
                  maxLength={300}
                  required
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <AmountField
                label="Price before tax"
                currency={currency}
                value={amount}
                onChange={changeAmount}
                error={amountError}
              />
              <Field label="Quantity">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    inputMode="numeric"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="tabular"
                    required
                  />
                )}
              </Field>
            </div>
            <p className="text-[13px] text-ink-soft">
              {unitAmount !== null && count > 1
                ? `${count} × ${formatMoney(unitAmount, currency)} = ${formatMoney(unitAmount * count, currency)} before tax. `
                : ''}
              Tax is added by the system when the charge is saved.
            </p>
            {kind === 'room' && (
              <Notice tone="info">
                Room nights are charged by the night audit and at check-out. Add one by hand only
                for something they do not cover.
              </Notice>
            )}
            {usual && folio && (
              <Notice tone="info">
                {KIND_LABELS[kind]} charges normally go to {usual.label}. This one goes on{' '}
                {folio.label}.
              </Notice>
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}
