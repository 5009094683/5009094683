import type { ReactNode } from 'react';
import { Notice } from '@/components/ui/misc';
import { formatDate, formatWeekdayName, plural } from '@/lib/format';
import { money } from './money';
import type { NightAudit } from './types';

/** `Fri 13 Nov 2026` */
export function dayText(date: string): string {
  return `${formatWeekdayName(date)} ${formatDate(date)}`;
}

/** `03:00` */
export function hourText(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * `14 Nov, 00:05` by the clock at the property. The hotel day and the hour of the automatic
 * run are given in property time, so the time a run happened is too.
 */
export function ranAt(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value));
}

const API_KEY = 'api-key:';

/**
 * Who ran it: `Automatic` for the nightly run, else the person's name when it is known and
 * their email address when it is not. Another system that ran it with an API key is named
 * after its key.
 */
export function ranBy(audit: NightAudit, names: Map<string, string>): string {
  if (audit.runByLabel.startsWith('system:')) return 'Automatic';
  if (audit.runByLabel.startsWith(API_KEY)) {
    return `${audit.runByLabel.slice(API_KEY.length)} (API key)`;
  }
  return (audit.runBy && names.get(audit.runBy)) || audit.runByLabel;
}

/** The audit lists people as "CODE Guest name". */
function person(entry: string): { name: string; code: string | null } {
  const space = entry.indexOf(' ');
  return space > 0
    ? { name: entry.slice(space + 1), code: entry.slice(0, space) }
    : { name: entry, code: null };
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className="tabular text-base font-semibold text-ink">{children}</dd>
    </div>
  );
}

function People({ title, advice, people }: { title: string; advice?: string; people: string[] }) {
  if (people.length === 0) return null;
  return (
    <section>
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {advice && <p className="text-[13px] text-ink-soft">{advice}</p>}
      <ul className="mt-1.5 divide-y divide-line rounded-lg border border-line text-sm">
        {people.map((entry) => {
          const { name, code } = person(entry);
          return (
            <li key={entry} className="flex flex-wrap justify-between gap-x-3 px-3 py-2">
              <span className="text-ink">{name}</span>
              {code && <span className="tabular text-ink-faint">Booking {code}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What one night audit did: the figures, and the guests it could not settle by itself. */
export function AuditFigures({ audit, currency }: { audit: NightAudit; currency: string }) {
  const summary = audit.summary;
  const settled =
    summary.noShows.length + summary.pendingArrivals.length + summary.overdueDepartures.length ===
    0;
  return (
    <div className="flex flex-col gap-4">
      {audit.status === 'failed' && (
        <Notice tone="danger" title="This run failed">
          {audit.error ?? 'No reason was recorded.'} Nothing was charged and the hotel day did not
          move on.
        </Notice>
      )}
      <dl className="grid grid-cols-2 gap-2.5">
        <Figure label="Rooms charged">{summary.roomChargesPosted}</Figure>
        <Figure label="Room charges, with tax">{money(summary.roomRevenue, currency)}</Figure>
        <Figure label="Guests staying on">{summary.stayovers}</Figure>
        <Figure label="Cleaning tasks written">{summary.housekeepingTasks}</Figure>
      </dl>
      <People
        title={`${plural(summary.pendingArrivals.length, 'booking')} did not arrive`}
        advice={
          summary.pendingArrivals.length === 1
            ? 'Left as it is. Mark it no-show, or check the guest in if they are late.'
            : 'Left as they are. Mark them no-show, or check the guests in if they are late.'
        }
        people={summary.pendingArrivals}
      />
      <People
        title={`${plural(summary.noShows.length, 'booking')} marked no-show`}
        people={summary.noShows}
      />
      <People
        title={`${plural(summary.overdueDepartures.length, 'guest')} due to leave and still checked in`}
        // Only the nights of a booking are charged, and these bookings had none left.
        advice={
          summary.overdueDepartures.length === 1
            ? 'Not charged for this night, because the booking had ended. Extend the stay or check the guest out.'
            : 'Not charged for this night, because their bookings had ended. Extend the stays or check the guests out.'
        }
        people={summary.overdueDepartures}
      />
      {settled && audit.status === 'completed' && (
        <p className="text-[13px] text-ink-soft">
          Every booking due that day arrived, and nobody stayed past their departure date.
        </p>
      )}
    </div>
  );
}
