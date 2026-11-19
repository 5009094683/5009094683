'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { PropertyDetail } from '@/lib/types';
import {
  SITE_SUGGESTIONS,
  calendarErrors,
  draftOf,
  lostBySaving,
  sameCalendars,
  toInput,
  unitGroups,
  type CalendarField,
  type DraftCalendar,
} from './calendar-draft';
import { calendarName } from './calendar-status';
import { CalendarUnitGroup } from './calendar-unit-group';
import { isLive, joinList } from './labels';
import type { CalendarFeed, Connection } from './types';
import { SaveBar } from './unsaved';

const FIELDS: CalendarField[] = ['label', 'code', 'url'];

/** What becomes of what was read from the calendars of sites that are no longer read. */
function whatStays(one: boolean): string {
  return `Bookings and blocked dates that came from ${one ? 'it' : 'them'} stay here for staff to deal with.`;
}

/** What goes with the calendars that saving removes. Only one that was read has brought anything in. */
function whatGoesWith(removed: CalendarFeed[]): string {
  const one = removed.length === 1;
  const stops = one
    ? 'The address of our calendar that was given to the site stops working'
    : 'The addresses of our calendars that were given to the sites stop working';
  if (!removed.some((feed) => feed.importUrl)) return `${stops}.`;
  return `${stops}, and ${one ? 'the calendar of the site is' : 'the calendars of the sites are'} no longer read. ${whatStays(one)}`;
}

/** What saving takes away for good, said before it is saved. */
function LostBySaving({ saved, draft }: { saved: CalendarFeed[]; draft: DraftCalendar[] }) {
  const { removed, noLongerRead, readElsewhere } = lostBySaving(saved, draft);
  if (removed.length === 0 && noLongerRead.length === 0 && readElsewhere.length === 0) return null;
  return (
    <Notice tone="warning">
      {removed.length > 0 && (
        <p>
          Saving removes {joinList(removed.map(calendarName))}. {whatGoesWith(removed)}
        </p>
      )}
      {noLongerRead.length > 0 && (
        <p>
          Saving leaves {joinList(noLongerRead.map(calendarName))} without{' '}
          {noLongerRead.length === 1
            ? 'the address of the calendar of the site'
            : 'the addresses of the calendars of the sites'}
          , so bookings made there no longer arrive here. {whatStays(noLongerRead.length === 1)}
        </p>
      )}
      {readElsewhere.length > 0 && (
        <p>
          Saving changes where {joinList(readElsewhere.map(calendarName))}{' '}
          {readElsewhere.length === 1 ? 'is' : 'are'} read from. Bookings that came from the old
          address and are not in the new calendar are cancelled here once two reads have missed
          them.
        </p>
      )}
    </Notice>
  );
}

/**
 * The calendars of a connection, unit by unit. Changes are kept here until saved; saving
 * replaces the whole set, so what is sent is always every calendar as it stands on screen.
 */
