import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { addDays, decimalToMinor, eachDate, isValidDate, minorToDecimal } from '@pms/domain/shared';
import {
  CHANNELS,
  SimError,
  type SimMessage,
  type SimState,
  type SimThread,
  type SimWebhook,
} from './state';

/** Events a webhook may subscribe to, as the real service lists them. */
const WEBHOOK_EVENTS = new Set([
  'ari',
  'booking',
  'booking_new',
  'booking_modification',
  'booking_cancellation',
  'booking_unmapped_room',
  'booking_unmapped_rate',
  'non_acked_booking',
  'message',
  'sync_error',
  'sync_warning',
  'rate_error',
  'reservation_request',
  'alteration_request',
  'accepted_reservation',
  'declined_reservation',
  'inquiry',
  'review',
  'updated_review',
  'new_channel',
  'updated_channel',
  'disconnect_channel',
  'disconnect_listing',
  'activate_channel',
  'deactivate_channel',
  'channel_removal_warning',
  'property_removal_warning',
  'message_thread_booking_assigned',
]);

const unauthorized = { errors: { code: 'unauthorized', title: 'Unauthorized' } };
const notFound = { errors: { code: 'resource_not_found', title: 'Resource Not Found' } };

function validationError(details: Record<string, string[]>) {
  return { errors: { code: 'validation_error', title: 'Validation Error', details } };
}

type Query = Record<string, string | undefined>;

function paging(query: Query): { page: number; limit: number } {
  const page = Math.max(1, Number(query['pagination[page]'] ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(query['pagination[limit]'] ?? 10) || 10));
  return { page, limit };
}

function paginate<T>(
  items: T[],
  query: Query,
): { data: T[]; meta: { total: number; page: number; limit: number } } {
  const { page, limit } = paging(query);
  return {
    data: items.slice((page - 1) * limit, page * limit),
    meta: { total: items.length, page, limit },
  };
}

function dateFilter(query: Query): { from: string; to: string } | null {
  const single = query['filter[date]'];
  const from = single ?? query['filter[date][gte]'];
  const to = single ?? query['filter[date][lte]'];
  if (!isValidDate(from) || !isValidDate(to) || to < from) return null;
  return { from, to };
}

export interface ChannexApiOptions {
  apiKeys: string[];
}

