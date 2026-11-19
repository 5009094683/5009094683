import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  bookingRevisions,
  conversations,
  guests,
  messages,
  onlineCheckins,
  organizations,
  properties,
  reservations,
  storedFiles,
  type DbOrTx,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import { systemActor, type Actor } from './context';
import { decryptJson, decryptSecret } from './crypto';
import { invalidState, notFound } from './errors';
import { fullName, guestView } from './guests';
import { transact, uuidArray } from './sqlx';

/**
 * Guests' personal data: what is kept for how long, what a guest is given
 * when they ask for a copy, and how a guest is forgotten.
 *
 * Tax invoices are kept as issued: the law that requires them to be kept
 * outranks a request to erase them. Everything else that names the guest is
 * removed or replaced.
 */

const FORMER = 'Former guest';

/**
 * Erases what identifies a guest and keeps what the books need: the stays
 * themselves, with their dates and amounts, under "Former guest". Refused
 * while the guest has a stay under way or still to come.
 */
export async function anonymiseGuest(
  db: DbOrTx,
  actor: Actor,
  guestId: string,
  now: Date = new Date(),
): Promise<void> {
  await transact(db, async (tx) => {
    const [guest] = await tx
      .select()
      .from(guests)
      .where(and(eq(guests.id, guestId), eq(guests.orgId, actor.orgId)))
      .for('update');
    if (!guest) throw notFound('Guest', guestId);
    if (guest.anonymizedAt) return;
    // Erasing would also forget why this person is not to be given a room again. That has to be
    // somebody's decision, made by taking the mark off first.
    if (guest.blacklisted) {
      throw invalidState(
        'This guest is marked "Do not accept". Take that mark off first if their details are really to be erased.',
      );
    }
    const stays = await tx
      .select({ id: reservations.id, status: reservations.status, name: reservations.guestName })
      .from(reservations)
      .where(eq(reservations.guestId, guestId));
    if (stays.some((s) => ['tentative', 'confirmed', 'in_house'].includes(s.status))) {
      throw invalidState(
        'This guest has a stay under way or still to come. Their details can be erased once it is over or cancelled.',
      );
    }
    await scrub(tx, guest.id, stays, fullName(guest), now);
    await writeAudit(tx, actor, {
      action: 'guest.anonymised',
      entityType: 'guest',
      entityId: guestId,
      summary: 'Erased the personal details of a guest',
    });
  });
}

