import { addDays, currencyExponent, isValidDate, type DateString } from '@pms/domain';

/**
 * Reading reservation emails.
 *
 * Booking sites send a notice for every booking, change and cancellation.
 * Their layouts differ and change without warning, so nothing here depends on
 * one layout: an email is reduced to plain lines, and each fact is looked for
 * by the words that label it ("Check-in", "Arrival date", ...), wherever it
 * sits. An email that looks like a booking notice but does not yield the
 * essentials is reported as unreadable, never half-used.
 */

export interface EmailMessage {
  messageId: string;
  /** Sender address, lower case. */
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  date: Date;
  /** The body as plain text (see `htmlToText` for HTML-only mail). */
  text: string;
  /**
   * The HTML part as text, when the message has both. The plain part of an
   * automated email is often a poor copy; the table in the HTML part reads better.
   */
  alternativeText?: string;
  /** What the receiving mail server concluded about the sender. */
  authentication: SenderCheck;
  /** Ids of the message this one answers and of the thread before it, without angle brackets. */
  inReplyTo?: string | null;
  references?: string[];
  /** Names and sizes of attached files. */
  attachments?: {
    name: string;
    contentType: string | null;
    size: number | null;
    /** The file itself, for mail from a guest. Never part of what is stored about a booking email. */
    content?: Buffer;
  }[];
}

/** `pass`: the receiving server verified the sender's domain. `fail`: it tried and it did not match. `none`: nothing to go on. */
export type SenderCheck = 'pass' | 'fail' | 'none';

export interface ParsedReservationEmail {
  channelCode: string | null;
  channelName: string;
  status: 'new' | 'modified' | 'cancelled';
  /** The channel's booking reference. */
  reference: string;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  checkIn: DateString | null;
  checkOut: DateString | null;
  roomName: string | null;
  rooms: number;
  adults: number | null;
  children: number | null;
  currency: string | null;
  /** Minor units of `currency`. */
  totalAmount: number | null;
  notes: string | null;
}

export type EmailReading =
  | { kind: 'reservation'; reservation: ParsedReservationEmail }
  /** Looks like a booking notice, but the essentials could not be made out. */
  | { kind: 'unreadable'; channelName: string; channelCode: string | null; reason: string }
  /** Not about a booking: a newsletter, an invoice, a conversation. */
  | { kind: 'other' };

export interface ReadOptions {
  /** Read 03/04/2027 as 3 April (true) or 4 March (false). */
  dayFirst: boolean;
  /** Assumed when an amount carries no currency. */
  currency: string;
}

// ---------------------------------------------------------------------------
// Text

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rupee: '₹',
  euro: '€',
  pound: '£',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : ' ';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** An HTML email as lines of text: table cells on a row are separated by tabs, rows by line breaks. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(td|th)\s*>/gi, '\t')
    .replace(/<\/\s*(p|div|tr|li|h[1-6]|table|ul|ol|section)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normaliseText(decodeEntities(text));
}

export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .replace(/[ ]*\t[ \t]*/g, '\t')
        .replace(/ {2,}/g, '  ')
        .replace(/^[\t ]+|[\t ]+$/g, ''),
    )
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Channels

interface KnownChannel {
  code: string;
  name: string;
  domains: string[];
}

const CHANNELS: KnownChannel[] = [
  { code: 'BDC', name: 'Booking.com', domains: ['booking.com'] },
  { code: 'ABB', name: 'Airbnb', domains: ['airbnb.com', 'airbnb.co.in'] },
  {
    code: 'EXP',
    name: 'Expedia',
    domains: ['expedia.com', 'expediapartnercentral.com', 'expediagroup.com', 'hotels.com'],
  },
  { code: 'AGO', name: 'Agoda', domains: ['agoda.com'] },
  { code: 'MMT', name: 'MakeMyTrip', domains: ['makemytrip.com', 'go-mmt.com'] },
  { code: 'GIB', name: 'Goibibo', domains: ['goibibo.com'] },
  { code: 'VRB', name: 'Vrbo', domains: ['vrbo.com', 'homeaway.com'] },
  { code: 'CTP', name: 'Trip.com', domains: ['trip.com', 'ctrip.com'] },
  { code: 'TRA', name: 'Tripadvisor', domains: ['tripadvisor.com'] },
  { code: 'HWL', name: 'Hostelworld', domains: ['hostelworld.com'] },
  { code: 'YAT', name: 'Yatra', domains: ['yatra.com'] },
  { code: 'CLT', name: 'Cleartrip', domains: ['cleartrip.com'] },
  { code: 'EMT', name: 'EaseMyTrip', domains: ['easemytrip.com'] },
];

function domainOf(address: string): string {
  return address.split('@')[1]?.toLowerCase() ?? '';
}

