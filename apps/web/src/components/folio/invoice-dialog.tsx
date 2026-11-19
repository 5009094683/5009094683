'use client';

import { ExternalLink } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate, formatDay, formatMoney, plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import {
  BillToFields,
  billToDraft,
  billToErrors,
  billToFromDraft,
  billToSummary,
  type BillToDraft,
  type BillToErrors,
} from './bill-to-fields';
import { isCharge, lineTotal } from './labels';
import type { Folio, FolioLine, Invoice } from './types';

export const invoiceHref = (invoiceId: string): string => `/accounts/invoices/${invoiceId}`;

/** Charges and discounts that are not voided and not yet on an invoice. */
export function invoiceableLines(folio: Folio): FolioLine[] {
  return folio.lines.filter((line) => isCharge(line) && !line.voidedAt && !line.invoiceId);
}

/** Issues a tax invoice for charges on a folio, then shows its number and where to open it. */
export function InvoiceDialog({
  folio,
  onClose,
  onIssued,
}: {
  folio: Folio;
  onClose: () => void;
  /** Called as soon as the invoice exists; the dialog stays open to show its number. */
  onIssued: () => void;
}) {
  const toast = useToast();
  const currency = folio.currency;
  // Fixed when the dialog opens: once issued, the folio refetches and these lines stop being candidates.
  const [candidates] = useState(() => invoiceableLines(folio));
  const [chosen, setChosen] = useState<string[]>(() => candidates.map((line) => line.id));
  const [other, setOther] = useState(false);
  const [billTo, setBillTo] = useState<BillToDraft>(() => billToDraft(folio.billTo));
  const [billToProblems, setBillToProblems] = useState<BillToErrors | null>(null);
  const [issued, setIssued] = useState<Invoice | null>(null);

  const lines = candidates.filter((line) => chosen.includes(line.id));
  const beforeTax = lines.reduce((sum, line) => sum + line.amount, 0);
  const tax = lines.reduce((sum, line) => sum + line.taxAmount, 0);

  const save = useAction(async () => {
    const invoice = await api<Invoice>(`/folios/${folio.id}/invoices`, {
      body: {
        ...(chosen.length < candidates.length ? { lineIds: chosen } : {}),
        ...(other ? { billTo: billToFromDraft(billTo) } : {}),
      },
    });
    setIssued(invoice);
    toast.success(`Invoice ${invoice.number} issued`);
    onIssued();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = other ? billToErrors(billTo) : null;
    setBillToProblems(problems);
    if (problems || lines.length === 0) return;
    void save.run();
  };

  if (issued) {
    return (
      <Dialog
        open
        onClose={onClose}
        size="sm"
        title="Invoice issued"
        footer={<Button onClick={onClose}>Close</Button>}
      >
        <div className="flex flex-col gap-3">
          <Notice tone="success" title={`Invoice ${issued.number}`}>
            {formatMoney(issued.totals.total, issued.currency)}, made out to {issued.buyer.name},
            dated {formatDate(issued.issuedOn)}.
          </Notice>
          <a
            href={invoiceHref(issued.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            Open invoice {issued.number}
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Issue invoice"
      description={`For charges on ${folio.label}. It gets the next invoice number and cannot be changed afterwards.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="folio-invoice-form"
            variant="primary"
            loading={save.busy}
            disabled={lines.length === 0}
          >
            Issue invoice
          </Button>
        </>
      }
    >
      <form id="folio-invoice-form" onSubmit={submit} className="flex flex-col gap-4">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <fieldset className="flex flex-col">
          <legend className="text-[13px] font-medium text-ink-soft">
            On the invoice: {plural(lines.length, 'charge')}
            {lines.length < candidates.length ? ` of ${candidates.length}` : ''}
          </legend>
          <ul className="mt-1.5 divide-y divide-line rounded-md border border-line">
            {candidates.map((line) => (
              <li key={line.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <Checkbox
                  className="min-w-0"
                  checked={chosen.includes(line.id)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...chosen, line.id]
                        : chosen.filter((id) => id !== line.id),
                    )
                  }
                  label={
                    <span className="min-w-0">
                      <span className="block text-ink">{line.description}</span>
                      <span className="block text-xs text-ink-faint">
                        {formatDay(line.businessDate)}
                      </span>
                    </span>
                  }
                />
                <span className="tabular shrink-0 text-sm text-ink">
                  {formatMoney(lineTotal(line), currency)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 px-3 text-[13px]">
            <dt className="text-ink-soft">Before tax</dt>
            <dd className="tabular text-right text-ink">{formatMoney(beforeTax, currency)}</dd>
            <dt className="text-ink-soft">Tax</dt>
            <dd className="tabular text-right text-ink">{formatMoney(tax, currency)}</dd>
            <dt className="font-medium text-ink">Invoice total</dt>
            <dd className="tabular text-right font-semibold text-ink">
              {formatMoney(beforeTax + tax, currency)}
            </dd>
          </dl>
        </fieldset>

        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <div>
            <p className="text-[13px] font-medium text-ink-soft">Made out to</p>
            <p className="mt-0.5 text-sm text-ink">
              {other ? 'The details below' : billToSummary(folio.billTo)}
            </p>
          </div>
          <Checkbox
            label="Change who it is made out to, or add a GSTIN"
            checked={other}
            onChange={(e) => setOther(e.target.checked)}
          />
          {other && (
            <BillToFields
              draft={billTo}
              onChange={(next) => {
                setBillTo(next);
                setBillToProblems(null);
              }}
              errors={billToProblems}
            />
          )}
        </div>
      </form>
    </Dialog>
  );
}
