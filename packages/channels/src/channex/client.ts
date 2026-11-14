import createClient, { type Client } from 'openapi-fetch';
import { ChannelError } from '../adapter';
import type { components, paths } from './generated';

type Schemas = components['schemas'];

export type ChannexRevision = Schemas['BookingRevisions.BookingRevision'];
export type ChannexBooking = Schemas['Bookings.Booking'];
export type ChannexBookingRoom = Schemas['BookingRevisions.BookingRoom'];
export type ChannexAvailabilityUpdate = Schemas['Restrictions.AvailabilityUpdate'];
export type ChannexRestrictionUpdate = Schemas['Restrictions.RestrictionUpdate'];
export type ChannexRestrictionKind = Schemas['Restrictions.RestrictionKind'];
export type ChannexRestrictionValues = Schemas['Restrictions.RestrictionValues'];
export type ChannexWebhook = Schemas['Webhooks.Webhook'];
export type ChannexWebhookWrite = Schemas['Webhooks.WebhookCreate'];
export type ChannexPropertyCreate = Schemas['Properties.PropertyCreate'];
export type ChannexRoomTypeCreate = Schemas['RoomTypes.RoomTypeCreate'];
export type ChannexRatePlanCreate = Schemas['RatePlans.RatePlanCreate'];

export interface ChannexClientOptions {
  /** API root including `/api/v1`. */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AriAcknowledgement {
  /** Ids of the background tasks Channex created; quoted when tracing an update with their support. */
  taskIds: string[];
  /** Change objects Channex refused, in words. */
  warnings: string[];
}

export interface ChannexNamed {
  id: string;
  title: string;
}

export interface ChannexRatePlanSummary extends ChannexNamed {
  roomTypeId: string;
  currency: string | null;
  parentRatePlanId: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;
/** Pages fetched from one listing before giving up, as a guard against a paging loop. */
const MAX_PAGES = 50;

/**
 * When Channex says a quota is exhausted, calls are held back locally until
 * it resets instead of being sent to collect a 429. Shared by every client
 * using the same key, since the quota is per key.
 */
const pausedUntil = new Map<string, number>();

/** Reads `"name";r=5;t=30, ...` and returns how long to wait if any window has nothing left. */
export function exhaustedFor(rateLimitHeader: string | null): number {
  if (!rateLimitHeader) return 0;
  let wait = 0;
  for (const entry of rateLimitHeader.split(',')) {
    const remaining = /;\s*r=(-?\d+)/.exec(entry);
    const reset = /;\s*t=(\d+)/.exec(entry);
    if (remaining && reset && Number(remaining[1]) <= 0) {
      wait = Math.max(wait, Number(reset[1]) * 1000);
    }
  }
  return wait;
}

function describeError(body: unknown): string {
  const errors = (
    body as { errors?: { title?: string; code?: string; details?: unknown } } | undefined
  )?.errors;
  if (!errors) return '';
  const details =
    errors.details && typeof errors.details === 'object'
      ? ` ${JSON.stringify(errors.details)}`
      : '';
  return `${errors.title ?? errors.code ?? 'error'}${details}`.slice(0, 500);
}

function describeWarning(warning: Schemas['Restrictions.UpdateWarning'] | string): string {
  if (typeof warning === 'string') return warning;
  const w = warning as Record<string, unknown>;
  const dates =
    w.date ?? (w.date_from ? `${String(w.date_from)} to ${String(w.date_to)}` : 'unknown dates');
  const target = w.rate_plan_id
    ? `rate plan ${String(w.rate_plan_id)}`
    : `room type ${String(w.room_type_id)}`;
  const reasons = Object.entries((w.warning as Record<string, string[]> | undefined) ?? {})
    .map(([field, why]) => `${field} ${Array.isArray(why) ? why.join(', ') : String(why)}`)
    .join('; ');
  return `${target}, ${String(dates)}: ${reasons || 'refused'}`;
}

/**
 * The Channex API, as far as the PMS uses it. Request and response shapes
 * come from Channex's OpenAPI spec (`schema.ts`), so a call that does not
 * match the spec fails to compile.
 *
 * Every failure is raised as a `ChannelError` that says whether trying again
 * can help, which is all the sync engine needs to know.
 */
export class ChannexClient {
  private readonly api: Client<paths>;
  private readonly key: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  readonly baseUrl: string;

