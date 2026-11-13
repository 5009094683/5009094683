'use client';

import { useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Segmented, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { amountText, money, parseAmount } from './money';
import type { Invoice, InvoiceLine } from './types';

type Mode = 'whole' | 'lines';

const MODES: { value: Mode; label: string }[] = [
  { value: 'whole', label: 'The whole invoice' },
  { value: 'lines', label: 'Chosen lines' },
];

/** Tax goes back in the same proportion as the amount, component by component, as the server works it out. */
function taxOn(line: InvoiceLine, credit: number): number {
  return line.taxes.reduce((sum, tax) => sum + Math.round((tax.amount * credit) / line.amount), 0);
}

/**
 * Corrects an invoice. An invoice is never edited: a credit note is issued
 * against it for the whole of it, or for chosen lines and amounts.
 */
export function CreditNoteDialog({
  invoice,
  credited,
  onClose,
  onIssued,
}: {
  invoice: Invoice;
  /** What earlier credit notes took off this invoice, before tax. */
  credited: number;
  onClose: () => void;
  onIssued: (note: Invoice) => void;
}) {
  const toast = useToast();
  const { currency } = invoice;
  const left = invoice.totals.taxable - credited;
  const hasDiscount = invoice.lines.some((line) => line.amount <= 0);
  const wholeAllowed = credited === 0 && !hasDiscount;

  const [mode, setMode] = useState<Mode>(wholeAllowed ? 'whole' : 'lines');
  const [reason, setReason] = useState('');
  /** The amount typed for each chosen line, by the line's position on the invoice. */
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  /** How many times the form was sent with something wrong: nothing is pointed out before the first. */
  const [attempts, setAttempts] = useState(0);

  const chosen = invoice.lines.flatMap((line, index) => {
    const typed = amounts[index];
    if (typed === undefined) return [];
    const credit = parseAmount(typed, currency);
    const valid = credit !== null && credit > 0 && credit <= line.amount;
    return [{ index, line, credit: valid ? credit : null }];
  });
  const sum = chosen.reduce((total, row) => total + (row.credit ?? 0), 0);
  const tax =
    mode === 'whole'
      ? invoice.totals.taxTotal
      : chosen.reduce((total, row) => total + (row.credit ? taxOn(row.line, row.credit) : 0), 0);
  const taxable = mode === 'whole' ? invoice.totals.taxable : sum;

  const problem = !reason.trim()
    ? 'Say why the invoice is being corrected.'
    : mode === 'whole'
      ? null
      : chosen.length === 0
        ? 'Tick at least one line to credit.'
        : chosen.some((row) => row.credit === null)
          ? 'Check the amounts: each has to be above zero and no more than was invoiced.'
          : sum > left
            ? `That is more than is left to credit on this invoice: ${money(left, currency)} before tax.`
            : null;

  const save = useAction(async () => {
    if (problem) {
      setAttempts((count) => count + 1);
      return;
    }
    const note = await api<Invoice>(`/invoices/${invoice.id}/credit-notes`, {
      body: {
        reason: reason.trim(),
        ...(mode === 'lines'
          ? { lines: chosen.map((row) => ({ index: row.index, amount: row.credit ?? 0 })) }
          : {}),
      },
    });
    toast.success(
      `Credit note ${note.number} issued`,
      `${money(-note.totals.total, currency)} is taken off the folio.`,
    );
    onIssued(note);
  });

  const toggle = (index: number, line: InvoiceLine, on: boolean) => {
    setAmounts((current) => {
      const next = { ...current };
      if (on) next[index] = amountText(Math.min(line.amount, Math.max(left, 0)), currency);
      else delete next[index];
      return next;
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Issue a credit note against ${invoice.number}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="credit-note-form" variant="primary" loading={save.busy}>
            Issue credit note
          </Button>
        </>
      }
    >
      <form
        id="credit-note-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-4"
      >
        <FormError message={save.error} />
        <Notice tone="info">
          An invoice cannot be changed once it is issued. A credit note corrects it: the amount
          credited, with its tax, comes off the folio. If that was already paid, the folio then
          shows it in the guest&apos;s favour, to refund or to set against other charges.
        </Notice>

        <Field label="Reason" hint="Printed on the credit note.">
          {(props) => (
            <Textarea
              {...props}
              required
              maxLength={500}
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-ink-soft">What to credit</p>
          {wholeAllowed ? (
            <div>
              <Segmented label="What to credit" value={mode} onChange={setMode} options={MODES} />
            </div>
          ) : (
            <p className="text-[13px] text-ink-soft">
              {credited > 0
                ? `${money(credited, currency)} of this invoice has been credited already. ${money(left, currency)} before tax is left to credit.`
                : 'This invoice has a discount on it, so it cannot be credited in one go.'}
            </p>
          )}
          {mode === 'lines' && (
            <p className="text-[13px] text-ink-soft">
              Tick the lines to credit. To credit only part of a line, change its amount.
            </p>
          )}
        </div>

        {mode === 'lines' && (
          <ul className="divide-y divide-line rounded-md border border-line">
            {invoice.lines.map((line, index) => {
              const typed = amounts[index];
              const row = chosen.find((r) => r.index === index);
              const invalid = attempts > 0 && row !== undefined && row.credit === null;
              return (
                <li key={index} className="flex flex-col gap-2 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <Checkbox
                      label={
                        <span>
                          {line.description}
                          <span className="block text-[13px] text-ink-faint">
                            {formatDate(line.date)}
                          </span>
                        </span>
                      }
                      className="items-start [&>input]:mt-0.5"
                      checked={typed !== undefined}
                      disabled={line.amount <= 0}
                      onChange={(event) => toggle(index, line, event.target.checked)}
                    />
                    <span className="tabular shrink-0 text-right text-sm text-ink-soft">
                      {money(line.amount, currency)}
                      <span className="block text-[13px] text-ink-faint">before tax</span>
                    </span>
                  </div>
                  {line.amount <= 0 && (
                    <p className="pl-6 text-[13px] text-ink-faint">
                      A discount cannot be credited.
                    </p>
                  )}
                  {typed !== undefined && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
                      <Input
                        aria-label={`Amount to credit for ${line.description}, ${formatDate(line.date)}`}
                        aria-invalid={invalid || undefined}
                        inputMode="decimal"
                        className="w-32 text-right"
                        value={typed}
                        onChange={(event) =>
                          setAmounts((current) => ({ ...current, [index]: event.target.value }))
                        }
                      />
                      <span className="text-[13px] text-ink-soft">
                        {row?.credit
                          ? `plus ${money(taxOn(line, row.credit), currency)} tax`
                          : `up to ${money(line.amount, currency)}`}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {attempts > 0 && <FormError key={attempts} tone="warning" message={problem} />}

        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-md bg-sunken px-3 py-2.5 text-sm">
          <dt className="text-ink-soft">Credit before tax</dt>
          <dd className="tabular text-right">{money(taxable, currency)}</dd>
          <dt className="text-ink-soft">Tax</dt>
          <dd className="tabular text-right">{money(tax, currency)}</dd>
          <dt className="font-medium text-ink">Total credit</dt>
          <dd className="tabular text-right font-medium text-ink">
            {money(taxable + tax, currency)}
          </dd>
        </dl>
      </form>
    </Dialog>
  );
}
