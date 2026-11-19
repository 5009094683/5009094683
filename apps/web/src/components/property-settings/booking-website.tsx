'use client';

import { SwitchField } from '@/components/settings/fields';
import { Field, Segmented } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/misc';
import { plural } from '@/lib/format';
import type { Property, PropertyDetail } from '@/lib/types';
import { FormSection, Item, Items, SettingsCard, SettingsDialog, WholeNumberInput } from './parts';
import { useSettingsForm, type Reading } from './use-settings-form';
import {
  DEFAULTS,
  LIMITS,
  websitePath,
  wholeNumber,
  type BookingPayment,
  type Settings,
} from './values';

const NON_REFUNDABLE = 'A non-refundable rate is always paid in full when it is booked.';

function paymentInWords(payment: BookingPayment, depositPercent: number): string {
  if (payment === 'deposit') {
    return `A deposit of ${depositPercent}% of the stay. The rest is paid at the property.`;
  }
  if (payment === 'none') return 'Nothing. Guests pay at the property.';
  return 'The whole stay.';
}

/** Room types the website sells: in use, with a rate plan that is in use and bookable there. */
function soldOnWebsite(detail: PropertyDetail): boolean {
  return detail.roomTypes.some(
    (roomType) =>
      roomType.active && roomType.ratePlans.some((plan) => plan.active && plan.publicBookable),
  );
}

