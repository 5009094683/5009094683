import type { Business, Service, ServiceKind } from '../../business/schema';
import type { IsoDate } from '../../nlu/dates';
import type { Booking, BookingStatus } from '../../store';

/** A booking, or one being put together, as the messages show it. */
export interface BookingView {
  code: string | null;
  kind: ServiceKind;
  serviceName: string;
  /** null when the service has a single option and naming it adds nothing. */
  optionName: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  days: number;
  quantity: number;
  name: string;
  phone: string | null;
  pickup: string | null;
  unitPrice: number | null;
  total: number | null;
  depositPercent: number;
  deposit: number | null;
}

/**
 * Every sentence the assistant says to a customer, in one language.
 *
 * To change the wording, edit en.ts and vi.ts. The functions get the facts
 * (names, dates, amounts) and return the text; plain line breaks, no markup,
 * because Messenger shows the text as it is.
 */
export interface Wording {
  welcome(business: Business): string;
  /** Put before the first answer when the customer did not open with a greeting. */
  intro(business: Business): string;
  askService(business: Business): string;
  askOption(service: Service): string;
  askStartDate(kind: ServiceKind): string;
  askDays(kind: ServiceKind): string;
  askQuantity(kind: ServiceKind): string;
  askName(): string;
  askPhone(): string;
  askPickup(kind: ServiceKind): string;

  summary(view: BookingView): string;
  remindConfirm(): string;
  whatToChange(kind: ServiceKind): string;

  bookingReceived(view: BookingView): string;
  bookingConfirmed(view: BookingView, business: Business, service: Service | undefined): string;
  bookingDeclined(code: string, note: string | null): string;
  bookingCancelled(code: string, note: string | null): string;

  prices(service: Service): string;
  offerToBook(): string;
  included(service: Service): string;
  payment(business: Business): string;
  cancellation(business: Business): string;
  /** One service's cancellation terms in a sentence, or '' when it has none. */
  cancellationOf(service: Service): string;
  documents(): string;
  contact(business: Business): string;
  location(business: Business): string;

  status(bookings: Booking[]): string;
  statusWord(status: BookingStatus): string;
  noBookings(): string;

  handoff(business: Business): string;
  handoffConfused(business: Business): string;
  needsPerson(business: Business): string;
  discount(): string;
  cancelRequest(booking: Booking | null, terms: string): string;
  changeRequest(booking: Booking | null): string;

  notUnderstood(business: Business): string;
  sorry(): string;
  draftDropped(): string;
  dateInPast(date: IsoDate): string;
  dateTooFar(maxAdvanceDays: number): string;
  full(kind: ServiceKind, left: number): string;
  attachmentOnly(): string;
  thanks(): string;
  bye(): string;
}
