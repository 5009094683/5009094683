'use client';

import { useState, type FormEvent } from 'react';
import { addDays, isValidDate } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Segmented } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { toMinor } from '@/lib/format';
import type { PropertyDetail } from '@/lib/types';
import type { NewChange, RateChangeBody } from './pending';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

type Tri = 'keep' | 'on' | 'off';

/**
 * Sets rates and restrictions for a run of dates on one or more rate plans.
 * What is entered joins the changes waiting on the rates screen; nothing is
 * sent until they are saved.
 */
export function BulkDialog({
  detail,
  defaultFrom,
  onClose,
  onAdd,
}: {
  detail: PropertyDetail;
  defaultFrom: string;
  onClose: () => void;
  onAdd: (changes: NewChange[]) => void;
}) {
  const plans = detail.roomTypes.flatMap((t) =>
    t.ratePlans.filter((p) => p.active).map((p) => ({ plan: p, type: t })),
  );
  const currency = detail.property.currency;
  const [selected, setSelected] = useState<string[]>(plans[0] ? [plans[0].plan.id] : []);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(addDays(defaultFrom, 30));
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [rate, setRate] = useState('');
  const [minStay, setMinStay] = useState('');
  const [maxStay, setMaxStay] = useState('');
  const [stopSell, setStopSell] = useState<Tri>('keep');
  const [cta, setCta] = useState<Tri>('keep');
  const [ctd, setCtd] = useState<Tri>('keep');

  const change: RateChangeBody = {};
  if (rate.trim() !== '') change.rate = toMinor(Number(rate), currency);
  if (minStay.trim() !== '') {
    change.minStayArrival = Math.max(1, Math.round(Number(minStay)));
    change.minStayThrough = change.minStayArrival;
  }
  if (maxStay.trim() !== '') {
    const nights = Math.round(Number(maxStay));
    change.maxStay = nights <= 0 ? null : nights;
  }
  if (stopSell !== 'keep') change.stopSell = stopSell === 'on';
  if (cta !== 'keep') change.closedToArrival = cta === 'on';
  if (ctd !== 'keep') change.closedToDeparture = ctd === 'on';
  const hasChange = Object.keys(change).length > 0;
  const derivedSelected = plans.filter(
    (p) => selected.includes(p.plan.id) && p.plan.parentRatePlanId,
  );
  const invalidRate =
    change.rate !== undefined &&
    change.rate !== null &&
    (!Number.isFinite(change.rate) || change.rate < 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes: NewChange[] = [];
    for (const { plan } of plans.filter((p) => selected.includes(p.plan.id))) {
      // A derived plan follows its parent's price, so only its restrictions are set.
      const { rate: _rate, ...restrictions } = change;
      const body = plan.parentRatePlanId ? restrictions : change;
      if (Object.keys(body).length === 0) continue;
      changes.push({
        ratePlanId: plan.id,
        from,
        to: addDays(to, 1),
        ...(days.length === 7 ? {} : { daysOfWeek: days }),
        change: body,
      });
    }
    onAdd(changes);
    onClose();
  };

  const tri = (label: string, value: Tri, set: (v: Tri) => void) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-ink">{label}</span>
      <Segmented
        label={label}
        size="sm"
        value={value}
        onChange={set}
        options={[
          { value: 'keep', label: 'No change' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Update rates and restrictions"
      description="Applies to every chosen day in the range. It joins the changes waiting on the rates screen: nothing is sent until you save them."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="bulk-form"
            variant="primary"
            disabled={
              !hasChange ||
              invalidRate ||
              selected.length === 0 ||
              days.length === 0 ||
              !isValidDate(from) ||
              !isValidDate(to) ||
              to < from
            }
          >
            Add to changes
          </Button>
        </>
      }
    >
      <form id="bulk-form" onSubmit={submit} className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">Rate plans</legend>
          <div className="scrollbar-thin flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-md border border-line p-2.5">
            {plans.map(({ plan, type }) => (
              <Checkbox
                key={plan.id}
                label={
                  <span>
                    {type.name} <span className="text-ink-faint">·</span> {plan.name}
                  </span>
                }
                checked={selected.includes(plan.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, plan.id]
                      : selected.filter((id) => id !== plan.id),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="To (inclusive)">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            )}
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">Days of the week</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => {
              const on = days.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setDays(on ? days.filter((x) => x !== d.value) : [...days, d.value])
                  }
                  className={cn(
                    'h-8 w-12 rounded-md border text-[13px] font-medium transition-colors',
                    on
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-line-strong bg-surface text-ink-soft hover:bg-sunken',
                  )}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <Field
          label={`Rate per night (${currency})`}
          optional
          hint="Leave empty to keep current rates."
          error={invalidRate ? 'Enter an amount of zero or more.' : undefined}
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum stay (nights)" optional>
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
          <Field label="Maximum stay (nights)" optional hint="0 removes the limit.">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={0}
                max={365}
                value={maxStay}
                onChange={(e) => setMaxStay(e.target.value)}
              />
            )}
          </Field>
        </div>
        {derivedSelected.length > 0 && change.rate !== undefined && (
          <Notice tone="info">
            {derivedSelected.map((p) => p.plan.name).join(', ')}{' '}
            {derivedSelected.length === 1 ? 'follows' : 'follow'} another plan&apos;s price, so the
            rate is not applied there. Restrictions are.
          </Notice>
        )}
        <div className="flex flex-col gap-2.5 rounded-md border border-line p-3">
          {tri('Stop sell', stopSell, setStopSell)}
          {tri('Closed to arrival', cta, setCta)}
          {tri('Closed to departure', ctd, setCtd)}
        </div>
      </form>
    </Dialog>
  );
}
