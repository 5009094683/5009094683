'use client';

import { SwitchField } from '@/components/settings/fields';
import { Field, Input, Select } from '@/components/ui/field';
import { plural } from '@/lib/format';
import { useProperties } from '@/lib/hooks';
import type { Property } from '@/lib/types';
import { FormSection, Item, Items, SettingsCard, SettingsDialog, WholeNumberInput } from './parts';
import { useSettingsForm, type Reading } from './use-settings-form';
import {
  DEFAULTS,
  LIMITS,
  hourText,
  invoicePrefixOf,
  isIndia,
  sampleInvoiceNumber,
  wholeNumber,
  type Settings,
} from './values';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The night audit, invoice numbers and cleaning times of a property. */
export function HouseCard({ property, onEdit }: { property: Property; onEdit?: () => void }) {
  const { settings } = property;
  const prefix = invoicePrefixOf(property);
  return (
    <SettingsCard title="House settings" onEdit={onEdit}>
      <Items>
        <Item label="Night audit">
          {settings.nightAuditHour === null
            ? 'The automatic run is off'
            : `Runs by itself at ${hourText(settings.nightAuditHour ?? DEFAULTS.nightAuditHour)}`}
        </Item>
        <Item label="Bookings that do not arrive">
          {settings.autoNoShow
            ? 'Marked no-show by the night audit'
            : 'Listed by the night audit, and left as they are'}
        </Item>
        <Item
          label="Invoice numbers start with"
          note={`As in ${sampleInvoiceNumber(prefix, property)}`}
        >
          <span className="font-mono text-[13px]">{prefix}</span>
        </Item>
        {isIndia(property) && (
          <Item label="Specified premises for GST">
            {settings.specifiedPremises ? 'Yes' : 'No'}
          </Item>
        )}
        <Item label="Departure clean">
          {plural(settings.departureCleanMinutes ?? DEFAULTS.departureCleanMinutes, 'minute')}
        </Item>
        <Item label="Stay-over clean">
          {plural(settings.stayoverCleanMinutes ?? DEFAULTS.stayoverCleanMinutes, 'minute')}
        </Item>
      </Items>
    </SettingsCard>
  );
}

interface Values {
  automatic: boolean;
  hour: string;
  autoNoShow: boolean;
  prefix: string;
  specifiedPremises: boolean;
  departureMinutes: string;
  stayoverMinutes: string;
}

type Body = Pick<
  Settings,
  | 'nightAuditHour'
  | 'autoNoShow'
  | 'invoicePrefix'
  | 'specifiedPremises'
  | 'departureCleanMinutes'
  | 'stayoverCleanMinutes'
>;

type Problem = 'prefix' | 'departureMinutes' | 'stayoverMinutes';

function valuesFrom(property: Property): Values {
  const { settings } = property;
  return {
    automatic: settings.nightAuditHour !== null,
    hour: String(settings.nightAuditHour ?? DEFAULTS.nightAuditHour),
    autoNoShow: settings.autoNoShow ?? false,
    // Shown as it comes out on an invoice, saved or not: what was never saved comes from the code.
    prefix: invoicePrefixOf(property),
    specifiedPremises: settings.specifiedPremises ?? false,
    departureMinutes: String(settings.departureCleanMinutes ?? DEFAULTS.departureCleanMinutes),
    stayoverMinutes: String(settings.stayoverCleanMinutes ?? DEFAULTS.stayoverCleanMinutes),
  };
}

const prefixOf = (typed: string): string | null => {
  const prefix = typed.trim().toUpperCase();
  return /^[A-Z0-9]{1,4}$/.test(prefix) ? prefix : null;
};

function read(values: Values, property: Property): Reading<Body, Problem> {
  const problems: Reading<Body, Problem>['problems'] = {};
  const body: Body = {
    // Null is how the automatic run is switched off.
    nightAuditHour: values.automatic ? Number(values.hour) : null,
    autoNoShow: values.autoNoShow,
  };

  const prefix = prefixOf(values.prefix);
  if (prefix === null) problems.prefix = 'Enter one to four letters or digits, and nothing else.';
  else body.invoicePrefix = prefix;

  // The setting means nothing outside India, so it is neither shown nor sent there.
  if (isIndia(property)) body.specifiedPremises = values.specifiedPremises;

  const departure = wholeNumber(values.departureMinutes, LIMITS.cleanMinutes);
  if (departure === null) problems.departureMinutes = 'Enter a whole number from 5 to 480.';
  else body.departureCleanMinutes = departure;
  const stayover = wholeNumber(values.stayoverMinutes, LIMITS.cleanMinutes);
  if (stayover === null) problems.stayoverMinutes = 'Enter a whole number from 5 to 480.';
  else body.stayoverCleanMinutes = stayover;

  return { body, problems };
}

