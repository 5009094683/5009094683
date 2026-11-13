'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  PauseCircle,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { READ_EVERY_MS, calendarsOf, hasMailbox, kindOf } from './kinds';
import { CONNECTION_STATUS, driftResult, formatAgo, formatUntil, isLive, sentence } from './labels';
import { RelativeTime } from './parts';
import type { Connection, SyncLogRow } from './types';

/** Changes that have waited this long are slow; the server raises an alert at the same point. */
const SLOW_AFTER_MS = 10 * 60_000;
/** A read is late once this many of the usual gaps between reads have passed without one. */
const LATE_AFTER_READS = 3;

export function ConnectionStatusBadge({ connection }: { connection: Connection }) {
  const status = CONNECTION_STATUS[connection.status];
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

interface SyncState {
  icon: LucideIcon;
  iconClass: string;
  text: string;
}

const NOT_SET_UP = { icon: Wrench, iconClass: 'text-ink-faint' };

/** Whether a calendar connection or a mailbox has anything to read, going by its summary. */
function reads(connection: Connection): boolean {
  if (connection.adapter === 'ical') return calendarsOf(connection).read;
  return connection.adapter !== 'email' || hasMailbox(connection);
}

/** How reading is going for a calendar connection or a mailbox, neither of which sends anything. */
function readState(
  connection: Connection,
  now: Date,
  failing: boolean,
  failingCalendars: string[],
): SyncState {
  const calendars = connection.adapter === 'ical';
  if (calendars && calendarsOf(connection).count === 0) {
    return { ...NOT_SET_UP, text: 'No calendar is set up yet' };
  }
  if (!reads(connection)) {
    return {
      ...NOT_SET_UP,
      text: calendars
        ? 'Nothing is read from the sites: no calendar here has the address of the calendar of a site'
        : 'No mailbox to read is entered',
    };
  }
  if (failing) {
    return {
      icon: AlertTriangle,
      iconClass: 'text-danger-500',
      text: calendars ? 'The calendars cannot be read' : 'The mailbox cannot be read',
    };
  }
  // Some are read and some are not: the read as a whole counts as having worked.
  const [failed] = failingCalendars;
  if (calendars && failed) {
    return {
      icon: AlertTriangle,
      iconClass: 'text-warning-500',
      text:
        failingCalendars.length === 1
          ? `${failed.charAt(0).toUpperCase()}${failed.slice(1)} cannot be read. The calendar itself, below, says what went wrong.`
          : `${failingCalendars.length} calendars cannot be read. Each of them, below, says what went wrong.`,
    };
  }
  // Where the calendars themselves are not at hand, the summary still says how many fail.
  const unread = connection.calendars?.failing ?? 0;
  if (calendars && unread > 0) {
    return {
      icon: AlertTriangle,
      iconClass: 'text-warning-500',
      text:
        unread === 1
          ? 'One calendar cannot be read. Open the connection to see which, and why.'
          : `${unread} calendars cannot be read. Open the connection to see which, and why.`,
    };
  }
  const last = connection.lastPullAt;
  if (!last) {
    return {
      icon: Clock,
      iconClass: 'text-info-500',
      text: calendars
        ? 'The calendars have not been read yet'
        : 'The mailbox has not been read yet',
    };
  }
  const every = READ_EVERY_MS[connection.adapter];
  if (every && now.getTime() - new Date(last).getTime() > LATE_AFTER_READS * every) {
    return {
      icon: Clock,
      iconClass: 'text-warning-500',
      text: calendars
        ? `The calendars were last read ${formatAgo(last, now)}. They are normally read every 5 minutes.`
        : `The mailbox was last read ${formatAgo(last, now)}. It is normally read every minute.`,
    };
  }
  return {
    icon: CheckCircle2,
    iconClass: 'text-success-500',
    text: calendars ? 'The calendars are being read' : 'Booking emails are being read',
  };
}

function syncState(
  connection: Connection,
  now: Date,
  failing: boolean,
  failingCalendars: string[],
): SyncState {
  const kind = kindOf(connection);
  switch (connection.status) {
    case 'pending':
      return {
        ...NOT_SET_UP,
        text: 'Set-up is not finished. Nothing is sent to the booking sites yet.',
      };
    case 'paused':
      return { icon: PauseCircle, iconClass: 'text-warning-500', text: kind.whenPaused };
    case 'disabled':
      return { icon: PauseCircle, iconClass: 'text-ink-faint', text: kind.whenOff };
  }
  if (READ_EVERY_MS[connection.adapter]) {
    return readState(connection, now, failing, failingCalendars);
  }
  if (!connection.capabilities.ari) {
    return {
      icon: CheckCircle2,
      iconClass: 'text-success-500',
      text: 'Bookings are being fetched',
    };
  }
  if (connection.fullSyncRequestedAt) {
    return {
      icon: RefreshCw,
      iconClass: 'text-info-500',
      text: connection.lastError
        ? 'All availability and rates are waiting to be sent'
        : 'Sending all availability and rates',
    };
  }
  if (connection.pendingChanges === 0) {
    return connection.status === 'error'
      ? { icon: Clock, iconClass: 'text-ink-faint', text: 'Nothing is waiting to be sent' }
      : { icon: CheckCircle2, iconClass: 'text-success-500', text: 'Everything is up to date' };
  }
  const oldest = connection.oldestPendingAt;
  const slow = oldest !== null && now.getTime() - new Date(oldest).getTime() > SLOW_AFTER_MS;
  return {
    icon: Clock,
    iconClass: slow || connection.status === 'error' ? 'text-warning-500' : 'text-info-500',
    text:
      `${plural(connection.pendingChanges, 'change')} waiting` +
      (oldest ? `, oldest from ${formatAgo(oldest, now)}` : ''),
  };
}

function LastError({ connection, now }: { connection: Connection; now: Date }) {
  if (!isLive(connection) || !connection.lastError) return null;
  const failing = connection.status === 'error';
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-[13px]',
        failing
          ? 'border-danger-100 bg-danger-50 text-danger-700'
          : 'border-warning-100 bg-warning-50 text-warning-700',
      )}
    >
      <p className="font-medium">
        The last update failed
        {connection.lastErrorAt ? ` ${formatAgo(connection.lastErrorAt, now)}` : ''}
      </p>
      <p className="mt-0.5 break-words">{connection.lastError}</p>
      <p className="mt-0.5">
        {connection.consecutiveFailures > 1
          ? `${connection.consecutiveFailures} attempts in a row have failed. `
          : ''}
        It is tried again automatically: next try{' '}
        {connection.nextAttemptAt ? formatUntil(connection.nextAttemptAt, now) : 'any moment now'}.
      </p>
    </div>
  );
}

