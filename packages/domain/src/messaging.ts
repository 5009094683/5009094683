import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  automationRules,
  automationSends,
  channelConnections,
  conversations,
  guests,
  messageTemplates,
  organizations,
  properties,
  reservations,
  type AutomationTrigger,
  type ConversationChannel,
  type DbOrTx,
  type ReservationSource,
} from '@pms/db';
import { diff, writeAudit } from './audit';
import { stayMoney } from './booking-engine';
import { systemActor, type Actor } from './context';
import { diffDays, type DateString } from './dates';
import { conflict, notFound, validationError } from './errors';
import { guestBookingUrl } from './guest-links';
import {
  openConversation,
  sendMessage,
  threadKey,
  transportFor,
  whatsappWindowOpen,
  type ConversationRow,
  type MessageRow,
} from './inbox';
import { displayMoney } from './money';
import { transact } from './sqlx';
import { TEMPLATE_VARIABLES, renderTemplate, unfilledVariables } from './template-text';

export {
  SAMPLE_TEMPLATE_VALUES,
  TEMPLATE_VARIABLES,
  renderTemplate,
  unfilledVariables,
} from './template-text';

export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type AutomationRuleRow = typeof automationRules.$inferSelect;
type ReservationRow = typeof reservations.$inferSelect;
type GuestRow = typeof guests.$inferSelect;

/**
 * Reasons a reservation is cancelled without the guest ever having had a booking: no message is
 * due for those, and reports do not count them as cancellations.
 */
export const SILENT_CANCELLATIONS = [
  'Hold expired before the booking was completed',
  'The payment page could not be opened',
];

// ---------------------------------------------------------------------------
// Templates

function longDate(date: DateString): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

type PropertyRow = typeof properties.$inferSelect;

function propertyVariables(p: PropertyRow): Record<string, string> {
  return {
    property_name: p.name,
    property_address: [p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode]
      .filter(Boolean)
      .join(', '),
    property_phone: p.phone ?? '',
    property_email: p.email ?? '',
    check_in_time: p.checkInTime,
    check_out_time: p.checkOutTime,
    arrival_instructions: p.settings.arrivalInstructions ?? '',
  };
}

/** Everything a template can mention about a reservation. */
export async function templateVariables(
  db: DbOrTx,
  reservation: ReservationRow,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, reservation.propertyId));
  const { rows } = await db.execute<{ name: string; count: number }>(sql`
    SELECT rt.name, count(*)::int AS count
    FROM reservation_rooms rr JOIN room_types rt ON rt.id = rr.room_type_id
    WHERE rr.reservation_id = ${reservation.id} AND rr.status NOT IN ('cancelled', 'no_show')
    GROUP BY rt.name ORDER BY rt.name
  `);
  const money = await stayMoney(db, reservation);
  return {
    ...propertyVariables(property!),
    guest_name: reservation.guestName,
    guest_first_name: reservation.guestName.split(/\s+/)[0] ?? reservation.guestName,
    booking_code: reservation.code,
    check_in: longDate(reservation.checkIn),
    check_out: longDate(reservation.checkOut),
    nights: plural(diffDays(reservation.checkIn, reservation.checkOut), 'night', 'nights'),
    rooms: rows.map((r) => `${r.count} x ${r.name}`).join(', '),
    guests:
      plural(reservation.adults, 'adult', 'adults') +
      (reservation.children > 0 ? `, ${plural(reservation.children, 'child', 'children')}` : ''),
    total: displayMoney(money.total, reservation.currency),
    paid: displayMoney(money.paid, reservation.currency),
    balance: displayMoney(Math.max(0, money.balance), reservation.currency),
    booking_link: guestBookingUrl(reservation),
    checkin_link: guestBookingUrl(reservation, '/check-in'),
    ...extra,
  };
}

