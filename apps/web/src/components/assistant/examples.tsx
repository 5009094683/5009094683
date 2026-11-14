'use client';

import { useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { fromMinor } from '@/lib/format';
import { useCurrentProperty, usePropertyDetail } from '@/lib/hooks';
import type { Permission } from '@/lib/types';

const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function ahead(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dayMonth.format(date);
}

/**
 * Requests the assistant understands even without an AI service (see `HELP` in
 * `packages/ai/src/copilot/rules.ts`), written with this person's own property, rooms and
 * near dates, and only for things their role may do.
 */
export function useExamples(): string[] {
  const auth = useAuth();
  const { property: current, properties } = useCurrentProperty();
  const property = current?.active ? current : properties.find((p) => p.active);
  const { data: detail } = usePropertyDetail(property?.id);

  return useMemo(() => {
    if (!property) return [];
    const examples: string[] = [];
    const place = property.name;
    const can = (permission: Permission) => auth.can(permission, property.id);
    const roomTypes =
      detail?.property.id === property.id ? detail.roomTypes.filter((type) => type.active) : [];

    if (can('reservations.read')) {
      examples.push(`arrivals today at ${place}`);
      examples.push(`availability ${ahead(14)} to ${ahead(17)} at ${place}`);
    }
    if (can('reports.read')) {
      examples.push(`occupancy ${ahead(7)} to ${ahead(14)} at ${place}`);
    }
    if (can('blocks.write')) {
      const units = roomTypes.flatMap((type) => type.units.filter((unit) => unit.active));
      const unit = units[0];
      if (unit) {
        // A property with one unit, a villa, is blocked by its own name.
        const what = units.length === 1 || unit.name === place ? place : `${unit.name} at ${place}`;
        examples.push(`block ${what} from ${ahead(21)} to ${ahead(24)} for maintenance`);
      }
    }
    if (can('rates.write')) {
      for (const type of roomTypes) {
        const plan = type.ratePlans.find(
          (p) => p.active && p.isDefault && !p.parentRatePlanId && p.baseRate > 0,
        );
        if (!plan) continue;
        const rate = Math.round((fromMinor(plan.baseRate, plan.currency) * 1.1) / 100) * 100;
        examples.push(
          `set rate of ${type.name} to ${rate} from ${ahead(28)} to ${ahead(31)} at ${place}`,
        );
        break;
      }
    }
    if (can('housekeeping.read')) examples.push(`housekeeping at ${place}`);
    return examples;
  }, [auth, property, detail]);
}

/** Example requests as chips. Choosing one fills the input for the person to adjust and send. */
export function ExampleChips({
  examples,
  onPick,
}: {
  examples: string[];
  onPick: (text: string) => void;
}) {
  if (examples.length === 0) return null;
  return (
    <ul aria-label="Example requests" className="flex flex-wrap gap-1.5">
      {examples.map((example) => (
        <li key={example}>
          <button
            type="button"
            onClick={() => onPick(example)}
            className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-left text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
          >
            {example}
          </button>
        </li>
      ))}
    </ul>
  );
}
