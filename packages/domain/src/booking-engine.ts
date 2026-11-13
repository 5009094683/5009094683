import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  folios,
  guests,
  organizations,
  paymentOrders,
  payments,
  properties,
  ratePlans,
  reservationNights,
  reservationRooms,
  reservations,
  roomTypes,
  type CancellationPolicy,
  type Database,
  type DbOrTx,
  type MealPlan,
  type PaymentOrderPurpose,
  type Transaction,
} from '@pms/db';
import { raiseAlert } from './alerts';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { randomCode } from './crypto';
import { addDays, assertRange, diffDays, todayIn, type DateString } from './dates';
import {
  conflict,
  DomainError,
  invalidState,
  isDomainError,
  notFound,
  validationError,
} from './errors';
import { ensureGuestFolio, postCharge, recordPayment, refundPayment } from './folios';
import { guestBookingUrl, guestToken, readGuestToken } from './guest-links';
import { getAvailability } from './inventory';
import { formatMoney } from './money';
import type { PaymentGateway } from './payments/gateway';
import { applyPromo, findPromo, promoLabel, promoProblem, type PromoRow } from './promos';
import { quoteStay } from './rates';
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  loadReservation,
  reinstateReservation,
  type ReservationDetail,
  type ReservationRow,
} from './reservations';
import { transact } from './sqlx';
import { computeTax, taxRuleFor } from './taxes';

type PropertyRow = typeof properties.$inferSelect;
type RoomTypeRow = typeof roomTypes.$inferSelect;
type RatePlanRow = typeof ratePlans.$inferSelect;
export type PaymentOrderRow = typeof paymentOrders.$inferSelect;

/** Longest stay and most rooms the booking site takes in one booking; larger ones go through staff. */
const MAX_WEBSITE_NIGHTS = 30;
const MAX_WEBSITE_ROOMS = 8;
/** Unfinished bookings one email address may hold at a time, so one visitor cannot lock up the inventory. */
const MAX_OPEN_HOLDS_PER_GUEST = 3;
const DEFAULT_HOLD_MINUTES = 15;
const DEFAULT_DEPOSIT_PERCENT = 30;
/** How long after its expiry an order is still asked about before it is closed. */
const ORDER_GRACE_MS = 2 * 60_000;

function guestActor(orgId: string, label: string): Actor {
  return { type: 'guest', orgId, label: `guest:${label}`, grants: [] };
}

const gatewayActor = (orgId: string, gateway: string): Actor => ({
  type: 'system',
  orgId,
  label: `system:payments:${gateway}`,
  grants: [],
});

// ---------------------------------------------------------------------------
// What the booking site shows

export interface PublicProperty {
  code: string;
  name: string;
  kind: string;
  city: string | null;
  state: string | null;
  country: string;
  currency: string;
  timezone: string;
  checkInTime: string;
  checkOutTime: string;
  description: string | null;
  photos: string[];
  amenities: string[];
  brandColor: string | null;
}

export interface PublicRoomType {
  id: string;
  name: string;
  description: string | null;
  baseOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  amenities: string[];
  photos: string[];
}

export interface PublicPropertyDetail extends PublicProperty {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  terms: string | null;
  childMaxAge: number | null;
  /** What is paid when booking. */
  payment: { mode: 'full' | 'deposit' | 'none'; depositPercent: number };
  roomTypes: PublicRoomType[];
  /** Furthest date that can be booked. */
  bookableUntil: DateString;
}

function publicProperty(p: PropertyRow): PublicProperty {
  return {
    code: p.code,
    name: p.name,
    kind: p.kind,
    city: p.city,
    state: p.state,
    country: p.country,
    currency: p.currency,
    timezone: p.timezone,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    description: p.settings.description ?? null,
    photos: p.settings.photos ?? [],
    amenities: p.settings.amenities ?? [],
    brandColor: p.settings.brandColor ?? null,
  };
}

function publicRoomType(t: RoomTypeRow): PublicRoomType {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    baseOccupancy: t.baseOccupancy,
    maxAdults: t.maxAdults,
    maxChildren: t.maxChildren,
    maxOccupancy: t.maxOccupancy,
    amenities: t.amenities,
    photos: t.photos,
  };
}

function paymentTerms(p: PropertyRow): {
  mode: 'full' | 'deposit' | 'none';
  depositPercent: number;
} {
  const percent = p.settings.depositPercent ?? DEFAULT_DEPOSIT_PERCENT;
  return {
    mode: p.settings.bookingPayment ?? 'full',
    depositPercent: Math.min(100, Math.max(1, percent)),
  };
}

/**
 * The organisation a booking site sells for. A site set up for one chain
 * names it by slug; without one, the only organisation there is.
 */
export async function publicOrganization(
  db: DbOrTx,
  slug?: string | null,
): Promise<{ id: string; name: string; slug: string }> {
  if (slug) {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    if (!org) throw notFound('Organisation');
    return { id: org.id, name: org.name, slug: org.slug };
  }
  const all = await db.select().from(organizations).limit(2);
  if (all.length !== 1) throw notFound('Organisation');
  return { id: all[0]!.id, name: all[0]!.name, slug: all[0]!.slug };
}

/** Properties that take bookings on the website. */
export async function listPublicProperties(db: DbOrTx, orgId: string): Promise<PublicProperty[]> {
  const rows = await db
    .select()
    .from(properties)
    .where(and(eq(properties.orgId, orgId), eq(properties.active, true)))
    .orderBy(asc(properties.name));
  return rows.filter((p) => p.settings.bookingEngineEnabled).map(publicProperty);
}

async function bookableProperty(db: DbOrTx, orgId: string, code: string): Promise<PropertyRow> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.orgId, orgId), eq(properties.code, code.trim().toUpperCase())));
  if (!property || !property.active || !property.settings.bookingEngineEnabled) {
    throw notFound('Property');
  }
  return property;
}

/** Room types that have at least one rate sold on the website, with those rates. */
async function sellable(
  db: DbOrTx,
  propertyId: string,
): Promise<{ roomType: RoomTypeRow; plans: RatePlanRow[] }[]> {
  const types = await db
    .select()
    .from(roomTypes)
    .where(and(eq(roomTypes.propertyId, propertyId), eq(roomTypes.active, true)))
    .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.name));
  const plans = await db
    .select()
    .from(ratePlans)
    .where(
      and(
        eq(ratePlans.propertyId, propertyId),
        eq(ratePlans.active, true),
        eq(ratePlans.publicBookable, true),
      ),
    )
    .orderBy(desc(ratePlans.isDefault), asc(ratePlans.name));
  return types
    .map((roomType) => ({ roomType, plans: plans.filter((p) => p.roomTypeId === roomType.id) }))
    .filter((t) => t.plans.length > 0);
}

