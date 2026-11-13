'use client';

import { ChevronLeft, ChevronRight, Link2, SlidersHorizontal, Tags } from 'lucide-react';
import { Fragment, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import useSWR from 'swr';
import { addDays, dayOfWeek, eachDate, isValidDate, todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Segmented, Select } from '@/components/ui/field';
import {
  EmptyState,
  ErrorState,
  Notice,
  PageLoading,
  Popover,
  Tooltip,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import {
  formatAmount,
  formatMonth,
  formatWeekday,
  formatWeekdayName,
  fromMinor,
  plural,
  toMinor,
} from '@/lib/format';
import { useCurrentProperty, usePropertyDetail, useStoredState } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Availability, PropertyDetail, RateDay, RatePlan } from '@/lib/types';

const CELL = 58;
const LABEL = 220;
const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

interface RateChangeBody {
  rate?: number | null;
  minStayArrival?: number | null;
  minStayThrough?: number | null;
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

/** One editable rate cell. Enter saves and moves right; Escape cancels; clearing the field removes the override. */
function RateCell({
  day,
  currency,
  editable,
  onSave,
}: {
  day: RateDay;
  currency: string;
  editable: boolean;
  onSave: (rate: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);

  const commit = async (moveNext: boolean, element: HTMLInputElement) => {
    if (cancelled.current) return;
    const text = value.trim();
    const next = text === '' ? null : toMinor(Number(text), currency);
    setEditing(false);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return;
    const unchanged = next === null ? !day.rateOverridden : next === day.rate && day.rateOverridden;
    if (!unchanged) {
      setSaving(true);
      try {
        await onSave(next);
      } finally {
        setSaving(false);
      }
    }
    if (moveNext) {
      const cell = element.closest('[data-rate-cell]')?.nextElementSibling;
      (cell?.querySelector('button') as HTMLButtonElement | null)?.click();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit(true, e.currentTarget);
    } else if (e.key === 'Escape') {
      cancelled.current = true;
      setEditing(false);
    }
  };

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
          onBlur={(e) => void commit(false, e.currentTarget)}
          onFocus={(e) => e.currentTarget.select()}
          className="tabular h-8 w-full bg-brand-50 px-1 text-center text-[13px] outline-2 -outline-offset-2 outline-brand-500"
        />
      ) : (
        <button
          type="button"
          disabled={!editable}
          title={day.rateOverridden ? 'Set for this day' : 'Plan default'}
          aria-label={`Rate on ${day.date}: ${formatAmount(day.rate, currency)}`}
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
            saving && 'animate-pulse',
          )}
        >
          {formatAmount(day.rate, currency)}
        </button>
      )}
    </div>
  );
}

