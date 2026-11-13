import type { Env } from '@pms/config';
import type { ChannelAdapterKind, ConnectionConfig } from '@pms/db';
import type { DateRange, DateString } from '@pms/domain';

/**
 * The contract every route to the outside world implements: the aggregator
 * API, calendar feeds, the reservations mailbox. The sync engine only ever
 * talks to this interface, so a channel (or the aggregator itself) can be
 * replaced without touching the PMS.
 */
export interface ChannelAdapter {
  readonly capabilities: {
    /** Accepts pushed availability, rates and restrictions. */
    ari: boolean;
    /** How bookings arrive: pushed to us, fetched by us, or not at all. */
    bookings: 'webhook' | 'poll' | 'none';
    messaging: boolean;
  };
  /** Shortest pause between two pushes for one connection, to stay inside the channel's rate limits. */
  readonly minPushIntervalMs: number;
  /** How many days ahead the channel accepts values for. Absent means as far as the property plans. */
  readonly horizonDays?: number;
  /** How often to fetch bookings when nothing prompts it. Absent means every 15 minutes. */
  readonly pollIntervalMs?: number;

  /**
   * Sends current values. Never differences: sending the same batch twice, or
   * an older batch after a newer one has been superseded, must be harmless.
   * Throws `ChannelError` when the channel did not accept the request.
   */
  pushAri(batch: AriBatch): Promise<PushResult>;

  /**
   * Bookings not yet acknowledged, oldest first. `cursor` is the position
   * stored for the connection, for sources that page through history; sources
   * that return "everything unacknowledged" ignore it.
   */
  pullBookings?(cursor: string | null): Promise<BookingEvent[]>;

  /** Tells the channel a revision is safely stored, so it stops re-sending it. */
  ack?(revisionId: string): Promise<void>;

  /** One booking revision by id, for webhooks that announce an id rather than carry the booking. */
  fetchBooking?(revisionId: string): Promise<BookingEvent | null>;

  /**
   * Bookings that already exist at the channel and end on or after `from`, in
   * their latest state. Used once, when a connection is first switched on, to
   * bring in what was sold before the PMS was connected.
   */
  listBookings?(from: DateString): Promise<BookingEvent[]>;

  /**
   * Reads a stored message again, for sources whose reading can improve (a
   * parsed email). Used when staff ask for a message that could not be read
   * to be applied again.
   */
  reparse?(raw: Record<string, unknown>): Promise<BookingEvent | null>;

  /**
   * Sources that could not be read on the last pull although others could (one
   * calendar of several). Each is raised as its own alert and cleared when it
   * reads again.
   */
  problems?(): { key: string; message: string }[];

  /**
   * What the channel currently holds, for comparing against the PMS. Rates
   * come back in minor units of `currency`, the property's currency.
   */
  fetchAri?(range: DateRange, currency: string): Promise<RemoteAri>;

  /**
   * Writes to a guest in the booking site's own message box: in a thread
   * that exists, or on a booking that has no thread yet.
   */
  sendMessage?(
    target: { threadId?: string; bookingId?: string },
    text: string,
  ): Promise<{ messageId: string; threadId: string | null }>;

  /** One conversation with everything said in it, oldest first. Null when the channel no longer has it. */
  fetchThread?(threadId: string): Promise<ChannelThread | null>;

  /** Conversations with the most recent activity first, for catching up on what a webhook did not announce. */
  listThreads?(): Promise<ChannelThreadSummary[]>;
}

export interface ChannelThreadSummary {
  threadId: string;
  /** The channel's id of the booking the conversation is about, when it is about one. */
  bookingId: string | null;
  title: string | null;
  /** The booking site, as the channel names it. */
  provider: string | null;
  lastMessageAt: Date | null;
}

export interface ChannelMessage {
  id: string;
  sender: 'guest' | 'property' | 'system';
  text: string;
  /** Links to files sent with the message. */
  attachments: string[];
  at: Date;
}

export interface ChannelThread extends ChannelThreadSummary {
  messages: ChannelMessage[];
}

export interface AvailabilityUpdate {
  roomTypeId: string;
  externalRoomTypeId: string;
  dateFrom: DateString;
  /** Inclusive, unlike stay ranges inside the PMS: this is how channels express ranges. */
  dateTo: DateString;
  availability: number;
}

export interface RestrictionUpdate {
  ratePlanId: string;
  externalRatePlanId: string;
  dateFrom: DateString;
  /** Inclusive. */
  dateTo: DateString;
  /** Minor units of `currency`. */
  rate: number;
  currency: string;
  minStayArrival: number;
  minStayThrough: number;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
}

export interface AriBatch {
  availability: AvailabilityUpdate[];
  restrictions: RestrictionUpdate[];
  /** True when this batch restates the whole horizon rather than recent changes. */
  full: boolean;
}

export interface PushResult {
  /** Identifiers the channel returned for the update, for tracing it on their side. */
  references: string[];
  /** Individual values the channel refused while accepting the rest. */
  warnings: string[];
}

export interface RemoteAri {
  /** external room type id -> date -> rooms available */
  availability: Record<string, Record<DateString, number>>;
  /** external rate plan id -> date -> values */
  restrictions: Record<string, Record<DateString, RemoteRestriction>>;
}