export async function getPublicProperty(
  db: DbOrTx,
  orgId: string,
  code: string,
): Promise<PublicPropertyDetail> {
  const property = await bookableProperty(db, orgId, code);
  const types = await sellable(db, property.id);
  return {
    ...publicProperty(property),
    addressLine1: property.addressLine1,
    addressLine2: property.addressLine2,
    postalCode: property.postalCode,
    phone: property.phone,
    email: property.email,
    terms: property.settings.bookingTerms ?? null,
    childMaxAge: property.settings.childMaxAge ?? null,
    payment: paymentTerms(property),
    roomTypes: types.map((t) => publicRoomType(t.roomType)),
    bookableUntil: addDays(todayIn(property.timezone), property.inventoryHorizonDays - 1),
  };
}

// ---------------------------------------------------------------------------
// Cancellation terms

export interface CancellationTerms {
  nonRefundable: boolean;
  /** Last day on which cancelling costs nothing. Null when it never does. */
  freeUntil: DateString | null;
  /** What cancelling after that costs. */
  penalty: 'first_night' | 'percent' | 'full';
  penaltyPercent: number | null;
  /** The terms in a sentence, for the guest. */
  text: string;
}

function longDate(date: DateString): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

export function cancellationTerms(
  policy: CancellationPolicy | null | undefined,
  checkIn: DateString,
): CancellationTerms {
  if (policy?.nonRefundable) {
    return {
      nonRefundable: true,
      freeUntil: null,
      penalty: 'full',
      penaltyPercent: null,
      text: 'Non-refundable. The full price of the stay is charged if you cancel or do not arrive.',
    };
  }
  const freeUntil = addDays(checkIn, -(policy?.freeCancelDays ?? 0));
  const penalty = policy?.penalty ?? 'first_night';
  const percent = penalty === 'percent' ? (policy?.penaltyPercent ?? 100) : null;
  const cost =
    penalty === 'full'
      ? 'the full price of the stay'
      : penalty === 'percent'
        ? `${percent}% of the price of the stay`
        : 'the first night';
  return {
    nonRefundable: false,
    freeUntil,
    penalty,
    penaltyPercent: percent,
    text: `Free cancellation until ${longDate(freeUntil)}. After that, ${cost} is charged.`,
  };
}

/** What cancelling on `today` costs for one room, before tax. */
export function cancellationCharge(
  policy: CancellationPolicy | null | undefined,
  checkIn: DateString,
  nightly: number[],
  today: DateString,
): number {
  const terms = cancellationTerms(policy, checkIn);
  const stay = nightly.reduce((sum, n) => sum + n, 0);
  if (terms.nonRefundable) return stay;
  if (terms.freeUntil && today <= terms.freeUntil) return 0;
  if (terms.penalty === 'full') return stay;
  if (terms.penalty === 'percent') return Math.round((stay * (terms.penaltyPercent ?? 100)) / 100);
  return nightly[0] ?? 0;
}

// ---------------------------------------------------------------------------
// Searching and pricing

export interface PlanOffer {
  ratePlanId: string;
  name: string;
  description: string | null;
  mealPlan: MealPlan;
  cancellation: CancellationTerms;
  /** Price of each night for one room, before tax, after any promotional code. */
  nightly: { date: DateString; amount: number }[];
  /** For one room: before tax and before the code, what the code took off, tax, and what the guest pays. */
  subtotal: number;
  discount: number;
  taxes: number;
  total: number;
  /** Of `total`, what is paid when booking. */
  payNow: number;
  /** False when a rule for these dates rules the stay out (minimum stay, closed to arrival). */
  bookable: boolean;
  reason: string | null;
}

export interface StayOffer {
  roomType: PublicRoomType;
  /** Rooms of this kind free on every night of the stay. */
  available: number;
  plans: PlanOffer[];
}

export interface StaySearch {
  property: PublicProperty;
  checkIn: DateString;
  checkOut: DateString;
  nights: number;
  adults: number;
  children: number;
  offers: StayOffer[];
  promo: { code: string; label: string; applied: boolean; reason: string | null } | null;
}

export interface StayQuery {
  propertyCode: string;
  checkIn: DateString;
  checkOut: DateString;
  /** Guests in each room. */
  adults: number;
  children?: number;
  promoCode?: string | null;
}

function validateWindow(property: PropertyRow, checkIn: string, checkOut: string): number {
  const range = assertRange(checkIn, checkOut, 'stay');
  const nights = diffDays(range.from, range.to);
  const today = todayIn(property.timezone);
  if (range.from < today) throw validationError('The arrival date is in the past');
  if (nights > MAX_WEBSITE_NIGHTS) {
    throw validationError(
      `Stays of more than ${MAX_WEBSITE_NIGHTS} nights are arranged with the property directly`,
    );
  }
  if (range.to > addDays(today, property.inventoryHorizonDays)) {
    throw validationError('These dates are not open for booking yet');
  }
  return nights;
}

function payNowOf(property: PropertyRow, plan: RatePlanRow, total: number): number {
  const terms = paymentTerms(property);
  if (plan.cancellationPolicy?.nonRefundable) return total;
  if (terms.mode === 'none') return 0;
  if (terms.mode === 'deposit') return Math.round((total * terms.depositPercent) / 100);
  return total;
}

interface PricedPlan {
  plan: RatePlanRow;
  original: number[];
  nightly: { date: DateString; amount: number }[];
  subtotal: number;
  discount: number;
  taxes: number;
  total: number;
  violation: string | null;
  promoProblem: string | null;
}