/** The booking site an address belongs to, if it is one we know. Subdomains count. */
export function channelOfSender(address: string): KnownChannel | null {
  const domain = domainOf(address);
  if (!domain) return null;
  return (
    CHANNELS.find((c) => c.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) ?? null
  );
}

// ---------------------------------------------------------------------------
// Values

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function build(year: number, month: number, day: number): DateString | null {
  const full = year < 100 ? 2000 + year : year;
  const date = `${String(full).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidDate(date) ? date : null;
}

/** A calendar date written the way people and booking sites write them. */
export function parseDate(text: string, dayFirst: boolean): DateString | null {
  const value = text.trim();
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (iso) return build(+iso[1]!, +iso[2]!, +iso[3]!);

  // 12 Jan 2027, 12-Jan-27, 12th January, 2027
  const dayMonth =
    /(\d{1,2})(?:st|nd|rd|th)?[\s.\-/]*([a-z]{3,9})\.?,?[\s.\-/]*(\d{4}|\d{2})\b/i.exec(value);
  if (dayMonth && MONTHS[dayMonth[2]!.slice(0, 3).toLowerCase()]) {
    return build(+dayMonth[3]!, MONTHS[dayMonth[2]!.slice(0, 3).toLowerCase()]!, +dayMonth[1]!);
  }
  // Jan 12, 2027 / January 12 2027
  const monthDay = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(value);
  if (monthDay && MONTHS[monthDay[1]!.slice(0, 3).toLowerCase()]) {
    return build(+monthDay[3]!, MONTHS[monthDay[1]!.slice(0, 3).toLowerCase()]!, +monthDay[2]!);
  }
  const numeric = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(value);
  if (numeric) {
    const [a, b] = [+numeric[1]!, +numeric[2]!];
    // A part above 12 can only be the day, whatever the convention.
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : dayFirst ? [a, b] : [b, a];
    return build(+numeric[3]!, month, day);
  }
  return null;
}

const SYMBOLS: [RegExp, string][] = [
  [/₹|\brs\.?(?=\s|\d)|\binr\b/i, 'INR'],
  [/us\$|\busd\b/i, 'USD'],
  [/€|\beur\b/i, 'EUR'],
  [/£|\bgbp\b/i, 'GBP'],
  [/\baed\b|د\.إ/i, 'AED'],
  [/a\$|\baud\b/i, 'AUD'],
  [/s\$|\bsgd\b/i, 'SGD'],
  [/฿|\bthb\b/i, 'THB'],
  [/¥|\bjpy\b/i, 'JPY'],
  [/\$/, 'USD'],
];

/** An amount of money with its currency, e.g. "INR 12,500.00", "₹1,25,000", "€ 1.234,56". */
export function parseMoney(
  text: string,
  fallbackCurrency: string,
): { amount: number; currency: string } | null {
  const number = /\d[\d.,\s]*\d|\d/.exec(text.replace(/(\d)\s+(?=\d{3}\b)/g, '$1'));
  if (!number) return null;
  let currency = SYMBOLS.find(([pattern]) => pattern.test(text))?.[1];
  if (!currency) {
    const code = /\b([A-Z]{3})\b/.exec(text)?.[1];
    currency =
      code && !['THE', 'FOR', 'AND', 'PER', 'TAX', 'GST', 'VAT'].includes(code)
        ? code
        : fallbackCurrency;
  }
  let digits = number[0].replace(/\s/g, '');
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  let fraction = '';
  const separator = Math.max(lastDot, lastComma);
  if (separator >= 0) {
    const after = digits.length - separator - 1;
    const both = lastDot >= 0 && lastComma >= 0;
    // With both marks the later one is the decimal mark; alone, a mark followed by
    // one or two digits is a decimal mark and by three a thousands mark.
    if ((both && after <= 3) || (!both && after > 0 && after <= 2)) {
      fraction = digits.slice(separator + 1);
      digits = digits.slice(0, separator);
    }
  }
  const whole = digits.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole)) return null;
  const exponent = currencyExponent(currency);
  const minor =
    Number(whole) * 10 ** exponent + Math.round(Number(`0.${fraction || '0'}`) * 10 ** exponent);
  return Number.isSafeInteger(minor) ? { amount: minor, currency } : null;
}

// ---------------------------------------------------------------------------
// Fields

const LABELS = {
  reference:
    /(?:booking|reservation|confirmation|itinerary|trip|order)\s*(?:id|number|no\.?|code|reference|ref\.?|#)|pnr|confirmation\s*#/i,
  guest:
    /(?:lead |primary |main )?(?:guest|booker|customer|traveller|traveler|client)(?:'s)?(?:\s*name)?|booked by|name of guest/i,
  checkIn:
    /check[\s-]?in(?:\s*date)?|arrival(?:\s*date)?|arrives?|date of arrival|from date|start date/i,
  checkOut:
    /check[\s-]?out(?:\s*date)?|departure(?:\s*date)?|departs?|date of departure|to date|end date/i,
  nights:
    /(?:number of |no\.? of |total |length of stay|duration)\s*(?:nights?|\(nights\))?|nights?/i,
  room: /room\s*type|room\s*name|room\s*category|accommodation(?:\s*type)?|unit(?:\s*type)?|listing|rooms?\s*booked|room/i,
  roomCount: /(?:number of |no\.? of |total )rooms?|rooms/i,
  adults: /(?:number of |no\.? of )?adults?/i,
  children: /(?:number of |no\.? of )?child(?:ren)?|kids/i,
  guests: /(?:number of |no\.? of |total )?(?:guests|occupancy|pax|persons?|people)/i,
  total:
    /(?:(?:grand|booking|reservation|net|total)\s+)*(?:total|amount|price|payout|cost)(?:\s*(?:price|amount|cost|payout|payable|to collect|paid|charges?|due))?|you(?:'ll)? earn/i,
  email: /(?:guest |customer |booker )?e-?mail(?:\s*(?:address|id))?/i,
  phone: /(?:guest |customer |booker )?(?:phone|mobile|contact|telephone)(?:\s*(?:number|no\.?))?/i,
  notes: /special\s*requests?|guest\s*(?:comments?|message|notes?|requests?)|remarks?|comments?/i,
} as const;

type Field = keyof typeof LABELS;

/**
 * The value written against a label. Understands "Label: value",
 * "Label<tab>value" (a table row), and a label on one line with its value on
 * the next. Where several labels would match a line, the longest label wins,
 * so "Check-in date" is not taken for "date".
 */
function fieldOf(lines: string[], field: Field): string | null {
  const label = LABELS[field].source;
  const inline = new RegExp(`^(?:${label})\\s*(?::|=|\\t|–|—| - | {2,})\\s*(.+)$`, 'i');
  const alone = new RegExp(`^(?:${label})\\s*:?$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = inline.exec(line);
    if (match?.[1]) {
      const value = match[1].split('\t')[0]!.trim();
      if (value) return value;
    }
    if (alone.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      // The next line is a value unless it is itself another label.
      if (next && !/[:\t]\s*\S/.test(next) && next.length <= 200)
        return next.split('\t')[0]!.trim();
    }
  }
  return null;
}

