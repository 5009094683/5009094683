'use client';

import { BedDouble, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Notice } from '@/components/ui/misc';
import { plural } from '@/lib/format';
import {
  fitsCalendars,
  takesBookingsWithoutRoom,
  type CalendarErrors,
  type DraftCalendar,
  type UnitGroup,
} from './calendar-draft';
import { CalendarFields } from './calendar-fields';
import { RowLabel, unitCount } from './mapping-editor';
import type { CalendarFeed } from './types';

/** Why a room type gets no calendars, or what is wrong with the ones it has. */
function Unfit({ group, calendars }: { group: UnitGroup; calendars: number }) {
  const { type, rooms } = group;
  if (rooms <= 1) {
    if (calendars === 0) return null;
    return (
      <Notice tone="warning" className="m-3 mb-0">
        {type.active
          ? `No unit of ${type.name} is in use, so its calendars show nothing that can be sold.`
          : `${type.name} is not in use, so its calendars show nothing that can be sold.`}{' '}
        Remove them unless it is coming back.
      </Notice>
    );
  }
  if (calendars === 0) {
    return (
      <p className="px-3 py-3 text-[13px] text-ink-soft">
        Calendars are not offered for {type.name}. It has {plural(rooms, 'room')}, and a calendar
        cannot count rooms: it can only say that dates are taken or free, which leads to double
        bookings. Use the channel manager for this room type.
      </p>
    );
  }
  return (
    <Notice tone="danger" className="m-3 mb-0" title={`${type.name} has ${plural(rooms, 'room')}`}>
      A calendar cannot count rooms. It can only say that dates are taken or free, so with{' '}
      {calendars === 1 ? 'this calendar' : 'these calendars'} a site can go on selling rooms that
      are gone here. Remove {calendars === 1 ? 'it' : 'them'} and use the channel manager for this
      room type.
    </Notice>
  );
}

/**
 * The units of one room type with their calendars. A calendar can be added only where the room
 * type has a single room; calendars that exist elsewhere are shown so that they can be removed.
 */
export function CalendarUnitGroup({
  group,
  calendars,
  saved,
  errors,
  suggestionsId,
  disabled,
  live,
  now,
  onAdd,
  onChange,
  onRemove,
}: {
  group: UnitGroup;
  /** Every calendar being edited; the group shows those of its own units. */
  calendars: DraftCalendar[];
  /** The calendars as they are saved, by id. */
  saved: ReadonlyMap<string, CalendarFeed>;
  /** What is wrong with each calendar, by key, once saving has been tried. */
  errors?: ReadonlyMap<string, CalendarErrors>;
  suggestionsId: string;
  disabled: boolean;
  live: boolean;
  now: Date;
  onAdd: (unitId: string) => void;
  onChange: (key: string, change: Partial<DraftCalendar>) => void;
  onRemove: (calendar: DraftCalendar) => void;
}) {
  const { type } = group;
  const fits = fitsCalendars(group);
  const units = group.units
    .map((unit) => ({
      unit,
      own: calendars.filter((calendar) => calendar.unitId === unit.id),
      offered: fits && unit.active,
    }))
    .filter(({ own, offered }) => offered || own.length > 0);
  const count = units.reduce((sum, { own }) => sum + own.length, 0);

  return (
    <li className="overflow-hidden rounded-lg border border-line">
      <h3 className="border-b border-line bg-sunken/60 px-3 py-2">
        <RowLabel
          icon={<BedDouble />}
          name={type.name}
          detail={unitCount(type)}
          inactive={!type.active}
          strong
        />
      </h3>
      {!fits && <Unfit group={group} calendars={count} />}
      {fits && takesBookingsWithoutRoom(type) && (
        <Notice tone="warning" className="m-3 mb-0">
          Bookings for {type.name} are taken without a room, and our calendar lists only the
          bookings that have one. Until someone gives such a booking its room, the sites still see
          its dates as free. Under Settings, change how units are assigned for this room type, so
          that every booking is tied to a unit straight away.
        </Notice>
      )}
      <ul className="divide-y divide-line">
        {units.map(({ unit, own, offered }) => (
          <li key={unit.id} data-unit={unit.id} className="flex flex-col gap-3 px-3 py-3">
            <h4 className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              {unit.name}
              {!unit.active && <Badge tone="warning">Inactive</Badge>}
            </h4>
            {own.map((calendar) => (
              <CalendarFields
                key={calendar.key}
                calendar={calendar}
                unitName={unit.name}
                saved={calendar.id ? saved.get(calendar.id) : undefined}
                errors={errors?.get(calendar.key)}
                suggestionsId={suggestionsId}
                disabled={disabled}
                live={live}
                now={now}
                onChange={(change) => onChange(calendar.key, change)}
                onRemove={() => onRemove(calendar)}
              />
            ))}
            {offered && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                  size="sm"
                  icon={<Plus className="size-3.5" />}
                  data-add
                  disabled={disabled}
                  aria-label={`Add a calendar for ${unit.name}`}
                  onClick={() => onAdd(unit.id)}
                >
                  Add a calendar
                </Button>
                {own.length === 0 && (
                  <span className="text-[13px] text-ink-faint">
                    No calendar yet. Add one for each site this unit is listed on.
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