async function pricePlan(
  db: DbOrTx,
  property: PropertyRow,
  plan: RatePlanRow,
  stay: { checkIn: DateString; checkOut: DateString; adults: number; children: number },
  promo: PromoRow | null | undefined,
): Promise<PricedPlan> {
  const quote = await quoteStay(db, {
    propertyId: property.id,
    ratePlanId: plan.id,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: stay.adults,
    children: stay.children,
  });
  const original = quote.nights.map((n) => n.amount);
  const subtotal = quote.total;
  let amounts = original;
  let discount = 0;
  let problem: string | null = null;
  if (promo !== undefined) {
    problem = promoProblem(promo, {
      propertyId: property.id,
      ratePlanId: plan.id,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      nights: quote.nights.length,
      currency: plan.currency,
    });
    if (!problem && promo) ({ nightly: amounts, discount } = applyPromo(promo, original));
  }
  const rule = await taxRuleFor(db, property.id, 'room');
  const taxes = amounts.reduce((sum, amount) => sum + computeTax(rule, amount).taxAmount, 0);
  return {
    plan,
    original,
    nightly: quote.nights.map((n, i) => ({ date: n.date, amount: amounts[i]! })),
    subtotal,
    discount,
    taxes,
    total: subtotal - discount + taxes,
    // A night without a price is not on sale, whatever the restrictions say.
    violation:
      quote.violations[0]?.message ??
      (original.some((a) => a <= 0) ? 'Not on sale for these dates' : null),
    promoProblem: problem,
  };
}

/** What can be booked for the dates and party, with the price of each rate. */
export async function searchStay(db: DbOrTx, orgId: string, query: StayQuery): Promise<StaySearch> {
  const property = await bookableProperty(db, orgId, query.propertyCode);
  const nights = validateWindow(property, query.checkIn, query.checkOut);
  const adults = query.adults;
  const children = query.children ?? 0;
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
    throw validationError('Say how many adults and children are in each room');
  }
  const code = query.promoCode?.trim();
  const promo = code ? await findPromo(db, orgId, code) : undefined;

  const types = await sellable(db, property.id);
  const days = types.length
    ? await getAvailability(db, {
        propertyId: property.id,
        range: { from: query.checkIn, to: query.checkOut },
        roomTypeIds: types.map((t) => t.roomType.id),
      })
    : [];
  const offers: StayOffer[] = [];
  let promoApplied = false;
  let promoReason: string | null = null;
  for (const { roomType, plans } of types) {
    if (
      adults > roomType.maxAdults ||
      children > roomType.maxChildren ||
      adults + children > roomType.maxOccupancy
    ) {
      continue;
    }
    const available = Math.max(
      0,
      Math.min(...days.filter((d) => d.roomTypeId === roomType.id).map((d) => d.available)),
    );
    const priced: PlanOffer[] = [];
    for (const plan of plans) {
      const p = await pricePlan(
        db,
        property,
        plan,
        { checkIn: query.checkIn, checkOut: query.checkOut, adults, children },
        promo,
      );
      if (promo !== undefined) {
        if (!p.promoProblem) promoApplied = true;
        else promoReason ??= p.promoProblem;
      }
      priced.push({
        ratePlanId: plan.id,
        name: plan.name,
        description: plan.description,
        mealPlan: plan.mealPlan,
        cancellation: cancellationTerms(plan.cancellationPolicy, query.checkIn),
        nightly: p.nightly,
        subtotal: p.subtotal,
        discount: p.discount,
        taxes: p.taxes,
        total: p.total,
        payNow: payNowOf(property, plan, p.total),
        bookable: !p.violation,
        reason: p.violation,
      });
    }
    priced.sort((a, b) => Number(b.bookable) - Number(a.bookable) || a.total - b.total);
    offers.push({
      roomType: publicRoomType(roomType),
      available: Number.isFinite(available) ? available : 0,
      plans: priced,
    });
  }
  return {
    property: publicProperty(property),
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    nights,
    adults,
    children,
    offers,
    promo:
      promo === undefined
        ? null
        : {
            code: promo?.code ?? code!.toUpperCase(),
            label: promo ? promoLabel(promo) : '',
            applied: promoApplied,
            reason: promoApplied ? null : (promoReason ?? 'This code is not valid'),
          },
  };
}

// ---------------------------------------------------------------------------
// Booking

export interface BookingRequest {
  propertyCode: string;
  checkIn: DateString;
  checkOut: DateString;
  rooms: { roomTypeId: string; ratePlanId: string; adults: number; children?: number }[];
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    country?: string | null;
  };
  arrivalTime?: string | null;
  specialRequests?: string | null;
  promoCode?: string | null;
  /** The guest ticked the box accepting the property's terms. */
  acceptTerms: boolean;
  marketingConsent?: boolean;
}

