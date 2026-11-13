import { randomUUID } from 'node:crypto';
import {
  addDays,
  dayOfWeek,
  decimalToMinor,
  eachDate,
  isValidDate,
  minorToDecimal,
  todayIn,
} from '@pms/domain/shared';

/**
 * The simulator's world: a channel manager account (properties, room types,
 * rate plans, the inventory table), the booking channels connected to it, and
 * the bookings they produce. Everything lives in memory.
 *
 * It follows Channex's documented behaviour where that behaviour matters to
 * a PMS: values are absolute and last-write-wins, a rejected value becomes a
 * warning rather than an error, a new booking lowers availability on its own
 * while a change or cancellation does not, revisions stay in the feed until
 * acknowledged, and guest contact details are withheld once they are.
 */

export interface SimProperty {
  id: string;
  title: string;
  currency: string;
  timezone: string;
  propertyType: string;
  createdAt: string;
}

export interface SimRoomType {
  id: string;
  propertyId: string;
  title: string;
  countOfRooms: number;
  occAdults: number;
  occChildren: number;
  occInfants: number;
  defaultOccupancy: number;
}

export interface SimRatePlan {
  id: string;
  propertyId: string;
  roomTypeId: string;
  title: string;
  currency: string;
  /** Default nightly rate in minor units, used for dates never priced. */
  defaultRate: number;
}

export interface RestrictionState {
  /** Minor units. */
  rate: number;
  minStayArrival: number;
  minStayThrough: number;
  /** 0 means no maximum. */
  maxStay: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
}

export const CHANNELS = {
  BDC: { title: 'Booking.com', otaName: 'BookingCom', commissionPercent: 15 },
  ABB: { title: 'Airbnb', otaName: 'Airbnb', commissionPercent: 3 },
  EXP: { title: 'Expedia', otaName: 'Expedia', commissionPercent: 18 },
  AGO: { title: 'Agoda', otaName: 'Agoda', commissionPercent: 17 },
  MMT: { title: 'MakeMyTrip', otaName: 'MakeMyTrip', commissionPercent: 18 },
} as const;
export type ChannelCode = keyof typeof CHANNELS;

export interface SimChannel {
  id: string;
  propertyId: string;
  code: ChannelCode;
  active: boolean;
  /** What the channel itself shows as bookable: room type id -> date -> rooms. Lags the inventory table. */
  view: Map<string, Map<string, number>>;
  lastUpdatedAt: string | null;
}

export interface SimBookingRoom {
  bookingRoomId: string;
  roomTypeId: string | null;
  ratePlanId: string | null;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** date -> minor units */
  days: Record<string, number>;
  guestName: string | null;
  isCancelled: boolean;
}

export interface SimCustomer {
  name: string;
  surname: string;
  mail: string | null;
  phone: string | null;
  country: string | null;
  language: string | null;
  city: string | null;
  address: string | null;
  zip: string | null;
}

export interface SimBooking {
  id: string;
  propertyId: string;
  channel: ChannelCode;
  otaReservationCode: string;
  status: 'new' | 'modified' | 'cancelled';
  rooms: SimBookingRoom[];
  customer: SimCustomer;
  notes: string | null;
  arrivalHour: string | null;
  paymentCollect: 'property' | 'ota' | null;
  revisionIds: string[];
  createdAt: string;
}

export interface SimRevision {
  id: string;
  bookingId: string;
  propertyId: string;
  status: 'new' | 'modified' | 'cancelled';
  insertedAt: string;
  /** Snapshot of the booking at this revision, in Channex's wire format. */
  attributes: Record<string, unknown>;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  nonAckedWarned: boolean;
}

export interface SimWebhook {
  id: string;
  callbackUrl: string;
  eventMask: string;
  headers: Record<string, string>;
  isActive: boolean;
  isGlobal: boolean;
  propertyId: string | null;
  sendData: boolean;
  isSigned: boolean;
}

export interface RequestLogEntry {
  at: string;
  method: string;
  path: string;
  status: number;
  propertyId?: string;
  /** Number of change objects in an ARI update. */
  values?: number;
  full?: boolean;
}

