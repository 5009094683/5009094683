import type { ComponentProps } from 'react';
import { BLOCK_KIND_LABELS, diffDays, isValidDate } from '@pms/domain/shared';
import type { Badge } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { formatDay } from '@/lib/format';
import type { Issue, IssueStatus, OffSale, Priority } from './types';

type Tone = NonNullable<ComponentProps<typeof Badge>['tone']>;

export const STATUSES: IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed'];

export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_TONES: Record<IssueStatus, Tone> = {
  open: 'warning',
  in_progress: 'info',
  resolved: 'success',
  closed: 'neutral',
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

/** Resolved and closed issues are finished: the room is back on sale and no work is left. */
export function isFinished(status: IssueStatus): boolean {
  return status === 'resolved' || status === 'closed';
}

/** Where the issue is: the room, or the property as a whole. */
export function placeText(issue: Issue): string {
  return issue.unitName ?? 'Common area';
}

/**
 * Where the issue is with its property: `Sea Breeze Candolim · 204`. A villa let as a whole
 * has one room with the villa's own name, which is then said once.
 */
export function whereText(issue: Issue, propertyName: string | undefined): string {
  const place = placeText(issue);
  return propertyName && propertyName !== place ? `${propertyName} · ${place}` : place;
}

export function offSaleText(offSale: OffSale): string {
  return `Off sale from ${formatDay(offSale.from)}, back on sale ${formatDay(offSale.to)}`;
}

/** The same, as a sentence about the room, for the message after saving. */
export function offSaleSentence(room: string, offSale: OffSale): string {
  return `${room} is off sale from ${formatDay(offSale.from)}, back on sale ${formatDay(offSale.to)}.`;
}

/** The server allows a room to be off sale for at most this many days in one go. */
const MAX_OFF_SALE_DAYS = 730;

/** What is wrong with the dates, in words for the form, or null when they are fine. */
export function offSaleProblem(offSale: OffSale): string | null {
  if (!isValidDate(offSale.from) || !isValidDate(offSale.to)) return 'Choose both dates.';
  const days = diffDays(offSale.from, offSale.to);
  if (days < 1) return 'This has to be after the first date.';
  if (days > MAX_OFF_SALE_DAYS) return 'A room can be off sale for at most two years at a time.';
  return null;
}

interface Conflict {
  unitName?: string;
  from?: string;
  to?: string;
  kind?: 'reservation' | 'block';
  label?: string | null;
}

/**
 * What a block that is in the way is called: the reason it was given. For a block without
 * one the server names its kind, which is said as the calendar says it; a plain block has
 * nothing more to say than that it is one.
 */
function blockName(label: string | null | undefined): string | null {
  if (!label || label === 'block') return null;
  return Object.hasOwn(BLOCK_KIND_LABELS, label)
    ? BLOCK_KIND_LABELS[label as keyof typeof BLOCK_KIND_LABELS]
    : label;
}

/**
 * The error to show when saving failed. A refusal because a stay or a block is in the way
 * is put in plain words, with what is in the way named.
 */
export function saveError(err: unknown): Error {
  if (!(err instanceof ApiError) || err.code !== 'unit_occupied') {
    return err instanceof Error ? err : new Error('Something went wrong');
  }
  const [conflict] = (err.details?.conflicts as Conflict[] | undefined) ?? [];
  if (!conflict?.from || !conflict.to) return err;
  const dates = `${formatDay(conflict.from)} to ${formatDay(conflict.to)}`;
  const room = conflict.unitName ?? 'The room';
  if (conflict.kind === 'block') {
    const name = blockName(conflict.label);
    return new Error(
      `${room} is already blocked from ${dates}${name ? ` (${name})` : ''}. Nothing was saved. Choose other dates.`,
    );
  }
  return new Error(
    `${room} has a stay that cannot be moved: reservation ${conflict.label ?? ''}, ${dates}. Nothing was saved. Move or cancel that stay first, or choose other dates.`,
  );
}
