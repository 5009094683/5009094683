'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useAccountsCurrency } from './currency';
import { FormError } from './form-error';
import { amountText, parseAmount, parsePercent, percentText } from './money';
import type { Company, CompanyKind } from './types';

export const KIND_LABELS: Record<CompanyKind, string> = {
  corporate: 'Company',
  travel_agent: 'Travel agent',
};

const GSTIN = /^[0-9]{2}[0-9A-Z]{13}$/;

interface Problems {
  gstin?: string;
  creditLimit?: string;
  terms?: string;
  commission?: string;
}

const nullable = (value: string): string | null => value.trim() || null;

/** Adds a company or travel agent, or changes one. */
export function CompanyDialog({
  company,
  onClose,
  onSaved,
}: {
  /** The company to change. Absent: a new one. */
  company?: Company;
  onClose: () => void;
  onSaved: (company: Company) => void;
}) {
  const toast = useToast();
  const currency = useAccountsCurrency();
  const [kind, setKind] = useState<CompanyKind>(company?.kind ?? 'corporate');
  const [name, setName] = useState(company?.name ?? '');
  const [legalName, setLegalName] = useState(company?.legalName ?? '');
  const [gstin, setGstin] = useState(company?.gstin ?? '');
  const [addressLine1, setAddressLine1] = useState(company?.addressLine1 ?? '');
  const [city, setCity] = useState(company?.city ?? '');
  const [state, setState] = useState(company?.state ?? '');
  const [stateCode, setStateCode] = useState(company?.stateCode ?? '');
  const [postalCode, setPostalCode] = useState(company?.postalCode ?? '');
  const [country, setCountry] = useState(company?.country ?? 'IN');
  const [contactName, setContactName] = useState(company?.contactName ?? '');
  const [email, setEmail] = useState(company?.email ?? '');
  const [phone, setPhone] = useState(company?.phone ?? '');
  const [creditLimit, setCreditLimit] = useState(
    company && company.creditLimit !== null ? amountText(company.creditLimit, currency) : '',
  );
  const [terms, setTerms] = useState(String(company?.paymentTermsDays ?? 30));
  const [commission, setCommission] = useState(percentText(company?.commissionBp ?? 0));
  const [notes, setNotes] = useState(company?.notes ?? '');
  const [active, setActive] = useState(company?.active ?? true);
  const [problems, setProblems] = useState<Problems>({});
  const form = useRef<HTMLFormElement>(null);

  // The form is longer than the dialog: go to the first field that needs a look.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problems]);

  const agent = kind === 'travel_agent';

  const save = useAction(async () => {
    const found: Problems = {};
    const gstinValue = gstin.trim().toUpperCase();
    if (gstinValue && !GSTIN.test(gstinValue)) {
      found.gstin = 'A GSTIN is 15 letters and digits, starting with the two-digit state code.';
    }
    const limit = creditLimit.trim() === '' ? null : parseAmount(creditLimit, currency);
    if (creditLimit.trim() !== '' && limit === null) {
      found.creditLimit = 'Enter an amount, or leave this empty for no limit.';
    }
    const days = /^\d{1,3}$/.test(terms.trim()) ? Number(terms) : null;
    if (days === null || days > 365) found.terms = 'Enter a number of days from 0 to 365.';
    const commissionBp = agent ? parsePercent(commission.trim() || '0') : 0;
    if (commissionBp === null || commissionBp > 5000) {
      found.commission = 'Enter a percentage from 0 to 50.';
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    const body = {
      kind,
      name: name.trim(),
      legalName: nullable(legalName),
      gstin: gstinValue || null,
      addressLine1: nullable(addressLine1),
      city: nullable(city),
      state: nullable(state),
      // Left out when empty beside a GSTIN: the server then takes it from the GSTIN's first two digits.
      ...(stateCode.trim() || !gstinValue ? { stateCode: nullable(stateCode) } : {}),
      postalCode: nullable(postalCode),
      country: country.trim().toUpperCase() || 'IN',
      contactName: nullable(contactName),
      email: nullable(email),
      phone: nullable(phone),
      creditLimit: limit,
      paymentTermsDays: days ?? 30,
      commissionBp: commissionBp ?? 0,
      notes: nullable(notes),
      ...(company ? { active } : {}),
    };
    const saved = company
      ? await api<Company>(`/companies/${company.id}`, { method: 'PATCH', body })
      : await api<Company>('/companies', { body });
    toast.success(company ? `${saved.name} saved` : `${saved.name} added`);
    onSaved(saved);
    onClose();
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={company ? `Edit ${company.name}` : 'Add a company or travel agent'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="company-form" variant="primary" loading={save.busy}>
            {company ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id="company-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        <FormError message={save.error} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Kind">
            {(props) => (
              <Select
                {...props}
                value={kind}
                onChange={(event) => setKind(event.target.value as CompanyKind)}
              >
                <option value="corporate">{KIND_LABELS.corporate}</option>
                <option value="travel_agent">{KIND_LABELS.travel_agent}</option>
              </Select>
            )}
          </Field>
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                required
                maxLength={200}
                autoFocus={!company}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Name on invoices"
            optional
            hint="The registered name, when it differs."
            className="sm:col-span-2"
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
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Tax and address
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="GSTIN" optional error={problems.gstin}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={15}
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={gstin}
                  onChange={(event) => setGstin(event.target.value.toUpperCase())}
                />
              )}
            </Field>
            <Field label="State code" optional hint="Taken from the GSTIN when left empty.">
              {(props) => (
                <Input
                  {...props}
                  maxLength={4}
                  inputMode="numeric"
                  value={stateCode}
                  onChange={(event) => setStateCode(event.target.value)}
                />
              )}
            </Field>
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
            <Field label="Country" hint="Two letters, such as IN.">
              {(props) => (
                <Input
                  {...props}
                  required
                  maxLength={2}
                  autoCapitalize="characters"
                  value={country}
                  onChange={(event) => setCountry(event.target.value.toUpperCase())}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Contact
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Contact person" optional className="sm:col-span-2">
              {(props) => (
                <Input
                  {...props}
                  maxLength={160}
                  value={contactName}
                  onChange={(event) => setContactName(event.target.value)}
                />
              )}
            </Field>
            <Field label="Email" optional>
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  maxLength={200}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>
            <Field label="Phone" optional>
              {(props) => (
                <Input
                  {...props}
                  type="tel"
                  maxLength={40}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Credit
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={`Credit limit (${currency})`}
              optional
              hint="The most it may owe on account. Empty means no limit."
              error={problems.creditLimit}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="decimal"
                  value={creditLimit}
                  onChange={(event) => setCreditLimit(event.target.value)}
                />
              )}
            </Field>
            <Field
              label="Payment terms (days)"
              hint="How long it has to pay a bill."
              error={problems.terms}
            >
              {(props) => (
                <Input
                  {...props}
                  required
                  inputMode="numeric"
                  value={terms}
                  onChange={(event) => setTerms(event.target.value)}
                />
              )}
            </Field>
            {agent && (
              <Field
                label="Commission (%)"
                hint="The share of room revenue the agent keeps."
                error={problems.commission}
              >
                {(props) => (
                  <Input
                    {...props}
                    inputMode="decimal"
                    value={commission}
                    onChange={(event) => setCommission(event.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        </fieldset>

        <Field label="Notes" optional>
          {(props) => (
            <Textarea
              {...props}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>

        {company && (
          <div className="flex flex-col gap-1">
            <Checkbox
              label="Active"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            <p className="text-[13px] text-ink-faint">
              An inactive company is left out of lists, and nothing more can be billed to it.
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
