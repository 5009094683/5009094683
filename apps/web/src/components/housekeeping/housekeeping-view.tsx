'use client';

import { BedDouble, ListPlus, Plus, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { CleaningForecast } from '@/components/insights/cleaning-forecast';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { EmptyState, ErrorState, Notice, PageHeader, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatWeekday, plural } from '@/lib/format';
import { useStoredState } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Property } from '@/lib/types';
import {
  NO_FLOOR,
  filterUnits,
  floorLabel,
  floorsOf,
  groupUnits,
  type BoardFilters,
  type Grouping,
} from './board';
import { BulkBar, CountsStrip, GroupingToggle } from './board-controls';
import { useReturnFocus } from './focus';
import { STATES, STATE_LABELS, TASK_KIND_LABELS, finishedText } from './labels';
import { NoAccess } from './no-access';
import { PropertyPicker, usePropertyFor } from './property-picker';
import { staffFor } from './staff';
import { AddTaskDialog, EditTaskDialog } from './task-dialog';
import { TOUCH, type BoardActions } from './task-row';
import type { Board, BoardUnit, SettableState, StaffMember } from './types';
import { UnitCard } from './unit-card';

const ALL_FLOORS = '*';

/** How the board is laid out, remembered on this device. */
interface BoardView {
  grouping: Grouping;
  mine: boolean;
}

/** The rooms the board is narrowed to. Remembered for each property: floors differ between them. */
type Narrowing = Pick<BoardFilters, 'state' | 'floor'>;

const EVERY_ROOM: Narrowing = { state: null, floor: null };

