import type { ComponentProps } from 'react';
import type { Badge } from '@/components/ui/misc';
import { CHANNEL_NAMES, plural } from '@/lib/format';
import type { Connection, Kind, Revision, SyncLogRow } from './types';

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

const REVISION_STATUS: Record<Revision['status'], StatusLabel> = {
  received: { label: 'Waiting', tone: 'info' },
  applied: { label: 'Recorded', tone: 'success' },
  superseded: { label: 'Out of date, ignored', tone: 'neutral' },
  unmapped: { label: 'Room not mapped', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  set_aside: { label: 'Dealt with by hand', tone: 'neutral' },
};

/**
 * A mailbox maps nothing: it knows a room by the name in the email. And what it could not use
 * is as a rule an email that says too little or that nobody vouches for, not something that
 * broke.
 */
const REVISION_STATUS_BY_KIND: Partial<
  Record<Kind, Partial<Record<Revision['status'], StatusLabel>>>
> = {
  email: {
    unmapped: { label: 'Room not known', tone: 'danger' },
    failed: { label: 'Not recorded', tone: 'danger' },
  },
};

/** What became of a booking message. Without the kind of its connection, as the channel manager's. */
export function revisionStatus(revision: Revision, kind?: Kind): StatusLabel {
  return (
    (kind && REVISION_STATUS_BY_KIND[kind]?.[revision.status]) ?? REVISION_STATUS[revision.status]
  );
}

/** A booking message in one of these states is not in the PMS, so its dates are not held. */
export function isNotRecorded(revision: Revision): boolean {
  return revision.status === 'unmapped' || revision.status === 'failed';
}

type Arrival = Record<Revision['receivedVia'], { label: string; hint: string }>;

const RECEIVED_VIA: Arrival = {
  webhook: {
    label: 'Announced',
    hint: 'The channel manager announced it as soon as it was made',
  },
  poll: { label: 'Regular check', hint: 'Found by the regular check for waiting bookings' },
  import: { label: 'Import', hint: 'Brought in by an import of existing bookings' },
};

const READ_FROM_CALENDAR = {
  label: 'Calendar',
  hint: 'Found when the calendar of the site was read',
};

/** A calendar connection and a mailbox get their bookings in ways of their own. */
const RECEIVED_VIA_BY_KIND: Partial<Record<Kind, Partial<Arrival>>> = {
  ical: { webhook: READ_FROM_CALENDAR, poll: READ_FROM_CALENDAR },
  email: {
    webhook: { label: 'Forwarded', hint: 'Handed over by the mail service as the email arrived' },
    poll: { label: 'Mailbox', hint: 'Read from the mailbox' },
  },
};

/** How a booking message got here. Without the kind of its connection, as the channel manager's. */
export function receivedVia(revision: Revision, kind?: Kind): { label: string; hint: string } {
  return (
    (kind && RECEIVED_VIA_BY_KIND[kind]?.[revision.receivedVia]) ??
    RECEIVED_VIA[revision.receivedVia]
  );
}

/**
 * Dates that a site's calendar shows as closed are recorded as a block, not as a booking, and
 * so have no reservation. The server does not mark them, but only a calendar connection can
 * record an entry without a reservation. A cancellation without one is the end of such a block,
 * unless the server notes that there was nothing here to cancel.
 */
export function isBlockedDates(revision: Revision, kind?: Kind): boolean {
  return (
    kind === 'ical' &&
    revision.status === 'applied' &&
    !revision.reservationId &&
    (revision.kind !== 'cancelled' || !revision.error)
  );
}

const BLOCKED_DATES: Record<Revision['kind'], string> = {
  new: 'Blocked dates',
  modified: 'Change to blocked dates',
  cancelled: 'Blocked dates removed',
};

/** `New booking`, `Change`, `Cancellation`, or what a calendar's closed dates were recorded as. */
export function revisionKind(revision: Revision, kind?: Kind): string {
  return (isBlockedDates(revision, kind) ? BLOCKED_DATES : REVISION_KINDS)[revision.kind];
}

/** The booking site behind a channel code; codes without a known name are shown as they are. */
export function channelLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown site';
  return CHANNEL_NAMES[code.toUpperCase()] ?? code;
}

/**
 * `new booking from Airbnb for Priya Nair`: what a row is about, for the names of its actions,
 * which would otherwise read the same on every row.
 */
