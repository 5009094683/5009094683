'use client';

import useSWR from 'swr';
import { Card, ErrorState, PageLoading } from '@/components/ui/misc';
import { usePropertyDetail } from '@/lib/hooks';
import { MailboxLimits } from './kind-limits';
import { calendarsOf } from './kinds';
import { MailboxForm } from './mailbox-form';
import { MailboxForwarding } from './mailbox-forwarding';
import { SectionHeading, StaleNotice } from './parts';
import { RoomNamesEditor, RoomNamesSummary } from './room-names-editor';
import type { Connection, Mappings, MailboxSettings } from './types';

/** Whether a property has a connection that closes its rooms on the sites, which a mailbox never does. */
function useClosesRooms(propertyId: string): boolean | undefined {
  // The same list the Channels page is made from.
  const { data } = useSWR<{ connections: Connection[] }>('/channels/connections');
  return data?.connections.some(
    (other) =>
      other.propertyId === propertyId &&
      (other.adapter === 'channex' || (other.adapter === 'ical' && calendarsOf(other).count > 0)),
  );
}

/**
 * The set-up of a reservations mailbox: what it can and cannot do, how the mailbox is read, and
 * what the sites call each room type in their emails. How the mailbox is read is shown only to
 * people who can change it.
 */
export function MailboxConnection({
  connection,
  mappings,
  canManage,
  onSaved,
}: {
  connection: Connection;
  mappings: Mappings;
  canManage: boolean;
  /** Fetches the connection again, whose summary says whether there is a mailbox to read. */
  onSaved: () => Promise<unknown>;
}) {
  const settings = useSWR<MailboxSettings>(
    canManage ? `/channels/connections/${connection.id}/email/mailbox` : null,
  );
  const property = usePropertyDetail(connection.propertyId);
  const closesRooms = useClosesRooms(connection.propertyId);

  return (
    <>
      <section aria-labelledby="mailbox-heading" className="mt-8">
        <SectionHeading
          id="mailbox-heading"
          title="Mailbox"
          description="Where the booking emails of this property are read from."
        />
        <div className="flex flex-col gap-4">
          <MailboxLimits closesRooms={closesRooms} />
          {!canManage ? (
            <p className="text-sm text-ink-soft">
              How the mailbox is read is shown only to people who can manage channels.
            </p>
          ) : !settings.data ? (
            <Card>
              {settings.error ? (
                <ErrorState error={settings.error} onRetry={() => void settings.mutate()} />
              ) : (
                <PageLoading />
              )}
            </Card>
          ) : (
            <Card className="flex flex-col gap-4 px-4 py-4 sm:px-5">
              {settings.error && (
                <StaleNotice
                  title="The mailbox settings could not be refreshed"
                  error={settings.error}
                  onRetry={() => void settings.mutate()}
                />
              )}
              <MailboxForm
                connection={connection}
                settings={settings.data}
                onSaved={() => Promise.all([settings.mutate(), onSaved()])}
              />
              {settings.data.forwardingUrl && (
                <MailboxForwarding address={settings.data.forwardingUrl} />
              )}
            </Card>
          )}
        </div>
      </section>

      <section aria-labelledby="room-names-heading" className="mt-8">
        <SectionHeading
          id="room-names-heading"
          title="Room names"
          description={
            <>
              A booking email names the room in the words of the site. A booking is placed by itself
              when exactly one room type here has that name, or a name that contains it or is part
              of it, or when the property has only one room type.{' '}
              {canManage
                ? 'Where a site uses another name, enter it here; a room type can have one.'
                : 'Where a site uses another name, that name is kept here. You can look at the names, not change them.'}{' '}
              A booking whose room is not known is held under Bookings received until the name is
              entered and the booking is applied again.
            </>
          }
        />
        {!property.data ? (
          <Card>
            {property.error ? (
              <ErrorState error={property.error} onRetry={() => void property.mutate()} />
            ) : (
              <PageLoading />
            )}
          </Card>
        ) : canManage ? (
          <RoomNamesEditor
            connection={connection}
            roomTypes={property.data.roomTypes}
            mappings={mappings}
            onSaved={onSaved}
          />
        ) : (
          <RoomNamesSummary roomTypes={property.data.roomTypes} mappings={mappings} />
        )}
      </section>
    </>
  );
}
