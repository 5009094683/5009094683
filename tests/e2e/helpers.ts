import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API_URL, DEMO_LOGIN } from './env';

export async function signIn(page: Page, login = DEMO_LOGIN): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(login.email);
  await page.getByLabel('Password').fill(login.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/calendar');
}

/** An API client signed in as the demo admin, for arranging data a test needs. */
export async function apiClient(request: APIRequestContext): Promise<{
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}> {
  const login = await request.post(`${API_URL}/auth/login`, { data: DEMO_LOGIN });
  expect(login.ok(), await login.text()).toBe(true);
  const call = async <T>(method: 'get' | 'post', path: string, body?: unknown): Promise<T> => {
    const res = await request[method](
      `${API_URL}${path}`,
      method === 'post' ? { data: body ?? {} } : undefined,
    );
    expect(res.ok(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  };
  return { get: (path) => call('get', path), post: (path, body) => call('post', path, body) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayInIndia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/** Points the calendar at a date and waits for that date's column to be on screen. */
export async function showCalendarFrom(page: Page, date: string): Promise<void> {
  await page.getByLabel('Go to date').fill(date);
  await expect(page.locator(`[data-date="${date}"]`)).toBeVisible();
}

/** Horizontal centre of a date's column, in page coordinates. */
export async function dateX(page: Page, date: string): Promise<number> {
  const box = await page.locator(`[data-date="${date}"]`).boundingBox();
  if (!box) throw new Error(`date ${date} is not on screen`);
  return box.x + box.width / 2;
}

export async function rowY(row: Locator): Promise<number> {
  const box = await row.boundingBox();
  if (!box) throw new Error('row is not on screen');
  return box.y + box.height / 2;
}

/** Drags with real mouse events, in steps, the way a person would. */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

export type Api = Awaited<ReturnType<typeof apiClient>>;

export interface TestProperty {
  id: string;
  name: string;
  roomTypes: {
    id: string;
    name: string;
    units: { id: string; name: string }[];
    ratePlans: { id: string; name: string }[];
  }[];
}

/**
 * Creates a property of its own for a spec file, so specs never depend on,
 * or disturb, each other's stays or the demo data. A villa has one unit and
 * two rate plans (a flexible one at 18,000 and a non-refundable one 10%
 * below it); a hotel has one room type with rooms 101 and 102.
 */
export async function createTestProperty(api: Api, kind: 'villa' | 'hotel'): Promise<TestProperty> {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const name = kind === 'villa' ? `Test Cottage ${suffix}` : `Test Hotel ${suffix}`;
  const property = await api.post<{ id: string }>('/properties', {
    code: `T${suffix}`,
    name,
    kind,
  });
  const base = `/properties/${property.id}`;
  const roomType = await api.post<{ id: string }>(`${base}/room-types`, {
    code: kind === 'villa' ? 'VILLA' : 'STD',
    name: kind === 'villa' ? 'Entire Cottage' : 'Standard Room',
    maxAdults: 4,
    maxOccupancy: 5,
  });
  for (const unitName of kind === 'villa' ? ['Cottage'] : ['101', '102']) {
    await api.post(`${base}/units`, { roomTypeId: roomType.id, name: unitName });
  }
  const flexible = await api.post<{ id: string }>(`${base}/rate-plans`, {
    roomTypeId: roomType.id,
    code: 'BAR',
    name: 'Flexible',
    baseRate: 1_800_000,
  });
  await api.post(`${base}/rate-plans`, {
    roomTypeId: roomType.id,
    code: 'NRF',
    name: 'Non-refundable',
    baseRate: 0,
    parentRatePlanId: flexible.id,
    derivedPercentBp: -1000,
    cancellationPolicy: { nonRefundable: true },
  });
  const detail = await api.get<{ roomTypes: TestProperty['roomTypes'] }>(base);
  return { id: property.id, name, roomTypes: detail.roomTypes };
}

/** Makes the calendar show only the given properties, as a user would with the property filter. */
export async function showOnlyProperties(
  page: Page,
  api: Api,
  propertyIds: string[],
): Promise<void> {
  const { properties } = await api.get<{ properties: { id: string }[] }>('/properties');
  const hidden = properties.map((p) => p.id).filter((id) => !propertyIds.includes(id));
  await page.addInitScript(
    (value) => window.localStorage.setItem('pms.calendar.hidden', value),
    JSON.stringify(hidden),
  );
}

/** `PATCH` on the API, on a request context that `apiClient` has signed in. */
export async function apiPatch<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await request.patch(`${API_URL}${path}`, { data: body });
  expect(res.ok(), `PATCH ${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/**
 * Opens a test property to bookings from the guest website. `fields` is anything else
 * the property should have for the test: an address, a phone number, more settings.
 * Returns the property's code, which is its address on the booking site.
 */
export async function takeWebsiteBookings(
  request: APIRequestContext,
  property: TestProperty,
  fields: { settings?: Record<string, unknown> } & Record<string, unknown> = {},
): Promise<string> {
  const { code } = await apiPatch<{ code: string }>(request, `/properties/${property.id}`, {
    ...fields,
    settings: { ...fields.settings, bookingEngineEnabled: true },
  });
  return code;
}
