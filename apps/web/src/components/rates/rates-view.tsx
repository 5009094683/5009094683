'use client';

import { ChevronLeft, ChevronRight, Link2, SlidersHorizontal, Tags } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import useSWR from 'swr';
import { addDays, dayOfWeek, eachDate, todayIn } from '@pms/domain/shared';
import { RateSuggestions } from '@/components/pricing/rate-suggestions';
import { Button } from '@/components/ui/button';
import { Input, Segmented, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, PageLoading, Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatMonth, formatWeekdayName, plural } from '@/lib/format';
import { useCurrentProperty, usePropertyDetail, useStoredState } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Availability, RateDay, RatePlan } from '@/lib/types';
import { BulkDialog } from './bulk-dialog';
import {
  addChanges,
  batchBody,
  parentRatePending,
  withPending,
  type NewChange,
  type RateChangeBody,
} from './pending';
import { PendingBar, type PlanName } from './pending-bar';
import { CELL, RateCell, RestrictionCell } from './rate-cells';
import { usePendingChanges } from './use-pending';

const LABEL = 220;

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
  // Changes are held here and saved together, so the booking sites are told once.
  const [pending, setPending] = usePendingChanges(property?.id);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const hold = (changes: NewChange[]) => {
    setSaveError(null);
    setPending(addChanges(pending, changes));
  };
  const holdDay = (plan: RatePlan, date: string, change: RateChangeBody) =>
    hold([{ ratePlanId: plan.id, from: date, to: addDays(date, 1), change }]);

  const saveAll = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api<{ daysChanged: number }>(`/properties/${property.id}/rates/batch`, {
        body: batchBody(pending),
      });
      setPending([]);
      toast.success(
        result.daysChanged === 0
          ? 'Nothing needed changing'
          : `${plural(result.daysChanged, 'day')} updated`,
        result.daysChanged === 0 ? undefined : 'The booking sites are being updated.',
      );
      await mutateRates();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const plansById = new Map<string, PlanName>(
    (detail?.roomTypes ?? []).flatMap((type) =>
      type.ratePlans.map((plan) => [plan.id, { plan, typeName: type.name }] as const),
    ),
  );

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
        <RateSuggestions property={property} detail={detail} />
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
                                  day={withPending(day, plan, pending)}
                                  currency={currency}
                                  editable={canEdit && !derived}
                                  follows={
                                    parentRatePending(plan, date, pending)
                                      ? planName(plan.parentRatePlanId)
                                      : null
                                  }
                                  onChange={(rate) => holdDay(plan, date, { rate })}
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
                                  day={withPending(day, plan, pending)}
                                  plan={plan}
                                  editable={canEdit}
                                  onChange={(change) => holdDay(plan, date, change)}
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

      {canEdit && (
        <PendingBar
          pending={pending}
          plans={plansById}
          currency={currency}
          saving={saving}
          error={saveError}
          onRemove={(id) => {
            setSaveError(null);
            setPending(pending.filter((change) => change.id !== id));
          }}
          onDiscard={() => {
            setSaveError(null);
            setPending([]);
          }}
          onSave={() => void saveAll()}
        />
      )}

      {bulk && detail && (
        <BulkDialog
          detail={detail}
          defaultFrom={from}
          onClose={() => setBulk(false)}
          onAdd={hold}
        />
      )}
    </div>
  );
}
