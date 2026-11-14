'use client';

import { ArrowLeft, FileMinus, Printer } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { useReturnFocus } from '@/components/housekeeping/focus';
import { Button } from '@/components/ui/button';
import { Card, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { useLive } from '@/lib/live';
import { CreditNoteDialog } from './credit-note-dialog';
import { InvoiceDocument } from './invoice-document';
import { money } from './money';
import { NoAccess } from './no-access';
import { usePrintTitle } from './print-title';
import type { Invoice } from './types';

const LIST = '/accounts/invoices';

/** What was loaded for another invoice must never stand in for this one, not even for a moment. */
const ONE_DOCUMENT = { keepPreviousData: false };

/** Credit notes issued against an invoice, with what is left of it to credit. */
function CreditNotes({ invoice, notes }: { invoice: Invoice; notes: Invoice[] }) {
  const credited = notes.reduce((sum, note) => sum - note.totals.taxable, 0);
  const left = invoice.totals.taxable - credited;
  return (
    <Card className="mx-auto mt-4 w-full max-w-[210mm] print:hidden">
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
        Credit notes against this invoice
      </h2>
      <ul className="divide-y divide-line">
        {notes.map((note) => (
          <li key={note.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
            <div className="min-w-0">
              <Link
                href={`${LIST}/${note.id}`}
                className="font-medium text-brand-700 hover:underline"
              >
                {note.number}
              </Link>
              <span className="text-ink-soft"> · {formatDate(note.issuedOn)}</span>
              {note.reason && <p className="text-[13px] text-ink-soft">{note.reason}</p>}
            </div>
            <span className="tabular shrink-0 text-right text-ink">
              {money(-note.totals.total, note.currency)}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-3 text-[13px] text-ink-soft">
        {left > 0
          ? `${money(left, invoice.currency)} before tax is left that could still be credited.`
          : 'This invoice has been credited in full.'}
      </p>
    </Card>
  );
}

/** One invoice or credit note: the printable document, and the ways to act on it. */
export function InvoiceView({ invoiceId }: { invoiceId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const allowed = auth.can('folio.read');
  const [crediting, setCrediting] = useState(false);
  const rememberOpener = useReturnFocus(crediting);

  const {
    data: invoice,
    error,
    isLoading,
    mutate,
  } = useSWR<Invoice>(allowed ? `/invoices/${invoiceId}` : null, ONE_DOCUMENT);
  // There is no way to ask for the credit notes of one invoice, so the property's are read
  // from the invoice's date on and matched here.
  const related = useSWR<{ invoices: Invoice[] }>(
    invoice?.type === 'invoice'
      ? `/invoices${query({
          propertyIds: invoice.propertyId,
          type: 'credit_note',
          from: invoice.issuedOn,
          limit: 1000,
        })}`
      : null,
    ONE_DOCUMENT,
  );
  useLive(/^folio\./, () => void related.mutate());
  usePrintTitle(
    invoice
      ? `${invoice.type === 'credit_note' ? 'Credit note' : 'Tax invoice'} ${invoice.number}`
      : null,
  );

  if (!allowed) return <NoAccess />;
  if (error && !invoice) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <ErrorState error={error} onRetry={() => void mutate()} />
        <p className="mt-3 text-center text-sm">
          <Link href={LIST} className="font-medium text-brand-700 hover:underline">
            Back to invoices
          </Link>
        </p>
      </div>
    );
  }
  if (isLoading || !invoice) return <PageLoading label="Loading the invoice" />;

  const credit = invoice.type === 'credit_note';
  const notes = (related.data?.invoices ?? []).filter(
    (note) => note.relatedInvoiceId === invoice.id,
  );
  const credited = notes.reduce((sum, note) => sum - note.totals.taxable, 0);
  const canCredit = !credit && auth.can('accounting.manage', invoice.propertyId);
  // Until the earlier credit notes are known, how much is left to credit is not known either.
  const creditReady = related.data !== undefined && credited < invoice.totals.taxable;

  // Back returns to the list as it was left, filters and all, when the invoice was opened from it.
  const back = () => (window.history.length > 1 ? router.back() : router.push(LIST));

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mx-auto mb-4 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Button icon={<ArrowLeft className="size-4" aria-hidden />} onClick={back}>
            Back
          </Button>
          <h1 className="truncate text-base font-semibold text-ink">
            {credit ? 'Credit note' : 'Invoice'} {invoice.number}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {canCredit && (
            <Button
              icon={<FileMinus className="size-4" aria-hidden />}
              onClick={() => {
                rememberOpener();
                setCrediting(true);
              }}
              disabled={!creditReady}
            >
              Issue credit note
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Printer className="size-4" aria-hidden />}
            onClick={() => window.print()}
          >
            Print
          </Button>
        </div>
      </div>

      {credit && invoice.relatedInvoiceId && (
        <Notice tone="info" className="mx-auto mb-4 w-full max-w-[210mm] print:hidden">
          This credit note corrects invoice{' '}
          <Link
            href={`${LIST}/${invoice.relatedInvoiceId}`}
            className="font-medium underline hover:no-underline"
          >
            {invoice.reference.invoice ?? 'issued earlier'}
          </Link>
          .
        </Notice>
      )}

      {/* Without this the invoice would look as if nothing had been credited against it. */}
      {related.error && !related.data && (
        <Notice tone="warning" className="mx-auto mb-4 w-full max-w-[210mm] print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p>
              The credit notes against this invoice could not be loaded.
              {canCredit && ' A new one cannot be issued until they are.'}
            </p>
            <Button loading={related.isValidating} onClick={() => void related.mutate()}>
              Try again
            </Button>
          </div>
        </Notice>
      )}

      <InvoiceDocument invoice={invoice} />

      {notes.length > 0 && <CreditNotes invoice={invoice} notes={notes} />}

      {crediting && (
        <CreditNoteDialog
          invoice={invoice}
          credited={credited}
          onClose={() => setCrediting(false)}
          onIssued={(note) => {
            setCrediting(false);
            void related.mutate();
            router.push(`${LIST}/${note.id}`);
          }}
        />
      )}
    </div>
  );
}