/** Whether guests can book the property on the website, and what they pay when they do. */
export function BookingWebsiteCard({
  detail,
  canManage,
  onEdit,
}: {
  detail: PropertyDetail;
  canManage: boolean;
  onEdit?: () => void;
}) {
  const { property } = detail;
  const { settings } = property;
  const enabled = Boolean(settings.bookingEngineEnabled);
  const shown = enabled && property.active;
  return (
    <SettingsCard
      title="Booking website"
      status={<Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>}
      onEdit={onEdit}
    >
      {!enabled ? (
        <p className="text-sm text-ink-soft">
          Guests cannot find or book this property on the website.
        </p>
      ) : !property.active ? (
        <Notice tone="warning">
          Guests cannot find this property on the website while it is inactive.
          {canManage && ' Make it active under Edit details.'}
        </Notice>
      ) : (
        <p className="text-sm text-ink-soft">
          Guests can find this property on the website and book it there.
        </p>
      )}
      {shown && !soldOnWebsite(detail) && (
        <Notice tone="warning" className="mt-3">
          Nothing can be booked there yet: no room type has a rate plan that is active and bookable
          on the website. That is set on each rate plan, under Room types.
        </Notice>
      )}
      <Items className="mt-3">
        {shown && (
          <Item
            label="Page on the website"
            note={
              detail.bookingSiteUrl
                ? 'Opens the page guests book on.'
                : 'Put this after the address of your website to open the page.'
            }
            className="sm:col-span-2"
          >
            {detail.bookingSiteUrl ? (
              <a
                href={detail.bookingSiteUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[13px] break-all text-brand-700 hover:underline"
              >
                {detail.bookingSiteUrl}
              </a>
            ) : (
              <span className="font-mono text-[13px]">{websitePath(property)}</span>
            )}
          </Item>
        )}
        <Item label="Paid when booking" note={NON_REFUNDABLE} className="sm:col-span-2">
          {paymentInWords(
            settings.bookingPayment ?? 'full',
            settings.depositPercent ?? DEFAULTS.depositPercent,
          )}
        </Item>
        <Item label="Time to pay" note="The rooms are held for the guest that long.">
          {plural(settings.bookingHoldMinutes ?? DEFAULTS.bookingHoldMinutes, 'minute')}
        </Item>
        <Item
          label="Children"
          note={
            settings.childMaxAge === undefined ? 'The website says nothing about their age.' : null
          }
        >
          {settings.childMaxAge === undefined ? null : `Aged ${settings.childMaxAge} or under`}
        </Item>
      </Items>
    </SettingsCard>
  );
}

interface Values {
  enabled: boolean;
  payment: BookingPayment;
  depositPercent: string;
  holdMinutes: string;
  childMaxAge: string;
}

type Body = Pick<
  Settings,
  'bookingEngineEnabled' | 'bookingPayment' | 'depositPercent' | 'bookingHoldMinutes'
> & {
  /** Null takes a saved age away again. */
  childMaxAge?: number | null;
};

type Problem = 'depositPercent' | 'holdMinutes' | 'childMaxAge';

function valuesFrom(settings: Settings): Values {
  return {
    enabled: settings.bookingEngineEnabled ?? false,
    payment: settings.bookingPayment ?? 'full',
    depositPercent: String(settings.depositPercent ?? DEFAULTS.depositPercent),
    holdMinutes: String(settings.bookingHoldMinutes ?? DEFAULTS.bookingHoldMinutes),
    childMaxAge: settings.childMaxAge === undefined ? '' : String(settings.childMaxAge),
  };
}

function read(values: Values, settings: Settings): Reading<Body, Problem> {
  const problems: Reading<Body, Problem>['problems'] = {};
  const body: Body = { bookingEngineEnabled: values.enabled, bookingPayment: values.payment };

  // The share only counts while a deposit is taken; chosen otherwise, it is left as it was.
  if (values.payment === 'deposit') {
    const percent = wholeNumber(values.depositPercent, LIMITS.depositPercent);
    if (percent === null) problems.depositPercent = 'Enter a whole number from 1 to 100.';
    else body.depositPercent = percent;
  }

  const minutes = wholeNumber(values.holdMinutes, LIMITS.holdMinutes);
  if (minutes === null) problems.holdMinutes = 'Enter a whole number from 5 to 120.';
  else body.bookingHoldMinutes = minutes;

  if (values.childMaxAge.trim() === '') {
    // Emptied: the age is taken away, and the website says nothing about age again.
    if (settings.childMaxAge !== undefined) body.childMaxAge = null;
  } else {
    const age = wholeNumber(values.childMaxAge, LIMITS.childMaxAge);
    if (age === null) problems.childMaxAge = 'Enter a whole number from 0 to 17.';
    else body.childMaxAge = age;
  }
  return { body, problems };
}

const PAYMENT_OPTIONS: { value: BookingPayment; label: string }[] = [
  { value: 'full', label: 'The whole stay' },
  { value: 'deposit', label: 'A deposit' },
  { value: 'none', label: 'Nothing' },
];

const PAYMENT_MEANS: Record<BookingPayment, string> = {
  full: 'Guests pay for the whole stay when they book.',
  deposit: 'Guests pay a share of the stay when they book, and the rest at the property.',
  none: 'Guests pay nothing when they book. The booking is confirmed at once and they pay at the property.',
};

export function BookingWebsiteDialog({
  property,
  onClose,
}: {
  property: Property;
  onClose: () => void;
}) {
  const { settings } = property;
  const form = useSettingsForm<Values, Body, Problem>({
    property,
    start: () => valuesFrom(settings),
    read: (values) => read(values, settings),
    // Saved, though not in force unless a deposit is taken: choosing a deposit keeps it.
    stored: { depositPercent: settings.depositPercent },
    saved: (changes) => ({
      message: 'Booking website settings saved',
      detail:
        changes.bookingEngineEnabled === undefined
          ? undefined
          : changes.bookingEngineEnabled
            ? property.active
              ? `Guests can now book ${property.name} on the website.`
              : `${property.name} is inactive, so it is not on the website yet.`
            : `${property.name} is no longer on the website.`,
    }),
    onClose,
  });
  const { values, change, problems } = form;

  return (
    <SettingsDialog
      title="Booking website"
      description={`Whether guests can book ${property.name} on the website, and what they pay when they do.`}
      size="md"
      form={form}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <SwitchField
          label="Bookable on the website"
          hint="Switched off, the property’s page on the website is gone and nothing new can be booked there. Guests who have booked can still open their booking."
          checked={values.enabled}
          onChange={(enabled) => change({ enabled })}
        />
        {values.enabled && !property.active && (
          <Notice tone="warning">
            This property is inactive, and an inactive property is left off the website. It shows
            there once it is made active under Edit details.
          </Notice>
        )}
      </div>

      <FormSection title="Payment">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <p className="text-[13px] font-medium text-ink-soft">Paid when booking</p>
          <div>
            <Segmented
              label="Paid when booking"
              value={values.payment}
              onChange={(payment) => change({ payment })}
              options={PAYMENT_OPTIONS}
            />
          </div>
          <p className="text-[13px] text-ink-faint">
            {PAYMENT_MEANS[values.payment]} {NON_REFUNDABLE}
          </p>
        </div>
        {values.payment === 'deposit' && (
          <Field
            label="Deposit (% of the stay)"
            hint={`From 1 to 100. ${DEFAULTS.depositPercent} unless changed.`}
            error={problems.depositPercent}
          >
            {(props) => (
              <WholeNumberInput
                {...props}
                value={values.depositPercent}
                onChange={(e) => change({ depositPercent: e.target.value })}
              />
            )}
          </Field>
        )}
        <Field
          label="Minutes to pay"
          hint={`From 5 to 120. ${DEFAULTS.bookingHoldMinutes} unless changed.`}
          error={problems.holdMinutes}
        >
          {(props) => (
            <WholeNumberInput
              {...props}
              value={values.holdMinutes}
              onChange={(e) => change({ holdMinutes: e.target.value })}
            />
          )}
        </Field>
        <p className="text-[13px] text-ink-faint sm:col-span-2">
          A booking keeps its rooms for this long while the guest pays. If it is not paid by then,
          it is cancelled and the rooms go back on sale.
        </p>
      </FormSection>

      <FormSection title="Children">
        <Field
          label="Children are aged up to"
          optional
          hint="From 0 to 17. The website tells guests this where they say who is staying. Left empty, it says nothing about age."
          error={problems.childMaxAge}
          className="sm:col-span-2"
        >
          {(props) => (
            <WholeNumberInput
              {...props}
              value={values.childMaxAge}
              onChange={(e) => change({ childMaxAge: e.target.value })}
            />
          )}
        </Field>
      </FormSection>
    </SettingsDialog>
  );
}
