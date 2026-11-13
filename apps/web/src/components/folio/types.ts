import type {
  ChargeKind as DomainChargeKind,
  CompanyView,
  FolioLineRow,
  FolioView,
  InvoiceRow,
  PaymentRow,
} from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Folio = Serialized<FolioView>;
export type FolioLine = Serialized<FolioLineRow>;
export type Payment = Serialized<PaymentRow>;
export type Invoice = Serialized<InvoiceRow>;
export type Company = Serialized<CompanyView>;

export type ChargeKind = DomainChargeKind;
/** What a charge can be, and what a discount can be taken off: the kinds that have a tax rule. */
export type TaxedKind = Exclude<ChargeKind, 'discount'>;
export type PaymentMethod = Payment['method'];
export type BillTo = Folio['billTo'];

/** What `GET /reservations/:id/folios` answers. */
export interface ReservationFolios {
  folios: Folio[];
  /** Owed across all the folios. Negative when the guest is in credit. */
  balance: number;
  invoices: Invoice[];
}
