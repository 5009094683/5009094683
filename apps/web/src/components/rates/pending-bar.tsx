'use client';

import { ListChecks, X } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Notice, Popover } from '@/components/ui/misc';
import { plural } from '@/lib/format';
import type { RatePlan } from '@/lib/types';
import { changeText, datesText, type PendingChange } from './pending';

export interface PlanName {
  plan: RatePlan;
  typeName: string;
}

/**
 * The changes made on the rates screen and not yet saved: how many, what
 * they are, and the two things to do with them. Saving sends them together,
 * so the booking sites are told once.
 */
export function PendingBar({
  pending,
  plans,
  currency,
  saving,
  error,
  onRemove,
  onDiscard,
  onSave,
}: {
  pending: PendingChange[];
  plans: ReadonlyMap<string, PlanName>;
  currency: string;
  saving: boolean;
  /** Why the last attempt to save did not go through. */
  error: string | null;
  onRemove: (id: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (pending.length === 0) return null;

  return (
    <section
      aria-label="Changes not saved yet"
      className="flex flex-col gap-2 border-t border-warning-200 bg-warning-50 px-3 py-2"
    >
      {error && (
        <Notice tone="danger" title="The changes were not saved">
          {error} Nothing was changed. Correct or remove the change it names, then save again.
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="text-sm font-medium text-ink">
          {plural(pending.length, 'change')} not saved yet
        </p>
        <Popover
          align="start"
          className="w-[min(26rem,calc(100vw-1.5rem))] p-0"
          trigger={
            <Button size="sm" icon={<ListChecks className="size-3.5" aria-hidden />}>
              Review
            </Button>
          }
        >
          <ul className="scrollbar-thin max-h-80 divide-y divide-line overflow-y-auto">
            {pending.map((change) => {
              const named = plans.get(change.ratePlanId);
              return (
                <li key={change.id} className="flex items-start gap-2 px-3 py-2 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words text-ink">
                      {named
                        ? `${named.typeName} · ${named.plan.name}`
                        : 'A rate plan that is gone'}
                    </p>
                    <p className="text-ink-soft">{datesText(change)}</p>
                    <p className="break-words text-ink">
                      {named
                        ? changeText(change.change, named.plan, currency).join(', ')
                        : 'Remove this change: its rate plan no longer exists.'}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={`Remove the change to ${named?.plan.name ?? 'the rate plan'} on ${datesText(change)}`}
                    onClick={() => onRemove(change.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Popover>
        <p className="hidden text-[13px] text-ink-soft sm:block">
          Saved together, they reach the booking sites as one update.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" disabled={saving} onClick={() => setAsking(true)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={onSave}>
            Save changes
          </Button>
        </div>
      </div>
      {asking && (
        <ConfirmDialog
          title={`Discard ${plural(pending.length, 'change')}?`}
          confirmLabel="Discard"
          onClose={() => setAsking(false)}
          onConfirm={async () => {
            onDiscard();
            setAsking(false);
          }}
        >
          <p>The rates and restrictions stay as they were. Nothing is sent to the booking sites.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
