'use client';

import { Field, Input } from '@/components/ui/field';
import { textOrNull } from './form-values';

export interface AddressValues {
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface TaxValues {
  stateCode: string;
  gstin: string;
}

export function addressBody(values: AddressValues) {
  return {
    addressLine1: textOrNull(values.addressLine1),
    addressLine2: textOrNull(values.addressLine2),
    city: textOrNull(values.city),
    state: textOrNull(values.state),
    postalCode: textOrNull(values.postalCode),
    country: values.country.trim().toUpperCase(),
  };
}

export function taxBody(values: TaxValues) {
  return {
    stateCode: textOrNull(values.stateCode),
    gstin: textOrNull(values.gstin)?.toUpperCase() ?? null,
  };
}

/** Address fields for a two-column form grid. */
export function AddressFields({
  values,
  onChange,
}: {
  values: AddressValues;
  onChange: (patch: Partial<AddressValues>) => void;
}) {
  return (
    <>
      <Field label="Address line 1" optional className="sm:col-span-2">
        {(props) => (
          <Input
            {...props}
            value={values.addressLine1}
            onChange={(e) => onChange({ addressLine1: e.target.value })}
            maxLength={200}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Address line 2" optional className="sm:col-span-2">
        {(props) => (
          <Input
            {...props}
            value={values.addressLine2}
            onChange={(e) => onChange({ addressLine2: e.target.value })}
            maxLength={200}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="City" optional>
        {(props) => (
          <Input
            {...props}
            value={values.city}
            onChange={(e) => onChange({ city: e.target.value })}
            maxLength={120}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="State" optional>
        {(props) => (
          <Input
            {...props}
            value={values.state}
            onChange={(e) => onChange({ state: e.target.value })}
            maxLength={120}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Postal code" optional>
        {(props) => (
          <Input
            {...props}
            value={values.postalCode}
            onChange={(e) => onChange({ postalCode: e.target.value })}
            maxLength={20}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Country" hint="Two-letter code, such as IN.">
        {(props) => (
          <Input
            {...props}
            value={values.country}
            onChange={(e) => onChange({ country: e.target.value })}
            pattern="[A-Za-z]{2}"
            maxLength={2}
            title="Two letters, such as IN"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="uppercase"
            required
          />
        )}
      </Field>
    </>
  );
}

/** GST fields for a two-column form grid. */
export function TaxFields({
  values,
  onChange,
}: {
  values: TaxValues;
  onChange: (patch: Partial<TaxValues>) => void;
}) {
  return (
    <>
      <Field label="GST state code" optional hint="Two digits, such as 30 for Goa.">
        {(props) => (
          <Input
            {...props}
            value={values.stateCode}
            onChange={(e) => onChange({ stateCode: e.target.value })}
            pattern="\d{2}"
            maxLength={2}
            inputMode="numeric"
            title="Two digits"
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="GSTIN" optional hint="15 characters, starting with the GST state code.">
        {(props) => (
          <Input
            {...props}
            value={values.gstin}
            onChange={(e) => onChange({ gstin: e.target.value })}
            pattern="\d{2}[A-Za-z]{5}\d{4}[A-Za-z][A-Za-z\d][Zz][A-Za-z\d]"
            maxLength={15}
            title="15 characters, such as 30ABCDE1234F1Z5"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono uppercase"
          />
        )}
      </Field>
    </>
  );
}
