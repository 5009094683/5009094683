import { expect, test } from '@playwright/test';
import {
  addDays,
  apiClient,
  createTestProperty,
  showCalendarFrom,
  showOnlyProperties,
  todayInIndia,
  type Api,
  type TestProperty,
} from '../helpers';

const first = addDays(todayInIndia(), 30);
const leaving = addDays(first, 2);

let api: Api;
let hotel: TestProperty;

test.beforeAll(async ({ playwright }) => {
  api = await apiClient(await playwright.request.newContext());
  // Two Standard Rooms, 101 and 102.
  hotel = await createTestProperty(api, 'hotel');
});

/** What anyone can book, night by night. */
async function onSale(): Promise<number[]> {
  const { days } = await api.get<{ days: { available: number }[] }>(
    `/properties/${hotel.id}/availability?from=${first}&to=${leaving}`,
  );
  return days.map((day) => day.available);
}

test.describe.configure({ mode: 'serial' });

test('a group holds rooms off sale and its guests book them', async ({ page }) => {
  await page.goto('/groups');
  await page.getByLabel('Property').selectOption({ label: hotel.name });
  await expect(page.getByText('No group is holding rooms')).toBeVisible();

  await page.getByRole('button', { name: 'New group' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New group' });
  await dialog.getByLabel('Name of the group').fill('Mehta wedding');
  await dialog.getByLabel('First night').fill(first);
  await dialog.getByLabel('Leaving on').fill(leaving);
  await expect(dialog.getByText('2 free on every night')).toBeVisible();
  await dialog.getByLabel(/^Standard Room/).fill('2');
  await dialog.getByRole('button', { name: 'Start group and hold rooms' }).click();

  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Mehta wedding' })).toBeVisible();
  await expect(page.getByText('Holding rooms')).toBeVisible();
  await expect(page.getByRole('cell', { name: '0 of 2 held rooms booked' })).toHaveCount(2);
  // Both rooms are off sale for everyone else.
  expect(await onSale()).toEqual([0, 0]);

  // The ordinary reservation form, opened for the group, sees the held rooms as free.
  await page.getByRole('button', { name: 'Book a room' }).click();
  const form = page.getByRole('dialog', { name: 'New reservation for Mehta wedding' });
  await expect(form.getByLabel('Check-in')).toHaveValue(first);
  await expect(form.getByLabel('Check-out')).toHaveValue(leaving);
  await form.getByLabel('First name').fill('Rohan');
  await form.getByLabel('Last name').fill('Mehta');
  await expect(form.getByText('before tax').first()).toBeVisible();
  await expect(form.getByText(/No Standard Room left/)).toHaveCount(0);
  await form.getByRole('button', { name: 'Create reservation' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('button', { name: /Rohan Mehta/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: '1 of 2 held rooms booked' })).toHaveCount(2);
  expect(await onSale()).toEqual([0, 0]);
});

test('a rooming list is booked whole or not at all', async ({ page }) => {
  await page.goto('/groups');
  await page.getByLabel('Property').selectOption({ label: hotel.name });
  await page.getByRole('link', { name: /Mehta wedding/ }).click();
  await page.getByRole('button', { name: 'Add a rooming list' }).click();
  const list = page.getByRole('dialog', { name: 'Rooming list for Mehta wedding' });

  // Two guests for the one room that is left: nobody is booked.
  await list.getByLabel('Guests').fill('Lena Ortiz, lena@example.com\nMarek Nowak');
  await expect(list.getByText(/Only 1 room of Standard Room can be booked/)).toBeVisible();
  await list.getByRole('button', { name: 'Book 2 rooms' }).click();
  await expect(list.getByRole('alert').filter({ hasText: 'No availability' })).toBeVisible();

  // One guest, at the rate agreed with the family.
  await list.getByLabel('Guests').fill('1. Lena Ortiz, lena@example.com, +91 98200 00000');
  await list.getByLabel('Rate per night').fill('15000');
  await list.getByRole('button', { name: 'Book 1 room' }).click();
  await expect(list).toBeHidden();
  await expect(page.getByRole('cell', { name: '2 of 2 held rooms booked' })).toHaveCount(2);
  const lena = page.getByRole('button', { name: /Lena Ortiz/ });
  await expect(lena).toContainText('30,000');

  // Her booking says which group it belongs to, and leads back to it.
  await lena.click();
  const panel = page.getByRole('dialog', { name: /^Reservation / });
  await expect(panel.getByRole('link', { name: 'Mehta wedding' })).toBeVisible();
  await expect(panel.getByText('lena@example.com')).toBeVisible();
});

test('the held rooms show on the calendar and can be released', async ({ page }) => {
  // On the calendar the held rooms are one bar, which leads to the group.
  await showOnlyProperties(page, api, [hotel.id]);
  await page.goto('/calendar');
  await showCalendarFrom(page, first);
  await page.getByRole('button', { name: /^Held: Mehta wedding/ }).click();
  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Mehta wedding' })).toBeVisible();

  // A third room cannot be held in a hotel of two.
  await page.getByRole('button', { name: /^Change the Standard Room rooms held/ }).click();
  const hold = page.getByRole('dialog', { name: 'Change held rooms: Standard Room' });
  await hold.getByLabel('Rooms to hold').fill('3');
  await hold.getByRole('button', { name: 'Save' }).click();
  await expect(hold.getByRole('alert')).toHaveText('Quantity must be between 1 and 2');
  await hold.getByRole('button', { name: 'Cancel' }).click();

  // A booking falls through: its room goes back to the group, not on sale.
  await page.getByRole('button', { name: /Rohan Mehta/ }).click();
  const panel = page.getByRole('dialog', { name: /^Reservation / });
  await panel.getByRole('button', { name: 'Take out of group' }).click();
  // Out of the group it would need a room from general sale, and there is none.
  await expect(page.getByRole('alert').filter({ hasText: 'No availability' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('cell', { name: '2 of 2 held rooms booked' })).toHaveCount(2);

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Release unbooked rooms' }).click();
  const confirm = page.getByRole('dialog', { name: 'Release the unbooked rooms?' });
  await expect(confirm).toContainText('The 2 bookings already made stay as they are.');
  await confirm.getByRole('button', { name: 'Release rooms' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('main').getByText('Rooms released', { exact: true })).toBeVisible();
  await expect(page.getByText('No rooms are held any more.')).toBeVisible();

  // It left the list of groups holding rooms.
  await page.getByRole('link', { name: 'Groups', exact: true }).first().click();
  await expect(page.getByText('No group is holding rooms')).toBeVisible();
  await page.getByRole('radio', { name: 'Released' }).click();
  await expect(page.getByRole('link', { name: /Mehta wedding/ })).toBeVisible();
});
