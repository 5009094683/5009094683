import { addDays, isValidDate, type DateString } from '@pms/domain';

/**
 * Reading and writing iCalendar (RFC 5545), as far as booking calendars use
 * it: all-day events with a start, an end, an id and a line of text. No
 * recurrence, alarms or attendees; booking sites do not produce them.
 */

export interface CalendarEvent {
  uid: string;
  /** First night. */
  start: DateString;
  /** The morning the stay ends: the first date that is free again. */
  end: DateString;
  summary: string;
  description: string;
  cancelled: boolean;
}

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Joins folded lines back together: a line starting with a space or tab continues the one before. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

function parseLine(line: string): ContentLine | null {
  // The value starts at the first colon that is not inside a quoted parameter.
  let inQuotes = false;
  let split = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      split = i;
      break;
    }
  }
  if (split < 0) return null;
  const [name, ...paramParts] = line.slice(0, split).split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: (name ?? '').toUpperCase(), params, value: line.slice(split + 1) };
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

function dateIn(timezone: string, instant: Date): DateString {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(instant);
}

/**
 * The calendar date of a DTSTART or DTEND. All-day values are taken as they
 * are; a date with a time is placed on the property's calendar, so a check-out
 * at 11:00 on the 12th ends on the 12th wherever the feed's clock is set.
 */
function dateOf(
  line: ContentLine,
  timezone: string,
): { date: DateString; hasTime: boolean } | null {
  const value = line.value.trim();
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (day) {
    const date = `${day[1]}-${day[2]}-${day[3]}`;
    return isValidDate(date) ? { date, hasTime: false } : null;
  }
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!timed) return null;
  const local = `${timed[1]}-${timed[2]}-${timed[3]}`;
  if (!isValidDate(local)) return null;
  if (timed[7] === 'Z') {
    const instant = new Date(
      Date.UTC(+timed[1]!, +timed[2]! - 1, +timed[3]!, +timed[4]!, +timed[5]!, +timed[6]!),
    );
    return { date: dateIn(timezone, instant), hasTime: true };
  }
  // A time given in a named zone or with no zone: the date as written is the local date.
  return { date: local, hasTime: true };
}

/**
 * The events of a calendar. Events that cannot be understood (no id, no
 * usable dates) are skipped and counted, never guessed at.
 */
export function parseCalendar(
  text: string,
  timezone: string,
): { events: CalendarEvent[]; skipped: number } {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('The address did not return a calendar');
  const events: CalendarEvent[] = [];
  let skipped = 0;
  let current: ContentLine[] | null = null;
  let depth = 0;

  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN') {
      if (line.value.toUpperCase() === 'VEVENT' && current === null) current = [];
      // Alarms and other parts nested inside an event are not part of it.
      else if (current !== null) depth++;
      continue;
    }
    if (line.name === 'END') {
      if (current !== null && depth > 0) {
        depth--;
        continue;
      }
      if (line.value.toUpperCase() === 'VEVENT' && current !== null) {
        const event = toEvent(current, timezone);
        if (event) events.push(event);
        else skipped++;
        current = null;
      }
      continue;
    }
    if (current !== null && depth === 0) current.push(line);
  }
  return { events, skipped };
}

function toEvent(lines: ContentLine[], timezone: string): CalendarEvent | null {
  const find = (name: string): ContentLine | undefined => lines.find((l) => l.name === name);
  const uid = find('UID')?.value.trim();
  const startLine = find('DTSTART');
  if (!uid || !startLine) return null;
  const start = dateOf(startLine, timezone);
  if (!start) return null;

  const endLine = find('DTEND');
  const endValue = endLine ? dateOf(endLine, timezone) : null;
  let end = endValue?.date ?? addDays(start.date, 1);
  // A timed stay that ends the day it starts (or a zero-length all-day event) still takes that night.
  if (end <= start.date) end = addDays(start.date, 1);

  return {
    uid,
    start: start.date,
    end,
    summary: unescapeText(find('SUMMARY')?.value ?? '').trim(),
    description: unescapeText(find('DESCRIPTION')?.value ?? '').trim(),
    cancelled: (find('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED',
  };
}

// ---------------------------------------------------------------------------
// Writing

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets must be folded; the continuation starts with a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  let limit = 75;
  while (Buffer.byteLength(rest, 'utf8') > limit) {
    // Cut on a character boundary at or below the limit.
    let cut = Math.min(rest.length, limit);
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > limit) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    limit = 74;
  }
  parts.push(rest);
  return parts.join('\r\n ');
}

const compact = (date: DateString): string => date.replace(/-/g, '');

function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export interface OutgoingEvent {
  uid: string;
  start: DateString;
  /** First date that is free again. */
  end: DateString;
  summary: string;
  /** When the underlying booking or block last changed. */
  modifiedAt?: Date;
}

/** A calendar a booking site can subscribe to. */
export function formatCalendar(
  name: string,
  events: OutgoingEvent[],
  now: Date = new Date(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PMS//Availability//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${compact(event.start)}`,
      `DTEND;VALUE=DATE:${compact(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      ...(event.modifiedAt ? [`LAST-MODIFIED:${stamp(event.modifiedAt)}`] : []),
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
