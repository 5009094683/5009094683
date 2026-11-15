import type { Lang, ServiceKind } from '../business/schema';
import type { IsoDate } from '../nlu/dates';
import type { Db } from './db';

export type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';
export const BOOKING_STATUSES: BookingStatus[] = ['pending', 'confirmed', 'declined', 'cancelled'];

/** Bookings in these states hold their motorbikes, drivers or seats. */
const HOLDING: BookingStatus[] = ['pending', 'confirmed'];

export interface Booking {
  id: number;
  code: string;
  threadId: string;
  status: BookingStatus;
  serviceId: string;
  serviceKind: ServiceKind;
  serviceName: string;
  optionId: string;
  optionName: string;
  startDate: IsoDate;
  days: number;
  endDate: IsoDate;
  quantity: number;
  customerName: string;
  phone: string | null;
  pickup: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  depositPercent: number;
  lang: Lang;
  confirmedBy: 'auto' | 'staff' | null;
  staffNote: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewBooking = Omit<Booking, 'id' | 'updatedAt'>;

interface Row {
  id: number;
  code: string;
  thread_id: string;
  status: string;
  service_id: string;
  service_kind: string;
  service_name: string;
  option_id: string;
  option_name: string;
  start_date: string;
  days: number;
  end_date: string;
  quantity: number;
  customer_name: string;
  phone: string | null;
  pickup: string | null;
  unit_price: number | null;
  total_price: number | null;
  deposit_percent: number;
  lang: string;
  confirmed_by: string | null;
  staff_note: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow(row: Row): Booking {
  return {
    id: row.id,
    code: row.code,
    threadId: row.thread_id,
    status: row.status as BookingStatus,
    serviceId: row.service_id,
    serviceKind: row.service_kind as ServiceKind,
    serviceName: row.service_name,
    optionId: row.option_id,
    optionName: row.option_name,
    startDate: row.start_date,
    days: row.days,
    endDate: row.end_date,
    quantity: row.quantity,
    customerName: row.customer_name,
    phone: row.phone,
    pickup: row.pickup,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    depositPercent: row.deposit_percent,
    lang: row.lang === 'vi' ? 'vi' : 'en',
    confirmedBy: row.confirmed_by as Booking['confirmedBy'],
    staffNote: row.staff_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Bookings {
  constructor(private readonly db: Db) {}

  insert(booking: NewBooking): Booking {
    this.db
      .prepare(
        `INSERT INTO bookings (
           code, thread_id, status, service_id, service_kind, service_name, option_id, option_name,
           start_date, days, end_date, quantity, customer_name, phone, pickup, unit_price,
           total_price, deposit_percent, lang, confirmed_by, staff_note, created_at, updated_at
         ) VALUES (
           @code, @threadId, @status, @serviceId, @serviceKind, @serviceName, @optionId, @optionName,
           @startDate, @days, @endDate, @quantity, @customerName, @phone, @pickup, @unitPrice,
           @totalPrice, @depositPercent, @lang, @confirmedBy, @staffNote, @createdAt, @createdAt
         )`,
      )
      .run(booking);
    return this.get(booking.code)!;
  }

  get(code: string): Booking | undefined {
    const row = this.db
      .prepare('SELECT * FROM bookings WHERE code = ? COLLATE NOCASE')
      .get(code) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  exists(code: string): boolean {
    return this.db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code) !== undefined;
  }

  update(
    code: string,
    changes: Partial<
      Pick<Booking, 'status' | 'unitPrice' | 'totalPrice' | 'confirmedBy' | 'staffNote'>
    >,
    now: number,
  ): Booking {
    const current = this.get(code);
    if (!current) throw new Error(`No booking ${code}`);
    const next = { ...current, ...changes };
    this.db
      .prepare(
        `UPDATE bookings
            SET status = ?, unit_price = ?, total_price = ?, confirmed_by = ?, staff_note = ?,
                updated_at = ?
          WHERE code = ?`,
      )
      .run(next.status, next.unitPrice, next.totalPrice, next.confirmedBy, next.staffNote, now, current.code); // prettier-ignore
    return this.get(current.code)!;
  }

  /** A customer's bookings, newest first. */
  ofThread(threadId: string): Booking[] {
    const rows = this.db
      .prepare('SELECT * FROM bookings WHERE thread_id = ? ORDER BY id DESC')
      .all(threadId) as Row[];
    return rows.map(fromRow);
  }

  list(status?: BookingStatus, limit = 500): Booking[] {
    const rows = (
      status
        ? this.db
            .prepare('SELECT * FROM bookings WHERE status = ? ORDER BY start_date, id LIMIT ?')
            .all(status, limit)
        : this.db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT ?').all(limit)
    ) as Row[];
    return rows.map(fromRow);
  }

  counts(): Record<BookingStatus, number> {
    const counts: Record<BookingStatus, number> = { pending: 0, confirmed: 0, declined: 0, cancelled: 0 }; // prettier-ignore
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status')
      .all() as Array<{ status: BookingStatus; n: number }>;
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /**
   * The most units of one option that are taken on any single day of a period,
   * by bookings that are waiting or confirmed. `exceptCode` leaves one booking
   * out: the one being looked at.
   */
  peakTaken(
    serviceId: string,
    optionId: string,
    days: IsoDate[],
    exceptCode: string | null = null,
  ): number {
    const statement = this.db.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS n FROM bookings
        WHERE service_id = ? AND option_id = ?
          AND status IN (${HOLDING.map(() => '?').join(', ')})
          AND start_date <= ? AND end_date >= ?
          AND code <> COALESCE(?, '')`,
    );
    let peak = 0;
    for (const day of days) {
      const row = statement.get(serviceId, optionId, ...HOLDING, day, day, exceptCode) as { n: number }; // prettier-ignore
      peak = Math.max(peak, row.n);
    }
    return peak;
  }
}
