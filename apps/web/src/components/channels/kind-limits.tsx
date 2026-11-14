'use client';

import { Notice } from '@/components/ui/misc';

/** What a calendar connection can and cannot do, said once, before any calendar is set up. */
export function CalendarLimits() {
  return (
    <Notice tone="warning" title="What calendars can and cannot do">
      <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-4">
        <li>
          <strong className="font-semibold">
            Never use a calendar for a room type with more than one room.
          </strong>{' '}
          A calendar can only say that dates are taken or free. It cannot say how many rooms are
          left, so the site would go on selling rooms that are gone here: double bookings. Use the
          channel manager for those rooms.
        </li>
        <li>
          A calendar carries dates and nothing else. Each booking arrives without the guest and the
          price, and is marked for review until staff add them from the site.
        </li>
        <li>
          The calendars of the sites are read every 5 minutes, but a site reads ours only every few
          hours. Until it has, a room sold here can still be sold there.
        </li>
      </ul>
    </Notice>
  );
}

/**
 * What a reservations mailbox can and cannot do. `closesRooms` says whether the property has
 * another connection that closes its rooms on the sites, which a mailbox never does.
 */
export function MailboxLimits({ closesRooms }: { closesRooms: boolean | undefined }) {
  return (
    <Notice tone="info" title="What a reservations mailbox can and cannot do">
      <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-4">
        <li>
          It reads the emails the booking sites send about new bookings, changes and cancellations.
          It knows what an email says and nothing more, so every booking from it is marked for staff
          to check against the site.
        </li>
        <li>
          It sends nothing to the sites, so it does not close rooms there. The channel manager or
          the calendars do that.
          {closesRooms === false && (
            <strong className="font-semibold">
              {' '}
              This property has neither, so a room booked here stays on sale on the sites.
            </strong>
          )}
        </li>
        <li>
          It cannot tell that a booking has already arrived another way. Do not read the emails of a
          site whose bookings also come in through the channel manager or through a calendar that is
          read here: each booking would be recorded twice.
        </li>
      </ul>
    </Notice>
  );
}
