'use client';

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { useReservationFolios } from '@/components/folio/data';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney, plural } from '@/lib/format';
import type { Reservation } from '@/lib/types';
import { CheckOutReview } from './check-out-review';
import { SettleForm, type PaymentToTake, type SettleChoice } from './check-out-settle';
import { listInWords, roomInText } from './labels';
import type { CheckOutOutcome } from './types';

type Step =
  | { name: 'review' }
  /** The server refused: this much is owed (or, below zero, in credit) once the last room leaves. */
  | { name: 'settle'; due: number }
  | { name: 'done'; outcome: CheckOutOutcome };

type BalanceMode = 'require_settled' | 'bill_company' | 'leave_open';

const REVIEW_FORM = 'check-out-form';
const SETTLE_FORM = 'check-out-settle-form';

/** The balance from a check-out refused because the bill is not settled, else null. */
function balanceDue(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.details?.reason !== 'balance_due') return null;
  return typeof err.details.balance === 'number' ? err.details.balance : null;
}

function nightsBackOnSale(nights: number): string {
  return `${plural(nights, 'night')} went back on sale.`;
}

/**
 * Checks out one or more rooms. The bill is settled as part of it: the server says what is owed
 * once the nights not yet charged are counted, and the user then takes payment, bills the
 * company or leaves the bill open.
 */
