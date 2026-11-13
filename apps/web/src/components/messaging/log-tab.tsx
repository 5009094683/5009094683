'use client';

import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, EmptyState } from '@/components/ui/misc';
import { formatDateTime } from '@/lib/format';
import type { AutomationLog } from './types';

function Result({ entry }: { entry: AutomationLog }) {
  if (entry.status === 'sent') return <Badge tone="success">Sent</Badge>;
  // The server joins the reason each way of sending failed with "; ".
  const reasons = (entry.reason ?? '').split('; ').filter(Boolean);
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge tone="warning">Not sent</Badge>
      {reasons.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px] text-ink-soft">
          {reasons.map((reason) => (
            <li key={reason} className="break-words">
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Booking({ entry }: { entry: AutomationLog }) {
  return (
    <Link
      href={`/reservations/${entry.reservationId}`}
      className="font-mono text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline"
    >
      {entry.reservationCode}
    </Link>
  );
}

/** What the automatic messages did lately: to whom, about which booking, when, and how it went. */
export function LogTab({ log }: { log: AutomationLog[] }) {
  if (log.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="size-5" />}
        title="Nothing has been sent automatically yet"
        description="Each time an automatic message writes to a guest, or cannot, it is listed here."
      />
    );
  }
  return (
    // Cards until the table has the room it needs: the page's own width, not the screen's.
    <div className="@container">
      <p className="mb-3 text-[13px] text-ink-soft">
        The last {log.length === 1 ? 'entry' : `${log.length} entries`}, newest first. An automatic
        message writes to a booking once: when it could not be sent, it is not tried again.
      </p>

      <ul className="flex flex-col gap-3 @3xl:hidden">
        {log.map((entry) => (
          <li key={entry.id}>
            <Card className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 font-medium break-words text-ink">{entry.ruleName}</p>
                <span className="shrink-0 text-[13px] text-ink-faint">
                  {formatDateTime(entry.createdAt)}
                </span>
              </div>
              <p className="text-[13px] text-ink-soft">
                To {entry.guestName}, booking <Booking entry={entry} />
              </p>
              <Result entry={entry} />
            </Card>
          </li>
        ))}
      </ul>

      <Card className="hidden overflow-hidden @3xl:block">
        <div className="scrollbar-thin relative overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Automatic message
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  To
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Booking
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Result
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {log.map((entry) => (
                <tr key={entry.id} className="align-top">
                  <td className="px-4 py-3 whitespace-nowrap text-ink-soft">
                    <span title={new Date(entry.createdAt).toLocaleString()}>
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink">{entry.ruleName}</td>
                  <td className="px-4 py-3 text-ink">{entry.guestName}</td>
                  <td className="px-4 py-3">
                    <Booking entry={entry} />
                  </td>
                  <td className="max-w-sm px-4 py-3">
                    <Result entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
