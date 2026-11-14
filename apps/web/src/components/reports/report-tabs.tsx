'use client';

import { useEffect, useRef, type MouseEvent } from 'react';
import { cn } from '@/lib/cn';
import type { ReportFilters } from './filters';
import { VIEWS, type ViewKey } from './views';

/**
 * The reports, one tab each. Tabs are links: each has an address of its own that can be opened
 * in a new tab, bookmarked or sent to someone, and the back button returns to the tab before.
 */
export function ReportTabs({ filters }: { filters: ReportFilters }) {
  const current = useRef<HTMLAnchorElement>(null);

  // On a narrow screen the strip scrolls sideways, and the open tab may start out of view.
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [filters.view]);

  const open = (event: MouseEvent<HTMLAnchorElement>, view: ViewKey) => {
    // A click with a key held, or with another button, is the browser's: a new tab or window.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    // The page is the same for every tab, so nothing needs to be asked of the server for it.
    filters.openView(view);
  };

  return (
    <nav
      aria-label="Reports"
      className="scrollbar-thin -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0"
    >
      {VIEWS.map((view) => {
        const active = view.key === filters.view;
        const href = filters.hrefFor(view.key);
        return (
          <a
            key={view.key}
            href={href}
            ref={active ? current : undefined}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => open(event, view.key)}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
              active
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {view.label}
          </a>
        );
      })}
    </nav>
  );
}
