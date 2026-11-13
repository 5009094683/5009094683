'use client';

import { AlertTriangle, CheckCircle2, Clock, MinusCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { sentence } from './labels';
import { RelativeTime } from './parts';
import type { CalendarFeed } from './types';

/** What the server reports about a read that failed, and what to tell staff instead. */
const READ_PROBLEMS: [RegExp, (found: RegExpExecArray) => string][] = [
  [
    /answered (401|403)\b/,
    ([, status]) =>
      `The site refused to hand over its calendar (it answered ${status}). The address may have been replaced: copy it again from the site.`,
  ],
  [
    /answered (404|410)\b/,
    ([, status]) =>
      `The site says there is no calendar at this address (it answered ${status}). Copy the address again from the site.`,
  ],
  [
    /answered (429)\b/,
    () => 'The site says its calendar is asked for too often. It is tried again by itself.',
  ],
  [
    /answered (5\d\d)\b/,
    ([, status]) =>
      `The site has a problem of its own (it answered ${status}). It is tried again by itself.`,
  ],
  [
    /did not return a calendar/i,
    () =>
      'What this address returns is not a calendar. Check that it is the address the site gives for exporting its calendar; it usually ends in .ics.',
  ],
  [
    /did not answer in time/i,
    () => 'The site did not answer in time. It is tried again by itself.',
  ],
  [
    /ENOTFOUND|EAI_AGAIN/,
    () => 'No site was found at this address. Check the address for typing mistakes.',
  ],
  [
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/,
    () =>
      'The site could not be reached. It is tried again by itself; if this goes on, check the address.',
  ],
  [
    /is not a public address/i,
    () =>
      'This address leads to a private network, which is not read. Use the address the site gives out.',
  ],
  [/only https addresses/i, () => 'Only addresses that start with https:// can be read.'],
  [
    /too many redirects/i,
    () =>
      'The site keeps passing the request on to another address. Copy the address again from the site.',
  ],
];

/** `the Airbnb calendar of Coral Cottage`: a calendar inside a sentence. */
export function calendarName(feed: CalendarFeed): string {
  return `the ${feed.label} calendar of ${feed.unitName}`;
}

/**
 * The calendars whose last read did not work. People who are not shown the addresses cannot
 * tell which calendars are read at all, so for them every calendar with a failure counts.
 */
export function failingCalendars(feeds: CalendarFeed[], seesAddresses: boolean): CalendarFeed[] {
  return feeds.filter((feed) => feed.error && (feed.importUrl || !seesAddresses));
}

/** Why a calendar could not be read, in words staff can act on. */
export function readProblem(error: string): string {
  for (const [pattern, explain] of READ_PROBLEMS) {
    const found = pattern.exec(error);
    if (found) return explain(found);
  }
  return sentence(error);
}

function Line({
  icon: Icon,
  iconClass,
  children,
}: {
  icon: LucideIcon;
  iconClass: string;
  children: ReactNode;
}) {
  return (
    <p className="flex items-start gap-1.5 text-[13px] text-ink-soft">
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', iconClass)} aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * How reading the calendar of a site is going: when it was last read, and whether that worked.
 * `read` says whether there is an address to read; people who are not shown the addresses
 * cannot tell, and leave it out.
 */
export function CalendarStatus({
  feed,
  read,
  live,
  now,
}: {
  feed: CalendarFeed;
  read?: boolean;
  /** Whether the connection is switched on, so that calendars are read at all. */
  live: boolean;
  now: Date;
}) {
  if (read === false) {
    return (
      <Line icon={MinusCircle} iconClass="text-ink-faint">
        Not read: the address of the calendar of the site is not entered. Bookings made on{' '}
        {feed.label} do not arrive here; the site can still read ours.
      </Line>
    );
  }
  if (feed.error) {
    return (
      <div className="rounded-md border border-danger-100 bg-danger-50 px-3 py-2 text-[13px] text-danger-700">
        <p className="flex items-start gap-1.5 font-medium">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          The last read did not work
        </p>
        <p className="mt-0.5 break-words">{readProblem(feed.error)}</p>
        <p className="mt-0.5">
          {feed.lastReadAt ? (
            <>
              It was last read <RelativeTime value={feed.lastReadAt} now={now} />. Bookings made on{' '}
              {feed.label} since then are not here.
            </>
          ) : (
            `It has not been read yet, so no booking made on ${feed.label} is here.`
          )}
        </p>
      </div>
    );
  }
  if (feed.lastReadAt) {
    return (
      <Line icon={CheckCircle2} iconClass="text-success-500">
        Read <RelativeTime value={feed.lastReadAt} now={now} />, and that worked.{' '}
        {feed.entries === 0
          ? 'It has no upcoming entries.'
          : `It has ${plural(feed.entries, 'upcoming entry', 'upcoming entries')}.`}
      </Line>
    );
  }
  if (read === undefined) {
    return (
      <Line icon={Clock} iconClass="text-ink-faint">
        Not read so far. Either it is new, or it is not set to be read.
      </Line>
    );
  }
  return (
    <Line icon={Clock} iconClass={live ? 'text-info-500' : 'text-ink-faint'}>
      {live
        ? 'Not read yet. Calendars are read every 5 minutes.'
        : 'Not read yet. Calendars are read once the connection is switched on.'}
    </Line>
  );
}
