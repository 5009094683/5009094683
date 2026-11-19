'use client';

import { Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { useSWRConfig } from 'swr';
import { changedFields } from '@/components/settings/form-values';
import { Button } from '@/components/ui/button';
import { Field, Input, Switch } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatMoney, fromMinor, toMinor } from '@/lib/format';
import type { Property, PropertyDetail } from '@/lib/types';
import { PRICING_DEFAULTS, type PricingEvent, type PricingSettings } from './types';

interface EventValues {
  key: number;
  name: string;
  from: string;
  to: string;
  uplift: string;
}

interface Values {
  autopilot: string[];
  maxChange: string;
  rounding: string;
  events: EventValues[];
}

function valuesFrom(settings: PricingSettings, currency: string): Values {
  return {
    autopilot: settings.pricingAutopilotRoomTypes ?? [],
    maxChange: String(settings.pricingMaxChangePercent ?? PRICING_DEFAULTS.maxChangePercent),
    rounding: String(fromMinor(settings.pricingRounding ?? PRICING_DEFAULTS.rounding, currency)),
    events: (settings.pricingEvents ?? []).map((event, key) => ({
      key,
      name: event.name,
      from: event.from,
      to: event.to,
      uplift: String(event.upliftPercent ?? PRICING_DEFAULTS.eventUpliftPercent),
    })),
  };
}

function settingsFrom(values: Values, currency: string): Required<PricingSettings> {
  return {
    pricingAutopilotRoomTypes: values.autopilot,
    pricingMaxChangePercent: Number(values.maxChange),
    pricingRounding: toMinor(Number(values.rounding), currency),
    pricingEvents: values.events.map((event): PricingEvent => ({
      name: event.name.trim(),
      from: event.from,
      to: event.to,
      upliftPercent: Number(event.uplift),
    })),
  };
}

const isWhole = (text: string, min: number, max: number): boolean => {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max;
};

type Errors = Partial<Record<'maxChange' | 'rounding', string>> & {
  events: Record<number, string>;
};

function validate(values: Values): Errors {
  const errors: Errors = { events: {} };
  if (!isWhole(values.maxChange, 1, 100)) {
    errors.maxChange = 'Enter a whole number from 1 to 100.';
  }
  if (values.rounding.trim() === '' || !(Number(values.rounding) > 0)) {
    errors.rounding = 'Enter an amount above zero.';
  }
  for (const event of values.events) {
    if (!event.name.trim()) errors.events[event.key] = 'Give these dates a name.';
    else if (!event.from || !event.to) errors.events[event.key] = 'Choose the first and last day.';
    else if (event.to < event.from) {
      errors.events[event.key] = 'The last day is before the first day.';
    } else if (!isWhole(event.uplift, 1, 100)) {
      errors.events[event.key] = 'Enter the uplift as a whole number from 1 to 100.';
    }
  }
  return errors;
}

const hasErrors = (errors: Errors): boolean =>
  Boolean(errors.maxChange || errors.rounding || Object.keys(errors.events).length > 0);

/** Whether two JSON values say the same. The database returns an object's keys in its own order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => sameJson(left[key], right[key]))
    );
  }
  return a === b;
}

interface Fence {
  /** Suggestions are made only for active plans that carry their own rate. */
  priced: PropertyDetail['roomTypes'][number]['ratePlans'];
  fenced: PropertyDetail['roomTypes'][number]['ratePlans'];
  open: PropertyDetail['roomTypes'][number]['ratePlans'];
}

function fenceOf(roomType: PropertyDetail['roomTypes'][number]): Fence {
  const priced = roomType.ratePlans.filter(
    (plan) => plan.active && !plan.parentRatePlanId && plan.baseRate > 0,
  );
  const fenced = priced.filter((plan) => plan.floorRate !== null && plan.ceilingRate !== null);
  return { priced, fenced, open: priced.filter((plan) => !fenced.includes(plan)) };
}

const missing = (plan: Fence['priced'][number]): string =>
  plan.floorRate === null && plan.ceilingRate === null
    ? 'no floor and no ceiling'
    : plan.floorRate === null
      ? 'no floor'
      : 'no ceiling';

