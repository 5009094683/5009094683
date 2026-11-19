'use client';

import { CalendarClock, Plus } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { ScheduleCard, type SendOutcome } from './schedule-card';
import { ScheduleDialog } from './schedule-dialog';
import type { Schedule, SchedulesAnswer, SendResult } from './types';

type Open = { kind: 'new' } | { kind: 'edit' | 'delete'; schedule: Schedule };

/** The list is asked for again this often, so that "next" and "last" keep up with the clock. */
const REFRESH_MS = 60_000;

function outcomeOf(result: SendResult, schedule: Schedule): SendOutcome {
  if (result.status === 'sent') {
    return { tone: 'success', title: 'Sent', detail: `To ${schedule.recipients.join(', ')}.` };
  }
  return {
    tone: result.status === 'not_configured' ? 'warning' : 'danger',
    title: 'The report was not sent',
    detail: result.error,
  };
}

/**
 * The reports that go out by email by themselves. Anyone who may read reports may schedule
 * them, for the properties their role covers; the server lists only those they may manage.
 */
export function SchedulesView({ offered }: { offered: Property[] }) {
  const toast = useToast();
  const { data, error, mutate } = useSWR<SchedulesAnswer>('/reports/schedules', {
    refreshInterval: REFRESH_MS,
  });
  const { data: organisation } = useSWR<Organization>('/org');
  const timeZone = organisation?.defaultTimezone;

  const [open, setOpen] = useState<Open | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, SendOutcome | undefined>>({});
  const setOutcome = (id: string, outcome: SendOutcome | undefined) =>
    setOutcomes((current) => ({ ...current, [id]: outcome }));

  const switchTo = async (schedule: Schedule, active: boolean) => {
    setSwitchingId(schedule.id);
    try {
      await api(`/reports/schedules/${schedule.id}`, { method: 'PATCH', body: { active } });
      await mutate();
      if (active) toast.success(`\u201c${schedule.name}\u201d switched on`);
      else toast.success(`\u201c${schedule.name}\u201d switched off`, 'It is no longer sent.');
    } catch (err) {
      toast.error(err);
    } finally {
      setSwitchingId(null);
    }
  };

  const sendNow = async (schedule: Schedule) => {
    setSendingId(schedule.id);
    setOutcome(schedule.id, undefined);
    try {
      const result = await api<SendResult>(`/reports/schedules/${schedule.id}/send`, {
        method: 'POST',
      });
      setOutcome(schedule.id, outcomeOf(result, schedule));
    } catch (err) {
      setOutcome(schedule.id, {
        tone: err instanceof ApiError && err.status === 429 ? 'warning' : 'danger',
        title: 'The report was not sent',
        detail: errorMessage(err),
      });
    } finally {
      setSendingId(null);
    }
  };

  const add = (
    <Button
      variant="primary"
      icon={<Plus className="size-4" aria-hidden />}
      onClick={() => setOpen({ kind: 'new' })}
    >
      Schedule a report
    </Button>
  );

  let body;
  if (error && !data) {
    body = <ErrorState error={error} onRetry={() => void mutate()} />;
  } else if (!data) {
    body = <PageLoading label="Loading scheduled emails" />;
  } else if (data.schedules.length === 0) {
    body = (
      <EmptyState
        icon={<CalendarClock className="size-5" />}
        title="No reports are scheduled"
        description="A scheduled report goes out by email every day, week or month, as a spreadsheet, to the people who should see it."
        action={add}
      />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3">
        {data.schedules.map((schedule) => (
          <li key={schedule.id}>
            <ScheduleCard
              schedule={schedule}
              properties={offered}
              timeZone={timeZone}
              switching={switchingId === schedule.id}
              sending={sendingId === schedule.id}
              outcome={outcomes[schedule.id]}
              onSwitch={(active) => void switchTo(schedule, active)}
              onSend={() => void sendNow(schedule)}
              onDismissOutcome={() => setOutcome(schedule.id, undefined)}
              onEdit={() => setOpen({ kind: 'edit', schedule })}
              onDelete={() => setOpen({ kind: 'delete', schedule })}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="report-schedules">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="report-schedules" className="text-base font-semibold text-ink">
            Scheduled emails
          </h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            Reports that go out by email by themselves, as a spreadsheet.
          </p>
        </div>
        {data && data.schedules.length > 0 && add}
      </div>

      {data && !data.mailConfigured && (
        <Notice tone="warning" title="Email is not set up on this server" className="mb-4">
          Scheduled reports cannot go out until whoever looks after the system has set up a mail
          server. Schedules made now start to go out once it is.
        </Notice>
      )}

      {body}

      {open && open.kind !== 'delete' && (
        <ScheduleDialog
          schedule={open.kind === 'edit' ? open.schedule : undefined}
          offered={offered}
          timeZone={timeZone}
          onClose={() => setOpen(null)}
          onSaved={() => void mutate()}
        />
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete \u201c${open.schedule.name}\u201d?`}
          confirmLabel="Delete schedule"
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            await api(`/reports/schedules/${open.schedule.id}`, { method: 'DELETE' });
            await mutate();
            toast.success(`\u201c${open.schedule.name}\u201d deleted`);
            setOpen(null);
          }}
        >
          This report will no longer be sent to {open.schedule.recipients.join(', ')}. Reports
          already sent stay with the people who have them.
        </ConfirmDialog>
      )}
    </section>
  );
}
