import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emailToEvent,
  emailToEventWithFallback,
  parseMime,
  setEmailFallbackReader,
  type FallbackReading,
} from './adapter';
import {
  channelOfSender,
  htmlToText,
  parseDate,
  parseMoney,
  readReservationEmail,
  senderCheck,
  type EmailMessage,
} from './parse';

/**
 * These emails are written for the tests, in the style booking sites use.
 * They are not copies of real ones: real layouts have to be checked against a
 * property's own mailbox before the mailbox route is relied on.
 */
const message = (overrides: Partial<EmailMessage> & { text: string }): EmailMessage => ({
  messageId: 'm1@example.com',
  from: 'noreply@booking.com',
  fromName: 'Booking.com',
  to: ['reservations@seabreeze.example'],
  subject: 'New booking',
  date: new Date('2027-01-05T10:00:00Z'),
  authentication: 'pass',
  ...overrides,
});

const options = { dayFirst: true, currency: 'INR' };

describe('dates', () => {
  it('reads the ways dates are written', () => {
    for (const [text, expected] of [
      ['2027-01-12', '2027-01-12'],
      ['12 Jan 2027', '2027-01-12'],
      ['Tue, 12 January 2027', '2027-01-12'],
      ['12-Jan-27', '2027-01-12'],
      ['12th January, 2027', '2027-01-12'],
      ['Jan 12, 2027', '2027-01-12'],
      ['January 12 2027 (from 14:00)', '2027-01-12'],
      ['12/01/2027', '2027-01-12'],
      ['12.01.2027', '2027-01-12'],
      ['25/01/2027', '2027-01-25'],
    ] as const) {
      expect(parseDate(text, true), text).toBe(expected);
    }
  });

  it('reads 03/04 by the convention it is told, unless only one reading is possible', () => {
    expect(parseDate('03/04/2027', true)).toBe('2027-04-03');
    expect(parseDate('03/04/2027', false)).toBe('2027-03-04');
    expect(parseDate('04/25/2027', true)).toBe('2027-04-25');
    expect(parseDate('25/04/2027', false)).toBe('2027-04-25');
  });

  it('refuses what is not a date', () => {
    expect(parseDate('31/02/2027', true)).toBeNull();
    expect(parseDate('soon', true)).toBeNull();
    expect(parseDate('', true)).toBeNull();
  });
});

describe('money', () => {
  it('reads amounts with their currency, in minor units', () => {
    expect(parseMoney('INR 12,500.00', 'INR')).toEqual({ amount: 1_250_000, currency: 'INR' });
    expect(parseMoney('₹1,25,000', 'USD')).toEqual({ amount: 12_500_000, currency: 'INR' });
    expect(parseMoney('Rs. 4500', 'USD')).toEqual({ amount: 450_000, currency: 'INR' });
    expect(parseMoney('US$ 240.50', 'INR')).toEqual({ amount: 24_050, currency: 'USD' });
    expect(parseMoney('€ 1.234,56', 'INR')).toEqual({ amount: 123_456, currency: 'EUR' });
    expect(parseMoney('1 234,50 EUR', 'INR')).toEqual({ amount: 123_450, currency: 'EUR' });
    expect(parseMoney('GBP 153', 'INR')).toEqual({ amount: 15_300, currency: 'GBP' });
    expect(parseMoney('12,500', 'INR')).toEqual({ amount: 1_250_000, currency: 'INR' });
    expect(parseMoney('¥15000', 'INR')).toEqual({ amount: 15_000, currency: 'JPY' });
    expect(parseMoney('free', 'INR')).toBeNull();
  });
});

describe('channels', () => {
  it('knows the booking sites by their sending domains, subdomains included', () => {
    expect(channelOfSender('noreply@booking.com')?.code).toBe('BDC');
    expect(channelOfSender('automated@airbnb.com')?.code).toBe('ABB');
    expect(channelOfSender('no-reply@partner.agoda.com')?.code).toBe('AGO');
    expect(channelOfSender('alerts@go-mmt.com')?.code).toBe('MMT');
    expect(channelOfSender('someone@notbooking.com')).toBeNull();
    expect(channelOfSender('someone@booking.com.evil.example')).toBeNull();
  });

  it('judges the sender by what the receiving server recorded', () => {
    expect(senderCheck([], 'noreply@booking.com')).toBe('none');
    expect(
      senderCheck(['mx.example; dmarc=pass header.from=booking.com'], 'noreply@booking.com'),
    ).toBe('pass');
    expect(
      senderCheck(
        ['mx.example; dkim=pass header.d=booking.com; spf=neutral'],
        'noreply@mail.booking.com',
      ),
    ).toBe('pass');
    // Signed, but by somebody else's domain.
    expect(
      senderCheck(['mx.example; dkim=pass header.d=mailer.example'], 'noreply@booking.com'),
    ).toBe('none');
    expect(
      senderCheck(
        ['mx.example; spf=fail smtp.mailfrom=booking.com; dmarc=fail'],
        'noreply@booking.com',
      ),
    ).toBe('fail');
  });
});