export function revisionSubject(revision: Revision, kind?: Kind): string {
  const what = revisionKind(revision, kind).toLowerCase();
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

/** A calendar connection and a mailbox look for bookings by reading, and say so. */
const READ_LABELS: Partial<Record<Kind, string>> = {
  ical: 'Read of the calendars',
  email: 'Read of the mailbox',
};

const isBooking = (row: SyncLogRow): boolean => row.operation.startsWith('booking.');

/** As `isBlockedDates`, for the entry the log keeps of the same event. */
function loggedBlockedDates(row: SyncLogRow, kind?: Kind): boolean {
  return (
    kind === 'ical' &&
    (row.operation === 'booking.new' || row.operation === 'booking.modified') &&
    row.detail?.outcome === 'applied' &&
    row.detail.reservationId === null
  );
}

/**
 * An entry that went from the calendar of a site without a booking here to cancel: the end of
 * blocked dates as a rule, though the log does not keep which. Not a booking either way.
 */
function loggedWithoutBooking(row: SyncLogRow, kind?: Kind): boolean {
  return (
    kind === 'ical' &&
    row.operation === 'booking.cancelled' &&
    row.detail?.outcome === 'applied' &&
    row.detail.reservationId === null
  );
}

/** The entries, by the id their calendar gives them, that a log shows were recorded as blocked dates. */
export function loggedBlocks(log: SyncLogRow[], kind?: Kind): ReadonlySet<string> {
  const blocks = new Set<string>();
  for (const row of log) {
    const id = row.detail?.bookingId;
    if (typeof id === 'string' && loggedBlockedDates(row, kind)) blocks.add(id);
  }
  return blocks;
}

/**
 * What a log entry was about. `blocks` are the entries known to be blocked dates, so that the
 * end of one is called that; without them it is a cancellation like any other.
 */
export function operationLabel(row: SyncLogRow, kind?: Kind, blocks?: ReadonlySet<string>): string {
  const id = row.detail?.bookingId;
  const unblocked = loggedWithoutBooking(row, kind) && typeof id === 'string' && blocks?.has(id);
  const label = loggedBlockedDates(row, kind)
    ? row.operation === 'booking.new'
      ? 'Blocked dates'
      : 'Change to blocked dates'
    : unblocked
      ? 'Blocked dates removed'
      : (row.operation === 'bookings.pull' && kind && READ_LABELS[kind]) ||
        (OPERATION_LABELS[row.operation] ?? row.operation);
  const channel = row.detail?.channel;
  return isBooking(row) && typeof channel === 'string'
    ? `${label} from ${channelLabel(channel)}`
    : label;
}

/** What the count of a log entry counts, which depends on what was done. */
export function operationCount(row: SyncLogRow, kind?: Kind): string {
  if (loggedBlockedDates(row, kind) || loggedWithoutBooking(row, kind)) return '';
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

/**
 * The newest read that failed with no read having worked since. A read that fails is kept in
 * the log; one that works leaves only its time on the connection.
 */
export function failingRead(connection: Connection, log: SyncLogRow[]): SyncLogRow | undefined {
  const failed = log.find((row) => row.operation === 'bookings.pull' && row.status !== 'ok');
  if (!failed) return undefined;
  const worked = connection.lastPullAt ? new Date(connection.lastPullAt).getTime() : 0;
  return new Date(failed.createdAt).getTime() > worked ? failed : undefined;
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

/** What the server says of a booking whose room it cannot place, with the room as the channel named it. */
const ROOM_NOT_PLACED = /^No room type is mapped to channel room (.+)$/;
/** What the server puts in the place of the room where the channel named none. */
const NO_ROOM_GIVEN = '(no room given)';

/**
 * Why a mailbox could not place a booking, in the words of a mailbox: the server speaks of
 * mapping, which a mailbox does not have, as it knows a room by the name in the email. `named`
 * says whether the email named a room at all. Null where the server says something else.
 */
export function unknownRoomInEmail(error: string | null): { text: string; named: boolean } | null {
  const room = ROOM_NOT_PLACED.exec(error ?? '')?.[1];
  if (!room) return null;
  return room === NO_ROOM_GIVEN
    ? {
        text: 'The email does not say which room was booked, so the booking could not be placed',
        named: false,
      }
    : { text: `The room in the email, "${room}", is not known here`, named: true };
}

/** `a, b and c` */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
