import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AUTOMATION_TRIGGERS,
  automationRules,
  CONVERSATION_CHANNELS,
  CONVERSATION_STATUSES,
  conversations,
  messages,
  messageTemplates,
  paymentOrders,
  PROMO_KINDS,
  RESERVATION_SOURCES,
  reservations,
} from '@pms/db';
import {
  automationLog,
  cancelPaymentOrder,
  canAcrossOrganisation,
  conversationTemplates,
  createPaymentLink,
  createPromo,
  deleteAutomationRule,
  deletePromo,
  deleteTemplate,
  displayMoney,
  forbidden,
  getConversation,
  getStaffCheckin,
  guestBookingUrl,
  listAssignees,
  listAutomationRules,
  listConversations,
  listPaymentOrders,
  listPromos,
  listTemplates,
  markConversationRead,
  notFound,
  openConversation,
  propertyScope,
  readAttachment,
  readCheckinDocument,
  reservationTemplates,
  retryMessage,
  saveAutomationRule,
  saveTemplate,
  sendMessage,
  sendTemplate,
  sendTemplateInConversation,
  syncPaymentOrder,
  TEMPLATE_VARIABLES,
  unreadConversations,
  updateConversation,
  updatePromo,
  verifyOnlineCheckin,
  writeAudit,
  type Actor,
  type Permission,
} from '@pms/domain';
import { dateString, idParams, money, uuid } from '../lib/schemas';
import { authorizeReservation } from '../lib/scope';
import { authorize } from '../plugins/auth';

const channel = z.enum(CONVERSATION_CHANNELS);

/**
 * Settings that shape what every guest is told (templates, automatic
 * messages) or what every guest pays (promotional codes): for one property
 * they need the permission there, for the whole organisation they need it on
 * all properties.
 */
function authorizeScoped(
  req: FastifyRequest,
  permission: Permission,
  propertyId: string | null | undefined,
): Actor {
  const actor = authorize(req, permission, propertyId ?? undefined);
  if (!propertyId && !canAcrossOrganisation(actor.grants, permission)) throw forbidden();
  return actor;
}

