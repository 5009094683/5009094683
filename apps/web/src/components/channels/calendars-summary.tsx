'use client';

import { Badge } from '@/components/ui/misc';
import { TREAT_AS } from './calendar-draft';
import { CalendarStatus } from './calendar-status';
import { channelLabel } from './labels';
import type { CalendarFeed } from './types';

/** The calendars of each unit together, in the order the units first appear. */
function byUnit(
  feeds: CalendarFeed[],
): { unitId: string; unitName: string; feeds: CalendarFeed[] }[] {
  const units = new Map<string, { unitId: string; unitName: string; feeds: CalendarFeed[] }>();
  for (const feed of feeds) {
    const unit = units.get(feed.unitId);
    if (unit) unit.feeds.push(feed);
    else units.set(feed.unitId, { unitId: feed.unitId, unitName: feed.unitName, feeds: [feed] });
  }
  return [...units.values()];
}

/**
 * The saved calendars, for people who may look at a connection but not change it. The
 * addresses are left out: whoever holds one can read which nights are taken.
 */
export function CalendarsSummary({
  feeds,
  live,
  now,
}: {
  feeds: CalendarFeed[];
  live: boolean;
  now: Date;
}) {
  if (feeds.length === 0) {
    return <p className="text-sm text-ink-faint">No calendar is set up yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {byUnit(feeds).map((unit) => (
          <li key={unit.unitId} className="overflow-hidden rounded-lg border border-line">
            <h3 className="border-b border-line bg-sunken/60 px-3 py-2 text-sm font-medium text-ink">
              {unit.unitName}
            </h3>
            <ul className="divide-y divide-line">
              {unit.feeds.map((feed) => (
                <li key={feed.id} className="flex flex-col gap-1.5 px-3 py-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    {feed.label} calendar
                    {feed.channelCode && channelLabel(feed.channelCode) !== feed.label && (
                      <Badge>{feed.channelCode}</Badge>
                    )}
                  </p>
                  <p className="text-[13px] text-ink-soft">{TREAT_AS[feed.treatAs].summary}</p>
                  <CalendarStatus feed={feed} live={live} now={now} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-ink-faint">
        The addresses of the calendars are shown only to people who can manage channels.
      </p>
    </div>
  );
}
