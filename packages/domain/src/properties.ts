import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  organizations,
  properties,
  ratePlans,
  roomTypes,
  units,
  MEAL_PLANS,
  type CancellationPolicy,
  type DbOrTx,
  type MealPlan,
  type PropertyKind,
  type PropertySettings,
  type Transaction,
  type UnitAssignmentMode,
} from '@pms/db';
import { diff, writeAudit } from './audit';
import { propertyScope } from './auth/permissions';
import type { Actor } from './context';
import { addDays, todayIn, type DateRange } from './dates';
import { conflict, notFound, validationError } from './errors';
import { refreshInventory } from './inventory';
import { isValidCurrency, isValidTimezone } from './org';
import { emit } from './outbox';
import { transact } from './sqlx';

export type PropertyRow = typeof properties.$inferSelect;
export type RoomTypeRow = typeof roomTypes.$inferSelect;
export type UnitRow = typeof units.$inferSelect;
export type RatePlanRow = typeof ratePlans.$inferSelect;

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeCode(code: string, what: string): string {
  const upper = code.trim().toUpperCase();
  if (!CODE_RE.test(upper)) {
    throw validationError(`${what} code must be 1-20 letters, digits, dashes or underscores`);
  }
  return upper;
}

/** The dates a property keeps availability for: today (in its own time zone) up to its horizon. */
export function horizonRange(
  property: Pick<PropertyRow, 'timezone' | 'inventoryHorizonDays'>,
  now = new Date(),
): DateRange {
  const today = todayIn(property.timezone, now);
  return { from: today, to: addDays(today, property.inventoryHorizonDays) };
}

export async function requireProperty(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
): Promise<PropertyRow> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  return property;
}

export async function requireRoomType(
  db: DbOrTx,
  propertyId: string,
  roomTypeId: string,
): Promise<RoomTypeRow> {
  const [roomType] = await db
    .select()
    .from(roomTypes)
    .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId)));
  if (!roomType) throw notFound('Room type', roomTypeId);
  return roomType;
}

// ---------------------------------------------------------------------------
// Properties

export interface PropertyInput {
  code: string;
  name: string;
  kind: PropertyKind;
  timezone?: string;
  currency?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string;
  phone?: string | null;
  email?: string | null;
  legalName?: string | null;
  gstin?: string | null;
  checkInTime?: string;
  checkOutTime?: string;
  inventoryHorizonDays?: number;
  settings?: PropertySettings;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

function validatePropertyFields(input: Partial<PropertyInput>): void {
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw validationError(`"${input.timezone}" is not a known time zone`);
  }
  if (input.currency !== undefined && !isValidCurrency(input.currency)) {
    throw validationError(`"${input.currency}" is not a known currency code`);
  }
  for (const [label, value] of [
    ['Check-in time', input.checkInTime],
    ['Check-out time', input.checkOutTime],
  ] as const) {
    if (value !== undefined && !TIME_RE.test(value))
      throw validationError(`${label} must be HH:MM`);
  }
  if (
    input.inventoryHorizonDays !== undefined &&
    (input.inventoryHorizonDays < 30 || input.inventoryHorizonDays > 1095)
  ) {
    throw validationError('The availability horizon must be between 30 and 1095 days');
  }
  if (input.gstin) {
    if (!GSTIN_RE.test(input.gstin.toUpperCase()))
      throw validationError('GSTIN is not in a valid format');
    if (input.stateCode && input.gstin.slice(0, 2) !== input.stateCode) {
      throw validationError('The first two digits of the GSTIN must match the state code');
    }
  }
  if (input.stateCode && !/^\d{2}$/.test(input.stateCode)) {
    throw validationError('State code must be the two-digit GST state code');
  }
}

