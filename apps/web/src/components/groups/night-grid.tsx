'use client';

import { eachDate } from '@pms/domain/shared';
import { cn } from '@/lib/cn';
import { formatDay, formatWeekdayName } from '@/lib/format';
import type { Group, GroupNight } from './types';

function cellWords(night: GroupNight | undefined): string {
  if (!night || (night.held === 0 && night.booked === 0)) return 'nothing held';
  if (night.held === 0) return `${night.booked} booked, none held`;
  return `${night.booked} of ${night.held} held rooms booked`;
}

/**
 * Night by night, for each kind of room: how many rooms are held and how many of them the
 * group has booked. A night with bookings but nothing held is booked from general sale.
 */
export function NightGrid({ group }: { group: Group }) {
  if (!group.from || !group.to) return null;
  const dates = eachDate(group.from, group.to);
  const names = new Map<string, string>();
  for (const hold of group.holds) names.set(hold.roomTypeId, hold.roomTypeName);
  for (const booking of group.reservations) {
    for (const room of booking.rooms) names.set(room.roomTypeId, room.roomTypeName);
  }
  const byCell = new Map(group.nights.map((n) => [`${n.roomTypeId}|${n.date}`, n]));
  const rows = [...names.entries()]
    .filter(([id]) => group.nights.some((n) => n.roomTypeId === id))
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (rows.length === 0) return null;

  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="border-separate border-spacing-0 text-sm">
        <caption className="sr-only">
          Rooms booked out of the rooms held, for each kind of room and each night
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 min-w-36 bg-surface py-1.5 pr-3 text-left text-[13px] font-medium text-ink-soft"
            >
              Booked of held
            </th>
            {dates.map((date) => (
              <th
                key={date}
                scope="col"
                className="min-w-14 px-1 py-1.5 text-center text-xs font-medium text-ink-soft"
              >
                <span className="block text-ink-faint">{formatWeekdayName(date)}</span>
                <span className="block whitespace-nowrap">{formatDay(date)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([roomTypeId, name]) => (
            <tr key={roomTypeId}>
              <th
                scope="row"
                className="sticky left-0 z-10 max-w-48 truncate bg-surface py-1 pr-3 text-left font-medium text-ink"
              >
                {name}
              </th>
              {dates.map((date) => {
                const night = byCell.get(`${roomTypeId}|${date}`);
                const held = night?.held ?? 0;
                const booked = night?.booked ?? 0;
                return (
                  <td key={date} className="p-0.5 text-center">
                    <span
                      title={cellWords(night)}
                      className={cn(
                        'tabular block rounded-md px-1 py-1.5 text-[13px]',
                        held > 0 && booked >= held && 'bg-success-50 font-medium text-success-700',
                        held > 0 && booked > 0 && booked < held && 'bg-brand-50 text-brand-700',
                        held > 0 && booked === 0 && 'bg-sunken text-ink-soft',
                        held === 0 &&
                          booked > 0 &&
                          'border border-dashed border-line-strong text-ink-soft',
                        held === 0 && booked === 0 && 'text-ink-faint',
                      )}
                    >
                      <span aria-hidden>
                        {held > 0 ? `${booked}/${held}` : booked > 0 ? booked : '–'}
                      </span>
                      <span className="sr-only">{cellWords(night)}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
