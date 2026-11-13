'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { Popover } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatAmount, formatWeekday, fromMinor, toMinor } from '@/lib/format';
import type { RatePlan } from '@/lib/types';
import type { RateChangeBody, ShownDay } from './pending';

export const CELL = 58;

const NOT_SAVED = 'not saved yet';

/**
 * One rate cell. Enter keeps the figure and moves right; Escape cancels;
 * clearing the field takes the day back to the plan's own rate. The figure is
 * held with the other changes until they are saved together.
 */
export function RateCell({
  day,
  currency,
  editable,
  follows,
  onChange,
}: {
  day: ShownDay;
  currency: string;
  editable: boolean;
  /** For a plan that takes its price from another whose rate is waiting to be saved: that plan's name. */
  follows?: string | null;
  onChange: (rate: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const cancelled = useRef(false);

  const commit = (moveNext: boolean, element: HTMLInputElement) => {
    if (cancelled.current) return;
    const text = value.trim();
    const next = text === '' ? null : toMinor(Number(text), currency);
    setEditing(false);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return;
    const unchanged = next === null ? !day.rateOverridden : next === day.rate && day.rateOverridden;
    if (!unchanged) onChange(next);
    if (moveNext) {
      const cell = element.closest('[data-rate-cell]')?.nextElementSibling;
      (cell?.querySelector('button') as HTMLButtonElement | null)?.click();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(true, e.currentTarget);
    } else if (e.key === 'Escape') {
      cancelled.current = true;
      setEditing(false);
    }
  };

  const title = day.ratePending
    ? 'Changed here, not saved yet'
    : follows
      ? `Follows ${follows}: it changes when the changes are saved`
      : day.rateOverridden
        ? 'Set for this day'
        : 'Plan default';

  return (
    <div data-rate-cell className="shrink-0 border-r border-line" style={{ width: CELL }}>
      {editing ? (
        <input
          autoFocus
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={value}
          aria-label={`Rate on ${day.date}`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={(e) => commit(false, e.currentTarget)}
          onFocus={(e) => e.currentTarget.select()}
          className="tabular h-8 w-full bg-brand-50 px-1 text-center text-[13px] outline-2 -outline-offset-2 outline-brand-500"
        />
      ) : (
        <button
          type="button"
          disabled={!editable}
          title={title}
          aria-label={`Rate on ${day.date}: ${formatAmount(day.rate, currency)}${day.ratePending ? `, ${NOT_SAVED}` : ''}`}
          onClick={() => {
            cancelled.current = false;
            setValue(String(fromMinor(day.rate, currency)));
            setEditing(true);
          }}
          className={cn(
            'tabular h-8 w-full text-center text-[13px] transition-colors',
            editable && 'hover:bg-brand-50',
            !editable && 'cursor-default',
            day.rateOverridden ? 'font-semibold text-ink' : 'text-ink-soft',
            day.stopSell && 'text-ink-faint line-through',
            day.ratePending && 'bg-warning-100 font-semibold text-ink',
            follows && !day.ratePending && 'text-ink-faint italic',
          )}
        >
          {formatAmount(day.rate, currency)}
        </button>
      )}
    </div>
  );
}

/** Restrictions for one day, edited in a popover and held with the other changes until saved. */
export function RestrictionCell({
  day,
  plan,
  editable,
  onChange,
}: {
  day: ShownDay;
  plan: RatePlan;
  editable: boolean;
  onChange: (change: RateChangeBody) => void;
}) {
  const [open, setOpen] = useState(false);
  const [minStay, setMinStay] = useState('');
  const [maxStay, setMaxStay] = useState('');
  const [stopSell, setStopSell] = useState(false);
  const [cta, setCta] = useState(false);
  const [ctd, setCtd] = useState(false);

  const flags = [
    day.stopSell && { text: 'Stop', tone: 'bg-danger-100 text-danger-700', title: 'Not on sale' },
    day.closedToArrival && {
      text: 'CTA',
      tone: 'bg-warning-100 text-warning-700',
      title: 'Closed to arrival',
    },
    day.closedToDeparture && {
      text: 'CTD',
      tone: 'bg-warning-100 text-warning-700',
      title: 'Closed to departure',
    },
    day.minStayArrival > 1 && {
      text: `${day.minStayArrival}n`,
      tone: 'bg-info-100 text-info-700',
      title: `Minimum stay ${day.minStayArrival} nights`,
    },
    day.maxStay !== null && {
      text: `≤${day.maxStay}n`,
      tone: 'bg-info-100 text-info-700',
      title: `Maximum stay ${day.maxStay} nights`,
    },
  ].filter(Boolean) as { text: string; tone: string; title: string }[];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Only what was changed is held: the list of changes then says what was meant.
    const change: RateChangeBody = {};
    const nights = minStay.trim() === '' ? plan.minStay : Math.max(1, Math.round(Number(minStay)));
    if (nights !== day.minStayArrival || nights !== day.minStayThrough) {
      // The plan's own minimum needs no entry for the day: the day follows the plan again.
      change.minStayArrival = nights === plan.minStay ? null : nights;
      change.minStayThrough = change.minStayArrival;
    }
    const longest = maxStay.trim() === '' ? null : Math.max(1, Math.round(Number(maxStay)));
    if (longest !== day.maxStay) change.maxStay = longest;
    if (stopSell !== day.stopSell) change.stopSell = stopSell;
    if (cta !== day.closedToArrival) change.closedToArrival = cta;
    if (ctd !== day.closedToDeparture) change.closedToDeparture = ctd;
    if (Object.keys(change).length > 0) onChange(change);
    setOpen(false);
  };

  const described = flags.length ? flags.map((f) => f.title).join(', ') : 'none';
  const trigger = (
    <button
      type="button"
      disabled={!editable}
      title={day.restrictionsPending ? 'Changed here, not saved yet' : undefined}
      aria-label={`Restrictions on ${day.date}: ${described}${day.restrictionsPending ? `, ${NOT_SAVED}` : ''}`}
      className={cn(
        'flex h-7 w-full items-center justify-center gap-0.5 px-0.5',
        editable ? 'hover:bg-brand-50' : 'cursor-default',
        day.restrictionsPending && 'bg-warning-100',
      )}
    >
      {flags.length === 0 ? (
        <span className="text-[11px] text-line-strong">·</span>
      ) : (
        flags.slice(0, 2).map((flag) => (
          <span
            key={flag.text}
            title={flag.title}
            className={cn('rounded px-1 text-[10px] leading-4 font-medium', flag.tone)}
          >
            {flag.text}
          </span>
        ))
      )}
    </button>
  );

  return (
    <div className="shrink-0 border-r border-line" style={{ width: CELL }}>
      {editable ? (
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next) {
              setMinStay(String(day.minStayArrival));
              setMaxStay(day.maxStay === null ? '' : String(day.maxStay));
              setStopSell(day.stopSell);
              setCta(day.closedToArrival);
              setCtd(day.closedToDeparture);
            }
            setOpen(next);
          }}
          trigger={trigger}
          className="w-64"
        >
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-sm font-medium text-ink">{formatWeekday(day.date)}</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Minimum stay">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={365}
                    value={minStay}
                    onChange={(e) => setMinStay(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Maximum stay">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={365}
                    placeholder="No limit"
                    value={maxStay}
                    onChange={(e) => setMaxStay(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Checkbox
              label="Stop sell (not on sale)"
              checked={stopSell}
              onChange={(e) => setStopSell(e.target.checked)}
            />
            <Checkbox
              label="Closed to arrival"
              checked={cta}
              onChange={(e) => setCta(e.target.checked)}
            />
            <Checkbox
              label="Closed to departure"
              checked={ctd}
              onChange={(e) => setCtd(e.target.checked)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" variant="primary">
                Done
              </Button>
            </div>
          </form>
        </Popover>
      ) : (
        trigger
      )}
    </div>
  );
}
