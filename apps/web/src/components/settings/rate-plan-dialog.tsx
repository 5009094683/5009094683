'use client';

import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatMoney, toMinor } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Property, PropertyDetail, RatePlan } from '@/lib/types';
import { CodeInput, SwitchField } from './fields';
import { changedFields, intOrNull, majorText, minorOrNull, textOrNull } from './form-values';
import { MEAL_PLAN_LABELS } from './labels';
import { adjustmentText, defaultNightlyRate, deriveRate, followerIds } from './rate-plans';

type RoomTypeDetail = PropertyDetail['roomTypes'][number];
type Penalty = NonNullable<RatePlan['cancellationPolicy']['penalty']>;

const PENALTY_LABELS: Record<Penalty, string> = {
  first_night: 'The first night',
  percent: 'A percentage of the stay',
  full: 'The full stay',
};

interface Values {
  code: string;
  name: string;
  description: string;
  mealPlan: RatePlan['mealPlan'];
  parentRatePlanId: string;
  baseRate: string;
  percent: string;
  amount: string;
  includedOccupancy: string;
  extraAdultRate: string;
  extraChildRate: string;
  floorRate: string;
  ceilingRate: string;
  minStay: string;
  maxStay: string;
  nonRefundable: boolean;
  freeCancelDays: string;
  penalty: Penalty | '';
  penaltyPercent: string;
  isDefault: boolean;
  publicBookable: boolean;
  active: boolean;
}

function initialValues(
  plan: RatePlan | undefined,
  roomType: RoomTypeDetail,
  currency: string,
): Values {
  const policy = plan?.cancellationPolicy ?? {};
  return {
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    mealPlan: plan?.mealPlan ?? 'room_only',
    parentRatePlanId: plan?.parentRatePlanId ?? '',
    baseRate: plan ? majorText(plan.baseRate, currency) : '',
    percent: String((plan?.derivedPercentBp ?? 0) / 100),
    amount: majorText(plan?.derivedAmount ?? 0, currency),
    includedOccupancy: String(plan?.includedOccupancy ?? roomType.baseOccupancy),
    extraAdultRate: majorText(plan?.extraAdultRate ?? 0, currency),
    extraChildRate: majorText(plan?.extraChildRate ?? 0, currency),
    floorRate: majorText(plan?.floorRate ?? null, currency),
    ceilingRate: majorText(plan?.ceilingRate ?? null, currency),
    minStay: String(plan?.minStay ?? 1),
    maxStay: plan?.maxStay ? String(plan.maxStay) : '',
    nonRefundable: policy.nonRefundable === true,
    freeCancelDays: policy.freeCancelDays === undefined ? '' : String(policy.freeCancelDays),
    penalty: policy.penalty ?? '',
    penaltyPercent: policy.penaltyPercent === undefined ? '' : String(policy.penaltyPercent),
    // The first plan of a room type is the one new bookings start from.
    isDefault: plan?.isDefault ?? roomType.ratePlans.length === 0,
    publicBookable: plan?.publicBookable ?? true,
    active: plan?.active ?? true,
  };
}

function policyFrom(values: Values): RatePlan['cancellationPolicy'] {
  if (values.nonRefundable) return { nonRefundable: true };
  return {
    ...(values.freeCancelDays.trim() !== ''
      ? { freeCancelDays: Number(values.freeCancelDays) }
      : {}),
    ...(values.penalty ? { penalty: values.penalty } : {}),
    ...(values.penalty === 'percent' && values.penaltyPercent.trim() !== ''
      ? { penaltyPercent: Number(values.penaltyPercent) }
      : {}),
  };
}