export async function createProperty(
  db: DbOrTx,
  actor: Actor,
  input: PropertyInput,
): Promise<PropertyRow> {
  const code = normalizeCode(input.code, 'Property');
  if (!input.name.trim()) throw validationError('Property name is required');
  validatePropertyFields(input);
  return transact(db, async (tx) => {
    const [clash] = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.orgId, actor.orgId), eq(properties.code, code)));
    if (clash) throw conflict(`A property with code ${code} already exists`);
    const [org] = await tx
      .select({ currency: organizations.defaultCurrency, timezone: organizations.defaultTimezone })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId));
    const [property] = await tx
      .insert(properties)
      .values({
        ...input,
        currency: input.currency ?? org?.currency,
        timezone: input.timezone ?? org?.timezone,
        gstin: input.gstin?.toUpperCase() ?? null,
        code,
        name: input.name.trim(),
        orgId: actor.orgId,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'property.created',
      entityType: 'property',
      entityId: property!.id,
      propertyId: property!.id,
      summary: `Created property ${property!.name}`,
    });
    return property!;
  });
}

export async function updateProperty(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  patch: Partial<Omit<PropertyInput, 'code' | 'kind'>> & { active?: boolean },
): Promise<PropertyRow> {
  validatePropertyFields(patch);
  return transact(db, async (tx) => {
    const before = await requireProperty(tx, actor.orgId, propertyId);
    const next = {
      ...patch,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.gstin !== undefined ? { gstin: patch.gstin?.toUpperCase() ?? null } : {}),
      ...(patch.settings !== undefined
        ? { settings: { ...before.settings, ...patch.settings } }
        : {}),
    };
    if (next.name !== undefined && !next.name) throw validationError('Property name is required');
    const changes = diff(before as unknown as Record<string, unknown>, next);
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx
      .update(properties)
      .set(next)
      .where(eq(properties.id, propertyId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'property.updated',
      entityType: 'property',
      entityId: propertyId,
      propertyId,
      summary: `Updated property ${after!.name}`,
      changes,
    });
    if (
      patch.inventoryHorizonDays !== undefined &&
      patch.inventoryHorizonDays > before.inventoryHorizonDays
    ) {
      await extendHorizon(tx, after!);
    }
    return after!;
  });
}

/** Properties the actor may see, in name order. */
/**
 * The properties a member of staff may see. A villa owner is not staff: the
 * owner portal shows them their own units, and a property's settings are not
 * for them.
 */
export async function listProperties(db: DbOrTx, actor: Actor): Promise<PropertyRow[]> {
  const scope = propertyScope(actor.grants, 'property.read');
  const all = actor.type === 'system' || scope === 'all';
  const ids = scope === 'all' ? [] : scope;
  if (!all && ids.length === 0) return [];
  return db
    .select()
    .from(properties)
    .where(and(eq(properties.orgId, actor.orgId), all ? undefined : inArray(properties.id, ids)))
    .orderBy(asc(properties.name));
}

export interface PropertyConfig {
  property: PropertyRow;
  roomTypes: Array<RoomTypeRow & { units: UnitRow[]; ratePlans: RatePlanRow[] }>;
}

export async function getPropertyConfig(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
): Promise<PropertyConfig> {
  const property = await requireProperty(db, orgId, propertyId);
  const [types, unitRows, planRows] = await Promise.all([
    db
      .select()
      .from(roomTypes)
      .where(eq(roomTypes.propertyId, propertyId))
      .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.name)),
    db
      .select()
      .from(units)
      .where(eq(units.propertyId, propertyId))
      .orderBy(asc(units.sortOrder), asc(units.name)),
    db
      .select()
      .from(ratePlans)
      .where(eq(ratePlans.propertyId, propertyId))
      .orderBy(asc(ratePlans.name)),
  ]);
  return {
    property,
    roomTypes: types.map((t) => ({
      ...t,
      units: unitRows.filter((u) => u.roomTypeId === t.id),
      ratePlans: planRows.filter((p) => p.roomTypeId === t.id),
    })),
  };
}

/** Materialises ledger rows up to the property's horizon. Run when it grows and nightly as dates roll forward. */
export async function extendHorizon(
  tx: Transaction,
  property: PropertyRow,
  now = new Date(),
): Promise<void> {
  const types = await tx
    .select({ id: roomTypes.id })
    .from(roomTypes)
    .where(eq(roomTypes.propertyId, property.id));
  if (types.length === 0) return;
  const range = horizonRange(property, now);
  await refreshInventory(
    tx,
    property.orgId,
    types.map((t) => ({ roomTypeId: t.id, range })),
  );
}