export interface RemoteRestriction {
  rate?: number;
  minStayArrival?: number;
  minStayThrough?: number;
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

/** A booking, a change to one, or its cancellation, as a channel reported it. */
export interface BookingEvent {
  /** Unique per message. Receiving the same id again is a repeat delivery. */
  revisionId: string;
  /** Stable for the life of the booking across its revisions. */
  bookingId: string;
  /** When the channel produced this revision. Decides which of two revisions is newer. */
  revisionAt: Date;
  status: 'new' | 'modified' | 'cancelled';
  /** Short code of the selling channel, e.g. BDC, ABB. */
  channelCode: string | null;
  /** The channel's own confirmation number, as the guest knows it. */
  channelReservationCode: string | null;
  currency: string | null;
  /** Minor units. */
  totalAmount: number | null;
  commissionAmount: number | null;
  paymentCollect: 'property' | 'channel' | null;
  arrivalTime: string | null;
  notes: string | null;
  guest: BookingEventGuest;
  rooms: BookingEventRoom[];
  /** Set when the source could only partly describe the booking (calendar feeds, parsed email). */
  needsReview?: string;
  /**
   * Set when the source saw what is plainly a booking message but could not
   * make out what it says, or must not act on it (an email whose sender
   * cannot be verified). Nothing is recorded; staff are told, in these words.
   */
  unreadable?: string;
  /**
   * Set when this is not a guest booking but dates the channel shows as
   * closed (a calendar entry marked "not available"). It is recorded as a
   * date block on the unit rather than as a reservation.
   */
  block?: { reason: string };
  /** The message as received, stored untouched for diagnosis. */
  raw: Record<string, unknown>;
}

export interface BookingEventGuest {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  language: string | null;
  city?: string | null;
  addressLine1?: string | null;
  postalCode?: string | null;
  company?: string | null;
}

export interface BookingEventRoom {
  /** The channel's room type id, resolved through the connection's mappings. Null when the channel could not map the room. */
  externalRoomTypeId: string | null;
  externalRatePlanId: string | null;
  /**
   * The room as the source words it, for sources that give a name rather than
   * an id (an email). Used to find the room type by name when no mapping does.
   */
  externalRoomName?: string | null;
  /** For sources tied to one unit (a calendar feed): the PMS ids directly, bypassing mappings. */
  internal?: { roomTypeId: string; unitId?: string };
  checkIn: DateString;
  checkOut: DateString;
  adults: number;
  children: number;
  /** Price per night in minor units, by date. */
  nightlyRates: Record<DateString, number> | null;
  /** Room total in minor units, used when no nightly breakdown is given. */
  amount: number | null;
  guestName: string | null;
  /** The channel's id for this room within the booking, to match rooms across revisions. */
  externalRoomRef: string | null;
}

/** The form a booking event is stored in: everything but the raw message, with the time as text. */
export type StoredBookingEvent = Omit<BookingEvent, 'raw' | 'revisionAt'> & { revisionAt: string };

export function serializeBookingEvent(event: BookingEvent): StoredBookingEvent {
  const { raw: _raw, revisionAt, ...rest } = event;
  return { ...rest, revisionAt: revisionAt.toISOString() };
}

export function deserializeBookingEvent(
  stored: StoredBookingEvent,
  raw: Record<string, unknown>,
): BookingEvent {
  return { ...stored, revisionAt: new Date(stored.revisionAt), raw };
}

/** A failure talking to a channel, classified so the engine knows whether to retry. */
export class ChannelError extends Error {
  /** False for failures that will not fix themselves: bad credentials, an unknown property. */
  readonly retryable: boolean;
  /** How long the channel asked us to wait (rate limiting). */
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ChannelError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

export interface AdapterContext {
  connectionId: string;
  orgId: string;
  propertyId: string;
  config: ConnectionConfig;
  secrets: Record<string, string>;
  /**
   * The adapter's own notes between runs (feed snapshots, mailbox positions).
   * An adapter changes this object in place while pulling; the engine saves it
   * once the pulled bookings are stored, so a crash in between only means the
   * same bookings are read again, which is harmless. If the pull throws, the
   * notes are saved as they stand, so before throwing an adapter must not have
   * noted anything as seen that it did not return.
   */
  state: Record<string, unknown>;
  env: Env;
}

export type AdapterFactory = (context: AdapterContext) => ChannelAdapter;

/** Adapter kinds that accept pushed values; only their connections get work-list rows. */
export const ARI_ADAPTER_KINDS: readonly ChannelAdapterKind[] = ['channex'];

const factories = new Map<ChannelAdapterKind, AdapterFactory>();

export function registerAdapter(kind: ChannelAdapterKind, factory: AdapterFactory): void {
  factories.set(kind, factory);
}

export function hasAdapter(kind: ChannelAdapterKind): boolean {
  return factories.has(kind);
}

export function createAdapter(kind: ChannelAdapterKind, context: AdapterContext): ChannelAdapter {
  const factory = factories.get(kind);
  if (!factory) throw new Error(`No adapter is registered for "${kind}"`);
  return factory(context);
}
