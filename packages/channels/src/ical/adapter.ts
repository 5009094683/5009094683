import { createHash } from 'node:crypto';
import { todayIn, type DateString } from '@pms/domain';
import {
  ChannelError,
  type AdapterContext,
  type BookingEvent,
  type ChannelAdapter,
  type PushResult,
} from '../adapter';
import { safeFetch } from '../net';
import { parseCalendar, type CalendarEvent } from './calendar';

/** One listing's calendar: where to read the channel's bookings, and which unit it is. */
export interface IcalFeedConfig {
  id: string;
  unitId: string;
  /** The unit's room type, kept alongside so events can be placed without a lookup. */
  roomTypeId: string;
  /** The calendar address the channel gives out. Null for a calendar that is only offered, not read. */
  importUrl: string | null;
  /** What to call the channel on screen, e.g. "Airbnb". */
  label: string;
  /** Short code of the channel, when it is a known one. */
  channelCode: string | null;
  /**
   * What an entry in the channel's calendar is taken to be. `auto` reads the
   * entry's text: "Reserved" is a booking, "Not available" a closure.
   */
  treatAs: 'auto' | 'reservations' | 'blocks';
}

interface SeenEvent {
  start: DateString;
  end: DateString;
  kind: 'reservation' | 'block';
  /** Consecutive reads in which the entry was absent. */
  missing?: number;
}

export interface IcalFeedState {
  etag?: string;
  lastModified?: string;
  /** When the calendar was last read successfully. */
  fetchedAt?: string;
  /** Why the last read failed, if it did. */
  error?: string | null;
  failedSince?: string | null;
  events: Record<string, SeenEvent>;
}

export interface IcalState {
  feeds?: Record<string, IcalFeedState>;
}

/** Calendars are re-read this often. Channels refresh theirs every few minutes at best. */
const POLL_INTERVAL_MS = 5 * 60_000;
/**
 * An entry must be absent from this many reads in a row before it counts as
 * cancelled. Channels occasionally serve an empty or partial calendar; acting
 * on one read would cancel real bookings.
 */
const MISSING_READS_BEFORE_CANCEL = 2;

export function feedsOf(config: AdapterContext['config']): IcalFeedConfig[] {
  return Array.isArray(config.feeds) ? (config.feeds as IcalFeedConfig[]) : [];
}

/** Whether a calendar entry is a guest booking or dates merely closed. */
export function classify(
  event: CalendarEvent,
  feed: Pick<IcalFeedConfig, 'treatAs'>,
): 'reservation' | 'block' {
  if (feed.treatAs === 'reservations') return 'reservation';
  if (feed.treatAs === 'blocks') return 'block';
  const text = `${event.summary} ${event.description}`.toLowerCase();
  if (/reserv|booked|booking\b|guest|confirmation/.test(text)) return 'reservation';
  if (/not available|unavailable|blocked|closed|block\b|maintenance|owner/.test(text)) {
    return 'block';
  }
  // Unlabelled entries are treated as bookings: a record staff must check beats a silent closure.
  return 'reservation';
}

/** The channel's own booking reference, where the calendar gives one. */
export function referenceOf(event: CalendarEvent): string | null {
  const text = `${event.description}\n${event.summary}`;
  // Airbnb: "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMXXXXXXXX"
  const airbnb = /reservations\/details\/([A-Z0-9]{8,12})/i.exec(text);
  if (airbnb) return airbnb[1]!.toUpperCase();
  const labelled =
    /(?:reservation|booking|confirmation)\s*(?:id|code|number|no\.?|#)?\s*[:#]\s*([A-Z0-9-]{5,20})/i.exec(
      text,
    );
  return labelled ? labelled[1]! : null;
}

/** A guest name, where the calendar gives one ("Reserved - Maria Lopez"). */
export function guestOf(event: CalendarEvent): { firstName: string; lastName: string } {
  const match = /^(?:reserved|booked|booking|reservation)\s*[-:–]\s*(.+)$/i.exec(event.summary);
  const name = match?.[1]?.trim() ?? '';
  if (!name || /not available|blocked/i.test(name)) return { firstName: '', lastName: '' };
  const parts = name.split(/\s+/);
  return {
    firstName: parts.slice(0, -1).join(' ') || parts[0]!,
    lastName: parts.length > 1 ? parts[parts.length - 1]! : '',
  };
}