// ---------------------------------------------------------------------------
// Room types

export interface RoomTypeInput {
  code: string;
  name: string;
  description?: string | null;
  baseOccupancy?: number;
  maxAdults?: number;
  maxChildren?: number;
  maxOccupancy?: number;
  assignment?: UnitAssignmentMode;
  /** For room types sold by count: give new bookings a free room straight away when one fits. */
  autoAssign?: boolean;
  amenities?: string[];
  photos?: string[];
  sortOrder?: number;
}

function validateOccupancy(o: {
  baseOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
}): void {
  if (o.baseOccupancy < 1 || o.maxAdults < 1 || o.maxChildren < 0) {
    throw validationError('Occupancy values must be positive');
  }
  if (o.maxOccupancy < o.baseOccupancy)
    throw validationError('Maximum occupancy cannot be below base occupancy');
  if (o.maxAdults > o.maxOccupancy)
    throw validationError('Maximum adults cannot exceed maximum occupancy');
}

export async function createRoomType(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  input: RoomTypeInput,
): Promise<RoomTypeRow> {
  const code = normalizeCode(input.code, 'Room type');
  if (!input.name.trim()) throw validationError('Room type name is required');
  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, propertyId);
    const baseOccupancy = input.baseOccupancy ?? 2;
    const maxAdults = input.maxAdults ?? Math.max(baseOccupancy, 2);
    const maxChildren = input.maxChildren ?? 0;
    const maxOccupancy = input.maxOccupancy ?? Math.max(maxAdults, baseOccupancy);
    validateOccupancy({ baseOccupancy, maxAdults, maxChildren, maxOccupancy });
    const [clash] = await tx
      .select({ id: roomTypes.id })
      .from(roomTypes)
      .where(and(eq(roomTypes.propertyId, propertyId), eq(roomTypes.code, code)));
    if (clash) throw conflict(`A room type with code ${code} already exists at this property`);
    const [roomType] = await tx
      .insert(roomTypes)
      .values({
        propertyId,
        code,
        name: input.name.trim(),
        description: input.description ?? null,
        baseOccupancy,
        maxAdults,
        maxChildren,
        maxOccupancy,
        // Villas are single units: every booking is tied to a physical unit straight away.
        assignment: input.assignment ?? (property.kind === 'villa' ? 'at_booking' : 'at_check_in'),
        autoAssign: input.autoAssign ?? true,
        amenities: input.amenities ?? [],
        photos: input.photos ?? [],
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'room_type.created',
      entityType: 'room_type',
      entityId: roomType!.id,
      propertyId,
      summary: `Created room type ${roomType!.name}`,
    });
    return roomType!;
  });
}

export async function updateRoomType(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  roomTypeId: string,
  patch: Partial<Omit<RoomTypeInput, 'code'>> & { active?: boolean },
): Promise<RoomTypeRow> {
  return transact(db, async (tx) => {
    await requireProperty(tx, actor.orgId, propertyId);
    const before = await requireRoomType(tx, propertyId, roomTypeId);
    const next = { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) };
    if (next.name !== undefined && !next.name) throw validationError('Room type name is required');
    validateOccupancy({
      baseOccupancy: next.baseOccupancy ?? before.baseOccupancy,
      maxAdults: next.maxAdults ?? before.maxAdults,
      maxChildren: next.maxChildren ?? before.maxChildren,
      maxOccupancy: next.maxOccupancy ?? before.maxOccupancy,
    });
    if (next.assignment === 'at_check_in' && before.assignment === 'at_booking') {
      const [linked] = await tx
        .select({ id: units.id })
        .from(units)
        .where(
          and(
            eq(units.roomTypeId, roomTypeId),
            sql`(${units.parentUnitId} IS NOT NULL OR EXISTS (SELECT 1 FROM units c WHERE c.parent_unit_id = ${units.id}))`,
          ),
        )
        .limit(1);
      if (linked)
        throw validationError('Room types with linked units must assign a unit at booking');
    }
    const changes = diff(before as unknown as Record<string, unknown>, next);
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx
      .update(roomTypes)
      .set(next)
      .where(eq(roomTypes.id, roomTypeId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'room_type.updated',
      entityType: 'room_type',
      entityId: roomTypeId,
      propertyId,
      summary: `Updated room type ${after!.name}`,
      changes,
    });
    return after!;
  });
}

