import { addDays, type DateRange, type DateString } from '@pms/domain';
import {
  ChannelError,
  type AdapterContext,
  type AriBatch,
  type BookingEvent,
  type ChannelAdapter,
  type ChannelThread,
  type ChannelThreadSummary,
  type PushResult,
  type RemoteAri,
} from '../adapter';
import {
  ChannexClient,
  type ChannexAvailabilityUpdate,
  type ChannexThreadResource,
} from './client';
import {
  bookingToEvent,
  DRIFT_RESTRICTION_KINDS,
  parseChannexTime,
  restrictionFromChannex,
  restrictionToChannex,
  revisionToEvent,
} from './mapping';

/** Channex holds values for 500 days ahead; a full sync covers exactly that. */
const HORIZON_DAYS = 500;
/** Longest span read back in one request when comparing values. */
const READ_CHUNK_DAYS = 90;

export function channexClientFor(
  context: Pick<AdapterContext, 'config' | 'secrets' | 'env'>,
): ChannexClient {
  const apiKey = context.secrets.apiKey ?? context.env.CHANNEX_API_KEY;
  if (!apiKey) {
    throw new ChannelError('No channel manager API key is set (CHANNEX_API_KEY)', {
      retryable: false,
    });
  }
  return new ChannexClient({
    baseUrl: (context.config.baseUrl as string | undefined) ?? context.env.CHANNEX_BASE_URL,
    apiKey,
  });
}

function chunks(range: DateRange, days: number): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let from = range.from; from < range.to; from = addDays(from, days)) {
    const end = addDays(from, days) < range.to ? addDays(from, days) : range.to;
    // Channex ranges include their last day.
    out.push({ from, to: addDays(end, -1) });
  }
  return out;
}

/**
 * The route to every channel Channex connects: Booking.com, Airbnb, Expedia,
 * Agoda, MakeMyTrip and the rest. Values are pushed to Channex, which
 * distributes them; bookings come back through its revision feed.
 */