interface DefaultTemplate {
  key: string;
  name: string;
  subject: string;
  body: string;
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    key: 'booking_confirmation',
    name: 'Booking confirmation',
    subject: 'Your booking at {{property_name}} is confirmed ({{booking_code}})',
    body: `Dear {{guest_name}},

Thank you for booking with {{property_name}}. Your reservation is confirmed.

Booking reference: {{booking_code}}
Arrival: {{check_in}}, from {{check_in_time}}
Departure: {{check_out}}, by {{check_out_time}}
Stay: {{nights}}, {{rooms}}, {{guests}}
Total with tax: {{total}}
Paid: {{paid}}
To pay: {{balance}}

You can see your booking, pay or cancel here:
{{booking_link}}

{{property_name}}
{{property_address}}
{{property_phone}}`,
  },
  {
    key: 'pre_arrival',
    name: 'Before arrival',
    subject: 'Your stay at {{property_name}} begins on {{check_in}}',
    body: `Dear {{guest_first_name}},

We look forward to welcoming you on {{check_in}}. Check-in is from {{check_in_time}}.

To save time at the desk, check in online before you arrive:
{{checkin_link}}

{{arrival_instructions}}

If you need anything before you arrive, reply to this message.

{{property_name}}
{{property_phone}}`,
  },
  {
    key: 'check_in_day',
    name: 'Day of arrival',
    subject: 'We are expecting you today at {{property_name}}',
    body: `Dear {{guest_first_name}},

We are expecting you today. Check-in is from {{check_in_time}}.

{{arrival_instructions}}

Booking reference: {{booking_code}}
{{property_address}}
{{property_phone}}`,
  },
  {
    key: 'post_stay',
    name: 'After the stay',
    subject: 'Thank you for staying at {{property_name}}',
    body: `Dear {{guest_first_name}},

Thank you for staying with us. We hope you had a good time.

If anything fell short, reply to this message and tell us: it reaches the manager. We would be glad to welcome you again.

{{property_name}}`,
  },
  {
    key: 'booking_cancelled',
    name: 'Booking cancelled',
    subject: 'Your booking at {{property_name}} has been cancelled ({{booking_code}})',
    body: `Dear {{guest_name}},

Your booking {{booking_code}} at {{property_name}} for {{check_in}} to {{check_out}} has been cancelled.

Details, including any refund, are here:
{{booking_link}}

{{property_name}}
{{property_phone}}`,
  },
  {
    key: 'payment_request',
    name: 'Payment request',
    subject: 'Payment for your booking at {{property_name}} ({{booking_code}})',
    body: `Dear {{guest_name}},

Please pay {{amount}} for your booking {{booking_code}} at {{property_name}} using this secure link:
{{pay_link}}

{{property_name}}
{{property_phone}}`,
  },
];

interface DefaultRule {
  name: string;
  trigger: AutomationTrigger;
  offsetDays: number;
  sendHour: number;
  templateKey: string;
  sources: ReservationSource[] | null;
  active: boolean;
}

const DIRECT_SOURCES: ReservationSource[] = ['website', 'direct', 'phone'];

/**
 * Confirmations and cancellations of the property's own bookings are on from
 * the start: a website guest expects them. The rest wait for someone to read
 * the wording and switch them on.
 */
const DEFAULT_RULES: DefaultRule[] = [
  {
    name: 'Confirm a booking',
    trigger: 'booking_confirmed',
    offsetDays: 0,
    sendHour: 0,
    templateKey: 'booking_confirmation',
    sources: DIRECT_SOURCES,
    active: true,
  },
  {
    name: 'Confirm a cancellation',
    trigger: 'booking_cancelled',
    offsetDays: 0,
    sendHour: 0,
    templateKey: 'booking_cancelled',
    sources: DIRECT_SOURCES,
    active: true,
  },
  {
    name: 'Two days before arrival',
    trigger: 'pre_arrival',
    offsetDays: 2,
    sendHour: 10,
    templateKey: 'pre_arrival',
    sources: null,
    active: false,
  },
  {
    name: 'On the day of arrival',
    trigger: 'check_in_day',
    offsetDays: 0,
    sendHour: 8,
    templateKey: 'check_in_day',
    sources: null,
    active: false,
  },
  {
    name: 'The day after departure',
    trigger: 'post_stay',
    offsetDays: 1,
    sendHour: 11,
    templateKey: 'post_stay',
    sources: null,
    active: false,
  },
];

/** Gives an organisation that has neither templates nor rules the standard set. Safe to call at any time. */
export async function ensureMessagingDefaults(db: DbOrTx, orgId: string): Promise<boolean> {
  return transact(db, async (tx) => {
    // Serialises two callers for one organisation, so the set is not inserted twice.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pms-messaging:${orgId}`}, 0))`,
    );
    const [{ count } = { count: 0 }] = await tx
      .select({
        count: sql<number>`(SELECT count(*) FROM message_templates WHERE org_id = ${orgId})::int
          + (SELECT count(*) FROM automation_rules WHERE org_id = ${orgId})::int`,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (count > 0) return false;
    await tx.insert(messageTemplates).values(DEFAULT_TEMPLATES.map((t) => ({ orgId, ...t })));
    await tx.insert(automationRules).values(
      DEFAULT_RULES.map((r) => ({
        orgId,
        ...r,
        channels: ['whatsapp', 'email', 'ota'] satisfies ConversationChannel[],
      })),
    );
    return true;
  });
}

export async function listTemplates(db: DbOrTx, orgId: string): Promise<MessageTemplateRow[]> {
  await ensureMessagingDefaults(db, orgId);
  return db
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.orgId, orgId))
    .orderBy(asc(messageTemplates.name), asc(messageTemplates.language));
}