// ---------------------------------------------------------------------------
// Units

export interface UnitInput {
  roomTypeId: string;
  name: string;
  floor?: string | null;
  /** Makes this unit a part of another unit, e.g. a bedroom of a villa. */
  parentUnitId?: string | null;
  sortOrder?: number;
  notes?: string | null;
}

async function hasUpcomingOccupancy(
  tx: Transaction,
  unitIds: string[],
  from: string,
): Promise<boolean> {
  if (unitIds.length === 0) return false;
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM unit_occupancy o
    WHERE (o.unit_id IN (${sql.join(
      unitIds.map((id) => sql`${id}`),
      sql`, `,
    )})
        OR o.source_unit_id IN (${sql.join(
          unitIds.map((id) => sql`${id}`),
          sql`, `,
        )}))
      AND upper(o.stay) > ${from}::date
    LIMIT 1
  `);
  return rows.length > 0;
}

async function validateParent(
  tx: Transaction,
  propertyId: string,
  roomTypeId: string,
  parentUnitId: string,
  today: string,
) {
  const [parent] = await tx.select().from(units).where(eq(units.id, parentUnitId));
  if (!parent || parent.propertyId !== propertyId)
    throw validationError('The parent unit must belong to the same property');
  if (parent.parentUnitId)
    throw validationError('A unit that is itself part of another unit cannot have parts');
  if (parent.roomTypeId === roomTypeId) {
    throw validationError('A part must have a different room type than the unit it belongs to');
  }
  // Occupancy is recorded on the smallest units. Changing which units are the
  // smallest while stays exist would leave those records on the wrong unit.
  if (await hasUpcomingOccupancy(tx, [parentUnitId], today)) {
    throw conflict(
      'The parent unit has upcoming bookings or blocks. Move or cancel them before linking units.',
    );
  }
  // Linked inventory only works when both sides are tied to physical units at booking.
  await tx
    .update(roomTypes)
    .set({ assignment: 'at_booking' })
    .where(inArray(roomTypes.id, [roomTypeId, parent.roomTypeId]));
}

export async function createUnit(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  input: UnitInput,
): Promise<UnitRow> {
  if (!input.name.trim()) throw validationError('Unit name is required');
  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, propertyId);
    await requireRoomType(tx, propertyId, input.roomTypeId);
    const today = todayIn(property.timezone);
    const [clash] = await tx
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.propertyId, propertyId), eq(units.name, input.name.trim())));
    if (clash)
      throw conflict(`A unit named "${input.name.trim()}" already exists at this property`);
    if (input.parentUnitId)
      await validateParent(tx, propertyId, input.roomTypeId, input.parentUnitId, today);

    const [unit] = await tx
      .insert(units)
      .values({
        propertyId,
        roomTypeId: input.roomTypeId,
        name: input.name.trim(),
        floor: input.floor ?? null,
        parentUnitId: input.parentUnitId ?? null,
        sortOrder: input.sortOrder ?? 0,
        notes: input.notes ?? null,
      })
      .returning();
    // One more unit raises availability on every night of the horizon.
    await refreshInventory(tx, actor.orgId, [
      { roomTypeId: input.roomTypeId, range: horizonRange(property) },
    ]);
    await writeAudit(tx, actor, {
      action: 'unit.created',
      entityType: 'unit',
      entityId: unit!.id,
      propertyId,
      summary: `Added unit ${unit!.name}`,
    });
    return unit!;
  });
}

export async function updateUnit(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  unitId: string,
  patch: {
    name?: string;
    floor?: string | null;
    sortOrder?: number;
    notes?: string | null;
    active?: boolean;
    parentUnitId?: string | null;
  },
): Promise<UnitRow> {
  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, propertyId);
    const [before] = await tx
      .select()
      .from(units)
      .where(and(eq(units.id, unitId), eq(units.propertyId, propertyId)))
      .for('update');
    if (!before) throw notFound('Unit', unitId);
    const today = todayIn(property.timezone);
    const next = { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) };
    if (next.name !== undefined && !next.name) throw validationError('Unit name is required');
    if (next.name && next.name !== before.name) {
      const [clash] = await tx
        .select({ id: units.id })
        .from(units)
        .where(and(eq(units.propertyId, propertyId), eq(units.name, next.name)));
      if (clash) throw conflict(`A unit named "${next.name}" already exists at this property`);
    }

    const linkChanges =
      patch.parentUnitId !== undefined && patch.parentUnitId !== before.parentUnitId;
    const deactivates = patch.active === false && before.active;
    if (linkChanges || deactivates) {
      const children = await tx
        .select({ id: units.id })
        .from(units)
        .where(eq(units.parentUnitId, unitId));
      if (await hasUpcomingOccupancy(tx, [unitId, ...children.map((c) => c.id)], today)) {
        throw conflict(
          deactivates
            ? 'This unit has upcoming bookings or blocks. Move or cancel them before taking it out of service permanently.'
            : 'This unit has upcoming bookings or blocks. Move or cancel them before changing how units are linked.',
        );
      }
      if (deactivates && children.length > 0) {
        throw conflict('Unlink or deactivate the parts of this unit first');
      }
    }
    if (linkChanges && patch.parentUnitId) {
      await validateParent(tx, propertyId, before.roomTypeId, patch.parentUnitId, today);
    }

    const changes = diff(before as unknown as Record<string, unknown>, next);
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx.update(units).set(next).where(eq(units.id, unitId)).returning();

    if (linkChanges || patch.active !== undefined) {
      // Unit count or linkage changed: rebuild the horizon for this type. A
      // removal that would leave existing bookings without capacity is refused.
      const affected = new Set([before.roomTypeId]);
      for (const parentId of [before.parentUnitId, patch.parentUnitId]) {
        if (!parentId) continue;
        const [parent] = await tx
          .select({ roomTypeId: units.roomTypeId })
          .from(units)
          .where(eq(units.id, parentId));
        if (parent) affected.add(parent.roomTypeId);
      }
      await refreshInventory(
        tx,
        actor.orgId,
        [...affected].map((roomTypeId) => ({ roomTypeId, range: horizonRange(property) })),
        { allowOverbooking: false },
      );
    }
    await writeAudit(tx, actor, {
      action: 'unit.updated',
      entityType: 'unit',
      entityId: unitId,
      propertyId,
      summary: `Updated unit ${after!.name}`,
      changes,
    });
    await emit(tx, actor.orgId, [{ kind: 'unit.updated', propertyId, payload: { unitId } }]);
    return after!;
  });
}

// ---------------------------------------------------------------------------
// Rate plans

export interface RatePlanInput {
  roomTypeId: string;
  code: string;
  name: string;
  description?: string | null;
  currency?: string;
  /** Nightly rate in minor units, before tax. */
  baseRate: number;
  includedOccupancy?: number;
  extraAdultRate?: number;
  extraChildRate?: number;
  mealPlan?: MealPlan;
  cancellationPolicy?: CancellationPolicy;
  minStay?: number;
  maxStay?: number | null;
  parentRatePlanId?: string | null;
  derivedPercentBp?: number;
  derivedAmount?: number;
  floorRate?: number | null;
  ceilingRate?: number | null;
  isDefault?: boolean;
  publicBookable?: boolean;
}

function validateRatePlanFields(v: {
  baseRate: number;
  extraAdultRate: number;
  extraChildRate: number;
  minStay: number;
  maxStay: number | null;
  floorRate: number | null;
  ceilingRate: number | null;
  mealPlan: string;
  derivedPercentBp: number;
  includedOccupancy: number;
}): void {
  for (const [label, value] of [
    ['Base rate', v.baseRate],
    ['Extra adult rate', v.extraAdultRate],
    ['Extra child rate', v.extraChildRate],
  ] as const) {
    if (!Number.isInteger(value) || value < 0)
      throw validationError(`${label} must be a non-negative whole amount in minor units`);
  }
  if (!Number.isInteger(v.minStay) || v.minStay < 1)
    throw validationError('Minimum stay must be at least 1 night');
  if (v.maxStay !== null && v.maxStay < v.minStay)
    throw validationError('Maximum stay cannot be below minimum stay');
  if (v.floorRate !== null && v.ceilingRate !== null && v.floorRate > v.ceilingRate) {
    throw validationError('The floor rate cannot be above the ceiling rate');
  }
  if (!MEAL_PLANS.includes(v.mealPlan as MealPlan)) throw validationError('Unknown meal plan');
  if (v.derivedPercentBp <= -10_000)
    throw validationError('A derived rate cannot discount by 100% or more');
  if (v.includedOccupancy < 1) throw validationError('Included occupancy must be at least 1');
}

/** Rate plans whose prices follow `ratePlanId`, at any depth. */
export async function derivedRatePlanIds(db: DbOrTx, ratePlanId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM rate_plans WHERE parent_rate_plan_id = ${ratePlanId}
      UNION
      SELECT rp.id FROM rate_plans rp JOIN tree t ON rp.parent_rate_plan_id = t.id
    )
    SELECT id FROM tree
  `);
  return rows.map((r) => r.id);
}

