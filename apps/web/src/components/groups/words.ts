import { formatDate, formatStay, plural } from '@/lib/format';
import type { GroupItem, GroupStatus } from './types';

export const STATUS_LABELS: Record<GroupStatus, string> = {
  open: 'Holding rooms',
  closed: 'Rooms released',
  cancelled: 'Cancelled',
};

export const STATUS_TONES: Record<GroupStatus, 'brand' | 'neutral' | 'danger'> = {
  open: 'brand',
  closed: 'neutral',
  cancelled: 'danger',
};

/** `12 – 15 Mar 2027`, or what to say while the group has no dates. */
export function datesText(group: Pick<GroupItem, 'from' | 'to'>): string {
  return group.from && group.to ? formatStay(group.from, group.to) : 'No dates yet';
}

/** How far the group has got with booking the rooms held for it. */
export function progressText(
  group: Pick<GroupItem, 'heldNights' | 'leftNights' | 'bookings' | 'status'>,
): string {
  const booked = plural(group.bookings, 'booking');
  if (group.heldNights === 0) return booked;
  const taken = group.heldNights - group.leftNights;
  return `${booked} · ${taken} of ${plural(group.heldNights, 'held room night')} booked`;
}

export function cutoffText(group: Pick<GroupItem, 'cutoffDate' | 'status'>): string | null {
  if (!group.cutoffDate || group.status !== 'open') return null;
  return `Unbooked rooms go back on sale after ${formatDate(group.cutoffDate)}`;
}