export interface TemplateInput {
  key: string;
  name: string;
  propertyId?: string | null;
  language?: string;
  subject?: string | null;
  body: string;
  whatsappTemplate?: string | null;
  whatsappParams?: string[];
  active?: boolean;
}

function validateTemplate(input: {
  body: string;
  subject?: string | null;
  whatsappParams?: string[];
}): void {
  if (!input.body.trim()) throw validationError('A template needs some text');
  const used = new Set<string>();
  for (const text of [input.body, input.subject ?? '']) {
    for (const match of text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi))
      used.add(match[1]!.toLowerCase());
    // What is left of a placeholder that was mistyped would reach the guest as typed.
    if (/\{\{|\}\}/.test(text.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, ''))) {
      throw validationError(
        'There is a stray {{ or }} in the text. A placeholder is a name between two pairs of braces, like {{guest_name}}.',
      );
    }
  }
  const unknown = [...used, ...(input.whatsappParams ?? [])].filter(
    (name) => !(name in TEMPLATE_VARIABLES),
  );
  if (unknown.length > 0) {
    throw validationError(
      `Unknown placeholder: ${[...new Set(unknown)].map((n) => `{{${n}}}`).join(', ')}`,
      { unknown },
    );
  }
}

export async function saveTemplate(
  db: DbOrTx,
  actor: Actor,
  input: TemplateInput,
  templateId?: string,
): Promise<MessageTemplateRow> {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(key)) {
    throw validationError('A template key is lower-case letters, digits and underscores');
  }
  if (!input.name.trim()) throw validationError('A template needs a name');
  validateTemplate(input);
  const language = (input.language ?? 'en').trim().toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) {
    throw validationError('The language is a two-letter code such as en or hi');
  }
  return transact(db, async (tx) => {
    if (input.propertyId) {
      const [property] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.id, input.propertyId), eq(properties.orgId, actor.orgId)));
      if (!property) throw notFound('Property', input.propertyId);
    }
    const values = {
      orgId: actor.orgId,
      propertyId: input.propertyId ?? null,
      key,
      name: input.name.trim().slice(0, 120),
      language,
      subject: input.subject?.trim().slice(0, 300) || null,
      body: input.body.trim().slice(0, 10_000),
      whatsappTemplate: input.whatsappTemplate?.trim() || null,
      whatsappParams: input.whatsappParams ?? [],
      active: input.active ?? true,
    };
    const [clash] = await tx
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.orgId, actor.orgId),
          eq(messageTemplates.key, key),
          eq(messageTemplates.language, language),
          values.propertyId
            ? eq(messageTemplates.propertyId, values.propertyId)
            : sql`${messageTemplates.propertyId} IS NULL`,
          templateId ? sql`${messageTemplates.id} <> ${templateId}` : undefined,
        ),
      );
    if (clash) {
      throw conflict('There is already a template with this key and language for that property');
    }
    if (templateId) {
      const [before] = await tx
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.orgId, actor.orgId)));
      if (!before) throw notFound('Template', templateId);
      const [after] = await tx
        .update(messageTemplates)
        .set(values)
        .where(eq(messageTemplates.id, templateId))
        .returning();
      await writeAudit(tx, actor, {
        action: 'template.updated',
        entityType: 'message_template',
        entityId: templateId,
        propertyId: after!.propertyId,
        summary: `Changed the message template "${after!.name}"`,
        changes: diff(before, after!),
      });
      return after!;
    }
    const [created] = await tx.insert(messageTemplates).values(values).returning();
    await writeAudit(tx, actor, {
      action: 'template.created',
      entityType: 'message_template',
      entityId: created!.id,
      propertyId: created!.propertyId,
      summary: `Added the message template "${created!.name}"`,
    });
    return created!;
  });
}

export async function deleteTemplate(db: DbOrTx, actor: Actor, templateId: string): Promise<void> {
  await transact(db, async (tx) => {
    const [row] = await tx
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.orgId, actor.orgId)));
    if (!row) throw notFound('Template', templateId);
    // A rule that is switched off counts too: it could never be saved again without its template.
    const [inUse] = await tx
      .select({ name: automationRules.name, active: automationRules.active })
      .from(automationRules)
      .where(and(eq(automationRules.orgId, actor.orgId), eq(automationRules.templateKey, row.key)))
      .orderBy(desc(automationRules.active))
      .limit(1);
    const [{ others } = { others: 0 }] = await tx
      .select({ others: sql<number>`count(*)::int` })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.orgId, actor.orgId),
          eq(messageTemplates.key, row.key),
          sql`${messageTemplates.id} <> ${templateId}`,
          sql`${messageTemplates.propertyId} IS NULL`,
        ),
      );
    if (inUse && others === 0) {
      throw conflict(
        `The automatic message "${inUse.name}" uses this template. Point it at another template, or remove it, first.`,
      );
    }
    await tx.delete(messageTemplates).where(eq(messageTemplates.id, templateId));
    await writeAudit(tx, actor, {
      action: 'template.deleted',
      entityType: 'message_template',
      entityId: templateId,
      propertyId: row.propertyId,
      summary: `Removed the message template "${row.name}"`,
    });
  });
}

