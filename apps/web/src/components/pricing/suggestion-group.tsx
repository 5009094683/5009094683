'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { Checkbox } from '@/components/ui/field';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatMoney, formatWeekday, plural } from '@/lib/format';
import type { RatePlan } from '@/lib/types';
import { changePercent, effectText, shareText, type SuggestionGroup } from './suggestions';
import type { RateSuggestion, SuggestionConfidence } from './types';

/** Nights shown before "Show all": the near ones are the ones that need a decision first. */
const FIRST_SHOWN = 14;

const CONFIDENCE: Record<
  SuggestionConfidence,
  { label: string; tone: 'info' | 'neutral' | 'warning'; meaning: string }
> = {
  high: {
    label: 'High confidence',
    tone: 'info',
    meaning: 'there is more than six months of booking history of its own to go on',
  },
  medium: {
    label: 'Medium confidence',
    tone: 'neutral',
    meaning: 'there is some booking history, and built-in patterns fill the gaps',
  },
  low: {
    label: 'Low confidence',
    tone: 'warning',
    meaning: 'there is little booking history yet, so built-in patterns did most of the work',
  },
};

/** What a rate plan gives the suggestions to work from: its base rate and the bounds none of them leaves. */
function limits(plan: RatePlan): string {
  const money = (amount: number) => formatMoney(amount, plan.currency);
  const bounds =
    plan.floorRate !== null && plan.ceilingRate !== null
      ? `floor ${money(plan.floorRate)}, ceiling ${money(plan.ceilingRate)}`
      : plan.floorRate !== null
        ? `floor ${money(plan.floorRate)}, no ceiling`
        : plan.ceilingRate !== null
          ? `no floor, ceiling ${money(plan.ceilingRate)}`
          : 'no floor or ceiling';
  return `Base rate ${money(plan.baseRate)}, ${bounds}. The percentage after each reason is what it does to the base rate.`;
}

function reasons(suggestion: RateSuggestion, plan: RatePlan | undefined): string {
  const parts =
    suggestion.drivers.length > 0
      ? suggestion.drivers.map((driver) => `${driver.label} (${effectText(driver.effectBp)})`)
      : ['Demand looks usual for this night, so the usual rate of the plan is suggested'];
  if (plan?.ceilingRate !== null && suggestion.recommendedRate === plan?.ceilingRate) {
    parts.push('held at the ceiling of the rate plan');
  } else if (plan?.floorRate !== null && suggestion.recommendedRate === plan?.floorRate) {
    parts.push('held at the floor of the rate plan');
  }
  return parts.join(', ');
}

function SuggestionRow({
  suggestion,
  plan,
  selected,
  onToggle,
}: {
  suggestion: RateSuggestion;
  plan: RatePlan | undefined;
  /** Undefined when this person may not decide: the row is then for reading only. */
  selected: boolean | undefined;
  onToggle: (selected: boolean) => void;
}) {
  const change = changePercent(suggestion);
  const up = change > 0;
  const confidence = CONFIDENCE[suggestion.confidence];
  const content = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium text-ink">{formatWeekday(suggestion.date)}</span>
        <span className="tabular text-sm text-ink">
          <span className="sr-only">now </span>
          <span className="text-ink-soft">
            {formatMoney(suggestion.currentRate, suggestion.currency)}
          </span>
          <span aria-hidden className="px-1 text-ink-faint">
            &rarr;
          </span>
          <span className="sr-only">, suggested </span>
          <span className="font-semibold">
            {formatMoney(suggestion.recommendedRate, suggestion.currency)}
          </span>
          <span
            className={cn(
              'ml-2 inline-flex items-center gap-0.5 font-medium',
              up ? 'text-success-700' : 'text-warning-700',
            )}
          >
            {up ? (
              <ArrowUp className="size-3.5" aria-hidden />
            ) : (
              <ArrowDown className="size-3.5" aria-hidden />
            )}
            <span className="sr-only">{up ? 'up' : 'down'} </span>
            {Math.abs(change)}%
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px] text-ink-soft">
        <span>
          {shareText(suggestion.occupancyBp)} sold now, likely {shareText(suggestion.forecastBp)} by
          the night
        </span>
        <Badge tone={confidence.tone}>{confidence.label}</Badge>
      </span>
      <span className="text-[13px] text-ink-soft [overflow-wrap:anywhere]">
        {reasons(suggestion, plan)}
      </span>
    </span>
  );
  return (
    <li className="px-3 py-2.5">
      {selected === undefined ? (
        <div className="flex">{content}</div>
      ) : (
        <Checkbox
          checked={selected}
          onChange={(event) => onToggle(event.target.checked)}
          label={content}
          className="flex w-full cursor-pointer items-start gap-3 [&>input]:mt-0.5 [&>input]:shrink-0"
        />
      )}
    </li>
  );
}

/** The suggestions of one rate plan, night by night, with what each would change and why. */
export function SuggestionGroupCard({
  group,
  plan,
  selected,
  onToggle,
}: {
  group: SuggestionGroup;
  plan: RatePlan | undefined;
  /** Undefined when this person may not apply or dismiss suggestions. */
  selected: ReadonlySet<string> | undefined;
  onToggle: (ids: string[], selected: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { suggestions } = group;
  const shown = showAll ? suggestions : suggestions.slice(0, FIRST_SHOWN);
  const ids = suggestions.map((suggestion) => suggestion.id);
  const chosen = selected ? ids.filter((id) => selected.has(id)).length : 0;
  const levels = [...new Set(suggestions.map((suggestion) => suggestion.confidence))];
  const name = (
    <span className="text-sm font-semibold text-ink">
      {group.roomTypeName}
      <span className="font-normal text-ink-soft"> / {group.ratePlanName}</span>
    </span>
  );

  return (
    <section
      aria-label={`${group.roomTypeName}, ${group.ratePlanName}`}
      className="overflow-hidden rounded-lg border border-line"
    >
      <div className="flex flex-col gap-1 border-b border-line bg-sunken px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {selected ? (
            <Checkbox
              checked={chosen === ids.length}
              onChange={(event) => onToggle(ids, event.target.checked)}
              label={name}
              className="cursor-pointer gap-3"
            />
          ) : (
            name
          )}
          <span className="text-xs text-ink-soft">
            {selected && chosen > 0
              ? `${chosen} of ${plural(ids.length, 'night')} selected`
              : plural(ids.length, 'night')}
          </span>
        </div>
        <p className="text-xs text-ink-soft">
          {plan && `${limits(plan)} `}
          {levels
            .map((level) => `${CONFIDENCE[level].label}: ${CONFIDENCE[level].meaning}.`)
            .join(' ')}
        </p>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            suggestion={suggestion}
            plan={plan}
            selected={selected?.has(suggestion.id)}
            onToggle={(on) => onToggle([suggestion.id], on)}
          />
        ))}
      </ul>
      {suggestions.length > FIRST_SHOWN && (
        <div className="border-t border-line px-3 py-2">
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((all) => !all)}
            className="text-[13px] font-medium text-brand-700 hover:underline"
          >
            {showAll
              ? `Show the first ${FIRST_SHOWN} nights only`
              : `Show all ${suggestions.length} nights`}
          </button>
        </div>
      )}
    </section>
  );
}
