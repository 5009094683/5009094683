'use client';

import { ArrowRightLeft, Plus } from 'lucide-react';
import { Badge, Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { attention } from './board';
import { SETTABLE_STATES, STATE_LABELS, STATE_TONES, occupancyText } from './labels';
import { TOUCH, TaskRow, type BoardActions } from './task-row';
import type { BoardUnit, SettableState } from './types';

const PRESSED: Record<SettableState, string> = {
  clean: 'border-success-500 bg-success-50 text-success-700',
  dirty: 'border-warning-500 bg-warning-50 text-warning-700',
  inspected: 'border-info-500 bg-info-50 text-info-700',
};

/** One room on the housekeeping board: its state, what is happening in it today and its tasks. */
export function UnitCard({
  unit,
  timezone,
  actions,
  selected,
  onSelect,
}: {
  unit: BoardUnit;
  timezone: string;
  actions: BoardActions | null;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const turnover = unit.occupancy === 'turnover';
  const rank = attention(unit);
  const saving = actions?.busy.get(`unit:${unit.unitId}`);
  // Maintenance decides when a room that is out of service comes back.
  const settable = actions !== null && unit.status !== 'out_of_service';

  return (
    <Card
      aria-label={unit.unitName}
      role="group"
      className={cn(
        'flex flex-col overflow-hidden',
        rank === 0 && 'border-l-4 border-l-warning-500',
        rank === 1 && 'border-l-4 border-l-danger-500',
        selected && 'ring-2 ring-brand-500',
      )}
    >
      <div className="flex items-start gap-2 p-3.5">
        {settable && (
          <label className="-my-2 -ml-2.5 flex size-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              aria-label={`Select ${unit.unitName}`}
              checked={selected}
              onChange={(event) => onSelect(event.target.checked)}
              className="size-5 cursor-pointer rounded border-line-strong accent-brand-600"
            />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-2xl leading-tight font-semibold tracking-tight break-words text-ink">
              {unit.unitName}
            </h3>
            <Badge tone={STATE_TONES[unit.status]} className="mt-1">
              {STATE_LABELS[unit.status]}
            </Badge>
          </div>
          <p className="text-[13px] text-ink-faint">{unit.roomTypeName}</p>
          <p
            className={cn(
              'mt-1.5 flex items-center gap-1.5 text-sm font-medium',
              turnover ? 'text-warning-700' : 'text-ink',
            )}
          >
            {turnover && <ArrowRightLeft className="size-4 shrink-0" aria-hidden />}
            {occupancyText(unit)}
          </p>
          {unit.guestName && (
            <p className="text-sm text-ink-soft">
              {unit.guestName}
              {turnover && ' (leaving)'}
            </p>
          )}
        </div>
      </div>

      {(unit.tasks.length > 0 || actions) && (
        <ul className="divide-y divide-line border-t border-line">
          {unit.tasks.map((task) => (
            <TaskRow key={task.id} unit={unit} task={task} timezone={timezone} actions={actions} />
          ))}
          {actions && (
            <li>
              <button
                type="button"
                onClick={() => actions.addTask(unit)}
                className="flex h-11 w-full items-center gap-1.5 px-3.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sunken hover:text-ink sm:h-9"
              >
                <Plus className="size-4 text-ink-faint" aria-hidden />
                Add task
                <span className="sr-only"> for {unit.unitName}</span>
              </button>
            </li>
          )}
        </ul>
      )}

      {settable && (
        <div
          role="group"
          aria-label={`Mark ${unit.unitName} as`}
          className="mt-auto grid grid-cols-3 gap-1.5 border-t border-line bg-sunken/40 p-2.5"
        >
          {SETTABLE_STATES.map((state) => {
            const pressed = unit.status === state;
            return (
              <button
                key={state}
                type="button"
                aria-pressed={pressed}
                aria-busy={saving === state || undefined}
                disabled={saving !== undefined}
                onClick={() => !pressed && actions.setState(unit, state)}
                className={cn(
                  TOUCH,
                  'rounded-md border px-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  pressed
                    ? PRESSED[state]
                    : 'border-line-strong bg-surface text-ink-soft shadow-sm hover:bg-sunken hover:text-ink',
                )}
              >
                {STATE_LABELS[state]}
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
