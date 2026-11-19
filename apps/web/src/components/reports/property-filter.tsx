'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { Checkbox, Input } from '@/components/ui/field';
import { Popover } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import type { Property } from '@/lib/types';

/** From this many properties the list is long enough to want a search box. */
const SEARCH_FROM = 9;

/** The properties chosen, in a few words. */
function chosenText(offered: Property[], chosenIds: string[], allLabel: string | null): string {
  if (chosenIds.length === 0) return allLabel ?? 'Choose properties';
  const only = chosenIds.length === 1 && offered.find((p) => p.id === chosenIds[0]);
  return only ? only.name : plural(chosenIds.length, 'property', 'properties');
}

function PropertyList({
  offered,
  chosenIds,
  allLabel,
  onChange,
}: {
  offered: Property[];
  chosenIds: string[];
  allLabel: string | null;
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const words = search.trim().toLowerCase();
  const matching = offered.filter(
    (p) => !words || p.name.toLowerCase().includes(words) || p.code.toLowerCase().includes(words),
  );
  const active = matching.filter((p) => p.active);
  const closed = matching.filter((p) => !p.active);
  // Amounts in different currencies cannot be added up, so the currency matters to the choice.
  const severalCurrencies = new Set(offered.map((p) => p.currency)).size > 1;
  const chosen = new Set(chosenIds);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(offered.filter((p) => next.has(p.id)).map((p) => p.id));
  };

  const row = (property: Property) => (
    <li key={property.id}>
      <Checkbox
        className="flex w-full rounded-md px-2 py-1.5 hover:bg-sunken"
        checked={chosen.has(property.id)}
        onChange={() => toggle(property.id)}
        label={
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">{property.name}</span>
            {severalCurrencies && (
              <span className="shrink-0 text-xs text-ink-faint">{property.currency}</span>
            )}
          </span>
        }
      />
    </li>
  );

  return (
    <div className="flex max-h-[min(26rem,70dvh)] flex-col">
      {offered.length >= SEARCH_FROM && (
        <div className="border-b border-line p-2">
          <Input
            type="search"
            aria-label="Find a property"
            placeholder="Find a property"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      )}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {allLabel !== null && (
          <Checkbox
            className="mb-1 flex w-full rounded-md border-b border-line px-2 py-1.5 font-medium hover:bg-sunken"
            checked={chosen.size === 0}
            // Unticking it would leave nothing chosen, which is what it stands for already.
            onChange={() => chosen.size > 0 && onChange([])}
            label={allLabel}
          />
        )}
        <ul>{active.map(row)}</ul>
        {closed.length > 0 && (
          <>
            <p className="px-2 pt-3 pb-1 text-xs font-medium text-ink-faint">No longer active</p>
            <ul>{closed.map(row)}</ul>
          </>
        )}
        {matching.length === 0 && (
          <p className="px-2 py-3 text-[13px] text-ink-soft">
            No property has &ldquo;{search.trim()}&rdquo; in its name.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Which properties a report covers. With an `allLabel`, nothing ticked means all of them, which
 * is also what the API takes an empty choice to mean; without one, some must be ticked.
 */
export function PropertyFilter({
  offered,
  chosenIds,
  allLabel,
  onChange,
  error,
  className,
}: {
  offered: Property[];
  chosenIds: string[];
  allLabel: string | null;
  onChange: (ids: string[]) => void;
  /** What is wrong with the choice, said beneath it. */
  error?: string | null;
  className?: string;
}) {
  const labelId = useId();
  const valueId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const label = (
    <span id={labelId} className="text-[13px] font-medium text-ink-soft">
      {offered.length === 1 ? 'Property' : 'Properties'}
    </span>
  );
  const problem = error ? (
    <p id={errorId} role="alert" className="text-[13px] text-danger-600">
      {error}
    </p>
  ) : null;

  // With one property there is nothing to choose between.
  if (offered.length <= 1) {
    return (
      <div className={cn('flex min-w-0 flex-col gap-1', className)}>
        {label}
        <p
          className={cn(
            'flex h-9 items-center truncate text-sm',
            offered.length > 0 ? 'text-ink' : 'text-ink-faint',
          )}
        >
          {offered[0]?.name ?? 'None'}
        </p>
        {problem}
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {label}
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
        trigger={
          <button
            type="button"
            aria-labelledby={`${labelId} ${valueId}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-sm text-ink shadow-sm transition-colors',
              'hover:border-ink-faint focus:border-brand-500 focus:ring-2 focus:ring-brand-200 focus:outline-none',
              'aria-[invalid=true]:border-danger-500',
            )}
          >
            <span
              id={valueId}
              className={cn(
                'truncate',
                chosenIds.length === 0 && allLabel === null && 'text-ink-faint',
              )}
            >
              {chosenText(offered, chosenIds, allLabel)}
            </span>
            <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden />
          </button>
        }
      >
        <PropertyList
          offered={offered}
          chosenIds={chosenIds}
          allLabel={allLabel}
          onChange={onChange}
        />
      </Popover>
      {problem}
    </div>
  );
}