export interface BookingResult {
  /** Opens the booking on the booking site. */
  token: string;
  code: string;
  status: 'tentative' | 'confirmed';
  currency: string;
  total: number;
  payNow: number;
  /** Where to send the guest to pay, and until when the rooms are held. Null when nothing is due now. */
  payment: { checkoutUrl: string; expiresAt: Date } | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Takes a booking from the website: holds the rooms, and either confirms at
 * once (nothing to pay now) or returns where the guest pays. The hold lapses
 * by itself if the payment does not arrive.
 *
 * Every price is worked out here from the rates on file; nothing the browser
 * sends about money is used.
 */
export async function createBooking(
  db: Database,
  gateway: PaymentGateway,
  orgId: string,
  request: BookingRequest,
  now: Date = new Date(),
): Promise<BookingResult> {
  if (!request.acceptTerms) throw validationError('Please accept the booking terms');
  const email = request.guest.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw validationError('Please give a valid email address');
  if (!request.guest.firstName.trim()) throw validationError('Please give your name');
  if (request.rooms.length < 1) throw validationError('Choose at least one room');
  if (request.rooms.length > MAX_WEBSITE_ROOMS) {
    throw validationError(
      `Bookings of more than ${MAX_WEBSITE_ROOMS} rooms are arranged with the property directly`,
    );
  }
  const property = await bookableProperty(db, orgId, request.propertyCode);
  validateWindow(property, request.checkIn, request.checkOut);
  const actor = guestActor(orgId, email);
  const holdMinutes = property.settings.bookingHoldMinutes ?? DEFAULT_HOLD_MINUTES;
  const holdExpiresAt = new Date(now.getTime() + holdMinutes * 60_000);

  const [{ holds } = { holds: 0 }] = await db
    .select({ holds: sql<number>`count(*)::int` })
    .from(reservations)
    .where(
      and(
        eq(reservations.orgId, orgId),
        eq(reservations.status, 'tentative'),
        eq(reservations.source, 'website'),
        gt(reservations.holdExpiresAt, now),
        sql`${reservations.guestId} IN (SELECT id FROM guests WHERE org_id = ${orgId} AND email = ${email})`,
      ),
    );
  if (holds >= MAX_OPEN_HOLDS_PER_GUEST) {
    throw new DomainError(
      'rate_limited',
      'You have several bookings waiting for payment. Finish or cancel one of them first.',
    );
  }

  const code = request.promoCode?.trim();
  const promo = code ? await findPromo(db, orgId, code) : undefined;
  const types = await sellable(db, property.id);

  const outcome = await transact(db, async (tx) => {
    const rooms: { priced: PricedPlan; adults: number; children: number; roomTypeId: string }[] =
      [];
    for (const room of request.rooms) {
      const type = types.find((t) => t.roomType.id === room.roomTypeId);
      const plan = type?.plans.find((p) => p.id === room.ratePlanId);
      if (!type || !plan) throw validationError('That room or rate is not sold on the website');
      const priced = await pricePlan(
        tx,
        property,
        plan,
        {
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          adults: room.adults,
          children: room.children ?? 0,
        },
        promo,
      );
      if (priced.violation) throw new DomainError('restriction_violated', priced.violation);
      if (promo !== undefined && priced.promoProblem && request.rooms.length === 1) {
        throw validationError(priced.promoProblem);
      }
      rooms.push({
        priced,
        adults: room.adults,
        children: room.children ?? 0,
        roomTypeId: room.roomTypeId,
      });
    }
    const usedPromo =
      promo && rooms.some((r) => !r.priced.promoProblem && r.priced.discount > 0) ? promo : null;
    if (promo !== undefined && !usedPromo) {
      throw validationError(rooms[0]?.priced.promoProblem ?? 'This code is not valid');
    }

    const reservation = await createReservation(
      tx,
      actor,
      {
        propertyId: property.id,
        status: 'tentative',
        source: 'website',
        guest: {
          firstName: request.guest.firstName.trim(),
          lastName: request.guest.lastName.trim(),
          email,
          phone: request.guest.phone ?? null,
          country: request.guest.country ?? null,
        },
        rooms: rooms.map((r) => ({
          roomTypeId: r.roomTypeId,
          ratePlanId: r.priced.plan.id,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          adults: r.adults,
          children: r.children,
          nightlyRates: r.priced.nightly.map((n) => n.amount),
        })),
        arrivalTime: request.arrivalTime?.trim().slice(0, 20) || null,
        specialRequests: request.specialRequests?.trim().slice(0, 4000) || null,
        holdExpiresAt,
      },
      // The website never books past capacity and never skips the occupancy limits.
      {},
    );
    const discount = rooms.reduce((sum, r) => sum + r.priced.discount, 0);
    if (usedPromo) {
      await tx
        .update(reservations)
        .set({ promoCodeId: usedPromo.id, promoCode: usedPromo.code, discountAmount: discount })
        .where(eq(reservations.id, reservation.id));
    }
    if (request.marketingConsent && reservation.guestId) {
      await tx.execute(
        sql`UPDATE guests SET marketing_consent = true WHERE id = ${reservation.guestId}`,
      );
    }
    const total = rooms.reduce((sum, r) => sum + r.priced.total, 0);
    const payNow = rooms.reduce(
      (sum, r) => sum + payNowOf(property, r.priced.plan, r.priced.total),
      0,
    );
    return { reservation, total, payNow };
  });

  const { reservation, total, payNow } = outcome;
  const subject = {
    id: reservation.id,
    guestTokenVersion: reservation.guestTokenVersion,
    checkOut: reservation.checkOut,
  };
  const token = guestToken(subject);
  const base = {
    token,
    code: reservation.code,
    currency: reservation.currency,
    total,
    payNow,
  };

  if (payNow <= 0) {
    await confirmBooking(db, actor, reservation.id);
    return { ...base, status: 'confirmed', payment: null };
  }
  try {
    const order = await openPaymentOrder(db, gateway, {
      reservation,
      purpose: 'booking',
      amount: payNow,
      description: `${property.name}, booking ${reservation.code}`,
      expiresAt: holdExpiresAt,
      createdBy: null,
    });
    return {
      ...base,
      status: 'tentative',
      payment: { checkoutUrl: order.checkoutUrl, expiresAt: order.expiresAt },
    };
  } catch (err) {
    // No way to pay means no booking: give the rooms back rather than hold them for nothing.
    await cancelReservation(db, actor, reservation.id, {
      reason: 'The payment page could not be opened',
    }).catch(() => undefined);
    throw err;
  }
}

/** Confirms a held booking and counts the promotional code it used. Safe to repeat. */
async function confirmBooking(db: DbOrTx, actor: Actor, reservationId: string): Promise<void> {
  await transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId))
      .for('update');
    if (!before || before.status !== 'tentative') return;
    // Confirming also counts the promotional code the booking was made with.
    await confirmReservation(tx, actor, reservationId);
  });
}

// ---------------------------------------------------------------------------
// Payment orders

interface OpenOrderInput {
  reservation: Pick<
    ReservationRow | ReservationDetail,
    | 'id'
    | 'propertyId'
    | 'code'
    | 'currency'
    | 'guestName'
    | 'guestId'
    | 'guestTokenVersion'
    | 'checkOut'
  > & { orgId?: string };
  purpose: PaymentOrderPurpose;
  amount: number;
  description: string;
  expiresAt: Date;
  createdBy: string | null;
}

async function openPaymentOrder(
  db: Database,
  gateway: PaymentGateway,
  input: OpenOrderInput,
): Promise<PaymentOrderRow> {
  const { reservation } = input;
  const [row] = await db
    .select({ orgId: reservations.orgId, email: guests.email, phone: guests.phone })
    .from(reservations)
    .leftJoin(guests, eq(guests.id, reservations.guestId))
    .where(eq(reservations.id, reservation.id));
  if (!row) throw notFound('Reservation', reservation.id);
  const order = await gateway.createOrder({
    amount: input.amount,
    currency: reservation.currency,
    // The code alone is not unique: a booking can be asked to pay more than once.
    reference: `${reservation.code}-${randomCode(6)}`,
    description: input.description,
    customer: { name: reservation.guestName, email: row.email, phone: row.phone },
    returnUrl: guestBookingUrl(reservation, '?paid=1'),
    expiresAt: input.expiresAt,
  });
  const [created] = await db
    .insert(paymentOrders)
    .values({
      orgId: row.orgId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      purpose: input.purpose,
      provider: gateway.name,
      providerOrderId: order.orderId,
      checkoutUrl: order.checkoutUrl,
      amount: input.amount,
      currency: reservation.currency,
      description: input.description,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    })
    .returning();
  return created!;
}

/**
 * A link staff send to a guest to pay an amount online (a deposit asked for
 * by phone, the balance before arrival). The money lands on the guest folio.
 */
