'use client';

import { Field, Input } from '@/components/ui/field';
import type { BillTo } from './types';

/** Who a bill or invoice is made out to, as typed. Empty strings stand for "not given". */
export interface BillToDraft {
  name: string;
  gstin: string;
  email: string;
  addressLine1: string;
  city: string;
  state: string;
  stateCode: string;
  postalCode: string;
  country: string;
}

export function billToDraft(billTo?: BillTo | null): BillToDraft {
  return {
    name: billTo?.name ?? '',
    gstin: billTo?.gstin ?? '',
    email: billTo?.email ?? '',
    addressLine1: billTo?.addressLine1 ?? '',
    city: billTo?.city ?? '',
    state: billTo?.state ?? '',
    stateCode: billTo?.stateCode ?? '',
    postalCode: billTo?.postalCode ?? '',
    country: billTo?.country ?? '',
  };
}

export function billToFromDraft(draft: BillToDraft): BillTo {
  const text = (value: string) => value.trim() || null;
  return {
    name: draft.name.trim(),
    gstin: text(draft.gstin)?.toUpperCase() ?? null,
    email: text(draft.email),
    addressLine1: text(draft.addressLine1),
    city: text(draft.city),
    state: text(draft.state),
    stateCode: text(draft.stateCode),
    postalCode: text(draft.postalCode),
    country: text(draft.country),
  };
}

export interface BillToErrors {
  name?: string;
  gstin?: string;
}

/** What is wrong with the details as typed, or null when they can be sent. */
export function billToErrors(draft: BillToDraft): BillToErrors | null {
  const errors: BillToErrors = {};
  if (!draft.name.trim()) errors.name = 'Enter the name the bill is made out to.';
  const gstin = draft.gstin.trim();
  if (gstin && !/^[0-9A-Za-z]{15}$/.test(gstin)) errors.gstin = 'A GSTIN is 15 letters and digits.';
  return errors.name || errors.gstin ? errors : null;
}

/** One line saying who a bill is made out to: name, GSTIN and place when known. */
export function billToSummary(billTo: BillTo): string {
  return [
    billTo.name,
    billTo.gstin ? `GSTIN ${billTo.gstin}` : null,
    [billTo.city, billTo.state].filter(Boolean).join(', ') || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function BillToFields({
  draft,
  onChange,
  errors,
}: {
  draft: BillToDraft;
  onChange: (draft: BillToDraft) => void;
  errors?: BillToErrors | null;
}) {
  const set = (patch: Partial<BillToDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Name" className="col-span-2" error={errors?.name}>
        {(props) => (
          <Input
            {...props}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            maxLength={200}
            required
          />
        )}
      </Field>
      <Field label="GSTIN" optional error={errors?.gstin}>
        {(props) => (
          <Input
            {...props}
            value={draft.gstin}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
            maxLength={15}
            autoComplete="off"
            className="font-mono"
          />
        )}
      </Field>
      <Field label="Email" optional>
        {(props) => (
          <Input
            {...props}
            type="email"
            value={draft.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        )}
      </Field>
      <Field label="Address" optional className="col-span-2">
        {(props) => (
          <Input
            {...props}
            value={draft.addressLine1}
            onChange={(e) => set({ addressLine1: e.target.value })}
            maxLength={200}
          />
        )}
      </Field>
      <Field label="City" optional>
        {(props) => (
          <Input
            {...props}
            value={draft.city}
            onChange={(e) => set({ city: e.target.value })}
            maxLength={120}
          />
        )}
      </Field>
      <Field label="Postal code" optional>
        {(props) => (
          <Input
            {...props}
            value={draft.postalCode}
            onChange={(e) => set({ postalCode: e.target.value })}
            maxLength={20}
          />
        )}
      </Field>
      <Field label="State" optional>
        {(props) => (
          <Input
            {...props}
            value={draft.state}
            onChange={(e) => set({ state: e.target.value })}
            maxLength={120}
          />
        )}
      </Field>
      <Field label="State code" optional hint="For GST, such as 30 for Goa.">
        {(props) => (
          <Input
            {...props}
            value={draft.stateCode}
            onChange={(e) => set({ stateCode: e.target.value })}
            maxLength={4}
          />
        )}
      </Field>
      <Field label="Country" optional className="col-span-2">
        {(props) => (
          <Input
            {...props}
            value={draft.country}
            onChange={(e) => set({ country: e.target.value })}
            maxLength={60}
          />
        )}
      </Field>
    </div>
  );
}
