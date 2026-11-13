'use client';

import { History, KeyRound, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useRef, useState } from 'react';
import type { KeyedMutator } from 'swr';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/field';
import { Card, EmptyState, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import type { Property } from '@/lib/types';
import { DeliveriesDrawer } from './deliveries-drawer';
import { useNow, useReturnFocus } from './focus';
import { Code, HowTo } from './how-to';
import { SecretDialog } from './secret-dialog';
import type { CreatedWebhook, WebhookEndpoint, WebhooksAnswer } from './types';
import { WebhookDialog } from './webhook-dialog';
import { endpointHost, endpointName, endpointState, eventMeaning, formatWhen } from './words';

type Open =
  | { kind: 'new' }
  | { kind: 'edit' | 'replace' | 'delete' | 'switch-off'; endpoint: WebhookEndpoint }
  | { kind: 'secret'; host: string; secret: string; replaced: boolean }
  | { kind: 'deliveries'; endpointId: string };

const names = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });

/** Where a webhook applies, in words. */
function propertyWords(endpoint: WebhookEndpoint, properties: Property[]): string {
  if (!endpoint.propertyIds) return 'All properties';
  return names.format(
    endpoint.propertyIds.map(
      (id) => properties.find((property) => property.id === id)?.name ?? 'an unknown property',
    ),
  );
}

/** The whole address, where a confirmation has to leave no doubt which webhook is meant. */
function Address({ endpoint }: { endpoint: WebhookEndpoint }) {
  return (
    <p className="mb-2 rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[13px] break-all text-ink">
      {endpoint.url}
    </p>
  );
}

function EventList({ events }: { events: string[] }) {
  if (events.includes('*')) return <span>Every event</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {events.map((event) => (
        <li
          key={event}
          title={eventMeaning(event)}
          className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-soft"
        >
          {event}
        </li>
      ))}
    </ul>
  );
}