export async function createRatePlan(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  input: RatePlanInput,
): Promise<RatePlanRow> {
  const code = normalizeCode(input.code, 'Rate plan');
  if (!input.name.trim()) throw validationError('Rate plan name is required');
  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, propertyId);
    const roomType = await requireRoomType(tx, propertyId, input.roomTypeId);
    const values = {
      baseRate: input.baseRate,
      extraAdultRate: input.extraAdultRate ?? 0,
      extraChildRate: input.extraChildRate ?? 0,
      minStay: input.minStay ?? 1,
      maxStay: input.maxStay ?? null,
      floorRate: input.floorRate ?? null,
      ceilingRate: input.ceilingRate ?? null,
      mealPlan: input.mealPlan ?? 'room_only',
      derivedPercentBp: input.derivedPercentBp ?? 0,
      derivedAmount: input.derivedAmount ?? 0,
      includedOccupancy: input.includedOccupancy ?? roomType.baseOccupancy,
    };
    validateRatePlanFields(values);
    const currency = input.currency ?? property.currency;
    if (!isValidCurrency(currency))
      throw validationError(`"${currency}" is not a known currency code`);
    if (input.parentRatePlanId) {
      const [parent] = await tx
        .select()
        .from(ratePlans)
        .where(eq(ratePlans.id, input.parentRatePlanId));
      if (!parent || parent.propertyId !== propertyId)
        throw validationError('The parent rate plan must belong to the same property');
      if (parent.currency !== currency)
        throw validationError('A derived rate plan must use its parent\u2019s currency');
    }
    const [clash] = await tx
      .select({ id: ratePlans.id })
      .from(ratePlans)
      .where(and(eq(ratePlans.propertyId, propertyId), eq(ratePlans.code, code)));
    if (clash) throw conflict(`A rate plan with code ${code} already exists at this property`);

    const existing = await tx
      .select({ id: ratePlans.id })
      .from(ratePlans)
      .where(eq(ratePlans.roomTypeId, input.roomTypeId));
    const isDefault = input.isDefault ?? existing.length === 0;
    if (isDefault) {
      await tx
        .update(ratePlans)
        .set({ isDefault: false })
        .where(eq(ratePlans.roomTypeId, input.roomTypeId));
    }
    const [plan] = await tx
      .insert(ratePlans)
      .values({
        ...values,
        propertyId,
        roomTypeId: input.roomTypeId,
        code,
        name: input.name.trim(),
        description: input.description ?? null,
        currency,
        cancellationPolicy: input.cancellationPolicy ?? {},
        parentRatePlanId: input.parentRatePlanId ?? null,
        isDefault,
        publicBookable: input.publicBookable ?? true,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'rate_plan.created',
      entityType: 'rate_plan',
      entityId: plan!.id,
      propertyId,
      summary: `Created rate plan ${plan!.name}`,
    });
    return plan!;
  });
}

