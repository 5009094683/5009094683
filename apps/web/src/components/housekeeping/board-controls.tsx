'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import type { BoardFilters, Grouping } from './board';
import { SETTABLE_STATES, STATES, STATE_DOTS, STATE_LABELS } from './labels';
import { TOUCH } from './task-row';
import type { Board, SettableState } from './types';

/** How many rooms are in each cleaning state, each a switch to show only those, and the day's tasks. */
export function CountsStrip({
  board,
  state,
  onState,
}: {
  board: Board;
  state: BoardFilters['state'];
  onState: (state: BoardFilters['state']) => void;
}) {
  // The server counts a skipped task as done. A room that was skipped has not been cleaned,
  // so the two are told apart here.
  const skipped = board.units.reduce(
    (count, unit) => count + unit.tasks.filter((task) => task.status === 'skipped').length,
    0,
  );
  const done = Math.max(0, board.counts.tasksDone - skipped);
  return (
    <div className="mb-3 grid grid-cols-4 gap-2 lg:grid-cols-5">
      {STATES.map((s) => {
        const pressed = state === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={pressed}
            aria-label={`${STATE_LABELS[s]}: ${plural(board.counts[s], 'room')}. Show only these.`}
            onClick={() => onState(pressed ? null : s)}
            className={cn(
              'flex min-h-16 flex-col justify-center rounded-xl border px-2.5 py-2 text-left shadow-card transition-colors sm:px-3.5',
              pressed
                ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                : 'border-line bg-surface hover:border-line-strong',
            )}
          >
            <span className="tabular text-2xl leading-none font-semibold text-ink">
              {board.counts[s]}
            </span>
            <span className="mt-1.5 flex items-start gap-1.5 text-xs leading-tight text-ink-soft">
              <span className={cn('mt-[3px] size-2 shrink-0 rounded-full', STATE_DOTS[s])} />
              {STATE_LABELS[s]}
            </span>
          </button>
        );
      })}
      <div className="col-span-4 flex items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-card lg:col-span-1 lg:flex-col lg:items-start lg:justify-center lg:gap-0.5">
        <p className="text-xs font-medium text-ink-faint">Tasks</p>
        <p className="text-sm text-ink">
          <span className="tabular font-semibold">{board.counts.tasksOpen}</span> to do
          <span className="mx-1.5 text-ink-faint">·</span>
          <span className="tabular font-semibold">{done}</span> done
          {skipped > 0 && (
            <>
              <span className="mx-1.5 text-ink-faint">·</span>
              <span className="tabular font-semibold">{skipped}</span> skipped
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export function GroupingToggle({
  value,
  onChange,
}: {
  value: Grouping;
  onChange: (value: Grouping) => void;
}) {
  const options: { value: Grouping; label: string }[] = [
    { value: 'floor', label: 'By floor' },
    { value: 'type', label: 'By room type' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Group rooms"
      className="inline-flex rounded-md border border-line-strong bg-sunken p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-[38px] rounded-[5px] px-3 text-[13px] font-medium transition-colors sm:h-[30px]',
            value === option.value
              ? 'bg-surface text-ink shadow-sm'
              : 'text-ink-soft hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Stays at the foot of the screen while rooms are selected, to mark them all at once. */
export function BulkBar({
  count,
  saving,
  onMark,
  onClear,
}: {
  count: number;
  saving: string | undefined;
  onMark: (state: SettableState) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Selected rooms"
      className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-line bg-surface px-4 py-3 shadow-pop sm:-mx-6 sm:px-6"
    >
      {/* On a phone: the count and Clear on one line, the three states across the line below. */}
      <div className="grid grid-cols-3 items-center gap-2 sm:flex sm:flex-wrap sm:gap-x-3">
        <p className="col-span-2 row-start-1 text-sm font-medium text-ink" aria-live="polite">
          {plural(count, 'room')} selected. Mark as:
        </p>
        {SETTABLE_STATES.map((state) => (
          <Button
            key={state}
            className={cn(TOUCH, 'row-start-2 px-1 sm:px-3.5')}
            loading={saving === state}
            disabled={saving !== undefined}
            onClick={() => onMark(state)}
          >
            {STATE_LABELS[state]}
          </Button>
        ))}
        <Button
          variant="ghost"
          className={cn(TOUCH, 'col-start-3 row-start-1 justify-self-end sm:ml-auto')}
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
