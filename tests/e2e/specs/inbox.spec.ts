import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL, INBOUND_EMAIL_SECRET } from '../env';
import {
  addDays,
  apiClient,
  apiPatch,
  createTestProperty,
  todayInIndia,
  type Api,
  type TestProperty,
} from '../helpers';

const today = todayInIndia();
const guest = { firstName: 'Ines', lastName: 'Moreau', email: `ines.${Date.now()}@example.com` };
const guestName = `${guest.firstName} ${guest.lastName}`;

let request: APIRequestContext;
let api: Api;
let hotel: TestProperty;
let booking: { id: string; code: string };
let mailSeq = 0;

test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext();
  api = await apiClient(request);
  hotel = await createTestProperty(api, 'hotel');
  await apiPatch(request, `/properties/${hotel.id}`, {
    checkInTime: '14:00',
    settings: { arrivalInstructions: 'Ring the bell at the blue gate.' },
  });
  const roomType = hotel.roomTypes[0]!;
  booking = await api.post<{ id: string; code: string }>('/reservations', {
    propertyId: hotel.id,
    source: 'phone',
    guest,
    rooms: [
      {
        roomTypeId: roomType.id,
        ratePlanId: roomType.ratePlans.find((p) => p.name === 'Flexible')!.id,
        checkIn: addDays(today, 6),
        checkOut: addDays(today, 8),
        adults: 2,
      },
    ],
  });
});

/** Hands the API an email from the guest, the way a mail service would. */
async function guestWrites(subject: string, text: string, attachment?: Buffer): Promise<void> {
  const headers = [
    `From: ${guestName} <${guest.email}>`,
    'To: stay@seabreeze.example',
    `Subject: ${subject}`,
    `Message-ID: <e2e-${Date.now()}-${++mailSeq}@mail.example>`,
    'MIME-Version: 1.0',
  ];
  const raw = attachment
    ? [
        ...headers,
        'Content-Type: multipart/mixed; boundary="frontier"',
        '',
        '--frontier',
        'Content-Type: text/plain',
        '',
        text,
        '--frontier',
        'Content-Type: image/png; name="our-car.png"',
        'Content-Disposition: attachment; filename="our-car.png"',
        'Content-Transfer-Encoding: base64',
        '',
        attachment.toString('base64'),
        '--frontier--',
        '',
      ]
    : [...headers, 'Content-Type: text/plain', '', text];
  const res = await request.post(`${API_URL}/webhooks/inbox/email`, {
    headers: { 'content-type': 'message/rfc822', 'x-inbound-email-secret': INBOUND_EMAIL_SECRET },
    data: raw.join('\r\n'),
  });
  expect(res.ok(), await res.text()).toBe(true);
  expect(await res.json()).toMatchObject({ received: true, duplicate: false });
}

const row = (page: Page) => page.locator('[data-conversation]').filter({ hasText: guestName });
const thread = (page: Page) => page.getByRole('log', { name: `Messages with ${guestName}` });

test.describe.configure({ mode: 'serial' });

test('a guest’s email appears as it arrives and can be answered from what is on file', async ({
  page,
}) => {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // Nobody reloads: the message shows up in the list, and on the Inbox link, by itself.
  await guestWrites('Arrival', 'Hello, from what time can we check in?');
  await expect(row(page)).toBeVisible();
  await expect(row(page)).toContainText('from what time can we check in?');
  await expect(row(page)).toContainText('1 unread');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByLabel(/unread$/)).toBeVisible();

  await row(page).click();
  await expect(thread(page)).toContainText('Hello, from what time can we check in?');
  // It was filed under the guest's booking.
  await expect(page.getByRole('link', { name: `Booking ${booking.code}` })).toBeVisible();
  // Reading it clears the count for everyone.
  await expect(row(page)).not.toContainText('unread');

  // The property's own details answer this one; no AI service is set up here.
  await page.getByRole('button', { name: 'Suggest a reply' }).click();
  const reply = page.getByRole('textbox', { name: `Reply to ${guestName}` });
  await expect(reply).toHaveValue(
    /Dear Ines,\s+Check-in is from 14:00\. Ring the bell at the blue gate\./,
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(thread(page)).toContainText('Check-in is from 14:00.');
  // No worker runs in this test stack, so the reply stays on its way.
  await expect(thread(page)).toContainText('Sending');
  await expect(reply).toHaveValue('');
  await expect(row(page)).toContainText('Waiting for guest');
});

test('a template is shown as the guest will read it before it goes into the reply', async ({
  page,
}) => {
  await page.goto('/inbox');
  await row(page).click();
  await page.getByRole('button', { name: 'Use a template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Use a template' });
  await dialog.getByRole('radio', { name: 'Before arrival' }).check();
  // Filled in by the server for this guest and this booking: no placeholders left.
  await expect(dialog).toContainText('Dear Ines,');
  await expect(dialog).toContainText('Ring the bell at the blue gate.');
  await expect(dialog).not.toContainText('{{');
  await dialog.getByRole('button', { name: 'Use this message' }).click();
  await expect(page.getByRole('textbox', { name: `Reply to ${guestName}` })).toHaveValue(
    /We look forward to welcoming you/,
  );
});

test('a photo the guest sends can be opened, and the conversation handed over and closed', async ({
  page,
}) => {
  const photo = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('a photo of a car, as far as this test is concerned'),
  ]);
  await page.goto('/inbox');
  await row(page).click();
  await guestWrites('Our car', 'This is the car we arrive in.', photo);
  await expect(thread(page)).toContainText('This is the car we arrive in.');
  const link = thread(page).getByRole('link', { name: 'our-car.png' });
  await expect(link).toBeVisible();
  const file = await page.request.get(new URL((await link.getAttribute('href'))!, page.url()).href);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toBe('image/png');
  expect((await file.body()).equals(photo)).toBe(true);

  // The guest wrote again, so it is open; take it, then close it.
  await page.getByRole('button', { name: 'Unassigned' }).click();
  await page.getByRole('menuitem', { name: 'Me', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Assigned to me' })).toBeVisible();
  await page.getByRole('button', { name: 'Close conversation' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  // Closed conversations leave the list of active ones.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(row(page)).toHaveCount(0);
  await page.getByLabel('Status').selectOption({ label: 'Closed' });
  await expect(row(page)).toBeVisible();
});
