import type { FastifyInstance } from 'fastify';
import { addDays, eachDate, isValidDate } from '@pms/domain/shared';
import { CHANNELS, SimError, type ChannelCode, type SimState } from './state';
import type { WebhookSender } from './webhooks';

interface ControlOptions {
  state: SimState;
  sender: WebhookSender;
}

function isChannel(code: unknown): code is ChannelCode {
  return typeof code === 'string' && code in CHANNELS;
}

/**
 * What a test or a person at the simulator's own screen can do that the real
 * service would not let an API client do: act as a guest on a channel, break
 * things on purpose, and look inside.
 */
export async function controlApi(
  app: FastifyInstance,
  { state, sender }: ControlOptions,
): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    const status =
      err instanceof SimError ? err.status : ((err as { statusCode?: number }).statusCode ?? 500);
    return reply.status(status).send({ error: (err as Error).message });
  });

  app.get('/state', async (req) => {
    const query = req.query as { propertyId?: string; from?: string; days?: string };
    const properties = [...state.properties.values()].sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    const property = properties.find((p) => p.id === query.propertyId) ?? properties[0];
    const from = isValidDate(query.from) ? query.from : property ? state.today(property.id) : null;
    const days = Math.min(60, Math.max(1, Number(query.days ?? 14) || 14));
    const dates = from ? eachDate(from, addDays(from, days)) : [];

    const detail = property
      ? {
          id: property.id,
          title: property.title,
          currency: property.currency,
          dates,
          roomTypes: [...state.roomTypes.values()]
            .filter((r) => r.propertyId === property.id)
            .map((r) => ({
              id: r.id,
              title: r.title,
              countOfRooms: r.countOfRooms,
              availability: dates.map((d) => state.availabilityOn(r.id, d)),
              ratePlans: [...state.ratePlans.values()]
                .filter((p) => p.roomTypeId === r.id)
                .map((p) => ({
                  id: p.id,
                  title: p.title,
                  days: dates.map((d) => {
                    const v = state.restrictionOn(p.id, d);
                    return {
                      rate: v.rate,
                      stopSell: v.stopSell,
                      minStay: Math.max(v.minStayArrival, v.minStayThrough),
                    };
                  }),
                })),
            })),
          channels: state.channelsOf(property.id).map((c) => ({
            id: c.id,
            code: c.code,
            title: CHANNELS[c.code].title,
            active: c.active,
            lastUpdatedAt: c.lastUpdatedAt,
            view: Object.fromEntries(
              [...state.roomTypes.values()]
                .filter((r) => r.propertyId === property.id)
                .map((r) => [r.id, dates.map((d) => c.view.get(r.id)?.get(d) ?? null)]),
            ),
          })),
          bookings: [...state.bookings.values()]
            .filter((b) => b.propertyId === property.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 40)
            .map((b) => ({
              id: b.id,
              channel: b.channel,
              channelTitle: CHANNELS[b.channel].title,
              code: b.otaReservationCode,
              status: b.status,
              guest: `${b.customer.name} ${b.customer.surname}`,
              rooms: b.rooms.map((r) => ({
                bookingRoomId: r.bookingRoomId,
                roomTypeId: r.roomTypeId,
                checkIn: r.checkIn,
                checkOut: r.checkOut,
                isCancelled: r.isCancelled,
              })),
              revisions: b.revisionIds.map((id) => {
                const r = state.revisions.get(id)!;
                return {
                  id: r.id,
                  status: r.status,
                  acknowledged: r.acknowledged,
                  insertedAt: r.insertedAt,
                };
              }),
            })),
        }
      : null;

    return {
      properties: properties.map((p) => ({ id: p.id, title: p.title })),
      property: detail,
      webhooks: [...state.webhooks.values()].map((w) => ({
        id: w.id,
        callbackUrl: w.callbackUrl,
        isActive: w.isActive,
        eventMask: w.eventMask,
      })),
      faults: {
        ...state.faults,
        outageSecondsLeft: Math.max(0, Math.ceil((state.faults.outageUntil - Date.now()) / 1000)),
      },
      settings: {
        distributionDelayMs: state.distributionDelayMs,
        ariLimitPerMinute: state.ariLimitPerMinute,
        nonAckedAfterMs: state.nonAckedAfterMs,
      },
      unacknowledged: state.feed(property?.id).length,
      requests: state.requestLog.slice(-60).reverse(),
      deliveries: state.deliveries.slice(-40).reverse(),
    };
  });

  /** Everything, unsummarised: for assertions in tests. */
  app.get('/dump', async () => ({
    requests: state.requestLog,
    deliveries: state.deliveries,
    tasks: state.tasks,
    revisions: [...state.revisions.values()].map((r) => ({
      id: r.id,
      bookingId: r.bookingId,
      status: r.status,
      acknowledged: r.acknowledged,
      insertedAt: r.insertedAt,
    })),
  }));

  app.post('/bookings', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!isChannel(body.channel)) throw new SimError(400, 'Unknown channel');
    const booking = state.createBooking({
      ...(body as unknown as Parameters<SimState['createBooking']>[0]),
      channel: body.channel,
    });
    return reply.status(201).send({
      id: booking.id,
      code: booking.otaReservationCode,
      revisionId: booking.revisionIds[0],
    });
  });

  app.post('/bookings/:id/modify', async (req) => {
    const { id } = req.params as { id: string };
    const booking = state.modifyBooking(
      id,
      (req.body ?? {}) as Parameters<SimState['modifyBooking']>[1],
    );
    return { id: booking.id, revisionId: booking.revisionIds[booking.revisionIds.length - 1] };
  });

  app.post('/bookings/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const booking = state.cancelBooking(
      id,
      (req.body ?? {}) as { insertedAt?: string; silent?: boolean },
    );
    return { id: booking.id, revisionId: booking.revisionIds[booking.revisionIds.length - 1] };
  });

  /** The guest of a booking writes to the property in the booking site's message box. */
  app.post('/bookings/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; silent?: boolean };
    if (!body.text?.trim()) throw new SimError(400, 'A message needs some text');
    const message = state.guestMessage(id, body.text, { silent: body.silent });
    return reply.status(201).send({ id: message.id, threadId: message.threadId });
  });

  /** A guest reviews a stay on a booking site. */
  app.post('/reviews', async (req, reply) => {
    const review = state.guestReview((req.body ?? {}) as Parameters<SimState['guestReview']>[0]);
    return reply.status(201).send({ id: review.id });
  });

  app.get('/reviews', async () => ({ reviews: [...state.reviews.values()] }));

  /** Every conversation, with what each side wrote, oldest first. */
  app.get('/threads', async () => ({ threads: [...state.threads.values()] }));

  /** Switch the paid messages add-on off or on for a property. */
  app.post('/messaging', async (req) => {
    const body = (req.body ?? {}) as { propertyId?: string; enabled?: boolean };
    if (!body.propertyId || !state.properties.has(body.propertyId)) {
      throw new SimError(404, 'Property not found');
    }
    if (body.enabled === false) state.messagingDisabled.add(body.propertyId);
    else state.messagingDisabled.delete(body.propertyId);
    return { propertyId: body.propertyId, enabled: body.enabled !== false };
  });

  /** Announce again every revision still waiting, as the real service does until it is acknowledged. */
  app.post('/redeliver', async () => {
    const waiting = state.feed();
    for (const revision of waiting) {
      state.onEvent('booking', revision.propertyId, {
        booking_id: revision.bookingId,
        property_id: revision.propertyId,
        revision_id: revision.id,
      });
    }
    return { announced: waiting.length };
  });

  app.post('/channels', async (req) => {
    const body = req.body as { propertyId?: string; code?: string; active?: boolean };
    if (!body.propertyId || !state.properties.has(body.propertyId))
      throw new SimError(404, 'Property not found');
    if (!isChannel(body.code)) throw new SimError(400, 'Unknown channel');
    const channel = state.connectChannel(body.propertyId, body.code);
    const active = body.active !== false;
    const changed = channel.active !== active;
    channel.active = active;
    if (active) {
      // A channel that has just been switched on is brought up to date from the inventory table.
      for (const roomType of state.roomTypes.values()) {
        if (roomType.propertyId !== body.propertyId) continue;
        state.distribute(roomType.id, [...(state.availability.get(roomType.id)?.keys() ?? [])]);
      }
    }
    if (changed) {
      state.onEvent(active ? 'activate_channel' : 'deactivate_channel', body.propertyId, {
        title: CHANNELS[body.code].title,
        channel_id: channel.id,
        ota_name: CHANNELS[body.code].otaName,
      });
    }
    return { id: channel.id, active: channel.active };
  });

  /** Change a value in the channel manager behind the PMS's back, as someone editing its own screen would. */
  app.post('/tamper', async (req) => {
    const body = req.body as {
      roomTypeId?: string;
      ratePlanId?: string;
      date?: string;
      availability?: number;
      rate?: number;
      stopSell?: boolean;
    };
    if (!isValidDate(body.date)) throw new SimError(400, 'A date is required');
    if (body.roomTypeId && typeof body.availability === 'number') {
      const days = state.availability.get(body.roomTypeId);
      if (!days) throw new SimError(404, 'Room type not found');
      days.set(body.date, body.availability);
      state.distribute(body.roomTypeId, [body.date]);
    }
    if (body.ratePlanId) {
      const days = state.restrictions.get(body.ratePlanId);
      if (!days) throw new SimError(404, 'Rate plan not found');
      days.set(body.date, {
        ...state.restrictionOn(body.ratePlanId, body.date),
        ...(typeof body.rate === 'number' ? { rate: body.rate } : {}),
        ...(typeof body.stopSell === 'boolean' ? { stopSell: body.stopSell } : {}),
      });
    }
    return { ok: true };
  });

  app.post('/events', async (req) => {
    const body = req.body as {
      event?: string;
      propertyId?: string;
      payload?: Record<string, unknown>;
    };
    if (!body.event || !body.propertyId)
      throw new SimError(400, 'event and propertyId are required');
    state.onEvent(body.event, body.propertyId, body.payload ?? {});
    return { ok: true };
  });

  app.post('/faults', async (req) => {
    const body = (req.body ?? {}) as Partial<SimState['faults']> & { outageSeconds?: number };
    if (typeof body.failNext === 'number') state.faults.failNext = body.failNext;
    if (typeof body.failStatus === 'number') state.faults.failStatus = body.failStatus;
    if (typeof body.latencyMs === 'number') state.faults.latencyMs = body.latencyMs;
    if (typeof body.dropWebhooks === 'boolean') state.faults.dropWebhooks = body.dropWebhooks;
    if (typeof body.duplicateWebhooks === 'boolean')
      state.faults.duplicateWebhooks = body.duplicateWebhooks;
    if (typeof body.outageSeconds === 'number')
      state.faults.outageUntil = Date.now() + body.outageSeconds * 1000;
    if (typeof body.outageUntil === 'number') state.faults.outageUntil = body.outageUntil;
    return state.faults;
  });

  app.post('/settings', async (req) => {
    const body = (req.body ?? {}) as {
      distributionDelayMs?: number;
      ariLimitPerMinute?: number;
      ariWindowMs?: number;
      nonAckedAfterMs?: number;
    };
    if (typeof body.distributionDelayMs === 'number')
      state.distributionDelayMs = Math.max(0, body.distributionDelayMs);
    if (typeof body.ariLimitPerMinute === 'number') {
      state.ariLimitPerMinute = Math.max(1, body.ariLimitPerMinute);
      state.clearAriSlots();
    }
    if (typeof body.ariWindowMs === 'number') {
      state.ariWindowMs = Math.max(1_000, body.ariWindowMs);
      state.clearAriSlots();
    }
    if (typeof body.nonAckedAfterMs === 'number')
      state.nonAckedAfterMs = Math.max(0, body.nonAckedAfterMs);
    return { ok: true };
  });

  app.post('/non-acked-check', async () => ({ warned: state.warnNonAcked() }));

  app.post('/idle', async () => {
    await sender.idle();
    return { ok: true };
  });

  app.post('/reset', async () => {
    state.reset();
    return { ok: true };
  });
}
