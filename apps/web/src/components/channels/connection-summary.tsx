'use client';

import { CheckCircle2, Clock, PauseCircle, RefreshCw, Wrench, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { CONNECTION_STATUS, driftResult, formatAgo, formatUntil, isLive } from './labels';
import { RelativeTime } from './parts';
import type { Connection } from './types';

/** Changes that have waited this long are slow; the server raises an alert at the same point. */
const SLOW_AFTER_MS = 10 * 60_000;

export function ConnectionStatusBadge({ connection }: { connection: Connection }) {
  const status = CONNECTION_STATUS[connection.status];
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

interface SyncState {
  icon: LucideIcon;
  iconClass: string;
  text: string;
}

function syncState(connection: Connection, now: Date): SyncState {
  switch (connection.status) {
    case 'pending':
      return {
        icon: Wrench,
        iconClass: 'text-ink-faint',
        text: 'Set-up is not finished. Nothing is sent to the booking sites yet.',
      };
    case 'paused':
      return {
        icon: PauseCircle,
        iconClass: 'text-warning-500',
        text: 'Paused. Nothing is sent or fetched until it is resumed.',
      };
    case 'disabled':
      return {
        icon: PauseCircle,
        iconClass: 'text-ink-faint',
        text: 'Switched off. Nothing is sent or fetched.',
      };
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

/**
 * How a connection is doing: one line on what is waiting to go out, the last failure if any, and
 * when things last happened.
 */
export function ConnectionOverview({ connection, now }: { connection: Connection; now: Date }) {
  const state = syncState(connection, now);
  const Icon = state.icon;
  const { ari, bookings } = connection.capabilities;

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 text-sm text-ink">
        <Icon className={cn('mt-0.5 size-4 shrink-0', state.iconClass)} aria-hidden />
        <span>{state.text}</span>
      </p>
      <LastError connection={connection} now={now} />
      {connection.status === 'pending' ? (
        ari && (
          <p className="text-[13px] text-ink-soft">
            {connection.mappedRoomTypes === 0
              ? 'No rooms are mapped yet.'
              : `${plural(connection.mappedRoomTypes, 'room type')} and ${plural(connection.mappedRatePlans, 'rate plan')} mapped so far.`}
          </p>
        )
      ) : (
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
      )}
    </div>
  );
}
