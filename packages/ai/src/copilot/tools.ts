import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { guests, properties, reservations, units, type Database } from '@pms/db';
import {
  addDays,
  can,
  cancelReservation,
  createBlock,
  createReservation,
  diffDays,
  displayMoney,
  forbidden,
  frontDeskBoard,
  getAvailability,
  getPropertyConfig,
  getRateCalendar,
  housekeepingBoard,
  isValidDate,
  listAlerts,
  listProperties,
  listReservations,
  notFound,
  openConversation,
  propertyScope,
  releaseBlock,
  sendMessage,
  setHousekeepingStatus,
  setRates,
  todayIn,
  updateReservation,
  validationError,
  type Actor,
  type Permission,
} from '@pms/domain';

export interface ToolContext {
  db: Database;
  /** The person asking. Every tool runs with their permissions and nobody else's. */
  actor: Actor;
  now: Date;
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidDate, 'Not a real date')
  .describe('A date as YYYY-MM-DD');
const id = z.uuid();

interface ToolBase<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** The permission the user must hold (on the property involved, where there is one). */
  permission: Permission;
}

/** Looks something up. Runs straight away. */
export interface ReadTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: 'read';
  run(context: ToolContext, input: z.infer<S>): Promise<unknown>;
}

export interface Proposal {
  /** What will happen, in one sentence, as the user is asked to confirm it. */
  summary: string;
  propertyId: string | null;
}

/**
 * Changes something. `prepare` only checks that the change makes sense and
 * says what it would do; `execute` runs when the user has confirmed.
 */
export interface WriteTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: 'write';
  prepare(context: ToolContext, input: z.infer<S>): Promise<Proposal>;
  execute(context: ToolContext, input: z.infer<S>): Promise<{ message: string }>;
}

export type CopilotTool = ReadTool | WriteTool;

const read = <S extends z.ZodType>(tool: ReadTool<S>): CopilotTool =>
  tool as unknown as CopilotTool;
const write = <S extends z.ZodType>(tool: WriteTool<S>): CopilotTool =>
  tool as unknown as CopilotTool;

/** The property, if the user may do this there. A property they cannot see is "not found", not "forbidden". */
async function propertyFor(context: ToolContext, propertyId: string, permission: Permission) {
  const [property] = await context.db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, context.actor.orgId)));
  if (!property || !can(context.actor.grants, 'property.read', property.id)) {
    throw notFound('Property', propertyId);
  }
  if (!can(context.actor.grants, permission, property.id)) throw forbidden();
  return property;
}

async function reservationByCode(context: ToolContext, code: string, permission: Permission) {
  const [row] = await context.db
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.orgId, context.actor.orgId),
        eq(reservations.code, code.trim().toUpperCase()),
      ),
    );
  if (!row || !can(context.actor.grants, 'reservations.read', row.propertyId)) {
    throw notFound('Reservation', code);
  }
  if (!can(context.actor.grants, permission, row.propertyId)) throw forbidden();
  return row;
}

