import type { ChannelAdapterKind } from '@pms/db';
import { addDays, type DateRange, type DateString } from '@pms/domain';
import {
  ChannelError,
  registerAdapter,
  type AdapterContext,
  type AriBatch,
  type BookingEvent,
  type ChannelAdapter,
  type ChannelThread,
  type PushResult,
  type RemoteAri,
  type RemoteRestriction,
} from './adapter';

/**
 * An in-memory channel for tests: remembers what was pushed to it, can be told
 * to fail, and holds a feed of bookings that stay until acknowledged.
 */
export class FakeChannel {
  /** external room type id -> date -> rooms */
  readonly availability = new Map<string, Map<DateString, number>>();
  /** external rate plan id -> date -> values */
  readonly restrictions = new Map<string, Map<DateString, RemoteRestriction>>();
  readonly pushes: AriBatch[] = [];
  readonly acked: string[] = [];
  /** Bookings waiting to be acknowledged, oldest first. */
  feed: BookingEvent[] = [];
  /** Errors thrown by the next pushes, one per push. */
  failPushes: Error[] = [];
  failPull: Error | null = null;
  failAck: Error | null = null;
  warnings: string[] = [];
  minPushIntervalMs = 0;
  capabilities: ChannelAdapter['capabilities'] = {
    ari: true,
    bookings: 'webhook',
    messaging: false,
  };
  /** Guest conversations in the channel's message box, by thread id. */
  readonly threads = new Map<string, ChannelThread>();
  /** What the property sent through the adapter. */
  readonly sentMessages: { threadId: string | null; bookingId: string | null; text: string }[] = [];
  failSend: Error | null = null;
  /** Runs inside every push, before it is recorded: lets a test act while a push is in flight. */
  onPush: ((batch: AriBatch) => Promise<void> | void) | null = null;
  pullCount = 0;

  availabilityOn(externalRoomTypeId: string, date: DateString): number | undefined {
    return this.availability.get(externalRoomTypeId)?.get(date);
  }

  restrictionOn(externalRatePlanId: string, date: DateString): RemoteRestriction | undefined {
    return this.restrictions.get(externalRatePlanId)?.get(date);
  }

  failNextPush(status = 503, options: { retryAfterMs?: number; retryable?: boolean } = {}): void {
    this.failPushes.push(
      new ChannelError(`The channel answered ${status}`, {
        status,
        retryable: options.retryable ?? (status === 429 || status >= 500),
        retryAfterMs: options.retryAfterMs,
      }),
    );
  }

  adapter(): ChannelAdapter {
    const capabilities = (): ChannelAdapter['capabilities'] => this.capabilities;
    const minPushIntervalMs = (): number => this.minPushIntervalMs;
    return {
      get capabilities() {
        return capabilities();
      },
      get minPushIntervalMs() {
        return minPushIntervalMs();
      },
      pushAri: async (batch: AriBatch): Promise<PushResult> => {
        if (this.onPush) await this.onPush(batch);
        const failure = this.failPushes.shift();
        if (failure) throw failure;
        this.pushes.push(structuredClone(batch));
        for (const update of batch.availability) {
          const days =
            this.availability.get(update.externalRoomTypeId) ?? new Map<DateString, number>();
          for (let d = update.dateFrom; d <= update.dateTo; d = addDays(d, 1))
            days.set(d, update.availability);
          this.availability.set(update.externalRoomTypeId, days);
        }
        for (const update of batch.restrictions) {
          const days =
            this.restrictions.get(update.externalRatePlanId) ??
            new Map<DateString, RemoteRestriction>();
          for (let d = update.dateFrom; d <= update.dateTo; d = addDays(d, 1)) {
            days.set(d, {
              rate: update.rate,
              minStayArrival: update.minStayArrival,
              minStayThrough: update.minStayThrough,
              maxStay: update.maxStay,
              closedToArrival: update.closedToArrival,
              closedToDeparture: update.closedToDeparture,
              stopSell: update.stopSell,
            });
          }
          this.restrictions.set(update.externalRatePlanId, days);
        }
        return { references: [`fake-${this.pushes.length}`], warnings: this.warnings };
      },
      pullBookings: async (): Promise<BookingEvent[]> => {
        this.pullCount++;
        if (this.failPull) throw this.failPull;
        return this.feed.map((e) => structuredClone(e));
      },
      ack: async (revisionId: string): Promise<void> => {
        if (this.failAck) throw this.failAck;
        this.acked.push(revisionId);
        this.feed = this.feed.filter((e) => e.revisionId !== revisionId);
      },
      fetchBooking: async (revisionId: string): Promise<BookingEvent | null> =>
        this.feed.find((e) => e.revisionId === revisionId) ?? null,
      fetchAri: async (range: DateRange): Promise<RemoteAri> => {
        const inRange = (date: DateString): boolean => date >= range.from && date < range.to;
        const availability: RemoteAri['availability'] = {};
        for (const [id, days] of this.availability) {
          availability[id] = Object.fromEntries([...days].filter(([d]) => inRange(d)));
        }
        const restrictions: RemoteAri['restrictions'] = {};
        for (const [id, days] of this.restrictions) {
          restrictions[id] = Object.fromEntries([...days].filter(([d]) => inRange(d)));
        }
        return { availability, restrictions };
      },
      sendMessage: async (target, text) => {
        if (this.failSend) throw this.failSend;
        this.sentMessages.push({
          threadId: target.threadId ?? null,
          bookingId: target.bookingId ?? null,
          text,
        });
        let thread = target.threadId ? this.threads.get(target.threadId) : undefined;
        if (!thread && target.bookingId) {
          thread =
            [...this.threads.values()].find((t) => t.bookingId === target.bookingId) ??
            this.openThread(target.bookingId);
        }
        if (!thread)
          throw new ChannelError('No such conversation', { retryable: false, status: 404 });
        const id = `fake-msg-${this.sentMessages.length}`;
        thread.messages.push({ id, sender: 'property', text, attachments: [], at: new Date() });
        return { messageId: id, threadId: thread.threadId };
      },
      fetchThread: async (threadId: string): Promise<ChannelThread | null> => {
        const thread = this.threads.get(threadId);
        return thread ? structuredClone(thread) : null;
      },
      listThreads: async () =>
        [...this.threads.values()].map((t) => ({
          threadId: t.threadId,
          bookingId: t.bookingId,
          title: t.title,
          provider: t.provider,
          lastMessageAt: t.messages[t.messages.length - 1]?.at ?? null,
        })),
    };
  }