export async function createPaymentLink(
  db: Database,
  gateway: PaymentGateway,
  actor: Actor,
  reservationId: string,
  input: { amount: number; description?: string | null; validHours?: number },
  now: Date = new Date(),
): Promise<PaymentOrderRow & { payUrl: string }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw validationError('The amount must be above zero');
  }
  const hours = input.validHours ?? 48;
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14) {
    throw validationError('A payment link can be valid for 1 hour to 14 days');
  }
  const reservation = await loadReservation(db, actor.orgId, reservationId);
  if (['cancelled', 'no_show'].includes(reservation.status)) {
    throw invalidState('This reservation is cancelled');
  }
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, reservation.propertyId));
  const order = await openPaymentOrder(db, gateway, {
    reservation,
    purpose: 'payment_link',
    amount: input.amount,
    description:
      input.description?.trim().slice(0, 200) || `${property!.name}, booking ${reservation.code}`,
    expiresAt: new Date(now.getTime() + hours * 3_600_000),
    createdBy: actor.userId ?? null,
  });
  await writeAudit(db, actor, {
    action: 'payment.link_created',
    entityType: 'reservation',
    entityId: reservationId,
    propertyId: reservation.propertyId,
    summary: `Created a payment link for ${formatMoney(input.amount, reservation.currency)} on reservation ${reservation.code}`,
    changes: { orderId: order.id, amount: input.amount },
  });
  return { ...order, payUrl: guestBookingUrl(reservation, `/pay/${order.id}`) };
}

export interface OrderOutcome {
  order: PaymentOrderRow;
  /** True when this call is the one that recorded the payment. */
  settled: boolean;
  /** The money was returned because the rooms were gone by the time it arrived. */
  refunded: boolean;
}

/**
 * Asks the gateway what became of an order and acts on the answer: records
 * the payment and confirms the booking, or closes an order that lapsed.
 * Called on the guest's return from the payment page, on a webhook, and by
 * the worker for orders nobody came back for. Safe to call any number of
 * times, from any of them at once.
 */
export async function syncPaymentOrder(
  db: Database,
  gateway: PaymentGateway,
  orderId: string,
  now: Date = new Date(),
): Promise<OrderOutcome> {
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
  if (!order) throw notFound('Payment order', orderId);
  if (order.status !== 'created' || order.provider !== gateway.name) {
    return { order, settled: false, refunded: false };
  }
  let state = await gateway.fetchOrder(order.providerOrderId);
  const lapsed = now.getTime() > order.expiresAt.getTime() + ORDER_GRACE_MS;
  if (state.status === 'open' && lapsed) {
    // Close it at the gateway first, then look once more: a payment may have slipped in between.
    await gateway.cancelOrder(order.providerOrderId);
    state = await gateway.fetchOrder(order.providerOrderId);
    if (state.status !== 'paid') state = { status: 'expired' };
  }
  if (state.status === 'paid' && state.paymentId) {
    return settleOrder(db, gateway, order.id, {
      paymentId: state.paymentId,
      amountPaid: state.amountPaid ?? order.amount,
    });
  }
  // Still open (or paid without a payment to point to, which no gateway should report): ask again later.
  const status =
    state.status === 'expired' || state.status === 'cancelled' ? state.status : 'created';
  const [updated] = await db
    .update(paymentOrders)
    .set({ status, checkedAt: now })
    .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, 'created')))
    .returning();
  return { order: updated ?? order, settled: false, refunded: false };
}

async function settleOrder(
  db: Database,
  gateway: PaymentGateway,
  orderId: string,
  paid: { paymentId: string; amountPaid: number },
): Promise<OrderOutcome> {
  const result = await transact(db, async (tx) => {
    const [order] = await tx
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId))
      .for('update');
    if (!order) throw notFound('Payment order', orderId);
    if (order.status === 'paid') return { order, settled: false, unplaced: false };
    const actor = gatewayActor(order.orgId, gateway.name);

    let unplaced = false;
    const [reservation] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, order.reservationId))
      .for('update');
    if (order.purpose === 'booking') {
      if (reservation!.status === 'tentative') {
        await confirmBooking(tx, actor, reservation!.id);
      } else if (reservation!.status === 'cancelled') {
        // The hold ran out before the payment arrived. Take the rooms again if they are still free.
        try {
          await reinstateReservation(tx, actor, reservation!.id);
        } catch (err) {
          if (!isDomainError(err)) throw err;
          unplaced = true;
        }
      }
    }
    const folio = await ensureGuestFolio(tx, order.reservationId);
    if (folio.status !== 'open') {
      await tx
        .update(folios)
        .set({ status: 'open', closedAt: null })
        .where(eq(folios.id, folio.id));
    }
    const { payment } = await recordPayment(tx, actor, {
      folioId: folio.id,
      method: 'online',
      amount: paid.amountPaid,
      provider: gateway.name,
      providerPaymentId: paid.paymentId,
      providerOrderId: order.providerOrderId,
      note:
        order.purpose === 'booking' ? 'Paid on the booking site' : 'Paid through a payment link',
    });
    const [updated] = await tx
      .update(paymentOrders)
      .set({
        status: 'paid',
        folioId: folio.id,
        paymentId: payment.id,
        providerPaymentId: paid.paymentId,
        paidAt: new Date(),
        checkedAt: new Date(),
      })
      .where(eq(paymentOrders.id, order.id))
      .returning();
    return { order: updated!, settled: true, unplaced };
  });

  if (!result.unplaced) return { order: result.order, settled: result.settled, refunded: false };

  // Paid for rooms that are no longer free: the guest gets the money back, and staff are told.
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(eq(reservations.id, result.order.reservationId));
  const refunded = await refundOnline(db, gateway, result.order.paymentId!, {
    amount: paid.amountPaid,
    reason: 'The rooms were no longer available when the payment arrived',
  });
  await raiseAlert(db, {
    orgId: result.order.orgId,
    propertyId: result.order.propertyId,
    kind: 'payment_unplaced',
    severity: refunded ? 'warning' : 'critical',
    title: `A website booking was paid after its rooms were released (${reservation!.code})`,
    body: refunded
      ? `${reservation!.guestName} paid ${formatMoney(paid.amountPaid, result.order.currency)} after the hold had run out and the rooms had been sold. The payment was refunded automatically. Contact the guest to offer other dates.`
      : `${reservation!.guestName} paid ${formatMoney(paid.amountPaid, result.order.currency)} after the hold had run out and the rooms had been sold. The automatic refund FAILED: refund the payment from the reservation's folio and contact the guest.`,
    entityType: 'reservation',
    entityId: reservation!.id,
    dedupeKey: `payment_unplaced:${result.order.id}`,
  });
  return { order: result.order, settled: true, refunded };
}

