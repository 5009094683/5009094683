import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { BOOKING_URL } from '../env';
import {
  addDays,
  apiClient,
  apiPatch,
  createTestProperty,
  takeWebsiteBookings,
  todayInIndia,
  type Api,
  type TestProperty,
} from '../helpers';

/**
 * A guest's way through the booking site: finding a stay, paying for it on the
 * stand-in payment page, checking in online and cancelling, and what the site
 * says when a payment does not arrive or a link is wrong. The file makes a
 * cottage of its own that takes website bookings, and each test stays on its
 * own dates, so tests never compete for the cottage.
 */

// A guest has no session: these pages must work for somebody who never signed in.
test.use({ storageState: { cookies: [], origins: [] } });
// Each journey crosses half a dozen pages, which the development servers build on first use.
test.describe.configure({ timeout: 120_000 });
/** For what is looked for on a page the development server may be building for the first time. */
const SLOW = { timeout: 30_000 };

interface Stay {
  checkIn: string;
  nights: number;
}

interface QuoteJson {
  offers: { plans: { name: string; total: number }[] }[];
}

interface BookedJson {
  token: string;
  code: string;
  payment: { checkoutUrl: string };
}

interface BookingJson {
  code: string;
  status: string;
  total: number;
  paid: number;
  balance: number;
  cancellation: { allowed: boolean; charge: number; refund: number };
}

interface Guest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const today = todayInIndia();
const ADDRESS = '12 Beach Road';
const ARRIVAL_NOTE = 'The key safe is by the blue gate.';
const HOUSE_RULES = 'Quiet hours are from 22:00 to 07:00.';

let http: APIRequestContext;
let api: Api;
let cottage: TestProperty;
/** The cottage's address on the booking site. */
let code: string;
let flexiblePlanId: string;

test.beforeAll(async ({ playwright }) => {
  http = await playwright.request.newContext();
  api = await apiClient(http);
  cottage = await createTestProperty(api, 'villa');
  code = await takeWebsiteBookings(http, cottage, {
    addressLine1: ADDRESS,
    city: 'Candolim',
    phone: '+91 00000 11111',
    email: 'cottage@example.com',
    settings: { bookingTerms: HOUSE_RULES, arrivalInstructions: ARRIVAL_NOTE },
  });
  // From two weeks before arrival cancelling costs the first night, so that a
  // cancelled stay has both a charge and a refund to tell the guest about.
  flexiblePlanId = cottage.roomTypes[0]!.ratePlans.find((plan) => plan.name === 'Flexible')!.id;
  await apiPatch(http, `/properties/${cottage.id}/rate-plans/${flexiblePlanId}`, {
    cancellationPolicy: { freeCancelDays: 14, penalty: 'first_night' },
  });
});

test.afterAll(async () => {
  await http.dispose();
});

const firstPhone = Math.floor(Math.random() * 90_000);
let guests = 0;

/**
 * A guest nobody has seen before. The API takes a booking with a known email
 * address or telephone number to be a returning guest's, and one guest may
 * hold only a few unpaid bookings at a time, so tests must not share one, nor
 * may a run with those before it when the database is kept between runs.
 */
function newGuest(): Guest {
  guests += 1;
  return {
    firstName: 'Asha',
    lastName: 'Tester',
    email: `asha.${guests}.${code.toLowerCase()}@example.com`,
    phone: `+91 00000 ${String(firstPhone + guests).padStart(5, '0')}`,
  };
}

/** Amounts as the booking site writes them: `₹63,720`. */
const inr = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN')}`;

/** A date as the booking site writes it: `Tue 17 Nov 2026`. */
function inWords(date: string): string {
  const [weekday, day, month, year] = new Date(`${date}T00:00:00Z`)
    .toUTCString()
    .replace(',', '')
    .split(' ');
  return `${weekday} ${Number(day)} ${month} ${year}`;
}

/** What is written beside a label in a list of facts, such as the price summary. */
const fact = (within: Locator | Page, label: string): Locator =>
  within.locator(`div:has(> dt:text-is("${label}")) > dd`);

const headline = (page: Page): Locator => page.getByRole('heading', { level: 1 });

const bookingToken = (page: Page): string => new URL(page.url()).pathname.split('/')[2]!;

const readBooking = (token: string): Promise<BookingJson> =>
  api.get<BookingJson>(`/public/bookings/${token}`);