  /** Starts a conversation about a booking, as a guest opening the booking site's message box does. */
  openThread(bookingId: string | null, title = 'Asha Rao'): ChannelThread {
    const thread: ChannelThread = {
      threadId: `thread-${this.threads.size + 1}-${bookingId ?? 'enquiry'}`,
      bookingId,
      title,
      provider: 'BookingCom',
      lastMessageAt: null,
      messages: [],
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  /** The guest writes in a conversation. */
  guestWrites(threadId: string, text: string, at: Date = new Date()): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`No such thread: ${threadId}`);
    const id = `fake-guest-${threadId}-${thread.messages.length + 1}`;
    thread.messages.push({ id, sender: 'guest', text, attachments: [], at });
    thread.lastMessageAt = at;
    return id;
  }
}

const channels = new Map<string, FakeChannel>();
let fallback: FakeChannel | null = null;

/**
 * Routes every connection of the given adapter kind to in-memory channels.
 * Returns the channel used by connections that were not given their own.
 */
export function useFakeChannels(kind: ChannelAdapterKind = 'channex'): FakeChannel {
  channels.clear();
  fallback = new FakeChannel();
  registerAdapter(kind, (context: AdapterContext) =>
    (channels.get(context.connectionId) ?? fallback!).adapter(),
  );
  return fallback;
}

/** Gives one connection its own in-memory channel. */
export function fakeChannelFor(connectionId: string): FakeChannel {
  let channel = channels.get(connectionId);
  if (!channel) {
    channel = new FakeChannel();
    channels.set(connectionId, channel);
  }
  return channel;
}

let counter = 0;

/** A booking as a channel would report it, with sensible defaults for tests. */
export function bookingEvent(
  overrides: Partial<Omit<BookingEvent, 'rooms' | 'guest'>> & {
    rooms: Partial<BookingEvent['rooms'][number]>[];
    guest?: Partial<BookingEvent['guest']>;
  },
): BookingEvent {
  counter++;
  const { rooms, guest, ...rest } = overrides;
  return {
    revisionId: `rev-${counter}`,
    bookingId: `booking-${counter}`,
    revisionAt: new Date(),
    status: 'new',
    channelCode: 'BDC',
    channelReservationCode: `BDC-${1000 + counter}`,
    currency: 'INR',
    totalAmount: null,
    commissionAmount: null,
    paymentCollect: 'property',
    arrivalTime: null,
    notes: null,
    raw: { fake: true },
    ...rest,
    guest: {
      firstName: 'Asha',
      lastName: 'Rao',
      email: `asha.rao.${counter}@guest.example`,
      phone: null,
      country: 'IN',
      language: 'en',
      ...guest,
    },
    rooms: rooms.map((room) => ({
      externalRoomTypeId: null,
      externalRatePlanId: null,
      checkIn: '2027-01-10',
      checkOut: '2027-01-12',
      adults: 2,
      children: 0,
      nightlyRates: null,
      amount: null,
      guestName: null,
      externalRoomRef: null,
      ...room,
    })),
  };
}
