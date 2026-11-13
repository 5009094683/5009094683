'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { addDays, diffDays, isValidDate, todayIn } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatMoney, plural, toMinor } from '@/lib/format';
import { useAction, usePropertyDetail } from '@/lib/hooks';
import type { Property, Reservation } from '@/lib/types';
import { useFreeRooms } from './group-dialog';
import { parseRoomingList } from './rooming-list';
import type { Group } from './types';

/** Books a room for each guest of a list in one go: all of them, or none if rooms run out. */
export function RoomingListDialog({
  group,
  property,
  onClose,
  onSaved,
}: {
  group: Group;
  property: Property;
  onClose: () => void;
  onSaved: (group: Group) => void;
}) {
  const toast = useToast();
  const { data: detail } = usePropertyDetail(property.id);
  const today = todayIn(property.timezone);
  const types = detail?.roomTypes.filter((type) => type.active) ?? [];
  // Start on the room type the group holds most of.
  const mostHeld = [...group.holds].sort((a, b) => b.quantity - a.quantity)[0]?.roomTypeId;

  const [roomTypeId, setRoomTypeId] = useState('');
  const [ratePlanId, setRatePlanId] = useState('');
  const [checkIn, setCheckIn] = useState(group.from ?? addDays(today, 30));
  const [checkOut, setCheckOut] = useState(group.to ?? addDays(today, 32));
  const [adults, setAdults] = useState('1');
  const [rate, setRate] = useState('');
  const [text, setText] = useState('');

  const typeId = roomTypeId || types.find((type) => type.id === mostHeld)?.id || types[0]?.id || '';
  const type = types.find((candidate) => candidate.id === typeId);
  const plans = type?.ratePlans.filter((plan) => plan.active) ?? [];
  const planId =
    plans.find((plan) => plan.id === ratePlanId)?.id ??
    (plans.find((plan) => plan.isDefault) ?? plans[0])?.id ??
    '';
  const { guests, unreadable } = useMemo(() => parseRoomingList(text), [text]);
  const valid = isValidDate(checkIn) && isValidDate(checkOut) && checkOut > checkIn;
  const nights = valid ? diffDays(checkIn, checkOut) : 0;
  const bookable = useFreeRooms(property.id, checkIn, checkOut, group.id)?.get(typeId);
  const nightly = rate.trim() === '' ? null : Number(rate);
  const rateValid = nightly === null || (Number.isFinite(nightly) && nightly >= 0);

  const save = useAction(async () => {
    const result = await api<{ group: Group; reservations: Reservation[] }>(
      `/groups/${group.id}/rooming-list`,
      {
        body: {
          roomTypeId: typeId,
          ratePlanId: planId || null,
          checkIn,
          checkOut,
          adults: Number(adults) || 1,
          ...(nightly !== null ? { nightlyRate: toMinor(nightly, property.currency) } : {}),
          guests: guests.map((guest) => ({
            firstName: guest.firstName,
            ...(guest.lastName ? { lastName: guest.lastName } : {}),
            ...(guest.email ? { email: guest.email } : {}),
            ...(guest.phone ? { phone: guest.phone } : {}),
          })),
        },
      },
    );
    toast.success(
      `${plural(result.reservations.length, 'booking')} made for ${group.name}`,
      'Each guest has a booking of their own.',
    );
    onSaved(result.group);
    onClose();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Rooming list for ${group.name}`}
      description="One room is booked for each guest. If the rooms run out, nobody is booked and you can correct the list."
      footer={
        <>
          {guests.length > 0 && nights > 0 && (
            <p className="mr-auto text-sm text-ink-soft">
              {plural(guests.length, 'room')} for {plural(nights, 'night')}
              {nightly !== null && rateValid && (
                <>
                  {' · '}
                  <span className="font-medium text-ink">
                    {formatMoney(
                      toMinor(nightly, property.currency) * nights * guests.length,
                      property.currency,
                    )}
                  </span>{' '}
                  <span className="text-ink-faint">before tax</span>
                </>
              )}
            </p>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="rooming-form"
            variant="primary"
            loading={save.busy}
            disabled={guests.length === 0 || !typeId || !valid || !rateValid}
          >
            {guests.length > 0 ? `Book ${plural(guests.length, 'room')}` : 'Book rooms'}
          </Button>
        </>
      }
    >
      <form id="rooming-form" onSubmit={submit} className="flex flex-col gap-4">
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Room type" className="col-span-2">
            {(props) => (
              <Select
                {...props}
                value={typeId}
                onChange={(event) => {
                  setRoomTypeId(event.target.value);
                  setRatePlanId('');
                }}
                required
              >
                {types.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Rate plan" className="col-span-2">
            {(props) => (
              <Select
                {...props}
                value={planId}
                onChange={(event) => setRatePlanId(event.target.value)}
              >
                {plans.length === 0 && <option value="">No rate plan</option>}
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Check-in">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={checkIn}
                onChange={(event) => {
                  const next = event.target.value;
                  setCheckIn(next);
                  if (isValidDate(next) && checkOut <= next) setCheckOut(addDays(next, 1));
                }}
                required
              />
            )}
          </Field>
          <Field label="Check-out">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={checkOut}
                min={isValidDate(checkIn) ? addDays(checkIn, 1) : undefined}
                onChange={(event) => setCheckOut(event.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Adults per room">
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={1}
                max={type?.maxAdults ?? 30}
                value={adults}
                onChange={(event) => setAdults(event.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Rate per night" optional error={rateValid ? null : 'Enter an amount'}>
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                placeholder="Rate plan"
              />
            )}
          </Field>
        </div>

        <Field
          label="Guests"
          hint="One guest on each line. After the name you can add an email address and a phone number, separated by commas."
        >
          {(props) => (
            <Textarea
              {...props}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={8}
              placeholder={'Lena Ortiz, lena@example.com\nMarek Nowak, +48 600 100 200'}
              className="font-mono text-[13px]"
              required
            />
          )}
        </Field>

        {unreadable.length > 0 && (
          <Notice tone="warning" title="These lines have no name and will be left out">
            <ul className="list-disc pl-4">
              {unreadable.slice(0, 5).map((line, index) => (
                <li key={`${index}-${line}`} className="break-all">
                  {line}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {bookable !== undefined && guests.length > bookable && (
          <Notice tone="warning">
            {bookable <= 0
              ? `No ${type?.name ?? 'room'} can be booked for the group on every one of these nights.`
              : `Only ${plural(bookable, 'room')} of ${type?.name ?? 'this type'} can be booked for the group on every one of these nights, and the list has ${guests.length}.`}
          </Notice>
        )}
      </form>
    </Dialog>
  );
}
