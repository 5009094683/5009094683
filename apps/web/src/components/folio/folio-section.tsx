'use client';

import { ExternalLink, Plus, Split } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney } from '@/lib/format';
import { useLive } from '@/lib/live';
import type { Reservation } from '@/lib/types';
import { BillCompanyDialog } from './bill-company-dialog';
import { ChargeDialog } from './charge-dialog';
import { useReservationFolios } from './data';
import { FolioCard, type FolioAction } from './folio-card';
import { InvoiceDialog, invoiceHref } from './invoice-dialog';
import { BALANCE_TEXT_TONES, balanceText, lineDescription } from './labels';
import { MoveDialog } from './move-dialog';
import { PaymentDialog } from './payment-dialog';
import { RefundDialog } from './refund-dialog';
import { SplitDialog } from './split-dialog';
import type { Folio, Invoice } from './types';
import { VoidDialog } from './void-dialog';

const BILL_ELEMENT_ID = 'reservation-bill';

/**
 * Brings the bill of the reservation on screen into view. It may be asked for before the
 * reservation or its folios have loaded, so it waits a few seconds for them to appear.
 */
export function scrollToBill(): void {
  let tries = 0;
  const attempt = () => {
    const bill = document.getElementById(BILL_ELEMENT_ID);
    if (bill?.dataset.ready) bill.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (tries++ < 50) window.setTimeout(attempt, 100);
  };
  attempt();
}

// Folios and lines are kept by id, so that a dialog always works on what was last loaded.
type OpenDialog =
  | { kind: 'charge' | 'discount'; folioId: string | null }
  | { kind: 'payment' | 'move' | 'company' | 'invoice'; folioId: string }
  | { kind: 'void' | 'refund'; folioId: string; lineId: string }
  | { kind: 'split' };

const BILLED_STATUSES: readonly string[] = ['confirmed', 'in_house', 'checked_out'];

