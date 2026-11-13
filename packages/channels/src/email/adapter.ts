import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import {
  ChannelError,
  type AdapterContext,
  type BookingEvent,
  type BookingEventRoom,
  type ChannelAdapter,
  type PushResult,
} from '../adapter';
import {
  htmlToText,
  normaliseText,
  readReservationEmail,
  senderCheck,
  type EmailMessage,
  type ParsedReservationEmail,
  type ReadOptions,
} from './parse';

export interface MailboxSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  folder: string;
  secure: boolean;
}

export interface EmailConnectionConfig {
  mailbox?: { host?: string; port?: number; user?: string; folder?: string; secure?: boolean };
  /** Only mail addressed to this address is handled: for one mailbox shared by several properties. */
  recipient?: string;
  /**
   * Apply changes and cancellations even when the mail server could not
   * verify who sent them. Off by default: such an email could be forged.
   */
  trustUnverifiedSenders?: boolean;
  /** Saved with the connection from the property: how 03/04 is read, and the assumed currency. */
  dayFirst?: boolean;
  currency?: string;
}

interface EmailState {
  uidValidity?: string;
  lastUid?: number;
}

export interface RawEmail {
  uid: number;
  source: Buffer;
}

/** How mail is fetched. The real one speaks IMAP; tests supply their own. */
export interface MailboxReader {
  /**
   * Messages after the given position, oldest first. With no position (first
   * run, or the mailbox was rebuilt) it returns only recent mail, so years of
   * history are not replayed.
   */
  fetchAfter(
    position: { uidValidity: string | null; lastUid: number },
    limit: number,
  ): Promise<{ uidValidity: string; messages: RawEmail[] }>;
}

const FETCH_LIMIT = 50;
/** On a first run, how far back to look. */
const FIRST_RUN_LOOKBACK_MS = 24 * 3600_000;

/** Reads a mailbox over IMAP, without changing it: nothing is marked read, moved or deleted. */
export function imapMailbox(settings: MailboxSettings): MailboxReader {
  return {
    async fetchAfter(position, limit) {
      const client = new ImapFlow({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: { user: settings.user, pass: settings.password },
        logger: false,
        socketTimeout: 30_000,
      });
      try {
        await client.connect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const refused = /auth|credential|login|password/i.test(message);
        throw new ChannelError(
          refused
            ? `The mailbox refused the sign-in for ${settings.user}`
            : `The mailbox at ${settings.host} could not be reached: ${message}`,
          { retryable: !refused, cause: err },
        );
      }
      try {
        const lock = await client.getMailboxLock(settings.folder, { readOnly: true });
        try {
          const mailbox = client.mailbox;
          const uidValidity = mailbox ? String(mailbox.uidValidity) : '';
          const samePlace = position.uidValidity === uidValidity && position.lastUid > 0;
          let uids: number[];
          if (samePlace) {
            const found = await client.search({ uid: `${position.lastUid + 1}:*` }, { uid: true });
            uids = (found || []).filter((uid) => uid > position.lastUid);
          } else {
            const found = await client.search(
              { since: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS) },
              { uid: true },
            );
            uids = found || [];
          }
          uids = uids.sort((a, b) => a - b).slice(0, limit);
          const messages: RawEmail[] = [];
          if (uids.length > 0) {
            for await (const message of client.fetch(
              uids,
              { uid: true, source: true },
              { uid: true },
            )) {
              if (message.source) messages.push({ uid: message.uid, source: message.source });
            }
          }
          messages.sort((a, b) => a.uid - b.uid);
          return { uidValidity, messages };
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
    },
  };
}

let mailboxFactory: (settings: MailboxSettings) => MailboxReader = imapMailbox;

/** Test hook: replace how mailboxes are read. */
export function setMailboxFactory(
  factory: ((settings: MailboxSettings) => MailboxReader) | null,
): void {
  mailboxFactory = factory ?? imapMailbox;
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((entry) => entry.value.map((a) => (a.address ?? '').toLowerCase()))
    .filter(Boolean);
}

/** Turns a raw message into the few things the reader needs. */
export async function parseMime(source: Buffer | string): Promise<EmailMessage> {
  // The library's own HTML-to-text runs table cells together; ours keeps them apart.
  const mail = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipHtmlToText: true,
  });
  const from = mail.from?.value[0];
  const header = mail.headers.get('authentication-results');
  const results = (Array.isArray(header) ? header : header ? [header] : []).map((h) => String(h));
  const plain = mail.text?.trim() ? normaliseText(mail.text) : '';
  const fromHtml = mail.html ? htmlToText(mail.html) : '';
  const fromAddress = (from?.address ?? '').toLowerCase();
  return {
    // A message without an id is identified by its content, so a repeat is still recognised.
    messageId:
      mail.messageId?.replace(/^<|>$/g, '') ||
      createHash('sha256')
        .update(typeof source === 'string' ? source : source)
        .digest('hex')
        .slice(0, 32),
    from: fromAddress,
    fromName: from?.name ?? '',
    to: [...addresses(mail.to), ...addresses(mail.cc)],
    subject: mail.subject ?? '',
    date: mail.date ?? new Date(),
    text: plain || fromHtml,
    ...(plain && fromHtml ? { alternativeText: fromHtml } : {}),
    authentication: senderCheck(results, fromAddress),
    inReplyTo: mail.inReplyTo?.replace(/^<|>$/g, '') ?? null,
    references: (Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? mail.references.split(/\s+/)
        : []
    )
      .map((id) => id.replace(/^<|>$/g, ''))
      .filter(Boolean),
    attachments: mail.attachments.map((a) => ({
      name: a.filename ?? 'attachment',
      contentType: a.contentType ?? null,
      size: a.size ?? null,
    })),
  };
}