describe('reading a booking notice', () => {
  it('reads a plain "label: value" notice', () => {
    const reading = readReservationEmail(
      message({
        subject: 'New booking! Booking number 4521887766',
        text: [
          'You have a new booking.',
          '',
          'Booking number: 4521887766',
          'Guest name: Lena Fischer',
          'Check-in: Tuesday, 12 January 2027 (from 14:00)',
          'Check-out: Friday, 15 January 2027 (until 11:00)',
          'Room type: Deluxe Sea View Room',
          'Number of guests: 2',
          'Total price: INR 21,000.00',
          'Guest email: lena.fischer@guest.booking.com',
          'Phone: +49 171 5550101',
          'Special requests: Late arrival, around 22:00',
        ].join('\n'),
      }),
      options,
    );
    expect(reading).toEqual({
      kind: 'reservation',
      reservation: {
        channelCode: 'BDC',
        channelName: 'Booking.com',
        status: 'new',
        reference: '4521887766',
        guestName: 'Lena Fischer',
        guestEmail: 'lena.fischer@guest.booking.com',
        guestPhone: '+49 171 5550101',
        checkIn: '2027-01-12',
        checkOut: '2027-01-15',
        roomName: 'Deluxe Sea View Room',
        rooms: 1,
        adults: 2,
        children: null,
        currency: 'INR',
        totalAmount: 2_100_000,
        notes: 'Late arrival, around 22:00',
      },
    });
  });

  it('reads an HTML notice laid out as a table', () => {
    const html = `
      <html><head><style>td { padding: 4px }</style></head><body>
      <h2>Reservation confirmed</h2>
      <table>
        <tr><td>Confirmation code</td><td><b>HMQ2X7Y9ZT</b></td></tr>
        <tr><td>Guest</td><td>Maria&nbsp;Lopez</td></tr>
        <tr><td>Listing</td><td>Villa Azure &#8211; Entire Villa</td></tr>
        <tr><td>Check-in</td><td>Jan 20, 2027</td></tr>
        <tr><td>Checkout</td><td>Jan 24, 2027</td></tr>
        <tr><td>Guests</td><td>6 guests</td></tr>
        <tr><td>Total payout</td><td>&#8377;92,000.00</td></tr>
      </table>
      <!-- tracking --><script>track()</script>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Confirmation code\tHMQ2X7Y9ZT');
    expect(text).not.toMatch(/track|padding/);
    const reading = readReservationEmail(
      message({
        from: 'automated@airbnb.com',
        subject: 'Reservation confirmed - Maria Lopez arrives Jan 20',
        text,
      }),
      options,
    );
    expect(reading).toMatchObject({
      kind: 'reservation',
      reservation: {
        channelCode: 'ABB',
        reference: 'HMQ2X7Y9ZT',
        guestName: 'Maria Lopez',
        checkIn: '2027-01-20',
        checkOut: '2027-01-24',
        roomName: 'Villa Azure – Entire Villa',
        adults: 6,
        currency: 'INR',
        totalAmount: 9_200_000,
      },
    });
  });

  it('reads a notice with each label on its own line, and works the check-out out from the nights', () => {
    const reading = readReservationEmail(
      message({
        from: 'alerts@go-mmt.com',
        subject: 'Booking Confirmation - NH7412589630',
        text: [
          'Booking ID',
          'NH7412589630',
          'Customer Name',
          'Rahul Mehta',
          'Arrival date',
          '05/02/2027',
          'No. of nights',
          '3',
          'Room category',
          '2 x Standard Room',
          'No. of rooms',
          '2',
          'Adults',
          '4',
          'Children',
          '1',
          'Booking amount',
          'Rs. 27,000',
        ].join('\n'),
      }),
      options,
    );
    expect(reading).toMatchObject({
      kind: 'reservation',
      reservation: {
        channelCode: 'MMT',
        reference: 'NH7412589630',
        guestName: 'Rahul Mehta',
        checkIn: '2027-02-05',
        checkOut: '2027-02-08',
        roomName: 'Standard Room',
        rooms: 2,
        adults: 4,
        children: 1,
        totalAmount: 2_700_000,
      },
    });
  });

  it('recognises changes and cancellations', () => {
    const changed = readReservationEmail(
      message({
        subject: 'Booking modified: 4521887766',
        text: 'This reservation has been changed.\nBooking number: 4521887766\nCheck-in: 13 Jan 2027\nCheck-out: 16 Jan 2027',
      }),
      options,
    );
    expect(changed).toMatchObject({
      kind: 'reservation',
      reservation: { status: 'modified', checkIn: '2027-01-13' },
    });

    // A cancellation needs nothing but the reference.
    const cancelled = readReservationEmail(
      message({
        subject: 'Cancellation: booking 4521887766',
        text: 'The guest has cancelled this reservation.\nBooking number: 4521887766',
      }),
      options,
    );
    expect(cancelled).toMatchObject({
      kind: 'reservation',
      reservation: { status: 'cancelled', reference: '4521887766', checkIn: null, checkOut: null },
    });
  });

  it('says a booking notice is unreadable rather than guess', () => {
    expect(
      readReservationEmail(
        message({
          subject: 'New booking',
          text: 'You have a new booking.\nCheck-in: 12 Jan 2027\nCheck-out: 15 Jan 2027',
        }),
        options,
      ),
    ).toMatchObject({ kind: 'unreadable', reason: 'no booking reference could be found' });
    expect(
      readReservationEmail(
        message({
          subject: 'New booking 4521887766',
          text: 'Booking number: 4521887766\nSee the extranet for details.',
        }),
        options,
      ),
    ).toMatchObject({ kind: 'unreadable', reason: 'the stay dates could not be found' });
    expect(
      readReservationEmail(
        message({
          subject: 'New booking 4521887766',
          text: 'Booking number: 4521887766\nCheck-in: 15 Jan 2027\nCheck-out: 12 Jan 2027',
        }),
        options,
      ),
    ).toMatchObject({ kind: 'unreadable', reason: expect.stringMatching(/do not make sense/) });
  });

  it('leaves other mail alone', () => {
    expect(
      readReservationEmail(
        message({
          subject: 'Your monthly invoice is ready',
          text: 'Commission invoice for December is attached.',
        }),
        options,
      ),
    ).toEqual({ kind: 'other' });
    // From a stranger, a mention of a booking in passing is not enough.
    expect(
      readReservationEmail(
        message({
          from: 'guest@gmail.example',
          fromName: 'A Guest',
          subject: 'Question about parking',
          text: 'Hi, about my reservation number 12345678: is parking free?',
        }),
        options,
      ),
    ).toEqual({ kind: 'other' });
  });
});

describe('from email to booking event', () => {
  const notice = (overrides: Partial<EmailMessage> = {}) =>
    message({
      subject: 'New booking 4521887766',
      text: [
        'Booking number: 4521887766',
        'Guest name: Lena Fischer',
        'Check-in: 12 Jan 2027',
        'Check-out: 15 Jan 2027',
        'Room type: Deluxe Sea View Room',
        'Number of rooms: 2',
        'Adults: 3',
        'Total price: INR 21,001.00',
      ].join('\n'),
      ...overrides,
    });

  it('describes the booking for the pipeline, marked for a person to check', () => {
    const event = emailToEvent(notice(), options)!;
    expect(event).toMatchObject({
      revisionId: 'email:m1@example.com',
      bookingId: 'BDC:4521887766',
      status: 'new',
      channelCode: 'BDC',
      channelReservationCode: '4521887766',
      currency: 'INR',
      totalAmount: 2_100_100,
      guest: { firstName: 'Lena', lastName: 'Fischer' },
      needsReview: 'Read from an email from Booking.com. Check the details against Booking.com.',
    });
    expect(event.revisionAt).toEqual(new Date('2027-01-05T10:00:00Z'));
    expect(event.rooms).toHaveLength(2);
    expect(event.rooms[0]).toMatchObject({
      externalRoomTypeId: 'deluxe sea view room',
      externalRoomName: 'Deluxe Sea View Room',
      checkIn: '2027-01-12',
      checkOut: '2027-01-15',
      adults: 2,
      // The odd minor unit of the split total stays on the first room.
      amount: 1_050_050,
    });
    expect(event.rooms[1]).toMatchObject({ adults: 2, amount: 1_050_050 });
    expect(event.rooms[0]!.amount! + event.rooms[1]!.amount!).toBe(2_100_100);
    // Enough of the email is kept to read it again; the event itself has no raw card or message data.
    expect(event.raw).toMatchObject({
      subject: 'New booking 4521887766',
      from: 'noreply@booking.com',
    });
  });

  it('records a new booking from an unverified sender, saying so, but will not change or cancel on its word', () => {
    const unverified = emailToEvent(notice({ authentication: 'none' }), options)!;
    expect(unverified.unreadable).toBeUndefined();
    expect(unverified.needsReview).toMatch(/could not confirm who sent the email/);

    const cancel = emailToEvent(
      message({
        authentication: 'none',
        subject: 'Cancellation: booking 4521887766',
        text: 'The guest has cancelled.\nBooking number: 4521887766',
      }),
      options,
    )!;
    expect(cancel.unreadable).toMatch(
      /asks to cancel booking 4521887766.*could not confirm who sent it/,
    );
    expect(cancel.rooms).toEqual([]);

    // Unless the property has chosen to trust such mail.
    const trusted = emailToEvent(
      message({
        authentication: 'none',
        subject: 'Cancellation: booking 4521887766',
        text: 'The guest has cancelled.\nBooking number: 4521887766',
      }),
      { ...options, trustUnverifiedSenders: true },
    )!;
    expect(trusted).toMatchObject({ status: 'cancelled', bookingId: 'BDC:4521887766' });
    expect(trusted.unreadable).toBeUndefined();
  });

  it('does nothing with mail that failed the sender checks, whatever it says', () => {
    const forged = emailToEvent(notice({ authentication: 'fail' }), {
      ...options,
      trustUnverifiedSenders: true,
    })!;
    expect(forged.unreadable).toMatch(/may be forged/);
    expect(forged.rooms).toEqual([]);
  });

  it('passes on a notice it cannot read, for a person to handle', () => {
    const event = emailToEvent(
      message({ subject: 'New booking', text: 'You have a new booking. See the extranet.' }),
      options,
    )!;
    expect(event.unreadable).toBe(
      'An email from Booking.com ("New booking") looks like a booking notice, but no booking reference could be found. Open the email and enter the booking by hand.',
    );
    expect(
      emailToEvent(message({ subject: 'Invoice', text: 'Your invoice.' }), options),
    ).toBeNull();
  });

  describe('with a second reader', () => {
    const vague = (overrides: Partial<EmailMessage> = {}) =>
      message({
        subject: 'New booking',
        text: 'Great news! Lena Fischer is coming from the 12th to the 15th of January. Ref 998877.',
        ...overrides,
      });
    const reading: FallbackReading = {
      status: 'new',
      reference: '998877',
      guestName: 'Lena Fischer',
      guestEmail: null,
      guestPhone: null,
      checkIn: '2027-01-12',
      checkOut: '2027-01-15',
      roomName: 'Deluxe Sea View Room',
      rooms: 1,
      adults: 2,
      children: null,
      currency: 'INR',
      totalAmount: 945_000,
      notes: null,
    };
    const asked: { subject: string; context: unknown }[] = [];
    let answer: FallbackReading | null | Error = reading;

    beforeEach(() => {
      asked.length = 0;
      answer = reading;
      setEmailFallbackReader(async (email, context) => {
        asked.push({ subject: email.subject, context });
        if (answer instanceof Error) throw answer;
        return answer;
      });
    });
    afterEach(() => setEmailFallbackReader(null));

    it('gives it only the notices the patterns could not read, and marks what it read', async () => {
      const event = (await emailToEventWithFallback(vague(), options, { orgId: 'org-1' }))!;
      expect(event).toMatchObject({
        bookingId: 'BDC:998877',
        status: 'new',
        channelCode: 'BDC',
        totalAmount: 945_000,
        guest: { firstName: 'Lena', lastName: 'Fischer' },
      });
      expect(event.unreadable).toBeUndefined();
      expect(event.rooms).toHaveLength(1);
      expect(event.needsReview).toBe(
        'The usual reader could not make out this email, so the AI service read it. Read from an email from Booking.com. Check the details against Booking.com.',
      );
      expect(asked).toEqual([
        {
          subject: 'New booking',
          context: { orgId: 'org-1', channelName: 'Booking.com', defaultCurrency: 'INR' },
        },
      ]);

      // What the patterns can read, and what is not about a booking, never reaches it.
      asked.length = 0;
      const readable = await emailToEventWithFallback(
        message({
          subject: 'New booking 4521887766',
          text: 'Booking number: 4521887766\nCheck-in: 12 Jan 2027\nCheck-out: 15 Jan 2027',
        }),
        options,
        { orgId: 'org-1' },
      );
      expect(readable).toMatchObject({ bookingId: 'BDC:4521887766' });
      expect(
        await emailToEventWithFallback(
          message({ subject: 'Invoice', text: 'Your invoice.' }),
          options,
          { orgId: 'org-1' },
        ),
      ).toBeNull();
      expect(asked).toEqual([]);
    });

    it('holds what it read to the same sender checks', async () => {
      const forged = (await emailToEventWithFallback(vague({ authentication: 'fail' }), options, {
        orgId: 'org-1',
      }))!;
      expect(forged.unreadable).toMatch(/may be forged/);
      expect(forged.rooms).toEqual([]);

      answer = { ...reading, status: 'cancelled', checkIn: null, checkOut: null };
      const cancel = (await emailToEventWithFallback(vague({ authentication: 'none' }), options, {
        orgId: 'org-1',
      }))!;
      expect(cancel.unreadable).toMatch(/asks to cancel booking 998877.*could not confirm/);
    });

    it('leaves the email for a person when it cannot read it either, or is down', async () => {
      const byHand =
        'An email from Booking.com ("New booking") looks like a booking notice, but no booking reference could be found. Open the email and enter the booking by hand.';
      answer = null;
      expect(
        (await emailToEventWithFallback(vague(), options, { orgId: 'org-1' }))!.unreadable,
      ).toBe(byHand);
      answer = new Error('The AI service is not answering');
      expect(
        (await emailToEventWithFallback(vague(), options, { orgId: 'org-1' }))!.unreadable,
      ).toBe(byHand);
      expect(asked).toHaveLength(2);
    });
  });
});

describe('raw messages', () => {
  it('reads a multipart message, preferring its plain text, and notes the sender checks', async () => {
    const raw = [
      'From: "Booking.com" <noreply@booking.com>',
      'To: reservations@seabreeze.example',
      'Subject: =?UTF-8?B?TmV3IGJvb2tpbmcgNDUyMTg4Nzc2Ng==?=',
      'Message-ID: <abc123@booking.com>',
      'Date: Tue, 05 Jan 2027 10:00:00 +0000',
      'Authentication-Results: mx.seabreeze.example; dkim=pass header.d=booking.com; spf=pass smtp.mailfrom=booking.com; dmarc=pass',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Booking number: 4521887766',
      'Check-in: 12 Jan 2027',
      'Check-out: 15 Jan 2027',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Booking number: <b>4521887766</b></p>',
      '--b1--',
      '',
    ].join('\r\n');
    const parsed = await parseMime(raw);
    expect(parsed).toMatchObject({
      messageId: 'abc123@booking.com',
      from: 'noreply@booking.com',
      fromName: 'Booking.com',
      to: ['reservations@seabreeze.example'],
      subject: 'New booking 4521887766',
      authentication: 'pass',
    });
    expect(parsed.text).toBe(
      'Booking number: 4521887766\nCheck-in: 12 Jan 2027\nCheck-out: 15 Jan 2027',
    );
    expect(parsed.date).toEqual(new Date('2027-01-05T10:00:00Z'));
  });

  it('falls back to the HTML part, and identifies a message without an id by its content', async () => {
    const raw = [
      'From: automated@airbnb.com',
      'To: host@example.com',
      'Subject: Reservation confirmed',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<table><tr><td>Confirmation code</td><td>HMQ2X7Y9ZT</td></tr></table>',
      '',
    ].join('\r\n');
    const first = await parseMime(raw);
    const second = await parseMime(raw);
    expect(first.text).toBe('Confirmation code\tHMQ2X7Y9ZT');
    expect(first.authentication).toBe('none');
    expect(first.messageId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.messageId).toBe(first.messageId);
  });
});
