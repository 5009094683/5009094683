'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { listAuditLog } from '@pms/domain';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { Serialized } from '@/lib/types';

export type AuditPage = Serialized<Awaited<ReturnType<typeof listAuditLog>>>;
export type AuditEntry = AuditPage['entries'][number];

const ACTOR_TYPE_LABELS: Record<AuditEntry['actorType'], string | null> = {
  user: null,
  system: 'System',
  channel: 'Booking channel',
  api_key: 'API key',
  copilot: 'Copilot',
  guest: 'Guest',
};

const withYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const exact = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long' });

function AuditRow({
  entry,
  open,
  onToggle,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const at = new Date(entry.at);
  const actorType = ACTOR_TYPE_LABELS[entry.actorType];
  const detailsId = `audit-changes-${entry.id}`;
  return (
    <Fragment>
      <tr className="align-top">
        <td className="tabular px-4 py-2.5 whitespace-nowrap text-ink-soft">
          <time dateTime={entry.at} title={exact.format(at)}>
            {at.getFullYear() === new Date().getFullYear()
              ? formatDateTime(at)
              : withYear.format(at)}
          </time>
        </td>
        <td className="px-4 py-2.5">
          <p className="text-ink">{entry.actorLabel}</p>
          {(actorType || entry.ip) && (
            <p className="text-xs text-ink-faint">
              {[actorType, entry.ip].filter(Boolean).join(' · ')}
            </p>
          )}
        </td>
        <td className="px-4 py-2.5">
          <p className="font-mono text-[13px] text-ink">{entry.action}</p>
          <p className="text-xs text-ink-faint">{entry.entityType}</p>
        </td>
        <td className="px-4 py-2.5 text-ink-soft">
          {entry.summary ?? <span className="text-ink-faint">No summary</span>}
        </td>
        <td className="px-2 py-1.5 text-right whitespace-nowrap">
          {entry.changes && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={detailsId}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-ink-soft hover:bg-sunken hover:text-ink"
            >
              {open ? (
                <ChevronDown className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
              Details
              <span className="sr-only">: {entry.summary ?? entry.action}</span>
            </button>
          )}
        </td>
      </tr>
      {entry.changes && open && (
        <tr id={detailsId}>
          <td colSpan={5} className="bg-sunken/50 p-0">
            {/* As wide as the visible part of the table and pinned to it, so the changes can be
                read on a narrow screen wherever the table is scrolled to. */}
            <div className="sticky left-0 w-[100cqw] px-4 py-3">
              <pre className="max-h-96 overflow-y-auto font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-ink">
                {JSON.stringify(entry.changes, null, 2)}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function AuditTable({ entries, stale }: { entries: AuditEntry[]; stale: boolean }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    // Positioned so the visually hidden column heading scrolls with the table instead of
    // widening the page. A size container so an open details row can match the visible width.
    <div
      className={cn(
        '@container scrollbar-thin relative overflow-x-auto transition-opacity',
        stale && 'opacity-50',
      )}
      aria-busy={stale}
    >
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
            <th scope="col" className="px-4 py-2.5 font-medium">
              Time
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Who
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Action
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Summary
            </th>
            <th scope="col" className="px-4 py-2.5">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entries.map((entry) => (
            <AuditRow
              key={entry.id}
              entry={entry}
              open={expanded.has(entry.id)}
              onToggle={() => toggle(entry.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