/** The wording to use: the property's own in the guest's language, else the property's, else the organisation's. */
export async function findTemplate(
  db: DbOrTx,
  orgId: string,
  key: string,
  propertyId: string | null,
  language: string | null,
): Promise<MessageTemplateRow | null> {
  const rows = await db
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.orgId, orgId),
        eq(messageTemplates.key, key),
        eq(messageTemplates.active, true),
      ),
    );
  return pickTemplate(rows, propertyId, language);
}

function pickTemplate(
  rows: MessageTemplateRow[],
  propertyId: string | null,
  language: string | null,
): MessageTemplateRow | null {
  const lang = language?.toLowerCase().slice(0, 2) ?? 'en';
  const score = (t: MessageTemplateRow): number =>
    (t.propertyId === propertyId && propertyId ? 4 : t.propertyId ? -100 : 0) +
    (t.language.slice(0, 2) === lang ? 2 : t.language === 'en' ? 1 : 0);
  return rows.filter((t) => score(t) >= 0).sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** A template as the message it becomes on a channel. */
function templateMessage(
  template: MessageTemplateRow,
  variables: Record<string, string>,
  channel: ConversationChannel,
): { body: string; subject: string | null; templateKey: string; meta: Record<string, unknown> } {
  return {
    body: renderTemplate(template.body, variables),
    subject: template.subject ? renderTemplate(template.subject, variables) : null,
    templateKey: template.key,
    meta:
      channel === 'whatsapp' && template.whatsappTemplate
        ? {
            whatsappTemplate: template.whatsappTemplate,
            whatsappLanguage: template.language,
            whatsappParams: template.whatsappParams.map((name) => variables[name] ?? ''),
          }
        : {},
  };
}

// ---------------------------------------------------------------------------
// Sending a template about a reservation

export interface TemplateSend {
  conversation: ConversationRow;
  message: MessageRow;
  channel: ConversationChannel;
}

export interface Reach {
  channel: ConversationChannel;
  /** Why this channel cannot be used; null when it can. */
  problem: string | null;
}

/** Which of the channels the guest of a reservation can be reached on, with the reason for each that cannot. */
async function reachability(
  db: DbOrTx,
  reservation: ReservationRow,
  guest: GuestRow | undefined,
  template: MessageTemplateRow,
  channels: ConversationChannel[],
): Promise<Reach[]> {
  const out: Reach[] = [];
  for (const channel of channels) {
    const transport = transportFor(channel);
    let problem: string | null = null;
    if (!transport) {
      problem = `Sending by ${channel} is not set up`;
    } else if (channel === 'email') {
      problem = guest?.email ? null : 'The guest has no email address';
    } else if (channel === 'whatsapp') {
      if (!guest?.phone) problem = 'The guest has no phone number';
      else if (!template.whatsappTemplate) {
        // A business may only start a WhatsApp conversation with a template WhatsApp has approved.
        const [thread] = await db
          .select({ lastInboundAt: conversations.lastInboundAt })
          .from(conversations)
          .where(
            and(
              eq(conversations.orgId, reservation.orgId),
              eq(conversations.channel, 'whatsapp'),
              eq(conversations.externalThreadId, threadKey('whatsapp', guest.phone)),
            ),
          );
        if (!whatsappWindowOpen({ lastInboundAt: thread?.lastInboundAt ?? null })) {
          problem = 'This template has no approved WhatsApp template to open a conversation with';
        }
      }
    } else {
      if (!reservation.connectionId || !reservation.externalId) {
        problem = 'The booking did not come from a booking site';
      } else {
        const [connection] = await db
          .select()
          .from(channelConnections)
          .where(eq(channelConnections.id, reservation.connectionId));
        if (!connection || connection.adapter !== 'channex') {
          problem = 'This booking site connection has no message box';
        }
      }
    }
    if (!problem && transport) {
      // The transport knows whether its credentials are in place.
      problem = transport.unavailable({
        contactAddress:
          channel === 'email' ? guest!.email : channel === 'whatsapp' ? guest!.phone : null,
        connectionId: reservation.connectionId,
      });
    }
    out.push({ channel, problem });
  }
  return out;
}

/**
 * Sends a template to the guest of a reservation on the first of `channels`
 * that can reach them. Returns null, with the reasons, when none can.
 */
export async function sendTemplate(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  input: {
    templateKey: string;
    channels: ConversationChannel[];
    automationRuleId?: string | null;
    variables?: Record<string, string>;
  },
): Promise<{ sent: TemplateSend | null; problems: string[] }> {
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, actor.orgId)));
  if (!reservation) throw notFound('Reservation', reservationId);
  const [guest] = reservation.guestId
    ? await db.select().from(guests).where(eq(guests.id, reservation.guestId))
    : [];
  // An organisation that has never opened its templates still has the standard ones to send.
  await ensureMessagingDefaults(db, actor.orgId);
  const template = await findTemplate(
    db,
    actor.orgId,
    input.templateKey,
    reservation.propertyId,
    guest?.language ?? null,
  );
  if (!template) return { sent: null, problems: [`There is no template "${input.templateKey}"`] };
  const reach = await reachability(db, reservation, guest, template, input.channels);
  const usable = reach.find((r) => !r.problem);
  if (!usable) return { sent: null, problems: reach.map((r) => r.problem!) };

  const variables = await templateVariables(db, reservation, input.variables);
  const outgoing = templateMessage(template, variables, usable.channel);
  return transact(db, async (tx) => {
    const conversation = await openConversation(tx, actor.orgId, {
      channel: usable.channel,
      reservationId: reservation.id,
      subject: outgoing.subject,
    });
    const message = await sendMessage(tx, actor, conversation.id, {
      ...outgoing,
      automationRuleId: input.automationRuleId ?? null,
    });
    return { sent: { conversation, message, channel: usable.channel }, problems: [] };
  });
}