/**
 * Sends money back through the gateway and records it on the folio. Returns
 * false, without recording anything, when the gateway refuses; the caller
 * decides how to tell staff.
 */
export async function refundOnline(
  db: Database,
  gateway: PaymentGateway,
  paymentId: string,
  input: { amount: number; reason: string },
  actor?: Actor,
): Promise<boolean> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!payment) throw notFound('Payment', paymentId);
  if (!payment.providerPaymentId || payment.provider !== gateway.name) {
    throw invalidState('This payment was not taken through the payment gateway in use');
  }
  const [property] = await db
    .select({ orgId: properties.orgId })
    .from(properties)
    .where(eq(properties.id, payment.propertyId));
  const by = actor ?? gatewayActor(property!.orgId, gateway.name);
  // Counting earlier refunds of the payment makes the reference unique per refund but stable across retries of one.
  const [{ earlier } = { earlier: 0 }] = await db
    .select({ earlier: sql<number>`count(*)::int` })
    .from(payments)
    .where(eq(payments.refundOfPaymentId, payment.id));
  let refund;
  try {
    refund = await gateway.refund({
      paymentId: payment.providerPaymentId,
      amount: input.amount,
      currency: payment.currency,
      reference: `${payment.id.slice(0, 18)}-r${earlier + 1}`,
      reason: input.reason,
    });
  } catch (err) {
    if (isDomainError(err, 'upstream_failed')) return false;
    throw err;
  }
  await refundPayment(db, by, payment.id, {
    amount: input.amount,
    reason: input.reason,
    method: 'online',
    reference: refund.refundId,
  });
  return true;
}

/** Orders still open that the gateway should be asked about: those nobody returned from, and those past their time. */
export async function paymentOrdersToCheck(
  db: DbOrTx,
  provider: string,
  now: Date = new Date(),
  limit = 50,
): Promise<string[]> {
  const rows = await db
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.status, 'created'),
        eq(paymentOrders.provider, provider),
        // Give the guest's own return a head start, then ask at most once a minute.
        sql`${paymentOrders.createdAt} < ${new Date(now.getTime() - 60_000)}`,
        sql`(${paymentOrders.checkedAt} IS NULL OR ${paymentOrders.checkedAt} < ${new Date(now.getTime() - 60_000)})`,
      ),
    )
    .orderBy(asc(paymentOrders.expiresAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// The guest's own view of a booking

export interface GuestBooking {
  code: string;
  status: ReservationRow['status'];
  property: PublicProperty & { phone: string | null; email: string | null; address: string | null };
  guestName: string;
  checkIn: DateString;
  checkOut: DateString;
  nights: number;
  adults: number;
  children: number;
  arrivalTime: string | null;
  specialRequests: string | null;
  rooms: {
    roomType: string;
    ratePlan: string | null;
    mealPlan: MealPlan | null;
    adults: number;
    children: number;
    status: string;
    amount: number;
    cancellation: CancellationTerms;
  }[];
  currency: string;
  /** Charges with tax: what is on the bill so far plus the nights still to come. */
  total: number;
  /** The tax in `total`. */
  tax: number;
  /** What has been paid, less what has been returned. */
  paid: number;
  /** What has been returned to the guest so far. */
  refunded: number;
  balance: number;
  promoCode: string | null;
  discount: number;
  /** An unfinished payment the guest can still complete. */
  pendingPayment: { orderId: string; amount: number; checkoutUrl: string; expiresAt: Date } | null;
  /** What cancelling now would cost, and whether the guest may still do it online. */
  cancellation: { allowed: boolean; charge: number; refund: number; reason: string | null };
  onlineCheckin: { available: boolean; completedAt: Date | null };
  arrivalInstructions: string | null;
}

interface BookingContext {
  reservation: ReservationRow;
  property: PropertyRow;
}

/** Resolves a guest link to its reservation, or fails as "not found" whatever was wrong with it. */
export async function reservationForGuestToken(
  db: DbOrTx,
  token: string,
  now: Date = new Date(),
): Promise<BookingContext> {
  const claims = readGuestToken(token, now);
  if (!claims) throw notFound('Booking');
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(eq(reservations.id, claims.reservationId));
  if (!reservation || (reservation.guestTokenVersion & 0xffff) !== claims.version) {
    throw notFound('Booking');
  }
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, reservation.propertyId));
  return { reservation, property: property! };
}

interface StayMoney {
  total: number;
  /** The tax in `total`. */
  tax: number;
  /** Payments less refunds. */
  paid: number;
  refunded: number;
  balance: number;
}

/** What a stay costs with tax (billed so far plus nights to come), and what has been paid towards it. */
export async function stayMoney(db: DbOrTx, reservation: ReservationRow): Promise<StayMoney> {
  const { rows } = await db.execute<{
    charges: string | null;
    tax: string | null;
    paid: string | null;
    refunded: string | null;
  }>(sql`
    SELECT
      sum(l.amount + l.tax_amount) FILTER (WHERE l.kind NOT IN ('payment', 'refund'))::text AS charges,
      sum(l.tax_amount) FILTER (WHERE l.kind NOT IN ('payment', 'refund'))::text AS tax,
      (-sum(l.amount) FILTER (WHERE l.kind IN ('payment', 'refund')))::text AS paid,
      sum(l.amount) FILTER (WHERE l.kind = 'refund')::text AS refunded
    FROM folio_lines l JOIN folios f ON f.id = l.folio_id
    WHERE f.reservation_id = ${reservation.id} AND l.voided_at IS NULL
  `);
  const upcoming = await db.execute<{ amount: string }>(sql`
    SELECT n.amount::text
    FROM reservation_nights n
    JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
    WHERE rr.reservation_id = ${reservation.id}
      AND rr.status IN ('tentative', 'confirmed', 'in_house')
      AND NOT EXISTS (
        SELECT 1 FROM folio_lines l
        WHERE l.reservation_room_id = rr.id AND l.business_date = n.date
          AND l.kind = 'room' AND l.voided_at IS NULL)
  `);
  const rule = upcoming.rows.length ? await taxRuleFor(db, reservation.propertyId, 'room') : null;
  // A booking the channel collects for is not the property's to charge again.
  let toCome = 0;
  let taxToCome = 0;
  if (reservation.paymentCollect !== 'channel') {
    for (const row of upcoming.rows) {
      const amount = Number(row.amount);
      const tax = computeTax(rule, amount).taxAmount;
      toCome += amount + tax;
      taxToCome += tax;
    }
  }
  const total = Number(rows[0]?.charges ?? 0) + toCome;
  const paid = Number(rows[0]?.paid ?? 0);
  return {
    total,
    tax: Number(rows[0]?.tax ?? 0) + taxToCome,
    paid,
    refunded: Number(rows[0]?.refunded ?? 0),
    balance: total - paid,
  };
}

