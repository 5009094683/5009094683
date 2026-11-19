'use client';

import { Pencil, Send, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/field';
import { Badge, Card, Notice } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import type { Property } from '@/lib/types';
import { PERIOD_WORDS, REPORT_LABELS, coversText, runTimeText, whenText } from './schedule-words';
import type { Schedule } from './types';

/** What came of pressing "Send now", in the server's words where it gave any. */
export interface SendOutcome {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  detail?: string;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-ink">{children}</dd>
    </div>
  );
}

/** When the report was last due to go out by itself, and what came of it. */
function LastRun({ schedule, timeZone }: { schedule: Schedule; timeZone: string | undefined }) {
  if (!schedule.lastRunAt) return <span className="text-ink-soft">Not sent yet</span>;
  const sent = schedule.lastStatus === 'sent';
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {runTimeText(schedule.lastRunAt, timeZone)}
        <Badge tone={sent ? 'success' : 'danger'}>{sent ? 'Sent' : 'Not sent'}</Badge>
      </span>
      {!sent && schedule.lastError && (
        <span className="mt-1 block text-[13px] text-danger-700">{schedule.lastError}</span>
      )}
    </>
  );
}

/** One scheduled report: what is sent, when and to whom, with its switch and its actions. */
export function ScheduleCard({
  schedule,
  properties,
  timeZone,
  switching,
  sending,
  outcome,
  onSwitch,
  onSend,
  onDismissOutcome,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  properties: Property[];
  /** The organisation's time zone, which schedules run by. */
  timeZone: string | undefined;
  switching: boolean;
  sending: boolean;
  outcome: SendOutcome | undefined;
  onSwitch: (active: boolean) => void;
  onSend: () => void;
  onDismissOutcome: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const name = `\u201c${schedule.name}\u201d`;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold break-words text-ink">{schedule.name}</h3>
          <p className={cn('mt-0.5 text-sm', schedule.active ? 'text-ink' : 'text-ink-soft')}>
            {whenText(schedule)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <span
            aria-hidden
            className={cn(
              'text-[13px] font-medium',
              schedule.active ? 'text-success-700' : 'text-ink-faint',
            )}
          >
            {schedule.active ? 'On' : 'Off'}
          </span>
          <Switch
            checked={schedule.active}
            disabled={switching}
            label={`Send ${name} on schedule`}
            onChange={onSwitch}
          />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Report">{REPORT_LABELS[schedule.report]}</Detail>
        <Detail label="Covers">{coversText(schedule, properties)}</Detail>
        <Detail label="Period">{PERIOD_WORDS[schedule.period].label}</Detail>
        <Detail label="Sent to">{schedule.recipients.join(', ')}</Detail>
        <Detail label="Next goes out">
          {schedule.active ? (
            runTimeText(schedule.nextRunAt, timeZone)
          ) : (
            <span className="text-ink-soft">Switched off: it is not sent</span>
          )}
        </Detail>
        <Detail label="Last time">
          <LastRun schedule={schedule} timeZone={timeZone} />
        </Detail>
      </dl>

      {outcome && (
        <Notice tone={outcome.tone} title={outcome.title} className="mt-3">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words">{outcome.detail}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismissOutcome}
              className="-my-0.5 shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </Notice>
      )}

      <div className="mt-3 -mb-1 -ml-2 flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          icon={<Send className="size-3.5" aria-hidden />}
          loading={sending}
          aria-label={`Send ${name} now`}
          onClick={onSend}
        >
          Send now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Pencil className="size-3.5" aria-hidden />}
          aria-label={`Edit ${name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          variant="danger-ghost"
          size="sm"
          icon={<Trash2 className="size-3.5" aria-hidden />}
          aria-label={`Delete ${name}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}
