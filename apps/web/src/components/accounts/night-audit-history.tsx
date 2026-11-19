'use client';

import { useState } from 'react';
import { useReturnFocus } from '@/components/housekeeping/focus';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatWeekday } from '@/lib/format';
import { money } from './money';
import { AuditFigures, dayText, ranAt, ranBy } from './night-audit-figures';
import type { NightAudit } from './types';

const HEAD = 'px-3 py-2.5 align-bottom font-medium first:pl-4 last:pr-4';
// A figure's heading asks for no more than its longest word, so that spare width goes to who
// ran the audit before it goes to putting a heading on fewer lines.
const FIGURE_HEAD = cn(HEAD, 'w-px text-right');
const CELL = 'px-3 py-3 first:pl-4 last:pr-4';

const COUNTS: { label: string; of: (audit: NightAudit) => number }[] = [
  // A hyphen that does not break, so a narrow column cannot split the word.
  { label: 'No\u2011shows', of: (audit) => audit.summary.noShows.length },
  { label: 'Did not arrive', of: (audit) => audit.summary.pendingArrivals.length },
  { label: 'Overstays', of: (audit) => audit.summary.overdueDepartures.length },
  { label: 'Staying on', of: (audit) => audit.summary.stayovers },
  { label: 'Cleaning tasks', of: (audit) => audit.summary.housekeepingTasks },
];

function Count({ value }: { value: number }) {
  return <span className={cn('tabular', value === 0 && 'text-ink-faint')}>{value}</span>;
}

/** The last night audits of a property, newest first. A row opens what that run did. */
export function AuditHistory({
  audits,
  currency,
  timezone,
  names,
}: {
  audits: NightAudit[];
  currency: string;
  /** The property's time zone: runs are timed by its clock. */
  timezone: string;
  /** Names of staff by user id, as far as the viewer may see them. */
  names: Map<string, string>;
}) {
  const [opened, setOpened] = useState<NightAudit | null>(null);
  const rememberOpener = useReturnFocus(opened !== null);
  const open = (audit: NightAudit) => {
    rememberOpener();
    setOpened(audit);
  };
  return (
    <>
      <Card className="overflow-hidden">
        <div className="scrollbar-thin relative overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken/60 text-xs font-medium text-ink-faint">
                <th scope="col" className={HEAD}>
                  Hotel day
                </th>
                <th scope="col" className={HEAD}>
                  Ran
                </th>
                <th scope="col" className={HEAD}>
                  By
                </th>
                <th scope="col" className={FIGURE_HEAD}>
                  Rooms charged
                </th>
                <th scope="col" className={FIGURE_HEAD}>
                  Room charges, with tax
                </th>
                {COUNTS.map((count) => (
                  <th key={count.label} scope="col" className={FIGURE_HEAD}>
                    {count.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {audits.map((audit) => (
                <tr
                  key={audit.id}
                  className="cursor-pointer transition-colors hover:bg-brand-50/60"
                  onClick={() => open(audit)}
                >
                  <td className={cn(CELL, 'whitespace-nowrap')}>
                    <button
                      type="button"
                      className="font-medium text-ink hover:underline"
                      aria-label={`Night audit for ${dayText(audit.businessDate)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        open(audit);
                      }}
                    >
                      {dayText(audit.businessDate)}
                    </button>
                    {audit.status === 'failed' && (
                      <Badge tone="danger" className="ml-2">
                        Failed
                      </Badge>
                    )}
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap text-ink-soft')}>
                    {ranAt(audit.completedAt, timezone)}
                  </td>
                  <td className={cn(CELL, 'text-ink-soft')}>
                    {/* An email address stands in for a name that is not known here. It has no
                        spaces to wrap at and would otherwise push the figures out of sight. */}
                    <span className="block max-w-44 min-w-28 [overflow-wrap:anywhere]">
                      {ranBy(audit, names)}
                    </span>
                  </td>
                  <td className={cn(CELL, 'text-right')}>
                    <Count value={audit.summary.roomChargesPosted} />
                  </td>
                  <td className={cn(CELL, 'tabular text-right whitespace-nowrap text-ink')}>
                    {money(audit.summary.roomRevenue, currency)}
                  </td>
                  {COUNTS.map((count) => (
                    <td key={count.label} className={cn(CELL, 'text-right')}>
                      <Count value={count.of(audit)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {opened && (
        <Dialog
          open
          onClose={() => setOpened(null)}
          title={`Night audit for ${formatWeekday(opened.businessDate)}`}
          description={`Ran ${ranAt(opened.completedAt, timezone)}, ${
            ranBy(opened, names) === 'Automatic' ? 'by itself' : `by ${ranBy(opened, names)}`
          }`}
          footer={<Button onClick={() => setOpened(null)}>Close</Button>}
        >
          <AuditFigures audit={opened} currency={currency} />
        </Dialog>
      )}
    </>
  );
}
