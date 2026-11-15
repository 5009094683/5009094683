import { beforeEach, describe, expect, it } from 'vitest';
import { TestClock, demoBusiness, memoryStore } from '../../test/helpers';
import type { Store } from '../store';
import { type BookingRequest, BookingError, Desk } from './desk';
import { depositOf, formatMoney, quoteFor } from './pricing';

const business = demoBusiness();
const rental = business.services[0]!;
const tour = business.services[1]!;
const easyRider = business.services[2]!;

let store: Store;
let clock: TestClock;
let desk: Desk;

function request(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    threadId: 't1',
    lang: 'en',
    serviceId: 'motorbike-rental',
    optionId: 'honda-xr150',
    startDate: '2026-11-20',
    days: 3,
    quantity: 1,
    customerName: 'John Smith',
    phone: '+44 7700 900123',
    pickup: null,
    ...overrides,
  };
}

function place(overrides: Partial<BookingRequest> = {}) {
  const result = desk.place(request(overrides));
  if (!result.ok) throw new Error('expected the booking to be taken');
  return result.booking;
}

beforeEach(() => {
  store = memoryStore();
  clock = new TestClock();
  desk = new Desk(store, business, clock.now);
  store.conversations.open('t1', 'en', clock.now());
  store.conversations.open('t2', 'en', clock.now());
});

describe('prices', () => {
  it('charges rentals and Easy Rider per unit per day, tours per person', () => {
    expect(quoteFor(rental, rental.options[0]!, 3, 2).total).toBe(150_000 * 3 * 2);
    expect(quoteFor(easyRider, easyRider.options[0]!, 2, 2).total).toBe(1_300_000 * 2 * 2);
    expect(quoteFor(tour, tour.options[1]!, 3, 2).total).toBe(4_500_000 * 2);
  });

  it('works out the deposit from the service', () => {
    expect(quoteFor(tour, tour.options[0]!, 1, 2)).toMatchObject({
      total: 2_400_000,
      depositPercent: 30,
      deposit: 720_000,
    });
    expect(quoteFor(rental, rental.options[0]!, 1, 1).deposit).toBeNull();
    expect(depositOf(1_234_567, 30)).toBe(370_000);
    expect(depositOf(null, 30)).toBeNull();
  });

  it('leaves the price open when the settings have none', () => {
    const open = demoBusiness((s) => {
      s.services[1]!.options[0]!.price = null;
    }).services[1]!;
    expect(quoteFor(open, open.options[0]!, 1, 2)).toMatchObject({ unitPrice: null, total: null });
  });

  it('writes money the way each language does', () => {
    expect(formatMoney(1_500_000, 'en')).toBe('1,500,000 VND');
    expect(formatMoney(1_500_000, 'vi')).toBe('1.500.000 VND');
    expect(formatMoney(900, 'en')).toBe('900 VND');
  });
});

