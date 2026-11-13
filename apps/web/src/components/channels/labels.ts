import type { ComponentProps } from 'react';
import type { Badge } from '@/components/ui/misc';
import { CHANNEL_NAMES, plural } from '@/lib/format';
import type { Connection, Revision, SyncLogRow } from './types';

type Tone = NonNullable<ComponentProps<typeof Badge>['tone']>;

interface StatusLabel {
  label: string;
  tone: Tone;
}

export const CONNECTION_STATUS: Record<Connection['status'], StatusLabel> = {
  pending: { label: 'Setting up', tone: 'info' },
  active: { label: 'Live', tone: 'success' },
  error: { label: 'Live, last update failed', tone: 'danger' },
  paused: { label: 'Paused', tone: 'warning' },
  disabled: { label: 'Off', tone: 'neutral' },
};

/** Syncing, whether or not the last attempt worked. */
export function isLive(connection: Connection): boolean {
  return connection.status === 'active' || connection.status === 'error';
}

export const REVISION_KINDS: Record<Revision['kind'], string> = {
  new: 'New booking',
  modified: 'Change',
  cancelled: 'Cancellation',
};

export const REVISION_STATUS: Record<Revision['status'], StatusLabel> = {
  received: { label: 'Waiting', tone: 'info' },
  applied: { label: 'Recorded', tone: 'success' },
  superseded: { label: 'Out of date, ignored', tone: 'neutral' },
  unmapped: { label: 'Room not mapped', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** A booking message in one of these states is not in the PMS, so its dates are not held. */
export function isNotRecorded(revision: Revision): boolean {
  return revision.status === 'unmapped' || revision.status === 'failed';
}

export const RECEIVED_VIA: Record<Revision['receivedVia'], { label: string; hint: string }> = {
  webhook: {
    label: 'Announced',
    hint: 'The channel manager announced it as soon as it was made',
  },
  poll: { label: 'Regular check', hint: 'Found by the regular check for waiting bookings' },
  import: { label: 'Import', hint: 'Brought in by an import of existing bookings' },
};

/** The booking site behind a channel code; codes without a known name are shown as they are. */
export function channelLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown site';
  return CHANNEL_NAMES[code.toUpperCase()] ?? code;
}

/**
 * `new booking from Airbnb for Priya Nair`: what a row is about, for the names of its actions,
 * which would otherwise read the same on every row.
 */
export function revisionSubject(revision: Revision): string {
  const what = REVISION_KINDS[revision.kind].toLowerCase();
  const guest = revision.guestName ? ` for ${revision.guestName}` : '';
  return `${what} from ${channelLabel(revision.channelCode)}${guest}`;
}

export const LOG_STATUS: Record<SyncLogRow['status'], StatusLabel> = {
  ok: { label: 'OK', tone: 'success' },
  retry: { label: 'Will retry', tone: 'warning' },
  error: { label: 'Failed', tone: 'danger' },
};

export const LOG_DIRECTIONS: Record<SyncLogRow['direction'], string> = {
  out: 'Sent',
  in: 'Received',
};

const OPERATION_LABELS: Record<string, string> = {
  'ari.push': 'Changes to availability and rates',
  'ari.full_sync': 'All availability and rates',
  'booking.new': 'New booking',
  'booking.modified': 'Change to a booking',
  'booking.cancelled': 'Cancellation',
  'bookings.pull': 'Check for waiting bookings',
  'bookings.import': 'Import of existing bookings',
  'drift.check': 'Comparison with the channels',
};

const isBooking = (row: SyncLogRow): boolean => row.operation.startsWith('booking.');

export function operationLabel(row: SyncLogRow): string {
  const label = OPERATION_LABELS[row.operation] ?? row.operation;
  const channel = row.detail?.channel;
  return isBooking(row) && typeof channel === 'string'
    ? `${label} from ${channelLabel(channel)}`
    : label;
}

/** What the count of a log entry counts, which depends on what was done. */
export function operationCount(row: SyncLogRow): string {
  switch (row.operation) {
    case 'ari.push':
    case 'ari.full_sync':
      return plural(row.itemCount, 'update');
    case 'drift.check':
      if (row.status !== 'ok') return '';
      return driftResult(row.itemCount);
    case 'bookings.import':
      return plural(row.itemCount, 'booking');
    case 'bookings.pull':
      return '';
    default:
      if (isBooking(row)) return plural(row.itemCount, 'booking');
      return row.itemCount > 0 ? String(row.itemCount) : '';
  }
}

/** The outcome of comparing what the channels hold with the PMS. */
export function driftResult(differences: number): string {
  return differences === 0 ? 'no differences' : `${plural(differences, 'difference')} corrected`;
}

function spelledDuration(seconds: number): string {
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.round(hours / 24), 'day');
}

/** `2 minutes ago`, spelled out for use inside a sentence. */
export function formatAgo(value: string, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(value).getTime()) / 1000);
  return seconds < 5 ? 'just now' : `${spelledDuration(seconds)} ago`;
}

/** `in 3 minutes`, or `any moment now` once the time has come. */
export function formatUntil(value: string, now: Date): string {
  const seconds = Math.round((new Date(value).getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return 'any moment now';
  if (seconds < 60) return 'in under a minute';
  return `in ${spelledDuration(seconds)}`;
}

const exactTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** `13 Nov 2026, 17:05:09` in the viewer's own time zone: the full time behind a relative one. */
export function formatExact(value: string): string {
  return exactTime.format(new Date(value));
}

/** How long something waited, from milliseconds: `0.4 s`, `12 s`, `3 min`, `2 h`. */
export function formatWaited(ms: number): string {
  if (ms < 100) return 'under 0.1 s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

/** Messages from the server come without a full stop. Where more text follows, one is added. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The server can name a room of the channel manager only by its id. Where the room's title is
 * known, the title is put in its place.
 */
export function nameRooms(
  text: string,
  roomNames: ReadonlyMap<string, string> | undefined,
): string {
  let named = text;
  for (const [id, title] of roomNames ?? []) named = named.split(id).join(title);
  return named;
}

/** `a, b and c` */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
