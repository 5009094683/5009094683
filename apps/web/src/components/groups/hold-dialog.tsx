'use client';

import { useState, type FormEvent } from 'react';
import { addDays, isValidDate, todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatStay, plural } from '@/lib/format';
import { useAction, usePropertyDetail } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { useFreeRooms } from './group-dialog';
import type { Group, GroupHold } from './types';

/** Holds more rooms for a group, or changes how many are held and for which nights. */
export function HoldDialog({
  group,
  property,
  hold,
  onClose,
  onSaved,
}: {
  group: Group;
  property: Property;
  /** The held rooms to change. Leave out to hold more. */
  hold?: GroupHold;
  onClose: () => void;
  onSaved: (group: Group) => void;
}) {
  const toast = useToast();
  const { data: detail } = usePropertyDetail(property.id);
  const today = todayIn(property.timezone);
  const types =
    detail?.roomTypes.filter((type) => type.active && type.assignment === 'at_check_in') ?? [];

  const [roomTypeId, setRoomTypeId] = useState(hold?.roomTypeId ?? '');
  const [from, setFrom] = useState(hold?.from ?? group.from ?? addDays(today, 30));
  const [to, setTo] = useState(hold?.to ?? group.to ?? addDays(today, 32));
  const [quantity, setQuantity] = useState(String(hold?.quantity ?? 1));

  const typeId = roomTypeId || types[0]?.id || '';
  const free = useFreeRooms(property.id, from, to)?.get(typeId);
  // What the group has booked on the nights of these held rooms: fewer cannot usefully be held.
  const booked = hold
    ? Math.max(
        0,
        ...group.nights
          .filter((n) => n.roomTypeId === hold.roomTypeId && n.date >= from && n.date < to)
          .map((n) => n.booked),
      )
    : 0;
  const unchangedDates = hold && hold.from === from && hold.to === to;

  const save = useAction(async () => {
    const body = { from, to, quantity: Number(quantity) };
    const saved = hold
      ? await api<Group>(`/groups/${group.id}/holds/${hold.id}`, { method: 'PATCH', body })
      : await api<Group>(`/groups/${group.id}/holds`, { body: { ...body, roomTypeId: typeId } });
    toast.success(
      hold ? 'Held rooms changed' : `${plural(body.quantity, 'room')} held`,
      'Booking sites are being told.',
    );
    onSaved(saved);
    onClose();
  });
  const remove = useAction(async () => {
    if (!hold) return;
    const saved = await api<Group>(`/groups/${group.id}/holds/${hold.id}`, { method: 'DELETE' });
    toast.success('Rooms given up', 'They are back on sale. The bookings already made stay.');
    onSaved(saved);
    onClose();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run();
  };
  const error = save.error ?? remove.error;

  return (
    <Dialog
      open
      onClose={onClose}
      title={hold ? `Change held rooms: ${hold.roomTypeName}` : `Hold more rooms for ${group.name}`}
      description={hold ? formatStay(hold.from, hold.to) : undefined}
      footer={
        <>
          {hold && (
            <Button
              variant="danger-ghost"
              className="mr-auto"
              loading={remove.busy}
              onClick={() => void remove.run()}
            >
              Give up these rooms
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="hold-form"
            variant="primary"
            loading={save.busy}
            disabled={!typeId}
          >
            {hold ? 'Save' : 'Hold rooms'}
          </Button>
        </>
      }
    >
      <form id="hold-form" onSubmit={submit} className="flex flex-col gap-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {detail && types.length === 0 && (
          <Notice>
            {property.name} is booked unit by unit, so rooms cannot be held by number. Book each
            unit for the group instead.
          </Notice>
        )}
        {!hold && types.length > 0 && (
          <Field label="Room type">
            {(props) => (
              <Select
                {...props}
                value={typeId}
                onChange={(event) => setRoomTypeId(event.target.value)}
                required
              >
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First night">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={from}
                onChange={(event) => {
                  const next = event.target.value;
                  setFrom(next);
                  if (isValidDate(next) && to <= next) setTo(addDays(next, 1));
                }}
                required
              />
            )}
          </Field>
          <Field label="Leaving on">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={to}
                min={isValidDate(from) ? addDays(from, 1) : undefined}
                onChange={(event) => setTo(event.target.value)}
                required
              />
            )}
          </Field>
        </div>
        <Field
          label="Rooms to hold"
          hint={
            free === undefined
              ? undefined
              : hold && unchangedDates
                ? `${free <= 0 ? 'No' : free} more free on every night.${booked > 0 ? ` The group's bookings use up to ${booked} a night.` : ''}`
                : free <= 0
                  ? 'None free on every one of these nights.'
                  : `${free} free on every night.`
          }
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              inputMode="numeric"
              min={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="w-28"
              required
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