/** A template as it would be sent about one reservation, with the ways it could go. */
export interface ReservationTemplate {
  id: string;
  key: string;
  name: string;
  language: string;
  /** The property whose own wording this is; null for the organisation's. */
  propertyId: string | null;
  /** There are other wordings of it: another language, or the organisation's beside the property's. */
  severalVersions: boolean;
  /** Filled in. Used when it goes by email. */
  subject: string | null;
  body: string;
  /** The wording as written, placeholders and all, for a preview that fills in more than is known yet. */
  subjectText: string | null;
  bodyText: string;
  /** Placeholders the wording uses that there is nothing to put in for. */
  unfilled: string[];
  /** The name WhatsApp approved it under, and what goes in that wording's blanks, in order. */
  whatsappTemplate: string | null;
  whatsappValues: string[];
  /** Each way it could be sent, with why not for those that cannot be used now. */
  ways: Reach[];
}

/**
 * The templates that can be sent about a reservation: for each, the wording
 * the system picks for its guest, filled in with the booking's own details,
 * so that what staff read before sending is what the guest gets.
 */
export async function reservationTemplates(
  db: DbOrTx,
  orgId: string,
  reservationId: string,
): Promise<{
  templates: ReservationTemplate[];
  /** What each placeholder stands for with this booking. */
  values: Record<string, string>;
}> {
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, orgId)));
  if (!reservation) throw notFound('Reservation', reservationId);
  const [guest] = reservation.guestId
    ? await db.select().from(guests).where(eq(guests.id, reservation.guestId))
    : [];
  await ensureMessagingDefaults(db, orgId);
  const usable = (
    await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.orgId, orgId), eq(messageTemplates.active, true)))
  ).filter((t) => !t.propertyId || t.propertyId === reservation.propertyId);
  const variables = await templateVariables(db, reservation);
  const channels: ConversationChannel[] = reservation.connectionId
    ? ['email', 'whatsapp', 'ota']
    : ['email', 'whatsapp'];
  const out: ReservationTemplate[] = [];
  for (const key of new Set(usable.map((t) => t.key))) {
    const versions = usable.filter((t) => t.key === key);
    const template = pickTemplate(versions, reservation.propertyId, guest?.language ?? null);
    if (!template) continue;
    out.push({
      id: template.id,
      key,
      name: template.name,
      language: template.language,
      propertyId: template.propertyId,
      severalVersions: versions.length > 1,
      subject: template.subject ? renderTemplate(template.subject, variables) : null,
      body: renderTemplate(template.body, variables),
      subjectText: template.subject,
      bodyText: template.body,
      unfilled: unfilledVariables(`${template.subject ?? ''}\n${template.body}`, variables),
      whatsappTemplate: template.whatsappTemplate,
      whatsappValues: template.whatsappTemplate
        ? template.whatsappParams.map((name) => variables[name] ?? '')
        : [],
      ways: await reachability(db, reservation, guest, template, channels),
    });
  }
  return { templates: out.sort((a, b) => a.name.localeCompare(b.name)), values: variables };
}

// ---------------------------------------------------------------------------
// Templates in a conversation that is already open

