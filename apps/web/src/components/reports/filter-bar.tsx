'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import type { ReportFilters } from './filters';
import { PERIOD_LABELS, periodsFor, type PeriodKey } from './periods';
import { PropertyFilter } from './property-filter';
import type { ReportKey } from './views';

export interface GroupChoice {
  value: string;
  options: { value: string; label: string }[];
}

/** What "all properties" covers for the person signed in: a role for some properties sees only those. */
export function useAllLabel(): string {
  return useAuth().canOrgWide('reports.read') ? 'All properties' : 'All my properties';
}

/**
 * The spreadsheet of the report on screen. A link, so the browser saves the file the server
 * sends: the figures in it are the server's own, for the same filters.
 */
function DownloadLink({ href }: { href: string | null }) {
  const icon = <Download className="size-4" aria-hidden />;
  if (!href) {
    return (
      <Button disabled icon={icon} className="w-full lg:w-auto">
        Download spreadsheet
      </Button>
    );
  }
  return (
    <a
      href={href}
      download
      className={cn(
        'inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium whitespace-nowrap text-ink shadow-sm transition-colors select-none',
        'hover:bg-sunken active:bg-line lg:w-auto',
      )}
    >
      {icon}
      Download spreadsheet
    </a>
  );
}

/** The filters every report shares. They are kept in the address. */
export function FilterBar({
  view,
  filters,
  group,
  csvHref,
}: {
  view: ReportKey;
  filters: ReportFilters;
  /** The grouping of this report, when it has one. */
  group?: GroupChoice;
  /** Null while there is no report on screen to download. */
  csvHref: string | null;
}) {
  const allLabel = useAllLabel();
  const custom = filters.period === 'custom';

  return (
    <Card className="mb-4 p-4">
      <div className="grid grid-cols-2 items-end gap-3 lg:flex lg:flex-wrap">
        <PropertyFilter
          className="col-span-2 lg:w-60"
          offered={filters.offered}
          chosenIds={filters.propertyIds}
          allLabel={allLabel}
          onChange={filters.setProperties}
        />
        <Field label="Period" className={cn('lg:w-40', (custom || !group) && 'col-span-2')}>
          {(props) => (
            <Select
              {...props}
              value={filters.period}
              onChange={(event) => filters.setPeriod(event.target.value as PeriodKey)}
            >
              {periodsFor(view).map((period) => (
                <option key={period} value={period}>
                  {PERIOD_LABELS[period]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {custom && (
          // The two dates stay side by side, also where the row breaks.
          <div className="col-span-2 grid grid-cols-2 items-end gap-3 lg:flex">
            <Field label="From" className="lg:w-36">
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={filters.customFrom}
                  max={filters.customTo || undefined}
                  onChange={(event) => filters.setCustom({ from: event.target.value })}
                />
              )}
            </Field>
            <Field label="To" className="lg:w-36">
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={filters.customTo}
                  min={filters.customFrom || undefined}
                  onChange={(event) => filters.setCustom({ to: event.target.value })}
                />
              )}
            </Field>
          </div>
        )}
        {group && (
          <Field label="Group by" className={cn('lg:w-36', custom && 'col-span-2')}>
            {(props) => (
              <Select
                {...props}
                value={group.value}
                onChange={(event) => filters.setGroup(event.target.value)}
              >
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="col-span-2 lg:ml-auto">
          <DownloadLink href={csvHref} />
        </div>
      </div>
    </Card>
  );
}