/** `LIKE ANY` patterns matching text that contains any of the ids. */
function likeAny(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${`%${id}%`}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * What a booking site sent about the stays is kept as received, guest details included, so
 * that a booking can be traced. For an erased guest the message is emptied and the reading of
 * it keeps only what the books need: dates, rooms and amounts.
 */
async function scrubBookingMessages(tx: Transaction, stayIds: string[]): Promise<void> {
  const rows = await tx
    .select({ id: bookingRevisions.id, event: bookingRevisions.event })
    .from(bookingRevisions)
    .where(inArray(bookingRevisions.reservationId, stayIds));
  for (const row of rows) {
    const event = { ...row.event };
    if ('guest' in event) {
      event.guest = {
        firstName: 'Former',
        lastName: 'guest',
        email: null,
        phone: null,
        country: null,
        language: null,
      };
    }
    if ('notes' in event) event.notes = null;
    if ('arrivalTime' in event) event.arrivalTime = null;
    if (Array.isArray(event.rooms)) {
      event.rooms = event.rooms.map((room: unknown) =>
        room && typeof room === 'object' ? { ...room, guestName: null } : room,
      );
    }
    await tx
      .update(bookingRevisions)
      .set({ raw: { erased: true }, event })
      .where(eq(bookingRevisions.id, row.id));
  }
}

async function scrub(
  tx: Transaction,
  guestId: string,
  stays: { id: string; name: string }[],
  name: string,
  now: Date,
): Promise<void> {
  const stayIds = stays.map((s) => s.id);
  await tx
    .update(guests)
    .set({
      firstName: 'Former',
      lastName: 'guest',
      email: null,
      phone: null,
      language: null,
      nationality: null,
      dateOfBirth: null,
      addressLine1: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      company: null,
      gstin: null,
      idType: null,
      idNumberEnc: null,
      idExpiry: null,
      notes: null,
      preferences: {},
      tags: [],
      vip: false,
      marketingConsent: false,
      anonymizedAt: now,
    })
    .where(eq(guests.id, guestId));
  // What was written with or about the guest goes entirely.
  await tx.delete(conversations).where(eq(conversations.guestId, guestId));
  if (stayIds.length > 0) {
    const ids = uuidArray(stayIds);
    await tx.execute(sql`DELETE FROM conversations WHERE reservation_id = ANY(${ids})`);
    await tx.execute(sql`
      UPDATE reservations
      SET guest_name = ${FORMER}, special_requests = NULL, notes = NULL, arrival_time = NULL
      WHERE id = ANY(${ids})
    `);
    await tx.execute(
      sql`UPDATE reservation_rooms SET guest_name = NULL WHERE reservation_id = ANY(${ids})`,
    );
    await tx.execute(sql`
      UPDATE online_checkins
      SET data_enc = NULL, signature_name = NULL, ip = NULL, user_agent = NULL
      WHERE reservation_id = ANY(${ids})
    `);
    await tx.execute(sql`UPDATE reviews SET guest_name = NULL WHERE reservation_id = ANY(${ids})`);
    // A guest's own bill carries their name, address and tax number. An invoice issued from it
    // has its own copy, which the law keeps; a bill made out to a company is not theirs.
    await tx.execute(sql`
      UPDATE folios SET bill_to = jsonb_build_object('name', ${FORMER}::text)
      WHERE reservation_id = ANY(${ids}) AND company_id IS NULL
    `);
    await scrubBookingMessages(tx, stayIds);
    await tx.execute(sql`
      DELETE FROM ai_actions
      WHERE org_id = (SELECT org_id FROM guests WHERE id = ${guestId})
        AND (params::text LIKE ANY(${likeAny([guestId, ...stayIds])})
          OR result::text LIKE ANY(${likeAny([guestId, ...stayIds])}))
    `);
  }
  // The audit trail keeps what was done and by whom, without the guest's name. Its wording is
  // the one thing about an audit entry that may change, and only when announced like this.
  await tx.execute(sql`SELECT set_config('pms.audit_redaction', 'on', true)`);
  if (stayIds.length > 0) {
    const names = [...new Set([name, ...stays.map((s) => s.name)])].filter(
      (n) => n.trim().length > 1 && n !== FORMER,
    );
    // Entries about the stays, and about what hangs from them: their bills, invoices,
    // payments and reviews. An entry elsewhere that happens to hold the same name is someone else's.
    const { rows: linked } = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM folios WHERE reservation_id = ANY(${uuidArray(stayIds)})
      UNION ALL
      SELECT i.id::text FROM invoices i JOIN folios f ON f.id = i.folio_id
      WHERE f.reservation_id = ANY(${uuidArray(stayIds)})
      UNION ALL
      SELECT p.id::text FROM payments p JOIN folios f ON f.id = p.folio_id
      WHERE f.reservation_id = ANY(${uuidArray(stayIds)})
      UNION ALL
      SELECT id::text FROM reviews WHERE reservation_id = ANY(${uuidArray(stayIds)})
    `);
    const about = `{${[...stayIds, ...linked.map((row) => row.id)].join(',')}}`;
    for (const known of names) {
      const like = `%${known.replace(/[%_\\]/g, '\\$&')}%`;
      await tx.execute(sql`
        UPDATE audit_log SET summary = replace(summary, ${known}, 'a former guest')
        WHERE entity_id = ANY(${about}::text[]) AND summary LIKE ${like}
      `);
      await tx.execute(sql`
        UPDATE alerts
        SET title = replace(title, ${known}, 'a former guest'),
            body = replace(body, ${known}, 'a former guest')
        WHERE entity_type = 'reservation' AND entity_id = ANY(${`{${stayIds.join(',')}}`}::text[])
          AND (title LIKE ${like} OR body LIKE ${like})
      `);
    }
    await tx.execute(sql`
      UPDATE audit_log SET changes = changes - 'guestName' - 'specialRequests' - 'notes' - 'arrivalTime'
      WHERE entity_type = 'reservation' AND entity_id = ANY(${`{${stayIds.join(',')}}`}::text[])
        AND changes ?| array['guestName', 'specialRequests', 'notes', 'arrivalTime']
    `);
  }
  await tx.execute(sql`
    UPDATE audit_log SET summary = 'Guest record changed', changes = NULL
    WHERE entity_type = 'guest' AND entity_id = ${guestId} AND action <> 'guest.anonymised'
  `);
  await tx.execute(sql`SELECT set_config('pms.audit_redaction', 'off', true)`);
  // Their documents and attachments are removed from the file store by the next clean-up.
  await tx
    .update(storedFiles)
    .set({ deleteAfter: now })
    .where(
      and(
        sql`${storedFiles.deletedAt} IS NULL`,
        stayIds.length > 0
          ? sql`(${storedFiles.guestId} = ${guestId} OR ${storedFiles.reservationId} = ANY(${uuidArray(stayIds)}))`
          : eq(storedFiles.guestId, guestId),
      ),
    );
}

export interface GuestDataExport {
  exportedAt: string;
  profile: ReturnType<typeof guestView> & { idNumber: string | null };
  stays: {
    code: string;
    property: string;
    status: string;
    checkIn: string;
    checkOut: string;
    source: string;
    totalAmount: number;
    currency: string;
    specialRequests: string | null;
    onlineCheckin: unknown;
  }[];
  conversations: {
    channel: string;
    startedAt: string;
    messages: { at: string; from: 'guest' | 'property'; text: string }[];
  }[];
  invoices: { number: string; type: string; issuedOn: string; total: number; currency: string }[];
  documents: { fileName: string; uploadedAt: string }[];
}

/**
 * Everything held about a guest, for a guest who asks for a copy of their
 * data. Includes the identity number in clear, so it is for those who may
 * see identity data, and the reading is recorded.
 */
export async function exportGuestData(
  db: DbOrTx,
  actor: Actor,
  guestId: string,
  now: Date = new Date(),
): Promise<GuestDataExport> {
  const [guest] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.orgId, actor.orgId)));
  if (!guest) throw notFound('Guest', guestId);
  const stays = await db
    .select({ reservation: reservations, property: properties.name })
    .from(reservations)
    .innerJoin(properties, eq(properties.id, reservations.propertyId))
    .where(eq(reservations.guestId, guestId))
    .orderBy(asc(reservations.checkIn));
  const stayIds = stays.map((s) => s.reservation.id);
  const checkins = stayIds.length
    ? await db.select().from(onlineCheckins).where(inArray(onlineCheckins.reservationId, stayIds))
    : [];
  const threads = await db
    .select()
    .from(conversations)
    .where(
      stayIds.length
        ? sql`(${conversations.guestId} = ${guestId} OR ${conversations.reservationId} = ANY(${uuidArray(stayIds)}))`
        : eq(conversations.guestId, guestId),
    )
    .orderBy(asc(conversations.createdAt));
  const said = threads.length
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            inArray(
              messages.conversationId,
              threads.map((c) => c.id),
            ),
            eq(messages.kind, 'text'),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.seq))
    : [];
  const bills = stayIds.length
    ? await db.execute<{
        number: string;
        type: string;
        issued_on: string;
        total: string;
        currency: string;
      }>(sql`
        SELECT i.number, i.type, i.issued_on::text, (i.totals->>'total') AS total, i.currency
        FROM invoices i JOIN folios f ON f.id = i.folio_id
        WHERE f.reservation_id = ANY(${uuidArray(stayIds)}) ORDER BY i.issued_on, i.number
      `)
    : { rows: [] };
  const files = await db
    .select()
    .from(storedFiles)
    .where(
      and(
        sql`${storedFiles.deletedAt} IS NULL`,
        stayIds.length
          ? sql`(${storedFiles.guestId} = ${guestId} OR ${storedFiles.reservationId} = ANY(${uuidArray(stayIds)}))`
          : eq(storedFiles.guestId, guestId),
      ),
    );
  await writeAudit(db, actor, {
    action: 'guest.exported',
    entityType: 'guest',
    entityId: guestId,
    summary: `Exported the data held about ${fullName(guest)}`,
  });
  return {
    exportedAt: now.toISOString(),
    profile: {
      ...guestView(guest),
      idNumber: guest.idNumberEnc ? decryptSecret(guest.idNumberEnc) : null,
    },
    stays: stays.map(({ reservation: r, property }) => {
      const checkin = checkins.find((c) => c.reservationId === r.id);
      return {
        code: r.code,
        property,
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        source: r.channelCode ?? r.source,
        totalAmount: r.totalAmount,
        currency: r.currency,
        specialRequests: r.specialRequests,
        onlineCheckin: checkin?.dataEnc ? decryptJson<unknown>(checkin.dataEnc) : null,
      };
    }),
    conversations: threads.map((c) => ({
      channel: c.channel,
      startedAt: c.createdAt.toISOString(),
      messages: said
        .filter((m) => m.conversationId === c.id)
        .map((m) => ({
          at: m.createdAt.toISOString(),
          from: m.direction === 'in' ? ('guest' as const) : ('property' as const),
          text: m.body,
        })),
    })),
    invoices: bills.rows.map((i) => ({
      number: i.number,
      type: i.type,
      issuedOn: i.issued_on,
      total: Number(i.total),
      currency: i.currency,
    })),
    documents: files.map((f) => ({ fileName: f.fileName, uploadedAt: f.createdAt.toISOString() })),
  };
}

export interface RetentionRun {
  /** Guests whose identity document number was erased. */
  idNumbersErased: number;
  /** Online check-ins whose identity details were erased. */
  checkinsErased: number;
  /** Identity document files marked for removal. */
  documentsMarked: number;
  guestsAnonymised: number;
}

/**
 * Applies each organisation's own rules for how long guest data is kept:
 * identity details so many days after departure, the whole profile so many
 * days after the guest's last stay. Zero means "keep until removed by hand".
 * Run daily by the worker; safe to run as often as wanted.
 */
export async function applyRetention(db: DbOrTx, now: Date = new Date()): Promise<RetentionRun> {
  const run: RetentionRun = {
    idNumbersErased: 0,
    checkinsErased: 0,
    documentsMarked: 0,
    guestsAnonymised: 0,
  };
  const orgs = await db
    .select({ id: organizations.id, settings: organizations.settings })
    .from(organizations);
  const at = sql`${now.toISOString()}::timestamptz`;
  for (const org of orgs) {
    const idDays = org.settings.guestIdRetentionDays ?? 0;
    const profileDays = org.settings.guestProfileRetentionDays ?? 0;

    if (idDays > 0) {
      const age = sql`make_interval(days => ${idDays})`;
      // A guest's identity number goes once every stay of theirs ended that long ago.
      const erased = await db.execute(sql`
        UPDATE guests g SET id_number_enc = NULL, id_expiry = NULL
        WHERE g.org_id = ${org.id} AND g.id_number_enc IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM reservations r WHERE r.guest_id = g.id
              AND (r.status IN ('tentative', 'confirmed', 'in_house') OR r.check_out > (${at} - ${age})::date))
          AND g.updated_at < ${at} - ${age}
      `);
      run.idNumbersErased += erased.rowCount ?? 0;
      const checkins = await db.execute(sql`
        UPDATE online_checkins oc SET data_enc = NULL
        FROM reservations r
        WHERE r.id = oc.reservation_id AND r.org_id = ${org.id} AND oc.data_enc IS NOT NULL
          AND r.status NOT IN ('tentative', 'confirmed', 'in_house')
          AND r.check_out <= (${at} - ${age})::date
      `);
      run.checkinsErased += checkins.rowCount ?? 0;
      // Documents uploaded before the rule was set carry no date of their own.
      const documents = await db.execute(sql`
        UPDATE stored_files f SET delete_after = ${at}
        FROM reservations r
        WHERE r.id = f.reservation_id AND f.org_id = ${org.id} AND f.kind = 'id_document'
          AND f.deleted_at IS NULL AND f.delete_after IS NULL
          AND r.status NOT IN ('tentative', 'confirmed', 'in_house')
          AND r.check_out <= (${at} - ${age})::date
      `);
      run.documentsMarked += documents.rowCount ?? 0;
    }

    if (profileDays > 0) {
      const age = sql`make_interval(days => ${profileDays})`;
      const { rows: due } = await db.execute<{ id: string }>(sql`
        SELECT g.id FROM guests g
        WHERE g.org_id = ${org.id} AND g.anonymized_at IS NULL AND NOT g.blacklisted
          AND g.created_at < ${at} - ${age}
          AND NOT EXISTS (
            SELECT 1 FROM reservations r WHERE r.guest_id = g.id
              AND (r.status IN ('tentative', 'confirmed', 'in_house') OR r.check_out > (${at} - ${age})::date))
        LIMIT 500
      `);
      const actor = systemActor(org.id, 'retention');
      for (const { id } of due) {
        await anonymiseGuest(db, actor, id, now);
        run.guestsAnonymised++;
      }
    }
  }
  return run;
}
