'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { isValidDate, todayIn } from '@pms/domain/shared';
import type { Property } from '@/lib/types';
import { periodsFor, presetSpan, type PeriodKey, type Span } from './periods';
import { DEFAULT_VIEW, VIEWS, type ViewKey } from './views';

export interface ReportFilters {
  view: ViewKey;
  /** The properties reports may be asked for. */
  offered: Property[];
  /** Those chosen, in the order they are offered. None: every property offered. */
  propertyIds: string[];
  period: PeriodKey;
  /** What the custom date boxes hold, which may be nothing yet. Both are days the period covers. */
  customFrom: string;
  customTo: string;
  /** The dates the period covers. Null while the custom dates do not make a period. */
  span: Span | null;
  /** Why they do not: one is missing or unfinished, or the first is after the last. */
  spanFault: 'unfinished' | 'backwards' | null;
  /** The grouping the address asks for, which the report may not offer. */
  group: string | null;
  /** The address of another view with the same filters. */
  hrefFor(view: ViewKey): string;
  /** Goes to that address, leaving this one for the back button to return to. */
  openView(view: ViewKey): void;
  setProperties(ids: string[]): void;
  setPeriod(period: PeriodKey): void;
  setCustom(dates: { from?: string; to?: string }): void;
  setGroup(group: string): void;
}

/**
 * What a date box holds is given back to it untouched, also a year half typed such as 0002:
 * a box handed anything else loses what was typed into it.
 */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (value: string | null): string => (value && DATE_SHAPE.test(value) ? value : '');

/** The calendar date at the properties looked at, which is what "this month" is counted from. */
function todayAt(properties: Property[]): string {
  const zone = (properties.find((p) => p.active) ?? properties[0])?.timezone;
  try {
    if (zone) return todayIn(zone);
  } catch {
    // A zone this browser does not know: the browser's own date is the best there is.
  }
  return todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/**
 * The query of the address as it stands this instant. Next's `useSearchParams` hears of a
 * change a moment after it is made, and in that moment React puts a date box or a tick box
 * back to the value it had, which makes a date impossible to type. So the address itself is
 * read, and the filters follow it at once.
 */
function useSearch(): URLSearchParams {
  const routed = useSearchParams().toString();
  // A change Next makes itself, such as a link followed, is heard of through it.
  useEffect(tell, [routed]);
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => (routed ? `?${routed}` : ''),
  );
  return useMemo(() => new URLSearchParams(search), [search]);
}

/**
 * The view and its filters live in the address, so a report can be bookmarked or sent to
 * someone, and the back button returns to the view before.
 */
export function useReportFilters(offered: Property[]): ReportFilters {
  const pathname = usePathname();
  const params = useSearch();

  const view = VIEWS.find((entry) => entry.key === params.get('view'))?.key ?? DEFAULT_VIEW;
  const wanted = new Set((params.get('properties') ?? '').split(','));
  const chosen = offered.filter((p) => wanted.has(p.id));
  const propertyIds = chosen.map((p) => p.id);

  // Every report shares one period where it suits: a period pace does not offer falls back to
  // the one pace opens with, and comes back when another report is opened.
  const periods = view === 'schedules' ? periodsFor('performance') : periodsFor(view);
  const period = periods.find((key) => key === params.get('period')) ?? periods[0]!;
  const customFrom = dateParam(params.get('from'));
  const customTo = dateParam(params.get('to'));
  const today = todayAt(chosen.length > 0 ? chosen : offered);
  const typed = isValidDate(customFrom) && isValidDate(customTo);
  const span =
    period !== 'custom'
      ? presetSpan(period, today)
      : typed && customFrom <= customTo
        ? { from: customFrom, to: customTo }
        : null;
  const spanFault = span ? null : typed ? 'backwards' : 'unfinished';

  const search = (changes: Record<string, string | null>, from: string): string => {
    const next = new URLSearchParams(from);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Commas are left as they are: the address is read and passed on by people too.
    const text = next.toString().replaceAll('%2C', ',');
    return text ? `${pathname}?${text}` : pathname;
  };
  // Written to the address directly rather than through the router: two changes made one
  // straight after the other both hold, and nothing is asked of the server for the page.
  const change = (changes: Record<string, string | null>) => {
    window.history.replaceState(null, '', search(changes, window.location.search));
    tell();
  };
  const hrefFor = (target: ViewKey) =>
    search({ view: target === DEFAULT_VIEW ? null : target }, params.toString());

  return {
    view,
    offered,
    propertyIds,
    period,
    customFrom,
    customTo,
    span,
    spanFault,
    group: params.get('group'),
    hrefFor,
    openView: (target) => {
      window.history.pushState(null, '', hrefFor(target));
      tell();
    },
    setProperties: (ids) => change({ properties: ids.join(',') || null }),
    setPeriod: (next) => {
      if (next !== 'custom') {
        change({ period: next === periods[0] ? null : next, from: null, to: null });
        return;
      }
      // Custom dates start from the period on screen, so one of them can be moved.
      const start = period === 'custom' ? { from: customFrom, to: customTo } : span;
      change({ period: 'custom', from: start?.from ?? null, to: start?.to ?? null });
    },
    setCustom: (dates) =>
      change({
        ...(dates.from === undefined ? {} : { from: dates.from || null }),
        ...(dates.to === undefined ? {} : { to: dates.to || null }),
      }),
    setGroup: (group) => change({ group }),
  };
}
