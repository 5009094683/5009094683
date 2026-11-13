import { expect, test } from '@playwright/test';
import {
  addDays,
  apiClient,
  createTestProperty,
  dateX,
  drag,
  rowY,
  showCalendarFrom,
  showOnlyProperties,
  todayInIndia,
  type Api,
  type TestProperty,
} from '../helpers';

/**
 * The file creates a cottage (one unit) and a small hotel of its own, and each
 * test works in its own window of dates, so tests never see each other's stays.
 */
const today = todayInIndia();
const windowStart = (index: number) => addDays(today, 30 + index * 20);

interface ReservationJson {
  id: string;
  code: string;
  checkIn: string;
  checkOut: string;
  status: string;
  rooms: { id: string; unitName: string | null; checkIn: string; checkOut: string }[];
}

let api: Api;
let cottage: TestProperty;
let hotel: TestProperty;

test.beforeAll(async ({ playwright }) => {
  api = await apiClient(await playwright.request.newContext());
  cottage = await createTestProperty(api, 'villa');
  hotel = await createTestProperty(api, 'hotel');
});

function bookCottage(checkIn: string, checkOut: string, guest: string): Promise<ReservationJson> {
  const type = cottage.roomTypes[0]!;
  return api.post<ReservationJson>('/reservations', {
    propertyId: cottage.id,
    guest: { firstName: guest, lastName: 'Tester' },
    rooms: [
      { roomTypeId: type.id, ratePlanId: type.ratePlans[0]!.id, checkIn, checkOut, adults: 2 },
    ],
  });
}

test.describe('with the demo data', () => {
  test('shows every property with its rooms, availability and stays', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByRole('grid', { name: 'Reservations calendar' })).toBeVisible();
    for (const name of ['Coral Cottage', 'Sea Breeze Candolim', 'Villa Azure']) {
      await expect(page.getByRole('region', { name })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /Standard Room/ }).first()).toBeVisible();
    // The demo data has stays around today.
    expect(await page.locator('[data-stay]').count()).toBeGreaterThan(5);
  });
});

