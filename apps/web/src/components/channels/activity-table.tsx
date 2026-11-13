'use client';

import { ArrowDownLeft, ArrowUpRight, History } from 'lucide-react';
import { Badge, Card, EmptyState } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import {
  LOG_DIRECTIONS,
  LOG_STATUS,
  formatWaited,
  nameRooms,
  operationCount,
  operationLabel,
} from './labels';
import { RelativeTime } from './parts';
import type { SyncLogRow } from './types';

const COLUMNS = ['Time', 'Direction', 'What', 'Count', 'Result', 'Waited'];

/**
 * The channel manager's own ids for what was sent: what its support asks for when something
 * needs tracing, and what its certification asks to be quoted for each test.
 */
function referencesOf(row: SyncLogRow): string[] {
  const references = row.detail?.references;
  return Array.isArray(references)
    ? references.filter((r): r is string => typeof r === 'string')
    : [];
}

/** What was sent and received on a connection, newest first. */
export function ActivityTable({
  log,
  roomNames,
  now,
}: {
  log: SyncLogRow[];
  /** Titles of the channel manager's rooms by id, for errors that give only the id. */
  roomNames?: ReadonlyMap<string, string>;
  now: Date;
}) {
  return (
    <Card className="overflow-hidden">
      {log.length === 0 ? (
        <EmptyState
          icon={<History className="size-5" />}
          title="Nothing has been sent or received yet"
          description="Activity appears here once the connection is switched on."
        />
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="px-4 py-2.5 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {log.map((row) => {
                const status = LOG_STATUS[row.status];
                const Arrow = row.direction === 'out' ? ArrowUpRight : ArrowDownLeft;
                const references = referencesOf(row);
                return (
                  <tr key={row.id}>
                    <td className="tabular w-28 px-4 py-2.5 whitespace-nowrap text-ink-soft">
                      <RelativeTime value={row.createdAt} now={now} />
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-ink-soft">
                      <span className="inline-flex items-center gap-1.5">
                        <Arrow className="size-3.5 text-ink-faint" aria-hidden />
                        {LOG_DIRECTIONS[row.direction]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="text-ink">{operationLabel(row)}</p>
                      {row.error && (
                        <p
                          className={cn(
                            'mt-0.5 max-w-xl text-[13px] break-words',
                            row.status === 'retry' ? 'text-warning-700' : 'text-danger-700',
                          )}
                        >
                          {nameRooms(row.error, roomNames)}
                        </p>
                      )}
                      {references.length > 0 && (
                        <p className="mt-0.5 flex max-w-xl flex-wrap gap-x-2 text-xs text-ink-faint">
                          <span>Channel manager reference:</span>
                          {references.map((reference) => (
                            <span
                              key={reference}
                              className="font-mono whitespace-nowrap select-all"
                            >
                              {reference}
                            </span>
                          ))}
                        </p>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 whitespace-nowrap text-ink-soft">
                      {operationCount(row)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className="tabular px-4 py-2.5 whitespace-nowrap text-ink-soft">
                      {row.lagMs === null ? '' : formatWaited(row.lagMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
