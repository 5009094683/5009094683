'use client';

import { CalendarRange, Hourglass, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Notice, PageLoading, Spinner } from '@/components/ui/misc';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { FilterBar, type GroupChoice } from './filter-bar';
import type { ReportFilters } from './filters';
import { formatsFor, type Formats } from './format';
import { daysText, reportSpan, spanText } from './periods';
import { useReport, useReportRequest } from './use-report';
import { viewLabel, type ReportKey } from './views';

interface AnyReport {
  from: string;
  to: string;
  /** Null when the report covers no property. */
  currency: string | null;
}

/** The server asked for fewer requests: a matter of waiting, not a fault. */
function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/** The server understood the request and will not answer it as asked: asking again changes nothing. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

/**
 * Why the report could not be shown, in the server's own words. When the properties asked for
 * are priced in more than one currency, the way out is offered: the properties of one currency.
 */
function Problem({
  error,
  filters,
  onRetry,
}: {
  error: unknown;
  filters: ReportFilters;
  onRetry: () => void;
}) {
  if (isRateLimited(error)) {
    return (
      <div role="alert">
        <EmptyState
          icon={<Hourglass className="size-5" />}
          title="Too many reports were asked for in a short time"
          description={errorMessage(error)}
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      </div>
    );
  }
  if (!isRefusal(error)) return <ErrorState error={error} onRetry={onRetry} />;

  const covered =
    filters.propertyIds.length > 0
      ? filters.offered.filter((p) => filters.propertyIds.includes(p.id))
      : filters.offered;
  const currencies = [...new Set(covered.map((p) => p.currency))].sort();
  return (
    <div role="alert">
      <EmptyState
        icon={<SlidersHorizontal className="size-5" />}
        title="This report cannot be shown as asked"
        description={errorMessage(error)}
        action={
          currencies.length > 1 && (
            <div className="flex flex-wrap justify-center gap-2">
              {currencies.map((currency) => (
                <Button
                  key={currency}
                  onClick={() =>
                    filters.setProperties(
                      covered.filter((p) => p.currency === currency).map((p) => p.id),
                    )
                  }
                >
                  Show the {currency} properties
                </Button>
              ))}
            </div>
          )
        }
      />
    </div>
  );
}

/**
 * One report: its filters, and then the report itself or what stands in its place while it
 * loads, when it fails, and when there is nothing in it.
 */
export function ReportFrame<T extends AnyReport>({
  view,
  filters,
  group,
  isEmpty,
  empty,
  children,
}: {
  view: ReportKey;
  filters: ReportFilters;
  group?: GroupChoice;
  /** Whether there is nothing in the report for its dates and properties. */
  isEmpty: (report: T) => boolean;
  /** What to say then. */
  empty: { title: string; description: string };
  children: (report: T, formats: Formats) => ReactNode;
}) {
  const request = useReportRequest(view, filters, group?.value);
  const { report, current, error, refreshError, busy, retry } = useReport<T>(request);
  const filled = report !== undefined && !isEmpty(report);

  let body: ReactNode;
  if (filters.offered.length === 0) {
    body = (
      <EmptyState
        title="There are no properties to report on"
        description="Reports show here once the organisation has a property."
      />
    );
  } else if (!filters.span && !request.settling) {
    // Said once the typing has stopped: a date half typed is not a mistake yet.
    body =
      filters.spanFault === 'backwards' ? (
        <Notice tone="warning">The first date is after the last. Change one of them.</Notice>
      ) : (
        <Notice>Choose the first and the last date of the period.</Notice>
      );
  } else if (error) {
    body = <Problem error={error} filters={filters} onRetry={retry} />;
  } else if (!report) {
    body = <PageLoading label="Working out the report" />;
  } else if (!filled) {
    body = (
      <div aria-busy={!current || undefined} className={cn(!current && 'opacity-60')}>
        <EmptyState
          icon={<CalendarRange className="size-5" />}
          title={empty.title}
          description={empty.description}
        />
      </div>
    );
  } else {
    const span = reportSpan(report);
    body = (
      <div
        aria-busy={!current || undefined}
        className={cn('flex flex-col gap-4 transition-opacity', !current && 'opacity-60')}
      >
        {refreshError !== undefined && (
          <Notice tone="warning" title="These figures could not be brought up to date">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{errorMessage(refreshError)}</span>
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            </div>
          </Notice>
        )}
        <p className="flex items-center gap-2 text-[13px] text-ink-soft" aria-live="polite">
          <span>
            {spanText(span)} · {daysText(span)}
          </span>
          {busy && <Spinner className="size-3.5" label="Updating" />}
        </p>
        {children(report, formatsFor(report.currency ?? filters.offered[0]?.currency ?? 'INR'))}
      </div>
    );
  }

  return (
    <section aria-labelledby={`report-${view}`}>
      <h2 id={`report-${view}`} className="sr-only">
        {viewLabel(view)}
      </h2>
      <FilterBar
        view={view}
        filters={filters}
        group={group}
        csvHref={current && filled ? request.csvHref : null}
      />
      {body}
    </section>
  );
}
