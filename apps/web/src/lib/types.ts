import type {
  AlertRow,
  AvailabilityDay,
  BlockResult,
  BlockRow,
  CalendarBlock,
  CalendarDay,
  CalendarProperty,
  CalendarRoomType,
  CalendarStay,
  CalendarUnit,
  CalendarView,
  EffectiveRateDay,
  Grant,
  OidcProviderView,
  OrganizationView,
  PropertyConfig,
  PropertyRow,
  RatePlanRow,
  ReservationDetail,
  ReservationRoomView,
  RoomChangeResult,
  RoomTypeRow,
  StayQuote,
  UnitRow,
  UserListItem,
  guestView,
} from '@pms/domain';
import type { Permission } from '@pms/domain/shared';

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

export type Property = Serialized<PropertyRow>;
export type RoomType = Serialized<RoomTypeRow>;
export type Unit = Serialized<UnitRow>;
export type RatePlan = Serialized<RatePlanRow>;
export type PropertyDetail = Serialized<PropertyConfig> & {
  /** The property's page on the booking site, while guests can book it there. */
  bookingSiteUrl?: string | null;
};
export type Reservation = Serialized<ReservationDetail>;
export type ReservationRoom = Serialized<ReservationRoomView>;
export type Block = Serialized<BlockRow>;
export type BlockSaved = Serialized<BlockResult>;
export type RoomChange = Serialized<RoomChangeResult>;
export type Alert = Serialized<AlertRow>;
export type Calendar = Serialized<CalendarView>;
export type CalProperty = Serialized<CalendarProperty>;
export type CalRoomType = Serialized<CalendarRoomType>;
export type CalUnit = Serialized<CalendarUnit>;
export type CalDay = Serialized<CalendarDay>;
export type CalStay = Serialized<CalendarStay>;
export type CalBlock = Serialized<CalendarBlock>;
export type RateDay = Serialized<EffectiveRateDay>;
export type Availability = Serialized<AvailabilityDay>;
export type Quote = Serialized<StayQuote>;
export type Guest = Serialized<ReturnType<typeof guestView>>;
export type UserItem = Serialized<UserListItem>;
export type Organization = Serialized<OrganizationView>;
export type SsoProvider = Serialized<OidcProviderView>;
export type { Grant, Permission };

export interface Me {
  user: { id: string; orgId: string; email: string; name: string; twoFactorEnabled: boolean };
  organization: { id: string; name: string } | null;
  grants: (Grant & { roleLabel: string })[];
  permissions: Permission[];
  authMethod: 'password' | 'oidc';
  mfaPending: boolean;
  mustEnrollTwoFactor: boolean;
  expiresAt: string;
}

export interface LiveEvent {
  id: number;
  kind: string;
  orgId: string;
  propertyId: string | null;
  payload?: Record<string, unknown>;
}
