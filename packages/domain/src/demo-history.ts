/**
 * Gives the demo organisation a past: five weeks in which guests arrived,
 * stayed, ate, paid and left, night after night, so that every screen has
 * something on it: the front desk, bills and invoices, housekeeping, the
 * inbox, reviews, reports, and the villa owners' statements.
 *
 * Everything goes through the same functions the application uses, one hotel
 * day at a time, so the books this leaves behind are books the system itself
 * would have produced.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  guests,
  properties,
  ratePlans,
  reservationRooms,
  reservations,
  reviews,
  roomTypes,
  units,
  users,
  type Database,
} from '@pms/db';
import { createUser } from './auth/service';
import { createCompany } from './companies';
import type { Actor } from './context';
import { addDays, monthOf, todayIn, type DateString } from './dates';
import { DEMO_ADMIN } from './demo-seed';
import { DomainError } from './errors';
import { listFolios, postCharge, recordPayment, reservationBalance } from './folios';
import { checkIn, checkOut } from './frontdesk';
import { setHousekeepingStatus } from './housekeeping';
import { addRoomingList, createGroup } from './groups';
import { receiveMessage, sendMessage } from './inbox';
import { getAvailability } from './inventory';
import { issueInvoice } from './invoices';
import { reportIssue } from './maintenance';
import { runNightAudit } from './nightaudit';
import {
  addOwnerExpense,
  createContract,
  createOwner,
  draftOwnerStatement,
  issueOwnerStatement,
} from './owners';
import { createPromo } from './promos';
import { updateProperty } from './properties';
import { createReportSchedule } from './report-exports';
import { createReservation, type CreateReservationInput } from './reservations';

const TZ = 'Asia/Kolkata';
const DEFAULT_DAYS = 35;

const FIRST_NAMES = [
  'Aditi',
  'Rahul',
  'Sneha',
  'Karthik',
  'Divya',
  'Sameer',
  'Pooja',
  'Nikhil',
  'Tara',
  'Imran',
  'Lakshmi',
  'Dev',
  'Anjali',
  'Farhan',
  'Ritu',
  'Oliver',
  'Charlotte',
  'Lukas',
  'Sofia',
  'Kenji',
  'Amelie',
  'Mateo',
  'Hannah',
  'Daniel',
];
const LAST_NAMES = [
  'Verma',
  'Pillai',
  'Chatterjee',
  'Gupta',
  'Menon',
  'Joshi',
  'Rao',
  'Shetty',
  'Malhotra',
  'Dsouza',
  'Banerjee',
  'Kulkarni',
  'Saxena',
  'Thomas',
  'Becker',
  'Marino',
  'Nakamura',
  'Laurent',
  'Garcia',
  'Wilson',
  'Evans',
  'Novak',
];
/** Where demo bookings come from. Null is the property's own: phone, walk-in, website. */
const SOURCES = [null, null, null, null, 'BDC', 'BDC', 'BDC', 'ABB', 'AGO', 'EXP', 'MMT'] as const;
const EXTRAS = [
  { kind: 'food', description: 'Dinner at the restaurant', amount: 185_000 },
  { kind: 'food', description: 'Breakfast for two', amount: 90_000 },
  { kind: 'food', description: 'Room service', amount: 64_000 },
  { kind: 'service', description: 'Laundry', amount: 45_000 },
  { kind: 'service', description: 'Airport transfer', amount: 250_000 },
  { kind: 'service', description: 'Spa treatment', amount: 320_000 },
  { kind: 'extra', description: 'Minibar', amount: 38_000 },
] as const;
const REVIEW_TEXTS: { score: number; text: string; scores: [string, number][] }[] = [
  {
    score: 92,
    text: 'Spotless room and a lovely view of the sea. The staff at the front desk remembered our names from the first day. Breakfast could start a little earlier.',
    scores: [
      ['staff', 10],
      ['cleanliness', 10],
      ['location', 9],
      ['value', 8],
    ],
  },
  {
    score: 58,
    text: 'The location is good but the air conditioning in our room was noisy and it took two days to get it looked at. The bathroom was not properly cleaned on arrival.',
    scores: [
      ['staff', 6],
      ['cleanliness', 4],
      ['comfort', 5],
      ['location', 9],
    ],
  },
  {
    score: 100,
    text: 'Perfect stay. The villa is even better than the photos, the pool was warm and the caretaker arranged everything we asked for.',
    scores: [
      ['staff', 10],
      ['cleanliness', 10],
      ['comfort', 10],
      ['value', 10],
    ],
  },
  {
    score: 80,
    text: 'Comfortable beds, quiet at night, good wifi. Check-in was slow because the room was not ready at 2 pm.',
    scores: [
      ['comfort', 9],
      ['wifi', 9],
      ['staff', 7],
    ],
  },
  {
    score: 71,
    text: 'Zimmer sauber und gross, Fruehstueck gut. Leider war das WLAN im zweiten Stock sehr schwach und der Pool war am Sonntag geschlossen.',
    scores: [
      ['cleanliness', 9],
      ['wifi', 4],
      ['facilities', 6],
    ],
  },
  {
    score: 88,
    text: 'Great value for a family. Kids loved the beach two minutes away. Parking is tight, come early.',
    scores: [
      ['value', 9],
      ['location', 10],
      ['facilities', 7],
    ],
  },
  {
    score: 45,
    text: 'We were charged for a minibar we did not use and it took three emails to get it back. The room itself was fine.',
    scores: [
      ['staff', 4],
      ['value', 4],
      ['comfort', 7],
    ],
  },
  {
    score: 96,
    text: 'Second time here and just as good. Thank you for the late check-out and the birthday cake.',
    scores: [
      ['staff', 10],
      ['comfort', 9],
      ['value', 9],
    ],
  },
];