/** What the flexible rate asks for a stay, taxes included. */
async function priceOf(stay: Stay): Promise<number> {
  const checkOut = addDays(stay.checkIn, stay.nights);
  const quote = await api.get<QuoteJson>(
    `/public/properties/${code}/availability?checkIn=${stay.checkIn}&checkOut=${checkOut}&adults=1`,
  );
  return quote.offers[0]!.plans.find((plan) => plan.name === 'Flexible')!.total;
}

/** A small PNG picture, made here so that no binary file has to be kept with the specs. */
function smallPng(side = 24): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // red, green and blue
  // Each row starts with its filter (none), then one grey pixel after another.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(side * 3, 0xb4)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A phone has no room to scroll sideways: nothing may be wider than the screen. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page is wider than the screen').toBeLessThanOrEqual(0);
}

/**
 * Searches the cottage for a stay, chooses the flexible rate and fills in the
 * booking form, as far as the stand-in payment page. Returns what the stay costs.
 */
async function bookAsFarAsPaying(page: Page, stay: Stay, guest: Guest): Promise<number> {
  const total = await priceOf(stay);

  await page.goto(`${BOOKING_URL}/${code}`);
  await page.getByLabel('Arrival').fill(stay.checkIn);
  await page.getByLabel('Departure').fill(addDays(stay.checkIn, stay.nights));
  await page.getByLabel('Adults per room').selectOption('1');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Select Entire Cottage, Flexible' }).click();
  await page.getByRole('link', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible(SLOW);
  await page.getByLabel('First name').fill(guest.firstName);
  await page.getByLabel('Last name').fill(guest.lastName);
  await page.getByRole('textbox', { name: 'Email' }).fill(guest.email);
  await page.getByLabel('Phone').fill(guest.phone);
  await page.getByLabel('I accept these terms.').check();
  await page.getByRole('button', { name: `Confirm and pay ${inr(total)}` }).click();

  // The stand-in payment page, which the API serves at the back office's address.
  await expect(page.getByRole('button', { name: /^Pay / })).toBeVisible(SLOW);
  return total;
}

/**
 * Keeps the page's scripts from arriving until the function it returns is called, as on a
 * slow connection: the page can be read and filled in before its scripts have taken it over.
 */
async function holdScripts(page: Page): Promise<() => Promise<void>> {
  let arrive = (): void => {};
  const gate = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let held = 0;
  await page.route(
    (url) => url.pathname.startsWith('/_next/') && url.pathname.endsWith('.js'),
    async (route) => {
      held += 1;
      await gate;
      await route.continue();
    },
  );
  return async () => {
    expect(held, 'the page had no scripts to wait for').toBeGreaterThan(0);
    arrive();
    // With nothing left to fetch, the scripts have arrived and have the page.
    await page.waitForLoadState('networkidle');
  };
}

/** Presses Pay on the stand-in payment page from outside the browser, as a slow payment arrives. */
async function payOnStandIn(checkoutUrl: string): Promise<void> {
  const paid = await http.post(checkoutUrl, { form: { outcome: 'paid' }, maxRedirects: 0 });
  expect(paid.status(), 'the stand-in payment page sends the guest back').toBe(303);
}

/** A stay booked and paid for without a browser, for tests that are about what comes after. */
async function bookedAndPaid(stay: Stay): Promise<BookedJson> {
  const booked = await api.post<BookedJson>('/public/bookings', {
    propertyCode: code,
    checkIn: stay.checkIn,
    checkOut: addDays(stay.checkIn, stay.nights),
    rooms: [{ roomTypeId: cottage.roomTypes[0]!.id, ratePlanId: flexiblePlanId, adults: 1 }],
    guest: newGuest(),
    acceptTerms: true,
  });
  await payOnStandIn(booked.payment.checkoutUrl);
  await api.post(`/public/bookings/${booked.token}/sync`);
  return booked;
}

/** Book, pay, read the booking, check in online, cancel. */
async function guestJourney(page: Page, stay: Stay): Promise<void> {
  const total = await bookAsFarAsPaying(page, stay, newGuest());
  await page.getByRole('button', { name: /^Pay / }).click();

  // Back on the booking site, which asks the payment gateway what happened.
  await expect(headline(page)).toHaveText('Your booking is confirmed', SLOW);
  await expect(page.getByText('Thank you, we have received your payment.')).toBeVisible();
  // The address is the booking's own again: a reload would not ask about the payment twice.
  await expect(page).toHaveURL(/\/booking\/[^/?#]+$/);
  const token = bookingToken(page);
  await expect(page).toHaveTitle(/^Your booking/);
  expect(await page.title()).not.toContain(token);
  expect(await readBooking(token)).toMatchObject({
    status: 'confirmed',
    total,
    paid: total,
    balance: 0,
  });

  const yourStay = page.getByRole('region', { name: 'Your stay' });
  await expect(yourStay.getByText(inWords(stay.checkIn))).toBeVisible();
  await expect(yourStay.getByText('from 14:00')).toBeVisible();
  await expect(yourStay.getByText(inWords(addDays(stay.checkIn, stay.nights)))).toBeVisible();
  await expect(yourStay.getByText('by 11:00')).toBeVisible();
  await expect(fact(yourStay, 'Booked for')).toHaveText('Asha Tester');
  await expect(fact(yourStay, 'Length of stay')).toHaveText(`${stay.nights} nights`);
  await expect(yourStay.getByText('1 x Entire Cottage')).toBeVisible();
  await expect(yourStay.getByText('Flexible, Room only')).toBeVisible();

  const price = page.getByRole('region', { name: 'Price' });
  await expect(fact(price, 'Total, taxes included')).toHaveText(inr(total));
  await expect(fact(price, 'Paid')).toHaveText(inr(total));
  await expect(fact(price, 'Still to pay')).toHaveText('Nothing');

  await expect(page.getByText(ADDRESS)).toBeVisible();
  await expect(page.getByText(ARRIVAL_NOTE)).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Online check-in: one guest, one picture of their identity card.
  await page.getByRole('link', { name: 'Check in online' }).click();
  await expect(headline(page)).toHaveText('Check in online', SLOW);
  await expect(page).toHaveTitle(/^Check in online/);
  await expect(page.getByLabel('Full name', { exact: true })).toHaveValue('Asha Tester');
  await page.getByLabel('Nationality').selectOption({ label: 'India' });
  await page
    .getByLabel('Identity document', { exact: true })
    .selectOption({ label: 'Aadhaar card' });
  await page.getByLabel('Aadhaar card number').fill('0000 1111 2222');
  await page.getByLabel('When do you expect to arrive?').fill('15:30');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'identity-card.png',
    mimeType: 'image/png',
    buffer: smallPng(),
  });
  await expect(
    page.getByRole('list', { name: 'Documents added' }).getByText('identity-card.png'),
  ).toBeVisible();
  await expect(page.getByText(HOUSE_RULES)).toBeVisible();
  await page.getByLabel('I accept the house rules, and these details are correct.').check();
  await page.getByLabel('Type your full name to sign').fill('Asha Tester');
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Send my details' }).click();

  await expect(headline(page)).toHaveText('Thank you. Your details are saved.');
  const sent = page.getByRole('region', { name: 'The details you sent' });
  await expect(sent.getByRole('heading', { name: 'Asha Tester' })).toBeVisible();
  await expect(fact(sent, 'Nationality')).toHaveText('India');
  // Only the end of the number comes back.
  await expect(fact(sent, 'Aadhaar card')).toHaveText(/^\D*2222$/);
  await expect(sent).not.toContainText('0000 1111');
  await expect(fact(sent, 'Expected arrival')).toHaveText('15:30');
  await expect(fact(sent, 'Documents')).toContainText('identity-card.png');
  await expectNoSidewaysScroll(page);

  await page.getByRole('link', { name: 'Back to your booking' }).click();
  await expect(page.getByText(`Checked in online on ${inWords(today)}`)).toBeVisible();

  // Cancelling: the page says what it costs and what comes back before the guest decides.
  const { cancellation } = await readBooking(token);
  expect(cancellation.charge).toBeGreaterThan(0);
  expect(cancellation.refund).toBe(total - cancellation.charge);
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this booking?' });
  await expect(fact(dialog, 'Cancelling now costs')).toHaveText(inr(cancellation.charge));
  await expect(fact(dialog, 'You get back')).toHaveText(inr(cancellation.refund));
  await expectNoSidewaysScroll(page);
  await dialog.getByRole('button', { name: 'Cancel booking' }).click();

  await expect(headline(page)).toHaveText('This booking is cancelled');
  await expect(
    page.getByText(`The cancellation charge is ${inr(cancellation.charge)}.`),
  ).toBeVisible();
  await expect(
    page.getByText(`${inr(cancellation.refund)} is on its way back to you`),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking' })).toBeHidden();
  await expectNoSidewaysScroll(page);
  expect(await readBooking(token)).toMatchObject({
    status: 'cancelled',
    cancellation: { allowed: false },
  });
}

test('a guest books a stay, pays, checks in online and cancels', async ({ page }) => {
  await guestJourney(page, { checkIn: addDays(today, 1), nights: 3 });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the same journey fits the screen', async ({ page }) => {
    await guestJourney(page, { checkIn: addDays(today, 5), nights: 2 });
  });
});