function bodyFrom(values: Values, currency: string) {
  const follows = values.parentRatePlanId !== '';
  return {
    name: values.name.trim(),
    description: textOrNull(values.description),
    mealPlan: values.mealPlan,
    parentRatePlanId: values.parentRatePlanId || null,
    baseRate: minorOrNull(values.baseRate, currency) ?? 0,
    derivedPercentBp: follows ? Math.round(Number(values.percent) * 100) : 0,
    derivedAmount: follows ? toMinor(Number(values.amount), currency) : 0,
    includedOccupancy: Number(values.includedOccupancy),
    extraAdultRate: minorOrNull(values.extraAdultRate, currency) ?? 0,
    extraChildRate: minorOrNull(values.extraChildRate, currency) ?? 0,
    floorRate: minorOrNull(values.floorRate, currency),
    ceilingRate: minorOrNull(values.ceilingRate, currency),
    minStay: Number(values.minStay),
    maxStay: intOrNull(values.maxStay),
    cancellationPolicy: policyFrom(values),
    isDefault: values.isDefault,
    publicBookable: values.publicBookable,
    active: values.active,
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

function NumberField({
  label,
  hint,
  value,
  onChange,
  optional,
  min,
  max,
  step = 1,
  signed = false,
  className,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  min?: number;
  max?: number;
  /** 1 for counts; "any" for amounts of money. */
  step?: number | 'any';
  /** Negative numbers are allowed. */
  signed?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} optional={optional} className={className}>
      {(props) => (
        <Input
          {...props}
          type="number"
          min={min ?? (signed ? undefined : 0)}
          max={max}
          step={step}
          // Phone keypads for numbers often lack a minus key, so signed fields get the full keyboard.
          inputMode={signed ? undefined : step === 1 ? 'numeric' : 'decimal'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={!optional}
        />
      )}
    </Field>
  );
}

/** Adds a rate plan to a room type, or edits one. */
export function RatePlanDialog({
  property,
  roomTypes,
  roomType,
  plan,
  onClose,
  onSaved,
}: {
  property: Property;
  /** Every room type of the property, to list the plans this one can follow. */
  roomTypes: RoomTypeDetail[];
  roomType: RoomTypeDetail;
  /** The plan to edit; absent when adding one. */
  plan?: RatePlan;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  // A plan keeps the currency it was created in, whatever the property uses now.
  const currency = plan?.currency ?? property.currency;
  const [initial] = useState(() => initialValues(plan, roomType, currency));
  const [values, setValues] = useState(initial);
  const change = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  const allPlans = roomTypes.flatMap((other) => other.ratePlans);
  const plansById = new Map(allPlans.map((other) => [other.id, other]));
  // Following a plan that follows this one would make a loop, and the API needs one currency.
  const excluded = plan ? followerIds(plan.id, allPlans).add(plan.id) : new Set<string>();
  const parentGroups = roomTypes
    .map((other) => ({
      roomType: other,
      plans: other.ratePlans.filter(
        (candidate) => !excluded.has(candidate.id) && candidate.currency === currency,
      ),
    }))
    .filter((group) => group.plans.length > 0);
  const parent = values.parentRatePlanId ? plansById.get(values.parentRatePlanId) : undefined;
  const body = bodyFrom(values, currency);

  const save = useAction(async () => {
    if (plan) {
      const patch = changedFields(bodyFrom(initial, currency), body);
      if (Object.keys(patch).length > 0) {
        await api(`/properties/${property.id}/rate-plans/${plan.id}`, {
          method: 'PATCH',
          body: patch,
        });
        toast.success('Rate plan saved');
        onSaved();
      }
    } else {
      const { active: _active, ...fields } = body;
      await api(`/properties/${property.id}/rate-plans`, {
        body: { roomTypeId: roomType.id, code: values.code.trim().toUpperCase(), ...fields },
      });
      toast.success(`${body.name} added`);
      onSaved();
    }
    onClose();
  });

  const parentRate = parent ? defaultNightlyRate(parent, plansById) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={plan ? `Edit ${plan.name}` : 'Add rate plan'}
      description={
        plan
          ? `Code ${plan.code}, for ${roomType.name}. Amounts are in ${currency}.`
          : `For ${roomType.name}. Amounts are in ${currency}.`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="rate-plan-form" variant="primary" loading={save.busy}>
            {plan ? 'Save' : 'Add rate plan'}
          </Button>
        </>
      }
    >
      <form
        id="rate-plan-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-5"
      >
        {save.error && <Notice tone="danger">{save.error}</Notice>}

        <Section title="Plan">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" className={plan ? 'sm:col-span-2' : undefined}>
              {(props) => (
                <Input
                  {...props}
                  value={values.name}
                  onChange={(e) => change({ name: e.target.value })}
                  maxLength={120}
                  autoComplete="off"
                  autoFocus
                  required
                />
              )}
            </Field>
            {!plan && (
              <Field
                label="Code"
                hint="Short and unique within the property, such as DLX-FLEX. It cannot be changed later."
              >
                {(props) => (
                  <CodeInput
                    {...props}
                    value={values.code}
                    onChange={(e) => change({ code: e.target.value })}
                    required
                  />
                )}
              </Field>
            )}
            <Field label="Meal plan">
              {(props) => (
                <Select
                  {...props}
                  value={values.mealPlan}
                  onChange={(e) => change({ mealPlan: e.target.value as RatePlan['mealPlan'] })}
                >
                  {(Object.keys(MEAL_PLAN_LABELS) as RatePlan['mealPlan'][]).map((mealPlan) => (
                    <option key={mealPlan} value={mealPlan}>
                      {MEAL_PLAN_LABELS[mealPlan]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Description" optional className="sm:col-span-2">
              {(props) => (
                <Textarea
                  {...props}
                  value={values.description}
                  onChange={(e) => change({ description: e.target.value })}
                  maxLength={2000}
                />
              )}
            </Field>
          </div>
        </Section>

        <Section title="Price">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Follows another rate plan"
              hint="A plan that follows another is priced from it every day, so it moves when that plan's rates change."
              className="sm:col-span-2"
            >
              {(props) => (
                <Select
                  {...props}
                  value={values.parentRatePlanId}
                  onChange={(e) =>
                    change({
                      parentRatePlanId: e.target.value,
                      // A plan that followed another has no rate of its own worth keeping.
                      ...(e.target.value === '' && Number(values.baseRate) === 0
                        ? { baseRate: '' }
                        : {}),
                    })
                  }
                >
                  <option value="">No, it has its own rate</option>
                  {parentGroups.map((group) => (
                    <optgroup key={group.roomType.id} label={group.roomType.name}>
                      {group.plans.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name} ({candidate.code}){candidate.active ? '' : ', inactive'}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              )}
            </Field>

            {parent ? (
              <>
                <NumberField
                  label="Percentage adjustment"
                  hint="-10 means 10% cheaper than the plan it follows; 15 means 15% more expensive."
                  value={values.percent}
                  onChange={(percent) => change({ percent })}
                  min={-99.99}
                  max={1000}
                  step={0.01}
                  signed
                />
                <NumberField
                  label="Amount adjustment"
                  hint="Added after the percentage. A negative amount is taken off."
                  value={values.amount}
                  onChange={(amount) => change({ amount })}
                  step="any"
                  signed
                />
                <Notice tone="info" className="sm:col-span-2">
                  The price comes from {parent.name}, so this plan has no base rate of its own. With{' '}
                  {parent.name} at {formatMoney(parentRate, currency)}, this plan charges{' '}
                  {formatMoney(
                    deriveRate(parentRate, body.derivedPercentBp, body.derivedAmount),
                    currency,
                  )}
                  {adjustmentText(body.derivedPercentBp, body.derivedAmount, currency)
                    ? ` (${adjustmentText(body.derivedPercentBp, body.derivedAmount, currency)})`
                    : ''}
                  .
                </Notice>
              </>
            ) : (
              <NumberField
                label="Base rate per night"
                hint="Before tax. Charged on days that have no rate of their own on the Rates page."
                value={values.baseRate}
                onChange={(baseRate) => change({ baseRate })}
                min={0}
                step="any"
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumberField
              label="Included occupancy"
              hint="Guests the rate covers."
              value={values.includedOccupancy}
              onChange={(includedOccupancy) => change({ includedOccupancy })}
              min={1}
              max={30}
            />
            <NumberField
              label="Extra adult rate"
              hint="Per night, for each adult above the included occupancy."
              value={values.extraAdultRate}
              onChange={(extraAdultRate) => change({ extraAdultRate })}
              min={0}
              step="any"
            />
            <NumberField
              label="Extra child rate"
              hint="Per night, for each child above the included occupancy."
              value={values.extraChildRate}
              onChange={(extraChildRate) => change({ extraChildRate })}
              min={0}
              step="any"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumberField
              label="Floor rate"
              optional
              value={values.floorRate}
              onChange={(floorRate) => change({ floorRate })}
              min={0}
              step="any"
            />
            <NumberField
              label="Ceiling rate"
              optional
              value={values.ceilingRate}
              onChange={(ceilingRate) => change({ ceilingRate })}
              min={Number(values.floorRate) || 0}
              step="any"
            />
            <p className="-mt-1 text-[13px] text-ink-faint sm:col-span-2">
              The floor and ceiling bound automatic pricing recommendations: they never suggest a
              rate below the floor or above the ceiling.
            </p>
          </div>
        </Section>

        <Section title="Length of stay">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumberField
              label="Minimum stay (nights)"
              value={values.minStay}
              onChange={(minStay) => change({ minStay })}
              min={1}
              max={365}
            />
            <NumberField
              label="Maximum stay (nights)"
              optional
              value={values.maxStay}
              onChange={(maxStay) => change({ maxStay })}
              min={Math.max(1, Number(values.minStay) || 1)}
              max={365}
            />
          </div>
        </Section>

        <Section title="Cancellation policy">
          <Checkbox
            label="Non-refundable"
            checked={values.nonRefundable}
            onChange={(e) => change({ nonRefundable: e.target.checked })}
          />
          {!values.nonRefundable && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <NumberField
                label="Free cancellation until (days before arrival)"
                optional
                hint="0 means until the day of arrival."
                value={values.freeCancelDays}
                onChange={(freeCancelDays) => change({ freeCancelDays })}
                min={0}
                max={365}
              />
              <Field label="Charge for cancelling later" optional>
                {(props) => (
                  <Select
                    {...props}
                    value={values.penalty}
                    onChange={(e) => change({ penalty: e.target.value as Penalty | '' })}
                  >
                    <option value="">Not set</option>
                    {(Object.keys(PENALTY_LABELS) as Penalty[]).map((penalty) => (
                      <option key={penalty} value={penalty}>
                        {PENALTY_LABELS[penalty]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {values.penalty === 'percent' && (
                <NumberField
                  label="Percentage of the stay charged"
                  value={values.penaltyPercent}
                  onChange={(penaltyPercent) => change({ penaltyPercent })}
                  min={0}
                  max={100}
                  step="any"
                />
              )}
            </div>
          )}
        </Section>

        <Section title="Selling">
          <div>
            <Checkbox
              label="Default plan"
              checked={values.isDefault}
              onChange={(e) => change({ isDefault: e.target.checked })}
            />
            <p className="mt-0.5 pl-6 text-[13px] text-ink-faint">
              New bookings of this room type start with the default plan, and the calendar shows its
              rate. Making this plan the default replaces the current one.
            </p>
          </div>
          <Checkbox
            label="Bookable on the website"
            checked={values.publicBookable}
            onChange={(e) => change({ publicBookable: e.target.checked })}
          />
          {plan && (
            <SwitchField
              label="Active"
              hint="An inactive plan is closed for sale on every date and left out of the calendar."
              checked={values.active}
              onChange={(active) => change({ active })}
            />
          )}
        </Section>
      </form>
    </Dialog>
  );
}
