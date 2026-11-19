import type { ComponentProps } from 'react';
import { diffDays, todayIn } from '@pms/domain/shared';
import type { Badge } from '@/components/ui/misc';
import { formatDay, plural } from '@/lib/format';
import type { Property } from '@/lib/types';
import type { Housekeeping } from './types';

export { roomLabel } from '@/components/folio/labels';

type BadgeTone = ComponentProps<typeof Badge>['tone'];

export const HOUSEKEEPING_LABELS: Record<Housekeeping, string> = {
  clean: 'Clean',
  inspected: 'Inspected',
  dirty: 'Not cleaned',
  out_of_service: 'Out of service',
};

export const HOUSEKEEPING_TONES: Record<Housekeeping, BadgeTone> = {
  clean: 'success',
  inspected: 'success',
  dirty: 'warning',
  out_of_service: 'danger',
};

/** The day the front desk works on: where the night audit last left it, else today at the property. */
export function hotelDayOf(property: Pick<Property, 'businessDate' | 'timezone'>): string {
  return property.businessDate ?? todayIn(property.timezone);
}

/** The same inside a sentence: "room 204". */
export function roomInText(unitName: string): string {
  return /^\d/.test(unitName) ? `room ${unitName}` : unitName;
}

/** `13 Nov – 18 Nov · 5 nights` */
export function stayDates(checkIn: string, checkOut: string): string {
  return `${formatDay(checkIn)} – ${formatDay(checkOut)} · ${plural(diffDays(checkIn, checkOut), 'night')}`;
}

export function guestCount(adults: number, children: number): string {
  return `${plural(adults, 'adult')}${children > 0 ? `, ${plural(children, 'child', 'children')}` : ''}`;
}

/** `a, b and c` */
export function listInWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