export interface DeliveryLogEntry {
  at: string;
  webhookId: string;
  event: string;
  attempt: number;
  status: number | 'error' | 'dropped';
}

export interface Faults {
  /** The next N API requests fail with `failStatus`. */
  failNext: number;
  failStatus: number;
  /** Every API request fails with 503 until this time (epoch ms). */
  outageUntil: number;
  latencyMs: number;
  /** Webhooks are not sent at all: the PMS must find bookings by polling. */
  dropWebhooks: boolean;
  /** Every webhook is delivered twice. */
  duplicateWebhooks: boolean;
}

export interface UpdateWarning extends Record<string, unknown> {
  warning: Record<string, string[]>;
}

const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const MAX_LOG = 2000;

export class SimState {
  properties = new Map<string, SimProperty>();
  roomTypes = new Map<string, SimRoomType>();
  ratePlans = new Map<string, SimRatePlan>();
  /** room type id -> date -> rooms */
  availability = new Map<string, Map<string, number>>();
  /** rate plan id -> date -> values */
  restrictions = new Map<string, Map<string, RestrictionState>>();
  channels = new Map<string, SimChannel>();
  bookings = new Map<string, SimBooking>();
  revisions = new Map<string, SimRevision>();
  webhooks = new Map<string, SimWebhook>();
  oneTimeTokens = new Map<string, { propertyId: string; username: string; expiresAt: number }>();
  requestLog: RequestLogEntry[] = [];
  deliveries: DeliveryLogEntry[] = [];
  tasks: { id: string; propertyId: string; kind: 'availability' | 'restrictions'; at: string }[] =
    [];
  faults: Faults = {
    failNext: 0,
    failStatus: 503,
    outageUntil: 0,
    latencyMs: 0,
    dropWebhooks: false,
    duplicateWebhooks: false,
  };
  /** How long a channel takes to show a value after the channel manager has it. */
  distributionDelayMs = 0;
  /** Requests allowed per property on each ARI endpoint within `ariWindowMs`. */
  ariLimitPerMinute = 10;
  ariWindowMs = 60_000;
  /** How long a revision may stay unacknowledged before `non_acked_booking` is announced. */
  nonAckedAfterMs = 30 * 60_000;
  private ariCalls = new Map<string, number[]>();
  private reservationSeq = 4_100_000_000;
  /** Called when something should be announced to webhook subscribers. */
  onEvent: (event: string, propertyId: string, payload: Record<string, unknown>) => void = () => {};
  /** Timers for delayed channel updates, so a reset can cancel them. */
  private timers = new Set<NodeJS.Timeout>();

  reset(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.properties.clear();
    this.roomTypes.clear();
    this.ratePlans.clear();
    this.availability.clear();
    this.restrictions.clear();
    this.channels.clear();
    this.bookings.clear();
    this.revisions.clear();
    this.webhooks.clear();
    this.oneTimeTokens.clear();
    this.requestLog = [];
    this.deliveries = [];
    this.tasks = [];
    this.ariCalls.clear();
    this.faults = {
      failNext: 0,
      failStatus: 503,
      outageUntil: 0,
      latencyMs: 0,
      dropWebhooks: false,
      duplicateWebhooks: false,
    };
  }

  log(entry: RequestLogEntry): void {
    this.requestLog.push(entry);
    if (this.requestLog.length > MAX_LOG)
      this.requestLog.splice(0, this.requestLog.length - MAX_LOG);
  }

  // -------------------------------------------------------------------------
  // Structure

  createProperty(input: {
    title: string;
    currency: string;
    timezone?: string | null;
    propertyType?: string | null;
  }): SimProperty {
    const property: SimProperty = {
      id: randomUUID(),
      title: input.title,
      currency: input.currency.toUpperCase(),
      timezone: input.timezone ?? 'Asia/Kolkata',
      propertyType: input.propertyType ?? 'hotel',
      createdAt: new Date().toISOString(),
    };
    this.properties.set(property.id, property);
    // A new property starts with the main channels connected, so there is something to sell on.
    for (const code of Object.keys(CHANNELS) as ChannelCode[])
      this.connectChannel(property.id, code);
    return property;
  }