describe('placing a booking', () => {
  it('confirms at once where the service confirms by itself and there is room', () => {
    const booking = place();
    expect(booking).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'auto',
      code: expect.stringMatching(/^CB-[A-Z2-9]{5}$/),
      serviceName: 'Motorbike rental',
      optionName: 'Honda XR 150 (manual)',
      startDate: '2026-11-20',
      endDate: '2026-11-22',
      unitPrice: 400_000,
      totalPrice: 1_200_000,
    });
  });

  it('leaves a booking waiting where a person confirms', () => {
    const booking = place({ serviceId: 'tour-package', optionId: 'ban-gioc-day', days: 1, quantity: 2 }); // prettier-ignore
    expect(booking).toMatchObject({
      status: 'pending',
      confirmedBy: null,
      totalPrice: 2_400_000,
      depositPercent: 30,
    });
  });

  it('keeps the names in the language of the customer', () => {
    const booking = place({ lang: 'vi' });
    expect(booking).toMatchObject({ serviceName: 'Thuê xe máy', lang: 'vi' });
  });

  it('refuses what is known to be full, and says how many are left', () => {
    place({ quantity: 1 });
    // The XR 150 has two; one is out from the 20th to the 22nd.
    expect(desk.place(request({ quantity: 2 }))).toEqual({ ok: false, reason: 'full', left: 1 });
    expect(desk.place(request({ quantity: 1, threadId: 't2' })).ok).toBe(true);
    expect(desk.place(request({ quantity: 1, threadId: 't2' }))).toEqual({
      ok: false,
      reason: 'full',
      left: 0,
    });
  });

  it('counts each day of a booking, and only those days', () => {
    place({ quantity: 2, startDate: '2026-11-20', days: 3 });
    const at = (startDate: string, days: number) =>
      desk.availability('motorbike-rental', 'honda-xr150', startDate, days, 1).state;
    expect(at('2026-11-19', 1)).toBe('available');
    expect(at('2026-11-19', 2)).toBe('full');
    expect(at('2026-11-22', 1)).toBe('full');
    expect(at('2026-11-23', 5)).toBe('available');
    // Other models are not touched.
    expect(desk.availability('motorbike-rental', 'honda-wave', '2026-11-20', 3, 6).state).toBe(
      'available',
    );
  });

  it('holds room for bookings that wait, and frees it when they are declined or cancelled', () => {
    const waiting = place({ serviceId: 'tour-package', optionId: 'cao-bang-loop', quantity: 8 });
    const loop = (quantity: number) =>
      desk.availability('tour-package', 'cao-bang-loop', '2026-11-21', 1, quantity);
    expect(loop(1)).toEqual({ state: 'full', left: 0 });
    desk.decline(waiting.code, 'No guide that week');
    expect(loop(8)).toEqual({ state: 'available', left: 8 });

    const confirmed = place({ quantity: 2 });
    desk.cancel(confirmed.code, '');
    expect(desk.availability('motorbike-rental', 'honda-xr150', '2026-11-20', 1, 2).state).toBe(
      'available',
    );
  });

  it('cannot tell where the settings give no capacity, and lets a person decide', () => {
    const open = demoBusiness((s) => {
      s.services[1]!.options[0]!.capacity = null;
    });
    const openDesk = new Desk(store, open, clock.now);
    expect(openDesk.availability('tour-package', 'ban-gioc-day', '2026-11-20', 1, 50)).toEqual({
      state: 'unknown',
    });
    const result = openDesk.place(
      request({ serviceId: 'tour-package', optionId: 'ban-gioc-day', days: 1, quantity: 50 }),
    );
    expect(result.ok && result.booking.status).toBe('pending');
  });

  it('never gives two bookings the same number', () => {
    const codes = new Set(
      Array.from({ length: 200 }, () => place({ optionId: 'honda-wave', startDate: '2027-01-01', days: 1, quantity: 0 }).code), // prettier-ignore
    );
    expect(codes.size).toBe(200);
  });
});

describe('what a person does with a booking', () => {
  it('confirms a waiting booking, with a price where there was none', () => {
    const open = demoBusiness((s) => {
      s.services[1]!.options[0]!.price = null;
    });
    const openDesk = new Desk(store, open, clock.now);
    const result = openDesk.place(
      request({ serviceId: 'tour-package', optionId: 'ban-gioc-day', days: 1, quantity: 2 }),
    );
    if (!result.ok) throw new Error('expected the booking to be taken');
    expect(result.booking.totalPrice).toBeNull();

    clock.advance(60_000);
    const confirmed = openDesk.confirm(result.booking.code, 2_600_000);
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'staff',
      totalPrice: 2_600_000,
      updatedAt: clock.now(),
    });
  });

  it('keeps the quoted price when the person gives none', () => {
    const booking = place({ serviceId: 'tour-package', optionId: 'ban-gioc-day', days: 1, quantity: 2 }); // prettier-ignore
    expect(desk.confirm(booking.code)).toMatchObject({
      totalPrice: 2_400_000,
      unitPrice: 1_200_000,
    });
  });

  it('refuses steps that do not follow', () => {
    const booking = place();
    expect(() => desk.confirm(booking.code)).toThrowError(BookingError);
    expect(() => desk.decline(booking.code, '')).toThrowError(/confirmed/);
    desk.cancel(booking.code, 'Customer fell ill');
    expect(() => desk.cancel(booking.code, '')).toThrowError(/cancelled/);
    expect(() => desk.confirm('CB-NOPE1')).toThrowError(/no booking/i);
  });

  it('finds a booking whatever the case of its number', () => {
    const booking = place();
    expect(store.bookings.get(booking.code.toLowerCase())?.id).toBe(booking.id);
  });
});
