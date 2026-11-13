'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { PRIORITIES, PRIORITY_LABELS, TASK_KINDS, TASK_KIND_LABELS } from './labels';
import { PersonOptions } from './staff';
import type { Board, BoardTask, BoardUnit, Priority, StaffMember, TaskKind } from './types';

function PriorityOptions() {
  return PRIORITIES.map((priority) => (
    <option key={priority} value={priority}>
      {PRIORITY_LABELS[priority]}
    </option>
  ));
}

function roomsByType(units: BoardUnit[]): { type: string; units: BoardUnit[] }[] {
  const groups = new Map<string, BoardUnit[]>();
  for (const unit of units) {
    groups.set(unit.roomTypeName, [...(groups.get(unit.roomTypeName) ?? []), unit]);
  }
  return [...groups].map(([type, list]) => ({ type, units: list }));
}

/** Adds a task to today's list for one room. */
export function AddTaskDialog({
  propertyId,
  board,
  staff,
  unitId,
  onClose,
  onSaved,
}: {
  propertyId: string;
  board: Board;
  staff: StaffMember[];
  /** The room the dialog was opened from, if any. */
  unitId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [room, setRoom] = useState(unitId ?? '');
  const [wanted, setWanted] = useState<TaskKind>('touch_up');
  const [priority, setPriority] = useState<Priority>('normal');
  const [person, setPerson] = useState('');
  const [notes, setNotes] = useState('');

  const unit = board.units.find((u) => u.unitId === room);
  // A room has each kind of task at most once a day.
  const taken = new Set(unit?.tasks.map((t) => t.kind));
  const kind = taken.has(wanted) ? (TASK_KINDS.find((k) => !taken.has(k)) ?? wanted) : wanted;
  const full = taken.has(kind);

  const save = useAction(async () => {
    if (!unit) throw new Error('Choose a room');
    await api('/housekeeping/tasks', {
      body: {
        propertyId,
        unitId: unit.unitId,
        kind,
        priority,
        assignedTo: person || null,
        notes: notes.trim() || null,
      },
    });
    toast.success(`${TASK_KIND_LABELS[kind]} added for ${unit.unitName}`);
    onSaved();
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Add task"
      description="For today's list."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="add-task-form"
            variant="primary"
            loading={save.busy}
            disabled={full}
          >
            Add task
          </Button>
        </>
      }
    >
      <form
        id="add-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <Field label="Room">
          {(props) => (
            <Select
              {...props}
              required
              autoFocus={!unitId}
              value={room}
              onChange={(event) => setRoom(event.target.value)}
            >
              <option value="" disabled>
                Choose a room
              </option>
              {roomsByType(board.units).map((group) => (
                <optgroup key={group.type} label={group.type}>
                  {group.units.map((u) => (
                    <option key={u.unitId} value={u.unitId}>
                      {u.unitName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Task"
          error={full ? `${unit?.unitName} already has every kind of task today.` : null}
          hint={
            kind === 'inspection'
              ? 'When it is done, the room is marked inspected. The room has to be clean first.'
              : 'When it is done, the room is marked clean.'
          }
        >
          {(props) => (
            <Select
              {...props}
              value={kind}
              onChange={(event) => setWanted(event.target.value as TaskKind)}
            >
              {TASK_KINDS.map((k) => (
                <option key={k} value={k} disabled={taken.has(k)}>
                  {TASK_KIND_LABELS[k]}
                  {taken.has(k) ? ' (already on the list)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            {(props) => (
              <Select
                {...props}
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
              >
                <PriorityOptions />
              </Select>
            )}
          </Field>
          <Field label="Person">
            {(props) => (
              <Select {...props} value={person} onChange={(event) => setPerson(event.target.value)}>
                <PersonOptions staff={staff} area="housekeeping" />
              </Select>
            )}
          </Field>
        </div>
        <Field label="Notes" optional>
          {(props) => (
            <Textarea
              {...props}
              value={notes}
              maxLength={1000}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/** Changes who does a task, how pressing it is and its notes. */
export function EditTaskDialog({
  task,
  unit,
  staff,
  onClose,
  onSaved,
}: {
  task: BoardTask;
  unit: BoardUnit;
  staff: StaffMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [person, setPerson] = useState(task.assignedTo ?? '');
  const [notes, setNotes] = useState(task.notes ?? '');

  const save = useAction(async () => {
    const body: { priority?: Priority; assignedTo?: string | null; notes?: string | null } = {};
    if (priority !== task.priority) body.priority = priority;
    if ((person || null) !== task.assignedTo) body.assignedTo = person || null;
    if ((notes.trim() || null) !== task.notes) body.notes = notes.trim() || null;
    if (Object.keys(body).length > 0) {
      await api(`/housekeeping/tasks/${task.id}`, { method: 'PATCH', body });
      toast.success('Task saved');
      onSaved();
    }
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={TASK_KIND_LABELS[task.kind]}
      description={`${unit.unitName}, ${unit.roomTypeName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="edit-task-form" variant="primary" loading={save.busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="edit-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            {(props) => (
              <Select
                {...props}
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
              >
                <PriorityOptions />
              </Select>
            )}
          </Field>
          <Field label="Person">
            {(props) => (
              <Select {...props} value={person} onChange={(event) => setPerson(event.target.value)}>
                <PersonOptions
                  staff={staff}
                  area="housekeeping"
                  current={{ id: task.assignedTo, name: task.assignedToName }}
                />
              </Select>
            )}
          </Field>
        </div>
        <Field label="Notes" optional>
          {(props) => (
            <Textarea
              {...props}
              autoFocus
              value={notes}
              maxLength={1000}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
