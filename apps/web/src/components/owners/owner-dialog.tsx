'use client';

import { useState } from 'react';
import { FormError } from '@/components/housekeeping/form-error';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useProblems } from './problems';
import type { Owner } from './types';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GSTIN = /^[0-9]{2}[0-9A-Z]{13}$/;

type Problem = 'name' | 'email' | 'country' | 'gstin';

const nullable = (value: string): string | null => value.trim() || null;

/** What the API answers when an owner is added or changed: the owner without contracts or sign-in. */
type SavedOwner = Omit<Owner, 'contracts' | 'user'>;

/** Adds a villa owner, or changes one's contact details. */
export function OwnerDialog({
  owner,
  onClose,
  onSaved,
}: {
  /** The owner to change. Absent: a new one. */
  owner?: Owner;
  onClose: () => void;
  onSaved: (owner: SavedOwner) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(owner?.name ?? '');
  const [legalName, setLegalName] = useState(owner?.legalName ?? '');
  const [email, setEmail] = useState(owner?.email ?? '');
  const [phone, setPhone] = useState(owner?.phone ?? '');
  const [addressLine1, setAddressLine1] = useState(owner?.addressLine1 ?? '');
  const [city, setCity] = useState(owner?.city ?? '');
  const [state, setState] = useState(owner?.state ?? '');
  const [postalCode, setPostalCode] = useState(owner?.postalCode ?? '');
  const [country, setCountry] = useState(owner?.country ?? 'IN');
  const [gstin, setGstin] = useState(owner?.gstin ?? '');
  const [notes, setNotes] = useState(owner?.notes ?? '');
  const [active, setActive] = useState(owner?.active ?? true);
  const { problems, accept, clear, form } = useProblems<Problem>();

  const save = useAction(async () => {
    const found: Partial<Record<Problem, string>> = {};
    if (!name.trim()) found.name = 'Enter the name of the owner.';
    const emailValue = email.trim().toLowerCase();
    if (emailValue && !EMAIL.test(emailValue)) {
      found.email = 'Enter an email address such as name@example.com, or leave this empty.';
    }
    const gstinValue = gstin.trim().toUpperCase();
    if (gstinValue && !GSTIN.test(gstinValue)) {
      found.gstin = 'A GSTIN is 15 letters and digits, starting with the two-digit state code.';
    }
    // Left empty, the country is taken to be India, as it is everywhere else in the system.
    const countryValue = country.trim().toUpperCase() || 'IN';
    if (!/^[A-Z]{2}$/.test(countryValue)) {
      found.country = 'Enter the two letters of the country, such as IN.';
    }
    if (!accept(found)) return;

    const body = {
      name: name.trim(),
      legalName: nullable(legalName),
      email: emailValue || null,
      phone: nullable(phone),
      addressLine1: nullable(addressLine1),
      city: nullable(city),
      state: nullable(state),
      postalCode: nullable(postalCode),
      country: countryValue,
      gstin: gstinValue || null,
      notes: nullable(notes),
      ...(owner ? { active } : {}),
    };
    const saved = owner
      ? await api<SavedOwner>(`/owners/${owner.id}`, { method: 'PATCH', body })
      : await api<SavedOwner>('/owners', { body });
    toast.success(owner ? `${saved.name} saved` : `${saved.name} added`);
    onSaved(saved);
    onClose();
  });

  const signInDiffers =
    owner?.user && email.trim().toLowerCase() !== owner.user.email.toLowerCase();

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={owner ? `Edit ${owner.name}` : 'Add an owner'}
      description={
        owner
          ? undefined
          : 'The person or company a villa belongs to. Their contract comes next, on their page.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="owner-form" variant="primary" loading={save.busy}>
            {owner ? 'Save' : 'Add owner'}
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id="owner-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        <FormError message={save.error ? `Could not save. ${save.error}` : null} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" error={problems.name}>
            {(props) => (
              <Input
                {...props}
                required
                maxLength={200}
                autoFocus={!owner}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clear('name');
                }}
              />
            )}
          </Field>
          <Field
            label="Registered name"
            optional
            hint="When the villa is held by a company or under another name."
          >
            {(props) => (
              <Input
                {...props}
                maxLength={200}
                value={legalName}
                onChange={(event) => setLegalName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Email"
            optional
            hint={
              signInDiffers
                ? `Statements go to this address. They still sign in to the owner portal with ${owner.user?.email}.`
                : 'Statements are emailed here, and it becomes their sign-in if you invite them to the owner portal.'
            }
            error={problems.email}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                maxLength={254}
                autoComplete="off"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clear('email');
                }}
              />
            )}
          </Field>
          <Field label="Phone" optional>
            {(props) => (
              <Input
                {...props}
                type="tel"
                maxLength={40}
                autoComplete="off"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            )}
          </Field>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Address and tax
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Address" optional className="sm:col-span-2">
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  autoComplete="off"
                  value={addressLine1}
                  onChange={(event) => setAddressLine1(event.target.value)}
                />
              )}
            </Field>
            <Field label="City" optional>
              {(props) => (
                <Input
                  {...props}
                  maxLength={120}
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                />
              )}
            </Field>
            <Field label="State" optional>
              {(props) => (
                <Input
                  {...props}
                  maxLength={120}
                  value={state}
                  onChange={(event) => setState(event.target.value)}
                />
              )}
            </Field>
            <Field label="Postal code" optional>
              {(props) => (
                <Input
                  {...props}
                  maxLength={20}
                  value={postalCode}
                  onChange={(event) => setPostalCode(event.target.value)}
                />
              )}
            </Field>
            <Field label="Country" hint="Two letters, such as IN." error={problems.country}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={2}
                  autoCapitalize="characters"
                  value={country}
                  onChange={(event) => {
                    setCountry(event.target.value.toUpperCase());
                    clear('country');
                  }}
                />
              )}
            </Field>
            <Field label="GSTIN" optional error={problems.gstin}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={15}
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={gstin}
                  onChange={(event) => {
                    setGstin(event.target.value.toUpperCase());
                    clear('gstin');
                  }}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <Field
          label="Notes"
          optional
          hint="For the accounts team only, such as how the owner prefers to be paid. The owner does not see them."
        >
          {(props) => (
            <Textarea
              {...props}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>

        {owner && (
          <div className="flex flex-col gap-1">
            <Checkbox
              label="Active"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            <p className="text-[13px] text-ink-faint">
              An inactive owner can no longer use the owner portal. Their contracts and statements
              are kept.
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
