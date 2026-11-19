'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import useSWR from 'swr';
import { Badge, STATUS_TONES, Spinner } from '@/components/ui/misc';
import { query } from '@/lib/api';
import { cn } from '@/lib/cn';
import { STATUS_LABELS, formatStay } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import type { Reservation } from '@/lib/types';

/** Finds a reservation from anywhere: by guest, confirmation code, email, phone or channel reference. */
export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebounced(value.trim(), 200);
  const { data, isLoading } = useSWR<{ reservations: Reservation[] }>(
    term.length >= 2 ? `/reservations${query({ search: term, limit: 7, sort: 'created' })}` : null,
    { keepPreviousData: false },
  );
  const results = data?.reservations ?? [];

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setActive(0), [term]);

  const go = (reservation: Reservation) => {
    setOpen(false);
    setValue('');
    inputRef.current?.blur();
    router.push(`/reservations/${reservation.id}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showList = open && term.length >= 2;
  return (
    <div className="relative w-full max-w-md">
      <Search
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-ink-faint"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls="global-search-results"
        aria-autocomplete="list"
        aria-label="Search reservations"
        placeholder="Search reservations"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="h-8 w-full rounded-md border border-transparent bg-sunken pr-12 pl-8 text-sm text-ink placeholder:text-ink-faint focus:border-brand-500 focus:bg-surface focus:ring-2 focus:ring-brand-200 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute top-1.5 right-2 hidden rounded border border-line bg-surface px-1 text-[10px] leading-4 text-ink-faint sm:block">
        Ctrl K
      </kbd>
      {showList && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute z-50 mt-1 w-full min-w-72 overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
        >
          {isLoading ? (
            <p className="flex items-center gap-2 px-3 py-3 text-[13px] text-ink-faint">
              <Spinner className="size-3.5" /> Searching
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-ink-faint">
              No reservation matches &quot;{term}&quot;.
            </p>
          ) : (
            results.map((r, index) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(r)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left',
                  index === active && 'bg-sunken',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{r.guestName}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    <span className="font-mono">{r.code}</span> ·{' '}
                    {formatStay(r.checkIn, r.checkOut)} · {r.rooms[0]?.roomTypeName}
                  </span>
                </span>
                <Badge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Badge>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