export function channexAdapter(context: AdapterContext): ChannelAdapter {
  let client: ChannexClient | undefined;
  const api = (): ChannexClient => (client ??= channexClientFor(context));
  const property = (): string => {
    const id = context.config.externalPropertyId;
    if (!id) {
      throw new ChannelError('This connection has no channel manager property selected', {
        retryable: false,
      });
    }
    return id;
  };
  return {
    capabilities: { ari: true, bookings: 'webhook', messaging: true },
    // One push is at most one availability and one rate request, so this spacing keeps
    // a property inside Channex's limit of 10 a minute on each.
    minPushIntervalMs: context.env.CHANNEX_MIN_PUSH_INTERVAL_MS,
    horizonDays: HORIZON_DAYS,
    pollIntervalMs: 15 * 60_000,

    async pushAri(batch: AriBatch): Promise<PushResult> {
      const propertyId = property();
      const result: PushResult = { references: [], warnings: [] };

      // Availability first: closing a sold room matters more than a price.
      if (batch.availability.length > 0) {
        const values: ChannexAvailabilityUpdate[] = batch.availability.map((a) => ({
          property_id: propertyId,
          room_type_id: a.externalRoomTypeId,
          date_from: a.dateFrom,
          date_to: a.dateTo,
          availability: Math.max(0, a.availability),
        }));
        const ack = await api().updateAvailability(values);
        if (ack.taskIds.length === 0 && ack.warnings.length > 0) {
          throw new ChannelError(
            `The channel manager refused every availability value: ${ack.warnings[0]}`,
            {
              retryable: false,
            },
          );
        }
        result.references.push(...ack.taskIds);
        result.warnings.push(...ack.warnings);
      }

      if (batch.restrictions.length > 0) {
        const mapped = batch.restrictions.map((r) => restrictionToChannex(propertyId, r));
        const ack = await api().updateRestrictions(mapped.map((m) => m.value));
        if (ack.taskIds.length === 0 && ack.warnings.length > 0) {
          throw new ChannelError(
            `The channel manager refused every rate value: ${ack.warnings[0]}`,
            {
              retryable: false,
            },
          );
        }
        result.references.push(...ack.taskIds);
        result.warnings.push(
          ...ack.warnings,
          ...mapped.flatMap((m) => (m.warning ? [m.warning] : [])),
        );
      }
      return result;
    },

    async pullBookings(): Promise<BookingEvent[]> {
      const revisions = await api().revisionFeed(property());
      return revisions.map(revisionToEvent);
    },

    async ack(revisionId: string): Promise<void> {
      await api().acknowledgeRevision(revisionId);
    },

    async fetchBooking(revisionId: string): Promise<BookingEvent | null> {
      const revision = await api().getRevision(revisionId);
      return revision ? revisionToEvent(revision) : null;
    },

    async listBookings(from: DateString): Promise<BookingEvent[]> {
      const bookings = await api().listBookings(property(), from);
      return bookings.map(bookingToEvent);
    },

    async fetchAri(range: DateRange, currency: string): Promise<RemoteAri> {
      const propertyId = property();
      const remote: RemoteAri = { availability: {}, restrictions: {} };
      for (const chunk of chunks(range, READ_CHUNK_DAYS)) {
        const availability = await api().getAvailability(propertyId, chunk.from, chunk.to);
        for (const [roomTypeId, days] of Object.entries(availability)) {
          Object.assign((remote.availability[roomTypeId] ??= {}), days);
        }
        const restrictions = await api().getRestrictions(propertyId, chunk.from, chunk.to, [
          ...DRIFT_RESTRICTION_KINDS,
        ]);
        for (const [ratePlanId, days] of Object.entries(restrictions)) {
          const target = (remote.restrictions[ratePlanId] ??= {});
          for (const [date, values] of Object.entries(days)) {
            target[date] = restrictionFromChannex(values, currency);
          }
        }
      }
      return remote;
    },

    async sendMessage(target, text) {
      const sent = target.threadId
        ? await api().sendThreadMessage(target.threadId, text)
        : target.bookingId
          ? await api().sendBookingMessage(target.bookingId, text)
          : undefined;
      if (!sent) {
        throw new ChannelError('A message needs a conversation or a booking to go to', {
          retryable: false,
        });
      }
      return {
        messageId: sent.id,
        threadId: sent.relationships?.message_thread?.data?.id ?? target.threadId ?? null,
      };
    },

    async fetchThread(threadId: string): Promise<ChannelThread | null> {
      const thread = await api().getThread(threadId);
      if (!thread) return null;
      const messages = await api().threadMessages(threadId);
      return {
        ...threadSummary(thread),
        messages: messages
          .map((m) => ({
            id: m.id,
            sender:
              m.attributes.sender === 'guest'
                ? ('guest' as const)
                : m.attributes.sender === 'property'
                  ? ('property' as const)
                  : ('system' as const),
            text: m.attributes.message ?? '',
            attachments: (m.attributes.attachments ?? []).filter(
              (a): a is string => typeof a === 'string',
            ),
            at: parseChannexTime(m.attributes.inserted_at),
          }))
          .sort((a, b) => a.at.getTime() - b.at.getTime()),
      };
    },

    async listThreads(): Promise<ChannelThreadSummary[]> {
      return (await api().listThreads(property())).map(threadSummary);
    },
  };
}

function threadSummary(thread: ChannexThreadResource): ChannelThreadSummary {
  const last = thread.attributes.last_message_received_at ?? thread.attributes.updated_at;
  return {
    threadId: thread.id,
    bookingId: thread.relationships?.booking?.data?.id ?? null,
    title: thread.attributes.title ?? null,
    provider: thread.attributes.provider ?? null,
    lastMessageAt: last ? parseChannexTime(last) : null,
  };
}