const PRICE_AFFECTING: (keyof RatePlanRow)[] = [
  'baseRate',
  'minStay',
  'maxStay',
  'parentRatePlanId',
  'derivedPercentBp',
  'derivedAmount',
  'active',
];

export async function updateRatePlan(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  ratePlanId: string,
  patch: Partial<Omit<RatePlanInput, 'roomTypeId' | 'code' | 'currency'>> & { active?: boolean },
): Promise<RatePlanRow> {
  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, propertyId);
    const [before] = await tx
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.id, ratePlanId), eq(ratePlans.propertyId, propertyId)))
      .for('update');
    if (!before) throw notFound('Rate plan', ratePlanId);
    const next = { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) };
    if (next.name !== undefined && !next.name) throw validationError('Rate plan name is required');
    validateRatePlanFields({
      baseRate: next.baseRate ?? before.baseRate,
      extraAdultRate: next.extraAdultRate ?? before.extraAdultRate,
      extraChildRate: next.extraChildRate ?? before.extraChildRate,
      minStay: next.minStay ?? before.minStay,
      maxStay: next.maxStay === undefined ? before.maxStay : next.maxStay,
      floorRate: next.floorRate === undefined ? before.floorRate : next.floorRate,
      ceilingRate: next.ceilingRate === undefined ? before.ceilingRate : next.ceilingRate,
      mealPlan: next.mealPlan ?? before.mealPlan,
      derivedPercentBp: next.derivedPercentBp ?? before.derivedPercentBp,
      includedOccupancy: next.includedOccupancy ?? before.includedOccupancy,
    });
    if (next.parentRatePlanId) {
      if (next.parentRatePlanId === ratePlanId)
        throw validationError('A rate plan cannot derive from itself');
      const descendants = await derivedRatePlanIds(tx, ratePlanId);
      if (descendants.includes(next.parentRatePlanId)) {
        throw validationError('That would make the rate plans derive from each other in a loop');
      }
      const [parent] = await tx
        .select()
        .from(ratePlans)
        .where(eq(ratePlans.id, next.parentRatePlanId));
      if (!parent || parent.propertyId !== propertyId)
        throw validationError('The parent rate plan must belong to the same property');
      if (parent.currency !== before.currency)
        throw validationError('A derived rate plan must use its parent\u2019s currency');
    }
    const changes = diff(before as unknown as Record<string, unknown>, next);
    if (Object.keys(changes).length === 0) return before;
    if (next.isDefault) {
      await tx
        .update(ratePlans)
        .set({ isDefault: false })
        .where(eq(ratePlans.roomTypeId, before.roomTypeId));
    }
    const [after] = await tx
      .update(ratePlans)
      .set(next)
      .where(eq(ratePlans.id, ratePlanId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'rate_plan.updated',
      entityType: 'rate_plan',
      entityId: ratePlanId,
      propertyId,
      summary: `Updated rate plan ${after!.name}`,
      changes,
    });

    if (PRICE_AFFECTING.some((field) => field in changes)) {
      // Days without their own override follow the plan defaults, so every day
      // of the horizon may have changed, for this plan and for plans derived from it.
      const range = horizonRange(property);
      const affected = await tx
        .select({ id: ratePlans.id, roomTypeId: ratePlans.roomTypeId })
        .from(ratePlans)
        .where(inArray(ratePlans.id, [ratePlanId, ...(await derivedRatePlanIds(tx, ratePlanId))]));
      await emit(
        tx,
        actor.orgId,
        affected.map((p) => ({
          kind: 'ari.restrictions' as const,
          propertyId,
          ratePlanId: p.id,
          roomTypeId: p.roomTypeId,
          range,
        })),
      );
      await emit(tx, actor.orgId, [{ kind: 'rates.updated', propertyId, payload: { ratePlanId } }]);
    }
    return after!;
  });
}
