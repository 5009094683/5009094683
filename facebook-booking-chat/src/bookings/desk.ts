import { randomInt } from 'node:crypto';
import {
  type Business,
  type Lang,
  type Service,
  type ServiceOption,
  findOption,
  findService,
} from '../business/schema';
import { type IsoDate, addDays } from '../nlu/dates';
import type { Booking, Store } from '../store';
import { quoteFor } from './pricing';

/** 'unknown': the settings give no capacity, so only a person can tell. */
export type Availability =
  { state: 'available'; left: number } | { state: 'full'; left: number } | { state: 'unknown' };

export interface BookingRequest {
  threadId: string;
  lang: Lang;
  serviceId: string;
  optionId: string;
  startDate: IsoDate;
  days: number;
  quantity: number;
  customerName: string;
  phone: string | null;
  pickup: string | null;
}

export type PlaceResult =
  { ok: true; booking: Booking } | { ok: false; reason: 'full'; left: number };

export class BookingError extends Error {
  constructor(
    readonly reason: 'not_found' | 'wrong_state' | 'unknown_service',
    message: string,
  ) {
    super(message);
  }
}

// No 0/O, 1/I/L: a customer reads the number back from a screen.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Takes bookings in and moves them through their states. */
export class Desk {
  constructor(
    private readonly store: Store,
    private readonly business: Business,
    private readonly now: () => number = Date.now,
  ) {}

  private resolve(
    serviceId: string,
    optionId: string,
  ): { service: Service; option: ServiceOption } {
    const service = findService(this.business, serviceId);
    const option = service ? findOption(service, optionId) : undefined;
    if (!service || !option) {
      throw new BookingError('unknown_service', `Nothing to book as ${serviceId} / ${optionId}`);
    }
    return { service, option };
  }

  /** Whether `quantity` more can be taken for every day of the period. */
  availability(
    serviceId: string,
    optionId: string,
    startDate: IsoDate,
    days: number,
    quantity: number,
    exceptCode: string | null = null,
  ): Availability {
    const { option } = this.resolve(serviceId, optionId);
    if (option.capacity === null) return { state: 'unknown' };
    const period = Array.from({ length: days }, (_, i) => addDays(startDate, i));
    const taken = this.store.bookings.peakTaken(serviceId, optionId, period, exceptCode);
    const left = Math.max(0, option.capacity - taken);
    return left >= quantity ? { state: 'available', left } : { state: 'full', left };
  }

  /**
   * Records a booking the customer has agreed to. It is confirmed at once when
   * the service confirms by itself and there is room; it is refused when there
   * is known to be no room; otherwise it waits for a person.
   */
  place(request: BookingRequest): PlaceResult {
    const { service, option } = this.resolve(request.serviceId, request.optionId);
    return this.store.transaction((): PlaceResult => {
      const availability = this.availability(
        request.serviceId,
        request.optionId,
        request.startDate,
        request.days,
        request.quantity,
      );
      if (availability.state === 'full') {
        return { ok: false, reason: 'full', left: availability.left };
      }

      const quote = quoteFor(service, option, request.days, request.quantity);
      const automatic =
        service.autoConfirm && availability.state === 'available' && quote.total !== null;
      const booking = this.store.bookings.insert({
        code: this.newCode(),
        threadId: request.threadId,
        status: automatic ? 'confirmed' : 'pending',
        serviceId: service.id,
        serviceKind: service.kind,
        serviceName: service.name[request.lang],
        optionId: option.id,
        optionName: option.name[request.lang],
        startDate: request.startDate,
        days: request.days,
        endDate: addDays(request.startDate, request.days - 1),
        quantity: request.quantity,
        customerName: request.customerName,
        phone: request.phone,
        pickup: request.pickup,
        unitPrice: quote.unitPrice,
        totalPrice: quote.total,
        depositPercent: service.depositPercent,
        lang: request.lang,
        confirmedBy: automatic ? 'auto' : null,
        staffNote: null,
        createdAt: this.now(),
      });
      return { ok: true, booking };
    });
  }

  /** A person confirms a waiting booking, with the price if it was not set or has changed. */
  confirm(code: string, totalPrice: number | null = null): Booking {
    const booking = this.mustBe(code, ['pending']);
    const setByHand = totalPrice !== null && totalPrice !== booking.totalPrice;
    return this.store.bookings.update(
      booking.code,
      {
        status: 'confirmed',
        confirmedBy: 'staff',
        totalPrice: totalPrice ?? booking.totalPrice,
        // A total set by hand no longer follows from the unit price.
        unitPrice: setByHand ? null : booking.unitPrice,
      },
      this.now(),
    );
  }

  decline(code: string, note: string): Booking {
    const booking = this.mustBe(code, ['pending']);
    return this.store.bookings.update(
      booking.code,
      { status: 'declined', staffNote: note.trim() || null },
      this.now(),
    );
  }

  cancel(code: string, note: string): Booking {
    const booking = this.mustBe(code, ['pending', 'confirmed']);
    return this.store.bookings.update(
      booking.code,
      { status: 'cancelled', staffNote: note.trim() || null },
      this.now(),
    );
  }

  private mustBe(code: string, states: Array<Booking['status']>): Booking {
    const booking = this.store.bookings.get(code);
    if (!booking) throw new BookingError('not_found', `There is no booking ${code}.`);
    if (!states.includes(booking.status)) {
      throw new BookingError(
        'wrong_state',
        `Booking ${booking.code} is ${booking.status}; this can only be done while it is ${states.join(' or ')}.`,
      );
    }
    return booking;
  }

  private newCode(): string {
    for (;;) {
      let suffix = '';
      for (let i = 0; i < 5; i += 1) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const code = `${this.business.booking.codePrefix}-${suffix}`;
      if (!this.store.bookings.exists(code)) return code;
    }
  }
}
