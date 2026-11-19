'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property, RoomType } from '@/lib/types';
import { CodeInput, SwitchField } from './fields';
import { changedFields, textOrNull } from './form-values';
import { ASSIGNMENT_LABELS } from './labels';

interface Values {
  code: string;
  name: string;
  description: string;
  baseOccupancy: string;
  maxAdults: string;
  maxChildren: string;
  maxOccupancy: string;
  assignment: RoomType['assignment'];
  autoAssign: boolean;
  active: boolean;
}

function initialValues(property: Property, roomType: RoomType | undefined): Values {
  return {
    code: roomType?.code ?? '',
    name: roomType?.name ?? '',
    description: roomType?.description ?? '',
    baseOccupancy: String(roomType?.baseOccupancy ?? 2),
    maxAdults: String(roomType?.maxAdults ?? 2),
    maxChildren: String(roomType?.maxChildren ?? 0),
    maxOccupancy: String(roomType?.maxOccupancy ?? 2),
    assignment: roomType?.assignment ?? (property.kind === 'villa' ? 'at_booking' : 'at_check_in'),
    autoAssign: roomType?.autoAssign ?? true,
    active: roomType?.active ?? true,
  };
}

function bodyFrom(values: Values) {
  return {
    name: values.name.trim(),
    description: textOrNull(values.description),
    baseOccupancy: Number(values.baseOccupancy),
    maxAdults: Number(values.maxAdults),
    maxChildren: Number(values.maxChildren),
    maxOccupancy: Number(values.maxOccupancy),
    assignment: values.assignment,
    autoAssign: values.autoAssign,
    active: values.active,
  };
}

/** Adds a room type to a property, or edits one. */
export function RoomTypeDialog({
  property,
  roomType,
  hasLinkedUnits = false,
  nextSortOrder,
  onClose,
  onSaved,
}: {
  property: Property;
  /** The room type to edit; absent when adding one. */
  roomType?: RoomType;
  /** Linked units only work when bookings are tied to a unit, so the other choice is closed. */
  hasLinkedUnits?: boolean;
  /** Where a new room type goes in lists: after the ones that exist. */
  nextSortOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [initial] = useState(() => initialValues(property, roomType));
  const [values, setValues] = useState(initial);
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  const save = useAction(async () => {
    const body = bodyFrom(values);
    if (roomType) {
      const patch = changedFields(bodyFrom(initial), body);
      if (Object.keys(patch).length > 0) {
        await api(`/properties/${property.id}/room-types/${roomType.id}`, {
          method: 'PATCH',
          body: patch,
        });
        toast.success('Room type saved');
        onSaved();
      }
    } else {
      const { active: _active, ...fields } = body;
      await api(`/properties/${property.id}/room-types`, {
        body: { code: values.code.trim().toUpperCase(), ...fields, sortOrder: nextSortOrder },
      });
      toast.success(`${body.name} added`, 'Next, add its units and a rate plan.');
      onSaved();
    }
    onClose();
  });

  const minGuests = Math.max(Number(values.baseOccupancy) || 1, Number(values.maxAdults) || 1);

  return (
    <Dialog
      open
      onClose={onClose}
      title={roomType ? `Edit ${roomType.name}` : 'Add room type'}
      description={
        roomType
          ? `Code ${roomType.code}`
          : 'A kind of room or a whole villa that is sold at the same rates.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="room-type-form" variant="primary" loading={save.busy}>
            {roomType ? 'Save' : 'Add room type'}
          </Button>
        </>
      }
    >
      <form
        id="room-type-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" className={roomType ? 'sm:col-span-2' : undefined}>
            {(props) => (
              <Input
                {...props}
                value={values.name}
                onChange={(e) => change({ name: e.target.value })}
                maxLength={120}
                autoComplete="off"
                autoFocus
                required
              />
            )}
          </Field>
          {!roomType && (
            <Field label="Code" hint="Short, such as DLX. It cannot be changed later.">
              {(props) => (
                <CodeInput
                  {...props}
                  value={values.code}
                  onChange={(e) => change({ code: e.target.value })}
                  required
                />
              )}
            </Field>
          )}
          <Field label="Description" optional className="sm:col-span-2">
            {(props) => (
              <Textarea
                {...props}
                value={values.description}
                onChange={(e) => change({ description: e.target.value })}
                maxLength={4000}
              />
            )}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Base occupancy" className="col-span-2 sm:col-span-1">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={30}
                step={1}
                inputMode="numeric"
                value={values.baseOccupancy}
                onChange={(e) => change({ baseOccupancy: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Maximum adults">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={30}
                step={1}
                inputMode="numeric"
                value={values.maxAdults}
                onChange={(e) => change({ maxAdults: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Maximum children">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={0}
                max={30}
                step={1}
                inputMode="numeric"
                value={values.maxChildren}
                onChange={(e) => change({ maxChildren: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Maximum guests" className="col-span-2 sm:col-span-1">
            {(props) => (
              <Input
                {...props}
                type="number"
                min={minGuests}
                max={60}
                step={1}
                inputMode="numeric"
                value={values.maxOccupancy}
                onChange={(e) => change({ maxOccupancy: e.target.value })}
                required
              />
            )}
          </Field>
          <p className="col-span-2 -mt-1 text-[13px] text-ink-faint sm:col-span-4">
            Base occupancy is the number of guests a booking normally has. Maximum guests counts
            adults and children together and cannot be below base occupancy or maximum adults.
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium text-ink-soft">
            How units are assigned
          </legend>
          {(Object.keys(ASSIGNMENT_LABELS) as RoomType['assignment'][]).map((assignment) => (
            <label key={assignment} className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name="assignment"
                value={assignment}
                checked={values.assignment === assignment}
                onChange={() => change({ assignment })}
                disabled={assignment === 'at_check_in' && hasLinkedUnits}
                className="mt-0.5 size-4 shrink-0 accent-brand-600"
              />
              <span
                className={
                  assignment === 'at_check_in' && hasLinkedUnits ? 'text-ink-faint' : undefined
                }
              >
                {ASSIGNMENT_LABELS[assignment]}
              </span>
            </label>
          ))}
          {hasLinkedUnits && (
            <p className="text-[13px] text-ink-faint">
              This room type has units that are linked to other units, so every booking must be tied
              to a unit.
            </p>
          )}
        </fieldset>

        {values.assignment === 'at_check_in' && (
          <SwitchField
            label="Give each new booking a free room automatically when one fits"
            hint="When no room is free for the whole stay the booking is still taken, without a room."
            checked={values.autoAssign}
            onChange={(autoAssign) => change({ autoAssign })}
          />
        )}

        {roomType && (
          <SwitchField
            label="Active"
            hint="An inactive room type is left out of the calendar and is no longer sold."
            checked={values.active}
            onChange={(active) => change({ active })}
          />
        )}
      </form>
    </Dialog>
  );
}
