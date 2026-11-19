'use client';

import { CircleQuestionMark } from 'lucide-react';
import { Popover } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import type { ReservationRisk, RiskLevel } from './types';

type Marked = Exclude<RiskLevel, 'low'>;

/** The words speak of the arrival, never of the guest: this is an estimate, not a verdict. */
const LABELS: Record<Marked, string> = {
  medium: 'Arrival less certain',
  high: 'Arrival uncertain',
};

const TONES: Record<Marked, string> = {
  medium: 'bg-warning-50 text-warning-700 hover:bg-warning-100',
  high: 'bg-danger-50 text-danger-700 hover:bg-danger-100',
};

/**
 * A small marker on an arrival that is less sure than most to go ahead. It opens the two
 * likelihoods and what they are based on. Renders nothing when nothing stands out.
 */
export function RiskMarker({
  risk,
  guestName,
}: {
  risk: Pick<ReservationRisk, 'cancellation' | 'noShow' | 'level' | 'factors'>;
  guestName: string;
}) {
  if (risk.level === 'low') return null;
  const label = LABELS[risk.level];
  // The marker sits on cards that open the reservation when clicked. A click on it, or inside
  // what it opens (which React counts as inside the card), must not do that.
  return (
    <Popover
      className="w-72 max-w-[calc(100vw-2rem)] p-0"
      trigger={
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          aria-label={`${label}: ${guestName}. Show why`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors',
            TONES[risk.level],
          )}
        >
          <CircleQuestionMark className="size-3" aria-hidden />
          {label}
        </button>
      }
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex flex-col gap-2.5 p-3 text-[13px]"
      >
        <div>
          <p className="font-medium text-ink">{label}</p>
          <p className="text-ink-soft">
            An estimate from the booking. It says nothing certain about this guest.
          </p>
        </div>
        <dl className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-soft">Chance of being cancelled</dt>
            <dd className="tabular font-medium text-ink">About {risk.cancellation}%</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-soft">Chance of not turning up</dt>
            <dd className="tabular font-medium text-ink">About {risk.noShow}%</dd>
          </div>
        </dl>
        {risk.factors.length > 0 && (
          <div>
            <p className="text-xs font-medium text-ink-faint">Based on</p>
            <ul className="mt-0.5 list-disc pl-4 text-ink">
              {risk.factors.map((factor) => (
                <li key={factor}>{factor}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Popover>
  );
}
