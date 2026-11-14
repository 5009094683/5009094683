'use client';

import { addDays } from '@pms/domain/shared';
import { useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatWeekday } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { AuditFigures, dayText } from './night-audit-figures';
import type { AuditStatus, NightAudit } from './types';

interface AuditState {
  status: AuditStatus;
  audits: NightAudit[];
}

/**
 * Asks before closing the hotel day, runs the night audit, then shows what it did.
 * `status` is what the screen showed when the dialog opened: the day named here
 * is the day that gets closed, or nothing is.
 */
export function RunAuditDialog({
  property,
  status,
  onClose,
  onChanged,
}: {
  property: Property;
  status: AuditStatus;
  onClose: () => void;
  /** The hotel day moved, here or elsewhere: the screen behind should load again. */
  onChanged: () => void;
}) {
  const [result, setResult] = useState<NightAudit | null>(null);
  const day = status.businessDate;
  const next = addDays(day, 1);
  const early = day === status.today;

  const run = useAction(async () => {
    // The request cannot say which day to close. If the day was closed elsewhere a moment
    // ago, running now would close the day after it, which nobody confirmed.
    const latest = await api<AuditState>(`/properties/${property.id}/night-audit`);
    if (latest.status.businessDate !== day) {
      onChanged();
      throw new Error(
        `${formatWeekday(day)} has just been closed by someone else or by the automatic run. Nothing was done. Close this and check the status again.`,
      );
    }
    const audit = await api<NightAudit>(`/properties/${property.id}/night-audit`, {
      method: 'POST',
    });
    setResult(audit);
    onChanged();
  });

  if (result) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={`${formatWeekday(result.businessDate)} is closed`}
        description={`The hotel day at ${property.name} is now ${dayText(addDays(result.businessDate, 1))}.`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <AuditFigures audit={result} currency={property.currency} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={run.busy ? () => undefined : onClose}
      title={`Close ${formatWeekday(day)}?`}
      description={`Night audit for ${property.name}`}
      footer={
        <>
          <Button onClick={onClose} disabled={run.busy}>
            Cancel
          </Button>
          <Button type="submit" form="night-audit-form" variant="primary" loading={run.busy}>
            Run night audit
          </Button>
        </>
      }
    >
      <form
        id="night-audit-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run.run();
        }}
        className="flex flex-col gap-3 text-sm text-ink-soft"
      >
        <FormError message={run.error} />
        <p>
          This closes the hotel day {dayText(day)} and starts {dayText(next)}.
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            Every room with a guest checked in is charged for the night of {formatWeekday(day)}.
          </li>
          <li>
            Guests who were due to leave and are still checked in are listed. They are not charged
            for the night until their stay is extended.
          </li>
          <li>
            {property.settings.autoNoShow
              ? 'Bookings that were due and did not arrive are marked no-show.'
              : 'Bookings that were due and did not arrive are listed, and left as they are.'}
          </li>
          <li>The cleaning list for {formatWeekday(next)} is written.</li>
          <li>The figures for {formatWeekday(day)} are saved for reports.</li>
        </ul>
        {early && (
          <Notice tone="warning" title={`${formatWeekday(day)} is not over yet`}>
            Close it now only when the day&apos;s work is done.
            {property.settings.autoNoShow &&
              ' Guests due today who have not checked in yet are marked no-show.'}{' '}
            Anything posted after this is dated {formatWeekday(next)}, and the night audit cannot
            run again until then.
          </Notice>
        )}
        <p className="font-medium text-ink">This cannot be undone.</p>
      </form>
    </Dialog>
  );
}
