'use client';

import useSWR from 'swr';
import { addDays } from '@pms/domain/shared';
import { api, query } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { ReportFilters } from './filters';
import { ENDPOINTS, type ReportKey } from './views';

/**
 * Ticking three properties or typing a date is several changes in a row, and each report is a
 * heavy question for the database: it is asked once the changes have stopped.
 */
const SETTLE_MS = 500;

/** A report kept from a moment ago is shown again without asking: opening a view twice costs one request. */
const KEEP_MS = 15_000;

/** Bookings and payments arrive in bursts, and one fresh report for a burst is enough. */
const LIVE_REFRESH_MS = 15_000;

export interface ReportRequest {
  /** The report as filtered, as the API is asked for it. Null while it cannot be asked for. */
  path: string | null;
  /** The same report as a spreadsheet file. */
  csvHref: string | null;
  /** True while the filters are still being changed. */
  settling: boolean;
  propertyIds: string[];
}

/** What to ask the API for, given the filters on screen and the grouping of this report. */
export function useReportRequest(
  view: ReportKey,
  filters: ReportFilters,
  groupBy?: string,
): ReportRequest {
  const { span } = filters;
  const ids = filters.propertyIds.join(',');
  // Only typed dates wait: a named period is one choice, not several keystrokes. What is in
  // the date boxes is watched rather than the period they make, so that every keystroke counts
  // as a change, also from one unfinished date to the next.
  const typed = filters.period === 'custom' ? `${filters.customFrom}|${filters.customTo}` : '';
  const settledIds = useDebounced(ids, SETTLE_MS);
  const settledTyped = useDebounced(typed, SETTLE_MS);
  const settling =
    settledIds !== ids || (typed !== '' && settledTyped !== '' && settledTyped !== typed);

  if (!span || settling) {
    return { path: null, csvHref: null, settling, propertyIds: filters.propertyIds };
  }
  const asked = {
    from: span.from,
    // The API's `to` is the first day left out.
    to: addDays(span.to, 1),
    propertyIds: filters.propertyIds,
    groupBy,
  };
  return {
    path: `${ENDPOINTS[view]}${query(asked)}`,
    csvHref: `/api${ENDPOINTS[view]}${query({ ...asked, format: 'csv' })}`,
    settling,
    propertyIds: filters.propertyIds,
  };
}

interface Loaded<T> {
  path: string;
  report: T;
}

export interface ReportState<T> {
  /** The report to show: the one asked for, or the one before it while that is on its way. */
  report: T | undefined;
  /** Whether `report` is the one the filters ask for. */
  current: boolean;
  /** Why the report asked for could not be had. */
  error: unknown;
  /** Why the report on screen could not be brought up to date. It stays on screen. */
  refreshError: unknown;
  /** A request is on its way. */
  busy: boolean;
  retry(): void;
}

/**
 * One report from the API. While other filters load, the report before stays on screen, and it
 * is known not to be the one asked for: it is never passed off as that, nor shown after a failure.
 */
export function useReport<T>(request: ReportRequest): ReportState<T> {
  const { data, error, isValidating, mutate } = useSWR<Loaded<T>>(
    request.path,
    async (path: string) => ({ path, report: await api<T>(path) }),
    { keepPreviousData: true, dedupingInterval: KEEP_MS, focusThrottleInterval: KEEP_MS },
  );
  const current = data !== undefined && data.path === request.path;

  // A room closed for repair is no longer available, and occupancy changes with it.
  useLive(
    /^(reservation|folio|block)\./,
    (events) => {
      const touched = events.some(
        (event) =>
          event.propertyId === null ||
          request.propertyIds.length === 0 ||
          request.propertyIds.includes(event.propertyId),
      );
      if (current && touched) void mutate();
    },
    LIVE_REFRESH_MS,
  );

  return {
    report: current || !error ? data?.report : undefined,
    current,
    error: current ? undefined : error,
    refreshError: current ? error : undefined,
    busy: isValidating || request.settling,
    retry: () => void mutate(),
  };
}