/** Restrictions for one day, edited in a popover. */
function RestrictionCell({
  day,
  planMinStay,
  editable,
  onSave,
}: {
  day: RateDay;
  planMinStay: number;
  editable: boolean;
  onSave: (change: RateChangeBody) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [minStay, setMinStay] = useState('');
  const [stopSell, setStopSell] = useState(false);
  const [cta, setCta] = useState(false);
  const [ctd, setCtd] = useState(false);
  const [busy, setBusy] = useState(false);

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
  ].filter(Boolean) as { text: string; tone: string; title: string }[];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const nights = minStay.trim() === '' ? null : Math.max(1, Math.round(Number(minStay)));
    try {
      await onSave({
        // The plan default needs no override: store null so the day follows the plan again.
        minStayArrival: nights === planMinStay ? null : nights,
        minStayThrough: nights === planMinStay ? null : nights,
        stopSell,
        closedToArrival: cta,
        closedToDeparture: ctd,
      });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const trigger = (
    <button
      type="button"
      disabled={!editable}
      aria-label={`Restrictions on ${day.date}${flags.length ? `: ${flags.map((f) => f.title).join(', ')}` : ': none'}`}
      className={cn(
        'flex h-7 w-full items-center justify-center gap-0.5 px-0.5',
        editable ? 'hover:bg-brand-50' : 'cursor-default',
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
            <Field label="Minimum stay (nights)">
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
              <Button size="sm" type="submit" variant="primary" loading={busy}>
                Save
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

function BulkDialog({
  detail,
  defaultFrom,
  onClose,
  onSaved,
}: {
  detail: PropertyDetail;
  defaultFrom: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
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
  const [stopSell, setStopSell] = useState<'keep' | 'on' | 'off'>('keep');
  const [cta, setCta] = useState<'keep' | 'on' | 'off'>('keep');
  const [ctd, setCtd] = useState<'keep' | 'on' | 'off'>('keep');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change: RateChangeBody = {};
  if (rate.trim() !== '') change.rate = toMinor(Number(rate), currency);
  if (minStay.trim() !== '') {
    change.minStayArrival = Math.max(1, Math.round(Number(minStay)));
    change.minStayThrough = change.minStayArrival;
  }
  if (stopSell !== 'keep') change.stopSell = stopSell === 'on';
  if (cta !== 'keep') change.closedToArrival = cta === 'on';
  if (ctd !== 'keep') change.closedToDeparture = ctd === 'on';
  const hasChange = Object.keys(change).length > 0;
  const derivedSelected = plans.filter(
    (p) => selected.includes(p.plan.id) && p.plan.parentRatePlanId,
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let total = 0;
      for (const { plan } of plans.filter((p) => selected.includes(p.plan.id))) {
        // A derived plan follows its parent's price, so only its restrictions are sent.
        const { rate: _rate, ...restrictions } = change;
        const body = plan.parentRatePlanId ? restrictions : change;
        if (Object.keys(body).length === 0) continue;
        const result = await api<{ daysChanged: number }>(
          `/properties/${detail.property.id}/rates`,
          {
            body: {
              ratePlanId: plan.id,
              from,
              to: addDays(to, 1),
              daysOfWeek: days.length === 7 ? undefined : days,
              change: body,
            },
          },
        );
        total += result.daysChanged;
      }
      toast.success(
        total === 0 ? 'Nothing needed changing' : `${plural(total, 'day')} updated`,
        'Connected channels are being updated.',
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const tri = (
    label: string,
    value: 'keep' | 'on' | 'off',
    set: (v: 'keep' | 'on' | 'off') => void,
  ) => (
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
      description="Applies to every chosen day in the range. Channels are updated straight away."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="bulk-form"
            variant="primary"
            loading={busy}
            disabled={
              !hasChange ||
              selected.length === 0 ||
              days.length === 0 ||
              !isValidDate(from) ||
              !isValidDate(to) ||
              to < from
            }
          >
            Apply
          </Button>
        </>
      }
    >
      <form id="bulk-form" onSubmit={submit} className="flex flex-col gap-4">
        {error && <Notice tone="danger">{error}</Notice>}
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
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={`Rate per night (${currency})`}
            optional
            hint="Leave empty to keep current rates."
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

export function RatesView() {
  const auth = useAuth();
  const toast = useToast();
  const { property, properties, select, isLoading: propertiesLoading } = useCurrentProperty();
  const [span, setSpan] = useStoredState<'14' | '31'>('pms.rates.span', '14');
  const today = useMemo(() => todayIn(property?.timezone ?? 'Asia/Kolkata'), [property?.timezone]);
  const [start, setStart] = useState<string | null>(null);
  const from = start ?? today;
  const to = addDays(from, Number(span));
  const dates = useMemo(() => eachDate(from, to), [from, to]);
  const [bulk, setBulk] = useState(false);

  const { data: detail, error: detailError } = usePropertyDetail(property?.id);
  const ratesKey = property ? `/properties/${property.id}/rates${query({ from, to })}` : null;
  const availabilityKey = property
    ? `/properties/${property.id}/availability${query({ from, to })}`
    : null;
  const {
    data: rates,
    error: ratesError,
    mutate: mutateRates,
  } = useSWR<{ days: RateDay[] }>(ratesKey);
  const { data: availability, mutate: mutateAvailability } = useSWR<{ days: Availability[] }>(
    availabilityKey,
  );

  useLive(/^rates\.|^ari\.availability$/, (events) => {
    if (!events.some((e) => e.kind === 'resync' || e.propertyId === property?.id)) return;
    void mutateRates();
    void mutateAvailability();
  });

  const rateByKey = useMemo(
    () => new Map((rates?.days ?? []).map((d) => [`${d.ratePlanId}|${d.date}`, d])),
    [rates],
  );
  const availabilityByKey = useMemo(
    () => new Map((availability?.days ?? []).map((d) => [`${d.roomTypeId}|${d.date}`, d])),
    [availability],
  );

  if (propertiesLoading) return <PageLoading />;
  if (!property) {
    return (
      <EmptyState
        icon={<Tags className="size-5" />}
        title="No properties yet"
        description="Add a property under Settings first."
      />
    );
  }
  const canEdit = auth.can('rates.write', property.id);
  const currency = property.currency;

  const save = async (plan: RatePlan, date: string, change: RateChangeBody) => {
    try {
      await api(`/properties/${property.id}/rates`, {
        body: { ratePlanId: plan.id, from: date, to: addDays(date, 1), change },
      });
      await mutateRates();
    } catch (err) {
      toast.error(err);
    }
  };

  const months: { key: string; label: string; days: number }[] = [];
  for (const date of dates) {
    const last = months[months.length - 1];
    if (last && last.key === date.slice(0, 7)) last.days++;
    else months.push({ key: date.slice(0, 7), label: formatMonth(date), days: 1 });
  }
  const planName = (id: string | null) =>
    detail?.roomTypes.flatMap((t) => t.ratePlans).find((p) => p.id === id)?.name ?? 'another plan';

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {properties.length > 1 && (
          <Select
            aria-label="Property"
            value={property.id}
            onChange={(e) => select(e.target.value)}
            className="h-8 w-auto"
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <div className="flex items-center">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Earlier"
            onClick={() => setStart(addDays(from, -7))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="sm" onClick={() => setStart(today)}>
            Today
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Later"
            onClick={() => setStart(addDays(from, 7))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <Input
          type="date"
          aria-label="Go to date"
          value={from}
          onChange={(e) => e.target.value && setStart(e.target.value)}
          className="h-8 w-36"
        />
        <Segmented
          label="Days shown"
          size="sm"
          value={span}
          onChange={setSpan}
          options={[
            { value: '14', label: '2 weeks' },
            { value: '31', label: 'Month' },
          ]}
        />
        {canEdit && detail && (
          <Button
            size="sm"
            variant="primary"
            className="ml-auto"
            icon={<SlidersHorizontal className="size-3.5" />}
            onClick={() => setBulk(true)}
          >
            Bulk update
          </Button>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-surface">
        {detailError || ratesError ? (
          <ErrorState error={detailError ?? ratesError} onRetry={() => void mutateRates()} />
        ) : !detail || !rates ? (
          <PageLoading label="Loading rates" />
        ) : detail.roomTypes.every((t) => t.ratePlans.length === 0) ? (
          <EmptyState
            icon={<Tags className="size-5" />}
            title="No rate plans yet"
            description="Add a rate plan to each room type under Settings to start pricing."
          />
        ) : (
          <div className="w-max min-w-full" role="grid" aria-label="Rates and restrictions">
            <div className="sticky top-0 z-30 flex border-b border-line-strong bg-surface">
              <div
                className="sticky left-0 z-10 shrink-0 border-r border-line-strong bg-surface"
                style={{ width: LABEL }}
              />
              <div>
                <div className="flex h-6 border-b border-line">
                  {months.map((m) => (
                    <div
                      key={m.key}
                      className="border-r border-line px-2 text-xs leading-6 font-semibold text-ink-soft"
                      style={{ width: m.days * CELL }}
                    >
                      {m.days * CELL > 80 ? m.label : ''}
                    </div>
                  ))}
                </div>
                <div className="flex h-9">
                  {dates.map((date) => {
                    const dow = dayOfWeek(date);
                    return (
                      <div
                        key={date}
                        className={cn(
                          'flex shrink-0 flex-col items-center justify-center border-r border-line text-[10px] leading-none text-ink-faint',
                          (dow === 0 || dow === 6) && 'bg-sunken',
                        )}
                        style={{ width: CELL }}
                      >
                        <span className="uppercase">{formatWeekdayName(date)}</span>
                        <span
                          className={cn(
                            'tabular mt-0.5 flex size-5 items-center justify-center rounded-full text-xs font-semibold',
                            date === today ? 'bg-brand-600 text-white' : 'text-ink',
                          )}
                        >
                          {Number(date.slice(8))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {detail.roomTypes
              .filter((t) => t.active)
              .map((type) => (
                <Fragment key={type.id}>
                  <div className="flex border-b border-line bg-sunken/80">
                    <div
                      className="sticky left-0 z-20 flex shrink-0 items-center border-r border-line-strong bg-sunken px-3"
                      style={{ width: LABEL }}
                    >
                      <span className="truncate text-[13px] font-semibold text-ink">
                        {type.name}
                      </span>
                      <span className="ml-auto text-[11px] text-ink-faint">rooms left</span>
                    </div>
                    {dates.map((date) => {
                      const a = availabilityByKey.get(`${type.id}|${date}`);
                      return (
                        <div
                          key={date}
                          className={cn(
                            'tabular flex h-8 shrink-0 items-center justify-center border-r border-line text-[13px] font-semibold',
                            !a
                              ? 'text-ink-faint'
                              : a.available <= 0
                                ? 'bg-danger-50 text-danger-700'
                                : 'text-ink',
                          )}
                          style={{ width: CELL }}
                        >
                          {a ? a.available : ''}
                        </div>
                      );
                    })}
                  </div>
                  {type.ratePlans
                    .filter((p) => p.active)
                    .map((plan) => {
                      const derived = plan.parentRatePlanId !== null;
                      return (
                        <Fragment key={plan.id}>
                          <div className="flex border-b border-line">
                            <div
                              className="sticky left-0 z-20 flex shrink-0 items-center gap-1.5 border-r border-line-strong bg-surface pr-2 pl-6"
                              style={{ width: LABEL }}
                            >
                              <span className="truncate text-[13px] text-ink">{plan.name}</span>
                              {derived && (
                                <Tooltip
                                  content={`Follows ${planName(plan.parentRatePlanId)}${
                                    plan.derivedPercentBp
                                      ? ` ${plan.derivedPercentBp > 0 ? '+' : ''}${plan.derivedPercentBp / 100}%`
                                      : ''
                                  }`}
                                >
                                  <Link2
                                    className="size-3.5 shrink-0 text-ink-faint"
                                    aria-label="Derived rate plan"
                                  />
                                </Tooltip>
                              )}
                              <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
                                {currency}
                              </span>
                            </div>
                            {dates.map((date) => {
                              const day = rateByKey.get(`${plan.id}|${date}`);
                              return day ? (
                                <RateCell
                                  key={date}
                                  day={day}
                                  currency={currency}
                                  editable={canEdit && !derived}
                                  onSave={(rate) => save(plan, date, { rate })}
                                />
                              ) : (
                                <div
                                  key={date}
                                  className="shrink-0 border-r border-line"
                                  style={{ width: CELL }}
                                />
                              );
                            })}
                          </div>
                          <div className="flex border-b border-line">
                            <div
                              className="sticky left-0 z-20 flex shrink-0 items-center border-r border-line-strong bg-surface pl-6 text-[11px] text-ink-faint"
                              style={{ width: LABEL }}
                            >
                              Restrictions
                            </div>
                            {dates.map((date) => {
                              const day = rateByKey.get(`${plan.id}|${date}`);
                              return day ? (
                                <RestrictionCell
                                  key={date}
                                  day={day}
                                  planMinStay={plan.minStay}
                                  editable={canEdit}
                                  onSave={(change) => save(plan, date, change)}
                                />
                              ) : (
                                <div
                                  key={date}
                                  className="shrink-0 border-r border-line"
                                  style={{ width: CELL }}
                                />
                              );
                            })}
                          </div>
                        </Fragment>
                      );
                    })}
                </Fragment>
              ))}
          </div>
        )}
      </div>

      {bulk && detail && (
        <BulkDialog
          detail={detail}
          defaultFrom={from}
          onClose={() => setBulk(false)}
          onSaved={() => {
            void mutateRates();
          }}
        />
      )}
    </div>
  );
}
