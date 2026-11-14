'use client';

import { Card, ErrorState, PageLoading } from '@/components/ui/misc';
import { usePropertyDetail } from '@/lib/hooks';
import { CalendarsEditor } from './calendars-editor';
import { CalendarsSummary } from './calendars-summary';
import { CalendarLimits } from './kind-limits';
import { isLive } from './labels';
import { useMonitor } from './monitor';
import { SectionHeading, StaleNotice } from './parts';
import type { CalendarFeed, Connection } from './types';

/**
 * The set-up of a calendar connection: what calendars can and cannot do, and the calendars of
 * each unit. People who may not change the connection see them without the addresses.
 */
export function CalendarConnection({
  connection,
  canManage,
  now,
  onSaved,
}: {
  connection: Connection;
  canManage: boolean;
  now: Date;
  /** Fetches the connection again, whose summary counts the calendars. */
  onSaved: () => Promise<unknown>;
}) {
  const { data, error, mutate } = useMonitor<{ feeds: CalendarFeed[] }>(
    `/channels/connections/${connection.id}/ical/feeds`,
  );
  // Only the editor lists the units; the summary names them as the calendars do.
  const property = usePropertyDetail(canManage ? connection.propertyId : null);
  const roomTypes = property.data?.roomTypes;
  const failure = error ?? property.error;
  const retry = () => {
    void mutate();
    void property.mutate();
  };

  return (
    <section aria-labelledby="calendars-heading" className="mt-8">
      <SectionHeading
        id="calendars-heading"
        title="Calendars"
        description={
          canManage
            ? 'One calendar for each site a unit is listed on: where the calendar of the site is read from, and the address of our calendar to give to the site.'
            : 'The calendars of each unit, and how reading them is going. You can look at them, not change them.'
        }
      />
      <div className="flex flex-col gap-4">
        <CalendarLimits />
        {!data || (canManage && !roomTypes) ? (
          <Card>{failure ? <ErrorState error={failure} onRetry={retry} /> : <PageLoading />}</Card>
        ) : (
          <>
            {failure && (
              <StaleNotice
                title="The calendars could not be refreshed"
                error={failure}
                onRetry={retry}
              />
            )}
            {canManage && roomTypes ? (
              <CalendarsEditor
                connection={connection}
                feeds={data.feeds}
                roomTypes={roomTypes}
                now={now}
                onSaved={(feeds) =>
                  Promise.all([mutate({ feeds }, { revalidate: false }), onSaved()])
                }
              />
            ) : (
              <CalendarsSummary feeds={data.feeds} live={isLive(connection)} now={now} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