function BoardScreen({
  property,
  properties,
  onSelect,
}: {
  property: Property;
  properties: Property[];
  onSelect: (id: string) => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const canWrite = auth.can('housekeeping.write', property.id);
  const {
    data: board,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<Board>(`/properties/${property.id}/housekeeping`);
  const { data: staffData } = useSWR<{ staff: StaffMember[] }>(
    canWrite ? `/properties/${property.id}/staff` : null,
  );
  const staff = useMemo(() => staffFor(staffData?.staff ?? [], 'housekeeping'), [staffData]);

  useLive(/^(task|unit|reservation)\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || e.propertyId === property.id)) void mutate();
  });

  const [view, setView] = useStoredState<BoardView>('pms.housekeeping.view', {
    grouping: 'floor',
    mine: false,
  });
  const [narrowing, setNarrowing] = useStoredState<Narrowing>(
    `pms.housekeeping.rooms.${property.id}`,
    EVERY_ROOM,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlyMap<string, string>>(new Map());
  const [adding, setAdding] = useState<{ unitId?: string } | null>(null);
  const [editing, setEditing] = useState<{ unitId: string; taskId: string } | null>(null);
  const rememberOpener = useReturnFocus(adding !== null || editing !== null);

  const header = (
    <PageHeader
      title="Housekeeping"
      description={board ? formatWeekday(board.date) : undefined}
      actions={
        <PropertyPicker
          property={property}
          properties={properties}
          onSelect={onSelect}
          className={TOUCH}
        />
      }
    />
  );

  if (error && !board) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
        {header}
        <ErrorState error={error} onRetry={() => void mutate()} />
      </div>
    );
  }
  if (isLoading || !board) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
        {header}
        <PageLoading label="Loading rooms" />
      </div>
    );
  }

  /** Saves one change, then reloads the board before the control comes back to life. */
  const run = async (key: string, what: string, action: () => Promise<void>) => {
    setBusy((current) => new Map(current).set(key, what));
    try {
      await action();
      await mutate();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
  };

  const setStatus = async (units: BoardUnit[], state: SettableState): Promise<number> => {
    const { changed } = await api<{ changed: number }>(
      `/properties/${property.id}/housekeeping/status`,
      { body: { unitIds: units.map((u) => u.unitId), status: state } },
    );
    return changed;
  };

  // A change that shows on the card itself is not announced as well: on a phone
  // the message would cover the next thing to tap.
  const actions: BoardActions | null = canWrite
    ? {
        busy,
        staff,
        setState: (unit, state) =>
          void run(`unit:${unit.unitId}`, state, async () => {
            await setStatus([unit], state);
          }),
        setTaskStatus: (unit, task, status) =>
          void run(`task:${task.id}`, status, async () => {
            await api(`/housekeeping/tasks/${task.id}`, { method: 'PATCH', body: { status } });
            if (status === 'done') {
              toast.success(`${TASK_KIND_LABELS[task.kind]} done`, finishedText(task, unit));
            }
          }),
        assign: (_unit, task, personId) =>
          void run(`task:${task.id}`, 'assign', async () => {
            await api(`/housekeeping/tasks/${task.id}`, {
              method: 'PATCH',
              body: { assignedTo: personId },
            });
          }),
        editTask: (unit, task) => {
          rememberOpener();
          setEditing({ unitId: unit.unitId, taskId: task.id });
        },
        addTask: (unit) => {
          rememberOpener();
          setAdding({ unitId: unit.unitId });
        },
      }
    : null;

  const floors = floorsOf(board.units);
  const hasFloors = floors.some((f) => f !== NO_FLOOR);
  const grouping: Grouping = hasFloors ? view.grouping : 'type';
  // What was remembered may no longer fit: a floor can lose its last room, and with it its choice.
  const state = STATES.find((s) => s === narrowing.state) ?? null;
  const floor = floors.length > 1 ? (floors.find((f) => f === narrowing.floor) ?? null) : null;
  // Only people who can be given tasks have the "My tasks" switch, so only they can be held to it.
  const filters: BoardFilters = { state, floor, mine: canWrite && view.mine };
  const visible = filterUnits(board.units, filters, auth.me.user.id);
  const groups = groupUnits(visible, grouping);
  const showAll = () => {
    setNarrowing(EVERY_ROOM);
    setView({ ...view, mine: false });
  };
  // Only rooms on screen count as selected, so a filter never hides a room that is about to change.
  const chosen = visible.filter((u) => u.status !== 'out_of_service' && selected.has(u.unitId));

  const select = (unitIds: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of unitIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const markChosen = (state: SettableState) =>
    void run('bulk', state, async () => {
      const changed = await setStatus(chosen, state);
      const label = STATE_LABELS[state].toLowerCase();
      const unchanged = chosen.length - changed;
      toast.success(
        `${plural(changed, 'room')} marked ${label}`,
        unchanged > 0
          ? `${plural(unchanged, 'room was', 'rooms were')} already ${label}.`
          : undefined,
      );
      setSelected(new Set());
    });

  const refresh = () =>
    void run('refresh', 'refresh', async () => {
      const { added } = await api<{ added: number }>(
        `/properties/${property.id}/housekeeping/refresh`,
        { method: 'POST' },
      );
      if (added > 0) toast.success(`${plural(added, 'task')} added to today's list`);
      else toast.info("Today's list is up to date", 'No new departures or stay-overs to add.');
    });

  const editingUnit = editing ? board.units.find((u) => u.unitId === editing.unitId) : undefined;
  const editingTask = editingUnit?.tasks.find((t) => t.id === editing?.taskId);

  return (
    <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
      {header}

      {/* A board that has stopped updating looks just like one that is up to date. */}
      {error && (
        <Notice tone="warning" className="mb-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p>The board could not be updated, so it may be out of date.</p>
            <Button className={TOUCH} loading={isValidating} onClick={() => void mutate()}>
              Try again
            </Button>
          </div>
        </Notice>
      )}

      <CleaningForecast property={property} hotelDay={board.date} />

      {board.units.length === 0 ? (
        <EmptyState
          icon={<BedDouble className="size-5" />}
          title="No rooms yet"
          description={`Add rooms to ${property.name} under Settings, Properties.`}
        />
      ) : (
        <>
          <CountsStrip
            board={board}
            state={state}
            onState={(next) => setNarrowing({ state: next, floor })}
          />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            {floors.length > 1 && (
              <Select
                aria-label="Floor"
                value={floor ?? ALL_FLOORS}
                onChange={(event) =>
                  setNarrowing({
                    state,
                    floor: event.target.value === ALL_FLOORS ? null : event.target.value,
                  })
                }
                className={cn(TOUCH, 'w-auto')}
              >
                <option value={ALL_FLOORS}>All floors</option>
                {floors.map((f) => (
                  <option key={f} value={f}>
                    {floorLabel(f)}
                  </option>
                ))}
              </Select>
            )}
            {canWrite && (
              <button
                type="button"
                aria-pressed={filters.mine}
                onClick={() => setView({ ...view, mine: !view.mine })}
                className={cn(
                  TOUCH,
                  'inline-flex items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
                  filters.mine
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-line-strong bg-surface text-ink shadow-sm hover:bg-sunken',
                )}
              >
                <UserRound className="size-4" aria-hidden />
                My tasks
              </button>
            )}
            {hasFloors && (
              <GroupingToggle
                value={grouping}
                onChange={(next) => setView({ ...view, grouping: next })}
              />
            )}
            {canWrite && (
              <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                <Button
                  className={TOUCH}
                  icon={<ListPlus className="size-4" aria-hidden />}
                  loading={busy.has('refresh')}
                  onClick={refresh}
                >
                  Write today&apos;s list
                </Button>
                <Button
                  variant="primary"
                  className={TOUCH}
                  icon={<Plus className="size-4" aria-hidden />}
                  onClick={() => {
                    rememberOpener();
                    setAdding({});
                  }}
                >
                  Add task
                </Button>
              </div>
            )}
          </div>

          {canWrite && (
            <p className="mb-4 text-xs text-ink-faint">
              Marking a clean as done makes the room clean. Marking an inspection as done makes it
              inspected.
            </p>
          )}

          {/* The filters are remembered, so the board says when they are hiding rooms. */}
          {visible.length > 0 && visible.length < board.units.length && (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-sunken pl-3.5 text-[13px] text-ink-soft">
              <p aria-live="polite">
                Showing {visible.length} of {plural(board.units.length, 'room')}.
              </p>
              <button
                type="button"
                onClick={showAll}
                className="h-11 shrink-0 rounded-md px-3.5 font-medium text-brand-700 hover:underline sm:h-9"
              >
                Show all rooms
              </button>
            </div>
          )}

          {groups.length === 0 ? (
            <EmptyState
              icon={<BedDouble className="size-5" />}
              title={filters.mine ? 'No tasks are assigned to you here' : 'No rooms match'}
              description="The other rooms are hidden by the filters."
              action={
                <Button className={TOUCH} onClick={showAll}>
                  Show all rooms
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((group) => {
                const selectable = group.units
                  .filter((u) => u.status !== 'out_of_service')
                  .map((u) => u.unitId);
                const allSelected =
                  selectable.length > 0 && selectable.every((id) => selected.has(id));
                return (
                  <section key={group.key} aria-label={group.label}>
                    <div className="mb-1 flex min-h-9 items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-ink">
                        {group.label}
                        <span className="ml-2 font-normal text-ink-faint">
                          {plural(group.units.length, 'room')}
                        </span>
                      </h2>
                      {canWrite && selectable.length > 0 && (
                        <button
                          type="button"
                          onClick={() => select(selectable, !allSelected)}
                          className="-mr-2 h-11 rounded-md px-2 text-[13px] font-medium text-brand-700 hover:underline sm:h-8"
                        >
                          {allSelected ? 'Clear selection' : 'Select all'}
                          <span className="sr-only"> in {group.label}</span>
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {group.units.map((unit) => (
                        <UnitCard
                          key={unit.unitId}
                          unit={unit}
                          timezone={property.timezone}
                          actions={actions}
                          selected={selected.has(unit.unitId)}
                          onSelect={(on) => select([unit.unitId], on)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}

          {chosen.length > 0 && (
            <BulkBar
              count={chosen.length}
              saving={busy.get('bulk')}
              onMark={markChosen}
              onClear={() => setSelected(new Set())}
            />
          )}
        </>
      )}

      {adding && (
        <AddTaskDialog
          propertyId={property.id}
          board={board}
          staff={staff}
          unitId={adding.unitId}
          onClose={() => setAdding(null)}
          onSaved={() => void mutate()}
        />
      )}
      {editingUnit && editingTask && (
        <EditTaskDialog
          task={editingTask}
          unit={editingUnit}
          staff={staff}
          onClose={() => setEditing(null)}
          onSaved={() => void mutate()}
        />
      )}
    </div>
  );
}

/** The housekeeping board: every room's cleaning state and the day's tasks, built for a phone. */
export function HousekeepingView() {
  const auth = useAuth();
  const { property, properties, select, isLoading, error, retry } =
    usePropertyFor('housekeeping.read');
  if (!auth.can('housekeeping.read')) return <NoAccess />;
  if (isLoading) return <PageLoading />;
  if (!property) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
        <PageHeader title="Housekeeping" />
        {error ? (
          <ErrorState error={error} onRetry={retry} />
        ) : (
          <EmptyState
            icon={<BedDouble className="size-5" />}
            title="No property to show"
            description="Ask an organisation admin to give you housekeeping access to a property."
          />
        )}
      </div>
    );
  }
  // Keyed so that the selection starts afresh at another property, with that property's own filters.
  return (
    <BoardScreen key={property.id} property={property} properties={properties} onSelect={select} />
  );
}