test('a guest who comes back without having paid finds the room held, and can still pay', async ({
  page,
}) => {
  const total = await bookAsFarAsPaying(
    page,
    { checkIn: addDays(today, 20), nights: 2 },
    newGuest(),
  );
  const paymentPage = page.url();

  // The browser's Back button on the payment page: nothing was paid.
  await page.goBack();
  await expect(headline(page)).toHaveText(/^Waiting for payment: room held until \d\d:\d\d$/, SLOW);
  const booking = page.url();
  const token = bookingToken(page);
  const price = page.getByRole('region', { name: 'Price' });
  await expect(fact(price, 'Paid')).toHaveText(inr(0));
  await expect(fact(price, 'To pay now')).toHaveText(inr(total));

  // The way to pay is on another site: the booking's link must not travel there.
  const payNow = page.getByRole('link', { name: 'Pay now' });
  expect(await payNow.getAttribute('href')).not.toContain(token);
  const [toPaymentPage] = await Promise.all([
    page.waitForRequest(
      (request) => request.isNavigationRequest() && !request.url().startsWith(BOOKING_URL),
    ),
    payNow.click(),
  ]);
  expect(toPaymentPage.headers().referer).toBeUndefined();
  await expect(page.getByRole('button', { name: /^Pay / })).toBeVisible();

  // A payment gateway sends the guest back with `paid=1` whether they paid or not. The page
  // asks what happened, more than once, before it says that no payment has arrived.
  let asked = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/sync')) asked += 1;
  });
  await page.goto(`${booking}?paid=1`);
  await expect(headline(page)).toHaveText('Checking your payment');
  await expect(headline(page)).toHaveText(/^Waiting for payment: room held until \d\d:\d\d$/, SLOW);
  await expect(page.getByText('We have not received your payment.')).toBeVisible();
  await expect(page).toHaveURL(booking);
  expect(asked).toBeGreaterThan(1);

  // A payment that takes a few seconds to register is found by asking again.
  const firstAnswer = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/sync'),
  );
  await page.goto(`${booking}?paid=1`);
  await firstAnswer;
  await expect(headline(page)).toHaveText('Checking your payment');
  await payOnStandIn(paymentPage);
  await expect(headline(page)).toHaveText('Your booking is confirmed', SLOW);
  await expect(page).toHaveURL(booking);
  await expect(fact(price, 'Paid')).toHaveText(inr(total));
});