function EndpointCard({
  endpoint,
  properties,
  now,
  busy,
  onSwitch,
  onTest,
  onOpen,
}: {
  endpoint: WebhookEndpoint;
  properties: Property[];
  now: Date;
  /** What is being done to this webhook right now, if anything. */
  busy: 'switch' | 'test' | null;
  onSwitch: (on: boolean) => void;
  onTest: () => void;
  onOpen: (kind: 'edit' | 'replace' | 'delete' | 'deliveries') => void;
}) {
  const state = endpointState(endpoint);
  const name = endpointName(endpoint.url);
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-semibold break-all text-ink">{endpoint.url}</h2>
          {endpoint.description && (
            <p className="mt-0.5 text-sm break-words text-ink-soft">{endpoint.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <span
            aria-hidden
            className={cn(
              'text-[13px] font-medium',
              endpoint.active ? 'text-success-700' : 'text-ink-faint',
            )}
          >
            {endpoint.active ? 'On' : 'Off'}
          </span>
          <Switch
            checked={endpoint.active}
            disabled={busy === 'switch'}
            label={`Send to ${name}`}
            onChange={onSwitch}
          />
        </div>
      </div>

      {state === 'stopped' && (
        <Notice tone="warning" title="The system switched this webhook off" className="mt-3">
          <p className="break-words">{endpoint.disabledReason}</p>
          <p className="mt-1">
            Nothing is sent to it, and what was waiting has been dropped. Switch it on again once
            the receiver works.
          </p>
          <Button
            size="sm"
            className="mt-2"
            loading={busy === 'switch'}
            onClick={() => onSwitch(true)}
          >
            Switch on again
          </Button>
        </Notice>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-[13px] text-ink-faint">Events</dt>
          <dd className="mt-0.5 text-ink">
            <EventList events={endpoint.events} />
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-faint">Properties</dt>
          <dd className="break-words text-ink">{propertyWords(endpoint, properties)}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-faint">Deliveries</dt>
          <dd className="text-ink">
            {endpoint.lastSuccessAt ? (
              <span title={new Date(endpoint.lastSuccessAt).toLocaleString()}>
                Last delivered {formatWhen(endpoint.lastSuccessAt, now)}
              </span>
            ) : (
              'Nothing delivered yet'
            )}
            {endpoint.consecutiveFailures > 0 && endpoint.lastFailureAt && (
              <span
                className="block text-warning-700"
                title={new Date(endpoint.lastFailureAt).toLocaleString()}
              >
                {plural(endpoint.consecutiveFailures, 'failure')} in a row, the last{' '}
                {formatWhen(endpoint.lastFailureAt, now)}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-3 -mb-1 -ml-2 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          icon={<History className="size-3.5" />}
          aria-label={`Deliveries to ${name}`}
          onClick={() => onOpen('deliveries')}
        >
          Deliveries
        </Button>
        {endpoint.active && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Send className="size-3.5" />}
            aria-label={`Send a test to ${name}`}
            loading={busy === 'test'}
            onClick={onTest}
          >
            Send a test
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Pencil className="size-3.5" />}
          aria-label={`Edit the webhook to ${name}`}
          onClick={() => onOpen('edit')}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<KeyRound className="size-3.5" />}
          aria-label={`Replace secret of the webhook to ${name}`}
          onClick={() => onOpen('replace')}
        >
          Replace secret
        </Button>
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Trash2 className="size-3.5" />}
          aria-label={`Delete the webhook to ${name}`}
          onClick={() => onOpen('delete')}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

/** The addresses other systems are told at when something changes, and how the telling went. */
export function WebhooksTab({
  data,
  mutate,
  properties,
  adding,
  onAdd,
  onAddingDone,
}: {
  data: WebhooksAnswer;
  mutate: KeyedMutator<WebhooksAnswer>;
  properties: Property[];
  /** The page's "Add webhook" button was pressed. */
  adding: boolean;
  onAdd: () => void;
  onAddingDone: () => void;
}) {
  const toast = useToast();
  const now = useNow(30_000);
  const region = useRef<HTMLElement>(null);
  const [opened, setOpened] = useState<Open | null>(null);
  const [busy, setBusy] = useState<{ id: string; what: 'switch' | 'test' } | null>(null);
  const watched =
    opened?.kind === 'deliveries'
      ? data.endpoints.find((endpoint) => endpoint.id === opened.endpointId)
      : undefined;
  // A webhook deleted from elsewhere while its deliveries are open takes the drawer with it.
  const stale = opened?.kind === 'deliveries' && !watched;
  const open: Open | null = adding ? { kind: 'new' } : stale ? null : opened;
  useReturnFocus(open !== null, region);
  const close = () => {
    setOpened(null);
    onAddingDone();
  };

  /** Puts what the server answered into the list at once, without reading the whole list again. */
  const put = (saved: WebhookEndpoint) =>
    mutate(
      (current) =>
        current && {
          ...current,
          endpoints: current.endpoints.some((e) => e.id === saved.id)
            ? current.endpoints.map((e) => (e.id === saved.id ? saved : e))
            : [...current.endpoints, saved],
        },
      { revalidate: false },
    );

  const setActive = async (endpoint: WebhookEndpoint, active: boolean) => {
    await put(
      await api<WebhookEndpoint>(`/outbound-webhooks/${endpoint.id}`, {
        method: 'PATCH',
        body: { active },
      }),
    );
  };

  const switchOn = async (endpoint: WebhookEndpoint) => {
    await setActive(endpoint, true);
    toast.success(
      `The webhook to ${endpointHost(endpoint.url)} is on`,
      'What happens from now on is sent. What happened while it was off is not.',
    );
  };

  const switchOnFromCard = async (endpoint: WebhookEndpoint) => {
    setBusy({ id: endpoint.id, what: 'switch' });
    try {
      await switchOn(endpoint);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async (endpoint: WebhookEndpoint) => {
    setBusy({ id: endpoint.id, what: 'test' });
    try {
      await api(`/outbound-webhooks/${endpoint.id}/test`, { method: 'POST' });
      // The drawer shows the test going out and how the receiver answers.
      setOpened({ kind: 'deliveries', endpointId: endpoint.id });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const created = (answer: CreatedWebhook) => {
    onAddingDone();
    setOpened({
      kind: 'secret',
      host: endpointHost(answer.endpoint.url),
      secret: answer.secret,
      replaced: false,
    });
    void put(answer.endpoint);
  };

  const addButton = (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={onAdd}>
      Add webhook
    </Button>
  );

  return (
    <section ref={region} tabIndex={-1} aria-label="Webhooks" className="outline-none">
      {data.endpoints.length === 0 ? (
        <EmptyState
          icon={<Webhook className="size-5" />}
          title="No webhooks"
          description="A webhook tells another system the moment something changes here, such as a new reservation or a change of rates, so that it does not have to keep asking. Add the address that system gave you."
          action={addButton}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {data.endpoints.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              properties={properties}
              now={now}
              busy={busy?.id === endpoint.id ? busy.what : null}
              onSwitch={(on) =>
                on ? void switchOnFromCard(endpoint) : setOpened({ kind: 'switch-off', endpoint })
              }
              onTest={() => void sendTest(endpoint)}
              onOpen={(kind) =>
                setOpened(
                  kind === 'deliveries' ? { kind, endpointId: endpoint.id } : { kind, endpoint },
                )
              }
            />
          ))}
        </div>
      )}

      <HowTo title="How a webhook arrives">
        <p>
          Each delivery is a <Code>POST</Code> to your address with a small JSON body that says what
          changed and how to look it up. It arrives with these headers:
        </p>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt>
            <Code>X-PMS-Event</Code>
          </dt>
          <dd>The event, such as reservation.created.</dd>
          <dt>
            <Code>X-PMS-Delivery</Code>
          </dt>
          <dd>The delivery&rsquo;s own id, the same on every attempt.</dd>
          <dt>
            <Code>X-PMS-Timestamp</Code>
          </dt>
          <dd>When it was sent, in seconds.</dd>
          <dt>
            <Code>X-PMS-Signature</Code>
          </dt>
          <dd>The signature, made with the webhook&rsquo;s signing secret.</dd>
        </dl>
        <p>
          The receiver must check the signature of every delivery with the signing secret before it
          trusts it, and should answer with any <Code>2xx</Code> within ten seconds.
        </p>
      </HowTo>

      {(open?.kind === 'new' || open?.kind === 'edit') && (
        <WebhookDialog
          endpoint={open.kind === 'edit' ? open.endpoint : undefined}
          events={data.events}
          properties={properties}
          onClose={close}
          onCreated={created}
          onSaved={(saved) => void put(saved)}
        />
      )}
      {open?.kind === 'secret' && (
        <SecretDialog
          title={open.replaced ? 'The new signing secret' : 'The webhook is saved'}
          label="Signing secret"
          name="signing secret"
          value={open.secret}
          onClose={close}
        >
          {open.replaced
            ? `Deliveries to ${open.host} are signed with this secret from now on. Give it to the system that receives them: until it has the new secret, it will not recognise them.`
            : `Every delivery to ${open.host} is signed with this secret. Give it to the system that receives them, so that it can check each delivery really comes from here.`}
        </SecretDialog>
      )}
      {open?.kind === 'replace' && (
        <ConfirmDialog
          title="Replace the signing secret?"
          confirmLabel="Replace secret"
          onClose={close}
          onConfirm={async () => {
            const { secret } = await api<{ secret: string }>(
              `/outbound-webhooks/${open.endpoint.id}/rotate-secret`,
              { method: 'POST' },
            );
            setOpened({
              kind: 'secret',
              host: endpointHost(open.endpoint.url),
              secret,
              replaced: true,
            });
          }}
        >
          <Address endpoint={open.endpoint} />
          <p>
            The secret in use now stops working at once. Deliveries to this address are signed with
            a new one, which you are shown next.
          </p>
          <p className="mt-2">
            Until the receiving system has the new secret, it will not recognise the deliveries and
            will turn them away.
          </p>
        </ConfirmDialog>
      )}
      {open?.kind === 'switch-off' && (
        <ConfirmDialog
          title={`Switch off the webhook to ${endpointHost(open.endpoint.url)}?`}
          confirmLabel="Switch off"
          onClose={close}
          onConfirm={async () => {
            await setActive(open.endpoint, false);
            toast.success(
              `The webhook to ${endpointHost(open.endpoint.url)} is off`,
              'Nothing more is sent to it.',
            );
            close();
          }}
        >
          <Address endpoint={open.endpoint} />
          <p>
            Nothing is sent to this address while it is off. Deliveries that are waiting are
            dropped.
          </p>
          <p className="mt-2">
            What happens in the meantime is not sent later: when you switch it on again, the
            receiving system has to catch up through the API.
          </p>
        </ConfirmDialog>
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete the webhook to ${endpointHost(open.endpoint.url)}?`}
          confirmLabel="Delete webhook"
          onClose={close}
          onConfirm={async () => {
            await api(`/outbound-webhooks/${open.endpoint.id}`, { method: 'DELETE' });
            await mutate(
              (current) =>
                current && {
                  ...current,
                  endpoints: current.endpoints.filter((e) => e.id !== open.endpoint.id),
                },
              { revalidate: false },
            );
            toast.success(`The webhook to ${endpointHost(open.endpoint.url)} is deleted`);
            close();
          }}
        >
          <Address endpoint={open.endpoint} />
          <p>
            The system at this address is no longer told about anything. Deliveries that are waiting
            are not sent.
          </p>
          <p className="mt-2">
            The record of what was sent to it is deleted too, and so is its signing secret. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
      {open?.kind === 'deliveries' && watched && (
        <DeliveriesDrawer
          endpoint={watched}
          onClose={close}
          onEndpointChanged={() => void mutate()}
          onSwitchOn={() => switchOn(watched)}
        />
      )}
    </section>
  );
}
