import { expect, test, type Page } from '@playwright/test';
import {
  addDays,
  apiClient,
  createTestProperty,
  todayInIndia,
  type Api,
  type TestProperty,
} from '../helpers';

const start = addDays(todayInIndia(), 40);

interface RateDayJson {
  date: string;
  rate: number;
  rateOverridden: boolean;
  minStayArrival: number;
  maxStay: number | null;
  closedToDeparture: boolean;
  stopSell: boolean;
}

let api: Api;
let cottage: TestProperty;

test.beforeAll(async ({ playwright }) => {
  api = await apiClient(await playwright.request.newContext());
  cottage = await createTestProperty(api, 'villa');
});

async function ratesFor(planId: string, from: string, to: string): Promise<RateDayJson[]> {
  const { days } = await api.get<{ days: RateDayJson[] }>(
    `/properties/${cottage.id}/rates?from=${from}&to=${to}&ratePlanIds=${planId}`,
  );
  return days;
}

const plan = (name: string) => cottage.roomTypes[0]!.ratePlans.find((p) => p.name === name)!;

test.beforeEach(async ({ page }) => {
  await page.goto('/rates');
  await page.getByLabel('Property').selectOption({ label: cottage.name });
  await page.getByLabel('Go to date').fill(start);
});

const pendingBar = (page: Page) => page.getByRole('region', { name: 'Changes not saved yet' });

