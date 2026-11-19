'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { amountText, parseAmount, parsePercent, percentText } from '@/components/accounts/money';
import { useFirstProblem } from '@/components/engagement/first-problem';
import { IntoView } from '@/components/engagement/into-view';
import { CurrencyInput, SwitchField } from '@/components/settings/fields';
import { changedFields } from '@/components/settings/form-values';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Segmented, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { fromLocalInput, toLocalInput } from '@/lib/local-time';
import type { Property } from '@/lib/types';
import { RatePlanPicker } from './rate-plan-picker';
import type { Promo, PromoKind } from './types';

interface Values {
  code: string;
  /** Empty: all properties. */
  propertyId: string;
  kind: PromoKind;
  percent: string;
  amount: string;
  currency: string;
  /** Date and time as a `datetime-local` input holds it, in the viewer's own time zone. */
  bookFrom: string;
  bookTo: string;
  stayFrom: string;
  stayTo: string;
  minNights: string;
  maxUses: string;
  someRates: boolean;
  ratePlanIds: string[];
  description: string;
  active: boolean;
}

/** The fields of a promotional code as the server takes them. */
interface Body {
  description: string | null;
  propertyId: string | null;
  kind: PromoKind;
  value: number;
  currency: string | null;
  bookFrom: string | null;
  bookTo: string | null;
  stayFrom: string | null;
  stayTo: string | null;
  minNights: number;
  maxUses: number | null;
  ratePlanIds: string[] | null;
  active: boolean;
}

type Errors = Partial<
  Record<
    'code' | 'value' | 'currency' | 'bookTo' | 'stayTo' | 'minNights' | 'maxUses' | 'rates',
    string
  >
>;

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const MAX_VALUE = 1_000_000_000;
const MAX_USES = 1_000_000;
const USE_COUNTED =
  'A confirmed booking counts as a use. If it is cancelled, the use is given back.';

function wholeNumber(text: string): number | null {
  return /^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : null;
}

function initialValues(promo: Promo | undefined, propertyId: string, currency: string): Values {
  return {
    code: promo?.code ?? '',
    propertyId: promo ? (promo.propertyId ?? '') : propertyId,
    kind: promo?.kind ?? 'percent',
    percent: promo?.kind === 'percent' ? percentText(promo.value) : '',
    amount: promo?.kind === 'amount' ? amountText(promo.value, promo.currency ?? currency) : '',
    currency: promo?.currency ?? currency,
    bookFrom: toLocalInput(promo?.bookFrom ?? null),
    bookTo: toLocalInput(promo?.bookTo ?? null),
    stayFrom: promo?.stayFrom ?? '',
    stayTo: promo?.stayTo ?? '',
    minNights: String(promo?.minNights ?? 1),
    maxUses: promo?.maxUses ? String(promo.maxUses) : '',
    someRates: Boolean(promo?.ratePlanIds?.length),
    ratePlanIds: promo?.ratePlanIds ?? [],
    description: promo?.description ?? '',
    active: promo?.active ?? true,
  };
}

/**
 * The form as the server wants it, and what is wrong with it. The server applies the same
 * rules and has the last word.
 */