test.describe('working on the calendar', () => {
  test.beforeEach(async ({ page }) => {
    await showOnlyProperties(page, api, [cottage.id, hotel.id]);
    await page.goto('/calendar');
  });

  test('books a villa by dragging across empty dates', async ({ page }) => {
    const start = windowStart(0);
    const unit = cottage.roomTypes[0]!.units[0]!;
    const typeId = cottage.roomTypes[0]!.id;
    await showCalendarFrom(page, start);

    const row = page.locator(`[data-row="unit:${unit.id}"]`);
    const y = await rowY(row);
    await drag(
      page,
      { x: await dateX(page, addDays(start, 2)), y },
      { x: await dateX(page, addDays(start, 4)), y },
    );

    await page.getByRole('menuitem', { name: 'New reservation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New reservation' });
    // Three cells selected means three nights: arrive on the first, leave the morning after the last.
    await expect(dialog.getByLabel('Check-in')).toHaveValue(addDays(start, 2));
    await expect(dialog.getByLabel('Check-out')).toHaveValue(addDays(start, 5));
    await expect(dialog.getByText('3 nights')).toBeVisible();
    await dialog.getByLabel('First name').fill('Dragged');
    await dialog.getByLabel('Last name').fill('Booking');
    await dialog.getByRole('button', { name: 'Create reservation' }).click();
    await expect(dialog).toBeHidden();

    await expect(row.getByRole('button', { name: /Dragged Booking/ })).toBeVisible();
    for (const offset of [2, 3, 4]) {
      await expect(
        page.locator(`[data-availability="${typeId}:${addDays(start, offset)}"]`),
      ).toHaveAttribute('data-available', '0');
    }
    await expect(
      page.locator(`[data-availability="${typeId}:${addDays(start, 5)}"]`),
    ).toHaveAttribute('data-available', '1');

    // It is stored, not just drawn.
    await page.reload();
    await showCalendarFrom(page, start);
    await expect(
      page.locator(`[data-row="unit:${unit.id}"]`).getByRole('button', { name: /Dragged Booking/ }),
    ).toBeVisible();
  });

  test('moves a stay by dragging it and extends it by dragging its edge', async ({ page }) => {
    const start = windowStart(1);
    const stay = await bookCottage(addDays(start, 2), addDays(start, 4), 'Mover');
    await showCalendarFrom(page, start);

    const bar = page.locator(`[data-stay="${stay.rooms[0]!.id}"]`);
    await expect(bar).toBeVisible();
    const cell = (await dateX(page, addDays(start, 1))) - (await dateX(page, start));
    const box = (await bar.boundingBox())!;
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Three days later.
    await drag(page, middle, { x: middle.x + 3 * cell, y: middle.y });
    await expect(page.getByText('Mover Tester moved')).toBeVisible();
    let saved = await api.get<ReservationJson>(`/reservations/${stay.id}`);
    expect([saved.checkIn, saved.checkOut]).toEqual([addDays(start, 5), addDays(start, 7)]);

    // Two more nights, by the right edge.
    await expect
      .poll(async () => Math.round(((await bar.boundingBox())?.x ?? 0) - box.x - 3 * cell))
      .toBe(0);
    const moved = (await bar.boundingBox())!;
    const edge = { x: moved.x + moved.width - 2, y: moved.y + moved.height / 2 };
    await drag(page, edge, { x: edge.x + 2 * cell, y: edge.y });
    await expect
      .poll(async () => (await api.get<ReservationJson>(`/reservations/${stay.id}`)).checkOut)
      .toBe(addDays(start, 9));
    saved = await api.get<ReservationJson>(`/reservations/${stay.id}`);
    expect(saved.checkIn).toBe(addDays(start, 5));
  });

  test('refuses to drop a stay onto dates that are taken, and puts it back', async ({ page }) => {
    const start = windowStart(2);
    const first = await bookCottage(addDays(start, 1), addDays(start, 3), 'First');
    await bookCottage(addDays(start, 4), addDays(start, 7), 'Second');
    await showCalendarFrom(page, start);

    const bar = page.locator(`[data-stay="${first.rooms[0]!.id}"]`);
    const cell = (await dateX(page, addDays(start, 1))) - (await dateX(page, start));
    const box = (await bar.boundingBox())!;
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await drag(page, middle, { x: middle.x + 3 * cell, y: middle.y });

    // The refusal is explained, and nothing changed on the server.
    await expect(
      page.getByRole('alert').filter({ hasText: /No .* is free|already taken|No availability/ }),
    ).toBeVisible();
    const saved = await api.get<ReservationJson>(`/reservations/${first.id}`);
    expect([saved.checkIn, saved.checkOut]).toEqual([addDays(start, 1), addDays(start, 3)]);
    // The bar is back where it was.
    await expect.poll(async () => Math.round(((await bar.boundingBox())?.x ?? 0) - box.x)).toBe(0);
  });

  test('blocks dates from the calendar and releases them again', async ({ page }) => {
    const start = windowStart(3);
    const unit = cottage.roomTypes[0]!.units[0]!;
    const typeId = cottage.roomTypes[0]!.id;
    await showCalendarFrom(page, start);

    const row = page.locator(`[data-row="unit:${unit.id}"]`);
    const y = await rowY(row);
    await drag(
      page,
      { x: await dateX(page, addDays(start, 3)), y },
      { x: await dateX(page, addDays(start, 5)), y },
    );
    await page.getByRole('menuitem', { name: 'Block dates' }).click();

    const dialog = page.getByRole('dialog', { name: 'Block dates' });
    await dialog.getByLabel('Reason').fill('Deep clean');
    await dialog.getByRole('button', { name: 'Block dates' }).click();
    await expect(dialog).toBeHidden();

    const block = row.locator('[data-block]');
    await expect(block).toContainText('Deep clean');
    const cell = page.locator(`[data-availability="${typeId}:${addDays(start, 4)}"]`);
    await expect(cell).toHaveAttribute('data-available', '0');

    // The blocked dates cannot be booked.
    const res = await page.request.post('/api/reservations', {
      data: {
        propertyId: cottage.id,
        guest: { firstName: 'Blocked' },
        rooms: [
          {
            roomTypeId: typeId,
            ratePlanId: cottage.roomTypes[0]!.ratePlans[0]!.id,
            checkIn: addDays(start, 4),
            checkOut: addDays(start, 5),
            adults: 2,
          },
        ],
      },
    });
    expect(res.status()).toBe(409);

    await block.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Release dates' }).click();
    await expect(row.locator('[data-block]')).toHaveCount(0);
    await expect(cell).toHaveAttribute('data-available', '1');
  });

  test('moves a hotel stay to another room by dragging it to that row', async ({ page }) => {
    const start = windowStart(4);
    const standard = hotel.roomTypes[0]!;
    const [from, to] = [standard.units[0]!, standard.units[1]!];
    const stay = await api.post<ReservationJson>('/reservations', {
      propertyId: hotel.id,
      guest: { firstName: 'Room', lastName: 'Changer' },
      rooms: [
        {
          roomTypeId: standard.id,
          ratePlanId: standard.ratePlans[0]!.id,
          unitId: from.id,
          checkIn: addDays(start, 2),
          checkOut: addDays(start, 5),
          adults: 2,
        },
      ],
    });
    await showCalendarFrom(page, start);

    const bar = page.locator(`[data-stay="${stay.rooms[0]!.id}"]`);
    const box = (await bar.boundingBox())!;
    const targetY = await rowY(page.locator(`[data-row="unit:${to.id}"]`));
    await drag(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + box.width / 2, y: targetY },
    );

    await expect
      .poll(
        async () => (await api.get<ReservationJson>(`/reservations/${stay.id}`)).rooms[0]!.unitName,
      )
      .toBe(to.name);
    const saved = await api.get<ReservationJson>(`/reservations/${stay.id}`);
    // Only the room changed.
    expect([saved.checkIn, saved.checkOut]).toEqual([addDays(start, 2), addDays(start, 5)]);
    await expect(
      page.locator(`[data-row="unit:${to.id}"]`).locator(`[data-stay="${stay.rooms[0]!.id}"]`),
    ).toBeVisible();
  });

  test('shows a booking made elsewhere without reloading the page', async ({ page }) => {
    const start = windowStart(5);
    await showCalendarFrom(page, start);
    await expect(page.getByRole('status', { name: 'Live updates connected' })).toBeVisible();

    // Someone else (another screen, or a channel) makes a booking.
    const stay = await bookCottage(addDays(start, 3), addDays(start, 6), 'Elsewhere');
    await expect(page.locator(`[data-stay="${stay.rooms[0]!.id}"]`)).toBeVisible({ timeout: 5000 });

    // ...and cancels it.
    await api.post(`/reservations/${stay.id}/cancel`, { reason: 'e2e' });
    await expect(page.locator(`[data-stay="${stay.rooms[0]!.id}"]`)).toHaveCount(0, {
      timeout: 5000,
    });
  });

  test('opens a stay, changes its dates in the panel and cancels it', async ({ page }) => {
    const start = windowStart(6);
    const stay = await bookCottage(addDays(start, 2), addDays(start, 4), 'Panel');
    await showCalendarFrom(page, start);

    await page.locator(`[data-stay="${stay.rooms[0]!.id}"]`).click();
    const panel = page.getByRole('dialog', { name: `Reservation ${stay.code}` });
    await expect(panel.getByText('Panel Tester').first()).toBeVisible();

    await panel.getByRole('button', { name: 'Change dates or room' }).click();
    await panel.getByLabel('Check-out').fill(addDays(start, 6));
    await panel.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Stay updated')).toBeVisible();
    expect((await api.get<ReservationJson>(`/reservations/${stay.id}`)).checkOut).toBe(
      addDays(start, 6),
    );

    await panel.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel reservation' }).click();
    const confirm = page.getByRole('dialog', { name: `Cancel reservation ${stay.code}?` });
    await confirm.getByLabel('Reason').fill('Changed plans');
    await confirm.getByRole('button', { name: 'Cancel reservation' }).click();
    await expect(panel.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    expect((await api.get<ReservationJson>(`/reservations/${stay.id}`)).status).toBe('cancelled');
  });

  test('holds a villa without confirming, moves the end of the hold, then confirms it', async ({
    page,
  }) => {
    const start = windowStart(7);
    const unit = cottage.roomTypes[0]!.units[0]!;
    const typeId = cottage.roomTypes[0]!.id;
    await showCalendarFrom(page, start);

    const row = page.locator(`[data-row="unit:${unit.id}"]`);
    const y = await rowY(row);
    await drag(
      page,
      { x: await dateX(page, addDays(start, 2)), y },
      { x: await dateX(page, addDays(start, 3)), y },
    );
    await page.getByRole('menuitem', { name: 'New reservation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New reservation' });
    await dialog.getByLabel('First name').fill('Option');
    await dialog.getByLabel('Last name').fill('Holder');
    await dialog.getByLabel('Hold the rooms without confirming yet').check();
    // It starts out a day from now, for the person to change.
    await expect(dialog.getByLabel('Hold until')).not.toHaveValue('');
    await dialog.getByLabel('Hold until').fill(`${addDays(today, 3)}T18:00`);
    await dialog.getByRole('button', { name: 'Hold the rooms' }).click();
    await expect(dialog).toBeHidden();

    // Held, the dates are as taken as if it were confirmed.
    const stay = row.getByRole('button', { name: /Option Holder/ });
    await expect(stay).toBeVisible();
    await expect(
      page.locator(`[data-availability="${typeId}:${addDays(start, 2)}"]`),
    ).toHaveAttribute('data-available', '0');

    await stay.click();
    const panel = page.getByRole('dialog', { name: /^Reservation / });
    await expect(panel.getByText('Held, not yet confirmed')).toBeVisible();
    await expect(panel.getByText(/The hold is released at .*18:00/)).toBeVisible();

    await panel.getByRole('button', { name: 'Change', exact: true }).click();
    const change = page.getByRole('dialog', { name: 'Hold until' });
    await change.getByLabel('Hold until').fill(`${addDays(today, 5)}T09:30`);
    await change.getByRole('button', { name: 'Save' }).click();
    await expect(change).toBeHidden();
    await expect(panel.getByText(/The hold is released at .*09:30/)).toBeVisible();

    await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(panel.getByText('Confirmed', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText('Held, not yet confirmed')).toBeHidden();
  });
});