test('a guest who cancels on the payment page can pay after all while the room is held', async ({
  page,
}) => {
  const total = await bookAsFarAsPaying(
    page,
    { checkIn: addDays(today, 26), nights: 2 },
    newGuest(),
  );
  await page.getByRole('button', { name: 'Cancel' }).click();

  // That payment page is closed for good, but the room is still held: a new one can be had.
  await expect(headline(page)).toHaveText('This booking is not confirmed', SLOW);
  await expect(page.getByText('Your payment was not completed.')).toBeVisible();
  await expect(page.getByText(/Your room is still held for you until \d\d:\d\d\./)).toBeVisible();
  const booking = page.url();
  await page.getByRole('button', { name: 'Pay now' }).click();
  await page.getByRole('button', { name: /^Pay / }).click();
  await expect(headline(page)).toHaveText('Your booking is confirmed', SLOW);
  await expect(page).toHaveURL(booking);
  await expect(fact(page.getByRole('region', { name: 'Price' }), 'Paid')).toHaveText(inr(total));
});

test('a guest who cancels on the payment page can instead book again', async ({ page }) => {
  const guest = newGuest();
  const total = await bookAsFarAsPaying(page, { checkIn: addDays(today, 30), nights: 2 }, guest);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Booking again gives the hold up and takes the guest back to the form they filled in.
  await expect(headline(page)).toHaveText('This booking is not confirmed', SLOW);
  await expect(page.getByRole('button', { name: 'Pay now' })).toBeVisible();
  await page.getByRole('button', { name: 'Book again' }).click();

  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible(SLOW);
  await expect(page.getByLabel('First name')).toHaveValue(guest.firstName);
  await expect(page.getByRole('textbox', { name: 'Email' })).toHaveValue(guest.email);
  // The cottage has one unit: the form shows only because the first booking let go of it.
  await expect(page.getByRole('button', { name: `Confirm and pay ${inr(total)}` })).toBeVisible();
});