/** Room names are compared without regard to case or spacing. */
export function normaliseRoomName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function splitName(name: string | null): { firstName: string; lastName: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
}

function rawOf(message: EmailMessage): Record<string, unknown> {
  return {
    messageId: message.messageId,
    from: message.from,
    fromName: message.fromName,
    to: message.to,
    subject: message.subject,
    date: message.date.toISOString(),
    authentication: message.authentication,
    // Enough to read it again later; not the whole of a long thread.
    text: message.text.slice(0, 20_000),
    ...(message.alternativeText
      ? { alternativeText: message.alternativeText.slice(0, 20_000) }
      : {}),
  };
}

function base(message: EmailMessage, channelCode: string | null, reference: string | null) {
  return {
    revisionId: `email:${message.messageId}`,
    bookingId: `${channelCode ?? 'EMAIL'}:${reference ?? message.messageId}`,
    revisionAt: Number.isNaN(message.date.getTime()) ? new Date() : message.date,
    channelCode,
    channelReservationCode: reference,
    commissionAmount: null,
    paymentCollect: null,
    arrivalTime: null,
    raw: rawOf(message),
  } satisfies Partial<BookingEvent>;
}

const NO_GUEST = {
  firstName: '',
  lastName: '',
  email: null,
  phone: null,
  country: null,
  language: null,
};

function unreadable(
  message: EmailMessage,
  channelCode: string | null,
  channelName: string,
  reference: string | null,
  status: BookingEvent['status'],
  reason: string,
): BookingEvent {
  return {
    ...base(message, channelCode, reference),
    status,
    currency: null,
    totalAmount: null,
    notes: null,
    guest: NO_GUEST,
    rooms: [],
    unreadable: `An email from ${channelName} ("${message.subject.slice(0, 120)}") ${reason}`,
  };
}

function toEvent(
  message: EmailMessage,
  parsed: ParsedReservationEmail,
  trustUnverified: boolean,
): BookingEvent {
  const who = parsed.channelName;
  if (message.authentication === 'fail') {
    return unreadable(
      message,
      parsed.channelCode,
      who,
      parsed.reference,
      parsed.status,
      `failed the mail server's checks on who sent it, so it may be forged. Nothing was done with it. Look up booking ${parsed.reference} on ${who}.`,
    );
  }
  const verified = message.authentication === 'pass' || trustUnverified;
  if (!verified && parsed.status !== 'new') {
    return unreadable(
      message,
      parsed.channelCode,
      who,
      parsed.reference,
      parsed.status,
      `asks to ${parsed.status === 'cancelled' ? 'cancel' : 'change'} booking ${parsed.reference}, but the mail server could not confirm who sent it, so it was not applied. Check the booking on ${who} and make the change by hand.`,
    );
  }

  const count = Math.max(1, Math.min(parsed.rooms, 20));
  const perRoom = (value: number | null): number | null =>
    value === null ? null : Math.max(0, Math.floor(value / count));
  const rooms: BookingEventRoom[] =
    parsed.checkIn && parsed.checkOut
      ? Array.from({ length: count }, (_, index) => ({
          externalRoomTypeId: parsed.roomName ? normaliseRoomName(parsed.roomName) : null,
          externalRoomName: parsed.roomName,
          externalRatePlanId: null,
          checkIn: parsed.checkIn!,
          checkOut: parsed.checkOut!,
          adults: Math.max(1, Math.ceil((parsed.adults ?? count) / count)),
          children: index === 0 ? (parsed.children ?? 0) : 0,
          nightlyRates: null,
          // Any remainder from splitting the total goes on the first room.
          amount:
            parsed.totalAmount === null
              ? null
              : perRoom(parsed.totalAmount)! + (index === 0 ? parsed.totalAmount % count : 0),
          guestName: null,
          externalRoomRef: count > 1 ? String(index + 1) : null,
        }))
      : [];
  return {
    ...base(message, parsed.channelCode, parsed.reference),
    status: parsed.status,
    currency: parsed.currency,
    totalAmount: parsed.totalAmount,
    notes: parsed.notes,
    guest: {
      ...splitName(parsed.guestName),
      email: parsed.guestEmail,
      phone: parsed.guestPhone,
      country: null,
      language: null,
    },
    rooms,
    needsReview:
      `Read from an email from ${who}. Check the details against ${who}.` +
      (verified && message.authentication === 'pass'
        ? ''
        : ' The mail server could not confirm who sent the email.'),
  };
}

