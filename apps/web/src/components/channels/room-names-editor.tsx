'use client';

import { BedDouble } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { PropertyDetail } from '@/lib/types';
import { ColumnHeadings, GRID, RowLabel, unitCount } from './mapping-editor';
import type { Connection, Mappings } from './types';
import { SaveBar } from './unsaved';

type PmsRoomType = PropertyDetail['roomTypes'][number];

/** The name the sites use for each room type in their emails, by the id of the room type. */
type Names = Record<string, string>;

const HEADINGS = { ours: 'Room types here', theirs: 'Name in the emails of the sites' };
const MAX_LENGTH = 100;

function savedNames(mappings: Mappings): Names {
  return Object.fromEntries(
    mappings.roomTypes.map((m) => [m.roomTypeId, m.externalName ?? m.externalId]),
  );
}

/** Names are compared the way the server compares them: without regard to case or spacing. */
const normalise = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim();

function sameNames(a: Names, b: Names, roomTypes: PmsRoomType[]): boolean {
  return roomTypes.every((type) => (a[type.id] ?? '').trim() === (b[type.id] ?? '').trim());
}

/** The room types worth showing: the ones in use, and any other that still has a name. */
function rowsOf(roomTypes: PmsRoomType[], ...names: Names[]): PmsRoomType[] {
  return roomTypes.filter(
    (type) => type.active || names.some((set) => (set[type.id] ?? '').trim() !== ''),
  );
}

/** What is wrong with each name, by room type. The server names no room type in its answer. */
function nameErrors(rows: PmsRoomType[], names: Names): Map<string, string> {
  const errors = new Map<string, string>();
  const usedFor = new Map<string, string>();
  for (const type of rows) {
    const name = normalise(names[type.id] ?? '');
    if (!name) continue;
    const other = usedFor.get(name);
    if (other)
      errors.set(type.id, `${other} has this name already. A name can stand for one room type.`);
    else usedFor.set(name, type.name);
  }
  return errors;
}

/** The saved names, for people who may look at a connection but not change it. */
export function RoomNamesSummary({
  roomTypes,
  mappings,
}: {
  roomTypes: PmsRoomType[];
  mappings: Mappings;
}) {
  const saved = savedNames(mappings);
  const rows = rowsOf(roomTypes, saved);
  if (rows.length === 0) {
    return <p className="text-sm text-ink-faint">This property has no room types yet.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <ColumnHeadings {...HEADINGS} />
      <ul className="divide-y divide-line">
        {rows.map((type) => (
          <li key={type.id} className="px-3 py-3">
            <div className={GRID}>
              <RowLabel
                icon={<BedDouble />}
                name={type.name}
                detail={unitCount(type)}
                inactive={!type.active}
                strong
              />
              {saved[type.id] ? (
                <span className="text-sm text-ink">{saved[type.id]}</span>
              ) : (
                <span className="text-sm text-ink-faint">No other name entered</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Says what the sites call each room type in their booking emails, so that a booking can be
 * placed. Changes are kept here until saved; saving replaces every name.
 */
export function RoomNamesEditor({
  connection,
  roomTypes,
  mappings,
  onSaved,
}: {
  connection: Connection;
  roomTypes: PmsRoomType[];
  mappings: Mappings;
  onSaved: () => Promise<unknown>;
}) {
  const toast = useToast();
  const baseId = useId();
  const list = useRef<HTMLUListElement>(null);
  const saved = useMemo(() => savedNames(mappings), [mappings]);
  // Null while nothing has been changed, so that the fields follow what is saved.
  const [draft, setDraft] = useState<Names | null>(null);
  // Mistakes are pointed out once saving has been tried, not while a name is still being typed.
  const [checked, setChecked] = useState(false);
  const current = draft ?? saved;
  const rows = rowsOf(roomTypes, current, saved);
  const dirty = draft !== null && !sameNames(draft, saved, rows);
  const errors = nameErrors(rows, current);

  const save = useAction(async () => {
    await api<Mappings>(`/channels/connections/${connection.id}/mappings`, {
      method: 'PUT',
      body: {
        roomTypes: rows
          .map((type) => ({ roomTypeId: type.id, name: (current[type.id] ?? '').trim() }))
          .filter(({ name }) => name !== '')
          .map(({ roomTypeId, name }) => ({ roomTypeId, externalId: name, externalName: name })),
      },
    });
    await onSaved();
    setDraft(null);
    setChecked(false);
    toast.success(
      'Room names saved',
      'A booking that was held because its room was not known can now be applied again, under Bookings received.',
    );
  });

  const trySave = () => {
    setChecked(true);
    const wrong = rows.find((type) => errors.has(type.id));
    if (wrong) {
      list.current?.querySelector<HTMLElement>(`[data-room-type="${wrong.id}"]`)?.focus();
      return;
    }
    void save.run();
  };

  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        This property has no room types yet. Add them under Settings, then come back here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-line">
        <ColumnHeadings {...HEADINGS} />
        <ul ref={list} className="divide-y divide-line">
          {rows.map((type) => {
            const id = `${baseId}-${type.id}`;
            const error = checked ? errors.get(type.id) : undefined;
            return (
              <li key={type.id} className="px-3 py-3">
                <div className={GRID}>
                  <RowLabel
                    htmlFor={id}
                    icon={<BedDouble />}
                    name={type.name}
                    detail={unitCount(type)}
                    inactive={!type.active}
                    strong
                  />
                  <div className="flex flex-col gap-1">
                    <Input
                      id={id}
                      data-room-type={type.id}
                      aria-label={`Name the sites use for ${type.name} in their emails`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      maxLength={MAX_LENGTH}
                      autoComplete="off"
                      placeholder={`Only if it differs from ${type.name}`}
                      value={current[type.id] ?? ''}
                      disabled={save.busy}
                      onChange={(e) => setDraft({ ...current, [type.id]: e.target.value })}
                    />
                    {error && (
                      <p id={`${id}-error`} role="alert" className="text-[13px] text-danger-600">
                        {error}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      <SaveBar
        label="Save room names"
        what="the room names"
        dirty={dirty}
        busy={save.busy}
        onSave={trySave}
        onDiscard={() => {
          setDraft(null);
          setChecked(false);
          save.clearError();
        }}
      />
    </div>
  );
}