export function HouseDialog({ property, onClose }: { property: Property; onClose: () => void }) {
  const { properties } = useProperties();
  const form = useSettingsForm<Values, Body, Problem>({
    property,
    start: () => valuesFrom(property),
    read: (values) => read(values, property),
    saved: () => ({ message: 'House settings saved' }),
    onClose,
  });
  const { values, change, problems } = form;

  const prefix = prefixOf(values.prefix);
  const sample = sampleInvoiceNumber(prefix ?? invoicePrefixOf(property), property);
  const sharing =
    prefix === null
      ? []
      : properties.filter((other) => other.id !== property.id && invoicePrefixOf(other) === prefix);

  return (
    <SettingsDialog
      title="House settings"
      description={`The night audit, invoice numbers and cleaning times of ${property.name}.`}
      form={form}
      onClose={onClose}
    >
      <FormSection title="Night audit">
        <SwitchField
          label="Run the night audit automatically"
          hint="The night audit closes the hotel day: it charges the rooms for the night and writes the cleaning list for the next day. Switched off, someone has to run it under Accounts, Night audit."
          checked={values.automatic}
          onChange={(automatic) => change({ automatic })}
          className="sm:col-span-2"
        />
        {values.automatic && (
          <Field
            label="Time of the automatic run"
            hint={`By the clock at the property (${property.timezone}). A hotel day is closed on the day after it: with ${hourText(Number(values.hour))}, Monday is closed on Tuesday at ${hourText(Number(values.hour))}.`}
            className="sm:col-span-2"
          >
            {(props) => (
              <Select
                {...props}
                value={values.hour}
                onChange={(e) => change({ hour: e.target.value })}
                className="sm:max-w-40"
              >
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {hourText(hour)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <SwitchField
          label="Mark bookings that do not arrive as no-show"
          hint={
            values.autoNoShow
              ? 'When the night audit runs, bookings that were due and did not arrive are marked no-show.'
              : 'When the night audit runs, bookings that were due and did not arrive are listed, and left as they are.'
          }
          checked={values.autoNoShow}
          onChange={(autoNoShow) => change({ autoNoShow })}
          className="sm:col-span-2"
        />
      </FormSection>

      <FormSection title="Invoices">
        <Field
          label="Invoice prefix"
          hint={`Up to four letters or digits. Every invoice number starts with it, as in ${sample}. A change affects only invoices issued from then on: those already issued keep their numbers, and the count carries on.`}
          error={problems.prefix}
          className="sm:col-span-2"
        >
          {(props) => (
            <Input
              {...props}
              value={values.prefix}
              onChange={(e) => change({ prefix: e.target.value })}
              maxLength={4}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono uppercase sm:max-w-40"
            />
          )}
        </Field>
        {sharing.length > 0 && (
          <p className="text-[13px] text-warning-700 sm:col-span-2">
            {sharing.map((other) => other.name).join(', ')}{' '}
            {sharing.length === 1 ? 'starts' : 'start'} invoice numbers with {prefix} too, so
            invoices of different properties would carry the same number.
          </p>
        )}
        {isIndia(property) && (
          <SwitchField
            label="Specified premises for GST"
            hint="Read once, when this property’s tax rules are first set up: food and drink are then taxed at 18% instead of 5%. After that it changes nothing, and the rate is changed under Accounts, Tax rules."
            checked={values.specifiedPremises}
            onChange={(specifiedPremises) => change({ specifiedPremises })}
            className="sm:col-span-2"
          />
        )}
      </FormSection>

      <FormSection title="Housekeeping">
        <Field
          label="Departure clean (minutes)"
          hint={`From 5 to 480. ${DEFAULTS.departureCleanMinutes} unless changed.`}
          error={problems.departureMinutes}
        >
          {(props) => (
            <WholeNumberInput
              {...props}
              value={values.departureMinutes}
              onChange={(e) => change({ departureMinutes: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Stay-over clean (minutes)"
          hint={`From 5 to 480. ${DEFAULTS.stayoverCleanMinutes} unless changed.`}
          error={problems.stayoverMinutes}
        >
          {(props) => (
            <WholeNumberInput
              {...props}
              value={values.stayoverMinutes}
              onChange={(e) => change({ stayoverMinutes: e.target.value })}
            />
          )}
        </Field>
        <p className="text-[13px] text-ink-faint sm:col-span-2">
          How long one clean takes. “Cleaning ahead” on the Housekeeping screen works out from these
          how much cleaning each of the coming days holds, and how many housekeepers it takes.
        </p>
      </FormSection>
    </SettingsDialog>
  );
}
