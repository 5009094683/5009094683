import { describe, expect, it } from 'vitest';
import { classify, guestOf, referenceOf } from './adapter';
import { formatCalendar, parseCalendar, type CalendarEvent } from './calendar';

const wrap = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...events, 'END:VCALENDAR'].join('\r\n');

const event = (fields: string[]) => ['BEGIN:VEVENT', ...fields, 'END:VEVENT'].join('\r\n');

describe('reading a calendar', () => {
  it('reads an Airbnb-style all-day entry, with folded lines and escaped text', () => {
    const { events, skipped } = parseCalendar(
      wrap(
        event([
          'DTEND;VALUE=DATE:20270115',
          'DTSTART;VALUE=DATE:20270112',
          'UID:1418fb94e984-aa11bb22cc33@airbnb.com',
          'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de',
          ' tails/HMABCD1234\\nPhone Number (Last 4 Digits): 1234',
          'SUMMARY:Reserved',
        ]),
      ),
      'Asia/Kolkata',
    );
    expect(skipped).toBe(0);
    expect(events).toEqual([
      {
        uid: '1418fb94e984-aa11bb22cc33@airbnb.com',
        start: '2027-01-12',
        end: '2027-01-15',
        summary: 'Reserved',
        description:
          'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCD1234\nPhone Number (Last 4 Digits): 1234',
        cancelled: false,
      },
    ]);
    expect(referenceOf(events[0]!)).toBe('HMABCD1234');
    expect(classify(events[0]!, { treatAs: 'auto' })).toBe('reservation');
  });

  it('tells closures from bookings by their text, unless told how to read the calendar', () => {
    const closed: CalendarEvent = {
      uid: 'x',
      start: '2027-01-01',
      end: '2027-01-02',
      summary: 'Airbnb (Not available)',
      description: '',
      cancelled: false,
    };
    expect(classify(closed, { treatAs: 'auto' })).toBe('block');
    expect(classify({ ...closed, summary: 'CLOSED - Not available' }, { treatAs: 'auto' })).toBe(
      'block',
    );
    expect(classify({ ...closed, summary: 'Blocked' }, { treatAs: 'auto' })).toBe('block');
    expect(classify({ ...closed, summary: 'Reserved - Maria Lopez' }, { treatAs: 'auto' })).toBe(
      'reservation',
    );
    // Nothing to go on: a record staff must check is safer than a silent closure.
    expect(classify({ ...closed, summary: '' }, { treatAs: 'auto' })).toBe('reservation');
    expect(classify(closed, { treatAs: 'reservations' })).toBe('reservation');
    expect(classify({ ...closed, summary: 'Reserved' }, { treatAs: 'blocks' })).toBe('block');
  });

  it('finds a guest name when the calendar gives one', () => {
    const base = {
      uid: 'x',
      start: '2027-01-01',
      end: '2027-01-02',
      description: '',
      cancelled: false,
    };
    expect(guestOf({ ...base, summary: 'Reserved - Maria Lopez' })).toEqual({
      firstName: 'Maria',
      lastName: 'Lopez',
    });
    expect(guestOf({ ...base, summary: 'Booked: Chen' })).toEqual({
      firstName: 'Chen',
      lastName: '',
    });
    expect(guestOf({ ...base, summary: 'Reserved' })).toEqual({ firstName: '', lastName: '' });
  });

  it('places timed entries on the property’s calendar', () => {
    const { events } = parseCalendar(
      wrap(
        // 20:30 UTC on the 9th is 02:00 on the 10th in India.
        event([
          'UID:utc',
          'DTSTART:20270109T203000Z',
          'DTEND:20270112T053000Z',
          'SUMMARY:Reserved',
        ]),
        event([
          'UID:zoned',
          'DTSTART;TZID=Asia/Kolkata:20270110T140000',
          'DTEND;TZID=Asia/Kolkata:20270112T110000',
        ]),
        event(['UID:same-day', 'DTSTART:20270120T100000', 'DTEND:20270120T180000']),
        event(['UID:no-end', 'DTSTART;VALUE=DATE:20270125']),
      ),
      'Asia/Kolkata',
    );
    expect(events.map((e) => [e.uid, e.start, e.end])).toEqual([
      ['utc', '2027-01-10', '2027-01-12'],
      ['zoned', '2027-01-10', '2027-01-12'],
      ['same-day', '2027-01-20', '2027-01-21'],
      ['no-end', '2027-01-25', '2027-01-26'],
    ]);
  });

  it('skips entries it cannot understand rather than guessing', () => {
    const { events, skipped } = parseCalendar(
      wrap(
        event(['DTSTART;VALUE=DATE:20270112', 'DTEND;VALUE=DATE:20270115', 'SUMMARY:No id']),
        event(['UID:no-dates', 'SUMMARY:Reserved']),
        event(['UID:bad-date', 'DTSTART;VALUE=DATE:20271340']),
        event(['UID:good', 'DTSTART;VALUE=DATE:20270112', 'DTEND;VALUE=DATE:20270113']),
      ),
      'UTC',
    );
    expect(events.map((e) => e.uid)).toEqual(['good']);
    expect(skipped).toBe(3);
  });

  it('notes cancelled entries and ignores alarms inside an entry', () => {
    const { events } = parseCalendar(
      wrap(
        event([
          'UID:with-alarm',
          'DTSTART;VALUE=DATE:20270112',
          'DTEND;VALUE=DATE:20270113',
          'STATUS:CANCELLED',
          'BEGIN:VALARM',
          'TRIGGER:-PT1H',
          'DESCRIPTION:Reminder',
          'END:VALARM',
          'SUMMARY:Reserved',
        ]),
      ),
      'UTC',
    );
    expect(events).toMatchObject([
      { uid: 'with-alarm', cancelled: true, summary: 'Reserved', description: '' },
    ]);
  });

  it('refuses something that is not a calendar', () => {
    expect(() => parseCalendar('<html>Sign in</html>', 'UTC')).toThrow(/did not return a calendar/);
  });
});

describe('writing a calendar', () => {
  it('writes entries a channel can read back', () => {
    const text = formatCalendar(
      'Villa Azure - Villa',
      [
        { uid: 'a@pms', start: '2027-01-12', end: '2027-01-15', summary: 'Reserved' },
        { uid: 'b@pms', start: '2027-02-01', end: '2027-02-03', summary: 'Not available' },
      ],
      new Date('2027-01-01T08:00:00Z'),
    );
    expect(text).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
    expect(text).toContain('DTSTART;VALUE=DATE:20270112\r\nDTEND;VALUE=DATE:20270115\r\n');
    expect(text).toContain('DTSTAMP:20270101T080000Z');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const { events } = parseCalendar(text, 'UTC');
    expect(events.map((e) => [e.uid, e.start, e.end, e.summary])).toEqual([
      ['a@pms', '2027-01-12', '2027-01-15', 'Reserved'],
      ['b@pms', '2027-02-01', '2027-02-03', 'Not available'],
    ]);
  });

  it('folds long lines and escapes special characters', () => {
    const long =
      'Property with a very long name, a semicolon; a backslash \\ and words that go on and on and on';
    const text = formatCalendar(long, [], new Date('2027-01-01T00:00:00Z'));
    for (const line of text.split('\r\n'))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(text).toContain('\\, a semicolon\\; a backslash \\\\');
    // Unfolded, the name reads back intact.
    expect(text.replace(/\r\n /g, '')).toContain(
      `X-WR-CALNAME:${long.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')}`,
    );
  });
});