/**
 * How suggestions are made for a property, and the few things its managers decide: which room
 * types may be repriced without waiting for a person, how far a suggestion may go, and the
 * dates that sell unusually well.
 */
export function PricingSettingsForm({
  property,
  detail,
  onClose,
}: {
  property: Property;
  detail: PropertyDetail;
  onClose: () => void;
}) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const headingId = useId();
  const currency = property.currency;
  const [initial] = useState(() => valuesFrom(detail.property.settings, currency));
  const [values, setValues] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextKey, setNextKey] = useState(initial.events.length);
  const errors = submitted ? validate(values) : { events: {} };
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));
  const changeEvent = (key: number, patch: Partial<EventValues>) =>
    change({
      events: values.events.map((event) => (event.key === key ? { ...event, ...patch } : event)),
    });
  const roomTypes = detail.roomTypes.filter((type) => type.active);
  const settingsHref = `/settings/properties/${property.id}`;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (hasErrors(validate(values))) return;
    const changes = changedFields(settingsFrom(initial, currency), settingsFrom(values, currency));
    const keys = Object.keys(changes) as (keyof PricingSettings)[];
    if (keys.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      // The server merges `settings` key by key, so only what changed is sent.
      const saved = await api<Property>(`/properties/${property.id}`, {
        method: 'PATCH',
        body: { settings: changes },
      });
      const kept = keys.every((key) => sameJson(saved.settings[key], changes[key]));
      if (!kept) {
        // A server that does not know these settings answers "saved" and drops them.
        setError(
          'Could not save. The server took the request but did not keep these settings, so nothing has changed. Tell whoever looks after the system.',
        );
        return;
      }
      await Promise.all([mutate('/properties'), mutate(`/properties/${property.id}`)]);
      toast.success(
        'Suggestion settings saved',
        'They apply from the next time suggestions are worked out.',
      );
      onClose();
    } catch (err) {
      setError(`Could not save. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-line p-4">
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        How suggestions work
      </h3>
      <div className="mt-1.5 flex flex-col gap-1.5 text-[13px] text-ink-soft">
        <p>
          Once a night, and whenever someone asks, each coming night is compared with how nights
          like it usually sell at this property. A night that is filling faster than usual gets a
          higher suggested rate, a slow one a lower rate. Each suggestion lists its reasons, with
          what each does to the base rate of the rate plan.
        </p>
        <p>
          A suggestion never leaves the floor and ceiling of its rate plan, and one that is within
          3% of the current rate is not made. Suggestions wait for someone to apply them, except for
          room types on autopilot.
        </p>
      </div>

      <form onSubmit={save} noValidate className="mt-4 flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2.5">
          <legend className="text-[13px] font-medium text-ink">Autopilot</legend>
          <p className="text-[13px] text-ink-soft">
            On autopilot, suggested rates for a room type are applied as soon as they are worked
            out, without waiting for a person, and go to the booking sites. That is allowed only for
            a rate plan with both a floor and a ceiling, which are set on the rate plan under{' '}
            <Link href={settingsHref} className="font-medium text-brand-700 hover:underline">
              Settings
            </Link>
            .
          </p>
          {roomTypes.length === 0 ? (
            <p className="text-[13px] text-ink-faint">This property has no room types yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {roomTypes.map((roomType) => {
                const fence = fenceOf(roomType);
                const on = values.autopilot.includes(roomType.id);
                const possible = fence.fenced.length > 0;
                return (
                  <li key={roomType.id} className="flex items-start justify-between gap-4 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{roomType.name}</p>
                      {fence.priced.length === 0 ? (
                        <p className="mt-0.5 text-[13px] text-ink-faint">
                          Cannot go on autopilot: it has no active rate plan with a rate of its own,
                          so no suggestions are made for it.
                        </p>
                      ) : (
                        <>
                          {fence.fenced.map((plan) => (
                            <p key={plan.id} className="mt-0.5 text-[13px] text-ink-soft">
                              {plan.name}: kept between {formatMoney(plan.floorRate ?? 0, currency)}{' '}
                              and {formatMoney(plan.ceilingRate ?? 0, currency)}.
                            </p>
                          ))}
                          {fence.open.map((plan) => (
                            <p key={plan.id} className="mt-0.5 text-[13px] text-warning-700">
                              {possible
                                ? `${plan.name} has ${missing(plan)}, so its suggestions always wait for a person.`
                                : `Cannot go on autopilot: ${plan.name} has ${missing(plan)}.`}
                            </p>
                          ))}
                          {on && !possible && (
                            <p className="mt-0.5 text-[13px] text-warning-700">
                              Autopilot is on but applies nothing until a floor and a ceiling are
                              set.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <Switch
                      label={`Autopilot for ${roomType.name}`}
                      checked={on}
                      // Stays switchable while on, so a room type that lost its fence can be taken off.
                      disabled={!possible && !on}
                      onChange={(checked) =>
                        change({
                          autopilot: checked
                            ? [...values.autopilot, roomType.id]
                            : values.autopilot.filter((id) => id !== roomType.id),
                        })
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Largest change (%)"
            hint={`How far a suggested rate may be from the base rate of its plan. ${PRICING_DEFAULTS.maxChangePercent}% unless changed.`}
            error={errors.maxChange}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                value={values.maxChange}
                onChange={(e) => change({ maxChange: e.target.value })}
              />
            )}
          </Field>
          <Field
            label={`Round to (${currency})`}
            hint={`Suggested rates are a multiple of this. ${formatMoney(PRICING_DEFAULTS.rounding, currency)} unless changed.`}
            error={errors.rounding}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={values.rounding}
                onChange={(e) => change({ rounding: e.target.value })}
              />
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="text-[13px] font-medium text-ink">Special dates</legend>
          <p className="text-[13px] text-ink-soft">
            Festivals, long weekends and local events sell better than their weekday suggests. Name
            the dates and say by how much the rate should go up on them.
          </p>
          {values.events.map((entry) => (
            <div
              key={entry.key}
              role="group"
              aria-label={entry.name.trim() || 'New special dates'}
              className="flex flex-col gap-2 rounded-md border border-line p-3"
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_5.5rem]">
                <Field label="Name" className="col-span-2 sm:col-span-1">
                  {(props) => (
                    <Input
                      {...props}
                      // Only a row the person has just added: it is where they type next.
                      autoFocus={entry.key >= initial.events.length}
                      maxLength={80}
                      value={entry.name}
                      onChange={(e) => changeEvent(entry.key, { name: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="First day">
                  {(props) => (
                    <Input
                      {...props}
                      type="date"
                      value={entry.from}
                      onChange={(e) =>
                        changeEvent(entry.key, {
                          from: e.target.value,
                          to: entry.to && entry.to >= e.target.value ? entry.to : e.target.value,
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Last day">
                  {(props) => (
                    <Input
                      {...props}
                      type="date"
                      min={entry.from || undefined}
                      value={entry.to}
                      onChange={(e) => changeEvent(entry.key, { to: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Uplift (%)">
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      value={entry.uplift}
                      onChange={(e) => changeEvent(entry.key, { uplift: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <div className="flex items-center justify-between gap-3">
                {errors.events[entry.key] ? (
                  <p role="alert" className="text-[13px] text-danger-600">
                    {errors.events[entry.key]}
                  </p>
                ) : (
                  <span />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X className="size-3.5" aria-hidden />}
                  aria-label={`Remove ${entry.name.trim() || 'these dates'}`}
                  onClick={() =>
                    change({ events: values.events.filter((other) => other.key !== entry.key) })
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button
              size="sm"
              icon={<Plus className="size-3.5" aria-hidden />}
              onClick={() => {
                change({
                  events: [
                    ...values.events,
                    {
                      key: nextKey,
                      name: '',
                      from: '',
                      to: '',
                      uplift: String(PRICING_DEFAULTS.eventUpliftPercent),
                    },
                  ],
                });
                setNextKey(nextKey + 1);
              }}
            >
              Add special dates
            </Button>
          </div>
        </fieldset>

        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}
