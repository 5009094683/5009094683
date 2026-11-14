'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { CodeInput, CurrencyInput, TimeZoneSelect } from './fields';
import { KIND_LABELS } from './labels';
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
  code: string;
  kind: Property['kind'];
  timezone: string;
  currency: string;
}

/** Adds a property. Its room types, units and rate plans are added afterwards on its own page. */
export function PropertyDialog({
  defaults,
  onClose,
  onCreated,
}: {
  defaults: { timezone: string; currency: string };
  onClose: () => void;
  onCreated: (property: Property) => void;
}) {
  const [values, setValues] = useState<Values>({
    name: '',
    code: '',
    kind: 'hotel',
    timezone: defaults.timezone,
    currency: defaults.currency,
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'IN',
    stateCode: '',
    gstin: '',
  });
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  const create = useAction(async () => {
    const property = await api<Property>('/properties', {
      body: {
        code: values.code.trim().toUpperCase(),
        name: values.name.trim(),
        kind: values.kind,
        timezone: values.timezone,
        currency: values.currency.trim().toUpperCase(),
        ...addressBody(values),
        ...taxBody(values),
      },
    });
    onCreated(property);
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add property"
      description="A hotel or a villa. You add its room types, units and rate plans next."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="property-form" variant="primary" loading={create.busy}>
            Add property
          </Button>
        </>
      }
    >
      <form
        id="property-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create.run();
        }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {create.error && (
          <Notice tone="danger" className="sm:col-span-2">
            {create.error}
          </Notice>
        )}
        <Field label="Name" className="sm:col-span-2">
          {(props) => (
            <Input
              {...props}
              value={values.name}
              onChange={(e) => change({ name: e.target.value })}
              maxLength={160}
              autoComplete="off"
              autoFocus
              required
            />
          )}
        </Field>
        <Field label="Code" hint="Short and unique, such as GOA. It cannot be changed later.">
          {(props) => (
            <CodeInput
              {...props}
              value={values.code}
              onChange={(e) => change({ code: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Kind" hint="It cannot be changed later.">
          {(props) => (
            <Select
              {...props}
              value={values.kind}
              onChange={(e) => change({ kind: e.target.value as Property['kind'] })}
            >
              {(Object.keys(KIND_LABELS) as Property['kind'][]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Time zone">
          {(props) => (
            <TimeZoneSelect
              {...props}
              value={values.timezone}
              onChange={(e) => change({ timezone: e.target.value })}
            />
          )}
        </Field>
        <Field label="Currency">
          {(props) => (
            <CurrencyInput
              {...props}
              value={values.currency}
              onChange={(e) => change({ currency: e.target.value })}
              required
            />
          )}
        </Field>
        <AddressFields values={values} onChange={change} />
        <TaxFields values={values} onChange={change} />
      </form>
    </Dialog>
  );
}