export function CheckOutDialog({
  reservationId,
  roomId,
  hotelDay,
  onClose,
  onCheckedOut,
  onOpenBill,
}: {
  reservationId: string;
  /** The room the dialog was opened for. Without it, every room that is checked in is ticked. */
  roomId?: string;
  /** The property's current hotel day. */
  hotelDay: string;
  onClose: () => void;
  /** Called once the rooms are checked out. The dialog stays open to show the result. */
  onCheckedOut: (reservation: Reservation) => void;
  /** Shows the reservation's bill, for a refund or an invoice. The dialog is closed first. */
  onOpenBill?: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const {
    data: reservation,
    error: loadError,
    mutate,
  } = useSWR<Reservation>(`/reservations/${reservationId}`);
  const propertyId = reservation?.propertyId;
  const canSeeBill = propertyId ? auth.can('folio.read', propertyId) : false;
  const canPay = propertyId ? auth.can('folio.write', propertyId) : false;
  const { data: bill, mutate: mutateBill } = useReservationFolios(reservationId, canSeeBill);

  const [step, setStep] = useState<Step>({ name: 'review' });
  const [ticked, setTicked] = useState<string[] | null>(null);
  // Fixed at the first attempt: once checked out, the rooms are no longer "in house" to derive from.
  const [leaving, setLeaving] = useState<string[]>([]);
  const [choice, setChoice] = useState<SettleChoice | null>(null);
  const [round, setRound] = useState(0);
  const [received, setReceived] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inHouse = (reservation?.rooms ?? []).filter((room) => room.status === 'in_house');
  const inHouseIds = inHouse.map((room) => room.id);
  const opened = roomId && inHouseIds.includes(roomId) ? [roomId] : inHouseIds;
  const selected = inHouse.filter((room) => (ticked ?? opened).includes(room.id));
  const currency = reservation?.currency ?? 'INR';
  const guestName = reservation?.guestName ?? '';

  const checkOut = async (roomIds: string[], mode: BalanceMode) => {
    const outcome = await api<CheckOutOutcome>(`/reservations/${reservationId}/check-out`, {
      body: { roomIds, ...(mode === 'require_settled' ? {} : { balance: mode }) },
    });
    void mutate(outcome.reservation, { revalidate: false });
    void mutateBill();
    const rooms = outcome.reservation.rooms.filter((room) => roomIds.includes(room.id));
    toast.success(
      `Checked out ${rooms.length === 1 ? (rooms[0]!.guestName ?? guestName) : guestName}`,
      outcome.nightsReleased > 0
        ? nightsBackOnSale(outcome.nightsReleased)
        : outcome.reservation.status !== 'checked_out'
          ? 'Other rooms of this booking are still checked in.'
          : outcome.balance > 0
            ? `${formatMoney(outcome.balance, currency)} is still owed.`
            : undefined,
    );
    setStep({ name: 'done', outcome });
    onCheckedOut(outcome.reservation);
  };

  /** Shows the ways to settle, with the bill as it stands now. */
  const askToSettle = async (due: number) => {
    if (canSeeBill) await mutateBill();
    setChoice(null);
    setRound((n) => n + 1);
    setStep({ name: 'settle', due });
  };

  const attempt = async (roomIds: string[], mode: BalanceMode) => {
    setBusy(true);
    setError(null);
    try {
      await checkOut(roomIds, mode);
    } catch (err) {
      const due = balanceDue(err);
      if (due !== null) await askToSettle(due);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const payAndCheckOut = async (payments: PaymentToTake[]) => {
    if (step.name !== 'settle') return;
    setBusy(true);
    setError(null);
    let taken = 0;
    try {
      for (const payment of payments) {
        if (payment.folio.status === 'closed') {
          await api(`/folios/${payment.folio.id}/reopen`, { method: 'POST' });
        }
        await api(`/folios/${payment.folio.id}/payments`, {
          body: {
            method: payment.method,
            amount: payment.amount,
            reference: payment.reference || null,
          },
        });
        taken += payment.amount;
      }
      await checkOut(leaving, 'require_settled');
    } catch (err) {
      const stillDue = balanceDue(err);
      if (stillDue === null) setError(errorMessage(err));
      // Nothing was recorded: what was typed stays, to be corrected and sent again.
      if (stillDue === null && taken === 0) return;
      // Whatever was recorded stays recorded. Start again from what is owed now, so that the
      // same payment is not offered a second time.
      const due = stillDue ?? step.due - taken;
      if (due === 0) {
        if (canSeeBill) await mutateBill();
        setStep({ name: 'review' });
      } else await askToSettle(due);
    } finally {
      setReceived((sum) => sum + taken);
      setBusy(false);
    }
  };

  const startCheckOut = (event: FormEvent) => {
    event.preventDefault();
    if (selected.length === 0) return;
    const roomIds = selected.map((room) => room.id);
    setLeaving(roomIds);
    void attempt(roomIds, 'require_settled');
  };

  const openBill = () => {
    onClose();
    onOpenBill?.();
  };

  const settleChoice =
    choice ??
    (step.name === 'settle' && step.due > 0 && canPay && bill && bill.folios.length > 0
      ? 'pay'
      : null);

  let title = 'Check out';
  let footer = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button
        type="submit"
        form={REVIEW_FORM}
        variant="primary"
        loading={busy}
        disabled={selected.length === 0}
      >
        {selected.length > 1 ? `Check out ${selected.length} rooms` : 'Check out'}
      </Button>
    </>
  );
  if (step.name === 'settle' && step.due > 0) {
    title = 'Settle the bill';
    footer = (
      <>
        <Button onClick={() => setStep({ name: 'review' })} disabled={busy}>
          Back
        </Button>
        <Button
          type="submit"
          form={SETTLE_FORM}
          variant="primary"
          loading={busy}
          disabled={settleChoice === null}
        >
          {settleChoice === 'pay'
            ? 'Take payment and check out'
            : settleChoice === 'bill_company'
              ? 'Bill company and check out'
              : settleChoice === 'leave_open'
                ? 'Check out, leave bill open'
                : 'Check out'}
        </Button>
      </>
    );
  } else if (step.name === 'settle') {
    title = 'The guest is in credit';
    footer = (
      <>
        {onOpenBill && canSeeBill ? (
          <Button onClick={openBill} disabled={busy}>
            Open bill
          </Button>
        ) : (
          <Button onClick={() => setStep({ name: 'review' })} disabled={busy}>
            Back
          </Button>
        )}
        <Button
          variant="primary"
          loading={busy}
          onClick={() => void attempt(leaving, 'leave_open')}
        >
          Check out, leave bill open
        </Button>
      </>
    );
  } else if (step.name === 'done') {
    title = 'Checked out';
    footer = (
      <>
        <Button onClick={onClose}>Close</Button>
        {onOpenBill && canSeeBill && (
          <Button variant="primary" onClick={openBill}>
            Open bill
          </Button>
        )}
      </>
    );
  }

  const done = step.name === 'done' ? step.outcome : null;
  const left = done ? done.reservation.rooms.filter((room) => leaving.includes(room.id)) : [];
  const leftUnits = left.flatMap((room) => (room.unitName ? [roomInText(room.unitName)] : []));

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={title}
      description={reservation ? `${guestName} · ${reservation.code}` : undefined}
      footer={reservation ? footer : undefined}
    >
      {loadError && !reservation ? (
        <ErrorState error={loadError} onRetry={() => void mutate()} />
      ) : !reservation ? (
        <PageLoading />
      ) : done ? (
        <div className="flex flex-col gap-3">
          <Notice
            tone="success"
            title={
              leftUnits.length > 0
                ? `${guestName} has checked out of ${listInWords(leftUnits)}`
                : `${guestName} has checked out`
            }
          >
            <ul className="flex flex-col gap-0.5">
              {done.nightsReleased > 0 && <li>{nightsBackOnSale(done.nightsReleased)}</li>}
              <li>
                {done.reservation.status !== 'checked_out'
                  ? 'Other rooms of this booking are not checked out yet. The bill is settled when the last one leaves.'
                  : done.balance > 0
                    ? `${formatMoney(done.balance, currency)} is still owed. The folio stays open so that it can be collected.`
                    : done.balance < 0
                      ? `The guest is ${formatMoney(-done.balance, currency)} in credit. Refund it from the folio.`
                      : 'The bill is settled.'}
              </li>
              <li>
                {left.length > 1 ? 'The rooms are' : 'The room is'} marked as not cleaned for
                housekeeping.
              </li>
            </ul>
          </Notice>
          {onOpenBill && canSeeBill && done.reservation.status === 'checked_out' && (
            <p className="text-[13px] text-ink-soft">
              Open the bill to issue the invoice
              {done.balance > 0
                ? ' or take the payment later'
                : done.balance < 0
                  ? ' or refund the credit'
                  : ''}
              .
            </p>
          )}
        </div>
      ) : step.name === 'settle' && step.due > 0 ? (
        <div className="flex flex-col gap-3">
          {error && <Notice tone="danger">{error}</Notice>}
          <div>
            <p className="text-lg font-semibold text-danger-700">
              {formatMoney(step.due, currency)} is still owed
            </p>
            <p className="text-[13px] text-ink-soft">
              {received > 0
                ? `${formatMoney(received, currency)} was recorded. `
                : 'This is the whole bill, with the nights that are charged at check-out. '}
              Nobody has been checked out yet.
            </p>
          </div>
          <SettleForm
            key={round}
            formId={SETTLE_FORM}
            due={step.due}
            reservation={reservation}
            folios={bill?.folios ?? []}
            canPay={canPay}
            choice={settleChoice}
            onChoice={setChoice}
            onPay={(payments) => void payAndCheckOut(payments)}
            onCheckOut={(mode) => void attempt(leaving, mode)}
          />
        </div>
      ) : step.name === 'settle' ? (
        <div className="flex flex-col gap-3">
          {error && <Notice tone="danger">{error}</Notice>}
          <p className="text-lg font-semibold text-info-700">
            {formatMoney(-step.due, currency)} in credit
          </p>
          <p className="text-sm text-ink">
            More was paid than the stay comes to, so the guest is owed{' '}
            {formatMoney(-step.due, currency)}. Nobody has been checked out yet.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-soft">
            <li>
              To give the money back now, open the bill, choose Refund on the payment, then check
              out again.
            </li>
            <li>
              Or check out and leave the bill open. The amount stays in credit on the folio until it
              is refunded.
            </li>
          </ul>
        </div>
      ) : (
        <form id={REVIEW_FORM} onSubmit={startCheckOut} className="flex flex-col gap-4">
          {error && <Notice tone="danger">{error}</Notice>}
          {received > 0 && (
            <Notice tone="success">
              {formatMoney(received, currency)} was recorded on the bill.
            </Notice>
          )}
          {inHouse.length === 0 ? (
            <Notice tone="info">No room of this reservation is checked in.</Notice>
          ) : (
            <CheckOutReview
              reservation={reservation}
              inHouse={inHouse}
              selected={selected}
              onToggle={(id, on) => {
                const current = ticked ?? opened;
                setTicked(on ? [...current, id] : current.filter((other) => other !== id));
              }}
              hotelDay={hotelDay}
              bill={bill}
            />
          )}
        </form>
      )}
    </Dialog>
  );
}
