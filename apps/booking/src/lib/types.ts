import type {
  BookingRequest,
  BookingResult,
  CancellationTerms,
  CheckinDocument,
  CheckinForm,
  GuestBooking,
  GuestCancellation,
  GuestCheckin,
  IdType,
  PlanOffer,
  PublicProperty,
  PublicPropertyDetail,
  PublicRoomType,
  StayOffer,
  StaySearch,
} from '@pms/domain';

/**
 * What a server type looks like after it has been through JSON: dates arrive
 * as ISO strings. API response types are the domain's own types, so the two
 * sides cannot drift apart unnoticed.
 */
export type Serialized<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

export type Property = Serialized<PublicProperty>;
export type PropertyDetail = Serialized<PublicPropertyDetail>;
export type RoomType = Serialized<PublicRoomType>;
export type Stay = Serialized<StaySearch>;
export type Offer = Serialized<StayOffer>;
export type Plan = Serialized<PlanOffer>;
export type Cancellation = Serialized<CancellationTerms>;
export type MealPlan = Plan['mealPlan'];
export type Promo = NonNullable<Stay['promo']>;

export type BookingBody = BookingRequest & { org?: string };
export type Booked = Serialized<BookingResult>;
export type Booking = Serialized<GuestBooking>;
export type BookingStatus = Booking['status'];
export type Cancelled = Serialized<GuestCancellation>;

export type Checkin = Serialized<GuestCheckin>;
export type CheckinGuestSaved = Checkin['guests'][number];
export type CheckinBody = CheckinForm;
export type CheckinGuestBody = CheckinForm['guests'][number];
export type CheckinFile = Serialized<CheckinDocument>;
export type { IdType };

export interface PropertyList {
  organisation: { name: string; slug: string };
  properties: Property[];
}

/** A payment the property asked the guest for, as `GET /public/bookings/:token/pay/:orderId` returns it. */
export interface PaymentRequest {
  bookingCode: string;
  guestName: string;
  propertyName: string;
  amount: number;
  currency: string;
  description: string | null;
  status: 'created' | 'paid' | 'failed' | 'expired' | 'cancelled';
  checkoutUrl: string | null;
  expiresAt: string;
}
