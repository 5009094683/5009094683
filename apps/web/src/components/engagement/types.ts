import type {
  GuestBooking,
  PaymentOrderRow,
  ReservationTemplate as DomainReservationTemplate,
  StaffCheckin,
  sendTemplate,
} from '@pms/domain';
import type { Serialized } from '@/lib/types';

/** A request for an online payment. `payUrl` is where the guest pays, while it can still be paid. */
export type PaymentOrder = Serialized<PaymentOrderRow> & { payUrl?: string | null };

/** A payment link just made, with what became of sending it when that was asked for. */
export type NewPaymentLink = PaymentOrder & {
  payUrl: string;
  sent: { channel: string | null; problems: string[] } | null;
};

export type Checkin = Serialized<StaffCheckin>;
export type CheckinPerson = Checkin['guests'][number];
export type CheckinFile = Checkin['documents'][number];

/** Where the guest sees the booking, and where they check in online. */
export interface GuestLinks {
  url: string;
  checkInUrl: string;
}

export type SendResult = Serialized<Awaited<ReturnType<typeof sendTemplate>>>;

/** A template as the server would send it about one reservation. */
export type ReservationTemplate = Serialized<DomainReservationTemplate>;

export interface ReservationTemplates {
  templates: ReservationTemplate[];
  /** What each placeholder stands for with this booking, as the server works it out. */
  values: Record<string, string>;
}

/** What the stay costs with tax and what has been paid, as the guest's own page shows it. */
export type StayMoney = Pick<Serialized<GuestBooking>, 'total' | 'paid' | 'balance' | 'currency'>;