export interface RenderedTemplate {
  id: string;
  key: string;
  name: string;
  language: string;
  /** The name WhatsApp approved it under, when it has one. */
  whatsappTemplate: string | null;
  /** Filled in. Only on email, the one channel with a subject line. */
  subject: string | null;
  /** Filled in for this guest, as it would be sent. */
  body: string;
  /** Placeholders the wording uses that there was nothing to put in for. */
  unfilled: string[];
  /** The wording the system itself picks for this guest: their language, the property's own text. */
  preferred: boolean;
}

async function conversationContext(
  db: DbOrTx,
  orgId: string,
  conversationId: string,
): Promise<{
  conversation: ConversationRow;
  reservation: ReservationRow | undefined;
  guest: GuestRow | undefined;
  propertyId: string | null;
}> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conversation) throw notFound('Conversation', conversationId);
  const [reservation] = conversation.reservationId
    ? await db.select().from(reservations).where(eq(reservations.id, conversation.reservationId))
    : [];
  const guestId = reservation?.guestId ?? conversation.guestId;
  const [guest] = guestId ? await db.select().from(guests).where(eq(guests.id, guestId)) : [];
  return {
    conversation,
    reservation,
    guest,
    propertyId: reservation?.propertyId ?? conversation.propertyId,
  };
}

/**
 * The templates that can be used in a conversation, each filled in for its
 * guest exactly as it would be sent, so that what staff read before sending
 * is what the guest gets.
 */
export async function conversationTemplates(
  db: DbOrTx,
  orgId: string,
  conversationId: string,
): Promise<RenderedTemplate[]> {
  const { conversation, reservation, guest, propertyId } = await conversationContext(
    db,
    orgId,
    conversationId,
  );
  await ensureMessagingDefaults(db, orgId);
  const all = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.orgId, orgId), eq(messageTemplates.active, true)));
  // One wording per name and language: the property's own in place of the organisation's.
  const wordings = new Map<string, MessageTemplateRow>();
  for (const template of all) {
    if (template.propertyId && template.propertyId !== propertyId) continue;
    const variant = `${template.key}:${template.language}`;
    if (template.propertyId || !wordings.has(variant)) wordings.set(variant, template);
  }
  const usable = [...wordings.values()];

  let variables: Record<string, string>;
  if (reservation) {
    variables = await templateVariables(db, reservation);
  } else {
    const [property] = propertyId
      ? await db.select().from(properties).where(eq(properties.id, propertyId))
      : [];
    // Without a booking the contact may be known only by an address, which is no way to greet anyone.
    const name =
      conversation.contactName !== conversation.contactAddress ? conversation.contactName : '';
    variables = {
      ...(property ? propertyVariables(property) : {}),
      guest_name: name,
      guest_first_name: name.split(/\s+/)[0] ?? '',
    };
  }

  const preferred = new Set<string>();
  for (const key of new Set(usable.map((t) => t.key))) {
    const best = pickTemplate(
      usable.filter((t) => t.key === key),
      propertyId,
      guest?.language ?? null,
    );
    if (best) preferred.add(best.id);
  }
  return usable
    .map((template) => {
      const subject = conversation.channel === 'email' ? template.subject : null;
      return {
        id: template.id,
        key: template.key,
        name: template.name,
        language: template.language,
        whatsappTemplate: template.whatsappTemplate,
        subject: subject ? renderTemplate(subject, variables) : null,
        body: renderTemplate(template.body, variables),
        unfilled: unfilledVariables(
          subject ? `${subject}\n${template.body}` : template.body,
          variables,
        ),
        preferred: preferred.has(template.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/**
 * Sends a template in the conversation that is open, to the address that
 * conversation is with, rather than wherever the guest's profile points.
 */
export async function sendTemplateInConversation(
  db: DbOrTx,
  actor: Actor,
  conversationId: string,
  input: { templateKey: string },
): Promise<{ sent: TemplateSend | null; problems: string[] }> {
  const { conversation, reservation, guest } = await conversationContext(
    db,
    actor.orgId,
    conversationId,
  );
  if (!reservation) {
    return {
      sent: null,
      problems: [
        'A template is sent about a booking, and this conversation is not linked to one. Link it to the booking first.',
      ],
    };
  }
  await ensureMessagingDefaults(db, actor.orgId);
  const template = await findTemplate(
    db,
    actor.orgId,
    input.templateKey,
    reservation.propertyId,
    guest?.language ?? null,
  );
  if (!template) return { sent: null, problems: [`There is no template "${input.templateKey}"`] };
  const transport = transportFor(conversation.channel);
  let problem = transport
    ? transport.unavailable(conversation)
    : `Sending by ${conversation.channel} is not set up`;
  if (
    !problem &&
    conversation.channel === 'whatsapp' &&
    !template.whatsappTemplate &&
    !whatsappWindowOpen(conversation)
  ) {
    problem = 'This template has no approved WhatsApp template to open a conversation with';
  }
  if (problem) return { sent: null, problems: [problem] };

  const variables = await templateVariables(db, reservation);
  const message = await sendMessage(
    db,
    actor,
    conversation.id,
    templateMessage(template, variables, conversation.channel),
  );
  return { sent: { conversation, message, channel: conversation.channel }, problems: [] };
}

// ---------------------------------------------------------------------------
// Automatic messages

export interface AutomationRuleInput {
  name: string;
  propertyId?: string | null;
  trigger: AutomationTrigger;
  offsetDays?: number;
  sendHour?: number;
  templateKey: string;
  channels: ConversationChannel[];
  sources?: ReservationSource[] | null;
  active?: boolean;
}

export async function listAutomationRules(db: DbOrTx, orgId: string): Promise<AutomationRuleRow[]> {
  await ensureMessagingDefaults(db, orgId);
  return db
    .select()
    .from(automationRules)
    .where(eq(automationRules.orgId, orgId))
    .orderBy(asc(automationRules.createdAt), asc(automationRules.name));
}

export async function saveAutomationRule(
  db: DbOrTx,
  actor: Actor,
  input: AutomationRuleInput,
  ruleId?: string,
): Promise<AutomationRuleRow> {
  if (!input.name.trim()) throw validationError('An automatic message needs a name');
  if (input.channels.length === 0) throw validationError('Choose at least one way to send it');
  const offsetDays = input.offsetDays ?? 0;
  const sendHour = input.sendHour ?? 10;
  if (!Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 365) {
    throw validationError('The number of days must be between 0 and 365');
  }
  if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) {
    throw validationError('The hour must be between 0 and 23');
  }
  if (input.trigger === 'pre_arrival' && offsetDays < 1) {
    throw validationError('A message before arrival is sent at least one day ahead');
  }
  return transact(db, async (tx) => {
    if (input.propertyId) {
      const [property] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.id, input.propertyId), eq(properties.orgId, actor.orgId)));
      if (!property) throw notFound('Property', input.propertyId);
    }
    const [template] = await tx
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(eq(messageTemplates.orgId, actor.orgId), eq(messageTemplates.key, input.templateKey)),
      );
    if (!template) throw validationError(`There is no template "${input.templateKey}"`);
    const values = {
      orgId: actor.orgId,
      propertyId: input.propertyId ?? null,
      name: input.name.trim().slice(0, 120),
      trigger: input.trigger,
      offsetDays,
      sendHour,
      templateKey: input.templateKey,
      channels: [...new Set(input.channels)],
      sources: input.sources?.length ? [...new Set(input.sources)] : null,
      active: input.active ?? true,
    };
    if (ruleId) {
      const [before] = await tx
        .select()
        .from(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, actor.orgId)));
      if (!before) throw notFound('Automatic message', ruleId);
      const [after] = await tx
        .update(automationRules)
        .set(values)
        .where(eq(automationRules.id, ruleId))
        .returning();
      await writeAudit(tx, actor, {
        action: 'automation.updated',
        entityType: 'automation_rule',
        entityId: ruleId,
        propertyId: after!.propertyId,
        summary: `Changed the automatic message "${after!.name}"`,
        changes: diff(before, after!),
      });
      return after!;
    }
    const [created] = await tx.insert(automationRules).values(values).returning();
    await writeAudit(tx, actor, {
      action: 'automation.created',
      entityType: 'automation_rule',
      entityId: created!.id,
      propertyId: created!.propertyId,
      summary: `Added the automatic message "${created!.name}"`,
    });
    return created!;
  });
}