  createRoomType(input: Omit<SimRoomType, 'id'>): SimRoomType {
    const roomType: SimRoomType = { ...input, id: randomUUID() };
    this.roomTypes.set(roomType.id, roomType);
    this.availability.set(roomType.id, new Map());
    return roomType;
  }

  createRatePlan(input: Omit<SimRatePlan, 'id'>): SimRatePlan {
    const ratePlan: SimRatePlan = { ...input, id: randomUUID() };
    this.ratePlans.set(ratePlan.id, ratePlan);
    this.restrictions.set(ratePlan.id, new Map());
    return ratePlan;
  }

  connectChannel(propertyId: string, code: ChannelCode): SimChannel {
    const existing = [...this.channels.values()].find(
      (c) => c.propertyId === propertyId && c.code === code,
    );
    if (existing) {
      existing.active = true;
      return existing;
    }
    const channel: SimChannel = {
      id: randomUUID(),
      propertyId,
      code,
      active: true,
      view: new Map(),
      lastUpdatedAt: null,
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  channelsOf(propertyId: string): SimChannel[] {
    return [...this.channels.values()].filter((c) => c.propertyId === propertyId);
  }

  today(propertyId: string): string {
    return todayIn(this.properties.get(propertyId)?.timezone ?? 'UTC');
  }

  // -------------------------------------------------------------------------
  // Inventory table

  availabilityOn(roomTypeId: string, date: string): number {
    return this.availability.get(roomTypeId)?.get(date) ?? 0;
  }

  restrictionOn(ratePlanId: string, date: string): RestrictionState {
    const plan = this.ratePlans.get(ratePlanId);
    return (
      this.restrictions.get(ratePlanId)?.get(date) ?? {
        rate: plan?.defaultRate ?? 0,
        minStayArrival: 1,
        minStayThrough: 1,
        maxStay: 0,
        closedToArrival: false,
        closedToDeparture: false,
        stopSell: false,
      }
    );
  }

  /** True when the ARI call is within the per-property limit; records it if so. */
  takeAriSlot(
    endpoint: 'availability' | 'restrictions',
    propertyId: string,
    now = Date.now(),
  ): { ok: true } | { ok: false; retryAfter: number } {
    const key = `${endpoint}:${propertyId}`;
    const recent = (this.ariCalls.get(key) ?? []).filter((t) => now - t < this.ariWindowMs);
    if (recent.length >= this.ariLimitPerMinute) {
      this.ariCalls.set(key, recent);
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((this.ariWindowMs - (now - recent[0]!)) / 1000)),
      };
    }
    recent.push(now);
    this.ariCalls.set(key, recent);
    return { ok: true };
  }

  clearAriSlots(): void {
    this.ariCalls.clear();
  }

  private datesOf(change: Record<string, unknown>): string[] | string {
    const {
      date,
      date_from: from,
      date_to: to,
      days,
    } = change as {
      date?: unknown;
      date_from?: unknown;
      date_to?: unknown;
      days?: unknown;
    };
    if (date !== undefined && (from !== undefined || to !== undefined))
      return 'give either date or date_from and date_to';
    if (date !== undefined) return isValidDate(date) ? [date] : 'is invalid';
    if (!isValidDate(from) || !isValidDate(to)) return 'date or date_from and date_to are required';
    if (to < from) return 'date_to must not be before date_from';
    // Inclusive of both ends, as channels write ranges.
    const all = eachDate(from, addDays(to, 1));
    if (Array.isArray(days) && days.length > 0) {
      return all.filter((d) => days.includes(WEEKDAYS[dayOfWeek(d)]));
    }
    return all;
  }