function firstNumber(text: string | null): number | null {
  const match = text ? /\d+/.exec(text) : null;
  return match ? Number(match[0]) : null;
}

const REFERENCE_VALUE = /\b([A-Z0-9][A-Z0-9-]{4,24})\b/i;

function referenceOf(lines: string[], subject: string): string | null {
  const labelled = fieldOf(lines, 'reference');
  const fromLabel = labelled ? REFERENCE_VALUE.exec(labelled.replace(/\s+/g, ''))?.[1] : null;
  if (fromLabel && /\d/.test(fromLabel)) return fromLabel.toUpperCase();
  // "New booking 4521887766", "Reservation HMABCD1234 confirmed", "Booking ID: NH7412589630"
  const inSubject =
    /(?:booking|reservation|confirmation|itinerary)\s*(?:id|number|no\.?|code|ref(?:erence)?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i.exec(
      subject,
    )?.[1];
  if (inSubject && /\d/.test(inSubject)) return inSubject.toUpperCase();
  return null;
}

function statusOf(subject: string, text: string): ParsedReservationEmail['status'] {
  const head = `${subject}\n${text.slice(0, 400)}`.toLowerCase();
  if (/cancel(?:l)?ed|cancel(?:l)?ation|has been cancel/.test(head)) return 'cancelled';
  if (/modif|amend|changed|change to|updated|update to|alter|reschedul/.test(head))
    return 'modified';
  return 'new';
}

const ABOUT_A_BOOKING =
  /\b(?:booking|reservation|itinerary)\b[\s\S]{0,80}\b(?:confirm|new|cancel|modif|chang|amend|receiv|updat|id|number|ref)|\bnew (?:booking|reservation)\b|\b(?:booking|reservation) (?:confirmation|cancell?ation|modification)\b/i;

/**
 * Makes out what a reservation email says. Returns `other` for mail that is
 * not a booking notice, and `unreadable` for a booking notice whose
 * reference or dates could not be found.
 */
export function readReservationEmail(message: EmailMessage, options: ReadOptions): EmailReading {
  const reading = readBody(message, options);
  if (reading.kind === 'reservation' || !message.alternativeText) return reading;
  const second = readBody({ ...message, text: message.alternativeText }, options);
  // The other part settles it only if it reads fully; otherwise the first verdict stands.
  return second.kind === 'reservation' ? second : reading.kind === 'other' ? second : reading;
}

function readBody(message: EmailMessage, options: ReadOptions): EmailReading {
  const known = channelOfSender(message.from);
  const aboutBooking = ABOUT_A_BOOKING.test(`${message.subject}\n${message.text.slice(0, 1500)}`);
  if (!aboutBooking) return { kind: 'other' };
  // From a stranger, only mail that reads unmistakably like a booking notice is considered.
  if (!known && !ABOUT_A_BOOKING.test(message.subject)) return { kind: 'other' };

  const channelName =
    known?.name ?? (message.fromName || domainOf(message.from) || 'an unknown sender');
  const channelCode = known?.code ?? null;
  const lines = message.text.split('\n');
  const status = statusOf(message.subject, message.text);
  const reference = referenceOf(lines, message.subject);
  if (!reference) {
    return {
      kind: 'unreadable',
      channelName,
      channelCode,
      reason: 'no booking reference could be found',
    };
  }

  const checkInText = fieldOf(lines, 'checkIn');
  const checkOutText = fieldOf(lines, 'checkOut');
  const checkIn = checkInText ? parseDate(checkInText, options.dayFirst) : null;
  let checkOut = checkOutText ? parseDate(checkOutText, options.dayFirst) : null;
  const nights = firstNumber(fieldOf(lines, 'nights'));
  if (checkIn && !checkOut && nights && nights > 0 && nights < 366)
    checkOut = addDays(checkIn, nights);

  if (status !== 'cancelled') {
    if (!checkIn || !checkOut) {
      return {
        kind: 'unreadable',
        channelName,
        channelCode,
        reason: 'the stay dates could not be found',
      };
    }
    if (checkOut <= checkIn) {
      return {
        kind: 'unreadable',
        channelName,
        channelCode,
        reason: `the stay dates do not make sense (${checkIn} to ${checkOut})`,
      };
    }
  }

  const total = fieldOf(lines, 'total');
  const money = total ? parseMoney(total, options.currency) : null;
  const guests = firstNumber(fieldOf(lines, 'guests'));
  const adults = firstNumber(fieldOf(lines, 'adults')) ?? guests;
  const email = fieldOf(lines, 'email');
  const phone = fieldOf(lines, 'phone');
  const guestName = fieldOf(lines, 'guest');
  const roomName = fieldOf(lines, 'room');

  return {
    kind: 'reservation',
    reservation: {
      channelCode,
      channelName,
      status,
      reference,
      guestName: guestName && !/\d{3,}/.test(guestName) ? guestName.slice(0, 120) : null,
      guestEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null,
      guestPhone: phone && /\d{6,}/.test(phone.replace(/\D/g, '')) ? phone.slice(0, 40) : null,
      checkIn,
      checkOut,
      roomName:
        roomName && !/^\d+$/.test(roomName)
          ? roomName.replace(/^\d+\s*[x×]\s*/i, '').slice(0, 120)
          : null,
      rooms: Math.max(1, firstNumber(fieldOf(lines, 'roomCount')) ?? 1),
      adults,
      children: firstNumber(fieldOf(lines, 'children')),
      currency: money?.currency ?? null,
      totalAmount: money?.amount ?? null,
      notes: fieldOf(lines, 'notes'),
    },
  };
}

/** What the receiving mail server recorded about whether the sender's domain is genuine. */
export function senderCheck(authenticationResults: string[], fromAddress: string): SenderCheck {
  if (authenticationResults.length === 0) return 'none';
  const domain = domainOf(fromAddress);
  const joined = authenticationResults.join(' ; ').toLowerCase();
  if (/\bdmarc=pass\b/.test(joined)) return 'pass';
  // DKIM counts when the signing domain is the sender's domain or a parent of it.
  for (const match of joined.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:d|i)=@?([a-z0-9.-]+)/g)) {
    const signer = match[1]!;
    if (domain === signer || domain.endsWith(`.${signer}`)) return 'pass';
  }
  if (/\bspf=pass\b[^;]*?\bsmtp\.mailfrom=(?:[^\s;@]*@)?([a-z0-9.-]+)/.test(joined)) {
    const mailFrom = /\bspf=pass\b[^;]*?\bsmtp\.mailfrom=(?:[^\s;@]*@)?([a-z0-9.-]+)/.exec(
      joined,
    )![1]!;
    if (domain === mailFrom || domain.endsWith(`.${mailFrom}`) || mailFrom.endsWith(`.${domain}`))
      return 'pass';
  }
  if (/\b(?:dmarc|dkim|spf)=(?:fail|softfail|permerror)\b/.test(joined)) return 'fail';
  return 'none';
}