/**
 * Turns one email into what should happen in the PMS: a booking event, a
 * note that a booking email could not be read, or nothing (it is not about a
 * booking).
 */
export function emailToEvent(
  message: EmailMessage,
  options: ReadOptions & { trustUnverifiedSenders?: boolean },
): BookingEvent | null {
  const reading = readReservationEmail(message, options);
  if (reading.kind === 'other') return null;
  if (reading.kind === 'unreadable') {
    return unreadable(
      message,
      reading.channelCode,
      reading.channelName,
      null,
      'new',
      `looks like a booking notice, but ${reading.reason}. Open the email and enter the booking by hand.`,
    );
  }
  return toEvent(message, reading.reservation, options.trustUnverifiedSenders ?? false);
}

function readOptions(
  context: Pick<AdapterContext, 'config'>,
): ReadOptions & { trustUnverifiedSenders: boolean } {
  const config = context.config as EmailConnectionConfig;
  return {
    dayFirst: config.dayFirst ?? true,
    currency: config.currency ?? 'INR',
    trustUnverifiedSenders: config.trustUnverifiedSenders ?? false,
  };
}

export function mailboxSettings(
  context: Pick<AdapterContext, 'config' | 'secrets' | 'env'>,
): MailboxSettings | null {
  const config = context.config as EmailConnectionConfig;
  const host = config.mailbox?.host ?? context.env.RESERVATIONS_IMAP_HOST;
  const user = config.mailbox?.user ?? context.env.RESERVATIONS_IMAP_USER;
  const password = context.secrets.password ?? context.env.RESERVATIONS_IMAP_PASSWORD;
  if (!host || !user || !password) return null;
  const port = config.mailbox?.port ?? context.env.RESERVATIONS_IMAP_PORT;
  return {
    host,
    user,
    password,
    port,
    folder: config.mailbox?.folder ?? context.env.RESERVATIONS_IMAP_MAILBOX,
    secure: config.mailbox?.secure ?? port !== 143,
  };
}

/**
 * The reservations mailbox: for a channel with no connection of its own, its
 * booking emails still reach the PMS within a minute or two. Inbound only.
 */
export function emailAdapter(context: AdapterContext): ChannelAdapter {
  const state = context.state as EmailState;
  const options = readOptions(context);
  const recipient = (context.config as EmailConnectionConfig).recipient?.toLowerCase();

  return {
    capabilities: { ari: false, bookings: 'poll', messaging: false },
    minPushIntervalMs: 0,
    pollIntervalMs: 60_000,

    async pushAri(): Promise<PushResult> {
      return { references: [], warnings: [] };
    },

    async pullBookings(): Promise<BookingEvent[]> {
      const settings = mailboxSettings(context);
      // A connection fed only by forwarded mail has no mailbox to read.
      if (!settings) return [];
      const { uidValidity, messages } = await mailboxFactory(settings).fetchAfter(
        { uidValidity: state.uidValidity ?? null, lastUid: state.lastUid ?? 0 },
        FETCH_LIMIT,
      );
      const events: BookingEvent[] = [];
      let lastUid = state.uidValidity === uidValidity ? (state.lastUid ?? 0) : 0;
      for (const raw of messages) {
        lastUid = Math.max(lastUid, raw.uid);
        let message: EmailMessage;
        try {
          message = await parseMime(raw.source);
        } catch {
          // Not something that can be read as an email at all.
          continue;
        }
        if (recipient && !message.to.includes(recipient)) continue;
        const event = emailToEvent(message, options);
        if (event) events.push(event);
      }
      state.uidValidity = uidValidity;
      state.lastUid = lastUid;
      return events;
    },

    async reparse(raw: Record<string, unknown>): Promise<BookingEvent | null> {
      if (typeof raw.text !== 'string' || typeof raw.from !== 'string') return null;
      return emailToEvent(
        {
          messageId: String(raw.messageId ?? ''),
          from: raw.from,
          fromName: String(raw.fromName ?? ''),
          to: Array.isArray(raw.to) ? (raw.to as string[]) : [],
          subject: String(raw.subject ?? ''),
          date: new Date(String(raw.date ?? '')),
          text: raw.text,
          ...(typeof raw.alternativeText === 'string'
            ? { alternativeText: raw.alternativeText }
            : {}),
          authentication:
            raw.authentication === 'pass' || raw.authentication === 'fail'
              ? raw.authentication
              : 'none',
        },
        options,
      );
    },
  };
}