export async function deleteAutomationRule(
  db: DbOrTx,
  actor: Actor,
  ruleId: string,
): Promise<void> {
  const deleted = await db
    .delete(automationRules)
    .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, actor.orgId)))
    .returning();
  if (deleted.length === 0) throw notFound('Automatic message', ruleId);
  await writeAudit(db, actor, {
    action: 'automation.deleted',
    entityType: 'automation_rule',
    entityId: ruleId,
    propertyId: deleted[0]!.propertyId,
    summary: `Removed the automatic message "${deleted[0]!.name}"`,
  });
}

/** Reservations a rule is due for now and has not written to yet. */
async function dueReservations(
  db: DbOrTx,
  rule: AutomationRuleRow,
  now: Date,
  limit: number,
): Promise<string[]> {
  const today = sql`(${now.toISOString()}::timestamptz AT TIME ZONE p.timezone)::date`;
  const hour = sql`extract(hour FROM ${now.toISOString()}::timestamptz AT TIME ZONE p.timezone)`;
  const timed = sql`${hour} >= ${rule.sendHour}`;
  let when;
  switch (rule.trigger) {
    case 'booking_confirmed':
      when = sql`r.status = 'confirmed'
        AND r.created_at > ${now.toISOString()}::timestamptz - interval '48 hours'
        AND r.created_at >= ${rule.createdAt.toISOString()}::timestamptz`;
      break;
    case 'booking_cancelled':
      when = sql`r.status = 'cancelled'
        AND r.cancelled_at > ${now.toISOString()}::timestamptz - interval '24 hours'
        AND r.cancelled_at >= ${rule.createdAt.toISOString()}::timestamptz
        AND coalesce(r.cancellation_reason, '') NOT IN (${sql.join(
          SILENT_CANCELLATIONS.map((reason) => sql`${reason}`),
          sql`, `,
        )})`;
      break;
    case 'pre_arrival':
      // A booking made inside the window still gets the message, straight away.
      when = sql`r.status = 'confirmed' AND ${today} >= r.check_in - ${rule.offsetDays}::int
        AND ${today} < r.check_in AND ${timed}`;
      break;
    case 'check_in_day':
      when = sql`r.status = 'confirmed' AND ${today} = r.check_in AND ${timed}`;
      break;
    case 'post_stay':
      when = sql`r.status = 'checked_out' AND ${today} >= r.check_out + ${rule.offsetDays}::int
        AND ${today} <= r.check_out + ${rule.offsetDays}::int + 2 AND ${timed}`;
      break;
  }
  const sources = rule.sources?.length
    ? sql`AND r.source IN (${sql.join(
        rule.sources.map((s) => sql`${s}`),
        sql`, `,
      )})`
    : sql``;
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT r.id
    FROM reservations r JOIN properties p ON p.id = r.property_id
    WHERE r.org_id = ${rule.orgId}
      AND (${rule.propertyId}::uuid IS NULL OR r.property_id = ${rule.propertyId}::uuid)
      ${sources}
      AND ${when}
      AND NOT EXISTS (
        SELECT 1 FROM automation_sends s WHERE s.rule_id = ${rule.id} AND s.reservation_id = r.id)
    ORDER BY r.check_in
    LIMIT ${limit}
  `);
  return rows.map((r) => r.id);
}

export interface AutomationRun {
  sent: number;
  skipped: number;
}

/**
 * Sends every automatic message that is due. Run by the worker every minute
 * or so; any number of workers may run it at once, and a rule still writes to
 * a guest only once.
 */
export async function runAutomations(
  db: DbOrTx,
  now: Date = new Date(),
  limit = 200,
): Promise<AutomationRun> {
  const run: AutomationRun = { sent: 0, skipped: 0 };
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) await ensureMessagingDefaults(db, org.id);
  const rules = await db.select().from(automationRules).where(eq(automationRules.active, true));
  for (const rule of rules) {
    const actor = systemActor(rule.orgId, 'automation');
    for (const reservationId of await dueReservations(db, rule, now, limit)) {
      await transact(db, async (tx) => {
        // Claiming the pair first makes two workers that pick the same reservation send one message.
        const claimed = await tx
          .insert(automationSends)
          .values({ ruleId: rule.id, reservationId, status: 'sent' })
          .onConflictDoNothing()
          .returning({ id: automationSends.id });
        if (claimed.length === 0) return;
        const { sent, problems } = await sendTemplate(tx, actor, reservationId, {
          templateKey: rule.templateKey,
          channels: rule.channels,
          automationRuleId: rule.id,
        });
        if (sent) {
          await tx
            .update(automationSends)
            .set({ messageId: sent.message.id })
            .where(eq(automationSends.id, claimed[0]!.id));
          run.sent++;
        } else {
          await tx
            .update(automationSends)
            .set({ status: 'skipped', reason: problems.join('; ').slice(0, 500) })
            .where(eq(automationSends.id, claimed[0]!.id));
          run.skipped++;
        }
      });
    }
  }
  return run;
}

export interface AutomationLogEntry {
  id: number;
  ruleName: string;
  reservationId: string;
  reservationCode: string;
  guestName: string;
  status: 'sent' | 'skipped';
  reason: string | null;
  createdAt: Date;
}

/** What the automatic messages did lately, newest first. */
export async function automationLog(
  db: DbOrTx,
  orgId: string,
  limit = 100,
): Promise<AutomationLogEntry[]> {
  const rows = await db
    .select({
      id: automationSends.id,
      ruleName: automationRules.name,
      reservationId: automationSends.reservationId,
      reservationCode: reservations.code,
      guestName: reservations.guestName,
      status: automationSends.status,
      reason: automationSends.reason,
      createdAt: automationSends.createdAt,
    })
    .from(automationSends)
    .innerJoin(automationRules, eq(automationRules.id, automationSends.ruleId))
    .innerJoin(reservations, eq(reservations.id, automationSends.reservationId))
    .where(eq(automationRules.orgId, orgId))
    .orderBy(sql`${automationSends.createdAt} DESC`)
    .limit(Math.min(limit, 500));
  return rows;
}
