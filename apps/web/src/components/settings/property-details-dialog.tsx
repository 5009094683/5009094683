'use client';

import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { CurrencyInput, SwitchField, TimeZoneSelect } from './fields';
import { changedFields, textOrNull } from './form-values';
import {
  AddressFields,
  TaxFields,
  addressBody,
  taxBody,
  type AddressValues,
  type TaxValues,
} from './property-fields';

interface Values extends AddressValues, TaxValues {
  name: string;
  legalName: string;
  phone: string;
  email: string;
  timezone: string;
  currency: string;
  checkInTime: string;
  checkOutTime: string;
  inventoryHorizonDays: string;
  active: boolean;
}

function valuesFrom(property: Property): Values {
  return {
    name: property.name,
    legalName: property.legalName ?? '',
    phone: property.phone ?? '',
    email: property.email ?? '',
    timezone: property.timezone,
    currency: property.currency,
    addressLine1: property.addressLine1 ?? '',
    addressLine2: property.addressLine2 ?? '',
    city: property.city ?? '',
    state: property.state ?? '',
    postalCode: property.postalCode ?? '',
    country: property.country,
    stateCode: property.stateCode ?? '',
    gstin: property.gstin ?? '',
    checkInTime: property.checkInTime,
    checkOutTime: property.checkOutTime,
    inventoryHorizonDays: String(property.inventoryHorizonDays),
    active: property.active,
  };
}

function bodyFrom(values: Values) {
  return {
    name: values.name.trim(),
    legalName: textOrNull(values.legalName),
    phone: textOrNull(values.phone),
    email: textOrNull(values.email),
    timezone: values.timezone,
    currency: values.currency.trim().toUpperCase(),
    ...addressBody(values),
    ...taxBody(values),
    checkInTime: values.checkInTime,
    checkOutTime: values.checkOutTime,
    inventoryHorizonDays: Number(values.inventoryHorizonDays),
    active: values.active,
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <h3
        id={headingId}
        className="border-b border-line pb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase sm:col-span-2"
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

/** Edits a property's own details: contact, address, tax and how it operates. */
export function PropertyDetailsDialog({
  property,
  onClose,
  onSaved,
}: {
  property: Property;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [initial] = useState(() => valuesFrom(property));
  const [values, setValues] = useState(initial);
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  const save = useAction(async () => {
    const body = bodyFrom(values);
    const changes = changedFields(bodyFrom(initial), body);
    if (Object.keys(changes).length > 0) {
      await api(`/properties/${property.id}`, {
        method: 'PATCH',
        body: {
          ...changes,
          // The server checks the GSTIN against the state code only when it is sent both.
          ...('gstin' in changes || 'stateCode' in changes
            ? { gstin: body.gstin, stateCode: body.stateCode }
            : {}),
        },
      });
      toast.success('Property details saved');
      onSaved();
    }
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit ${property.name}`}
      description={`Code ${property.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="property-details-form" variant="primary" loading={save.busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="property-details-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}

        <Section title="Property">
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={values.name}
                onChange={(e) => change({ name: e.target.value })}
                maxLength={160}
                autoComplete="off"
                required
              />
            )}
          </Field>
          <Field label="Legal name" optional hint="The registered name, for invoices.">
            {(props) => (
              <Input
                {...props}
                value={values.legalName}
                onChange={(e) => change({ legalName: e.target.value })}
                maxLength={200}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Phone" optional>
            {(props) => (
              <Input
                {...props}
                type="tel"
                value={values.phone}
                onChange={(e) => change({ phone: e.target.value })}
                maxLength={40}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Email" optional>
            {(props) => (
              <Input
                {...props}
                type="email"
                value={values.email}
                onChange={(e) => change({ email: e.target.value })}
                autoComplete="off"
              />
            )}
          </Field>
        </Section>

        <Section title="Address">
          <AddressFields values={values} onChange={change} />
        </Section>

        <Section title="Tax">
          <TaxFields values={values} onChange={change} />
        </Section>

        <Section title="Operations">
          <Field label="Time zone" hint="Dates, check-in and check-out follow this time zone.">
            {(props) => (
              <TimeZoneSelect
                {...props}
                value={values.timezone}
                onChange={(e) => change({ timezone: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Currency"
            hint="Used for new rate plans. Existing rate plans keep the currency they were created in."
          >
            {(props) => (
              <CurrencyInput
                {...props}
                value={values.currency}
                onChange={(e) => change({ currency: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Check-in time">
            {(props) => (
              <Input
                {...props}
                type="time"
                value={values.checkInTime}
                onChange={(e) => change({ checkInTime: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Check-out time">
            {(props) => (
              <Input
                {...props}
                type="time"
                value={values.checkOutTime}
                onChange={(e) => change({ checkOutTime: e.target.value })}
                required
              />
            )}
          </Field>
          <Field
            label="Availability horizon (days)"
            hint="How far ahead availability is kept and sent to booking channels. Between 30 and 1095 days."
            className="sm:col-span-2"
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={30}
                max={1095}
                step={1}
                inputMode="numeric"
                value={values.inventoryHorizonDays}
                onChange={(e) => change({ inventoryHorizonDays: e.target.value })}
                className="sm:max-w-40"
                required
              />
            )}
          </Field>
          <SwitchField
            label="Active"
            hint="An inactive property is left out of the calendar. Its data is kept."
            checked={values.active}
            onChange={(active) => change({ active })}
            className="sm:col-span-2"
          />
        </Section>
      </form>
    </Dialog>
  );
}
