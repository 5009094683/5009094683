'use client';

import { Check, Pencil, Play, RotateCcw, SkipForward, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { isOpen } from './board';
import { PRIORITY_LABELS, PRIORITY_TONES, TASK_KIND_LABELS, formatTime } from './labels';
import { PersonOptions } from './staff';
import type { BoardTask, BoardUnit, SettableState, StaffMember, TaskStatus } from './types';

/** What a person with housekeeping.write can do from the board. Absent for everyone else. */
export interface BoardActions {
  /** What is being saved right now: `unit:<id>` or `task:<id>`, with the state or status on its way. */
  busy: ReadonlyMap<string, string>;
  staff: StaffMember[];
  setState(unit: BoardUnit, state: SettableState): void;
  setTaskStatus(unit: BoardUnit, task: BoardTask, status: TaskStatus): void;
  assign(unit: BoardUnit, task: BoardTask, personId: string | null): void;
  editTask(unit: BoardUnit, task: BoardTask): void;
  addTask(unit: BoardUnit): void;
}

/** Sized for a thumb on a phone, compact where there is a mouse. */
export const TOUCH = 'h-11 sm:h-9';

function StatusBadge({ task, timezone }: { task: BoardTask; timezone: string }) {
  if (task.status === 'in_progress') {
    return (
      <Badge tone="info">
        In progress{task.startedAt ? ` since ${formatTime(task.startedAt, timezone)}` : ''}
      </Badge>
    );
  }
  if (task.status === 'done') {
    return (
      <Badge tone="success">
        <Check className="size-3" aria-hidden />
        Done{task.completedAt ? ` ${formatTime(task.completedAt, timezone)}` : ''}
      </Badge>
    );
  }
  if (task.status === 'skipped') return <Badge>Skipped</Badge>;
  return null;
}

function Person({ task }: { task: BoardTask }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-soft">
      <UserRound className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      <span className="truncate">{task.assignedToName ?? 'Not assigned'}</span>
    </p>
  );
}

export function TaskRow({
  unit,
  task,
  timezone,
  actions,
}: {
  unit: BoardUnit;
  task: BoardTask;
  /** Of the property: the times on a task are given by its clock. */
  timezone: string;
  actions: BoardActions | null;
}) {
  const open = isOpen(task);
  const saving = actions?.busy.get(`task:${task.id}`);
  const busy = saving !== undefined;
  const kind = TASK_KIND_LABELS[task.kind];
  // The server refuses to pass an inspection in a room that has not been cleaned.
  const notCleaned = task.kind === 'inspection' && unit.status === 'dirty';

  return (
    <li className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('font-medium', open ? 'text-ink' : 'text-ink-soft')}>{kind}</span>
          {task.priority !== 'normal' && (
            <Badge tone={PRIORITY_TONES[task.priority]}>{PRIORITY_LABELS[task.priority]}</Badge>
          )}
          <StatusBadge task={task} timezone={timezone} />
        </div>
        {actions && (
          <button
            type="button"
            aria-label={`Edit ${kind.toLowerCase()} for ${unit.unitName}`}
            onClick={() => actions.editTask(unit, task)}
            className="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-sunken hover:text-ink sm:-my-1 sm:-mr-1 sm:size-8"
          >
            <Pencil className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {open && actions && (
        <Select
          aria-label={`Person for ${kind.toLowerCase()} in ${unit.unitName}`}
          value={task.assignedTo ?? ''}
          disabled={busy}
          onChange={(event) => actions.assign(unit, task, event.target.value || null)}
          className={cn(TOUCH, !task.assignedTo && 'text-ink-faint')}
        >
          <PersonOptions
            staff={actions.staff}
            area="housekeeping"
            current={{ id: task.assignedTo, name: task.assignedToName }}
          />
        </Select>
      )}
      {open && !actions && <Person task={task} />}

      {!open && (actions || task.assignedToName) && (
        <div className="flex items-center justify-between gap-2">
          {task.assignedToName ? <Person task={task} /> : <span />}
          {actions && (
            <Button
              variant="ghost"
              size="sm"
              className="-my-1 h-11 sm:h-7"
              icon={<RotateCcw className="size-3.5" aria-hidden />}
              loading={saving === 'pending'}
              disabled={busy}
              onClick={() => actions.setTaskStatus(unit, task, 'pending')}
            >
              Put back on the list
            </Button>
          )}
        </div>
      )}

      {task.notes && <p className="text-[13px] whitespace-pre-line text-ink-soft">{task.notes}</p>}

      {open && actions && (
        <>
          <div
            className={cn(
              'grid gap-1.5',
              task.status === 'pending' ? 'grid-cols-3' : 'grid-cols-2',
            )}
          >
            {task.status === 'pending' && (
              <Button
                className={TOUCH}
                icon={<Play className="size-4" aria-hidden />}
                loading={saving === 'in_progress'}
                disabled={busy}
                onClick={() => actions.setTaskStatus(unit, task, 'in_progress')}
              >
                Start
              </Button>
            )}
            <Button
              variant="primary"
              className={TOUCH}
              icon={<Check className="size-4" aria-hidden />}
              loading={saving === 'done'}
              disabled={busy || notCleaned}
              onClick={() => actions.setTaskStatus(unit, task, 'done')}
            >
              Done
            </Button>
            <Button
              variant="ghost"
              className={TOUCH}
              icon={<SkipForward className="size-4" aria-hidden />}
              loading={saving === 'skipped'}
              disabled={busy}
              onClick={() => actions.setTaskStatus(unit, task, 'skipped')}
            >
              Skip
            </Button>
          </div>
          {notCleaned && (
            <p className="text-xs text-warning-700">
              The room has to be clean before it can pass inspection.
            </p>
          )}
        </>
      )}
    </li>
  );
}
