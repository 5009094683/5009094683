'use client';

import { useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { amountText, money, parseAmount } from './money';

/** A company's account at one property, with what is needed to take a payment into it. */
export interface PayableAccount {
  folioId: string;
  propertyName: string;
  currency: string;
  balance: number;
}

/** The ways a company pays that staff can enter. Online and channel payments record themselves. */
const METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
] as const;

type Method = (typeof METHODS)[number]['value'];

/** Records money received from a company against its account at one property. */
export function PaymentDialog({
  companyName,
  accounts,
  onClose,
  onSaved,
}: {
  companyName: string;
  /** The accounts the payment may go into: with more than one, the dialog asks which. */
  accounts: PayableAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const first = accounts[0];
  const [folioId, setFolioId] = useState(first?.folioId ?? '');
  const account = accounts.find((a) => a.folioId === folioId);
  const [method, setMethod] = useState<Method>('bank_transfer');
  const [amount, setAmount] = useState(
    first && first.balance > 0 ? amountText(first.balance, first.currency) : '',
  );
  const [reference, setReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const changeAccount = (id: string) => {
    setFolioId(id);
    const next = accounts.find((a) => a.folioId === id);
    setAmount(next && next.balance > 0 ? amountText(next.balance, next.currency) : '');
    setProblem(null);
  };

  const save = useAction(async () => {
    if (!account) throw new Error('Choose the account to pay into.');
    const value = parseAmount(amount, account.currency);
    if (value === null || value === 0) {
      setProblem('Enter the amount received, above zero.');
      return;
    }
    setProblem(null);
    await api(`/folios/${account.folioId}/payments`, {
      body: { method, amount: value, reference: reference.trim() || null },
    });
    const after = account.balance - value;
    toast.success(
      `Payment of ${money(value, account.currency)} recorded`,
      after > 0
        ? `${companyName} still owes ${money(after, account.currency)} at ${account.propertyName}.`
        : after < 0
          ? `${companyName} is now ${money(-after, account.currency)} in credit at ${account.propertyName}.`
          : `${companyName} owes nothing at ${account.propertyName}.`,
    );
    onSaved();
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Record a payment"
      description={
        accounts.length === 1 && account
          ? `From ${companyName}, for ${account.propertyName}`
          : `From ${companyName}`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="company-payment-form" variant="primary" loading={save.busy}>
            Record payment
          </Button>
        </>
      }
    >
      <form
        id="company-payment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        <FormError message={save.error} />
        {accounts.length > 1 && (
          <Field label="Account" hint="Each property keeps its own account for the company.">
            {(props) => (
              <Select
                {...props}
                value={folioId}
                onChange={(event) => changeAccount(event.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.folioId} value={a.folioId}>
                    {a.propertyName}: owes {money(a.balance, a.currency)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {account && accounts.length === 1 && (
          <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-soft">
            Owes {money(account.balance, account.currency)} on this account.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid by">
            {(props) => (
              <Select
                {...props}
                value={method}
                onChange={(event) => setMethod(event.target.value as Method)}
              >
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={account ? `Amount (${account.currency})` : 'Amount'} error={problem}>
            {(props) => (
              <Input
                {...props}
                required
                inputMode="decimal"
                autoFocus
                className="text-right"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setProblem(null);
                }}
              />
            )}
          </Field>
        </div>
        <Field
          label="Reference"
          optional
          hint="Bank reference, cheque or receipt number. Never a card number."
        >
          {(props) => (
            <Input
              {...props}
              maxLength={120}
              autoComplete="off"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
