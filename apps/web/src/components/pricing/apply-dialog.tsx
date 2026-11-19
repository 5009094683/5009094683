'use client';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/misc';
import { formatDay, plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { SuggestionGroup } from './suggestions';

/** Says what applying will do, and where the new rates go, before anything is changed. */
export function ApplyDialog({
  propertyName,
  groups,
  onApply,
  onClose,
}: {
  propertyName: string;
  /** The chosen suggestions, by rate plan. */
  groups: SuggestionGroup[];
  onApply: () => Promise<void>;
  onClose: () => void;
}) {
  const apply = useAction(onApply);
  const count = groups.reduce((sum, group) => sum + group.suggestions.length, 0);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Apply ${plural(count, 'suggested rate')}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={apply.busy} onClick={() => void apply.run()}>
            {count === 1 ? 'Apply rate' : 'Apply rates'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-ink-soft">
        {apply.error && <Notice tone="danger">{apply.error}</Notice>}
        <p>The rate for each of these nights at {propertyName} is set to the suggested one:</p>
        <ul className="flex flex-col gap-1">
          {groups.map((group) => {
            const first = group.suggestions[0]!.date;
            const last = group.suggestions[group.suggestions.length - 1]!.date;
            return (
              <li key={group.ratePlanId}>
                <span className="font-medium text-ink">
                  {group.roomTypeName} / {group.ratePlanName}
                </span>
                : {plural(group.suggestions.length, 'night')}
                {first === last
                  ? ` (${formatDay(first)})`
                  : ` (between ${formatDay(first)} and ${formatDay(last)})`}
              </li>
            );
          })}
        </ul>
        <Notice tone="info">
          The new rates go to the booking sites like any other rate change.
        </Notice>
      </div>
    </Dialog>
  );
}