/** The part of the Channex API the PMS uses, served under `/api/v1`. */
export async function channexApi(
  app: FastifyInstance,
  options: { state: SimState } & ChannexApiOptions,
): Promise<void> {
  const { state } = options;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (state.faults.latencyMs > 0)
      await new Promise((resolve) => setTimeout(resolve, state.faults.latencyMs));
    if (Date.now() < state.faults.outageUntil) {
      return reply
        .status(503)
        .send({ errors: { code: 'service_unavailable', title: 'Service Unavailable' } });
    }
    if (state.faults.failNext > 0) {
      state.faults.failNext--;
      const status = state.faults.failStatus;
      if (status === 429) void reply.header('retry-after', '2');
      return reply.status(status).send({
        errors: {
          code: status === 429 ? 'http_too_many_requests' : 'internal_error',
          title: 'Simulated failure',
        },
      });
    }
    const key = req.headers['user-api-key'];
    if (typeof key !== 'string' || !options.apiKeys.includes(key))
      return reply.status(401).send(unauthorized);
    void reply.header('ratelimit-policy', '"api-key-minute";q=600;w=60');
    void reply.header('ratelimit', '"api-key-minute";r=590;t=30');
  });

  app.addHook('onResponse', async (req, reply) => {
    const body = req.body as { values?: unknown[] } | undefined;
    state.log({
      at: new Date().toISOString(),
      method: req.method,
      path: req.url.split('?')[0]!.replace(/^\/api\/v1/, ''),
      status: reply.statusCode,
      values: Array.isArray(body?.values) ? body.values.length : undefined,
    });
  });

  app.get('/whoami', async () => ({
    data: {
      type: 'user',
      id: '00000000-0000-4000-8000-000000000001',
      attributes: { email: 'sim@ota-sim.local', name: 'Simulator' },
    },
  }));

  // ---------------------------------------------------------------------------
  // Properties, room types, rate plans

  const propertyResource = (id: string) => {
    const p = state.properties.get(id)!;
    return {
      type: 'property',
      id: p.id,
      attributes: {
        id: p.id,
        title: p.title,
        currency: p.currency,
        timezone: p.timezone,
        property_type: p.propertyType,
        is_active: true,
        acc_channels_count: state.channelsOf(p.id).filter((c) => c.active).length,
        settings: {
          min_stay_type: 'both',
          state_length: 500,
          allow_availability_autoupdate_on_confirmation: true,
        },
      },
      relationships: {},
    };
  };

  app.get('/properties', async (req) => {
    const all = [...state.properties.values()].sort((a, b) => a.title.localeCompare(b.title));
    const page = paginate(all, req.query as Query);
    return { data: page.data.map((p) => propertyResource(p.id)), meta: page.meta };
  });

  app.get('/properties/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!state.properties.has(id)) return reply.status(404).send(notFound);
    return { data: propertyResource(id) };
  });

  app.post('/properties', async (req, reply) => {
    const input = (req.body as { property?: Record<string, unknown> })?.property ?? {};
    const problems: Record<string, string[]> = {};
    if (typeof input.title !== 'string' || !input.title.trim()) problems.title = ["can't be blank"];
    if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency))
      problems.currency = ['is invalid'];
    if (Object.keys(problems).length > 0) return reply.status(422).send(validationError(problems));
    const property = state.createProperty({
      title: String(input.title).trim(),
      currency: String(input.currency),
      timezone: typeof input.timezone === 'string' ? input.timezone : null,
      propertyType: typeof input.property_type === 'string' ? input.property_type : null,
    });
    return reply.status(201).send({ data: propertyResource(property.id) });
  });

  const roomTypeResource = (id: string) => {
    const r = state.roomTypes.get(id)!;
    return {
      type: 'room_type',
      id: r.id,
      attributes: {
        id: r.id,
        title: r.title,
        count_of_rooms: r.countOfRooms,
        occ_adults: r.occAdults,
        occ_children: r.occChildren,
        occ_infants: r.occInfants,
        default_occupancy: r.defaultOccupancy,
        room_kind: 'room',
      },
      relationships: {
        property: { data: { type: 'property', id: r.propertyId } },
        facilities: { data: [] },
      },
    };
  };

  app.get('/room_types', async (req) => {
    const query = req.query as Query;
    const all = [...state.roomTypes.values()].filter(
      (r) => !query['filter[property_id]'] || r.propertyId === query['filter[property_id]'],
    );
    const page = paginate(all, query);
    return { data: page.data.map((r) => roomTypeResource(r.id)), meta: page.meta };
  });

  app.post('/room_types', async (req, reply) => {
    const input = (req.body as { room_type?: Record<string, unknown> })?.room_type ?? {};
    const problems: Record<string, string[]> = {};
    if (!state.properties.has(String(input.property_id))) problems.property_id = ['does not exist'];
    if (typeof input.title !== 'string' || !input.title.trim()) problems.title = ["can't be blank"];
    if (!Number.isInteger(input.count_of_rooms) || (input.count_of_rooms as number) < 1) {
      problems.count_of_rooms = ['must be greater than 0'];
    }
    if (!Number.isInteger(input.occ_adults) || (input.occ_adults as number) < 1)
      problems.occ_adults = ['must be greater than 0'];
    if (Object.keys(problems).length > 0) return reply.status(422).send(validationError(problems));
    const roomType = state.createRoomType({
      propertyId: String(input.property_id),
      title: String(input.title).trim(),
      countOfRooms: input.count_of_rooms as number,
      occAdults: input.occ_adults as number,
      occChildren: Number(input.occ_children ?? 0),
      occInfants: Number(input.occ_infants ?? 0),
      defaultOccupancy: Number(input.default_occupancy ?? input.occ_adults),
    });
    return reply.status(201).send({ data: roomTypeResource(roomType.id) });
  });

  const ratePlanResource = (id: string) => {
    const p = state.ratePlans.get(id)!;
    return {
      type: 'rate_plan',
      id: p.id,
      attributes: {
        id: p.id,
        title: p.title,
        currency: p.currency,
        sell_mode: 'per_room',
        rate_mode: 'manual',
        options: [
          { occupancy: 2, is_primary: true, rate: minorToDecimal(p.defaultRate, p.currency) },
        ],
      },
      relationships: {
        property: { data: { type: 'property', id: p.propertyId } },
        room_type: { data: { type: 'room_type', id: p.roomTypeId } },
      },
    };
  };

  app.get('/rate_plans', async (req) => {
    const query = req.query as Query;
    const all = [...state.ratePlans.values()].filter(
      (p) =>
        (!query['filter[property_id]'] || p.propertyId === query['filter[property_id]']) &&
        (!query['filter[room_type_id]'] || p.roomTypeId === query['filter[room_type_id]']),
    );
    const page = paginate(all, query);
    return { data: page.data.map((p) => ratePlanResource(p.id)), meta: page.meta };
  });

  app.post('/rate_plans', async (req, reply) => {
    const input = (req.body as { rate_plan?: Record<string, unknown> })?.rate_plan ?? {};
    const problems: Record<string, string[]> = {};
    const property = state.properties.get(String(input.property_id));
    const roomType = state.roomTypes.get(String(input.room_type_id));
    if (!property) problems.property_id = ['does not exist'];
    if (!roomType || roomType.propertyId !== input.property_id)
      problems.room_type_id = ['does not exist'];
    if (typeof input.title !== 'string' || !input.title.trim()) problems.title = ["can't be blank"];
    const options = Array.isArray(input.options)
      ? (input.options as Record<string, unknown>[])
      : [];
    if (options.filter((o) => o.is_primary === true).length !== 1)
      problems.options = ['exactly one option must be primary'];
    if (Object.keys(problems).length > 0) return reply.status(422).send(validationError(problems));
    const currency =
      typeof input.currency === 'string' ? input.currency.toUpperCase() : property!.currency;
    const primary = options.find((o) => o.is_primary === true)!;
    const rate =
      typeof primary.rate === 'number'
        ? primary.rate
        : (decimalToMinor(primary.rate as string | undefined, currency) ?? 0);
    const plan = state.createRatePlan({
      propertyId: property!.id,
      roomTypeId: roomType!.id,
      title: String(input.title).trim(),
      currency,
      defaultRate: rate,
    });
    return reply.status(201).send({ data: ratePlanResource(plan.id) });
  });

  // ---------------------------------------------------------------------------
  // Availability, rates and restrictions

  function ariUpdate(endpoint: 'availability' | 'restrictions') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const values = (req.body as { values?: unknown })?.values;
      if (!Array.isArray(values)) {
        return reply.status(400).send({
          errors: { code: 'bad_request', title: 'Bad Request', details: ['values is required'] },
        });
      }
      const changes = values as Record<string, unknown>[];
      // The per-property limit is checked for each property named in the body.
      for (const propertyId of new Set(changes.map((c) => String(c.property_id)))) {
        const slot = state.takeAriSlot(endpoint, propertyId);
        if (!slot.ok) {
          void reply.header('retry-after', String(slot.retryAfter));
          return reply.status(429).send({
            errors: {
              code: 'http_too_many_requests',
              title: `Too Many Requests: retry after ${new Date(Date.now() + slot.retryAfter * 1000).toUTCString()}`,
              details: { retry_after: slot.retryAfter, id: propertyId },
            },
          });
        }
      }
      const result =
        endpoint === 'availability'
          ? state.applyAvailability(changes)
          : state.applyRestrictions(changes);
      const tasks = [...result.properties].map((propertyId) => {
        const task = { id: randomUUID(), propertyId, kind: endpoint, at: new Date().toISOString() };
        state.tasks.push(task);
        return { id: task.id, type: 'task' };
      });
      return {
        data: tasks,
        meta: {
          message: 'Success',
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : { warnings: [] }),
        },
      };
    };
  }

  app.post('/availability', ariUpdate('availability'));
  app.post('/restrictions', ariUpdate('restrictions'));

  app.get('/availability', async (req, reply) => {
    const query = req.query as Query;
    const range = dateFilter(query);
    const propertyId = query['filter[property_id]'];
    if (!range || !propertyId) {
      return reply.status(400).send({
        errors: { code: 'bad_request', title: 'Bad Request', details: ['date is required'] },
      });
    }
    const data: Record<string, Record<string, number>> = {};
    for (const roomType of state.roomTypes.values()) {
      if (roomType.propertyId !== propertyId) continue;
      data[roomType.id] = Object.fromEntries(
        eachDate(range.from, addDays(range.to, 1)).map((d) => [
          d,
          state.availabilityOn(roomType.id, d),
        ]),
      );
    }
    return { data };
  });

  app.get('/restrictions', async (req, reply) => {
    const query = req.query as Query;
    const range = dateFilter(query);
    const propertyId = query['filter[property_id]'];
    const kinds = (query['filter[restrictions]'] ?? '').split(',').filter(Boolean);
    if (!range || !propertyId || kinds.length === 0) {
      return reply.status(400).send({
        errors: {
          code: 'bad_request',
          title: 'Bad Request',
          details: ['restrictions is required'],
        },
      });
    }
    const data: Record<string, Record<string, Record<string, unknown>>> = {};
    for (const plan of state.ratePlans.values()) {
      if (plan.propertyId !== propertyId) continue;
      data[plan.id] = {};
      for (const d of eachDate(range.from, addDays(range.to, 1))) {
        const r = state.restrictionOn(plan.id, d);
        const availability = Math.max(0, state.availabilityOn(plan.roomTypeId, d));
        const all: Record<string, unknown> = {
          availability,
          rate: minorToDecimal(r.rate, plan.currency),
          min_stay_arrival: r.minStayArrival,
          min_stay_through: r.minStayThrough,
          max_stay: r.maxStay,
          closed_to_arrival: r.closedToArrival,
          closed_to_departure: r.closedToDeparture,
          // A date with no rooms or no price is closed whether or not anyone closed it.
          stop_sell: r.stopSell || availability === 0 || r.rate === 0,
          stop_sell_manual: r.stopSell,
          availability_offset: 0,
          max_availability: null,
          max_sell: null,
        };
        data[plan.id]![d] = Object.fromEntries(
          kinds.filter((k) => k in all).map((k) => [k, all[k]]),
        );
      }
    }
    return { data };
  });

  // ---------------------------------------------------------------------------
  // Bookings

  const revisionResource = (id: string) => {
    const revision = state.revisions.get(id)!;
    return {
      type: 'booking_revision',
      id: revision.id,
      attributes: state.revisionForApi(revision),
      relationships: {
        data: {
          booking: { id: revision.bookingId, type: 'booking' },
          property: { id: revision.propertyId, type: 'property' },
        },
      },
    };
  };

  app.get('/booking_revisions/feed', async (req) => {
    const query = req.query as Query;
    const page = paginate(state.feed(query['filter[property_id]']), query);
    return { data: page.data.map((r) => revisionResource(r.id)), meta: page.meta };
  });

  app.get('/booking_revisions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!state.revisions.has(id)) return reply.status(404).send(notFound);
    return { data: revisionResource(id) };
  });

  app.post('/booking_revisions/:id/ack', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!state.acknowledge(id)) return reply.status(404).send(notFound);
    return { meta: { message: 'Success' } };
  });

  app.get('/bookings', async (req) => {
    const query = req.query as Query;
    const propertyId = query['filter[property_id]'];
    const departingFrom = query['filter[departure_date][gte]'];
    const all = [...state.bookings.values()]
      .filter((b) => !propertyId || b.propertyId === propertyId)
      .map((b) => {
        const latest = state.revisions.get(b.revisionIds[b.revisionIds.length - 1]!)!;
        const attributes: Record<string, unknown> = {
          ...state.revisionForApi(latest),
          id: b.id,
          revision_id: latest.id,
          has_unacked_revisions: b.revisionIds.some((r) => !state.revisions.get(r)!.acknowledged),
        };
        return { type: 'booking', id: b.id, attributes };
      })
      .filter((b) => !departingFrom || String(b.attributes.departure_date ?? '') >= departingFrom)
      .sort((a, b) =>
        String(a.attributes.inserted_at).localeCompare(String(b.attributes.inserted_at)),
      );
    return paginate(all, query);
  });

  // ---------------------------------------------------------------------------
  // Webhooks

  const webhookResource = (w: SimWebhook) => ({
    type: 'webhook',
    id: w.id,
    attributes: {
      id: w.id,
      callback_url: w.callbackUrl,
      event_mask: w.eventMask,
      headers: w.headers,
      is_active: w.isActive,
      is_global: w.isGlobal,
      is_signed: w.isSigned,
      protected: false,
      request_params: {},
      send_data: w.sendData,
      signing_key_id: null,
    },
    relationships: {
      billing_account: {
        data: { type: 'billing_account', id: '00000000-0000-4000-8000-0000000000ba' },
      },
      organization: { data: { type: 'organization', id: '00000000-0000-4000-8000-00000000000a' } },
    },
  });

  function webhookProblems(
    input: Record<string, unknown>,
    creating: boolean,
  ): Record<string, string[]> {
    const problems: Record<string, string[]> = {};
    if (creating || input.callback_url !== undefined) {
      if (typeof input.callback_url !== 'string' || !/^https?:\/\//.test(input.callback_url)) {
        problems.callback_url = ['is invalid'];
      }
    }
    if (creating || input.event_mask !== undefined) {
      const mask = input.event_mask;
      if (typeof mask !== 'string' || !mask) problems.event_mask = ["can't be blank"];
      else if (mask !== '*') {
        const unknown = mask.split(';').filter((e) => !WEBHOOK_EVENTS.has(e));
        if (unknown.length > 0) problems.event_mask = [`unknown event: ${unknown.join(', ')}`];
      }
    }
    if (creating && !input.is_global && !state.properties.has(String(input.property_id))) {
      problems.property_id = ['is required unless is_global is true'];
    }
    return problems;
  }

  // -------------------------------------------------------------------------
  // Guest messages (the paid messages add-on)

  const forbidden = { errors: { code: 'forbidden', title: 'Forbidden' } };

  const messageResource = (m: SimMessage) => ({
    type: 'message',
    id: m.id,
    attributes: {
      message: m.message,
      attachments: [],
      sender: m.sender,
      inserted_at: m.insertedAt,
      updated_at: m.insertedAt,
    },
    relationships: { message_thread: { data: { id: m.threadId, type: 'message_thread' } } },
  });

  const threadResource = (t: SimThread) => {
    const last = t.messages[t.messages.length - 1];
    return {
      type: 'message_thread',
      id: t.id,
      attributes: {
        title: t.title,
        is_closed: t.isClosed,
        provider: t.provider,
        message_count: t.messages.length,
        last_message: last
          ? {
              attachments: [],
              inserted_at: last.insertedAt,
              message: last.message,
              sender: last.sender,
            }
          : null,
        last_message_received_at: last?.insertedAt ?? null,
        inserted_at: t.insertedAt,
        updated_at: last?.insertedAt ?? t.insertedAt,
      },
      relationships: {
        booking: { data: { id: t.bookingId, type: 'booking' } },
        property: { data: { id: t.propertyId, type: 'property' } },
      },
    };
  };

  const newestFirst = (messages: SimMessage[]) =>
    [...messages].sort((a, b) => b.insertedAt.localeCompare(a.insertedAt));

  app.get('/message_threads', async (req, reply) => {
    const query = req.query as Query;
    const propertyId = query['filter[property_id]'];
    if (propertyId && state.messagingDisabled.has(propertyId)) {
      return reply.status(403).send(forbidden);
    }
    const all = [...state.threads.values()]
      .filter((t) => !propertyId || t.propertyId === propertyId)
      .filter((t) => !state.messagingDisabled.has(t.propertyId))
      .sort((a, b) =>
        (b.messages[b.messages.length - 1]?.insertedAt ?? b.insertedAt).localeCompare(
          a.messages[a.messages.length - 1]?.insertedAt ?? a.insertedAt,
        ),
      );
    const page = paginate(all, query);
    return { data: page.data.map(threadResource), meta: page.meta };
  });

  app.get('/message_threads/:id', async (req, reply) => {
    const thread = state.threads.get((req.params as { id: string }).id);
    if (!thread) return reply.status(404).send(notFound);
    if (state.messagingDisabled.has(thread.propertyId)) return reply.status(403).send(forbidden);
    return { data: threadResource(thread) };
  });

  app.get('/message_threads/:id/messages', async (req, reply) => {
    const thread = state.threads.get((req.params as { id: string }).id);
    if (!thread) return reply.status(404).send(notFound);
    if (state.messagingDisabled.has(thread.propertyId)) return reply.status(403).send(forbidden);
    const page = paginate(newestFirst(thread.messages), req.query as Query);
    return { data: page.data.map(messageResource), meta: page.meta };
  });

  const textOf = (body: unknown): string | null => {
    const text = (body as { message?: { message?: unknown } } | undefined)?.message?.message;
    return typeof text === 'string' && text.trim() ? text : null;
  };

  app.post('/message_threads/:id/messages', async (req, reply) => {
    const thread = state.threads.get((req.params as { id: string }).id);
    if (!thread) return reply.status(404).send(notFound);
    if (state.messagingDisabled.has(thread.propertyId)) return reply.status(403).send(forbidden);
    const text = textOf(req.body);
    if (!text) return reply.status(422).send(validationError({ message: ["can't be blank"] }));
    return { data: messageResource(state.propertyMessage({ threadId: thread.id }, text)) };
  });

  app.get('/bookings/:id/messages', async (req, reply) => {
    const booking = state.bookings.get((req.params as { id: string }).id);
    if (!booking) return reply.status(404).send(notFound);
    if (state.messagingDisabled.has(booking.propertyId)) return reply.status(403).send(forbidden);
    const thread = [...state.threads.values()].find((t) => t.bookingId === booking.id);
    const page = paginate(newestFirst(thread?.messages ?? []), req.query as Query);
    return { data: page.data.map(messageResource), meta: page.meta };
  });

  app.post('/bookings/:id/messages', async (req, reply) => {
    const booking = state.bookings.get((req.params as { id: string }).id);
    if (!booking) return reply.status(404).send(notFound);
    if (state.messagingDisabled.has(booking.propertyId)) return reply.status(403).send(forbidden);
    // As on the real service: only some booking sites have a message box.
    if (!['BDC', 'ABB', 'EXP'].includes(booking.channel)) {
      return reply
        .status(422)
        .send({ errors: { code: 'not_supported', title: 'Method not supported' } });
    }
    const text = textOf(req.body);
    if (!text) return reply.status(422).send(validationError({ message: ["can't be blank"] }));
    return { data: messageResource(state.propertyMessage({ bookingId: booking.id }, text)) };
  });

  app.get('/webhooks', async (req) => {
    const page = paginate([...state.webhooks.values()], req.query as Query);
    return { data: page.data.map(webhookResource), meta: page.meta };
  });

  app.post('/webhooks', async (req, reply) => {
    const input = (req.body as { webhook?: Record<string, unknown> })?.webhook ?? {};
    const problems = webhookProblems(input, true);
    const duplicate = [...state.webhooks.values()].some(
      (w) => w.callbackUrl === input.callback_url && w.eventMask === input.event_mask,
    );
    if (duplicate) problems.callback_url = ['has already been taken'];
    if (Object.keys(problems).length > 0) return reply.status(422).send(validationError(problems));
    const webhook: SimWebhook = {
      id: randomUUID(),
      callbackUrl: String(input.callback_url),
      eventMask: String(input.event_mask),
      headers: (input.headers as Record<string, string> | null) ?? {},
      // A new webhook is inactive until it is switched on.
      isActive: input.is_active === true,
      isGlobal: input.is_global === true,
      propertyId: input.is_global === true ? null : String(input.property_id),
      sendData: input.send_data === true,
      isSigned: input.is_signed === true,
    };
    state.webhooks.set(webhook.id, webhook);
    return reply.status(201).send({ data: webhookResource(webhook) });
  });

  app.put('/webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const webhook = state.webhooks.get(id);
    if (!webhook) return reply.status(404).send(notFound);
    const input = (req.body as { webhook?: Record<string, unknown> })?.webhook ?? {};
    const problems = webhookProblems(input, false);
    if (Object.keys(problems).length > 0) return reply.status(422).send(validationError(problems));
    if (typeof input.callback_url === 'string') webhook.callbackUrl = input.callback_url;
    if (typeof input.event_mask === 'string') webhook.eventMask = input.event_mask;
    if (input.headers !== undefined)
      webhook.headers = (input.headers as Record<string, string> | null) ?? {};
    if (typeof input.is_active === 'boolean') webhook.isActive = input.is_active;
    if (typeof input.is_global === 'boolean') webhook.isGlobal = input.is_global;
    if (typeof input.send_data === 'boolean') webhook.sendData = input.send_data;
    if (typeof input.is_signed === 'boolean') webhook.isSigned = input.is_signed;
    if (input.property_id !== undefined)
      webhook.propertyId = (input.property_id as string | null) ?? null;
    return { data: webhookResource(webhook) };
  });

  app.delete('/webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!state.webhooks.delete(id)) return reply.status(404).send(notFound);
    return { meta: { message: 'Success' } };
  });

  // ---------------------------------------------------------------------------
  // Embedded channel screen sign-in

  app.post('/auth/one_time_token', async (req, reply) => {
    const input =
      (req.body as { one_time_token?: { property_id?: string; username?: string } })
        ?.one_time_token ?? {};
    if (!input.property_id || !state.properties.has(input.property_id)) {
      return reply.status(422).send(validationError({ property_id: ['does not exist'] }));
    }
    const token = randomUUID();
    state.oneTimeTokens.set(token, {
      propertyId: input.property_id,
      username: input.username ?? 'user',
      expiresAt: Date.now() + 15 * 60_000,
    });
    return {
      data: { token },
      meta: { message: 'You are successfully received one-time token! Use it for exchange to JWT' },
    };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SimError)
      return reply.status(err.status).send({ errors: { code: 'error', title: err.message } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ errors: { code: 'error', title: (err as Error).message } });
  });
}

export { CHANNELS };