function fingerprint(...parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function toBookingEvent(
  feed: IcalFeedConfig,
  event: Pick<CalendarEvent, 'uid' | 'start' | 'end'> & Partial<CalendarEvent>,
  status: BookingEvent['status'],
  kind: 'reservation' | 'block',
  now: Date,
): BookingEvent {
  const summary = event.summary ?? '';
  return {
    // Unique per observation: the same entry can vanish and come back with the same dates,
    // and that second appearance must not be mistaken for a repeat of the first.
    revisionId: `${feed.id}:${fingerprint(event.uid)}:${status}:${now.getTime().toString(36)}`,
    bookingId: `${feed.id}:${event.uid}`,
    // A calendar says what is true now, not when it changed: the time it was read orders the changes.
    revisionAt: now,
    status,
    channelCode: feed.channelCode,
    channelReservationCode:
      event.summary !== undefined ? referenceOf(event as CalendarEvent) : null,
    currency: null,
    totalAmount: null,
    commissionAmount: null,
    paymentCollect: null,
    arrivalTime: null,
    notes: null,
    guest: {
      ...(event.summary !== undefined
        ? guestOf(event as CalendarEvent)
        : { firstName: '', lastName: '' }),
      email: null,
      phone: null,
      country: null,
      language: null,
    },
    rooms: [
      {
        externalRoomTypeId: null,
        externalRatePlanId: null,
        internal: { roomTypeId: feed.roomTypeId, unitId: feed.unitId },
        checkIn: event.start,
        checkOut: event.end,
        adults: 1,
        children: 0,
        nightlyRates: null,
        amount: null,
        guestName: null,
        externalRoomRef: event.uid,
      },
    ],
    ...(kind === 'block'
      ? {
          block: { reason: `${feed.label} calendar${summary ? `: ${summary}` : ''}`.slice(0, 200) },
        }
      : {
          needsReview: `Read from the ${feed.label} calendar, which gives dates only. Add the guest and the price from ${feed.label}.`,
        }),
    raw: {
      feedId: feed.id,
      uid: event.uid,
      start: event.start,
      end: event.end,
      summary,
      description: event.description ?? '',
    },
  };
}

/**
 * Calendar feeds: the route for a single-unit listing on a channel that is
 * not connected through the channel manager. Each read of the channel's
 * calendar is compared with the previous one; what appeared, moved or
 * vanished becomes a booking, a change or a cancellation.
 *
 * It is slow by nature (a channel re-reads our calendar on its own schedule,
 * hours apart) and carries dates only, which is why it is the fallback and
 * not the main route.
 */
export function icalAdapter(context: AdapterContext): ChannelAdapter {
  const state = context.state as IcalState;
  let problems: { key: string; message: string }[] = [];

  return {
    capabilities: { ari: false, bookings: 'poll', messaging: false },
    minPushIntervalMs: 0,
    pollIntervalMs: POLL_INTERVAL_MS,

    async pushAri(): Promise<PushResult> {
      // Nothing is pushed: channels fetch the exported calendar themselves.
      return { references: [], warnings: [] };
    },

    async pullBookings(): Promise<BookingEvent[]> {
      const feeds = feedsOf(context.config).filter((f) => f.importUrl);
      // Saved with the calendars; decides which stays are already over.
      const timezone =
        typeof context.config.timezone === 'string' ? context.config.timezone : 'UTC';
      const today = todayIn(timezone);
      const now = new Date();
      const out: BookingEvent[] = [];
      problems = [];
      state.feeds ??= {};
      // Forget calendars that are no longer configured.
      for (const id of Object.keys(state.feeds)) {
        if (!feeds.some((f) => f.id === id)) delete state.feeds[id];
      }
      let failures = 0;

      for (const feed of feeds) {
        const seen = (state.feeds[feed.id] ??= { events: {} });
        try {
          const response = await safeFetch(feed.importUrl!, {
            allowPrivate: !context.env.isProduction,
            headers: {
              ...(seen.etag ? { 'if-none-match': seen.etag } : {}),
              ...(seen.lastModified ? { 'if-modified-since': seen.lastModified } : {}),
            },
          });
          if (response.status === 304) {
            seen.fetchedAt = now.toISOString();
            seen.error = null;
            seen.failedSince = null;
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            throw new ChannelError(`${feed.label} answered ${response.status}`, {
              retryable: response.status >= 500 || response.status === 429,
              status: response.status,
            });
          }
          const calendar = parseCalendar(response.body, timezone);
          const current = new Map<string, CalendarEvent>();
          for (const event of calendar.events) {
            // Stays that are over are history, not something to act on.
            if (!event.cancelled && event.end > today) current.set(event.uid, event);
          }

          for (const [uid, event] of current) {
            const kind = classify(event, feed);
            const before = seen.events[uid];
            if (!before) {
              out.push(toBookingEvent(feed, event, 'new', kind, now));
            } else if (before.start !== event.start || before.end !== event.end) {
              out.push(toBookingEvent(feed, event, 'modified', before.kind, now));
            }
            seen.events[uid] = { start: event.start, end: event.end, kind: before?.kind ?? kind };
          }
          for (const [uid, before] of Object.entries(seen.events)) {
            if (current.has(uid)) continue;
            if (before.end <= today) {
              // It ended; channels drop past stays from their calendars.
              delete seen.events[uid];
              continue;
            }
            const missing = (before.missing ?? 0) + 1;
            if (missing < MISSING_READS_BEFORE_CANCEL) {
              before.missing = missing;
              continue;
            }
            out.push(
              toBookingEvent(
                feed,
                { uid, start: before.start, end: before.end },
                'cancelled',
                before.kind,
                now,
              ),
            );
            delete seen.events[uid];
          }
          seen.etag = response.headers.etag;
          seen.lastModified = response.headers['last-modified'];
          seen.fetchedAt = now.toISOString();
          seen.error = null;
          seen.failedSince = null;
        } catch (err) {
          failures++;
          const message = err instanceof Error ? err.message : String(err);
          seen.error = message;
          seen.failedSince ??= now.toISOString();
          problems.push({ key: feed.id, message: `${feed.label}: ${message}` });
        }
      }
      // Every calendar failed, so nothing was noted as seen and nothing is lost by saying so.
      if (feeds.length > 0 && failures === feeds.length) {
        throw new ChannelError(`No calendar could be read. ${problems[0]!.message}`, {
          retryable: true,
        });
      }
      return out;
    },

    problems: () => problems,
  };
}