  constructor(private readonly options: ChannexClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.key = `${this.baseUrl}|${options.apiKey}`;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.api = createClient<paths>({
      baseUrl: this.baseUrl,
      headers: { 'user-api-key': options.apiKey, accept: 'application/json' },
      // Channex reads lists as one comma-separated value: filter[restrictions]=rate,max_stay
      querySerializer: { array: { style: 'form', explode: false } },
      fetch: (request) => this.send(request),
    });
  }

  private async send(request: Request): Promise<Response> {
    const wait = (pausedUntil.get(this.key) ?? 0) - Date.now();
    if (wait > 0) {
      throw new ChannelError('The channel manager quota is used up; waiting for it to reset', {
        retryable: true,
        retryAfterMs: wait,
        status: 429,
      });
    }
    let response: Response;
    try {
      response = await this.fetcher(
        new Request(request, { signal: AbortSignal.timeout(this.timeoutMs) }),
      );
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ChannelError(
        timedOut
          ? `The channel manager did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`
          : `The channel manager could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, cause: err },
      );
    }
    const exhausted = exhaustedFor(response.headers.get('ratelimit'));
    if (exhausted > 0) pausedUntil.set(this.key, Date.now() + exhausted);
    return response;
  }

  /** Turns a non-2xx answer into a classified error. */
  private fail(what: string, response: Response, body: unknown): never {
    const status = response.status;
    const detail = describeError(body);
    const suffix = detail ? `: ${detail}` : '';
    if (status === 429) {
      const header = Number(response.headers.get('retry-after'));
      const inBody = Number(
        (body as { errors?: { details?: { retry_after?: number } } })?.errors?.details?.retry_after,
      );
      const seconds =
        Number.isFinite(header) && header > 0
          ? header
          : Number.isFinite(inBody) && inBody > 0
            ? inBody
            : 60;
      pausedUntil.set(
        this.key,
        Math.max(pausedUntil.get(this.key) ?? 0, Date.now() + seconds * 1000),
      );
      throw new ChannelError(
        `${what}: the channel manager asked to slow down for ${seconds} seconds`,
        {
          retryable: true,
          retryAfterMs: seconds * 1000,
          status,
        },
      );
    }
    if (status === 401 || status === 403) {
      throw new ChannelError(
        `${what}: the channel manager refused the API key (${status})${suffix}`,
        {
          retryable: false,
          status,
        },
      );
    }
    if (status >= 500) {
      throw new ChannelError(`${what}: the channel manager failed (${status})${suffix}`, {
        retryable: true,
        status,
      });
    }
    throw new ChannelError(
      `${what}: the channel manager rejected the request (${status})${suffix}`,
      {
        retryable: false,
        status,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Availability, rates and restrictions

  async updateAvailability(values: ChannexAvailabilityUpdate[]): Promise<AriAcknowledgement> {
    const { data, error, response } = await this.api.POST('/availability', { body: { values } });
    if (!data) this.fail('Availability update', response, error);
    return {
      taskIds: data.data.map((t) => t.id),
      warnings: (data.meta.warnings ?? []).map(describeWarning),
    };
  }

  async updateRestrictions(values: ChannexRestrictionUpdate[]): Promise<AriAcknowledgement> {
    const { data, error, response } = await this.api.POST('/restrictions', { body: { values } });
    if (!data) this.fail('Rate update', response, error);
    return {
      taskIds: data.data.map((t) => t.id),
      warnings: (data.meta.warnings ?? []).map(describeWarning),
    };
  }

  /** Rooms available per room type per date, `from` and `to` inclusive. */
  async getAvailability(
    propertyId: string,
    from: string,
    to: string,
  ): Promise<Record<string, Record<string, number>>> {
    const { data, error, response } = await this.api.GET('/availability', {
      params: {
        query: {
          'filter[property_id]': propertyId,
          'filter[date][gte]': from,
          'filter[date][lte]': to,
        },
      },
    });
    if (!data) this.fail('Reading availability', response, error);
    return data.data as unknown as Record<string, Record<string, number>>;
  }

  /** The requested values per rate plan per date, `from` and `to` inclusive. */
  async getRestrictions(
    propertyId: string,
    from: string,
    to: string,
    kinds: ChannexRestrictionKind[],
  ): Promise<Record<string, Record<string, ChannexRestrictionValues>>> {
    const { data, error, response } = await this.api.GET('/restrictions', {
      params: {
        query: {
          'filter[property_id]': propertyId,
          'filter[date][gte]': from,
          'filter[date][lte]': to,
          'filter[restrictions]': kinds,
        },
      },
    });
    if (!data) this.fail('Reading rates', response, error);
    return data.data as unknown as Record<string, Record<string, ChannexRestrictionValues>>;
  }

  // -------------------------------------------------------------------------
  // Bookings

  /** Every booking revision not yet acknowledged, oldest first. */
  async revisionFeed(propertyId?: string): Promise<ChannexRevision[]> {
    const revisions: ChannexRevision[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error, response } = await this.api.GET('/booking_revisions/feed', {
        params: {
          query: {
            'pagination[page]': page,
            'pagination[limit]': PAGE_LIMIT,
            'order[inserted_at]': 'asc',
            ...(propertyId ? { 'filter[property_id]': propertyId } : {}),
          },
        },
      });
      if (!data) this.fail('Fetching bookings', response, error);
      revisions.push(...data.data.map((r) => r.attributes));
      if (data.data.length < PAGE_LIMIT) break;
    }
    return revisions;
  }

  async getRevision(id: string): Promise<ChannexRevision | null> {
    const { data, error, response } = await this.api.GET('/booking_revisions/{id}', {
      params: { path: { id } },
    });
    if (response.status === 404) return null;
    if (!data) this.fail('Fetching a booking', response, error);
    return data.data.attributes;
  }

  async acknowledgeRevision(id: string): Promise<void> {
    const { error, response } = await this.api.POST('/booking_revisions/{id}/ack', {
      params: { path: { id } },
    });
    // Unknown here means it is not waiting to be acknowledged, which is the state we want.
    if (response.status === 404) return;
    if (!response.ok) this.fail('Acknowledging a booking', response, error);
  }

  /** Bookings arriving on or after `arrivingFrom`, in their latest state. For the first import. */
  async listBookings(propertyId: string, arrivingFrom: string): Promise<ChannexBooking[]> {
    const bookings: ChannexBooking[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error, response } = await this.api.GET('/bookings', {
        params: {
          query: {
            'pagination[page]': page,
            'pagination[limit]': PAGE_LIMIT,
            'filter[property_id]': propertyId,
            'filter[departure_date][gte]': arrivingFrom,
            'order[inserted_at]': 'asc',
          },
        },
      });
      if (!data) this.fail('Listing bookings', response, error);
      bookings.push(...data.data.map((b) => b.attributes));
      if (data.data.length < PAGE_LIMIT) break;
    }
    return bookings;
  }

  // -------------------------------------------------------------------------
  // Structure: properties, room types, rate plans

  async whoami(): Promise<{ id: string; email: string | null; name: string | null }> {
    const { data, error, response } = await this.api.GET('/whoami');
    if (!data) this.fail('Checking the API key', response, error);
    const user = (
      data as { data?: { id?: string; attributes?: { email?: string; name?: string } } }
    ).data;
    return {
      id: user?.id ?? '',
      email: user?.attributes?.email ?? null,
      name: user?.attributes?.name ?? null,
    };
  }

  async listProperties(): Promise<(ChannexNamed & { currency: string | null })[]> {
    const out: (ChannexNamed & { currency: string | null })[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error, response } = await this.api.GET('/properties', {
        params: {
          query: {
            'pagination[page]': page,
            'pagination[limit]': PAGE_LIMIT,
            'order[title]': 'asc',
          },
        },
      });
      if (!data) this.fail('Listing properties', response, error);
      out.push(
        ...data.data.map((p) => ({
          id: p.id,
          title: p.attributes.title,
          currency: p.attributes.currency ?? null,
        })),
      );
      if (data.data.length < PAGE_LIMIT) break;
    }
    return out;
  }

  async getProperty(
    id: string,
  ): Promise<(ChannexNamed & { currency: string | null; timezone: string | null }) | null> {
    const { data, error, response } = await this.api.GET('/properties/{id}', {
      params: { path: { id } },
    });
    if (response.status === 404) return null;
    if (!data) this.fail('Reading the property', response, error);
    const a = data.data.attributes;
    return {
      id: data.data.id,
      title: a.title,
      currency: a.currency ?? null,
      timezone: a.timezone ?? null,
    };
  }

  async createProperty(property: ChannexPropertyCreate): Promise<ChannexNamed> {
    const { data, error, response } = await this.api.POST('/properties', { body: { property } });
    if (!data) this.fail('Creating the property', response, error);
    return { id: data.data.id, title: data.data.attributes.title };
  }

  async listRoomTypes(propertyId: string): Promise<(ChannexNamed & { countOfRooms: number })[]> {
    const out: (ChannexNamed & { countOfRooms: number })[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error, response } = await this.api.GET('/room_types', {
        params: {
          query: {
            'filter[property_id]': propertyId,
            'pagination[page]': page,
            'pagination[limit]': PAGE_LIMIT,
          },
        },
      });
      if (!data) this.fail('Listing room types', response, error);
      out.push(
        ...data.data.map((r) => ({
          id: r.id,
          title: r.attributes.title,
          countOfRooms: r.attributes.count_of_rooms,
        })),
      );
      if (data.data.length < PAGE_LIMIT) break;
    }
    return out;
  }

  async createRoomType(roomType: ChannexRoomTypeCreate): Promise<ChannexNamed> {
    const { data, error, response } = await this.api.POST('/room_types', {
      body: { room_type: roomType },
    });
    if (!data) this.fail('Creating a room type', response, error);
    return { id: data.data.id, title: data.data.attributes.title };
  }

  async listRatePlans(propertyId: string): Promise<ChannexRatePlanSummary[]> {
    const out: ChannexRatePlanSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error, response } = await this.api.GET('/rate_plans', {
        params: {
          query: {
            'filter[property_id]': propertyId,
            'pagination[page]': page,
            'pagination[limit]': PAGE_LIMIT,
          },
        },
      });
      if (!data) this.fail('Listing rate plans', response, error);
      out.push(
        ...data.data.map((r) => ({
          id: r.id,
          title: r.attributes.title,
          roomTypeId: r.relationships.room_type.data.id,
          currency: r.attributes.currency ?? null,
          parentRatePlanId: r.relationships.parent_rate_plan?.data?.id ?? null,
        })),
      );
      if (data.data.length < PAGE_LIMIT) break;
    }
    return out;
  }

  async createRatePlan(ratePlan: ChannexRatePlanCreate): Promise<ChannexNamed> {
    const { data, error, response } = await this.api.POST('/rate_plans', {
      body: { rate_plan: ratePlan },
    });
    if (!data) this.fail('Creating a rate plan', response, error);
    return { id: data.data.id, title: data.data.attributes.title };
  }

  // -------------------------------------------------------------------------
  // Webhooks

  async listWebhooks(): Promise<ChannexWebhook[]> {
    const { data, error, response } = await this.api.GET('/webhooks', {
      params: { query: { 'pagination[limit]': PAGE_LIMIT } },
    });
    if (!data) this.fail('Listing webhooks', response, error);
    return data.data.map((w) => w.attributes);
  }

  async createWebhook(webhook: ChannexWebhookWrite): Promise<ChannexWebhook> {
    const { data, error, response } = await this.api.POST('/webhooks', { body: { webhook } });
    if (!data) this.fail('Creating the webhook', response, error);
    return data.data.attributes;
  }

  async updateWebhook(id: string, webhook: Partial<ChannexWebhookWrite>): Promise<ChannexWebhook> {
    const { data, error, response } = await this.api.PUT('/webhooks/{id}', {
      params: { path: { id } },
      body: { webhook },
    });
    if (!data) this.fail('Updating the webhook', response, error);
    return data.data.attributes;
  }

  async deleteWebhook(id: string): Promise<void> {
    const { error, response } = await this.api.DELETE('/webhooks/{id}', {
      params: { path: { id } },
    });
    if (!response.ok && response.status !== 404) this.fail('Removing the webhook', response, error);
  }

  // -------------------------------------------------------------------------
  // Embedded channel screen

  /**
   * A single-use token that signs a user into Channex's embedded channel
   * screen for one property. This endpoint is documented by Channex but is
   * not part of their published OpenAPI spec, hence the untyped call.
   */
  // -------------------------------------------------------------------------
  // Guest messages
  //
  // The message endpoints are documented in Channex's API guide but most are
  // missing from the published OpenAPI spec, hence the untyped calls.

  private async json<T>(
    what: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ response: Response; body: T | undefined }> {
    const request = new Request(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'user-api-key': this.options.apiKey,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await this.send(request);
    const parsed = (await response.json().catch(() => undefined)) as T | undefined;
    if (!response.ok && response.status !== 404) this.fail(what, response, parsed);
    return { response, body: parsed };
  }

  async listThreads(propertyId: string): Promise<ChannexThreadResource[]> {
    const { body } = await this.json<{ data?: ChannexThreadResource[] }>(
      'Listing guest conversations',
      'GET',
      `/message_threads?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=${PAGE_LIMIT}`,
    );
    return body?.data ?? [];
  }

  async getThread(threadId: string): Promise<ChannexThreadResource | null> {
    const { response, body } = await this.json<{ data?: ChannexThreadResource }>(
      'Reading a guest conversation',
      'GET',
      `/message_threads/${encodeURIComponent(threadId)}`,
    );
    return response.status === 404 ? null : (body?.data ?? null);
  }

  /** Every message of a thread, in whatever order the pages come; callers sort. */
  async threadMessages(threadId: string): Promise<ChannexMessageResource[]> {
    const out: ChannexMessageResource[] = [];
    for (let page = 1; page <= 20; page++) {
      const { response, body } = await this.json<{
        data?: ChannexMessageResource[];
        meta?: { total?: number };
      }>(
        'Reading guest messages',
        'GET',
        `/message_threads/${encodeURIComponent(threadId)}/messages?pagination[page]=${page}&pagination[limit]=${PAGE_LIMIT}`,
      );
      if (response.status === 404) break;
      const data = body?.data ?? [];
      out.push(...data);
      if (data.length < PAGE_LIMIT || out.length >= (body?.meta?.total ?? Infinity)) break;
    }
    return out;
  }

  async sendThreadMessage(threadId: string, text: string): Promise<ChannexMessageResource> {
    const { response, body } = await this.json<{ data?: ChannexMessageResource }>(
      'Sending a message',
      'POST',
      `/message_threads/${encodeURIComponent(threadId)}/messages`,
      { message: { message: text } },
    );
    if (!body?.data) this.fail('Sending a message', response, body);
    return body.data;
  }

  async sendBookingMessage(bookingId: string, text: string): Promise<ChannexMessageResource> {
    const { response, body } = await this.json<{ data?: ChannexMessageResource }>(
      'Sending a message',
      'POST',
      `/bookings/${encodeURIComponent(bookingId)}/messages`,
      { message: { message: text } },
    );
    if (!body?.data) this.fail('Sending a message', response, body);
    return body.data;
  }

  // -------------------------------------------------------------------------
  // Reviews

  async listReviews(propertyId: string): Promise<ChannexReviewResource[]> {
    const { body } = await this.json<{ data?: ChannexReviewResource[] }>(
      'Listing reviews',
      'GET',
      `/reviews?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=${PAGE_LIMIT}`,
    );
    return body?.data ?? [];
  }

  async replyToReview(reviewId: string, text: string): Promise<void> {
    const { response, body } = await this.json<unknown>(
      'Replying to a review',
      'POST',
      `/reviews/${encodeURIComponent(reviewId)}/reply`,
      { reply: { reply: text } },
    );
    if (!response.ok) this.fail('Replying to a review', response, body);
  }

  async oneTimeToken(propertyId: string, username: string): Promise<string> {
    const request = new Request(`${this.baseUrl}/auth/one_time_token`, {
      method: 'POST',
      headers: {
        'user-api-key': this.options.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ one_time_token: { property_id: propertyId, username } }),
    });
    const response = await this.send(request);
    const body = (await response.json().catch(() => undefined)) as
      { data?: { token?: string } } | undefined;
    if (!response.ok || !body?.data?.token) this.fail('Opening the channel screen', response, body);
    return body.data.token;
  }
}

/** A message thread as Channex returns it. Not part of the published OpenAPI spec; shaped from the API guide. */
export interface ChannexThreadResource {
  id: string;
  attributes: {
    title?: string | null;
    provider?: string | null;
    is_closed?: boolean;
    last_message_received_at?: string | null;
    updated_at?: string | null;
  };
  relationships?: { booking?: { data?: { id?: string } | null } };
}

export interface ChannexMessageResource {
  id: string;
  attributes: {
    message?: string | null;
    sender?: string | null;
    attachments?: unknown[];
    inserted_at?: string | null;
  };
  relationships?: { message_thread?: { data?: { id?: string } | null } };
}

/** A review as Channex returns it (reviews add-on). Shaped from the API guide. */
export interface ChannexReviewResource {
  id: string;
  attributes: {
    content?: string | null;
    guest_name?: string | null;
    ota?: string | null;
    ota_reservation_id?: string | null;
    overall_score?: number | null;
    scores?: { category?: string; score?: number }[] | null;
    received_at?: string | null;
    inserted_at?: string | null;
    is_hidden?: boolean;
    is_replied?: boolean;
    reply?: string | null;
  };
}

/** Test hook: forget any locally remembered quota pauses. */
export function resetChannexThrottle(): void {
  pausedUntil.clear();
}