export function CalendarsEditor({
  connection,
  feeds,
  roomTypes,
  now,
  onSaved,
}: {
  connection: Connection;
  feeds: CalendarFeed[];
  roomTypes: PropertyDetail['roomTypes'];
  now: Date;
  onSaved: (feeds: CalendarFeed[]) => Promise<unknown>;
}) {
  const toast = useToast();
  const suggestionsId = useId();
  const root = useRef<HTMLDivElement>(null);
  const newKeys = useRef(0);
  const saved = useMemo(() => draftOf(feeds), [feeds]);
  const savedById = useMemo(() => new Map(feeds.map((feed) => [feed.id, feed])), [feeds]);
  // Null while nothing has been changed, so that the fields follow what is saved. `from` is what
  // was saved when the changes began, to notice that someone else has saved in the meantime.
  const [editing, setEditing] = useState<{ draft: DraftCalendar[]; from: DraftCalendar[] } | null>(
    null,
  );
  // Mistakes are pointed out once saving has been tried, not while a field is still being typed.
  const [checked, setChecked] = useState(false);
  // What to hand the keyboard to once the screen has caught up: the first of these that is there.
  const [focus, setFocus] = useState<string[] | null>(null);

  const changed = editing !== null && !sameCalendars(editing.draft, editing.from);
  const current = changed ? editing.draft : saved;
  const dirty = changed && !sameCalendars(current, saved);
  const changedElsewhere = changed && !sameCalendars(editing.from, saved);
  const errors = useMemo(() => calendarErrors(current), [current]);
  const groups = unitGroups(roomTypes, current);
  const live = isLive(connection);

  useEffect(() => {
    if (!focus) return;
    for (const selector of focus) {
      const target = root.current?.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus();
        return;
      }
    }
  }, [focus]);

  const change = (draft: DraftCalendar[]) =>
    setEditing({ draft, from: changed ? editing.from : saved });

  const add = (unitId: string) => {
    newKeys.current += 1;
    const key = `new-${newKeys.current}`;
    change([...current, { key, unitId, label: '', code: '', url: '', treatAs: 'auto' }]);
    setFocus([`[data-calendar="${key}"] [data-field="label"]`]);
  };

  const remove = (calendar: DraftCalendar) => {
    change(current.filter((other) => other.key !== calendar.key));
    setFocus([`[data-unit="${calendar.unitId}"] [data-add]`, '[data-editor]']);
  };

  const save = useAction(async () => {
    const result = await api<{ feeds: CalendarFeed[] }>(
      `/channels/connections/${connection.id}/ical/feeds`,
      { method: 'PUT', body: { feeds: toInput(current) } },
    );
    // In one go, so that the fields never show the old calendars or a half-saved state.
    const refreshed = onSaved(result.feeds);
    setEditing(null);
    setChecked(false);
    await refreshed;
    const read = live && result.feeds.some((feed) => feed.importUrl);
    // Saving does not start a read by itself, and the next one may be minutes away.
    if (read) {
      void api(`/channels/connections/${connection.id}/pull`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    toast.success(
      'Calendars saved',
      read ? 'The calendars of the sites are being read now.' : undefined,
    );
  });

  const trySave = () => {
    setChecked(true);
    // In the order of the screen, so that the keyboard goes to the first mistake from the top.
    const shown = groups.flatMap((group) =>
      group.units.flatMap((unit) => current.filter((calendar) => calendar.unitId === unit.id)),
    );
    const wrong = shown.find((calendar) => errors.has(calendar.key));
    if (wrong) {
      const field = FIELDS.find((name) => errors.get(wrong.key)?.[name]);
      setFocus([`[data-calendar="${wrong.key}"] [data-field="${field}"]`]);
      return;
    }
    void save.run();
  };

  if (groups.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        This property has no units yet. Add them under Settings, then come back here.
      </p>
    );
  }

  return (
    <div ref={root} data-editor tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <datalist id={suggestionsId}>
        {SITE_SUGGESTIONS.map((site) => (
          <option key={site} value={site} />
        ))}
      </datalist>
      <ul className="flex flex-col gap-3">
        {groups.map((group) => (
          <CalendarUnitGroup
            key={group.type.id}
            group={group}
            calendars={current}
            saved={savedById}
            errors={checked ? errors : undefined}
            suggestionsId={suggestionsId}
            disabled={save.busy}
            live={live}
            now={now}
            onAdd={add}
            onChange={(key, patch) =>
              change(
                current.map((calendar) =>
                  calendar.key === key ? { ...calendar, ...patch } : calendar,
                ),
              )
            }
            onRemove={remove}
          />
        ))}
      </ul>

      {dirty && <LostBySaving saved={feeds} draft={current} />}
      {changedElsewhere && (
        <Notice tone="warning">
          The calendars were changed by someone else while you were working on them. Saving puts
          yours in place of theirs. To see theirs, discard your changes.
        </Notice>
      )}
      {checked && errors.size > 0 && (
        <Notice tone="danger">
          {errors.size === 1
            ? 'One calendar needs correcting before the calendars can be saved.'
            : `${errors.size} calendars need correcting before the calendars can be saved.`}
        </Notice>
      )}
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      <SaveBar
        label="Save calendars"
        what="the calendars"
        dirty={dirty}
        busy={save.busy}
        onSave={trySave}
        onDiscard={() => {
          setEditing(null);
          setChecked(false);
          save.clearError();
        }}
      />
    </div>
  );
}
