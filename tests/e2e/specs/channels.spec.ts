import { expect, test, type APIRequestContext } from '@playwright/test';
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

let request: APIRequestContext;
let api: Api;
let hotel: TestProperty;
let mailbox: { id: string };
let mailSeq = 0;

test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext();
  api = await apiClient(request);
  hotel = await createTestProperty(api, 'hotel');
  mailbox = await api.post<{ id: string }>('/channels/connections', {
    propertyId: hotel.id,
    adapter: 'email',
  });
  await apiPatch(request, `/channels/connections/${mailbox.id}`, { status: 'active' });
});

/** Hands the API an email from a booking site, the way a mail service forwards one. */
async function bookingSiteWrites(subject: string, text: string): Promise<{ status?: string }> {
  const raw = [
    'From: Booking.com <noreply@booking.com>',
    'To: reservations@seabreeze.example',
    `Subject: ${subject}`,
    `Message-ID: <e2e-channels-${Date.now()}-${++mailSeq}@booking.example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain',
    '',
    text,
  ].join('\r\n');
  const res = await request.post(`${API_URL}/webhooks/inbound-email/${mailbox.id}`, {
    headers: { 'content-type': 'message/rfc822', 'x-inbound-email-secret': INBOUND_EMAIL_SECRET },
    data: raw,
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as { status?: string };
}

/** The alerts still open about a booking message of this property that could not be used. */
async function openAlerts(): Promise<unknown[]> {
  const { alerts } = await api.get<{ alerts: { title: string; propertyId: string | null }[] }>(
    '/alerts?limit=500',
  );
  return alerts.filter(
    (alert) => alert.propertyId === hotel.id && /could not be used/.test(alert.title),
  );
}

test('a booking email that could not be recorded is marked as dealt with by hand, and can be taken up again', async ({
  page,
}) => {
  // A notice with no booking number in it: nothing can be recorded from it.
  const outcome = await bookingSiteWrites(
    'New booking',
    [
      'You have a new booking.',
      `Check-in: ${addDays(today, 40)}`,
      `Check-out: ${addDays(today, 42)}`,
    ].join('\n'),
  );
  expect(outcome).toMatchObject({ received: true, status: 'failed' });
  expect(await openAlerts()).toHaveLength(1);

  await page.goto(`/channels/${mailbox.id}`);
  const outstanding = page.getByText('1 booking email could not be recorded here');
  await expect(outstanding).toBeVisible();

  // The front desk has entered the booking by hand and says so.
  await page.getByRole('button', { name: /^Dealt with by hand/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Dealt with by hand?' });
  await confirm.getByRole('button', { name: 'Yes, it is dealt with' }).click();
  await expect(confirm).toBeHidden();
  await expect(outstanding).toBeHidden();
  const row = page.locator('[data-revision]').first();
  await expect(row.getByText('Dealt with by hand', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply again/ })).toHaveCount(0);

  // The alert about it is closed with it.
  expect(await openAlerts()).toHaveLength(0);

  // Said by mistake: taking it up again puts it back among what is outstanding.
  await row.getByRole('button', { name: /^Take up again/ }).click();
  await expect(outstanding).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply again/ })).toBeVisible();
  expect(await openAlerts()).toHaveLength(1);
});
