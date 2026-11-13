import { expect, test } from '@playwright/test';
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

test('changes one night’s rate in place and a derived plan follows', async ({ page }) => {
  const date = addDays(start, 2);

  await page.getByRole('button', { name: `Rate on ${date}: 18,000` }).click();
  const input = page.getByRole('spinbutton', { name: `Rate on ${date}` });
  await input.fill('21000');
  await input.press('Enter');

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
  await dialog.getByRole('button', { name: 'Apply' }).click();
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
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(
    page.getByRole('button', { name: `Restrictions on ${date}: Not on sale` }),
  ).toBeVisible();
  expect((await ratesFor(plan('Flexible').id, date, addDays(date, 1)))[0]).toMatchObject({
    stopSell: true,
  });
});