  /** Applies availability changes; returns the properties touched and the changes refused. */
  applyAvailability(values: Record<string, unknown>[]): {
    properties: Set<string>;
    warnings: UpdateWarning[];
  } {
    const touched = new Set<string>();
    const warnings: UpdateWarning[] = [];
    const changed = new Map<string, Set<string>>();
    for (const change of values) {
      const problems: Record<string, string[]> = {};
      const roomType = this.roomTypes.get(String(change.room_type_id));
      if (!this.properties.has(String(change.property_id)))
        problems.property_id = ['does not exist'];
      if (!roomType || roomType.propertyId !== change.property_id)
        problems.room_type_id = ['does not exist'];
      const dates = this.datesOf(change);
      if (typeof dates === 'string') problems.date = [dates];
      const value = change.availability;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        problems.availability = ['must be greater than or equal to 0'];
      }
      if (Object.keys(problems).length > 0) {
        warnings.push({ ...change, warning: problems });
        continue;
      }
      const days = this.availability.get(roomType!.id)!;
      for (const d of dates as string[]) {
        days.set(d, value as number);
        if (!changed.has(roomType!.id)) changed.set(roomType!.id, new Set());
        changed.get(roomType!.id)!.add(d);
      }
      touched.add(roomType!.propertyId);
    }
    for (const [roomTypeId, dates] of changed) this.distribute(roomTypeId, [...dates]);
    return { properties: touched, warnings };
  }

  applyRestrictions(values: Record<string, unknown>[]): {
    properties: Set<string>;
    warnings: UpdateWarning[];
  } {
    const touched = new Set<string>();
    const warnings: UpdateWarning[] = [];
    for (const change of values) {
      const problems: Record<string, string[]> = {};
      const plan = this.ratePlans.get(String(change.rate_plan_id));
      if (!this.properties.has(String(change.property_id)))
        problems.property_id = ['does not exist'];
      if (!plan || plan.propertyId !== change.property_id)
        problems.rate_plan_id = ['does not exist'];
      const dates = this.datesOf(change);
      if (typeof dates === 'string') problems.date = [dates];
      else if (plan && dates.some((d) => d < this.today(plan.propertyId)))
        problems.date = ['past dates are not allowed'];

      const patch: Partial<RestrictionState> = {};
      if (change.rate !== undefined) {
        const rate =
          typeof change.rate === 'number' && Number.isInteger(change.rate)
            ? change.rate
            : typeof change.rate === 'string'
              ? decimalToMinor(change.rate, plan?.currency ?? 'USD')
              : null;
        if (rate === null) problems.rate = ['is invalid'];
        else if (rate <= 0) problems.rate = ['must be greater than 0'];
        else patch.rate = rate;
      }
      for (const [field, key] of [
        ['min_stay_arrival', 'minStayArrival'],
        ['min_stay_through', 'minStayThrough'],
      ] as const) {
        const v = change[field];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
          problems[field] = ['must be greater than or equal to 1'];
        else patch[key] = v;
      }
      if (change.max_stay !== undefined) {
        const v = change.max_stay;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
          problems.max_stay = ['must be greater than or equal to 0'];
        else patch.maxStay = v;
      }
      for (const [field, key] of [
        ['closed_to_arrival', 'closedToArrival'],
        ['closed_to_departure', 'closedToDeparture'],
        ['stop_sell', 'stopSell'],
      ] as const) {
        const v = change[field];
        if (v === undefined) continue;
        if (v === true || v === 1) patch[key] = true;
        else if (v === false || v === 0) patch[key] = false;
        else problems[field] = ['is invalid'];
      }
      if (Object.keys(problems).length === 0 && Object.keys(patch).length === 0) {
        problems.base = ['at least one restriction should be present'];
      }
      if (Object.keys(problems).length > 0) {
        warnings.push({ ...change, warning: problems });
        continue;
      }
      const days = this.restrictions.get(plan!.id)!;
      for (const d of dates as string[])
        days.set(d, { ...this.restrictionOn(plan!.id, d), ...patch });
      touched.add(plan!.propertyId);
    }
    return { properties: touched, warnings };
  }

  /** Copies the inventory table's values for the given dates to every connected channel, after the distribution delay. */
  distribute(roomTypeId: string, dates: string[]): void {
    const roomType = this.roomTypes.get(roomTypeId);
    if (!roomType) return;
    const apply = (): void => {
      for (const channel of this.channelsOf(roomType.propertyId)) {
        if (!channel.active) continue;
        if (!channel.view.has(roomTypeId)) channel.view.set(roomTypeId, new Map());
        const view = channel.view.get(roomTypeId)!;
        for (const d of dates) view.set(d, Math.max(0, this.availabilityOn(roomTypeId, d)));
        channel.lastUpdatedAt = new Date().toISOString();
      }
    };
    if (this.distributionDelayMs <= 0) {
      apply();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      apply();
    }, this.distributionDelayMs);
    this.timers.add(timer);
  }

  // -------------------------------------------------------------------------
  // Bookings made on a channel

  private nextReservationCode(): string {
    return String(this.reservationSeq++);
  }

  /** What a stay costs on a rate plan today, per night, in minor units. */
  priceStay(ratePlanId: string | null, checkIn: string, checkOut: string): Record<string, number> {
    const days: Record<string, number> = {};
    for (const d of eachDate(checkIn, checkOut)) {
      days[d] = ratePlanId ? this.restrictionOn(ratePlanId, d).rate : 0;
    }
    return days;
  }

  /** Why a guest could not book this on the channel, or null if they could. */
  whyNotBookable(
    channel: SimChannel,
    room: { roomTypeId: string; ratePlanId: string | null; checkIn: string; checkOut: string },
  ): string | null {
    const nights = eachDate(room.checkIn, room.checkOut);
    if (nights.length === 0) return 'The stay must be at least one night';
    const view = channel.view.get(room.roomTypeId);
    for (const d of nights) {
      if ((view?.get(d) ?? 0) < 1)
        return `${CHANNELS[channel.code].title} shows no room left on ${d}`;
    }
    if (!room.ratePlanId) return null;
    for (const d of nights) {
      const r = this.restrictionOn(room.ratePlanId, d);
      if (r.stopSell) return `Closed for sale on ${d}`;
      if (r.rate <= 0) return `No price on ${d}`;
      if (nights.length < r.minStayThrough)
        return `Minimum stay is ${r.minStayThrough} nights on ${d}`;
      if (r.maxStay > 0 && nights.length > r.maxStay)
        return `Maximum stay is ${r.maxStay} nights on ${d}`;
    }
    const arrival = this.restrictionOn(room.ratePlanId, room.checkIn);
    if (arrival.closedToArrival) return `Closed to arrival on ${room.checkIn}`;
    if (nights.length < arrival.minStayArrival)
      return `Minimum stay for arrival on ${room.checkIn} is ${arrival.minStayArrival} nights`;
    if (this.restrictionOn(room.ratePlanId, room.checkOut).closedToDeparture)
      return `Closed to departure on ${room.checkOut}`;
    return null;
  }

  createBooking(input: {
    propertyId: string;
    channel: ChannelCode;
    rooms: {
      roomTypeId: string | null;
      ratePlanId: string | null;
      checkIn: string;
      checkOut: string;
      adults?: number;
      children?: number;
      guestName?: string | null;
    }[];
    customer?: Partial<SimCustomer>;
    notes?: string | null;
    arrivalHour?: string | null;
    paymentCollect?: 'property' | 'ota' | null;
    /** Sell even though the channel shows nothing left: two channels taking the last room at once. */
    force?: boolean;
    /** Set the time the channel reports for the booking (to stage out-of-order deliveries). */
    insertedAt?: string;
    /** Do not announce it by webhook. */
    silent?: boolean;
  }): SimBooking {
    const property = this.properties.get(input.propertyId);
    if (!property) throw new SimError(404, 'Property not found');
    const channel = this.channelsOf(input.propertyId).find((c) => c.code === input.channel);
    if (!channel || !channel.active)
      throw new SimError(
        409,
        `${CHANNELS[input.channel].title} is not connected for this property`,
      );
    if (input.rooms.length === 0) throw new SimError(400, 'A booking needs at least one room');
    for (const room of input.rooms) {
      if (
        !isValidDate(room.checkIn) ||
        !isValidDate(room.checkOut) ||
        room.checkOut <= room.checkIn
      ) {
        throw new SimError(400, 'A room needs a check-out after its check-in');
      }
      if (room.roomTypeId && !input.force) {
        const reason = this.whyNotBookable(channel, { ...room, roomTypeId: room.roomTypeId });
        if (reason) throw new SimError(409, reason);
      }
    }
    const now = input.insertedAt ?? new Date().toISOString();
    const booking: SimBooking = {
      id: randomUUID(),
      propertyId: input.propertyId,
      channel: input.channel,
      otaReservationCode: this.nextReservationCode(),
      status: 'new',
      rooms: input.rooms.map((room) => ({
        bookingRoomId: randomUUID(),
        roomTypeId: room.roomTypeId,
        ratePlanId: room.ratePlanId,
        checkIn: room.checkIn,
        checkOut: room.checkOut,
        adults: room.adults ?? 2,
        children: room.children ?? 0,
        days: this.priceStay(room.ratePlanId, room.checkIn, room.checkOut),
        guestName: room.guestName ?? null,
        isCancelled: false,
      })),
      customer: {
        name: input.customer?.name ?? 'Test',
        surname: input.customer?.surname ?? 'Guest',
        mail:
          input.customer?.mail ??
          `guest.${this.reservationSeq}@guest.${input.channel.toLowerCase()}.example`,
        phone: input.customer?.phone ?? null,
        country: input.customer?.country ?? 'IN',
        language: input.customer?.language ?? 'en',
        city: input.customer?.city ?? null,
        address: input.customer?.address ?? null,
        zip: input.customer?.zip ?? null,
      },
      notes: input.notes ?? null,
      arrivalHour: input.arrivalHour ?? null,
      paymentCollect: input.paymentCollect ?? (input.channel === 'ABB' ? 'ota' : 'property'),
      revisionIds: [],
      createdAt: now,
    };
    this.bookings.set(booking.id, booking);

    // The channel manager lowers availability for a new booking by itself, and tells the other channels.
    for (const room of booking.rooms) {
      if (!room.roomTypeId) continue;
      const days = this.availability.get(room.roomTypeId);
      if (!days) continue;
      const nights = eachDate(room.checkIn, room.checkOut);
      for (const d of nights) days.set(d, this.availabilityOn(room.roomTypeId, d) - 1);
      // The selling channel knows at once; the others after the usual delay.
      const view = channel.view.get(room.roomTypeId);
      if (view) for (const d of nights) view.set(d, Math.max(0, (view.get(d) ?? 0) - 1));
      this.distribute(room.roomTypeId, nights);
    }
    this.addRevision(booking, 'new', now, input.silent);
    return booking;
  }

  modifyBooking(
    bookingId: string,
    change: {
      rooms?: {
        bookingRoomId?: string;
        roomTypeId?: string | null;
        ratePlanId?: string | null;
        checkIn?: string;
        checkOut?: string;
        adults?: number;
        children?: number;
        remove?: boolean;
      }[];
      addRooms?: {
        roomTypeId: string | null;
        ratePlanId: string | null;
        checkIn: string;
        checkOut: string;
        adults?: number;
        children?: number;
      }[];
      customer?: Partial<SimCustomer>;
      notes?: string | null;
      insertedAt?: string;
      silent?: boolean;
    },
  ): SimBooking {
    const booking = this.bookings.get(bookingId);
    if (!booking) throw new SimError(404, 'Booking not found');
    if (booking.status === 'cancelled') throw new SimError(409, 'The booking is cancelled');
    for (const patch of change.rooms ?? []) {
      const room = patch.bookingRoomId
        ? booking.rooms.find((r) => r.bookingRoomId === patch.bookingRoomId)
        : booking.rooms.find((r) => !r.isCancelled);
      if (!room) throw new SimError(404, 'Room not found on the booking');
      if (patch.remove) {
        room.isCancelled = true;
        continue;
      }
      if (patch.roomTypeId !== undefined) room.roomTypeId = patch.roomTypeId;
      if (patch.ratePlanId !== undefined) room.ratePlanId = patch.ratePlanId;
      if (patch.checkIn) room.checkIn = patch.checkIn;
      if (patch.checkOut) room.checkOut = patch.checkOut;
      if (patch.adults !== undefined) room.adults = patch.adults;
      if (patch.children !== undefined) room.children = patch.children;
      if (room.checkOut <= room.checkIn)
        throw new SimError(400, 'A room needs a check-out after its check-in');
      room.days = this.priceStay(room.ratePlanId, room.checkIn, room.checkOut);
    }
    for (const room of change.addRooms ?? []) {
      booking.rooms.push({
        bookingRoomId: randomUUID(),
        roomTypeId: room.roomTypeId,
        ratePlanId: room.ratePlanId,
        checkIn: room.checkIn,
        checkOut: room.checkOut,
        adults: room.adults ?? 2,
        children: room.children ?? 0,
        days: this.priceStay(room.ratePlanId, room.checkIn, room.checkOut),
        guestName: null,
        isCancelled: false,
      });
    }
    if (change.customer) booking.customer = { ...booking.customer, ...change.customer };
    if (change.notes !== undefined) booking.notes = change.notes;
    booking.status = 'modified';
    // Availability is deliberately left alone: for changes the channel manager waits for the PMS to say what is free.
    this.addRevision(
      booking,
      'modified',
      change.insertedAt ?? new Date().toISOString(),
      change.silent,
    );
    return booking;
  }

  cancelBooking(
    bookingId: string,
    options: { insertedAt?: string; silent?: boolean } = {},
  ): SimBooking {
    const booking = this.bookings.get(bookingId);
    if (!booking) throw new SimError(404, 'Booking not found');
    if (booking.status === 'cancelled') return booking;
    booking.status = 'cancelled';
    // As with changes, the rooms come back on sale only when the PMS says so.
    this.addRevision(
      booking,
      'cancelled',
      options.insertedAt ?? new Date().toISOString(),
      options.silent,
    );
    return booking;
  }

  private addRevision(
    booking: SimBooking,
    status: SimRevision['status'],
    insertedAt: string,
    silent = false,
  ): SimRevision {
    const revision: SimRevision = {
      id: randomUUID(),
      bookingId: booking.id,
      propertyId: booking.propertyId,
      status,
      insertedAt,
      attributes: {},
      acknowledged: false,
      acknowledgedAt: null,
      nonAckedWarned: false,
    };
    revision.attributes = this.revisionAttributes(booking, revision);
    this.revisions.set(revision.id, revision);
    booking.revisionIds.push(revision.id);
    if (!silent) {
      this.onEvent('booking', booking.propertyId, {
        booking_id: booking.id,
        property_id: booking.propertyId,
        revision_id: revision.id,
      });
    }
    return revision;
  }

  /** The revision in Channex's wire format. */
  private revisionAttributes(booking: SimBooking, revision: SimRevision): Record<string, unknown> {
    const property = this.properties.get(booking.propertyId)!;
    const currency = property.currency;
    const channel = CHANNELS[booking.channel];
    const live = booking.rooms.filter((r) => !r.isCancelled);
    const roomTotal = (room: SimBookingRoom): number =>
      Object.values(room.days).reduce((sum, v) => sum + v, 0);
    const total = live.reduce((sum, r) => sum + roomTotal(r), 0);
    const dates = (live.length > 0 ? live : booking.rooms)
      .flatMap((r) => [r.checkIn, r.checkOut])
      .sort();
    const occupancy = (rooms: SimBookingRoom[]) => ({
      adults: rooms.reduce((sum, r) => sum + r.adults, 0),
      children: rooms.reduce((sum, r) => sum + r.children, 0),
      infants: 0,
    });
    return {
      id: revision.id,
      booking_id: booking.id,
      property_id: booking.propertyId,
      channel_id:
        this.channelsOf(booking.propertyId).find((c) => c.code === booking.channel)?.id ?? null,
      unique_id: `${booking.channel}-${booking.otaReservationCode}`,
      system_id: `${booking.channel}${booking.otaReservationCode}${booking.revisionIds.length}`,
      ota_reservation_code: booking.otaReservationCode,
      ota_name: channel.otaName,
      secondary_ota: null,
      status: revision.status,
      acknowledge_status: 'pending',
      is_crs_revision: false,
      agent: null,
      deposits: [],
      meta: {},
      rooms: booking.rooms.map((room) => ({
        booking_room_id: room.bookingRoomId,
        room_type_id: room.roomTypeId,
        rate_plan_id: room.ratePlanId,
        checkin_date: room.checkIn,
        checkout_date: room.checkOut,
        amount: minorToDecimal(roomTotal(room), currency),
        days: Object.fromEntries(
          Object.entries(room.days).map(([d, v]) => [d, minorToDecimal(v, currency)]),
        ),
        occupancy: { adults: room.adults, children: room.children, infants: 0, ages: null },
        guests: room.guestName
          ? [
              {
                name: room.guestName.split(' ')[0] ?? room.guestName,
                surname: room.guestName.split(' ').slice(1).join(' '),
              },
            ]
          : [{ name: booking.customer.name, surname: booking.customer.surname }],
        is_cancelled: room.isCancelled,
        ota_unique_id: null,
        ota_commission: null,
        services: [],
        taxes: [],
        meta: {},
      })),
      services: [],
      guarantee:
        booking.paymentCollect === 'ota'
          ? null
          : {
              card_number: '411111******1111',
              card_type: 'VI',
              cardholder_name: `${booking.customer.name} ${booking.customer.surname}`.toUpperCase(),
              cvv: '***',
              expiration_date: '12/2030',
              is_virtual: false,
            },
      customer: { ...booking.customer, company: null, meta: {} },
      occupancy: occupancy(live),
      arrival_date: dates[0] ?? null,
      departure_date: dates[dates.length - 1] ?? null,
      arrival_hour: booking.arrivalHour,
      amount: minorToDecimal(total, currency),
      currency,
      notes: booking.notes,
      payment_collect: booking.paymentCollect,
      payment_type: booking.paymentCollect === 'ota' ? 'bank_transfer' : 'credit_card',
      ota_commission: minorToDecimal(
        Math.round((total * channel.commissionPercent) / 100),
        currency,
      ),
      raw_message: `<${channel.otaName} reservation ${booking.otaReservationCode}>`,
      inserted_at: revision.insertedAt.replace(/Z$/, ''),
    };
  }

  /** A revision as the API returns it: once acknowledged, guest contact details are withheld. */
  revisionForApi(revision: SimRevision): Record<string, unknown> {
    const attributes = structuredClone(revision.attributes);
    attributes.acknowledge_status = revision.acknowledged ? 'acknowledged' : 'pending';
    if (revision.acknowledged) {
      const customer = attributes.customer as Record<string, unknown>;
      for (const field of ['mail', 'phone', 'address', 'city', 'state', 'zip', 'country'])
        customer[field] = null;
      attributes.notes = null;
      attributes.raw_message = '';
    }
    return attributes;
  }

  acknowledge(revisionId: string): boolean {
    const revision = this.revisions.get(revisionId);
    if (!revision) return false;
    if (!revision.acknowledged) {
      revision.acknowledged = true;
      revision.acknowledgedAt = new Date().toISOString();
    }
    return true;
  }

  /** Revisions the PMS has not acknowledged, oldest first. */
  feed(propertyId?: string): SimRevision[] {
    return [...this.revisions.values()]
      .filter((r) => !r.acknowledged && (!propertyId || r.propertyId === propertyId))
      .sort((a, b) => a.insertedAt.localeCompare(b.insertedAt));
  }

  /** Announces revisions that have waited too long for an acknowledgement. Returns how many. */
  warnNonAcked(now = Date.now()): number {
    let warned = 0;
    for (const revision of this.revisions.values()) {
      if (revision.acknowledged || revision.nonAckedWarned) continue;
      if (now - new Date(revision.insertedAt).getTime() < this.nonAckedAfterMs) continue;
      revision.nonAckedWarned = true;
      warned++;
      const booking = this.bookings.get(revision.bookingId)!;
      this.onEvent('non_acked_booking', revision.propertyId, {
        booking_id: booking.id,
        booking_revision_id: revision.id,
        property_id: revision.propertyId,
        booking_unique_id: `${booking.channel}-${booking.otaReservationCode}`,
        customer_name: `${booking.customer.name} ${booking.customer.surname}`,
      });
    }
    return warned;
  }
}

export class SimError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
