'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { PropertyDetail, Unit } from '@/lib/types';
import { SwitchField } from './fields';
import { changedFields, textOrNull } from './form-values';

type RoomTypeDetail = PropertyDetail['roomTypes'][number];

interface Values {
  name: string;
  floor: string;
  sortOrder: string;
  notes: string;
  parentUnitId: string;
  active: boolean;
}

function bodyFrom(values: Values) {
  return {
    name: values.name.trim(),
    floor: textOrNull(values.floor),
    sortOrder: Number(values.sortOrder),
    notes: textOrNull(values.notes),
    parentUnitId: values.parentUnitId || null,
    active: values.active,
  };
}

/** Adds a unit (a room, or a villa) to a room type, or edits one. */
export function UnitDialog({
  propertyId,
  roomTypes,
  roomType,
  unit,
  onClose,
  onSaved,
}: {
  propertyId: string;
  /** Every room type of the property, to find the units this one can be a part of. */
  roomTypes: RoomTypeDetail[];
  roomType: RoomTypeDetail;
  /** The unit to edit; absent when adding one. */
  unit?: Unit;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [initial] = useState<Values>(() => ({
    name: unit?.name ?? '',
    floor: unit?.floor ?? '',
    // A new unit goes after the ones the room type already has.
    sortOrder: String(
      unit?.sortOrder ?? Math.max(-1, ...roomType.units.map((other) => other.sortOrder)) + 1,
    ),
    notes: unit?.notes ?? '',
    parentUnitId: unit?.parentUnitId ?? '',
    active: unit?.active ?? true,
  }));
  const [values, setValues] = useState(initial);
  const [addAnother, setAddAnother] = useState(false);
  const [added, setAdded] = useState(0);
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  // The API accepts as a parent only a unit of another room type that is not itself a part.
  const parentGroups = roomTypes
    .filter((other) => other.id !== roomType.id)
    .map((other) => ({
      roomType: other,
      units: other.units.filter((candidate) => candidate.parentUnitId === null),
    }))
    .filter((group) => group.units.length > 0);
  const parts = unit
    ? roomTypes.flatMap((other) => other.units).filter((other) => other.parentUnitId === unit.id)
    : [];

  const save = useAction(async () => {
    const body = bodyFrom(values);
    if (unit) {
      // Only what changed is sent: the API reads the mere presence of `active` or
      // `parentUnitId` as a change to check against upcoming bookings.
      const patch = changedFields(bodyFrom(initial), body);
      if (Object.keys(patch).length > 0) {
        await api(`/properties/${propertyId}/units/${unit.id}`, { method: 'PATCH', body: patch });
        toast.success('Unit saved');
        onSaved();
      }
      onClose();
      return;
    }
    await api(`/properties/${propertyId}/units`, {
      body: {
        roomTypeId: roomType.id,
        name: body.name,
        floor: body.floor,
        parentUnitId: body.parentUnitId,
        sortOrder: body.sortOrder,
      },
    });
    toast.success(`Unit ${body.name} added`);
    onSaved();
    if (addAnother) {
      change({ name: '', sortOrder: String(body.sortOrder + 1) });
      setAdded((count) => count + 1);
    } else {
      onClose();
    }
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={unit ? `Edit unit ${unit.name}` : 'Add unit'}
      description={`${roomType.name} (${roomType.code})`}
      footer={
        <>
          <Button onClick={onClose}>{unit ? 'Cancel' : 'Close'}</Button>
          <Button type="submit" form="unit-form" variant="primary" loading={save.busy}>
            {unit ? 'Save' : 'Add unit'}
          </Button>
        </>
      }
    >
      <form
        id="unit-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            hint="A room number or a name, such as 204. Unique within the property."
          >
            {(props) => (
              <Input
                {...props}
                // A new input per unit added, so the cursor returns here for the next name.
                key={added}
                value={values.name}
                onChange={(e) => change({ name: e.target.value })}
                maxLength={80}
                autoComplete="off"
                autoFocus
                required
              />
            )}
          </Field>
          <Field label="Floor" optional>
            {(props) => (
              <Input
                {...props}
                value={values.floor}
                onChange={(e) => change({ floor: e.target.value })}
                maxLength={20}
                autoComplete="off"
              />
            )}
          </Field>
        </div>

        {parts.length > 0 ? (
          <Notice tone="info">
            {parts.map((part) => part.name).join(', ')}{' '}
            {parts.length === 1 ? 'is a part' : 'are parts'} of this unit. A unit that has parts
            cannot itself be part of another unit.
          </Notice>
        ) : (
          <Field
            label="Part of"
            optional
            hint={
              parentGroups.length === 0 && !values.parentUnitId
                ? 'For a villa sold whole and by bedroom. There are no units in other room types to link to yet.'
                : 'For a villa sold whole and by bedroom: make each bedroom part of the villa unit. A booking of the villa then takes its bedrooms off sale, and a booking of a bedroom takes the villa off sale. Linking makes both room types tie every booking to a unit straight away.'
            }
          >
            {(props) => (
              <Select
                {...props}
                value={values.parentUnitId}
                onChange={(e) => change({ parentUnitId: e.target.value })}
                disabled={parentGroups.length === 0 && !values.parentUnitId}
              >
                <option value="">Not part of another unit</option>
                {parentGroups.map((group) => (
                  <optgroup key={group.roomType.id} label={group.roomType.name}>
                    {group.units.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                        {candidate.active ? '' : ' (inactive)'}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        )}

        {unit ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Sort order"
                hint="Units are listed by this number, then by name. Lower numbers come first."
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    step={1}
                    inputMode="numeric"
                    value={values.sortOrder}
                    onChange={(e) => change({ sortOrder: e.target.value })}
                    required
                  />
                )}
              </Field>
            </div>
            <Field label="Notes" optional>
              {(props) => (
                <Textarea
                  {...props}
                  value={values.notes}
                  onChange={(e) => change({ notes: e.target.value })}
                  maxLength={2000}
                />
              )}
            </Field>
            <SwitchField
              label="Active"
              hint="Turn off to take the unit out of service for good. It stops counting towards availability. Units with upcoming bookings cannot be turned off."
              checked={values.active}
              onChange={(active) => change({ active })}
            />
          </>
        ) : (
          <Checkbox
            label="Keep this open to add another unit"
            checked={addAnother}
            onChange={(e) => setAddAnother(e.target.checked)}
          />
        )}
      </form>
    </Dialog>
  );
}