/** Why a calendar connection or a mailbox could not be read, in the words the server recorded. */
function ReadFailure({
  connection,
  failure,
  now,
}: {
  connection: Connection;
  failure: SyncLogRow;
  now: Date;
}) {
  return (
    <div className="rounded-md border border-danger-100 bg-danger-50 px-3 py-2 text-[13px] text-danger-700">
      <p className="font-medium">The last read failed {formatAgo(failure.createdAt, now)}</p>
      {failure.error && <p className="mt-0.5 break-words">{sentence(failure.error)}</p>}
      <p className="mt-0.5">
        {connection.adapter === 'ical'
          ? 'Until a read works, bookings made on the sites do not arrive here. It is tried again by itself.'
          : 'Until a read works, bookings in the emails do not arrive here. It is tried again by itself. If it keeps failing, check the mail server, the port, the user name, the password and the folder entered for the mailbox.'}
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-[13px] text-ink">{children}</dd>
    </div>
  );
}

function When({ value, now }: { value: string | null; now: Date }) {
  return value ? (
    <RelativeTime value={value} now={now} />
  ) : (
    <span className="text-ink-faint">Not yet</span>
  );
}

/** When things last happened, for a connection past its set-up. */
function Facts({
  connection,
  now,
  failing,
}: {
  connection: Connection;
  now: Date;
  failing: boolean;
}) {
  const { ari, bookings } = connection.capabilities;
  if (connection.adapter === 'ical' || connection.adapter === 'email') {
    if (!reads(connection)) return null;
    return (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {connection.adapter === 'ical' && (
          <Fact label="Calendars">{calendarsOf(connection).count}</Fact>
        )}
        {/* The time kept is that of the last read that went through. */}
        <Fact label={failing ? 'Last read that worked' : 'Last read'}>
          <When value={connection.lastPullAt} now={now} />
        </Fact>
      </dl>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      {ari && (
        <Fact label="Last sent">
          <When value={connection.lastPushAt} now={now} />
        </Fact>
      )}
      {bookings !== 'none' && (
        <Fact label="Bookings last fetched">
          <When value={connection.lastPullAt} now={now} />
        </Fact>
      )}
      {ari && (
        <Fact label="Last full send">
          <When value={connection.lastFullSyncAt} now={now} />
        </Fact>
      )}
      {ari && (
        <Fact label="Last comparison">
          <When value={connection.lastDriftCheckAt} now={now} />
          {connection.lastDriftCheckAt && connection.lastDriftCount !== null && (
            <span className="block text-xs text-ink-soft">
              {driftResult(connection.lastDriftCount)}
            </span>
          )}
        </Fact>
      )}
    </dl>
  );
}

/**
 * How a connection is doing: one line on what is waiting to go out or on how reading is going,
 * the last failure if any, and when things last happened.
 */
export function ConnectionOverview({
  connection,
  now,
  failingRead,
  failingCalendars = [],
}: {
  connection: Connection;
  now: Date;
  /** The read that is failing now, where the log of the connection is at hand to tell. */
  failingRead?: SyncLogRow;
  /**
   * The calendars whose last read did not work, each named as in a sentence, where the
   * calendars of the connection are at hand to tell.
   */
  failingCalendars?: string[];
}) {
  const failing =
    (failingRead !== undefined || connection.readFailing) &&
    isLive(connection) &&
    reads(connection);
  const state = syncState(connection, now, failing, failingCalendars);
  const Icon = state.icon;

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 text-sm text-ink">
        <Icon className={cn('mt-0.5 size-4 shrink-0', state.iconClass)} aria-hidden />
        <span>{state.text}</span>
      </p>
      <LastError connection={connection} now={now} />
      {failing && failingRead && (
        <ReadFailure connection={connection} failure={failingRead} now={now} />
      )}
      {connection.status === 'pending' ? (
        connection.capabilities.ari && (
          <p className="text-[13px] text-ink-soft">
            {connection.mappedRoomTypes === 0
              ? 'No rooms are mapped yet.'
              : `${plural(connection.mappedRoomTypes, 'room type')} and ${plural(connection.mappedRatePlans, 'rate plan')} mapped so far.`}
          </p>
        )
      ) : (
        <Facts connection={connection} now={now} failing={failing} />
      )}
    </div>
  );
}
