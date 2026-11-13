import type { ComponentProps } from 'react';
import type { Badge } from '@/components/ui/misc';
import { formatDay } from '@/lib/format';
import type {
  BoardTask,
  BoardUnit,
  CleaningState,
  Priority,
  SettableState,
  TaskKind,
} from './types';

type Tone = NonNullable<ComponentProps<typeof Badge>['tone']>;

export const STATES: CleaningState[] = ['dirty', 'clean', 'inspected', 'out_of_service'];
export const SETTABLE_STATES: SettableState[] = ['clean', 'dirty', 'inspected'];

export const STATE_LABELS: Record<CleaningState, string> = {
  dirty: 'Not cleaned',
  clean: 'Clean',
  inspected: 'Inspected',
  out_of_service: 'Out of service',
};

export const STATE_TONES: Record<CleaningState, Tone> = {
  dirty: 'warning',
  clean: 'success',
  inspected: 'info',
  out_of_service: 'neutral',
};

export const STATE_DOTS: Record<CleaningState, string> = {
  dirty: 'bg-warning-500',
  clean: 'bg-success-500',
  inspected: 'bg-info-500',
  out_of_service: 'bg-ink-faint',
};

export const TASK_KINDS: TaskKind[] = [
  'departure',
  'stayover',
  'touch_up',
  'deep_clean',
  'inspection',
];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  departure: 'Departure clean',
  stayover: 'Stay-over clean',
  touch_up: 'Touch-up',
  deep_clean: 'Deep clean',
  inspection: 'Inspection',
};

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const PRIORITY_TONES: Record<Priority, Tone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

/** What is happening in the room today, in the words staff use. */
export function occupancyText(unit: BoardUnit): string {
  const leaves = unit.departs ? `Occupied, leaves ${formatDay(unit.departs)}` : 'Occupied';
  switch (unit.occupancy) {
    case 'blocked':
      return 'Off sale';
    case 'turnover':
      return 'Leaving and arriving today';
    case 'departing':
      // Once the next guest has checked in the room still reads as "departing",
      // but the guest and leaving date it carries are the new guest's.
      return unit.departs ? leaves : 'Leaving today';
    case 'arriving':
      return 'Arriving today';
    case 'occupied':
      return leaves;
    default:
      return 'Vacant';
  }
}

/** What finishing the task does to the room, said after the fact. */
export function finishedText(task: BoardTask, unit: BoardUnit): string {
  if (task.kind === 'inspection') return `${unit.unitName} is now inspected.`;
  if (unit.status === 'out_of_service') return `${unit.unitName} stays out of service.`;
  return `${unit.unitName} is now clean.`;
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** `10:42`, in the viewer's own time zone. */
export function formatTime(value: string): string {
  return clock.format(new Date(value));
}
