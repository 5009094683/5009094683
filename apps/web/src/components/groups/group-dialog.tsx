'use client';

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { addDays, diffDays, isValidDate, todayIn } from '@pms/domain/shared';
import { useCompanies } from '@/components/folio/data';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, query } from '@/lib/api';
import { plural } from '@/lib/format';
import { useAction, usePropertyDetail } from '@/lib/hooks';
import type { Availability, Property } from '@/lib/types';
import type { Group } from './types';

/** The fewest rooms free on any night of the range, per room type. */
export function useFreeRooms(
  propertyId: string,
  from: string,
  to: string,
  groupId?: string,
): Map<string, number> | undefined {
  const valid = isValidDate(from) && isValidDate(to) && to > from && diffDays(from, to) <= 365;
  const { data } = useSWR<{ days: Availability[] }>(
    valid ? `/properties/${propertyId}/availability${query({ from, to, groupId })}` : null,
  );
  if (!data) return undefined;
  const free = new Map<string, number>();
  for (const day of data.days) {
    free.set(day.roomTypeId, Math.min(free.get(day.roomTypeId) ?? Infinity, day.available));
  }
  return free;
}

/**
 * Starts a group, or changes the details of one. A new group names its dates and how many
 * rooms of each kind to keep for it; rooms on other dates are added from the group's page.
 */
export function GroupDialog({
  property,
  group,
  onClose,
  onSaved,
}: {
  property: Property;
  group?: Group;
  onClose: () => void;
  onSaved: (group: Group) => void;
}) {
  const toast = useToast();
  const { data: detail } = usePropertyDetail(group ? null : property.id);
  const { companies } = useCompanies();
  const today = todayIn(property.timezone);

  const [name, setName] = useState(group?.name ?? '');
  const [contactName, setContactName] = useState(group?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(group?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(group?.contactPhone ?? '');
  const [cutoffDate, setCutoffDate] = useState(group?.cutoffDate ?? '');
  const [companyId, setCompanyId] = useState(group?.company?.id ?? '');
  const [notes, setNotes] = useState(group?.notes ?? '');
  const [from, setFrom] = useState(addDays(today, 30));
  const [to, setTo] = useState(addDays(today, 32));
  const [rooms, setRooms] = useState<Record<string, string>>({});

  // Rooms can be held by number only where they are sold by number: hotel rooms, not villas.
  const heldByNumber =
    detail?.roomTypes.filter((type) => type.active && type.assignment === 'at_check_in') ?? [];
  const free = useFreeRooms(property.id, from, to);
  const holds = heldByNumber
    .map((type) => ({ roomTypeId: type.id, from, to, quantity: Number(rooms[type.id] ?? 0) }))
    .filter((hold) => hold.quantity > 0);
  const datesValid = isValidDate(from) && isValidDate(to) && to > from;
  // The current company stays in the list even if it has since been made inactive.
  const companyOptions =
    group?.company && !companies.some((company) => company.id === group.company?.id)
      ? [group.company, ...companies]
      : companies;

  const save = useAction(async () => {
    const details = {
      name: name.trim(),
      contactName: contactName.trim() || null,
      contactEmail: contactEmail.trim() || null,
      contactPhone: contactPhone.trim() || null,
      cutoffDate: cutoffDate || null,
      notes: notes.trim() || null,
      companyId: companyId || null,
    };
    const saved = group
      ? await api<Group>(`/groups/${group.id}`, { method: 'PATCH', body: details })
      : await api<Group>(`/properties/${property.id}/groups`, { body: { ...details, holds } });
    if (group) toast.success('Group saved');
    else {
      toast.success(
        `${saved.name} started`,
        saved.heldNights > 0
          ? `${plural(saved.heldNights, 'room night')} held. Booking sites are being told.`
          : 'No rooms are held for it yet.',
      );
    }
    onSaved(saved);
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
      title={group ? `Change ${group.name}` : 'New group'}
      description={
        group
          ? undefined
          : `At ${property.name}. The rooms you hold come off sale everywhere until the group books them.`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="group-form"
            variant="primary"
            loading={save.busy}
            disabled={!group && holds.length > 0 && !datesValid}
          >
            {group ? 'Save' : holds.length > 0 ? 'Start group and hold rooms' : 'Start group'}
          </Button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit} className="flex flex-col gap-4">
        {save.error && <Notice tone="danger">{save.error}</Notice>}

        <Field label="Name of the group" hint="For example the family, the company or the tour.">
          {(props) => (
            <Input
              {...props}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoComplete="off"
              required
            />
          )}
        </Field>

        {!group && (
          <fieldset className="rounded-lg border border-line p-3">
            <legend className="px-1 text-[13px] font-medium text-ink-soft">Rooms to hold</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First night">
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={from}
                    min={today}
                    onChange={(event) => {
                      const next = event.target.value;
                      setFrom(next);
                      if (isValidDate(next) && to <= next) setTo(addDays(next, 1));
                    }}
                    required={holds.length > 0}
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
                    required={holds.length > 0}
                  />
                )}
              </Field>
            </div>
            {!detail ? null : heldByNumber.length === 0 ? (
              <Notice className="mt-3">
                {property.name} is booked unit by unit, so rooms cannot be held by number. Start the
                group, then book each unit for it.
              </Notice>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {heldByNumber.map((type) => {
                  const left = free?.get(type.id);
                  const units = type.units.filter((unit) => unit.active).length;
                  return (
                    <li key={type.id} className="flex items-center justify-between gap-3">
                      <label htmlFor={`hold-${type.id}`} className="min-w-0 text-sm text-ink">
                        <span className="block truncate">{type.name}</span>
                        <span className="block text-[13px] text-ink-faint">
                          {left === undefined
                            ? `${plural(units, 'room')} in all`
                            : left <= 0
                              ? 'None free on these nights'
                              : `${left} free on every night`}
                        </span>
                      </label>
                      <Input
                        id={`hold-${type.id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={units}
                        value={rooms[type.id] ?? ''}
                        onChange={(event) =>
                          setRooms((current) => ({ ...current, [type.id]: event.target.value }))
                        }
                        placeholder="0"
                        className="w-20 text-right"
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        )}

        <Field
          label="Hold the rooms until"
          optional
          hint="Rooms nobody has booked by the end of this day go back on sale. Leave empty to keep them until the stay."
        >
          {(props) => (
            <Input
              {...props}
              type="date"
              value={cutoffDate}
              max={group ? (group.holds.map((hold) => hold.from).sort()[0] ?? undefined) : from}
              onChange={(event) => setCutoffDate(event.target.value)}
              className="sm:w-48"
            />
          )}
        </Field>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-soft">Who to talk to</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Name" optional>
              {(props) => (
                <Input
                  {...props}
                  value={contactName}
                  onChange={(event) => setContactName(event.target.value)}
                  maxLength={120}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Email" optional>
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Phone" optional>
              {(props) => (
                <Input
                  {...props}
                  type="tel"
                  value={contactPhone}
                  onChange={(event) => setContactPhone(event.target.value)}
                  maxLength={40}
                  autoComplete="off"
                />
              )}
            </Field>
          </div>
        </fieldset>

        <Field
          label="Booked for"
          optional
          hint="Bookings of the group are made for this company or agent, so their bills can go to its account."
        >
          {(props) => (
            <Select
              {...props}
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
            >
              <option value="">Nobody in particular</option>
              {companyOptions.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Notes" optional>
          {(props) => (
            <Textarea
              {...props}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={4000}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