const longDate = (d: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${d}T00:00:00Z`));

const nights = (from: string, to: string): string => {
  const n = diffDays(from, to);
  return `${n} night${n === 1 ? '' : 's'}`;
};

function assertWindow(from: string, to: string, maxDays: number): void {
  if (to <= from) throw validationError('The end date must be after the start date');
  if (diffDays(from, to) > maxDays) {
    throw validationError(`That is more than ${maxDays} days; ask for a shorter period`);
  }
}

export const COPILOT_TOOLS: CopilotTool[] = [
  read({
    name: 'list_properties',
    description:
      'The properties the user can see, each with its room types, units (rooms) and rate plans and their ids. Call this first to turn a name the user mentioned into an id.',
    schema: z.object({}),
    permission: 'property.read',
    kind: 'read',
    async run(context) {
      const visible = await listProperties(context.db, context.actor);
      const out = [];
      for (const property of visible.filter((p) => p.active).slice(0, 40)) {
        const config = await getPropertyConfig(context.db, context.actor.orgId, property.id);
        out.push({
          id: property.id,
          name: property.name,
          code: property.code,
          kind: property.kind,
          currency: property.currency,
          today: todayIn(property.timezone, context.now),
          roomTypes: config.roomTypes
            .filter((t) => t.active)
            .map((t) => ({
              id: t.id,
              name: t.name,
              units: t.units.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })),
              ratePlans: t.ratePlans
                .filter((p) => p.active)
                .map((p) => ({ id: p.id, name: p.name, baseRate: p.baseRate })),
            })),
        });
      }
      return { properties: out };
    },
  }),

  read({
    name: 'get_availability',
    description: 'Rooms left to sell per room type per night at a property, for up to 62 nights.',
    schema: z.object({ propertyId: id, from: date, to: date.describe('First day NOT included') }),
    permission: 'reservations.read',
    kind: 'read',
    async run(context, input) {
      await propertyFor(context, input.propertyId, 'reservations.read');
      assertWindow(input.from, input.to, 62);
      const days = await getAvailability(context.db, {
        propertyId: input.propertyId,
        range: { from: input.from, to: input.to },
      });
      const config = await getPropertyConfig(context.db, context.actor.orgId, input.propertyId);
      return {
        roomTypes: config.roomTypes
          .filter((t) => t.active)
          .map((t) => ({
            name: t.name,
            nights: days
              .filter((d) => d.roomTypeId === t.id)
              .map((d) => ({ date: d.date, available: d.available, total: d.total, sold: d.sold })),
          })),
      };
    },
  }),

  read({
    name: 'get_rates',
    description:
      'The nightly rate and restrictions (minimum stay, stop sell, closed to arrival or departure) of a rate plan for up to 62 nights. Rates are in minor units (paise).',
    schema: z.object({ propertyId: id, ratePlanId: id, from: date, to: date }),
    permission: 'rates.read',
    kind: 'read',
    async run(context, input) {
      await propertyFor(context, input.propertyId, 'rates.read');
      assertWindow(input.from, input.to, 62);
      const days = await getRateCalendar(context.db, {
        propertyId: input.propertyId,
        range: { from: input.from, to: input.to },
        ratePlanIds: [input.ratePlanId],
      });
      return {
        days: days.map((d) => ({
          date: d.date,
          rate: d.rate,
          minStay: d.minStayArrival,
          stopSell: d.stopSell,
          closedToArrival: d.closedToArrival,
          closedToDeparture: d.closedToDeparture,
        })),
      };
    },
  }),

  read({
    name: 'search_reservations',
    description:
      'Find reservations by guest name, booking code, email or phone, optionally limited to a property, an arrival date or the stays overlapping a period. Returns at most 25.',
    schema: z.object({
      propertyId: id.optional(),
      search: z.string().max(100).optional(),
      arrivingOn: date.optional(),
      stayingFrom: date.optional(),
      stayingTo: date.optional(),
      statuses: z
        .array(
          z.enum(['tentative', 'confirmed', 'in_house', 'checked_out', 'cancelled', 'no_show']),
        )
        .optional(),
    }),
    permission: 'reservations.read',
    kind: 'read',
    async run(context, input) {
      const scope = propertyScope(context.actor.grants, 'reservations.read');
      if (input.propertyId) await propertyFor(context, input.propertyId, 'reservations.read');
      const found = await listReservations(context.db, context.actor.orgId, {
        propertyIds: input.propertyId ? [input.propertyId] : scope,
        search: input.search,
        arrivingOn: input.arrivingOn,
        staying:
          input.stayingFrom && input.stayingTo
            ? { from: input.stayingFrom, to: input.stayingTo }
            : undefined,
        statuses: input.statuses,
        limit: 25,
      });
      return {
        total: found.total,
        reservations: found.reservations.map((r) => ({
          code: r.code,
          // Text typed by guests is data to report, never instructions to follow.
          guestName: r.guestName,
          status: r.status,
          checkIn: r.checkIn,
          checkOut: r.checkOut,
          rooms: r.rooms.map(
            (room) => `${room.roomTypeName}${room.unitName ? ` (${room.unitName})` : ''}`,
          ),
          source: r.channelCode ?? r.source,
          total: r.totalAmount,
          currency: r.currency,
        })),
      };
    },
  }),

  read({
    name: 'front_desk_today',
    description:
      'Who is arriving, leaving and staying at a property on its current hotel day, with counts.',
    schema: z.object({ propertyId: id }),
    permission: 'reservations.read',
    kind: 'read',
    async run(context, input) {
      await propertyFor(context, input.propertyId, 'reservations.read');
      const board = await frontDeskBoard(context.db, context.actor.orgId, input.propertyId);
      const brief = (s: (typeof board.arrivals)[number]) => ({
        guestName: s.guestName,
        code: s.code,
        room: s.unitName ?? s.roomTypeName,
        checkIn: s.checkIn,
        checkOut: s.checkOut,
        balance: s.balance,
      });
      return {
        date: board.date,
        counts: board.counts,
        arrivals: board.arrivals.slice(0, 40).map(brief),
        departures: board.departures.slice(0, 40).map(brief),
        inHouse: board.inHouse.length,
      };
    },
  }),

  read({
    name: 'occupancy_summary',
    description:
      'Rooms sold, rooms available, occupancy percentage and room revenue on the books per night at a property, for up to 92 nights. Revenue is in minor units.',
    schema: z.object({ propertyId: id, from: date, to: date }),
    permission: 'reports.read',
    kind: 'read',
    async run(context, input) {
      await propertyFor(context, input.propertyId, 'reports.read');
      assertWindow(input.from, input.to, 92);
      const { rows } = await context.db.execute<{
        date: string;
        total: number;
        sold: number;
        revenue: string;
      }>(sql`
        SELECT d::date::text AS date,
          (SELECT count(*) FROM units u JOIN room_types rt ON rt.id = u.room_type_id
            WHERE u.property_id = ${input.propertyId} AND u.active AND rt.active
              AND u.parent_unit_id IS NULL)::int AS total,
          (SELECT count(*) FROM reservation_nights n JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
            WHERE rr.property_id = ${input.propertyId} AND n.date = d::date
              AND rr.status IN ('confirmed', 'in_house', 'checked_out'))::int AS sold,
          (SELECT coalesce(sum(n.amount), 0) FROM reservation_nights n JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
            WHERE rr.property_id = ${input.propertyId} AND n.date = d::date
              AND rr.status IN ('confirmed', 'in_house', 'checked_out'))::text AS revenue
        FROM generate_series(${input.from}::date, ${input.to}::date - 1, interval '1 day') d
      `);
      return {
        nights: rows.map((r) => ({
          date: r.date,
          sold: r.sold,
          rooms: r.total,
          occupancyPercent: r.total > 0 ? Math.round((r.sold * 1000) / r.total) / 10 : 0,
          revenue: Number(r.revenue),
        })),
      };
    },
  }),

  read({
    name: 'list_alerts',
    description: 'Things that need attention now: overbookings, sync failures, failed messages.',
    schema: z.object({}),
    permission: 'property.read',
    kind: 'read',
    async run(context) {
      const open = await listAlerts(context.db, context.actor.orgId, {
        status: ['open', 'acknowledged'],
        propertyIds: propertyScope(context.actor.grants, 'property.read'),
        limit: 30,
      });
      return {
        alerts: open.map((a) => ({
          severity: a.severity,
          title: a.title,
          body: a.body,
          since: a.createdAt,
        })),
      };
    },
  }),

  read({
    name: 'housekeeping_status',
    description:
      'How many rooms are clean, not cleaned, inspected or out of service at a property.',
    schema: z.object({ propertyId: id }),
    permission: 'housekeeping.read',
    kind: 'read',
    async run(context, input) {
      await propertyFor(context, input.propertyId, 'housekeeping.read');
      const board = await housekeepingBoard(context.db, context.actor.orgId, input.propertyId);
      return {
        date: board.date,
        counts: board.counts,
        notClean: board.units
          .filter((u) => u.status === 'dirty')
          .map((u) => ({ id: u.unitId, name: u.unitName, today: u.occupancy })),
      };
    },
  }),

  write({
    name: 'block_dates',
    description:
      'Take a unit (a room or a villa) off sale for a period: maintenance, an owner stay, or any other reason. The booking sites are closed for those dates. Proposes the block; the user confirms it.',
    schema: z.object({
      propertyId: id,
      unitId: id,
      from: date,
      to: date.describe('First day back on sale'),
      kind: z.enum(['block', 'maintenance', 'owner_stay']).default('block'),
      reason: z.string().max(200).optional(),
    }),
    permission: 'blocks.write',
    kind: 'write',
    async prepare(context, input) {
      const property = await propertyFor(context, input.propertyId, 'blocks.write');
      const [unit] = await context.db
        .select()
        .from(units)
        .where(and(eq(units.id, input.unitId), eq(units.propertyId, property.id)));
      if (!unit) throw notFound('Unit', input.unitId);
      assertWindow(input.from, input.to, 730);
      const what =
        input.kind === 'maintenance'
          ? 'for maintenance'
          : input.kind === 'owner_stay'
            ? 'for an owner stay'
            : 'off sale';
      return {
        propertyId: property.id,
        summary: `Block ${unit.name} at ${property.name} ${what} from ${longDate(input.from)} to ${longDate(input.to)} (${nights(input.from, input.to)})${input.reason ? `: ${input.reason}` : ''}`,
      };
    },
    async execute(context, input) {
      await propertyFor(context, input.propertyId, 'blocks.write');
      const block = await createBlock(context.db, context.actor, {
        propertyId: input.propertyId,
        unitId: input.unitId,
        kind: input.kind,
        startDate: input.from,
        endDate: input.to,
        reason: input.reason ?? null,
      });
      return {
        message: `Blocked from ${longDate(block.startDate)} to ${longDate(block.endDate)}. The booking sites are being updated.`,
      };
    },
  }),

  write({
    name: 'release_block',
    description: 'Put a blocked unit back on sale by releasing its block. Needs the block id.',
    schema: z.object({ propertyId: id, blockId: id }),
    permission: 'blocks.write',
    kind: 'write',
    async prepare(context, input) {
      const property = await propertyFor(context, input.propertyId, 'blocks.write');
      const { rows } = await context.db.execute<{
        start_date: string;
        end_date: string;
        unit: string | null;
      }>(sql`
        SELECT b.start_date::text, b.end_date::text, u.name AS unit
        FROM inventory_blocks b LEFT JOIN units u ON u.id = b.unit_id
        WHERE b.id = ${input.blockId} AND b.property_id = ${property.id} AND b.released_at IS NULL
      `);
      if (!rows[0]) throw notFound('Block', input.blockId);
      return {
        propertyId: property.id,
        summary: `Put ${rows[0].unit ?? 'the blocked rooms'} at ${property.name} back on sale (blocked ${longDate(rows[0].start_date)} to ${longDate(rows[0].end_date)})`,
      };
    },
    async execute(context, input) {
      await propertyFor(context, input.propertyId, 'blocks.write');
      await releaseBlock(context.db, context.actor, input.blockId);
      return { message: 'The block is released and the dates are on sale again.' };
    },
  }),

  write({
    name: 'set_rates',
    description:
      'Change the nightly rate, minimum stay, or open and close sales (stop sell) of a rate plan for a period, optionally only on some weekdays (0 = Sunday). Rates are in minor units (paise): 450000 is 4,500 rupees. Proposes the change; the user confirms it.',
    schema: z.object({
      propertyId: id,
      ratePlanId: id,
      from: date,
      to: date.describe('First day NOT changed'),
      rate: z.number().int().min(0).max(100_000_000_00).optional(),
      minStay: z.number().int().min(1).max(60).optional(),
      stopSell: z.boolean().optional(),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    }),
    permission: 'rates.write',
    kind: 'write',
    async prepare(context, input) {
      const property = await propertyFor(context, input.propertyId, 'rates.write');
      const config = await getPropertyConfig(context.db, context.actor.orgId, property.id);
      const plan = config.roomTypes
        .flatMap((t) => t.ratePlans.map((p) => ({ plan: p, type: t })))
        .find((p) => p.plan.id === input.ratePlanId);
      if (!plan) throw notFound('Rate plan', input.ratePlanId);
      assertWindow(input.from, input.to, 730);
      const changes = [
        input.rate !== undefined ? `rate ${displayMoney(input.rate, property.currency)}` : null,
        input.minStay !== undefined ? `minimum stay ${input.minStay} nights` : null,
        input.stopSell !== undefined
          ? input.stopSell
            ? 'closed for sale'
            : 'open for sale'
          : null,
      ].filter(Boolean);
      if (changes.length === 0)
        throw validationError(
          'Say what to change: the rate, the minimum stay, or open or close sales',
        );
      if (input.rate !== undefined && plan.plan.parentRatePlanId) {
        throw validationError(
          `${plan.plan.name} follows another rate plan; change that plan's rate instead`,
        );
      }
      const weekdays = input.daysOfWeek?.length
        ? ` on ${input.daysOfWeek.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}`
        : '';
      return {
        propertyId: property.id,
        summary: `Set ${plan.type.name} / ${plan.plan.name} at ${property.name} to ${changes.join(', ')} from ${longDate(input.from)} to ${longDate(addDays(input.to, -1))}${weekdays}`,
      };
    },
    async execute(context, input) {
      await propertyFor(context, input.propertyId, 'rates.write');
      const result = await setRates(context.db, context.actor, {
        propertyId: input.propertyId,
        ratePlanId: input.ratePlanId,
        range: { from: input.from, to: input.to },
        daysOfWeek: input.daysOfWeek,
        change: {
          ...(input.rate !== undefined ? { rate: input.rate } : {}),
          ...(input.minStay !== undefined ? { minStayArrival: input.minStay } : {}),
          ...(input.stopSell !== undefined ? { stopSell: input.stopSell } : {}),
        },
      });
      return {
        message: `Changed ${result.daysChanged} day${result.daysChanged === 1 ? '' : 's'}. The booking sites are being updated.`,
      };
    },
  }),

  write({
    name: 'create_reservation',
    description:
      'Make a reservation for a guest at the rate on file. Proposes it with the price; the user confirms it.',
    schema: z.object({
      propertyId: id,
      roomTypeId: id,
      ratePlanId: id,
      checkIn: date,
      checkOut: date,
      adults: z.number().int().min(1).max(20).default(2),
      children: z.number().int().min(0).max(20).default(0),
      guestFirstName: z.string().min(1).max(120),
      guestLastName: z.string().max(120).default(''),
      guestEmail: z.email().optional(),
      guestPhone: z.string().max(40).optional(),
      notes: z.string().max(1000).optional(),
    }),
    permission: 'reservations.write',
    kind: 'write',
    async prepare(context, input) {
      const property = await propertyFor(context, input.propertyId, 'reservations.write');
      const config = await getPropertyConfig(context.db, context.actor.orgId, property.id);
      const type = config.roomTypes.find((t) => t.id === input.roomTypeId);
      const plan = type?.ratePlans.find((p) => p.id === input.ratePlanId);
      if (!type || !plan) throw notFound('Room type or rate plan');
      assertWindow(input.checkIn, input.checkOut, 365);
      const available = await getAvailability(context.db, {
        propertyId: property.id,
        range: { from: input.checkIn, to: input.checkOut },
        roomTypeIds: [type.id],
      });
      if (available.some((d) => d.available < 1)) {
        throw validationError(`No ${type.name} is free on every night of that stay`);
      }
      return {
        propertyId: property.id,
        summary: `Book a ${type.name} (${plan.name}) at ${property.name} for ${`${input.guestFirstName} ${input.guestLastName}`.trim()}, ${longDate(input.checkIn)} to ${longDate(input.checkOut)} (${nights(input.checkIn, input.checkOut)}), ${input.adults} adult${input.adults === 1 ? '' : 's'}${input.children ? ` and ${input.children} child${input.children === 1 ? '' : 'ren'}` : ''}`,
      };
    },
    async execute(context, input) {
      await propertyFor(context, input.propertyId, 'reservations.write');
      const reservation = await createReservation(context.db, context.actor, {
        propertyId: input.propertyId,
        source: 'direct',
        guest: {
          firstName: input.guestFirstName,
          lastName: input.guestLastName,
          email: input.guestEmail ?? null,
          phone: input.guestPhone ?? null,
        },
        rooms: [
          {
            roomTypeId: input.roomTypeId,
            ratePlanId: input.ratePlanId,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            adults: input.adults,
            children: input.children,
          },
        ],
        notes: input.notes ?? null,
      });
      return {
        message: `Reservation ${reservation.code} is confirmed: ${displayMoney(reservation.totalAmount, reservation.currency)} before tax.`,
      };
    },
  }),

  write({
    name: 'cancel_reservation',
    description: 'Cancel a reservation by its booking code. Proposes it; the user confirms it.',
    schema: z.object({ code: z.string().min(4).max(20), reason: z.string().max(300).optional() }),
    permission: 'reservations.write',
    kind: 'write',
    async prepare(context, input) {
      const reservation = await reservationByCode(context, input.code, 'reservations.write');
      if (!['tentative', 'confirmed'].includes(reservation.status)) {
        throw validationError(
          `Reservation ${reservation.code} is ${reservation.status.replace('_', ' ')} and cannot be cancelled`,
        );
      }
      return {
        propertyId: reservation.propertyId,
        summary: `Cancel reservation ${reservation.code} for ${reservation.guestName}, ${longDate(reservation.checkIn)} to ${longDate(reservation.checkOut)}${reservation.channelCode ? `. It came from a booking site (${reservation.channelCode}): cancelling here does not cancel it there` : ''}`,
      };
    },
    async execute(context, input) {
      const reservation = await reservationByCode(context, input.code, 'reservations.write');
      await cancelReservation(context.db, context.actor, reservation.id, {
        reason: input.reason ?? 'Cancelled through the assistant',
      });
      return {
        message: `Reservation ${reservation.code} is cancelled and its rooms are on sale again.`,
      };
    },
  }),

  write({
    name: 'add_reservation_note',
    description: 'Add a note for staff to a reservation, by its booking code.',
    schema: z.object({ code: z.string().min(4).max(20), note: z.string().min(1).max(1000) }),
    permission: 'reservations.write',
    kind: 'write',
    async prepare(context, input) {
      const reservation = await reservationByCode(context, input.code, 'reservations.write');
      return {
        propertyId: reservation.propertyId,
        summary: `Add a note to reservation ${reservation.code} (${reservation.guestName}): "${input.note}"`,
      };
    },
    async execute(context, input) {
      const reservation = await reservationByCode(context, input.code, 'reservations.write');
      const notes = [reservation.notes, input.note].filter(Boolean).join('\n');
      await updateReservation(context.db, context.actor, reservation.id, { notes });
      return { message: `Note added to ${reservation.code}.` };
    },
  }),

  write({
    name: 'mark_rooms',
    description: 'Mark rooms clean, not cleaned (dirty) or inspected at a property.',
    schema: z.object({
      propertyId: id,
      unitIds: z.array(id).min(1).max(100),
      status: z.enum(['clean', 'dirty', 'inspected']),
    }),
    permission: 'housekeeping.write',
    kind: 'write',
    async prepare(context, input) {
      const property = await propertyFor(context, input.propertyId, 'housekeeping.write');
      const rows = await context.db.select().from(units).where(eq(units.propertyId, property.id));
      const names = input.unitIds.map((unitId) => {
        const unit = rows.find((u) => u.id === unitId);
        if (!unit) throw notFound('Unit', unitId);
        return unit.name;
      });
      const label = input.status === 'dirty' ? 'not cleaned' : input.status;
      return {
        propertyId: property.id,
        summary: `Mark ${names.length === 1 ? 'room' : 'rooms'} ${names.join(', ')} at ${property.name} as ${label}`,
      };
    },
    async execute(context, input) {
      await propertyFor(context, input.propertyId, 'housekeeping.write');
      const changed = await setHousekeepingStatus(
        context.db,
        context.actor,
        input.unitIds,
        input.status,
      );
      return { message: `Updated ${changed} room${changed === 1 ? '' : 's'}.` };
    },
  }),

  write({
    name: 'message_guest',
    description:
      'Write to the guest of a reservation (by email, WhatsApp or the booking site, whichever reaches them). Proposes the message; the user confirms it before anything is sent.',
    schema: z.object({
      code: z.string().min(4).max(20),
      channel: z.enum(['email', 'whatsapp', 'ota']),
      body: z.string().min(1).max(4000),
    }),
    permission: 'inbox.write',
    kind: 'write',
    async prepare(context, input) {
      const reservation = await reservationByCode(context, input.code, 'inbox.write');
      // Said here, before the user is asked to confirm, when the guest cannot be reached that way.
      const [guest] = reservation.guestId
        ? await context.db
            .select({ email: guests.email, phone: guests.phone })
            .from(guests)
            .where(eq(guests.id, reservation.guestId))
        : [];
      if (input.channel === 'email' && !guest?.email) {
        throw validationError('There is no email address for this guest');
      }
      if (input.channel === 'whatsapp' && !guest?.phone) {
        throw validationError('There is no phone number for this guest');
      }
      if (input.channel === 'ota' && (!reservation.connectionId || !reservation.externalId)) {
        throw validationError('This booking did not come from a booking site');
      }
      return {
        propertyId: reservation.propertyId,
        summary: `Send ${reservation.guestName} (${reservation.code}) this message by ${input.channel === 'ota' ? 'the booking site' : input.channel}: "${input.body}"`,
      };
    },
    async execute(context, input) {
      const reservation = await reservationByCode(context, input.code, 'inbox.write');
      const conversation = await openConversation(context.db, context.actor.orgId, {
        channel: input.channel,
        reservationId: reservation.id,
      });
      await sendMessage(context.db, context.actor, conversation.id, {
        body: input.body,
        aiDrafted: true,
      });
      return { message: `The message to ${reservation.guestName} is on its way.` };
    },
  }),
];

/** The tools a user may be offered: those whose permission they hold on at least one property. */
export function toolsFor(actor: Actor): CopilotTool[] {
  return COPILOT_TOOLS.filter((tool) => can(actor.grants, tool.permission));
}

export function findTool(name: string): CopilotTool | undefined {
  return COPILOT_TOOLS.find((tool) => tool.name === name);
}
