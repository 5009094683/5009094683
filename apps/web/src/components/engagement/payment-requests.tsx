'use client';

import { Copy, Plus, RefreshCw, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { LinkDialog } from '@/components/settings/link-dialog';
import { Button } from '@/components/ui/button';
import { Badge, Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useLive } from '@/lib/live';
import type { Reservation } from '@/lib/types';
import { AskDialog } from './ask-dialog';
import { copyText } from './clipboard';
import { usePaymentOrders } from './data';
import { PaymentLinkDialog } from './payment-link-dialog';
import type { PaymentOrder } from './types';

type State = 'waiting' | 'paid' | 'expired' | 'cancelled' | 'failed';

const STATE_LABELS: Record<State, string> = {
  waiting: 'Waiting for payment',
  paid: 'Paid',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

const STATE_TONES: Record<State, 'warning' | 'success' | 'neutral' | 'danger'> = {
  waiting: 'warning',
  paid: 'success',
  expired: 'neutral',
  cancelled: 'neutral',
  failed: 'danger',
};

/** A request past its time can no longer be paid, even before the server has closed it. */
function stateOf(order: PaymentOrder, now: number): State {
  if (order.status !== 'created') return order.status;
  return new Date(order.expiresAt).getTime() <= now ? 'expired' : 'waiting';
}

function whenText(order: PaymentOrder, state: State): string {
  const asked = `Asked ${formatDateTime(order.createdAt)}`;
  if (state === 'paid' && order.paidAt) return `${asked} · paid ${formatDateTime(order.paidAt)}`;
  if (state === 'waiting') return `${asked} · can be paid until ${formatDateTime(order.expiresAt)}`;
  if (state === 'expired') return `${asked} · ran out ${formatDateTime(order.expiresAt)}`;
  return asked;
}

type Open =
  { kind: 'new' } | { kind: 'cancel'; order: PaymentOrder } | { kind: 'link'; link: string };

/**
 * The online payments asked of the guest of a reservation: the payment made when booking on
 * the website, and links staff have sent since. Renders nothing for a user who may not see
 * bills, or when there is nothing to show and nothing they could do.
 */
export function PaymentRequestsSection({
  reservation,
  frame,
  onChanged,
}: {
  reservation: Reservation;
  /** Puts the list inside the host's own section, with the action beside its heading. */
  frame: (content: ReactNode, action?: ReactNode) => ReactNode;
  /** Called when a payment was found to have arrived, so that balances shown elsewhere can follow. */
  onChanged?: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const canRead = auth.can('folio.read', reservation.propertyId);
  const canWrite = auth.can('folio.write', reservation.propertyId);
  const { data, error, mutate } = usePaymentOrders(reservation.id, canRead);
  const [open, setOpen] = useState<Open | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // A payment arriving is announced as a change to the bill.
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
  const orders = data?.orders ?? [];
  const canAsk = canWrite && !['cancelled', 'no_show'].includes(reservation.status);
  if (data && orders.length === 0 && !canAsk) return null;

  const copy = async (order: PaymentOrder) => {
    if (!order.payUrl) return;
    if (await copyText(order.payUrl)) toast.success('Payment link copied');
    else setOpen({ kind: 'link', link: order.payUrl });
  };

  const check = async (order: PaymentOrder) => {
    setBusyId(order.id);
    try {
      const checked = await api<PaymentOrder>(`/payment-orders/${order.id}/sync`, {
        method: 'POST',
      });
      await mutate();
      const amount = formatMoney(checked.amount, checked.currency);
      if (checked.status === 'paid') {
        toast.success(`${amount} has been paid`, 'The payment is on the bill.');
        onChanged?.();
      } else if (checked.status === 'created') {
        toast.info(`${amount} has not been paid yet`);
      } else {
        toast.info(`This request for ${amount} was not paid`, 'It can no longer be paid.');
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (order: PaymentOrder) => {
    const cancelled = await api<PaymentOrder>(`/payment-orders/${order.id}/cancel`, {
      method: 'POST',
    });
    await mutate();
    setOpen(null);
    const amount = formatMoney(cancelled.amount, cancelled.currency);
    if (cancelled.status === 'paid') {
      // The server asks the payment provider first, and records a payment rather than cancel it.
      toast.info(`${amount} was paid a moment ago`, 'The request was not cancelled.');
      onChanged?.();
    } else {
      toast.success(`Request for ${amount} cancelled`, 'The link no longer works.');
    }
  };

  const now = Date.now();

  return frame(
    <div className="flex flex-col gap-2">
      {error && !data ? (
        <Notice tone="danger" title="The payment requests could not be loaded">
          <p>{errorMessage(error)}</p>
          <Button size="sm" className="mt-2" onClick={() => void mutate()}>
            Try again
          </Button>
        </Notice>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading the payment requests…
        </div>
      ) : orders.length === 0 ? (
        <p className="text-sm text-ink-soft">
          Nothing has been asked for online. A payment link lets the guest pay a deposit or what is
          still owed from their phone.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {orders.map((order) => {
            const state = stateOf(order, now);
            const amount = formatMoney(order.amount, order.currency);
            return (
              <li key={order.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="tabular text-sm font-semibold text-ink">{amount}</p>
                  <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>
                </div>
                <p className="mt-0.5 text-sm break-words text-ink">
                  {order.purpose === 'booking'
                    ? 'Payment for the booking made on the website'
                    : order.description}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-soft">{whenText(order, state)}</p>
                {state === 'failed' && order.failureReason && (
                  <p className="mt-0.5 text-[13px] break-words text-danger-600">
                    {order.failureReason}
                  </p>
                )}
                {order.status === 'created' && (state === 'waiting' || canWrite) && (
                  <div className="mt-2 -ml-2 flex flex-wrap gap-1">
                    {state === 'waiting' && order.payUrl && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Copy className="size-3.5" />}
                        aria-label={`Copy the link to pay ${amount}`}
                        onClick={() => void copy(order)}
                      >
                        Copy link
                      </Button>
                    )}
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<RefreshCw className="size-3.5" />}
                        aria-label={`Check now whether ${amount} has been paid`}
                        loading={busyId === order.id}
                        onClick={() => void check(order)}
                      >
                        Check now
                      </Button>
                    )}
                    {canWrite && state === 'waiting' && order.purpose === 'payment_link' && (
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        icon={<X className="size-3.5" />}
                        aria-label={`Cancel the request for ${amount}`}
                        onClick={() => setOpen({ kind: 'cancel', order })}
                      >
                        Cancel request
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {open?.kind === 'new' && (
        <PaymentLinkDialog
          reservation={reservation}
          onClose={() => setOpen(null)}
          onCreated={() => void mutate()}
        />
      )}
      {open?.kind === 'cancel' && (
        <AskDialog
          title={`Cancel the request for ${formatMoney(open.order.amount, open.order.currency)}?`}
          confirmLabel="Cancel request"
          dismissLabel="Keep it"
          onClose={() => setOpen(null)}
          onConfirm={() => cancel(open.order)}
        >
          <p>
            The link sent to {reservation.guestName} stops working straight away and cannot be
            brought back. To ask again, create a new link.
          </p>
          <p>If the guest has paid in the meantime, the payment is recorded instead.</p>
        </AskDialog>
      )}
      {open?.kind === 'link' && (
        <LinkDialog
          title="Payment link"
          label="Payment link"
          link={open.link}
          onClose={() => setOpen(null)}
        >
          <p className="text-sm text-ink-soft">
            The browser did not allow copying. Select the link and copy it yourself.
          </p>
        </LinkDialog>
      )}
    </div>,
    canAsk && data ? (
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus className="size-3.5" />}
        onClick={() => setOpen({ kind: 'new' })}
      >
        Ask for a payment
      </Button>
    ) : undefined,
  );
}
