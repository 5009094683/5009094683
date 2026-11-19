import type { ReactNode } from 'react';
import { Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

/** How many figures stand side by side once there is room for all of them. */
const COLUMNS = {
  3: '@2xl:grid-cols-3',
  4: '@4xl:grid-cols-4',
  5: '@2xl:grid-cols-3 @6xl:grid-cols-5',
};

/**
 * The headline figures of a report. Side by side as cards where there is room; in a narrow
 * space, one under the other with the figure on the right, so that a long amount is never
 * squeezed into half a phone's width. It goes by the room it is given, not by the screen.
 */
export function Figures({ columns, children }: { columns: 3 | 4 | 5; children: ReactNode }) {
  return (
    <div className="@container">
      <dl className={cn('grid grid-cols-1 gap-2 @xl:grid-cols-2 @xl:gap-3', COLUMNS[columns])}>
        {children}
      </dl>
    </div>
  );
}

/** One headline figure, with a line saying what it counts. */
export function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <Card
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3',
        // Side by side, the cards of a row share its lines, so that the figures stand level
        // even when one label takes two lines.
        '@xl:row-span-3 @xl:grid-cols-1 @xl:grid-rows-subgrid @xl:items-start @xl:gap-y-1 @xl:p-4',
      )}
    >
      <dt className="text-[13px] font-medium text-ink-soft">{label}</dt>
      <dd
        className={cn(
          'tabular col-start-2 row-span-2 row-start-1 text-right text-xl font-semibold tracking-tight text-ink',
          '@xl:col-start-1 @xl:row-span-1 @xl:row-start-2 @xl:text-left @xl:text-2xl',
        )}
      >
        {value}
      </dd>
      {note && (
        <dd className="col-start-1 row-start-2 text-[13px] text-ink-faint @xl:row-start-3">
          {note}
        </dd>
      )}
    </Card>
  );
}