export async function engagementRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------------------
  // Inbox

  /** A conversation is open to whoever may read the inbox of its property; one not yet tied to a property, to all of them. */
  const authorizeConversation = async (
    req: FastifyRequest,
    conversationId: string,
    permission: 'inbox.read' | 'inbox.write',
  ): Promise<Actor> => {
    const session = authorize(req, permission);
    const [row] = await app.db
      .select({ propertyId: conversations.propertyId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, session.orgId)));
    if (!row) throw notFound('Conversation', conversationId);
    return row.propertyId ? authorize(req, permission, row.propertyId) : session;
  };

  r.get(
    '/inbox/conversations',
    {
      schema: {
        tags: ['inbox'],
        querystring: z.object({
          status: z.enum([...CONVERSATION_STATUSES, 'active']).optional(),
          channel: channel.optional(),
          assignedTo: z.union([uuid, z.literal('none'), z.literal('me')]).optional(),
          reservationId: uuid.optional(),
          guestId: uuid.optional(),
          search: z.string().max(120).optional(),
          cursor: z
            .string()
            .max(80)
            .optional()
            .describe('`nextCursor` of the page before, for the conversations after it'),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'inbox.read');
      const { assignedTo, ...filter } = req.query;
      return listConversations(app.db, actor.orgId, {
        ...filter,
        propertyIds: propertyScope(actor.grants, 'inbox.read'),
        assignedTo: assignedTo === 'me' ? actor.userId : assignedTo,
      });
    },
  );

  r.get(
    '/inbox/assignees',
    {
      schema: {
        tags: ['inbox'],
        summary: 'The people a conversation can be given to',
        querystring: z.object({ propertyId: uuid.optional() }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'inbox.read', req.query.propertyId);
      return { staff: await listAssignees(app.db, actor.orgId, req.query.propertyId ?? null) };
    },
  );

  r.get('/inbox/unread', { schema: { tags: ['inbox'] } }, async (req) => {
    const actor = authorize(req, 'inbox.read');
    return {
      unread: await unreadConversations(
        app.db,
        actor.orgId,
        propertyScope(actor.grants, 'inbox.read'),
      ),
    };
  });

  r.get(
    '/inbox/conversations/:id',
    { schema: { tags: ['inbox'], params: idParams } },
    async (req) => {
      const actor = await authorizeConversation(req, req.params.id, 'inbox.read');
      return getConversation(app.db, actor.orgId, req.params.id);
    },
  );

  r.post(
    '/inbox/conversations',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Find or start the conversation with a guest on a channel',
        body: z.object({
          channel,
          reservationId: uuid.nullable().optional(),
          guestId: uuid.nullable().optional(),
          address: z.string().trim().max(254).nullable().optional(),
          contactName: z.string().trim().max(200).nullable().optional(),
          subject: z.string().max(300).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = req.body.reservationId
        ? (await authorizeReservation(app.db, req, req.body.reservationId, 'inbox.write')).actor
        : authorize(req, 'inbox.write');
      return reply.status(201).send(await openConversation(app.db, actor.orgId, req.body));
    },
  );

  r.post(
    '/inbox/conversations/:id/messages',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Reply to the guest, or leave a note for colleagues',
        params: idParams,
        body: z.object({
          body: z.string().trim().min(1).max(10_000),
          subject: z.string().max(300).nullable().optional(),
          kind: z.enum(['text', 'note']).optional(),
          aiDrafted: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeConversation(req, req.params.id, 'inbox.write');
      return reply.status(201).send(await sendMessage(app.db, actor, req.params.id, req.body));
    },
  );

  r.patch(
    '/inbox/conversations/:id',
    {
      schema: {
        tags: ['inbox'],
        params: idParams,
        body: z.object({
          status: z.enum(CONVERSATION_STATUSES).optional(),
          assignedTo: uuid.nullable().optional(),
          reservationId: uuid.nullable().optional(),
          propertyId: uuid.nullable().optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeConversation(req, req.params.id, 'inbox.write');
      // Tying a conversation to a reservation or property must not move it somewhere the user cannot see.
      if (req.body.reservationId) {
        await authorizeReservation(app.db, req, req.body.reservationId, 'inbox.write');
      }
      if (req.body.propertyId) authorize(req, 'inbox.write', req.body.propertyId);
      return updateConversation(app.db, actor, req.params.id, req.body);
    },
  );

  r.post(
    '/inbox/conversations/:id/read',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Mark a conversation as read, for everyone',
        params: idParams,
      },
    },
    async (req, reply) => {
      // Read is shared: looking without being able to answer must not clear it for those who can.
      const actor = await authorizeConversation(req, req.params.id, 'inbox.write');
      await markConversationRead(app.db, actor.orgId, req.params.id);
      return reply.status(204).send();
    },
  );

  r.post(
    '/inbox/messages/:id/retry',
    {
      schema: { tags: ['inbox'], summary: 'Send a failed message again', params: idParams },
    },
    async (req) => {
      const session = authorize(req, 'inbox.write');
      const [row] = await app.db
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .where(and(eq(messages.id, req.params.id), eq(messages.orgId, session.orgId)));
      if (!row) throw notFound('Message', req.params.id);
      const actor = await authorizeConversation(req, row.conversationId, 'inbox.write');
      return retryMessage(app.db, actor, req.params.id);
    },
  );

  r.get(
    '/inbox/messages/:id/attachments/:fileId',
    {
      schema: {
        tags: ['inbox'],
        summary: 'A photo or PDF a guest sent with a message',
        params: idParams.extend({ fileId: uuid }),
      },
    },
    async (req, reply) => {
      const session = authorize(req, 'inbox.read');
      const [row] = await app.db
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .where(and(eq(messages.id, req.params.id), eq(messages.orgId, session.orgId)));
      if (!row) throw notFound('Message', req.params.id);
      const actor = await authorizeConversation(req, row.conversationId, 'inbox.read');
      const { file, data } = await readAttachment(
        app.db,
        app.files,
        actor.orgId,
        req.params.id,
        req.params.fileId,
      );
      return (
        reply
          .header('content-type', file.contentType)
          .header('content-disposition', `inline; filename="${file.fileName.replace(/"/g, '')}"`)
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          // A file from outside is shown as what it is and nothing more: no scripts, no frames.
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(data)
      );
    },
  );

  r.get(
    '/inbox/conversations/:id/templates',
    {
      schema: {
        tags: ['inbox'],
        summary: 'The templates that can be used in a conversation, filled in for its guest',
        params: idParams,
      },
    },
    async (req) => {
      const actor = await authorizeConversation(req, req.params.id, 'inbox.read');
      return {
        templates: await conversationTemplates(app.db, actor.orgId, req.params.id),
        variables: TEMPLATE_VARIABLES,
      };
    },
  );

  r.post(
    '/inbox/conversations/:id/send-template',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Send a template in this conversation, to the address it is with',
        params: idParams,
        body: z.object({ templateKey: z.string().min(1).max(50) }),
      },
    },
    async (req) => {
      const actor = await authorizeConversation(req, req.params.id, 'inbox.write');
      return sendTemplateInConversation(app.db, actor, req.params.id, req.body);
    },
  );

  r.get(
    '/reservations/:id/templates',
    {
      schema: {
        tags: ['inbox'],
        summary:
          'The templates that can be sent about a reservation, filled in for its guest, with the ways each could go',
        params: idParams,
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'inbox.read');
      return reservationTemplates(app.db, actor.orgId, req.params.id);
    },
  );

  r.post(
    '/reservations/:id/send-template',
    {
      schema: {
        tags: ['inbox'],
        summary:
          'Send a template to the guest of a reservation, on the first channel that reaches them',
        params: idParams,
        body: z.object({
          templateKey: z.string().min(1).max(50),
          channels: z.array(channel).min(1).max(3).optional(),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'inbox.write');
      return sendTemplate(app.db, actor, req.params.id, {
        templateKey: req.body.templateKey,
        channels: req.body.channels ?? ['whatsapp', 'email', 'ota'],
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Templates and automatic messages

  const templateBody = z.object({
    key: z.string().trim().min(2).max(50),
    name: z.string().trim().min(1).max(120),
    propertyId: uuid.nullable().optional(),
    language: z.string().trim().min(2).max(5).optional(),
    subject: z.string().max(300).nullable().optional(),
    body: z.string().min(1).max(10_000),
    whatsappTemplate: z.string().trim().max(120).nullable().optional(),
    whatsappParams: z.array(z.string().max(40)).max(20).optional(),
    active: z.boolean().optional(),
  });

  r.get('/messaging/templates', { schema: { tags: ['messaging'] } }, async (req) => {
    const actor = authorize(req, 'inbox.read');
    return {
      templates: await listTemplates(app.db, actor.orgId),
      variables: TEMPLATE_VARIABLES,
    };
  });

  r.post(
    '/messaging/templates',
    { schema: { tags: ['messaging'], body: templateBody } },
    async (req, reply) => {
      const actor = authorizeScoped(req, 'property.manage', req.body.propertyId);
      return reply.status(201).send(await saveTemplate(app.db, actor, req.body));
    },
  );

  /** The property a template belongs to (null: the whole organisation). */
  const templateScope = async (id: string, orgId: string): Promise<string | null> => {
    const [row] = await app.db
      .select({ propertyId: messageTemplates.propertyId })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, orgId)));
    if (!row) throw notFound('Template', id);
    return row.propertyId;
  };
  const automationScope = async (id: string, orgId: string): Promise<string | null> => {
    const [row] = await app.db
      .select({ propertyId: automationRules.propertyId })
      .from(automationRules)
      .where(and(eq(automationRules.id, id), eq(automationRules.orgId, orgId)));
    if (!row) throw notFound('Automatic message', id);
    return row.propertyId;
  };

  r.put(
    '/messaging/templates/:id',
    { schema: { tags: ['messaging'], params: idParams, body: templateBody } },
    async (req) => {
      const session = authorize(req);
      // Both where it is and where it is going must be the user's to manage.
      authorizeScoped(req, 'property.manage', await templateScope(req.params.id, session.orgId));
      const actor = authorizeScoped(req, 'property.manage', req.body.propertyId);
      return saveTemplate(app.db, actor, req.body, req.params.id);
    },
  );

  r.delete(
    '/messaging/templates/:id',
    { schema: { tags: ['messaging'], params: idParams } },
    async (req, reply) => {
      const session = authorize(req);
      const actor = authorizeScoped(
        req,
        'property.manage',
        await templateScope(req.params.id, session.orgId),
      );
      await deleteTemplate(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  const automationBody = z.object({
    name: z.string().trim().min(1).max(120),
    propertyId: uuid.nullable().optional(),
    trigger: z.enum(AUTOMATION_TRIGGERS),
    offsetDays: z.number().int().min(0).max(365).optional(),
    sendHour: z.number().int().min(0).max(23).optional(),
    templateKey: z.string().min(1).max(50),
    channels: z.array(channel).min(1).max(3),
    sources: z.array(z.enum(RESERVATION_SOURCES)).max(20).nullable().optional(),
    active: z.boolean().optional(),
  });

  r.get('/messaging/automations', { schema: { tags: ['messaging'] } }, async (req) => {
    const actor = authorize(req, 'inbox.read');
    return {
      rules: await listAutomationRules(app.db, actor.orgId),
      log: await automationLog(app.db, actor.orgId, 100),
    };
  });

  r.post(
    '/messaging/automations',
    { schema: { tags: ['messaging'], body: automationBody } },
    async (req, reply) => {
      const actor = authorizeScoped(req, 'property.manage', req.body.propertyId);
      return reply.status(201).send(await saveAutomationRule(app.db, actor, req.body));
    },
  );

  r.put(
    '/messaging/automations/:id',
    { schema: { tags: ['messaging'], params: idParams, body: automationBody } },
    async (req) => {
      const session = authorize(req);
      authorizeScoped(req, 'property.manage', await automationScope(req.params.id, session.orgId));
      const actor = authorizeScoped(req, 'property.manage', req.body.propertyId);
      return saveAutomationRule(app.db, actor, req.body, req.params.id);
    },
  );

  r.delete(
    '/messaging/automations/:id',
    { schema: { tags: ['messaging'], params: idParams } },
    async (req, reply) => {
      const session = authorize(req);
      const actor = authorizeScoped(
        req,
        'property.manage',
        await automationScope(req.params.id, session.orgId),
      );
      await deleteAutomationRule(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // Promotional codes

  const promoFields = {
    description: z.string().max(300).nullable().optional(),
    propertyId: uuid.nullable().optional(),
    kind: z.enum(PROMO_KINDS),
    value: z.number().int().min(1).max(1_000_000_000),
    currency: z.string().length(3).nullable().optional(),
    bookFrom: z.iso.datetime({ offset: true }).nullable().optional(),
    bookTo: z.iso.datetime({ offset: true }).nullable().optional(),
    stayFrom: dateString.nullable().optional(),
    stayTo: dateString.nullable().optional(),
    minNights: z.number().int().min(1).max(365).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
    ratePlanIds: z.array(uuid).max(200).nullable().optional(),
    active: z.boolean().optional(),
  };
  const dates = <T extends { bookFrom?: string | null; bookTo?: string | null }>(body: T) => ({
    ...body,
    bookFrom: body.bookFrom ? new Date(body.bookFrom) : body.bookFrom === null ? null : undefined,
    bookTo: body.bookTo ? new Date(body.bookTo) : body.bookTo === null ? null : undefined,
  });

  r.get('/promos', { schema: { tags: ['promotional codes'] } }, async (req) => {
    const actor = authorize(req, 'rates.read');
    const scope = propertyScope(actor.grants, 'rates.read');
    const all = await listPromos(app.db, actor.orgId);
    return {
      promos: all.filter(
        (p) => scope === 'all' || p.propertyId === null || scope.includes(p.propertyId),
      ),
    };
  });

  r.post(
    '/promos',
    {
      schema: {
        tags: ['promotional codes'],
        body: z.object({ code: z.string().trim().min(2).max(30), ...promoFields }),
      },
    },
    async (req, reply) => {
      const actor = authorizeScoped(req, 'rates.write', req.body.propertyId);
      return reply.status(201).send(await createPromo(app.db, actor, dates(req.body)));
    },
  );

  r.patch(
    '/promos/:id',
    {
      schema: {
        tags: ['promotional codes'],
        params: idParams,
        body: z.object(promoFields).partial(),
      },
    },
    async (req) => {
      const session = authorize(req, 'rates.write');
      const existing = (await listPromos(app.db, session.orgId)).find(
        (p) => p.id === req.params.id,
      );
      if (!existing) throw notFound('Promotional code', req.params.id);
      authorizeScoped(req, 'rates.write', existing.propertyId);
      const actor =
        req.body.propertyId === undefined
          ? session
          : authorizeScoped(req, 'rates.write', req.body.propertyId);
      return updatePromo(app.db, actor, req.params.id, dates(req.body));
    },
  );

  r.delete(
    '/promos/:id',
    {
      schema: {
        tags: ['promotional codes'],
        summary: 'Remove a code that no booking was made with',
        params: idParams,
      },
    },
    async (req, reply) => {
      const session = authorize(req, 'rates.write');
      const existing = (await listPromos(app.db, session.orgId)).find(
        (p) => p.id === req.params.id,
      );
      if (!existing) throw notFound('Promotional code', req.params.id);
      const actor = authorizeScoped(req, 'rates.write', existing.propertyId);
      await deletePromo(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // Online payments on a reservation

  r.get(
    '/reservations/:id/payment-orders',
    { schema: { tags: ['payments'], params: idParams } },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'folio.read');
      return { orders: await listPaymentOrders(app.db, actor.orgId, req.params.id) };
    },
  );

  r.post(
    '/reservations/:id/payment-links',
    {
      schema: {
        tags: ['payments'],
        summary: 'Create a link the guest can pay an amount through, and optionally send it',
        params: idParams,
        body: z.object({
          amount: money.refine((v) => v > 0, 'The amount must be above zero'),
          description: z.string().max(200).nullable().optional(),
          validHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 14)
            .optional(),
          send: z.boolean().optional().describe('Also send the link to the guest'),
        }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'folio.write');
      const { send, ...input } = req.body;
      const link = await createPaymentLink(app.db, app.gateway(), actor, req.params.id, input);
      let sent: { channel: string | null; problems: string[] } | null = null;
      if (send) {
        const result = await sendTemplate(app.db, actor, req.params.id, {
          templateKey: 'payment_request',
          channels: ['whatsapp', 'email'],
          variables: { amount: displayMoney(link.amount, link.currency), pay_link: link.payUrl },
        });
        sent = { channel: result.sent?.channel ?? null, problems: result.problems };
      }
      return reply.status(201).send({ ...link, sent });
    },
  );

  const orderProperty = async (req: FastifyRequest, orderId: string): Promise<Actor> => {
    const session = authorize(req);
    const [order] = await app.db
      .select({ propertyId: paymentOrders.propertyId })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.orgId, session.orgId)));
    if (!order) throw notFound('Payment link', orderId);
    return authorize(req, 'folio.write', order.propertyId);
  };

  r.post(
    '/payment-orders/:id/cancel',
    { schema: { tags: ['payments'], params: idParams } },
    async (req) => {
      const actor = await orderProperty(req, req.params.id);
      return cancelPaymentOrder(app.db, app.gateway(), actor, req.params.id);
    },
  );

  r.post(
    '/payment-orders/:id/sync',
    {
      schema: {
        tags: ['payments'],
        summary: 'Ask the payment gateway now whether this was paid',
        params: idParams,
      },
    },
    async (req) => {
      await orderProperty(req, req.params.id);
      return (await syncPaymentOrder(app.db, app.gateway(), req.params.id)).order;
    },
  );

  // ---------------------------------------------------------------------------
  // The guest's link and online check-in, as staff see them

  r.get(
    '/reservations/:id/guest-link',
    {
      schema: {
        tags: ['reservations'],
        summary: 'The address where the guest sees, pays for and checks in to this booking',
        params: idParams,
      },
    },
    async (req) => {
      await authorizeReservation(app.db, req, req.params.id, 'reservations.read');
      const [reservation] = await app.db
        .select()
        .from(reservations)
        .where(eq(reservations.id, req.params.id));
      return {
        url: guestBookingUrl(reservation!),
        checkInUrl: guestBookingUrl(reservation!, '/check-in'),
      };
    },
  );

  r.post(
    '/reservations/:id/guest-link/revoke',
    {
      schema: {
        tags: ['reservations'],
        summary: 'Make every link sent for this booking stop working, and issue a new one',
        params: idParams,
      },
    },
    async (req) => {
      const { actor, propertyId } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      const [reservation] = await app.db
        .update(reservations)
        .set({ guestTokenVersion: sql`${reservations.guestTokenVersion} + 1` })
        .where(eq(reservations.id, req.params.id))
        .returning();
      await writeAudit(app.db, actor, {
        action: 'reservation.guest_link_revoked',
        entityType: 'reservation',
        entityId: req.params.id,
        propertyId,
        summary: `Replaced the guest link of reservation ${reservation!.code}`,
      });
      return { url: guestBookingUrl(reservation!) };
    },
  );

  r.get(
    '/reservations/:id/online-checkin',
    {
      schema: {
        tags: ['front desk'],
        params: idParams,
        querystring: z.object({ reveal: z.enum(['true', 'false']).optional() }),
      },
    },
    async (req) => {
      const reveal = req.query.reveal === 'true';
      const { actor } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        // Seeing identity numbers in full takes the permission for identity data.
        reveal ? 'guests.pii' : 'reservations.read',
      );
      return getStaffCheckin(app.db, actor, req.params.id, { reveal });
    },
  );

  r.post(
    '/reservations/:id/online-checkin/verify',
    {
      schema: {
        tags: ['front desk'],
        summary: 'The details were compared with the documents shown on arrival',
        params: idParams,
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'frontdesk.operate');
      await verifyOnlineCheckin(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  r.get(
    '/reservations/:id/online-checkin/documents/:fileId',
    {
      schema: {
        tags: ['front desk'],
        summary: 'An identity document the guest uploaded (recorded in the audit log)',
        params: idParams.extend({ fileId: uuid }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'guests.pii');
      const file = await readCheckinDocument(
        app.db,
        app.files,
        actor,
        req.params.id,
        req.params.fileId,
      );
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `inline; filename="${file.fileName.replace(/"/g, '')}"`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.data);
    },
  );
}