interface CancellationQuote {
  allowed: boolean;
  /** Before tax. */
  charge: number;
  reason: string | null;
  perRoom: { roomId: string; charge: number }[];
}

async function quoteCancellation(
  db: DbOrTx,
  { reservation, property }: BookingContext,
): Promise<CancellationQuote> {
  const today = todayIn(property.timezone);
  const none = (reason: string): CancellationQuote => ({
    allowed: false,
    charge: 0,
    reason,
    perRoom: [],
  });
  if (reservation.status === 'cancelled') return none('This booking is already cancelled');
  if (!['tentative', 'confirmed'].includes(reservation.status)) {
    return none('This stay has started; please speak to the front desk');
  }
  if (reservation.source !== 'website') {
    return none(
      reservation.source === 'ota'
        ? 'This booking was made on a booking site; please cancel it there'
        : 'Please contact the property to cancel this booking',
    );
  }
  if (today > reservation.checkIn) return none('The arrival date has passed');
  const rooms = await db
    .select({ room: reservationRooms, policy: ratePlans.cancellationPolicy })
    .from(reservationRooms)
    .leftJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(
      and(
        eq(reservationRooms.reservationId, reservation.id),
        inArray(reservationRooms.status, ['tentative', 'confirmed']),
      ),
    );
  const nights = rooms.length
    ? await db
        .select()
        .from(reservationNights)
        .where(
          inArray(
            reservationNights.reservationRoomId,
            rooms.map((r) => r.room.id),
          ),
        )
        .orderBy(asc(reservationNights.date))
    : [];
  const perRoom = rooms.map(({ room, policy }) => ({
    roomId: room.id,
    // A hold that was never paid for costs nothing to drop.
    charge:
      reservation.status === 'tentative'
        ? 0
        : cancellationCharge(
            policy,
            room.checkIn,
            nights.filter((n) => n.reservationRoomId === room.id).map((n) => n.amount),
            today,
          ),
  }));
  return {
    allowed: true,
    charge: perRoom.reduce((sum, r) => sum + r.charge, 0),
    reason: null,
    perRoom,
  };
}

export async function getGuestBooking(
  db: DbOrTx,
  token: string,
  now: Date = new Date(),
): Promise<GuestBooking> {
  const context = await reservationForGuestToken(db, token, now);
  const { reservation, property } = context;
  const rooms = await db
    .select({
      room: reservationRooms,
      roomType: roomTypes.name,
      ratePlan: ratePlans.name,
      mealPlan: ratePlans.mealPlan,
      policy: ratePlans.cancellationPolicy,
    })
    .from(reservationRooms)
    .innerJoin(roomTypes, eq(roomTypes.id, reservationRooms.roomTypeId))
    .leftJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .where(eq(reservationRooms.reservationId, reservation.id))
    .orderBy(asc(reservationRooms.position));
  const money = await stayMoney(db, reservation);
  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.reservationId, reservation.id),
        eq(paymentOrders.status, 'created'),
        gt(paymentOrders.expiresAt, now),
      ),
    )
    .orderBy(desc(paymentOrders.createdAt))
    .limit(1);
  const quote = await quoteCancellation(db, context);
  const rule = quote.charge > 0 ? await taxRuleFor(db, property.id, 'fee') : null;
  const chargeWithTax = quote.charge + computeTax(rule, quote.charge).taxAmount;
  const today = todayIn(property.timezone);
  const public_ = publicProperty(property);
  return {
    code: reservation.code,
    status: reservation.status,
    property: {
      ...public_,
      phone: property.phone,
      email: property.email,
      address:
        [property.addressLine1, property.addressLine2, property.city, property.postalCode]
          .filter(Boolean)
          .join(', ') || null,
    },
    guestName: reservation.guestName,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    nights: diffDays(reservation.checkIn, reservation.checkOut),
    adults: reservation.adults,
    children: reservation.children,
    arrivalTime: reservation.arrivalTime,
    specialRequests: reservation.specialRequests,
    rooms: rooms.map((r) => ({
      roomType: r.roomType,
      ratePlan: r.ratePlan,
      mealPlan: r.mealPlan,
      adults: r.room.adults,
      children: r.room.children,
      status: r.room.status,
      amount: r.room.amount,
      cancellation: cancellationTerms(r.policy, r.room.checkIn),
    })),
    currency: reservation.currency,
    total: money.total,
    tax: money.tax,
    paid: money.paid,
    refunded: money.refunded,
    balance: money.balance,
    promoCode: reservation.promoCode,
    discount: reservation.discountAmount,
    pendingPayment: order
      ? {
          orderId: order.id,
          amount: order.amount,
          checkoutUrl: order.checkoutUrl,
          expiresAt: order.expiresAt,
        }
      : null,
    cancellation: {
      allowed: quote.allowed,
      charge: chargeWithTax,
      refund: quote.allowed ? Math.max(0, money.paid - chargeWithTax) : 0,
      reason: quote.reason,
    },
    onlineCheckin: {
      available:
        reservation.status === 'confirmed' &&
        today <= reservation.checkIn &&
        diffDays(today, reservation.checkIn) <= 7,
      completedAt: reservation.onlineCheckinAt,
    },
    arrivalInstructions:
      reservation.status === 'confirmed' || reservation.status === 'in_house'
        ? (property.settings.arrivalInstructions ?? null)
        : null,
  };
}

/** The guest came back from the payment page: find out what happened to each open order of the booking. */
export async function syncGuestPayments(
  db: Database,
  gateway: PaymentGateway,
  token: string,
  now: Date = new Date(),
): Promise<GuestBooking> {
  const { reservation } = await reservationForGuestToken(db, token, now);
  const open = await db
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.reservationId, reservation.id),
        eq(paymentOrders.status, 'created'),
        eq(paymentOrders.provider, gateway.name),
      ),
    );
  for (const { id } of open) await syncPaymentOrder(db, gateway, id, now);
  return getGuestBooking(db, token, now);
}