function InvoiceList({ invoices }: { invoices: Invoice[] }) {
  return (
    <div>
      <h4 className="text-[13px] font-medium text-ink-soft">Invoices</h4>
      <ul className="mt-1.5 divide-y divide-line rounded-md border border-line text-[13px]">
        {invoices.map((invoice) => (
          <li key={invoice.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
            <a
              href={invoiceHref(invoice.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              {invoice.number}
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <span className="text-ink-soft">
              {invoice.type === 'credit_note' ? 'Credit note' : 'Invoice'}
            </span>
            <span className="text-ink-soft">{formatDate(invoice.issuedOn)}</span>
            <span className="tabular ml-auto font-medium text-ink">
              {formatMoney(invoice.totals.total, invoice.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A reservation's bill: its folios with their charges and payments, and the invoices issued
 * from them. Renders nothing for a user who may not see folios, or for a reservation that was
 * never billed (tentative, cancelled or no-show with no folio).
 */
export function FolioSection({
  reservation,
  frame,
  onChanged,
}: {
  reservation: Reservation;
  /** Puts the bill inside the host's own section, heading included. */
  frame: (bill: ReactNode) => ReactNode;
  /** Called after anything on the bill changed, so that balances shown elsewhere can follow. */
  onChanged?: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const propertyId = reservation.propertyId;
  const canRead = auth.can('folio.read', propertyId);
  const canWrite = auth.can('folio.write', propertyId);
  const canRefund = auth.can('payments.refund', propertyId);
  const { data, error, isLoading, mutate } = useReservationFolios(reservation.id, canRead);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [busyFolio, setBusyFolio] = useState<string | null>(null);

  // Check-in opens the folio and check-out posts the last nights to it, and both are announced
  // as a change to the reservation only. The night audit announces folios without naming one.
  useLive(/^(folio|reservation)\./, (events) => {
    const concerned = events.some(
      (event) =>
        event.kind === 'resync' ||
        !event.payload?.reservationId ||
        event.payload.reservationId === reservation.id,
    );
    if (concerned) void mutate();
  });

  if (!canRead) return null;
  if (!BILLED_STATUSES.includes(reservation.status) && !data?.folios.length) return null;

  const currency = reservation.currency;
  const roomNames =
    reservation.rooms.length > 1
      ? Object.fromEntries(
          reservation.rooms.flatMap((room) => (room.unitName ? [[room.id, room.unitName]] : [])),
        )
      : undefined;
  // Descriptions are put in the words staff read here, once, for the cards and every dialog below.
  const folios: Folio[] = (data?.folios ?? []).map((folio) => ({
    ...folio,
    lines: folio.lines.map((line) => ({
      ...line,
      description: lineDescription(line, roomNames),
    })),
  }));
  const invoices = data?.invoices ?? [];

  const changed = () => {
    void mutate();
    onChanged?.();
  };
  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    changed();
  };

  const setStatus = async (folio: Folio, action: 'close' | 'reopen') => {
    setBusyFolio(folio.id);
    try {
      await api(`/folios/${folio.id}/${action}`, { method: 'POST' });
      toast.success(action === 'close' ? `${folio.label} closed` : `${folio.label} reopened`);
      changed();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyFolio(null);
    }
  };

  const act = (action: FolioAction) => {
    const folioId = action.folio.id;
    if (action.kind === 'close' || action.kind === 'reopen')
      void setStatus(action.folio, action.kind);
    else if (action.kind === 'void' || action.kind === 'refund') {
      setDialog({ kind: action.kind, folioId, lineId: action.line.id });
    } else setDialog({ kind: action.kind, folioId });
  };

  const dialogFolio =
    dialog && 'folioId' in dialog ? folios.find((folio) => folio.id === dialog.folioId) : undefined;
  const dialogLine =
    dialog && 'lineId' in dialog
      ? dialogFolio?.lines.find((line) => line.id === dialog.lineId)
      : undefined;
  const balance = data ? balanceText(data.balance, currency) : null;

  return frame(
    // Positioned, so that visually hidden text inside it scrolls with the page it is on instead
    // of making the whole window scrollable.
    <div
      id={BILL_ELEMENT_ID}
      data-ready={data ? 'true' : undefined}
      className="relative flex scroll-mt-10 flex-col gap-3"
    >
      {error && !data ? (
        <Notice tone="danger" title="The bill could not be loaded">
          <p>{errorMessage(error)}</p>
          <Button size="sm" className="mt-2" onClick={() => void mutate()}>
            Try again
          </Button>
        </Notice>
      ) : !data || isLoading ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading the bill…
        </div>
      ) : folios.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-ink">No charges yet</p>
            <p className="text-[13px] text-ink-soft">
              Room nights are added by the night audit and at check-out.
            </p>
          </div>
          {canWrite && (
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setDialog({ kind: 'charge', folioId: null })}
            >
              Add charge
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {balance && (
              <p className={cn('text-base font-semibold', BALANCE_TEXT_TONES[balance.tone])}>
                {balance.text}
              </p>
            )}
            {canWrite && (
              <Button
                size="sm"
                icon={<Split className="size-3.5" />}
                onClick={() => setDialog({ kind: 'split' })}
              >
                Split bill
              </Button>
            )}
          </div>
          {folios.map((folio) => (
            <FolioCard
              key={folio.id}
              folio={folio}
              guestName={reservation.guestName}
              invoices={invoices}
              several={folios.length > 1}
              canWrite={canWrite}
              canRefund={canRefund}
              busy={busyFolio === folio.id}
              onAction={act}
            />
          ))}
          {invoices.length > 0 && <InvoiceList invoices={invoices} />}
        </>
      )}

      {(dialog?.kind === 'charge' || dialog?.kind === 'discount') &&
        (dialog.folioId === null || dialogFolio) && (
          <ChargeDialog
            mode={dialog.kind}
            reservationId={reservation.id}
            folio={dialogFolio}
            folios={folios}
            currency={currency}
            onClose={close}
            onDone={done}
          />
        )}
      {dialog?.kind === 'payment' && dialogFolio && (
        <PaymentDialog folio={dialogFolio} currency={currency} onClose={close} onDone={done} />
      )}
      {dialog?.kind === 'move' && dialogFolio && (
        <MoveDialog
          target={dialogFolio}
          folios={folios}
          currency={currency}
          onClose={close}
          onDone={done}
        />
      )}
      {dialog?.kind === 'company' && dialogFolio && (
        <BillCompanyDialog
          folio={dialogFolio}
          reservation={reservation}
          onClose={close}
          onDone={done}
        />
      )}
      {dialog?.kind === 'invoice' && dialogFolio && (
        <InvoiceDialog folio={dialogFolio} onClose={close} onIssued={changed} />
      )}
      {dialog?.kind === 'void' && dialogLine && (
        <VoidDialog line={dialogLine} currency={currency} onClose={close} onDone={done} />
      )}
      {dialog?.kind === 'refund' && dialogFolio && dialogLine && (
        <RefundDialog
          line={dialogLine}
          credit={Math.max(0, -dialogFolio.totals.balance)}
          currency={currency}
          onClose={close}
          onDone={done}
        />
      )}
      {dialog?.kind === 'split' && (
        <SplitDialog reservation={reservation} onClose={close} onDone={done} />
      )}
    </div>,
  );
}
