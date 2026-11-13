'use client';

import { BedDouble, Save, Tag } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { PropertyDetail } from '@/lib/types';
import { isLive, joinList } from './labels';
import type { ChannelManagerStructure, Connection, Mappings } from './types';

type PmsRoomType = PropertyDetail['roomTypes'][number];
type PmsRatePlan = PmsRoomType['ratePlans'][number];

/** Which channel manager room or rate each PMS room type or rate plan stands for, by id. */
interface Draft {
  rooms: Record<string, string>;
  rates: Record<string, string>;
}

function savedDraft(mappings: Mappings): Draft {
  return {
    rooms: Object.fromEntries(mappings.roomTypes.map((m) => [m.roomTypeId, m.externalId])),
    rates: Object.fromEntries(mappings.ratePlans.map((m) => [m.ratePlanId, m.externalId])),
  };
}

function sameEntries(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

interface Row {
  type: PmsRoomType;
  plans: PmsRatePlan[];
}

/**
 * The room types and rate plans worth showing: the ones in use, and any
 * switched-off one that is still mapped, so that it can be unmapped.
 */
function mappingRows(roomTypes: PmsRoomType[], ...drafts: Draft[]): Row[] {
  const mapped = (kind: 'rooms' | 'rates', id: string) =>
    drafts.some((draft) => draft[kind][id] !== undefined);
  return roomTypes
    .filter((type) => type.active || mapped('rooms', type.id))
    .map((type) => ({
      type,
      plans: type.ratePlans.filter((plan) => plan.active || mapped('rates', plan.id)),
    }));
}

/** How far the mapping has got, for the checklist. */
export function mappingProgress(
  roomTypes: PmsRoomType[],
  mappings: Mappings,
): 'todo' | 'partial' | 'done' {
  if (mappings.roomTypes.length === 0) return 'todo';
  const saved = savedDraft(mappings);
  const complete = roomTypes
    .filter((type) => type.active)
    .every(
      (type) =>
        saved.rooms[type.id] !== undefined &&
        type.ratePlans.filter((plan) => plan.active).every((plan) => saved.rates[plan.id]),
    );
  return complete ? 'done' : 'partial';
}

function RowLabel({
  htmlFor,
  icon,
  name,
  detail,
  inactive,
  strong,
}: {
  htmlFor?: string;
  icon: ReactNode;
  name: string;
  detail?: string;
  inactive: boolean;
  strong?: boolean;
}) {
  // Side by side, only the name of a rate plan steps in, so that the selects stay in one column.
  const className = cn('flex min-w-0 items-center gap-2 text-sm', !strong && 'sm:pl-6');
  const content = (
    <>
      <span className="shrink-0 text-ink-faint [&>svg]:size-4">{icon}</span>
      <span className={cn('min-w-0 truncate text-ink', strong && 'font-medium')}>{name}</span>
      {detail && <span className="shrink-0 text-xs text-ink-faint">{detail}</span>}
      {inactive && <Badge tone="warning">Inactive</Badge>}
    </>
  );
  return htmlFor ? (
    <label htmlFor={htmlFor} className={className}>
      {content}
    </label>
  ) : (
    <span className={className}>{content}</span>
  );
}

const GRID = 'grid grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-2';
/** On a narrow screen a rate plan and its select are stacked, and step in together. */
const RATE_GRID = `${GRID} pl-6 sm:pl-0`;

function ColumnHeadings() {
  return (
    <div
      aria-hidden
      className={cn(
        GRID,
        'hidden border-b border-line bg-sunken/60 px-3 py-2 text-xs font-medium text-ink-faint sm:grid',
      )}
    >
      <span>Room types and rate plans here</span>
      <span>Rooms and rates in the channel manager</span>
    </div>
  );
}

const unitCount = (type: PmsRoomType): string =>
  plural(type.units.filter((unit) => unit.active).length, 'unit');

/** The saved mapping, for people who may look but not change it. */
export function MappingSummary({
  roomTypes,
  mappings,
}: {
  roomTypes: PmsRoomType[];
  mappings: Mappings;
}) {
  const saved = savedDraft(mappings);
  const rows = mappingRows(roomTypes, saved);
  const roomNames = new Map(mappings.roomTypes.map((m) => [m.roomTypeId, m.externalName]));
  const rateNames = new Map(mappings.ratePlans.map((m) => [m.ratePlanId, m.externalName]));
  const target = (mapped: boolean, name: string | null | undefined) =>
    mapped ? (
      <span className="text-sm text-ink">{name ?? 'Mapped'}</span>
    ) : (
      <span className="text-sm text-ink-faint">Not mapped</span>
    );

  if (rows.length === 0) {
    return <p className="text-ink-faint">This property has no room types yet.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <ColumnHeadings />
      <ul className="divide-y divide-line">
        {rows.map(({ type, plans }) => (
          <li key={type.id} className="flex flex-col gap-2 px-3 py-3">
            <div className={GRID}>
              <RowLabel
                icon={<BedDouble />}
                name={type.name}
                detail={unitCount(type)}
                inactive={!type.active}
                strong
              />
              {target(saved.rooms[type.id] !== undefined, roomNames.get(type.id))}
            </div>
            {plans.map((plan) => (
              <div key={plan.id} className={RATE_GRID}>
                <RowLabel icon={<Tag />} name={plan.name} inactive={!plan.active} />
                {target(saved.rates[plan.id] !== undefined, rateNames.get(plan.id))}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Says which channel manager room each PMS room type is, and which of that
 * room's rates each rate plan is. Changes are kept here until saved; saving
 * replaces the whole mapping.
 */
export function MappingEditor({
  connection,
  roomTypes,
  structure,
  mappings,
  onSaved,
}: {
  connection: Connection;
  roomTypes: PmsRoomType[];
  structure: ChannelManagerStructure;
  mappings: Mappings;
  onSaved: () => Promise<unknown>;
}) {
  const toast = useToast();
  const baseId = useId();
  const saved = useMemo(() => savedDraft(mappings), [mappings]);
  // Null while nothing has been changed, so that the selects follow what is saved.
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = draft ?? saved;
  const dirty =
    draft !== null &&
    !(sameEntries(draft.rooms, saved.rooms) && sameEntries(draft.rates, saved.rates));

  const rows = mappingRows(roomTypes, current, saved);
  const roomTitles = new Map(structure.roomTypes.map((room) => [room.id, room.title]));
  const rateTitles = new Map(structure.ratePlans.map((rate) => [rate.id, rate.title]));
  const savedRoomNames = new Map(mappings.roomTypes.map((m) => [m.externalId, m.externalName]));
  const savedRateNames = new Map(mappings.ratePlans.map((m) => [m.externalId, m.externalName]));

  const roomUsedBy = (externalId: string, except: string): string | undefined =>
    rows.find(({ type }) => type.id !== except && current.rooms[type.id] === externalId)?.type.name;
  const rateUsedBy = (externalId: string, except: string): string | undefined =>
    rows
      .flatMap(({ plans }) => plans)
      .find((plan) => plan.id !== except && current.rates[plan.id] === externalId)?.name;

  const setRoom = (type: PmsRoomType, externalId: string) => {
    const next: Draft = { rooms: { ...current.rooms }, rates: { ...current.rates } };
    if (externalId) next.rooms[type.id] = externalId;
    else delete next.rooms[type.id];
    // A rate belongs to one channel manager room: rates chosen for the previous room no longer fit.
    for (const plan of type.ratePlans) {
      const rate = next.rates[plan.id];
      if (rate === undefined) continue;
      const belongsTo = structure.ratePlans.find((r) => r.id === rate)?.roomTypeId;
      if (!externalId || belongsTo !== externalId) delete next.rates[plan.id];
    }
    setDraft(next);
  };

  const setRate = (plan: PmsRatePlan, externalId: string) => {
    const next: Draft = { rooms: current.rooms, rates: { ...current.rates } };
    if (externalId) next.rates[plan.id] = externalId;
    else delete next.rates[plan.id];
    setDraft(next);
  };

  const save = useAction(async () => {
    await api<Mappings>(`/channels/connections/${connection.id}/mappings`, {
      method: 'PUT',
      body: {
        roomTypes: rows
          .filter(({ type }) => current.rooms[type.id] !== undefined)
          .map(({ type }) => {
            const externalId = current.rooms[type.id]!;
            return {
              roomTypeId: type.id,
              externalId,
              externalName: roomTitles.get(externalId) ?? savedRoomNames.get(externalId) ?? null,
            };
          }),
        ratePlans: rows
          .flatMap(({ plans }) => plans)
          .filter((plan) => current.rates[plan.id] !== undefined)
          .map((plan) => {
            const externalId = current.rates[plan.id]!;
            return {
              ratePlanId: plan.id,
              externalId,
              externalName: rateTitles.get(externalId) ?? savedRateNames.get(externalId) ?? null,
            };
          }),
      },
    });
    await onSaved();
    setDraft(null);
    toast.success(
      'Mapping saved',
      isLive(connection)
        ? 'All availability and rates are being sent again so the booking sites match.'
        : undefined,
    );
  });

  const unmappedRooms = rows
    .filter(({ type }) => type.active && current.rooms[type.id] === undefined)
    .map(({ type }) => type.name);
  const unmappedRates = rows
    .filter(({ type }) => current.rooms[type.id] !== undefined)
    .flatMap(({ plans }) => plans)
    .filter((plan) => plan.active && current.rates[plan.id] === undefined).length;

  if (rows.length === 0) {
    return (
      <p className="text-ink-faint">
        This property has no room types yet. Add them under Settings, then come back here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {structure.roomTypes.length === 0 && (
        <Notice tone="info">
          The channel manager property has no rooms yet. Use &quot;Add anything missing&quot; in
          step 1 to create them from the room types here.
        </Notice>
      )}
      <div className="overflow-hidden rounded-lg border border-line">
        <ColumnHeadings />
        <ul className="divide-y divide-line">
          {rows.map(({ type, plans }) => {
            const room = current.rooms[type.id] ?? '';
            const roomId = `${baseId}-room-${type.id}`;
            const rates = structure.ratePlans.filter((rate) => rate.roomTypeId === room);
            return (
              <li key={type.id} className="flex flex-col gap-2 px-3 py-3">
                <div className={GRID}>
                  <RowLabel
                    htmlFor={roomId}
                    icon={<BedDouble />}
                    name={type.name}
                    detail={unitCount(type)}
                    inactive={!type.active}
                    strong
                  />
                  <Select
                    id={roomId}
                    aria-label={`Channel manager room for ${type.name}`}
                    value={room}
                    disabled={save.busy}
                    onChange={(e) => setRoom(type, e.target.value)}
                  >
                    <option value="">Not mapped</option>
                    {room && !roomTitles.has(room) && (
                      <option value={room}>
                        {savedRoomNames.get(room) ?? 'A room'} (no longer in the channel manager)
                      </option>
                    )}
                    {structure.roomTypes.map((option) => {
                      const usedBy = roomUsedBy(option.id, type.id);
                      return (
                        <option key={option.id} value={option.id} disabled={usedBy !== undefined}>
                          {option.title} ({plural(option.countOfRooms, 'room')})
                          {usedBy ? `, used for ${usedBy}` : ''}
                        </option>
                      );
                    })}
                  </Select>
                </div>
                {plans.map((plan) => {
                  const rate = current.rates[plan.id] ?? '';
                  const rateId = `${baseId}-rate-${plan.id}`;
                  return (
                    <div key={plan.id} className={RATE_GRID}>
                      <RowLabel
                        htmlFor={rateId}
                        icon={<Tag />}
                        name={plan.name}
                        inactive={!plan.active}
                      />
                      <Select
                        id={rateId}
                        aria-label={`Channel manager rate for ${plan.name} of ${type.name}`}
                        value={rate}
                        disabled={save.busy || !room}
                        onChange={(e) => setRate(plan, e.target.value)}
                      >
                        <option value="">{room ? 'Not mapped' : 'Map the room first'}</option>
                        {rate && !rates.some((option) => option.id === rate) && (
                          <option value={rate}>
                            {savedRateNames.get(rate) ?? 'A rate'} (no longer a rate of this room)
                          </option>
                        )}
                        {rates.map((option) => {
                          const usedBy = rateUsedBy(option.id, plan.id);
                          return (
                            <option
                              key={option.id}
                              value={option.id}
                              disabled={usedBy !== undefined}
                            >
                              {option.title}
                              {usedBy ? `, used for ${usedBy}` : ''}
                            </option>
                          );
                        })}
                      </Select>
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      </div>

      {(unmappedRooms.length > 0 || unmappedRates > 0) && (
        <Notice tone="warning">
          {unmappedRooms.length > 0 && (
            <p>
              {unmappedRooms.length <= 4
                ? `${joinList(unmappedRooms)} ${unmappedRooms.length === 1 ? 'is' : 'are'} not mapped.`
                : `${unmappedRooms.length} room types are not mapped.`}{' '}
              A room that is not mapped is not sent to the booking sites, and bookings for it cannot
              be recorded here.
            </p>
          )}
          {unmappedRates > 0 && (
            <p>
              {unmappedRates === 1
                ? '1 rate plan of a mapped room is not mapped.'
                : `${unmappedRates} rate plans of mapped rooms are not mapped.`}{' '}
              The prices and rules of a rate plan that is not mapped are not sent to the booking
              sites.
            </p>
          )}
        </Notice>
      )}
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="primary"
          icon={<Save className="size-4" />}
          disabled={!dirty}
          loading={save.busy}
          onClick={() => void save.run()}
        >
          Save mapping
        </Button>
        {dirty && (
          <>
            <Button
              variant="ghost"
              disabled={save.busy}
              onClick={() => {
                setDraft(null);
                save.clearError();
              }}
            >
              Discard changes
            </Button>
            <span className="text-[13px] font-medium text-warning-700">Unsaved changes</span>
          </>
        )}
      </div>
    </div>
  );
}
