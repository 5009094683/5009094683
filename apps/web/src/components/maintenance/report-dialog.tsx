'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { addDays, todayIn } from '@pms/domain/shared';
import { PersonOptions, staffFor } from '@/components/housekeeping/staff';
import type { StaffMember } from '@/components/housekeeping/types';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction, usePropertyDetail } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { PRIORITIES, PRIORITY_LABELS, offSaleProblem, offSaleSentence, saveError } from './labels';
import { OffSaleExplanation, OffSaleFields } from './off-sale-fields';
import type { OffSale, Priority } from './types';

function firstDates(property: Property | undefined): OffSale {
  const today = property ? (property.businessDate ?? todayIn(property.timezone)) : '';
  return { from: today, to: today ? addDays(today, 1) : '' };
}

/** Reports something that needs fixing, optionally taking the room off sale meanwhile. */
export function ReportDialog({
  properties,
  propertyId: initialPropertyId,
  onClose,
  onSaved,
}: {
  /** The properties the user may report issues at. */
  properties: Property[];
  /** The property the list is filtered to, if any. */
  propertyId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [propertyId, setPropertyId] = useState(
    properties.find((p) => p.id === initialPropertyId)?.id ?? properties[0]?.id ?? '',
  );
  const property = properties.find((p) => p.id === propertyId);
  const [unitId, setUnitId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [person, setPerson] = useState('');
  const [offSale, setOffSale] = useState(false);
  const [dates, setDates] = useState(() => firstDates(property));

  const detail = usePropertyDetail(propertyId || null);
  const { data: staffData } = useSWR<{ staff: StaffMember[] }>(
    propertyId ? `/properties/${propertyId}/staff` : null,
  );
  const staff = staffFor(staffData?.staff ?? [], 'maintenance');
  const roomTypes = (detail.data?.roomTypes ?? [])
    .map((type) => ({ ...type, units: type.units.filter((u) => u.active) }))
    .filter((type) => type.active && type.units.length > 0);
  const unit = roomTypes.flatMap((type) => type.units).find((u) => u.id === unitId);
  const closing = offSale && unit !== undefined;

  const changeProperty = (id: string) => {
    setPropertyId(id);
    setUnitId('');
    setPerson('');
    setOffSale(false);
    setDates(firstDates(properties.find((p) => p.id === id)));
  };

  const save = useAction(async () => {
    if (!property) throw new Error('Choose a property');
    if (closing && offSaleProblem(dates)) throw new Error('Check the off sale dates');
    try {
      await api('/maintenance', {
        body: {
          propertyId: property.id,
          unitId: unit?.id ?? null,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          assignedTo: person || null,
          ...(closing ? { offSale: dates } : {}),
        },
      });
    } catch (err) {
      throw saveError(err);
    }
    toast.success('Issue reported', closing ? offSaleSentence(unit.name, dates) : undefined);
    onSaved();
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Report an issue"
      description={properties.length === 1 ? property?.name : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="report-issue-form" variant="primary" loading={save.busy}>
            Report issue
          </Button>
        </>
      }
    >
      <form
        id="report-issue-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-3"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {properties.length > 1 && (
            <Field label="Property">
              {(props) => (
                <Select
                  {...props}
                  value={propertyId}
                  onChange={(event) => changeProperty(event.target.value)}
                >
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Room" className={properties.length > 1 ? undefined : 'sm:col-span-2'}>
            {(props) => (
              <Select
                {...props}
                value={unitId}
                disabled={detail.isLoading}
                onChange={(event) => {
                  setUnitId(event.target.value);
                  if (!event.target.value) setOffSale(false);
                }}
              >
                <option value="">Common area (no room)</option>
                {roomTypes.map((type) => (
                  <optgroup key={type.id} label={type.name}>
                    {type.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="What needs fixing">
          {(props) => (
            <Input
              {...props}
              autoFocus
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label="Details" optional>
          {(props) => (
            <Textarea
              {...props}
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
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
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Person">
            {(props) => (
              <Select {...props} value={person} onChange={(event) => setPerson(event.target.value)}>
                <PersonOptions staff={staff} area="maintenance" />
              </Select>
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <Checkbox
            label="Take the room off sale"
            checked={closing}
            disabled={!unit}
            onChange={(event) => setOffSale(event.target.checked)}
          />
          {!unit && (
            <p className="text-[13px] text-ink-faint">Choose a room to take it off sale.</p>
          )}
          {closing && (
            <>
              <OffSaleFields value={dates} onChange={setDates} />
              <OffSaleExplanation />
            </>
          )}
        </div>
      </form>
    </Dialog>
  );
}
