import { depositOf, quoteFor } from '../bookings/pricing';
import {
  type Business,
  type Lang,
  type Service,
  type ServiceOption,
  findService,
} from '../business/schema';
import { addDays } from '../nlu/dates';
import type { Booking } from '../store';
import type { BookingView } from './wording';
import { WORDING } from './wording';

/** A booking being put together, with every detail known, as the messages show it. */
export function viewOfDraft(
  lang: Lang,
  service: Service,
  option: ServiceOption,
  details: {
    startDate: string;
    days: number;
    quantity: number;
    name: string;
    phone: string | null;
    pickup: string | null;
  },
): BookingView {
  const quote = quoteFor(service, option, details.days, details.quantity);
  return {
    code: null,
    kind: service.kind,
    serviceName: service.name[lang],
    optionName: service.options.length > 1 ? option.name[lang] : null,
    startDate: details.startDate,
    endDate: addDays(details.startDate, details.days - 1),
    days: details.days,
    quantity: details.quantity,
    name: details.name,
    phone: details.phone,
    pickup: details.pickup,
    unitPrice: quote.unitPrice,
    total: quote.total,
    depositPercent: quote.depositPercent,
    deposit: quote.deposit,
  };
}

/** A recorded booking as the messages show it. */
export function viewOfBooking(booking: Booking, business: Business): BookingView {
  const service = findService(business, booking.serviceId);
  return {
    code: booking.code,
    kind: booking.serviceKind,
    serviceName: booking.serviceName,
    optionName: !service || service.options.length > 1 ? booking.optionName : null,
    startDate: booking.startDate,
    endDate: booking.endDate,
    days: booking.days,
    quantity: booking.quantity,
    name: booking.customerName,
    phone: booking.phone,
    pickup: booking.pickup,
    unitPrice: booking.unitPrice,
    total: booking.totalPrice,
    depositPercent: booking.depositPercent,
    deposit: depositOf(booking.totalPrice, booking.depositPercent),
  };
}

/** What the customer is told when a booking is taken, confirmed, declined or cancelled. */
export function bookingMessage(booking: Booking, business: Business): string {
  const wording = WORDING[booking.lang];
  switch (booking.status) {
    case 'pending':
      return wording.bookingReceived(viewOfBooking(booking, business));
    case 'confirmed':
      return wording.bookingConfirmed(
        viewOfBooking(booking, business),
        business,
        findService(business, booking.serviceId),
      );
    case 'declined':
      return wording.bookingDeclined(booking.code, booking.staffNote);
    case 'cancelled':
      return wording.bookingCancelled(booking.code, booking.staffNote);
  }
}