export interface DemoHistorySummary {
  days: number;
  stays: number;
  checkedOut: number;
  inHouse: number;
  noShows: number;
  invoices: number;
  conversations: number;
  reviews: number;
}

interface Setup {
  roomTypeId: string;
  ratePlanId: string;
  baseRate: number;
}

/** A small repeatable generator, so the demo is the same on every run. */
function generator(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    // The high bits: the low bits of this generator repeat with a short period.
    return Math.floor((state / 0x80000000) * n);
  };
}

/** Runs a step that a full house or a changed rule may refuse, as a real attempt would be refused. */
async function attempt<T>(step: () => Promise<T>): Promise<T | null> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof DomainError) return null;
    throw err;
  }
}

export async function seedDemoHistory(
  db: Database,
  orgId: string,
  options: { days?: number } = {},
): Promise<DemoHistorySummary> {
  const days = Math.max(3, Math.min(options.days ?? DEFAULT_DAYS, 120));
  const rnd = generator(7);
  const pick = <T>(list: readonly T[]): T => list[rnd(list.length)]!;
  const today = todayIn(TZ);
  const start = addDays(today, -days);
  const summary: DemoHistorySummary = {
    days,
    stays: 0,
    checkedOut: 0,
    inHouse: 0,
    noShows: 0,
    invoices: 0,
    conversations: 0,
    reviews: 0,
  };

  const [adminUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.email, DEMO_ADMIN.email)));
  if (!adminUser) throw new DomainError('not_found', 'The demo organisation has no demo admin');
  const admin: Actor = {
    type: 'user',
    orgId,
    userId: adminUser.id,
    label: adminUser.email,
    grants: [{ role: 'org_admin', propertyId: null }],
  };

  const all = await db.select().from(properties).where(eq(properties.orgId, orgId));
  const byCode = (code: string) => {
    const property = all.find((p) => p.code === code);
    if (!property) throw new DomainError('not_found', `The demo property ${code} is missing`);
    return property;
  };
  const hotel = byCode('GOA');
  const azure = byCode('AZR');
  const coral = byCode('CRL');

  /** The sellable room types of a property with their main rate plan, by room type code. */
  const setupsOf = async (propertyId: string): Promise<Map<string, Setup>> => {
    const rows = await db
      .select({ type: roomTypes, plan: ratePlans })
      .from(roomTypes)
      .innerJoin(ratePlans, eq(ratePlans.roomTypeId, roomTypes.id))
      .where(and(eq(roomTypes.propertyId, propertyId), sql`${ratePlans.parentRatePlanId} IS NULL`));
    return new Map(
      rows.map((r) => [
        r.type.code,
        { roomTypeId: r.type.id, ratePlanId: r.plan.id, baseRate: r.plan.baseRate },
      ]),
    );
  };
  const hotelTypes = await setupsOf(hotel.id);
  const azureTypes = await setupsOf(azure.id);
  const coralTypes = await setupsOf(coral.id);

  // --- What a property is like: what guests are told, and what the assistant may say. ---
  await updateProperty(db, admin, hotel.id, {
    legalName: 'Sea Breeze Hospitality Pvt Ltd',
    gstin: '30AAACS1234A1Z5',
    phone: '+91 832 555 0100',
    email: 'stay@seabreeze.example',
    settings: {
      autoNoShow: true,
      bookingEngineEnabled: true,
      description:
        'Forty steps from Candolim beach: sea-view rooms, a pool under the palms and a kitchen that cooks Goan food the way it is cooked at home.',
      amenities: [
        'Pool',
        'Free wifi',
        'Restaurant',
        'Free parking',
        'Air conditioning',
        'Airport transfer',
      ],
      arrivalInstructions:
        'Reception is open all day and night. Parking is behind the building; ask the guard for the gate code.',
      bookingTerms:
        'Check-in from 2 pm, check-out by 11 am. No smoking in the rooms. Visitors are welcome in the lobby and restaurant.',
      knowledge:
        'Breakfast is served from 7:30 to 10:30. The pool is open from 7 am to 8 pm. The nearest ATM is 200 m away, next to the pharmacy. Dabolim airport is 40 km (about 75 minutes); Mopa airport is 30 km.',
      pricingEvents: [
        {
          from: addDays(today, 38),
          to: addDays(today, 42),
          name: 'Music festival at Vagator',
          upliftPercent: 25,
        },
      ],
    },
  });
  for (const villa of [azure, coral]) {
    await updateProperty(db, admin, villa.id, {
      legalName: 'Sea Breeze Hospitality Pvt Ltd',
      gstin: villa.id === azure.id ? '30AAACS1234A1Z5' : '27AAACS1234A1Z9',
      phone: '+91 832 555 0100',
      email: 'villas@seabreeze.example',
      settings: {
        autoNoShow: true,
        bookingEngineEnabled: true,
        description:
          villa.id === azure.id
            ? 'A three-bedroom Portuguese house in Assagao with a pool in the garden. Take the whole villa, or a bedroom of your own.'
            : 'A cottage by the sea in Alibaug for up to six, with a cook who comes in the morning.',
        amenities: ['Private pool', 'Free wifi', 'Kitchen', 'Caretaker', 'Free parking'],
        arrivalInstructions:
          'The caretaker meets you at the gate with the keys. Call 30 minutes before you arrive.',
        bookingTerms: 'Check-in from 2 pm, check-out by 11 am. No parties. Pets on request.',
      },
    });
  }

  for (const [email, name, role, propertyId] of [
    ['manager@example.com', 'Maya Fernandes', 'general_manager', null],
    ['accounts@example.com', 'Suresh Kamat', 'accountant', null],
    ['housekeeping@example.com', 'Lata Naik', 'housekeeping', hotel.id],
    ['maintenance@example.com', 'Joseph Pereira', 'maintenance', hotel.id],
  ] as const) {
    await createUser(db, admin, {
      email,
      name,
      password: DEMO_ADMIN.password,
      grants: [{ role, propertyId }],
    });
  }

  const corporate = await createCompany(db, admin, {
    kind: 'corporate',
    name: 'Konkan Software Labs',
    legalName: 'Konkan Software Labs Pvt Ltd',
    gstin: '27AAACK4321B1Z6',
    city: 'Pune',
    state: 'Maharashtra',
    stateCode: '27',
    email: 'travel@konkanlabs.example',
    contactName: 'Rhea Kapoor',
    creditLimit: 50_000_000,
    paymentTermsDays: 30,
  });
  const agent = await createCompany(db, admin, {
    kind: 'travel_agent',
    name: 'Goa Trails Travel',
    city: 'Panaji',
    state: 'Goa',
    stateCode: '30',
    email: 'bookings@goatrails.example',
    contactName: 'Anthony Lobo',
    commissionBp: 1000,
  });

  // --- The past: bookings that were made for the weeks before the base demo begins. ---
  await db.update(properties).set({ businessDate: start }).where(eq(properties.orgId, orgId));

  const offsetOf = (date: DateString): number =>
    Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const book = async (
    propertyId: string,
    setup: Setup,
    arrival: DateString,
    nights: number,
  ): Promise<void> => {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const channel = pick(SOURCES);
    const account = !channel && rnd(7) === 0 ? (rnd(2) === 0 ? corporate : agent) : null;
    // Booked between a day and six weeks ahead, and never in the future.
    const lead = Math.max(1 + rnd(40), offsetOf(arrival) + 1);
    const input: CreateReservationInput = {
      propertyId,
      source: channel
        ? 'ota'
        : account
          ? account.kind === 'corporate'
            ? 'corporate'
            : 'travel_agent'
          : pick(['direct', 'phone', 'website', 'walk_in'] as const),
      channelCode: channel,
      channelReservationCode: channel ? `${channel}${4_000_000 + rnd(5_999_999)}` : null,
      paymentCollect: channel === 'ABB' ? 'channel' : 'property',
      commissionAmount: channel ? Math.round(setup.baseRate * nights * 0.15) : undefined,
      companyId: account?.id ?? null,
      guest: {
        firstName: first,
        lastName: last,
        email: `${first}.${last}.${summary.stays}@example.com`.toLowerCase(),
        phone: `+9197${String(10_000_000 + rnd(89_999_999))}`,
        nationality: [
          'Becker',
          'Marino',
          'Nakamura',
          'Laurent',
          'Garcia',
          'Wilson',
          'Evans',
          'Novak',
        ].includes(last)
          ? pick(['DE', 'IT', 'JP', 'FR', 'ES', 'GB'] as const)
          : 'IN',
      },
      rooms: [
        {
          roomTypeId: setup.roomTypeId,
          ratePlanId: setup.ratePlanId,
          checkIn: arrival,
          checkOut: addDays(arrival, nights),
          adults: 1 + rnd(2),
        },
      ],
    };
    const made = await attempt(() => createReservation(db, admin, input));
    if (!made) return;
    summary.stays++;
    // Booked some days before arrival, not all at once this minute: the pace report reads this.
    await db.execute(sql`
      UPDATE reservations SET created_at = (${arrival}::date - ${lead}::int)::timestamp + interval '10 hours' + (${rnd(600)}::int * interval '1 minute')
      WHERE id = ${made.id}
    `);
  };

  const hotelMix = ['STD', 'STD', 'STD', 'DLX', 'DLX', 'STE'] as const;
  for (let offset = -days; offset < -4; offset++) {
    const arrival = addDays(today, offset);
    const weekend = [5, 6].includes(new Date(`${arrival}T00:00:00Z`).getUTCDay());
    for (let i = 0; i < (weekend ? 3 : 2); i++) {
      if (rnd(5) === 0) continue;
      await book(hotel.id, hotelTypes.get(pick(hotelMix))!, arrival, 1 + rnd(4));
    }
    if (rnd(4) === 0) {
      await book(azure.id, azureTypes.get(rnd(3) === 0 ? 'VILLA' : 'BED')!, arrival, 2 + rnd(3));
    }
    if (rnd(5) === 0) await book(coral.id, coralTypes.get('VILLA')!, arrival, 2 + rnd(3));
  }
  // Today's front desk has people to welcome, whatever the dice of the base demo said.
  for (const code of ['STD', 'DLX', 'STD', 'STE'] as const) {
    await book(hotel.id, hotelTypes.get(code)!, today, 1 + rnd(3));
  }
  // The weeks ahead fill up as they would, and the festival fills them faster.
  for (let offset = 1; offset <= 45; offset++) {
    const arrival = addDays(today, offset);
    const festival = offset >= 37 && offset <= 41;
    for (let i = 0; i < (festival ? 5 : 1); i++) {
      if (!festival && rnd(3) === 0) continue;
      await book(hotel.id, hotelTypes.get(pick(hotelMix))!, arrival, 1 + rnd(festival ? 2 : 3));
    }
  }
  // The bookings the base demo made for the days ahead were not all made today either.
  await db.execute(sql`
    UPDATE reservations r SET created_at = now() - ((abs(hashtext(r.id::text)) % 28) + 1) * interval '1 day'
    WHERE r.org_id = ${orgId} AND r.check_in >= ${addDays(today, -4)}::date
      AND r.created_at > now() - interval '1 hour'
  `);

  // --- Living through it, one hotel day at a time. ---
  const propertyIds = [hotel.id, azure.id, coral.id];
  const settle = async (reservationId: string, companyAccount: boolean): Promise<void> => {
    const balance = await reservationBalance(db, reservationId);
    if (balance <= 0 || companyAccount) return;
    const [folio] = await listFolios(db, orgId, reservationId);
    if (!folio) return;
    const method = pick(['card', 'card', 'upi', 'upi', 'cash', 'bank_transfer'] as const);
    await recordPayment(db, admin, {
      folioId: folio.id,
      method,
      amount: balance,
      reference: method === 'cash' ? null : `${method.toUpperCase()}-${100_000 + rnd(899_999)}`,
    });
  };
  const invoice = async (reservationId: string): Promise<void> => {
    const [folio] = await listFolios(db, orgId, reservationId);
    if (!folio) return;
    if (await attempt(() => issueInvoice(db, admin, folio.id))) summary.invoices++;
  };

  /** One hotel day at a property. `partly` leaves some of the day's work for whoever opens the demo. */
  const liveDay = async (propertyId: string, date: DateString, partly: boolean): Promise<void> => {
    const leaving = await db
      .selectDistinct({ id: reservations.id, companyId: reservations.companyId })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(
        and(
          eq(reservationRooms.propertyId, propertyId),
          eq(reservationRooms.status, 'in_house'),
          sql`${reservationRooms.checkOut} <= ${date}::date`,
        ),
      );
    for (const [index, stay] of leaving.entries()) {
      if (partly && index % 2 === 1) continue;
      const onAccount = stay.companyId === corporate.id;
      await settle(stay.id, onAccount);
      const out = await attempt(() =>
        checkOut(db, admin, stay.id, { balance: onAccount ? 'bill_company' : 'require_settled' }),
      );
      if (!out) continue;
      summary.checkedOut++;
      if (rnd(4) !== 0) await invoice(stay.id);
    }

    // Housekeeping turns the rooms round before the afternoon's arrivals.
    const dirty = await db
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.propertyId, propertyId), eq(units.housekeepingStatus, 'dirty')))
      .orderBy(asc(units.sortOrder));
    const cleaned = partly ? dirty.filter((_unit, index) => index % 3 !== 0) : dirty;
    if (cleaned.length > 0) {
      await setHousekeepingStatus(
        db,
        admin,
        cleaned.map((u) => u.id),
        'clean',
      );
    }

    const arriving = await db
      .selectDistinct({ id: reservations.id, code: reservations.code })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(
        and(
          eq(reservationRooms.propertyId, propertyId),
          eq(reservationRooms.status, 'confirmed'),
          sql`${reservationRooms.checkIn} <= ${date}::date`,
          sql`${reservationRooms.checkOut} > ${date}::date`,
        ),
      )
      .orderBy(asc(reservations.code));
    for (const [index, stay] of arriving.entries()) {
      // Now and then a guest simply does not turn up; the night audit records it.
      if (!partly && rnd(18) === 0) {
        summary.noShows++;
        continue;
      }
      if (partly && index % 2 === 0) continue;
      await attempt(() => checkIn(db, admin, stay.id, { allowDirty: true }));
    }

    const inHouse = await db
      .selectDistinct({ id: reservations.id })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(
        and(eq(reservationRooms.propertyId, propertyId), eq(reservationRooms.status, 'in_house')),
      );
    for (const stay of inHouse) {
      if (rnd(4) !== 0) continue;
      const extra = pick(EXTRAS);
      await attempt(() =>
        postCharge(db, admin, {
          reservationId: stay.id,
          kind: extra.kind,
          description: extra.description,
          unitAmount: extra.amount,
        }),
      );
    }
    if (partly) summary.inHouse += inHouse.length;
  };

  for (let offset = -days; offset < 0; offset++) {
    const date = addDays(today, offset);
    for (const propertyId of propertyIds) {
      await liveDay(propertyId, date, false);
      await runNightAudit(db, admin, propertyId);
    }
  }
  // Today is under way: some guests have left and arrived, others are still expected.
  for (const propertyId of propertyIds) await liveDay(propertyId, today, true);

  // Arrivals and departures happened on their own days, not all in the minute this ran.
  await db.execute(sql`
    UPDATE reservation_rooms rr SET
      checked_in_at = CASE WHEN rr.checked_in_at IS NULL THEN NULL
        ELSE rr.check_in::timestamp + interval '9 hours' + ((abs(hashtext(rr.id::text)) % 420) * interval '1 minute') END,
      checked_out_at = CASE WHEN rr.checked_out_at IS NULL THEN NULL
        ELSE rr.check_out::timestamp + interval '2 hours' + ((abs(hashtext(rr.id::text)) % 200) * interval '1 minute') END
    FROM properties p WHERE p.id = rr.property_id AND p.org_id = ${orgId}
  `);

  // --- Things waiting for someone: repairs, messages, reviews. ---
  const hotelUnits = await db
    .select()
    .from(units)
    .where(eq(units.propertyId, hotel.id))
    .orderBy(asc(units.sortOrder), asc(units.name));
  const unitNamed = (name: string) => hotelUnits.find((u) => u.name === name)?.id ?? null;
  await reportIssue(db, admin, {
    propertyId: hotel.id,
    unitId: unitNamed('204'),
    title: 'Air conditioning is noisy',
    description: 'Rattles when the compressor starts. The guest in 204 asked twice.',
    priority: 'high',
  });
  await reportIssue(db, admin, {
    propertyId: hotel.id,
    unitId: unitNamed('103'),
    title: 'Shower drain is slow',
    priority: 'normal',
  });
  await reportIssue(db, admin, {
    propertyId: azure.id,
    title: 'Pool pump makes a grinding noise',
    description: 'Started on Sunday. The pool man is booked for Thursday.',
    priority: 'normal',
  });

  const writers = await db
    .select({ reservation: reservations, guest: guests })
    .from(reservations)
    .innerJoin(guests, eq(guests.id, reservations.guestId))
    .where(
      and(
        eq(reservations.orgId, orgId),
        inArray(reservations.status, ['confirmed', 'in_house']),
        sql`${reservations.checkOut} > ${today}::date`,
        sql`${guests.email} IS NOT NULL`,
      ),
    )
    .orderBy(asc(reservations.checkIn), asc(reservations.code))
    .limit(6);
  const questions: { channel: 'email' | 'whatsapp'; subject?: string; lines: string[] }[] = [
    {
      channel: 'email',
      subject: 'Early check-in',
      lines: ['Hello, our flight lands at 9 in the morning. Could we check in early, around 11?'],
    },
    {
      channel: 'whatsapp',
      lines: ['Hi! Is breakfast included in our booking?', 'And do you have a cot for a baby?'],
    },
    {
      channel: 'email',
      subject: 'Airport transfer',
      lines: [
        'Can you arrange a taxi from Mopa airport for four people with luggage? What does it cost?',
      ],
    },
    {
      channel: 'whatsapp',
      lines: ['Guten Tag, gibt es einen Parkplatz am Hotel? Wir kommen mit dem Mietwagen.'],
    },
    {
      channel: 'email',
      subject: 'Invoice with company details',
      lines: [
        'Please send the invoice in the name of my company. I will share the GST number at check-in.',
      ],
    },
    {
      channel: 'whatsapp',
      lines: ['We would like to stay one more night if the room is free. Is that possible?'],
    },
  ];
  for (const [index, writer] of writers.entries()) {
    const question = questions[index % questions.length]!;
    const address =
      question.channel === 'email'
        ? writer.guest.email!
        : (writer.guest.phone ?? writer.guest.email!);
    const channel =
      question.channel === 'whatsapp' && !writer.guest.phone ? 'email' : question.channel;
    let conversationId: string | null = null;
    for (const [line, body] of question.lines.entries()) {
      const received = await receiveMessage(db, {
        orgId,
        channel,
        externalThreadId: address,
        externalId: `demo-${index}-${line}`,
        contactName: writer.reservation.guestName,
        contactAddress: address,
        subject: question.subject ?? null,
        body,
        reservationId: writer.reservation.id,
        propertyId: writer.reservation.propertyId,
        guestId: writer.guest.id,
        receivedAt: new Date(
          Date.now() - (index * 47 + (question.lines.length - line) * 3) * 60_000,
        ),
      });
      conversationId = received.conversation.id;
    }
    if (conversationId && index === 4) {
      await sendMessage(db, admin, conversationId, {
        kind: 'note',
        body: 'Asked accounts to hold the invoice until the guest gives the GST number.',
      });
    }
    summary.conversations++;
  }

  const stayed = await db
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.orgId, orgId),
        eq(reservations.status, 'checked_out'),
        sql`${reservations.channelCode} IS NOT NULL`,
      ),
    )
    .orderBy(asc(reservations.checkOut), asc(reservations.code))
    .limit(REVIEW_TEXTS.length);
  for (const [index, stay] of stayed.entries()) {
    const review = REVIEW_TEXTS[index]!;
    await db.insert(reviews).values({
      orgId,
      propertyId: stay.propertyId,
      externalId: `demo-review-${index}`,
      channelCode: stay.channelCode,
      reservationId: stay.id,
      otaReservationCode: stay.channelReservationCode,
      guestName: stay.guestName,
      overallScore: review.score,
      scores: review.scores.map(([category, score]) => ({ category, score })),
      content: review.text,
      receivedAt: new Date(`${addDays(stay.checkOut, 2)}T09:00:00+05:30`),
    });
    summary.reviews++;
  }

  // --- Selling: codes for the website. ---
  await createPromo(db, admin, {
    code: 'WELCOME10',
    description: 'Ten per cent off a first booking on our own website',
    kind: 'percent',
    value: 1000,
  });
  await createPromo(db, admin, {
    code: 'STAY4',
    description: 'Rs 2,500 off stays of four nights or more',
    kind: 'amount',
    value: 250_000,
    currency: 'INR',
    minNights: 4,
    stayTo: addDays(today, 120),
  });

  // --- Groups: rooms held for an offsite and a wedding, some of them booked. ---
  /** Holds up to `wanted` rooms, leaving at least one of the type on general sale. */
  const holdable = async (setup: Setup, from: DateString, to: DateString, wanted: number) => {
    const days = await getAvailability(db, {
      propertyId: hotel.id,
      range: { from, to },
      roomTypeIds: [setup.roomTypeId],
    });
    const quantity = Math.min(wanted, Math.min(...days.map((d) => d.available)) - 1);
    return quantity > 0 ? [{ roomTypeId: setup.roomTypeId, from, to, quantity }] : [];
  };
  const standard = hotelTypes.get('STD')!;
  const deluxe = hotelTypes.get('DLX')!;
  const offsiteFrom = addDays(today, 16);
  const offsiteTo = addDays(offsiteFrom, 2);
  const offsite = await createGroup(db, admin, {
    propertyId: hotel.id,
    name: 'Konkan Software Labs offsite',
    contactName: 'Rhea Kapoor',
    contactEmail: 'travel@konkanlabs.example',
    cutoffDate: addDays(today, 9),
    companyId: corporate.id,
    notes: 'Meeting room from 9 to 6 on both days. Vegetarian lunch for twelve.',
    holds: await holdable(standard, offsiteFrom, offsiteTo, 4),
  });
  await attempt(() =>
    addRoomingList(db, admin, offsite.id, {
      roomTypeId: standard.roomTypeId,
      ratePlanId: standard.ratePlanId,
      checkIn: offsiteFrom,
      checkOut: offsiteTo,
      nightlyRate: Math.round((standard.baseRate * 0.85) / 10_000) * 10_000,
      guests: [
        { firstName: 'Ishaan', lastName: 'Verma', email: 'ishaan.verma@konkanlabs.example' },
        { firstName: 'Meera', lastName: 'Pillai', email: 'meera.pillai@konkanlabs.example' },
      ],
    }),
  );
  const weddingFrom = addDays(today, 26);
  const weddingTo = addDays(weddingFrom, 3);
  const weddingHolds = [
    ...(await holdable(standard, weddingFrom, weddingTo, 3)),
    ...(await holdable(deluxe, weddingFrom, weddingTo, 2)),
  ];
  const wedding = await createGroup(db, admin, {
    propertyId: hotel.id,
    name: 'Fernandes wedding',
    contactName: 'Maria Fernandes',
    contactPhone: '+91 98220 55501',
    cutoffDate: addDays(today, 14),
    notes: 'Family arrives the day before the ceremony. Late check-out asked for on the last day.',
    holds: weddingHolds,
  });
  // The first of the family books one of the rooms held, of the better kind where one is held.
  const familyRoom = weddingHolds.some((hold) => hold.roomTypeId === deluxe.roomTypeId)
    ? deluxe
    : standard;
  await attempt(() =>
    createReservation(db, admin, {
      propertyId: hotel.id,
      source: 'phone',
      guest: { firstName: 'Joseph', lastName: 'Fernandes', phone: '+91 98220 55502' },
      rooms: [
        {
          roomTypeId: familyRoom.roomTypeId,
          ratePlanId: familyRoom.ratePlanId,
          checkIn: weddingFrom,
          checkOut: weddingTo,
          adults: 2,
        },
      ],
      groupId: wedding.id,
    }),
  );

  // --- The villas' owners, their contracts and last month's statements. ---
  const lastMonth = monthOf(addDays(monthOf(today).start, -1)).start.slice(0, 7);
  const lastMonthDay = (day: number): DateString => `${lastMonth}-${String(day).padStart(2, '0')}`;
  const contractStart = addDays(today, -200);
  const kavita = await createOwner(db, admin, {
    name: 'Kavita Menon',
    email: 'kavita.menon@example.com',
    phone: '+91 98200 55501',
    city: 'Mumbai',
    state: 'Maharashtra',
  });
  const azureContract = await createContract(db, admin, {
    ownerId: kavita.id,
    propertyId: azure.id,
    startsOn: contractStart,
    model: 'revenue_share',
    managementFeeBp: 2000,
    feeBasis: 'net',
    feeTaxBp: 1800,
    commissionOnOwner: true,
    ownerNightsPerYear: 21,
    ownerStayNoticeDays: 14,
    notes: 'Statement by the 5th, payout by the 10th of each month.',
  });
  const rahul = await createOwner(db, admin, {
    name: 'Rahul Shah',
    email: 'rahul.shah@example.com',
    phone: '+91 98200 55502',
    city: 'Pune',
    state: 'Maharashtra',
  });
  const coralContract = await createContract(db, admin, {
    ownerId: rahul.id,
    propertyId: coral.id,
    startsOn: contractStart,
    model: 'fixed_rent',
    fixedRent: 12_000_000,
    ownerNightsPerYear: 14,
    ownerStayNoticeDays: 30,
  });
  await addOwnerExpense(db, admin, {
    contractId: azureContract.id,
    date: lastMonthDay(12),
    category: 'maintenance',
    description: 'Pool pump service',
    amount: 450_000,
  });
  await addOwnerExpense(db, admin, {
    contractId: azureContract.id,
    date: lastMonthDay(28),
    category: 'utilities',
    description: 'Electricity',
    amount: 620_000,
  });
  await addOwnerExpense(db, admin, {
    contractId: coralContract.id,
    date: lastMonthDay(20),
    category: 'supplies',
    description: 'New linen for the two bedrooms',
    amount: 780_000,
  });
  const azureStatement = await draftOwnerStatement(db, admin, azureContract.id, lastMonth);
  await issueOwnerStatement(db, admin, azureStatement.id);
  await draftOwnerStatement(db, admin, coralContract.id, lastMonth);

  await createReportSchedule(db, admin, {
    name: 'Monday morning figures',
    report: 'performance',
    groupBy: 'day',
    propertyIds: null,
    period: 'last_7_days',
    frequency: 'weekly',
    weekday: 1,
    hour: 8,
    recipients: [DEMO_ADMIN.email],
  });

  return summary;
}