test('holds a changed rate until it is saved, and a derived plan then follows', async ({
  page,
}) => {
  const date = addDays(start, 2);

  await page.getByRole('button', { name: `Rate on ${date}: 18,000` }).click();
  const input = page.getByRole('spinbutton', { name: `Rate on ${date}` });
  await input.fill('21000');
  await input.press('Enter');
  // Enter moves on to the next night; leave that one as it is.
  await page.getByRole('spinbutton').press('Escape');

  // The new figure shows, marked as waiting; nothing has been saved or sent yet.
  await expect(
    page.getByRole('button', { name: `Rate on ${date}: 21,000, not saved yet` }),
  ).toBeVisible();
  await expect(pendingBar(page)).toContainText('1 change not saved yet');
  expect((await ratesFor(plan('Flexible').id, date, addDays(date, 1)))[0]).toMatchObject({
    rate: 1_800_000,
    rateOverridden: false,
  });

  await pendingBar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('1 day updated')).toBeVisible();
  await expect(pendingBar(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Rate on ${date}: 21,000` })).toBeVisible();
  // The non-refundable plan is 10% below the flexible plan, so it moved too.
  await expect(page.getByRole('button', { name: `Rate on ${date}: 18,900` })).toBeVisible();

  expect((await ratesFor(plan('Flexible').id, date, addDays(date, 1)))[0]).toMatchObject({
    rate: 2_100_000,
    rateOverridden: true,
  });
  expect((await ratesFor(plan('Non-refundable').id, date, addDays(date, 1)))[0]).toMatchObject({
    rate: 1_890_000,
  });
});

test('updates a date range in bulk, on chosen weekdays only', async ({ page }) => {
  const from = addDays(start, 20);
  const to = addDays(start, 33);

  await page.getByRole('button', { name: 'Bulk update' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update rates and restrictions' });
  await dialog.getByLabel('From').fill(from);
  await dialog.getByLabel('To (inclusive)').fill(to);
  // Keep only Saturday.
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sun']) {
    await dialog.getByRole('button', { name: day, exact: true }).click();
  }
  await dialog.getByLabel(/Rate per night/).fill('25000');
  await dialog.getByLabel(/Minimum stay/).fill('3');
  await dialog.getByRole('button', { name: 'Add to changes' }).click();
  await pendingBar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('2 days updated')).toBeVisible();

  const days = await ratesFor(plan('Flexible').id, from, addDays(to, 1));
  const changed = days.filter((d) => d.rateOverridden);
  expect(changed).toHaveLength(2);
  for (const day of changed) {
    expect(new Date(`${day.date}T00:00:00Z`).getUTCDay()).toBe(6);
    expect(day).toMatchObject({ rate: 2_500_000, minStayArrival: 3 });
  }
  // Other days kept the plan default.
  expect(
    days
      .filter((d) => !d.rateOverridden)
      .every((d) => d.rate === 1_800_000 && d.minStayArrival === 1),
  ).toBe(true);
});

test('closes a night for sale from the restrictions row', async ({ page }) => {
  const date = addDays(start, 5);

  await page
    .getByRole('button', { name: `Restrictions on ${date}: none` })
    .first()
    .click();
  await page.getByLabel('Stop sell (not on sale)').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await pendingBar(page).getByRole('button', { name: 'Save changes' }).click();

  await expect(
    page.getByRole('button', { name: `Restrictions on ${date}: Not on sale`, exact: true }),
  ).toBeVisible();
  expect((await ratesFor(plan('Flexible').id, date, addDays(date, 1)))[0]).toMatchObject({
    stopSell: true,
  });
});

test('saves several changes to different plans and dates as one request', async ({ page }) => {
  const rateDate = addDays(start, 8);
  const closedDate = addDays(start, 9);
  const saves: { changes: unknown[] }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/rates(\/batch)?$/.test(new URL(request.url()).pathname)) {
      saves.push(request.postDataJSON() as { changes: unknown[] });
    }
  });

  // A price on one night of the flexible plan.
  await page.getByRole('button', { name: `Rate on ${rateDate}: 18,000` }).click();
  await page.getByRole('spinbutton', { name: `Rate on ${rateDate}` }).fill('19500');
  await page.getByRole('spinbutton', { name: `Rate on ${rateDate}` }).press('Enter');
  await page.getByRole('spinbutton').press('Escape');
  // A restriction on another night of the non-refundable plan (the second restrictions row).
  await page
    .getByRole('button', { name: `Restrictions on ${closedDate}: none` })
    .nth(1)
    .click();
  await page.getByLabel('Minimum stay').fill('4');
  await page.getByLabel('Maximum stay').fill('9');
  await page.getByLabel('Closed to departure').check();
  await page.getByRole('button', { name: 'Done' }).click();
  // And a minimum stay for a fortnight on both plans.
  await page.getByRole('button', { name: 'Bulk update' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update rates and restrictions' });
  await dialog.getByLabel(/Non-refundable/).check();
  await dialog.getByLabel('From').fill(addDays(start, 40));
  await dialog.getByLabel('To (inclusive)').fill(addDays(start, 53));
  await dialog.getByLabel(/Minimum stay/).fill('2');
  await dialog.getByRole('button', { name: 'Add to changes' }).click();

  await expect(pendingBar(page)).toContainText('4 changes not saved yet');
  // What is waiting can be read back, and one of them taken out again.
  await pendingBar(page).getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText('Minimum stay 4 nights, Maximum stay 9 nights')).toBeVisible();
  await page.keyboard.press('Escape');
  // They survive a reload: nothing is lost by looking something up elsewhere.
  await page.reload();
  await expect(pendingBar(page)).toContainText('4 changes not saved yet');
  expect(saves).toHaveLength(0);

  await pendingBar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('30 days updated')).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]!.changes).toHaveLength(4);

  expect((await ratesFor(plan('Flexible').id, rateDate, addDays(rateDate, 1)))[0]).toMatchObject({
    rate: 1_950_000,
  });
  expect(
    (await ratesFor(plan('Non-refundable').id, closedDate, addDays(closedDate, 1)))[0],
  ).toMatchObject({ minStayArrival: 4, maxStay: 9, closedToDeparture: true });
});

test('discards what was changed when asked to', async ({ page }) => {
  const date = addDays(start, 12);
  await page.getByRole('button', { name: `Rate on ${date}: 18,000` }).click();
  await page.getByRole('spinbutton', { name: `Rate on ${date}` }).fill('30000');
  await page.getByRole('spinbutton', { name: `Rate on ${date}` }).press('Enter');
  await page.getByRole('spinbutton').press('Escape');
  await expect(pendingBar(page)).toContainText('1 change not saved yet');

  await pendingBar(page).getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  await expect(pendingBar(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Rate on ${date}: 18,000` })).toBeVisible();
  expect((await ratesFor(plan('Flexible').id, date, addDays(date, 1)))[0]).toMatchObject({
    rate: 1_800_000,
    rateOverridden: false,
  });
});