function read(values: Values, currency: string): { body: Body; errors: Errors } {
  const errors: Errors = {};
  let value = 0;
  if (values.kind === 'percent') {
    const bp = parsePercent(values.percent);
    if (bp === null || bp < 1 || bp >= 10_000) {
      errors.value = 'Enter a percentage above 0 and below 100, with at most two decimals.';
    } else value = bp;
  } else {
    const known = CURRENCY_PATTERN.test(currency);
    if (!known) errors.currency = 'Enter the three letters of the currency, such as INR.';
    const minor = parseAmount(values.amount, known ? currency : 'INR');
    if (minor === null || minor < 1 || minor > MAX_VALUE) {
      errors.value = 'Enter an amount above zero.';
    } else value = minor;
  }
  const bookFrom = fromLocalInput(values.bookFrom);
  const bookTo = fromLocalInput(values.bookTo);
  if (bookFrom && bookTo && bookFrom >= bookTo) {
    errors.bookTo = 'This has to be later than the start.';
  }
  if (values.stayFrom && values.stayTo && values.stayFrom > values.stayTo) {
    errors.stayTo = 'The last night cannot be before the first.';
  }
  const minNights = wholeNumber(values.minNights);
  if (minNights === null || minNights < 1 || minNights > 365) {
    errors.minNights = 'Enter a whole number from 1 to 365.';
  }
  const maxUses = values.maxUses.trim() === '' ? null : wholeNumber(values.maxUses);
  if (values.maxUses.trim() !== '' && (maxUses === null || maxUses < 1 || maxUses > MAX_USES)) {
    errors.maxUses = 'Enter a whole number of 1 or more, or leave it empty for no limit.';
  }
  if (values.someRates && values.ratePlanIds.length === 0) {
    errors.rates = 'Tick at least one rate, or let the code apply to every rate.';
  }
  return {
    errors,
    body: {
      description: values.description.trim() || null,
      propertyId: values.propertyId || null,
      kind: values.kind,
      value,
      currency: values.kind === 'amount' ? currency.toUpperCase() : null,
      bookFrom,
      bookTo,
      stayFrom: values.stayFrom || null,
      stayTo: values.stayTo || null,
      minNights: minNights ?? 1,
      maxUses,
      ratePlanIds: values.someRates ? values.ratePlanIds : null,
      active: values.active,
    },
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3
        id={headingId}
        className="border-b border-line pb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase"
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

/** Adds a promotional code, or changes one. A code keeps its name once it exists. */
export function PromoDialog({
  promo,
  codes,
  properties,
  onClose,
  onSaved,
}: {
  /** The code to change. Absent: a new one. */
  promo?: Promo;
  /** The codes that exist already, in capitals. */
  codes: string[];
  properties: Property[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const canAll = auth.canOrgWide('rates.write');
  const inUse = properties.filter((p) => p.active);
  const [initial] = useState(() =>
    initialValues(
      promo,
      canAll ? '' : (inUse.find((p) => auth.can('rates.write', p.id))?.id ?? ''),
      inUse[0]?.currency ?? 'INR',
    ),
  );
  const [values, setValues] = useState<Values>(initial);
  const [attempted, setAttempted] = useState(false);
  const firstProblem = useFirstProblem();
  const ratesId = useId();

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const property = properties.find((p) => p.id === values.propertyId);
  // A code for one property takes off that property's money; one for all says which money it means.
  const currencyOf = (form: Values) =>
    properties.find((p) => p.id === form.propertyId)?.currency ?? form.currency.trim();
  const currency = currencyOf(values);
  const options = properties.filter(
    (p) => (p.active && auth.can('rates.write', p.id)) || p.id === values.propertyId,
  );
  const { body, errors } = read(values, currency);
  const code = values.code.trim().toUpperCase();
  if (!promo) {
    if (!CODE_PATTERN.test(code)) {
      errors.code =
        'Use 2 to 30 letters and digits. Dashes and underscores are allowed after the first character.';
    } else if (codes.includes(code)) {
      errors.code = `The code ${code} already exists.`;
    }
  }
  const shown: Errors = attempted ? errors : {};
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = useAction(async () => {
    if (promo) {
      const patch = changedFields(read(initial, currencyOf(initial)).body, body);
      if (Object.keys(patch).length > 0) {
        await api(`/promos/${promo.id}`, { method: 'PATCH', body: patch });
      }
      toast.success(`Code ${promo.code} saved`);
    } else {
      await api('/promos', { body: { code, ...body } });
      toast.success(`Code ${code} added`);
    }
    onSaved();
    onClose();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length > 0) {
      firstProblem.show();
      return;
    }
    void save.run();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={promo ? `Edit code ${promo.code}` : 'New promotional code'}
      description="A code guests type when they book on the website, to get a lower price."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="promo-form" variant="primary" loading={save.busy}>
            {promo ? 'Save changes' : 'Add code'}
          </Button>
        </>
      }
    >
      <form
        ref={firstProblem.form}
        id="promo-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-5"
      >
        {save.error && (
          <IntoView>
            <Notice tone="danger">{save.error}</Notice>
          </IntoView>
        )}

        <Section title="Code">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Code"
              error={shown.code}
              hint={
                promo
                  ? 'A code keeps its name. For another name, switch this one off and add a new code.'
                  : 'What guests type. Capitals or not makes no difference.'
              }
            >
              {(props) => (
                <Input
                  {...props}
                  value={values.code}
                  maxLength={30}
                  disabled={Boolean(promo)}
                  autoFocus={!promo}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono uppercase"
                  onChange={(e) => set('code', e.target.value)}
                />
              )}
            </Field>
            <Field label="Valid at">
              {(props) => (
                <Select
                  {...props}
                  value={values.propertyId}
                  onChange={(e) =>
                    setValues((current) => ({
                      ...current,
                      propertyId: e.target.value,
                      // Rates belong to a property: those of another one would never match.
                      ratePlanIds: [],
                    }))
                  }
                >
                  {(canAll || values.propertyId === '') && <option value="">All properties</option>}
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Section>

        <Section title="Discount">
          <div>
            <Segmented
              label="Kind of discount"
              value={values.kind}
              onChange={(kind) => set('kind', kind)}
              options={[
                { value: 'percent', label: 'Percentage' },
                { value: 'amount', label: 'Fixed amount' },
              ]}
            />
          </div>
          {values.kind === 'percent' ? (
            <Field
              label="Percentage off every night"
              error={shown.value}
              hint="Taken off the room price of each night, before tax."
              className="sm:max-w-[50%]"
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="decimal"
                  value={values.percent}
                  onChange={(e) => set('percent', e.target.value)}
                  placeholder="10"
                  className="tabular"
                />
              )}
            </Field>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={`Amount off the stay${CURRENCY_PATTERN.test(currency) ? ` (${currency.toUpperCase()})` : ''}`}
                error={shown.value}
                hint="Taken off the room price of the whole stay, before tax."
              >
                {(props) => (
                  <Input
                    {...props}
                    inputMode="decimal"
                    value={values.amount}
                    onChange={(e) => set('amount', e.target.value)}
                    placeholder="500"
                    className="tabular"
                  />
                )}
              </Field>
              {!property && (
                <Field
                  label="Currency"
                  error={shown.currency}
                  hint="The code only works where rooms are priced in this currency."
                >
                  {(props) => (
                    <CurrencyInput
                      {...props}
                      value={values.currency}
                      onChange={(e) => set('currency', e.target.value)}
                    />
                  )}
                </Field>
              )}
            </div>
          )}
        </Section>

        <Section title="When it can be used">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="For bookings made from" optional hint="Empty: straight away.">
              {(props) => (
                <Input
                  {...props}
                  type="datetime-local"
                  value={values.bookFrom}
                  onChange={(e) => set('bookFrom', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Until"
              optional
              error={shown.bookTo}
              hint="Empty: no end. After this moment the code has expired."
            >
              {(props) => (
                <Input
                  {...props}
                  type="datetime-local"
                  value={values.bookTo}
                  min={values.bookFrom || undefined}
                  onChange={(e) => set('bookTo', e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="-mt-1 text-[13px] text-ink-faint">
            Times are in your own time zone ({timeZone}).
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="For nights from" optional>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={values.stayFrom}
                  onChange={(e) => set('stayFrom', e.target.value)}
                />
              )}
            </Field>
            <Field label="Up to the night of" optional error={shown.stayTo}>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={values.stayTo}
                  min={values.stayFrom || undefined}
                  onChange={(e) => set('stayTo', e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="-mt-1 text-[13px] text-ink-faint">
            Every night of the stay has to be within these dates. Empty: any dates.
          </p>
        </Section>

        <Section title="Limits">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Shortest stay, in nights" error={shown.minNights}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  step={1}
                  value={values.minNights}
                  onChange={(e) => set('minNights', e.target.value)}
                  className="tabular"
                />
              )}
            </Field>
            <Field
              label="Times it can be used"
              optional
              error={shown.maxUses}
              hint={
                promo
                  ? `Empty: no limit. Used ${plural(promo.usedCount, 'time')} so far. ${USE_COUNTED}`
                  : `Empty: no limit. ${USE_COUNTED}`
              }
            >
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_USES}
                  step={1}
                  value={values.maxUses}
                  onChange={(e) => set('maxUses', e.target.value)}
                  className="tabular"
                />
              )}
            </Field>
          </div>
          <div role="group" aria-labelledby={ratesId} className="flex flex-col gap-2">
            <p id={ratesId} className="text-[13px] font-medium text-ink-soft">
              Rates it applies to
            </p>
            <div>
              <Segmented
                label="Rates it applies to"
                value={values.someRates ? 'some' : 'any'}
                onChange={(next) => set('someRates', next === 'some')}
                options={[
                  { value: 'any', label: 'Every rate' },
                  { value: 'some', label: 'Only chosen rates' },
                ]}
              />
            </div>
            {values.someRates && (
              <RatePlanPicker
                propertyIds={property ? [property.id] : inUse.map((p) => p.id)}
                selected={values.ratePlanIds}
                onChange={(ratePlanIds) => set('ratePlanIds', ratePlanIds)}
              />
            )}
            {shown.rates && (
              <p role="alert" className="text-[13px] text-danger-600">
                {shown.rates}
              </p>
            )}
          </div>
        </Section>

        <Section title="For your own use">
          <Field
            label="Note"
            optional
            hint="Why the code exists or who it is for. Guests do not see it."
          >
            {(props) => (
              <Textarea
                {...props}
                rows={2}
                maxLength={300}
                value={values.description}
                onChange={(e) => set('description', e.target.value)}
              />
            )}
          </Field>
          <SwitchField
            label="Switched on"
            hint="Switched off, the website turns the code down."
            checked={values.active}
            onChange={(active) => set('active', active)}
            className="rounded-lg border border-line p-3"
          />
        </Section>
      </form>
    </Dialog>
  );
}
