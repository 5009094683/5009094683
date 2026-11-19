'use client';

import { RotateCw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Badge, ErrorState, Notice, PageLoading, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { LiveEvent } from '@/lib/types';
import { useNow } from './focus';
import type { WebhookDelivery, WebhookEndpoint } from './types';
import {
  DELIVERY_STATE_LABELS,
  deliveryAnswer,
  deliveryInFlight,
  deliveryState,
  endpointState,
  eventFamily,
  formatDue,
  formatMoment,
  type DeliveryState,
} from './words';

/** How often the list is read again while a delivery is about to be sent. */
const POLL_SOON_MS = 3_000;
/** The same while the only deliveries waiting are due later: a failed one waits up to twelve hours. */
const POLL_LATER_MS = 30_000;
/**
 * A delivery due within this long counts as about to be sent. One that is being sent right now
 * is marked by the server as due two minutes on, so the window has to reach past that.
 */
const SOON_MS = 130_000;

const STATE_TONES: Record<DeliveryState, 'info' | 'warning' | 'success' | 'danger'> = {
  waiting: 'info',
  retrying: 'warning',
  delivered: 'success',
  failed: 'danger',
};

/**
 * Whether a change in the back office is one this webhook asked to be told about, so that the
 * list is read again for those only. Errs on the side of reading: the server decides what is
 * really sent.
 */
const asksFor = (endpoint: WebhookEndpoint, event: LiveEvent): boolean =>
  event.kind === 'resync' ||
  ((endpoint.propertyIds === null ||
    event.propertyId === null ||
    endpoint.propertyIds.includes(event.propertyId)) &&
    endpoint.events.some(
      (asked) => asked === '*' || asked === event.kind || asked === `${eventFamily(event.kind)}.*`,
    ));

/** What tells one reading of the list from the next, as far as the webhook's own figures go. */
const fingerprint = (deliveries: WebhookDelivery[]): string =>
  deliveries.map((d) => `${d.id}:${d.status}:${d.attempts}`).join(' ');

function DeliveryItem({
  delivery,
  endpointOn,
  now,
  busy,
  onSendAgain,
}: {
  delivery: WebhookDelivery;
  endpointOn: boolean;
  now: Date;
  busy: boolean;
  onSendAgain: () => void;
}) {
  const state = deliveryState(delivery);
  const due = delivery.nextAttemptAt;
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-mono text-[13px] font-medium break-all text-ink">
          {delivery.eventKind}
          {delivery.eventKind === 'ping' && (
            <span className="font-sans font-normal text-ink-faint"> (a test)</span>
          )}
        </p>
        <Badge tone={STATE_TONES[state]}>{DELIVERY_STATE_LABELS[state]}</Badge>
      </div>
      <p className="tabular mt-1 text-[13px] text-ink-soft">
        <time dateTime={delivery.createdAt}>{formatMoment(delivery.createdAt)}</time>
        {' · '}
        {delivery.attempts === 0 ? 'no attempt yet' : plural(delivery.attempts, 'attempt')}
      </p>
      <p
        className={cn(
          'text-[13px] break-words',
          state === 'retrying' || state === 'failed' ? 'text-danger-600' : 'text-ink-soft',
        )}
      >
        {deliveryAnswer(delivery)}
      </p>
      {delivery.status === 'pending' && !deliveryInFlight(delivery) && (
        <p className="tabular text-[13px] text-ink-soft">
          {!endpointOn
            ? 'Waits until the webhook is switched on.'
            : due && new Date(due).getTime() > now.getTime()
              ? `Next attempt at ${formatDue(due, now)}`
              : 'Next attempt within a few seconds'}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 font-mono text-xs break-all text-ink-faint">
          <span className="sr-only">Delivery </span>
          {delivery.eventId}
        </p>
        {endpointOn && (state === 'failed' || state === 'retrying') && (
          <Button
            size="sm"
            icon={<RotateCw className="size-3.5" />}
            loading={busy}
            aria-label={`Send ${delivery.eventKind} from ${formatMoment(delivery.createdAt)} again`}
            onClick={onSendAgain}
          >
            Send again
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * What was sent to one webhook lately and how the receiver answered, with a way to try the
 * address and to send a failed delivery again. Reads the list again by itself for as long as a
 * delivery is waiting to go out, and not otherwise.
 */
export function DeliveriesDrawer({
  endpoint,
  onClose,
  onEndpointChanged,
  onSwitchOn,
}: {
  endpoint: WebhookEndpoint;
  onClose: () => void;
  /** A delivery got through or failed, so the webhook's own figures are out of date. */
  onEndpointChanged: () => void;
  onSwitchOn: () => Promise<void>;
}) {
  const toast = useToast();
  const now = useNow(5_000);
  const [pollMs, setPollMs] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);
  const seen = useRef<string | null>(null);
  const { data, error, mutate } = useSWR<{ deliveries: WebhookDelivery[] }>(
    `/outbound-webhooks/${endpoint.id}/deliveries`,
    {
      refreshInterval: pollMs,
      onSuccess: (answer) => {
        const next = fingerprint(answer.deliveries);
        if (seen.current !== null && seen.current !== next) onEndpointChanged();
        seen.current = next;
      },
    },
  );

  // Nothing is sent for a webhook that is off, so there is nothing to wait for.
  const waiting = endpoint.active
    ? (data?.deliveries.filter((d) => d.status === 'pending') ?? [])
    : [];
  const soon = waiting.some(
    (d) => !d.nextAttemptAt || new Date(d.nextAttemptAt).getTime() - now.getTime() < SOON_MS,
  );
  const wantedMs = waiting.length === 0 ? 0 : soon ? POLL_SOON_MS : POLL_LATER_MS;
  if (wantedMs !== pollMs) setPollMs(wantedMs);

  // Switching a webhook off drops what was waiting, whether the system does it after too many
  // failures or a colleague does. The reading stops with it, so the list is read one last time.
  const wasActive = useRef(endpoint.active);
  useEffect(() => {
    if (wasActive.current === endpoint.active) return;
    wasActive.current = endpoint.active;
    void mutate();
  }, [endpoint.active, mutate]);

  // Something changing in the back office is what queues a delivery; it is on the list a moment
  // later. Nothing is queued for a webhook that is off.
  useLive(
    /^(reservation|block|rates|message|folio|alert)\./,
    (events) => {
      if (endpoint.active && events.some((event) => asksFor(endpoint, event))) void mutate();
    },
    1500,
  );

  const test = useAction(async () => {
    await api(`/outbound-webhooks/${endpoint.id}/test`, { method: 'POST' });
    await mutate();
  });
  const switchOn = useAction(onSwitchOn);

  const sendAgain = async (delivery: WebhookDelivery) => {
    setBusyId(delivery.id);
    try {
      await api(`/outbound-webhooks/deliveries/${delivery.id}/retry`, { method: 'POST' });
    } catch (err) {
      toast.error(err);
    } finally {
      // Read again either way: a refusal usually means the delivery has moved on meanwhile.
      await mutate().catch(() => undefined);
      setBusyId(null);
    }
  };

  const state = endpointState(endpoint);

  return (
    <Drawer
      open
      onClose={onClose}
      title="Deliveries"
      description={<span className="font-mono break-all">{endpoint.url}</span>}
    >
      <div className="flex flex-col gap-3">
        {state !== 'on' && (
          <Notice
            tone={state === 'stopped' ? 'warning' : 'info'}
            title={state === 'stopped' ? 'This webhook was switched off' : 'This webhook is off'}
          >
            <p>
              {endpoint.disabledReason ??
                'Nothing is sent to it. Switch it on to send a test or to send a delivery again.'}
            </p>
            {switchOn.error && <p className="mt-1 font-medium">{switchOn.error}</p>}
            <Button
              size="sm"
              className="mt-2"
              loading={switchOn.busy}
              onClick={() => void switchOn.run()}
            >
              {state === 'stopped' ? 'Switch on again' : 'Switch on'}
            </Button>
          </Notice>
        )}

        {endpoint.active && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <Button
              icon={<Send className="size-4" />}
              loading={test.busy}
              onClick={() => void test.run()}
            >
              Send a test
            </Button>
            {pollMs > 0 && (
              <p className="flex items-center gap-1.5 text-[13px] text-ink-faint">
                <Spinner label="Checking for news" />
                Updates by itself while a delivery is waiting
              </p>
            )}
          </div>
        )}
        {test.error && <Notice tone="danger">{test.error}</Notice>}

        {error && !data ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : !data ? (
          <PageLoading label="Loading the deliveries" />
        ) : data.deliveries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-ink-soft">
            Nothing has been sent to this address yet.
            {endpoint.active && ' Send a test to try it.'}
          </p>
        ) : (
          <ul aria-label="Latest deliveries" className="flex flex-col gap-2">
            {data.deliveries.map((delivery) => (
              <DeliveryItem
                key={delivery.id}
                delivery={delivery}
                endpointOn={endpoint.active}
                now={now}
                busy={busyId === delivery.id}
                onSendAgain={() => void sendAgain(delivery)}
              />
            ))}
          </ul>
        )}

        <p className="text-[13px] text-ink-faint">
          The latest 50 deliveries are shown. One that fails is sent again by itself after 30
          seconds, then after longer and longer pauses: eight attempts over about a day.
        </p>
      </div>
    </Drawer>
  );
}
