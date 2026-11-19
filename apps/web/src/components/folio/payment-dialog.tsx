'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatMoney, fromMinor } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { balanceText, parseAmount } from './labels';
import {
  PaymentFields,
  checkPayment,
  type PaymentDraft,
  type PaymentErrors,
} from './payment-fields';
import type { Folio } from './types';

/** Records money received on a folio. */
export function PaymentDialog({
  folio,
  currency,
  onClose,
  onDone,
}: {
  folio: Folio;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const owed = folio.totals.balance;
  const [draft, setDraft] = useState<PaymentDraft>({
    method: 'cash',
    amount: owed > 0 ? String(fromMinor(owed, currency)) : '',
    reference: '',
  });
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<PaymentErrors>({});

  const typed = parseAmount(draft.amount, currency);
  const over = typed !== null ? typed - Math.max(owed, 0) : 0;

  const save = useAction(async (amount: number) => {
    await api(`/folios/${folio.id}/payments`, {
      body: {
        method: draft.method,
        amount,
        reference: draft.reference.trim() || null,
        note: note.trim() || null,
      },
    });
    toast.success(`Payment of ${formatMoney(amount, currency)} recorded`);
    onDone();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = checkPayment(draft, currency);
    if (checked.errors) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    void save.run(checked.amount);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Record payment"
      description={`${folio.label} · ${balanceText(owed, currency).text}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="folio-payment-form" variant="primary" loading={save.busy}>
            Record payment
          </Button>
        </>
      }
    >
      <form id="folio-payment-form" onSubmit={submit} className="flex flex-col gap-3">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <PaymentFields
          draft={draft}
          currency={currency}
          onChange={(next) => {
            setDraft(next);
            setErrors({});
          }}
          errors={errors}
          autoFocus
        />
        {over > 0 && (
          <Notice tone="warning">
            That is {formatMoney(over, currency)} more than is owed on this folio. The guest will be
            in credit.
          </Notice>
        )}
        <Field label="Note" optional>
          {(props) => (
            <Input
              {...props}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
