'use client';

import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { plural } from '@/lib/format';
import type { PropertyDetail } from '@/lib/types';

/**
 * Ticks the rates a promotional code is limited to, out of those sold on the website at the
 * given properties. A rate that was chosen earlier and is no longer sold stays listed, so that
 * it is seen and can be unticked.
 */
export function RatePlanPicker({
  propertyIds,
  selected,
  onChange,
}: {
  propertyIds: string[];
  selected: string[];
  onChange: (ratePlanIds: string[]) => void;
}) {
  const { data, error, mutate } = useSWR<PropertyDetail[]>(
    propertyIds.length > 0 ? ['promo-rate-plans', ...propertyIds] : null,
    () => Promise.all(propertyIds.map((id) => api<PropertyDetail>(`/properties/${id}`))),
  );

  if (error && !data) {
    return (
      <Notice tone="danger" title="The rates could not be loaded">
        <p>{errorMessage(error)}</p>
        <Button size="sm" className="mt-2" onClick={() => void mutate()}>
          Try again
        </Button>
      </Notice>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-faint">
        <Spinner /> Loading the rates…
      </div>
    );
  }

  const groups = data.map((detail) => ({
    property: detail.property,
    plans: detail.roomTypes.flatMap((roomType) =>
      roomType.ratePlans
        .map((plan) => ({
          plan,
          roomType,
          sold: roomType.active && plan.active && plan.publicBookable,
        }))
        .filter(({ plan, sold }) => sold || selected.includes(plan.id)),
    ),
  }));
  const listed = new Set(groups.flatMap((group) => group.plans.map(({ plan }) => plan.id)));
  const unlisted = selected.filter((id) => !listed.has(id));

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-sunken p-3">
      {groups.map(({ property, plans }) => (
        <div key={property.id} role="group" aria-label={`Rates at ${property.name}`}>
          {groups.length > 1 && (
            <p className="mb-1.5 text-xs font-semibold text-ink-soft">{property.name}</p>
          )}
          {plans.length === 0 ? (
            <p className="text-[13px] text-ink-faint">No rate is sold on the website here.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {plans.map(({ plan, roomType, sold }) => (
                <Checkbox
                  key={plan.id}
                  label={
                    <span>
                      {roomType.name}: {plan.name}
                      {!sold && <span className="text-ink-faint"> (not sold on the website)</span>}
                    </span>
                  }
                  checked={selected.includes(plan.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, plan.id]
                        : selected.filter((id) => id !== plan.id),
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      ))}
      {unlisted.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-soft">
          <span>
            {plural(unlisted.length, 'chosen rate')} {unlisted.length === 1 ? 'is' : 'are'} not at{' '}
            {propertyIds.length === 1 ? 'this property' : 'these properties'} any more.
          </span>
          <Button size="sm" onClick={() => onChange(selected.filter((id) => listed.has(id)))}>
            Remove {unlisted.length === 1 ? 'it' : 'them'}
          </Button>
        </div>
      )}
    </div>
  );
}