export interface GuestCancellation {
  booking: GuestBooking;
  /** With tax. */
  charge: number;
  refunded: number;
  /** Money owed back to the guest that could not be sent automatically; staff have been told. */
  refundPending: number;
}

/**
 * The guest cancels their own website booking. The rate's terms decide what
 * it costs; anything paid beyond that goes back the way it came.
 */
export async function cancelGuestBooking(
  db: Database,
  gateway: PaymentGateway,
  token: string,
  now: Date = new Date(),
): Promise<GuestCancellation> {
  const context = await reservationForGuestToken(db, token, now);
  const { reservation } = context;
  const actor = guestActor(reservation.orgId, reservation.guestName);

  const { charge, owedBack } = await transact(db, async (tx) => {
    const [locked] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservation.id))
      .for('update');
    const quote = await quoteCancellation(tx, { ...context, reservation: locked! });
    if (!quote.allowed) throw invalidState(quote.reason ?? 'This booking cannot be cancelled');
    await cancelReservation(tx, actor, reservation.id, { reason: 'Cancelled by the guest online' });
    let withTax = 0;
    if (quote.charge > 0) {
      const line = await postCharge(tx, actor, {
        reservationId: reservation.id,
        kind: 'fee',
        description: 'Cancellation charge',
        unitAmount: quote.charge,
        source: 'cancellation',
      });
      withTax = line.amount + line.taxAmount;
    }
    await closeOpenOrders(tx, reservation.id);
    const money = await stayMoney(tx, { ...locked!, status: 'cancelled' });
    return { charge: withTax, owedBack: Math.max(0, money.paid - money.total) };
  });

  // Unpaid orders are closed at the gateway so the guest cannot pay for a cancelled booking.
  const closed = await db
    .select()
    .from(paymentOrders)
    .where(
      and(eq(paymentOrders.reservationId, reservation.id), eq(paymentOrders.status, 'cancelled')),
    );
  for (const order of closed) {
    if (order.provider === gateway.name) {
      await gateway.cancelOrder(order.providerOrderId).catch(() => undefined);
    }
  }

  let refunded = 0;
  if (owedBack > 0) refunded = await refundToGuest(db, gateway, reservation.id, owedBack, actor);
  const refundPending = owedBack - refunded;
  if (refundPending > 0) {
    await raiseAlert(db, {
      orgId: reservation.orgId,
      propertyId: reservation.propertyId,
      kind: 'refund_pending',
      severity: 'critical',
      title: `Refund owed on cancelled booking ${reservation.code}`,
      body: `${reservation.guestName} cancelled online and is owed ${formatMoney(refundPending, reservation.currency)}, which could not be sent back automatically. Refund it from the reservation's folio.`,
      entityType: 'reservation',
      entityId: reservation.id,
      dedupeKey: `refund_pending:${reservation.id}`,
    });
  }
  return { booking: await getGuestBooking(db, token, now), charge, refunded, refundPending };
}

async function closeOpenOrders(tx: Transaction, reservationId: string): Promise<void> {
  await tx
    .update(paymentOrders)
    .set({ status: 'cancelled' })
    .where(
      and(eq(paymentOrders.reservationId, reservationId), eq(paymentOrders.status, 'created')),
    );
}

/** Returns up to `amount` against the reservation's online payments, newest first. Returns what went back. */
async function refundToGuest(
  db: Database,
  gateway: PaymentGateway,
  reservationId: string,
  amount: number,
  actor: Actor,
): Promise<number> {
  const { rows } = await db.execute<{ id: string; left: string }>(sql`
    SELECT p.id, (p.amount + coalesce((
      SELECT sum(r.amount) FROM payments r
      WHERE r.refund_of_payment_id = p.id AND r.status = 'captured'), 0))::text AS left
    FROM payments p JOIN folios f ON f.id = p.folio_id
    WHERE f.reservation_id = ${reservationId} AND p.amount > 0 AND p.status = 'captured'
      AND p.provider = ${gateway.name} AND p.provider_payment_id IS NOT NULL
    ORDER BY p.received_at DESC
  `);
  let remaining = amount;
  for (const row of rows) {
    if (remaining <= 0) break;
    const part = Math.min(remaining, Number(row.left));
    if (part <= 0) continue;
    const ok = await refundOnline(
      db,
      gateway,
      row.id,
      { amount: part, reason: 'Booking cancelled by the guest' },
      { ...actor, type: 'system', label: `system:payments:${gateway.name}` },
    );
    if (ok) remaining -= part;
  }
  return amount - remaining;
}

/** The payment orders of a reservation, newest first, for staff. */
export async function listPaymentOrders(
  db: DbOrTx,
  orgId: string,
  reservationId: string,
): Promise<(PaymentOrderRow & { payUrl: string | null })[]> {
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, orgId)));
  if (!reservation) throw notFound('Reservation', reservationId);
  const rows = await db
    .select()
    .from(paymentOrders)
    .where(eq(paymentOrders.reservationId, reservationId))
    .orderBy(desc(paymentOrders.createdAt));
  return rows.map((order) => ({
    ...order,
    payUrl: order.status === 'created' ? guestBookingUrl(reservation, `/pay/${order.id}`) : null,
  }));
}

/** Stops a payment link that has not been paid. */
export async function cancelPaymentOrder(
  db: Database,
  gateway: PaymentGateway,
  actor: Actor,
  orderId: string,
): Promise<PaymentOrderRow> {
  const [order] = await db
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.orgId, actor.orgId)));
  if (!order) throw notFound('Payment link', orderId);
  if (order.status !== 'created') throw conflict(`This payment link is already ${order.status}`);
  // Ask first: it may have been paid a moment ago, and then it must be recorded, not cancelled.
  const synced = await syncPaymentOrder(db, gateway, order.id);
  if (synced.order.status !== 'created') return synced.order;
  if (order.provider === gateway.name) await gateway.cancelOrder(order.providerOrderId);
  const [updated] = await db
    .update(paymentOrders)
    .set({ status: 'cancelled' })
    .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, 'created')))
    .returning();
  await writeAudit(db, actor, {
    action: 'payment.link_cancelled',
    entityType: 'reservation',
    entityId: order.reservationId,
    propertyId: order.propertyId,
    summary: `Cancelled a payment link for ${formatMoney(order.amount, order.currency)}`,
  });
  return updated ?? synced.order;
}
