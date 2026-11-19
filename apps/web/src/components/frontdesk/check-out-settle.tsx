'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { CompanyCredit } from '@/components/folio/bill-company-dialog';
import { useCompanies } from '@/components/folio/data';
import {
  PaymentFields,
  checkPayment,
  type PaymentDraft,
  type PaymentErrors,
} from '@/components/folio/payment-fields';
import type { Folio, PaymentMethod } from '@/components/folio/types';
import { Notice } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatMoney, fromMinor } from '@/lib/format';
import type { Reservation } from '@/lib/types';

export type SettleChoice = 'pay' | 'bill_company' | 'leave_open';

export interface PaymentToTake {
  folio: Folio;
  method: PaymentMethod;
  amount: number;
  reference: string;
}

/**
 * What each folio will owe once the nights charged at check-out are on the bill. The refused
 * check-out left nothing behind, so those nights are not on any folio yet: they are the part of
 * `due` the folios do not account for, and they go to the folio that takes room charges.
 */
export function owedByFolio(folios: Folio[], due: number): { folio: Folio; owed: number }[] {
  const known = folios.reduce((sum, folio) => sum + folio.totals.balance, 0);
  const takesRoom =
    folios.find((folio) => folio.status === 'open' && folio.routes.includes('room')) ?? folios[0];
  return folios
    .map((folio) => ({
      folio,
      owed: folio.totals.balance + (folio.id === takesRoom?.id ? due - known : 0),
    }))
    .filter((entry) => entry.owed > 0);
}

function Choice({
  value,
  current,
  onPick,
  title,
  description,
  disabled,
  children,
}: {
  value: SettleChoice;
  current: SettleChoice | null;
  onPick: (value: SettleChoice) => void;
  title: string;
  description: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const picked = current === value;
  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        picked ? 'border-brand-500 bg-brand-50/50' : 'border-line',
      )}
    >
      <label className={cn('flex items-start gap-2.5', !disabled && 'cursor-pointer')}>
        <input
          type="radio"
          name="settle-choice"
          className="mt-0.5 size-4 shrink-0 accent-brand-600"
          checked={picked}
          disabled={disabled}
          onChange={() => onPick(value)}
        />
        <span className="min-w-0">
          <span
            className={cn('block text-sm font-medium', disabled ? 'text-ink-soft' : 'text-ink')}
          >
            {title}
          </span>
          <span className="block text-[13px] text-ink-soft">{description}</span>
        </span>
      </label>
      {picked && children && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

/** The ways to deal with money still owed when the last room leaves. */
export function SettleForm({
  formId,
  due,
  reservation,
  folios,
  canPay,
  choice,
  onChoice,
  onPay,
  onCheckOut,
}: {
  formId: string;
  /** What the server says is owed, nights charged at check-out included. Above zero. */
  due: number;
  reservation: Reservation;
  folios: Folio[];
  /** Whether the user may record payments. */
  canPay: boolean;
  choice: SettleChoice | null;
  onChoice: (choice: SettleChoice) => void;
  onPay: (payments: PaymentToTake[]) => void;
  onCheckOut: (balance: 'bill_company' | 'leave_open') => void;
}) {
  const currency = reservation.currency;
  const owing = owedByFolio(folios, due);
  const charged = folios.reduce((sum, folio) => sum + folio.totals.balance, 0);
  const atCheckOut = due - charged;
  const { companies } = useCompanies(Boolean(reservation.company));
  const company = companies.find((candidate) => candidate.id === reservation.company?.id);

  const [drafts, setDrafts] = useState<Record<string, PaymentDraft>>(() =>
    Object.fromEntries(
      owing.map(({ folio, owed }) => [
        folio.id,
        { method: 'cash', amount: String(fromMinor(owed, currency)), reference: '' },
      ]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, PaymentErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const typed = owing.reduce((sum, { folio }) => {
    const draft = drafts[folio.id];
    const checked = draft ? checkPayment(draft, currency) : null;
    return sum + (checked?.amount ?? 0);
  }, 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (choice === 'bill_company' || choice === 'leave_open') {
      onCheckOut(choice);
      return;
    }
    if (choice !== 'pay') return;
    const payments: PaymentToTake[] = [];
    const problems: Record<string, PaymentErrors> = {};
    for (const { folio } of owing) {
      const draft = drafts[folio.id];
      if (!draft) continue;
      // With several folios, one left empty is simply not paid now.
      if (owing.length > 1 && draft.amount.trim() === '' && !draft.reference.trim()) continue;
      const checked = checkPayment(draft, currency);
      if (checked.errors) problems[folio.id] = checked.errors;
      else {
        payments.push({
          folio,
          method: draft.method,
          amount: checked.amount,
          reference: draft.reference.trim(),
        });
      }
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    if (payments.length === 0) {
      setFormError('Enter the amount received.');
      return;
    }
    setFormError(null);
    onPay(payments);
  };

  return (
    <form id={formId} onSubmit={submit}>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">How to settle the bill</legend>
        <Choice
          value="pay"
          current={choice}
          onPick={onChoice}
          title="Take payment now"
          disabled={!canPay || owing.length === 0}
          description={
            !canPay
              ? 'You do not have permission to record payments.'
              : owing.length === 0
                ? 'The bill cannot be read here, so a payment cannot be recorded.'
                : 'Record what the guest pays, then check out.'
          }
        >
          {formError && <Notice tone="danger">{formError}</Notice>}
          {owing.map(({ folio, owed }, index) => {
            const draft = drafts[folio.id];
            if (!draft) return null;
            return (
              <div key={folio.id} className="flex flex-col gap-2">
                {owing.length > 1 && (
                  <p className="text-[13px] font-medium text-ink">
                    {folio.label}: {formatMoney(owed, currency)} owed
                  </p>
                )}
                <PaymentFields
                  draft={draft}
                  currency={currency}
                  onChange={(next) => {
                    setDrafts({ ...drafts, [folio.id]: next });
                    setErrors({ ...errors, [folio.id]: {} });
                    setFormError(null);
                  }}
                  errors={errors[folio.id]}
                  noReferenceHint={index > 0}
                />
              </div>
            );
          })}
          {atCheckOut > 0 && (
            <p className="text-[13px] text-ink-soft">
              Includes {formatMoney(atCheckOut, currency)} for nights that are charged at check-out.
            </p>
          )}
          {typed > due && (
            <Notice tone="warning">
              That is {formatMoney(typed - due, currency)} more than is owed. The guest would be in
              credit, and you would be asked what to do about it.
            </Notice>
          )}
          {typed > 0 && typed < due && (
            <Notice tone="info">
              {formatMoney(due - typed, currency)} will still be owed. You will be asked what to do
              about the rest.
            </Notice>
          )}
        </Choice>

        <Choice
          value="bill_company"
          current={choice}
          onPick={onChoice}
          title={reservation.company ? `Bill to ${reservation.company.name}` : 'Bill to company'}
          disabled={!reservation.company}
          description={
            reservation.company
              ? `${formatMoney(due, currency)} moves to the company's account, to be paid later.`
              : 'This reservation is not linked to a company. Link one first: open the reservation and set Company, then check out again.'
          }
        >
          {company && <CompanyCredit company={company} adding={due} currency={currency} />}
        </Choice>

        <Choice
          value="leave_open"
          current={choice}
          onPick={onChoice}
          title="Check out and leave the bill open"
          description={`${formatMoney(due, currency)} stays owed on the folio and can be collected later.`}
        />
      </fieldset>
    </form>
  );
}
