'use client';

import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Notice } from '@/components/ui/misc';
import type { Proposal } from './conversation';

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * A change the assistant has prepared. It shows what would happen and waits: only Confirm
 * carries it out, and only while the proposal is fresh.
 */
export function ProposalCard({
  proposal,
  now,
  busy,
  error,
  onConfirm,
  onDismiss,
}: {
  proposal: Proposal;
  /** The time by this device's clock, to tell when the proposal has lapsed. */
  now: number;
  busy: 'confirm' | 'dismiss' | undefined;
  error: string | undefined;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const { action, outcome, lapsesAt } = proposal;
  // A decision already on its way is seen through, even if the clock runs out meanwhile.
  const lapsed = outcome.state === 'waiting' && !busy && lapsesAt <= now;
  const waiting = outcome.state === 'waiting' && !lapsed;

  return (
    <div className="rounded-lg border border-line bg-surface p-3 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-faint">Proposed change</p>
        {waiting && <Badge tone="warning">Waiting for you</Badge>}
        {lapsed && <Badge>Lapsed</Badge>}
        {outcome.state === 'done' && (
          <Badge tone="success">
            <Check className="size-3" aria-hidden />
            Done
          </Badge>
        )}
        {outcome.state === 'dismissed' && <Badge>Dismissed</Badge>}
        {outcome.state === 'refused' && <Badge tone="danger">Not done</Badge>}
      </div>
      <p className="mt-1.5 text-sm text-ink [overflow-wrap:anywhere]">{action.summary}</p>

      {waiting && (
        <>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            Nothing changes until you confirm. This proposal waits until {clock.format(lapsesAt)}.
          </p>
          {error && (
            <Notice tone="warning" className="mt-2">
              {error}
            </Notice>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy === 'confirm'}
              disabled={busy === 'dismiss'}
              onClick={onConfirm}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              loading={busy === 'dismiss'}
              disabled={busy === 'confirm'}
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          </div>
        </>
      )}
      {lapsed && (
        <p className="mt-1.5 text-[13px] text-ink-soft">
          This proposal waited longer than it is kept, so nothing was changed. Ask again if you
          still want it.
        </p>
      )}
      {outcome.state === 'done' && (
        <p className="mt-1.5 text-[13px] text-success-700 [overflow-wrap:anywhere]">
          {outcome.message}
        </p>
      )}
      {outcome.state === 'dismissed' && (
        <p className="mt-1.5 text-[13px] text-ink-soft">Nothing was changed.</p>
      )}
      {outcome.state === 'refused' && (
        <Notice tone="danger" className="mt-2">
          {outcome.message}
        </Notice>
      )}
    </div>
  );
}
