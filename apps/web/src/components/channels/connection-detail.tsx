'use client';

import { ArrowLeft, Lock, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { Card, EmptyState, ErrorState, PageLoading } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ActivityTable } from './activity-table';
import { CalendarConnection } from './calendar-connection';
import { calendarName, failingCalendars } from './calendar-status';
import { ConnectionJobs, StatusSwitch, useConnectionActions } from './connection-actions';
import { ConnectionOverview, ConnectionStatusBadge } from './connection-summary';
import { HealthBanners } from './health-banners';
import { kindOf, ownName } from './kinds';
import { failingRead } from './labels';
import { MailboxConnection } from './mailbox-connection';
import { useMonitor, useNow } from './monitor';
import { ButtonLink, SectionHeading, StaleNotice } from './parts';
import { ReceivedBookings } from './received-bookings';
import { SetupSteps } from './setup-steps';
import { roomNamesOf, useChannelManagerStructure } from './structure';
import type { CalendarFeed, ConnectionDetail } from './types';
import { UnsavedChangesGuard } from './unsaved';

function Detail({
  detail,
  refresh,
  now,
}: {
  detail: ConnectionDetail;
  refresh: () => Promise<unknown>;
  now: Date;
}) {
  const auth = useAuth();
  const { connection, mappings, log } = detail;
  const canManage = auth.can('channels.manage', connection.propertyId);
  const actions = useConnectionActions(connection, refresh);
  const structure = useChannelManagerStructure(connection, canManage);
  const roomNames = useMemo(() => roomNamesOf(structure.data), [structure.data]);
  const kind = kindOf(connection);
  const KindIcon = kind.icon;
  const name = ownName(connection);
  // The same calendars the section below shows: a read counts as having worked when any
  // calendar was read, so only they tell that one of them was not.
  const calendars = useMonitor<{ feeds: CalendarFeed[] }>(
    connection.adapter === 'ical' ? `/channels/connections/${connection.id}/ical/feeds` : null,
  );
  const unread = failingCalendars(calendars.data?.feeds ?? [], canManage).map(calendarName);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {connection.propertyName}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              <KindIcon className="size-4 text-ink-faint" aria-hidden />
              {kind.label}
            </span>
            {name && <span className="text-ink-faint">{name}</span>}
            <ConnectionStatusBadge connection={connection} />
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusSwitch connection={connection} actions={actions} placement="card" />
            <ConnectionJobs connection={connection} actions={actions} placement="page" />
          </div>
        )}
      </div>

      <HealthBanners kind={connection.adapter} />

      <Card className="px-4 py-4 sm:px-5">
        <ConnectionOverview
          connection={connection}
          now={now}
          failingRead={failingRead(connection, log)}
          failingCalendars={unread}
        />
      </Card>

      {connection.adapter === 'channex' && (
        <section aria-labelledby="setup-heading" className="mt-8">
          <SectionHeading
            id="setup-heading"
            title="Set-up"
            description={
              canManage
                ? 'What it takes to get this property onto the booking sites. Each step can be done or changed on its own.'
                : 'What it takes to get this property onto the booking sites, and how far it has got. You can look at the set-up, not change it.'
            }
          />
          <SetupSteps
            connection={connection}
            mappings={mappings}
            actions={actions}
            canManage={canManage}
          />
        </section>
      )}
      {connection.adapter === 'ical' && (
        <CalendarConnection
          connection={connection}
          canManage={canManage}
          now={now}
          onSaved={refresh}
        />
      )}
      {connection.adapter === 'email' && (
        <MailboxConnection
          connection={connection}
          mappings={mappings}
          canManage={canManage}
          onSaved={refresh}
        />
      )}

      {connection.capabilities.bookings !== 'none' && (
        <section aria-labelledby="bookings-heading" className="mt-8">
          <SectionHeading
            id="bookings-heading"
            title="Bookings received"
            description={kind.bookings.description}
          />
          <ReceivedBookings
            connectionId={connection.id}
            connections={[connection]}
            now={now}
            emptyTitle={kind.bookings.emptyTitle}
            emptyHint={kind.bookings.emptyHint}
          />
        </section>
      )}

      <section aria-labelledby="activity-heading" className="mt-8">
        <SectionHeading
          id="activity-heading"
          title="Activity"
          description={kind.activity.description}
        />
        <ActivityTable log={log} kind={connection.adapter} roomNames={roomNames} now={now} />
      </section>
    </>
  );
}

/** One connection: how it is doing, its set-up, and what it has sent and received. */
export function ConnectionDetailView({ connectionId }: { connectionId: string }) {
  const auth = useAuth();
  const allowed = auth.can('channels.read');
  const { data, error, mutate } = useMonitor<ConnectionDetail>(
    allowed ? `/channels/connections/${connectionId}` : null,
  );
  const now = useNow();
  const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);
  const refused = !allowed || (error instanceof ApiError && error.status === 403);

  return (
    <UnsavedChangesGuard>
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <Link
          href="/channels"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden /> Channels
        </Link>
        {refused ? (
          <EmptyState
            icon={<Lock className="size-5" />}
            title="You do not have access to this connection"
            description="Ask an administrator if you need to see how this property is connected to the booking sites."
          />
        ) : missing ? (
          <EmptyState
            icon={<Unplug className="size-5" />}
            title="This connection does not exist"
            description="It may have been removed, or the address may be wrong."
            action={<ButtonLink href="/channels">Back to channels</ButtonLink>}
          />
        ) : !data ? (
          error ? (
            <ErrorState error={error} onRetry={() => void mutate()} />
          ) : (
            <PageLoading />
          )
        ) : (
          <>
            {error && <StaleNotice error={error} onRetry={() => void mutate()} />}
            <Detail detail={data} refresh={mutate} now={now} />
          </>
        )}
      </div>
    </UnsavedChangesGuard>
  );
}