test('a payment the property asks for is paid from its own page', async ({ page }) => {
  const booked = await bookedAndPaid({ checkIn: addDays(today, 40), nights: 2 });
  const { reservations } = await api.get<{ reservations: { id: string }[] }>(
    `/reservations?search=${booked.code}`,
  );
  const asked = await api.post<{ payUrl: string }>(
    `/reservations/${reservations[0]!.id}/payment-links`,
    { amount: 250_000, description: 'Airport transfer' },
  );
  expect(asked.payUrl.startsWith(`${BOOKING_URL}/booking/${booked.token}/pay/`)).toBe(true);

  await page.goto(asked.payUrl);
  await expect(headline(page)).toHaveText(`${cottage.name} asks you for a payment`);
  await expect(page).toHaveTitle(/^Payment request/);
  await expect(fact(page, 'Asked for by')).toHaveText(cottage.name);
  await expect(fact(page, 'For')).toHaveText('Airport transfer');
  await expect(fact(page, 'Booking reference')).toHaveText(booked.code);
  await expect(fact(page, 'Amount')).toHaveText(inr(250_000));
  await expect(page.getByText(/This link works until .*\d\d:\d\d\./)).toBeVisible();

  const payNow = page.getByRole('link', { name: 'Pay now' });
  expect(await payNow.getAttribute('href')).not.toContain(booked.token);
  await payNow.click();
  await page.getByRole('button', { name: /^Pay / }).click();

  await expect(headline(page)).toHaveText('Paid. Thank you.', SLOW);
  await expect(page).toHaveURL(asked.payUrl);
  await expect(fact(page, 'Paid')).toHaveText(inr(250_000));
  await expect(page.getByRole('link', { name: 'Pay now' })).toBeHidden();
});

test('what a guest fills in before the page is ready is kept', async ({ page }) => {
  const checkIn = addDays(today, 50);
  const checkOut = addDays(checkIn, 2);

  // The search: an arrival date and the number of adults go in while the scripts are still
  // on their way, the departure date once they have the page. Drawing the form again for
  // the departure must not put the other two back to what they were.
  let ready = await holdScripts(page);
  await page.goto(`${BOOKING_URL}/${code}`, { waitUntil: 'commit' });
  await page.getByLabel('Arrival').fill(checkIn);
  await page.getByLabel('Adults per room').selectOption('1');
  await ready();
  await page.getByLabel('Departure').fill(checkOut);
  await expect(page.getByLabel('Arrival')).toHaveValue(checkIn);
  await expect(page.getByLabel('Adults per room')).toHaveValue('1');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(new RegExp(`checkIn=${checkIn}&checkOut=${checkOut}&adults=1(&|$)`));
  await page.getByRole('button', { name: 'Select Entire Cottage, Flexible' }).click();
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible(SLOW);

  // The booking form, loaded afresh: the same for a name and a tick.
  ready = await holdScripts(page);
  await page.reload({ waitUntil: 'commit' });
  await page.getByLabel('First name').fill('Asha');
  await page.getByLabel('I accept these terms.').check();
  await ready();
  await page.getByLabel('Last name').fill('Tester');
  await expect(page.getByLabel('First name')).toHaveValue('Asha');
  await expect(page.getByLabel('I accept these terms.')).toBeChecked();
});

test('a link that is wrong or has run out says what to do, and nothing about a booking', async ({
  page,
}) => {
  const links = [
    'not-a-booking',
    'x'.repeat(53),
    'not-a-booking/check-in',
    'not-a-booking/pay/00000000-0000-4000-8000-000000000000',
  ];
  for (const link of links) {
    const response = await page.goto(`${BOOKING_URL}/booking/${link}`);
    expect(response?.status(), link).toBe(404);
    await expect(headline(page)).toHaveText('This link does not work any more');
    await expect(page).toHaveTitle(/^This link does not work any more/);
    await expect(page.getByText('please contact the property')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your stay' })).toBeHidden();
  }
});

test('search engines are asked to stay out of bookings', async () => {
  const robots = await (await http.get(`${BOOKING_URL}/robots.txt`)).text();
  expect(robots).toContain('Disallow: /booking/');
  expect(robots).toContain('Disallow: /api/');
});
