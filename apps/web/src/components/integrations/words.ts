import { formatRelative } from '@/lib/format';
import type { ApiKey, KeyRole, WebhookDelivery, WebhookEndpoint, WebhookEvent } from './types';

/**
 * What a key with each role can do, in the words of docs/integrations.md.
 * Roles a key cannot be given have no entry.
 */
export const KEY_ROLE_HELP: Partial<Record<KeyRole, string>> = {
  read_only: 'Reads reservations, rates, guests, bills, messages and reports. Changes nothing.',
  front_desk:
    'Reads, and also makes and changes reservations and blocks, checks guests in and out, posts charges and payments, updates housekeeping and answers guests.',
  revenue_manager:
    'Reads, and also changes rates and restrictions, makes and changes reservations and blocks, manages connections to booking sites and approves rate suggestions.',
  accountant:
    'Reads, and also posts charges, payments and refunds, issues invoices, manages tax rules, companies and owners, and runs the night audit.',
  housekeeping: 'Works with the housekeeping board and its tasks.',
  maintenance: 'Works with maintenance issues.',
  general_manager: 'Does everything the other roles can, at the properties it is given.',
};

/**
 * MIRROR of `WEBHOOK_EVENTS` in packages/domain/src/webhooks.ts, with the meaning of each event
 * from docs/integrations.md.
 *
 * The list is not exported from `@pms/domain/shared`, and the domain holds the names only, so
 * the meanings live here. The type makes the build fail when the domain gains or loses an event,
 * which is the moment to bring this up to date. The names offered on screen come from the
 * server (`GET /outbound-webhooks`); this adds the words.
 */
const WEBHOOK_EVENT_MEANINGS: Record<WebhookEvent, string> = {
  'reservation.created': 'A reservation is made, by anyone: staff, the website, a booking site.',
  'reservation.updated': 'Its dates, rooms, guest or status change, or a guest checks in or out.',
  'reservation.cancelled': 'A reservation is cancelled.',
  'block.created': 'Dates are closed.',
  'block.updated': 'Closed dates are changed.',
  'block.released': 'Closed dates are reopened.',
  'rates.updated': 'Rates or restrictions change for a rate plan and a range of dates.',
  'message.received': 'A guest writes. Not sent when staff read or reply.',
  'folio.updated': 'A charge, payment or refund is posted to a bill.',
  'alert.raised': 'The system raises an alert, such as an overbooking or a failed sync.',
};

const FAMILY_LABELS: Record<string, string> = {
  reservation: 'Reservations',
  block: 'Blocked dates',
  rates: 'Rates',
  message: 'Guest messages',
  folio: 'Bills',
  alert: 'Alerts',
};

/** `reservation` from `reservation.created`. */
export const eventFamily = (event: string): string => event.split('.')[0] ?? event;

const familyLabel = (family: string): string => FAMILY_LABELS[family] ?? family;

export function eventMeaning(event: string): string | undefined {
  return (WEBHOOK_EVENT_MEANINGS as Record<string, string | undefined>)[event];
}

export interface EventFamily {
  family: string;
  label: string;
  events: string[];
}

/** The events grouped by family, in the order the server lists them. */
export function eventFamilies(events: readonly string[]): EventFamily[] {
  const families: EventFamily[] = [];
  for (const event of events) {
    const family = eventFamily(event);
    const group = families.find((f) => f.family === family);
    if (group) group.events.push(event);
    else families.push({ family, label: familyLabel(family), events: [event] });
  }
  return families;
}

export type KeyState = 'active' | 'expired' | 'revoked';

/** Whether a key still works. A revoked key stays revoked whatever its expiry date says. */
export function keyState(key: ApiKey, now: Date): KeyState {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export const KEY_STATE_LABELS: Record<KeyState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

/** `hooks.example.com` from the address of a webhook: short enough to name it by. */
export function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * `hooks.example.com/pms`: the address without what never tells two webhooks apart. Two
 * webhooks often share a host, so this is what the buttons of one are named by.
 */
export function endpointName(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return pathname === '/' ? host : `${host}${pathname}`;
  } catch {
    return url;
  }
}

export type EndpointState = 'on' | 'off' | 'stopped';

/** `stopped` is an endpoint the system switched off itself, after deliveries kept failing. */
export function endpointState(endpoint: WebhookEndpoint): EndpointState {
  if (endpoint.active) return 'on';
  return endpoint.disabledReason ? 'stopped' : 'off';
}

export type DeliveryState = 'waiting' | 'retrying' | 'delivered' | 'failed';

/**
 * `waiting` has not been answered yet; `retrying` failed at least once and will be sent again by
 * itself; `failed` has been given up.
 */
export function deliveryState(delivery: WebhookDelivery): DeliveryState {
  if (delivery.status === 'delivered') return 'delivered';
  if (delivery.status === 'failed') return 'failed';
  return delivery.lastError ? 'retrying' : 'waiting';
}

/**
 * Whether a delivery is on its way to the receiver right now. The server counts the attempt
 * when it starts sending and records the answer when it has one, so in between there is an
 * attempt with nothing against it.
 */
export const deliveryInFlight = (delivery: WebhookDelivery): boolean =>
  delivery.status === 'pending' && delivery.attempts > 0 && !delivery.lastError;

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  waiting: 'Waiting',
  retrying: 'Failed, trying again',
  delivered: 'Delivered',
  failed: 'Failed',
};

/**
 * What the receiver answered, or what went wrong, the last time the delivery was sent.
 *
 * A delivery put back in the queue by hand keeps the status code of its earlier attempt on the
 * server, so the code is only shown for a delivery that has got through.
 */
export function deliveryAnswer(delivery: WebhookDelivery): string {
  if (delivery.status === 'delivered') {
    return delivery.lastStatusCode
      ? `The receiver answered ${delivery.lastStatusCode}`
      : 'Accepted';
  }
  if (delivery.lastError) return delivery.lastError;
  return delivery.attempts === 0 ? 'Not sent yet' : 'Sent, waiting for the answer';
}

const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dayMonthTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** A timestamp as a date in the viewer's own time zone: `13 Nov 2026`. */
export const formatDayOf = (value: string): string => dayMonthYear.format(new Date(value));

/** A timestamp to the second, which is what telling deliveries apart needs: `13 Nov, 17:05:32`. */
export const formatMoment = (value: string): string => dayMonthTime.format(new Date(value));

/** When something is due: the time alone when that is today, the day as well otherwise. */
export function formatDue(value: string, now: Date): string {
  const due = new Date(value);
  return due.toDateString() === now.toDateString()
    ? timeOnly.format(due)
    : dayMonthTime.format(due);
}

/** `3 min ago` for the recent past, the date for anything older than two days. */
export function formatWhen(value: string, now: Date): string {
  const then = new Date(value);
  const age = now.getTime() - then.getTime();
  return age < 48 * 3_600_000 ? formatRelative(then, now) : dayMonthYear.format(then);
}

/** Today in the viewer's own time zone, as the `YYYY-MM-DD` a date input works with. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The last moment of a day picked in a date input, in the viewer's own time zone. */
export function endOfLocalDay(date: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59);
}
