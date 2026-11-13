'use client';

import { BedDouble, Link2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatMoney, plural } from '@/lib/format';
import type { PropertyDetail, RatePlan, Unit } from '@/lib/types';
import { ASSIGNMENT_SUMMARIES, MEAL_PLAN_LABELS } from './labels';
import { RatePlanDialog } from './rate-plan-dialog';
import { adjustmentText, cancellationSummary, defaultNightlyRate } from './rate-plans';
import { RoomTypeDialog } from './room-type-dialog';
import { UnitDialog } from './unit-dialog';

type RoomTypeDetail = PropertyDetail['roomTypes'][number];

type Editing =
  | { kind: 'room-type'; roomType?: RoomTypeDetail }
  | { kind: 'unit'; roomType: RoomTypeDetail; unit?: Unit }
  | { kind: 'rate-plan'; roomType: RoomTypeDetail; plan?: RatePlan };

const SUBHEADING = 'text-xs font-semibold tracking-wide text-ink-faint uppercase';

function occupancySummary(roomType: RoomTypeDetail): string {
  const limits = [
    plural(roomType.maxAdults, 'adult'),
    roomType.maxChildren > 0 ? plural(roomType.maxChildren, 'child', 'children') : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `For ${plural(roomType.baseOccupancy, 'guest')}, up to ${roomType.maxOccupancy} (at most ${limits})`;
}

function UnitChip({
  unit,
  parentName,
  onEdit,
}: {
  unit: Unit;
  parentName: string | undefined;
  onEdit: (() => void) | undefined;
}) {
  const content = (
    <>
      <span className="font-medium text-ink">{unit.name}</span>
      {unit.floor && (
        <span className="text-ink-faint">
          {/^\d+$/.test(unit.floor) ? `Floor ${unit.floor}` : unit.floor}
        </span>
      )}
      {parentName && (
        <span className="inline-flex items-center gap-1 text-ink-faint">
          <Link2 className="size-3" aria-hidden />
          part of {parentName}
        </span>
      )}
      {!unit.active && <Badge tone="warning">Inactive</Badge>}
    </>
  );
  const shape =
    'inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-surface px-2.5 py-1 text-left text-[13px]';
  return onEdit ? (
    <button
      type="button"
      onClick={onEdit}
      className={cn(shape, 'transition-colors hover:border-line-strong hover:bg-sunken')}
    >
      <span className="sr-only">Edit unit </span>
      {content}
    </button>
  ) : (
    <span className={shape}>{content}</span>
  );
}

function RatePlanRow({
  plan,
  plansById,
  roomTypeNames,
  onEdit,
}: {
  plan: RatePlan;
  plansById: ReadonlyMap<string, RatePlan>;
  roomTypeNames: ReadonlyMap<string, string>;
  onEdit: (() => void) | undefined;
}) {
  const parent = plan.parentRatePlanId ? plansById.get(plan.parentRatePlanId) : undefined;
  const adjustment = adjustmentText(plan.derivedPercentBp, plan.derivedAmount, plan.currency);
  const details = [
    parent &&
      [
        'Follows',
        parent.name,
        // Plan names repeat across room types, so say whose plan it is when it is another's.
        parent.roomTypeId !== plan.roomTypeId && `of ${roomTypeNames.get(parent.roomTypeId)}`,
        adjustment,
      ]
        .filter(Boolean)
        .join(' '),
    MEAL_PLAN_LABELS[plan.mealPlan],
    cancellationSummary(plan.cancellationPolicy),
    plan.minStay > 1 && `Minimum ${plural(plan.minStay, 'night')}`,
  ].filter(Boolean);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-ink">{plan.name}</span>
          <span className="font-mono text-xs text-ink-faint">{plan.code}</span>
          {plan.isDefault && <Badge tone="brand">Default</Badge>}
          {!plan.active && <Badge tone="warning">Inactive</Badge>}
          {!plan.publicBookable && <Badge>Not on the website</Badge>}
        </div>
        <p className="mt-0.5 text-[13px] text-ink-soft">{details.join(' · ')}</p>
      </div>
      <p className="text-sm whitespace-nowrap text-ink-soft">
        <span className="tabular font-medium text-ink">
          {formatMoney(defaultNightlyRate(plan, plansById), plan.currency)}
        </span>{' '}
        per night
      </p>
      {onEdit && (
        <Button
          size="sm"
          variant="ghost"
          icon={<Pencil className="size-3.5" />}
          aria-label={`Edit rate plan ${plan.name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      )}
    </li>
  );
}

function RoomTypeCard({
  roomType,
  unitNames,
  plansById,
  roomTypeNames,
  canManage,
  canRates,
  onEdit,
}: {
  roomType: RoomTypeDetail;
  unitNames: ReadonlyMap<string, string>;
  plansById: ReadonlyMap<string, RatePlan>;
  roomTypeNames: ReadonlyMap<string, string>;
  canManage: boolean;
  canRates: boolean;
  onEdit: (editing: Editing) => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-semibold text-ink">{roomType.name}</h3>
            <span className="font-mono text-xs text-ink-faint">{roomType.code}</span>
            {!roomType.active && <Badge tone="warning">Inactive</Badge>}
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">{occupancySummary(roomType)}</p>
          <p className="text-[13px] text-ink-soft">
            {ASSIGNMENT_SUMMARIES[roomType.assignment]}
            {roomType.assignment === 'at_check_in' &&
              roomType.autoAssign &&
              ' A new booking gets a free room automatically when one fits.'}
          </p>
          {roomType.description && (
            <p className="mt-1 text-[13px] whitespace-pre-line text-ink-faint">
              {roomType.description}
            </p>
          )}
        </div>
        {canManage && (
          <Button
            size="sm"
            icon={<Pencil className="size-3.5" />}
            aria-label={`Edit room type ${roomType.name}`}
            onClick={() => onEdit({ kind: 'room-type', roomType })}
          >
            Edit
          </Button>
        )}
      </div>

      <div className="border-t border-line px-4 py-3 sm:px-5">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h4 className={SUBHEADING}>Units ({roomType.units.length})</h4>
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              aria-label={`Add unit to ${roomType.name}`}
              onClick={() => onEdit({ kind: 'unit', roomType })}
            >
              Add unit
            </Button>
          )}
        </div>
        {roomType.units.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft">
            No units yet. Nothing of this room type can be sold until it has at least one.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {roomType.units.map((unit) => (
              <li key={unit.id} className="max-w-full">
                <UnitChip
                  unit={unit}
                  parentName={unit.parentUnitId ? unitNames.get(unit.parentUnitId) : undefined}
                  onEdit={canManage ? () => onEdit({ kind: 'unit', roomType, unit }) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line px-4 py-3 sm:px-5">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h4 className={SUBHEADING}>Rate plans ({roomType.ratePlans.length})</h4>
          {canRates && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              aria-label={`Add rate plan to ${roomType.name}`}
              onClick={() => onEdit({ kind: 'rate-plan', roomType })}
            >
              Add rate plan
            </Button>
          )}
        </div>
        {roomType.ratePlans.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft">
            No rate plans yet. A room type needs one to have a price.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {roomType.ratePlans.map((plan) => (
              <RatePlanRow
                key={plan.id}
                plan={plan}
                plansById={plansById}
                roomTypeNames={roomTypeNames}
                onEdit={canRates ? () => onEdit({ kind: 'rate-plan', roomType, plan }) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** A property's room types, each with its units and rate plans, and the dialogs that change them. */
export function RoomTypes({
  detail,
  canManage,
  canRates,
  onChanged,
}: {
  detail: PropertyDetail;
  /** May change room types and units. */
  canManage: boolean;
  /** May change rate plans. */
  canRates: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const { property, roomTypes } = detail;
  const units = roomTypes.flatMap((roomType) => roomType.units);
  const unitNames = new Map(units.map((unit) => [unit.id, unit.name]));
  const plansById = new Map(
    roomTypes.flatMap((roomType) => roomType.ratePlans).map((plan) => [plan.id, plan]),
  );
  const roomTypeNames = new Map(roomTypes.map((roomType) => [roomType.id, roomType.name]));
  const close = () => setEditing(null);

  const hasLinkedUnits = (roomType: RoomTypeDetail) =>
    roomType.units.some(
      (unit) => unit.parentUnitId !== null || units.some((other) => other.parentUnitId === unit.id),
    );

  const addRoomType = canManage && (
    <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'room-type' })}>
      Add room type
    </Button>
  );

  return (
    <section aria-labelledby="room-types-heading" className="mt-8">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h2 id="room-types-heading" className="text-base font-semibold text-ink">
            Room types
          </h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            What this property sells, the units of each kind and the rate plans they are sold on.
          </p>
        </div>
        {roomTypes.length > 0 && addRoomType}
      </div>

      {roomTypes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BedDouble className="size-5" />}
            title="No room types yet"
            description={
              canManage
                ? 'Add a room type, such as Deluxe room or Entire villa. Then add its units and a rate plan.'
                : 'Nothing has been set up for this property yet.'
            }
            action={addRoomType}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {roomTypes.map((roomType) => (
            <RoomTypeCard
              key={roomType.id}
              roomType={roomType}
              unitNames={unitNames}
              plansById={plansById}
              roomTypeNames={roomTypeNames}
              canManage={canManage}
              canRates={canRates}
              onEdit={setEditing}
            />
          ))}
        </div>
      )}

      {editing?.kind === 'room-type' && (
        <RoomTypeDialog
          property={property}
          roomType={editing.roomType}
          hasLinkedUnits={editing.roomType ? hasLinkedUnits(editing.roomType) : false}
          nextSortOrder={Math.max(-1, ...roomTypes.map((roomType) => roomType.sortOrder)) + 1}
          onClose={close}
          onSaved={onChanged}
        />
      )}
      {editing?.kind === 'unit' && (
        <UnitDialog
          propertyId={property.id}
          roomTypes={roomTypes}
          roomType={editing.roomType}
          unit={editing.unit}
          onClose={close}
          onSaved={onChanged}
        />
      )}
      {editing?.kind === 'rate-plan' && (
        <RatePlanDialog
          property={property}
          roomTypes={roomTypes}
          roomType={editing.roomType}
          plan={editing.plan}
          onClose={close}
          onSaved={onChanged}
        />
      )}
    </section>
  );
}
