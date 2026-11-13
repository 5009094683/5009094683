/**
 * Fills an empty development database with a small demo organisation: one
 * hotel, one villa sold whole and by bedroom, one single villa, staff users
 * and a spread of reservations around today.
 *
 * Refuses to run against a database that already has an organisation.
 */
import type { Database } from '@pms/db';
import { createUser, isSetupComplete, setupOrganization } from './auth/service';
import { createBlock } from './blocks';
import type { Actor } from './context';
import { addDays, todayIn } from './dates';
import { DomainError } from './errors';
import {
  createProperty,
  createRatePlan,
  createRoomType,
  createUnit,
  type RatePlanRow,
  type RoomTypeRow,
  type UnitRow,
} from './properties';
import { setRates } from './rates';
import { createReservation, type CreateReservationInput } from './reservations';

export const DEMO_ADMIN = { email: 'admin@example.com', password: 'demo-password-1' };

const FIRST_NAMES = [
  'Aarav',
  'Priya',
  'Rohan',
  'Ananya',
  'Vikram',
  'Meera',
  'Kabir',
  'Isha',
  'Arjun',
  'Neha',
  'Sophie',
  'Liam',
  'Emma',
  'Noah',
  'Yuki',
  'Hana',
];
const LAST_NAMES = [
  'Sharma',
  'Iyer',
  'Kapoor',
  'Nair',
  'Mehta',
  'Reddy',
  'Bose',
  'Fernandes',
  'Khan',
  'Desai',
  'Martin',
  'Schmidt',
  'Tanaka',
  'Rossi',
  'Dubois',
  'Clarke',
];
const CHANNELS = [null, null, null, 'BDC', 'BDC', 'ABB', 'AGO', 'EXP', 'MMT'] as const;

interface TypeSetup {
  roomType: RoomTypeRow;
  units: UnitRow[];
  plan: RatePlanRow;
}

async function buildType(
  db: Database,
  actor: Actor,
  propertyId: string,
  spec: {
    code: string;
    name: string;
    unitNames: string[];
    rate: number;
    maxAdults?: number;
    parentUnitId?: string;
  },
): Promise<TypeSetup> {
  const roomType = await createRoomType(db, actor, propertyId, {
    code: spec.code,
    name: spec.name,
    maxAdults: spec.maxAdults ?? 3,
    maxChildren: 2,
    maxOccupancy: (spec.maxAdults ?? 3) + 1,
  });
  const units: UnitRow[] = [];
  for (const [index, name] of spec.unitNames.entries()) {
    units.push(
      await createUnit(db, actor, propertyId, {
        roomTypeId: roomType.id,
        name,
        sortOrder: index,
        parentUnitId: spec.parentUnitId ?? null,
      }),
    );
  }
  const plan = await createRatePlan(db, actor, propertyId, {
    roomTypeId: roomType.id,
    code: `${spec.code}-BAR`,
    name: 'Flexible',
    baseRate: spec.rate,
    extraAdultRate: Math.round(spec.rate * 0.2),
    floorRate: Math.round(spec.rate * 0.7),
    ceilingRate: Math.round(spec.rate * 2),
    cancellationPolicy: { freeCancelDays: 3, penalty: 'first_night' },
  });
  await createRatePlan(db, actor, propertyId, {
    roomTypeId: roomType.id,
    code: `${spec.code}-NRF`,
    name: 'Non-refundable',
    baseRate: 0,
    parentRatePlanId: plan.id,
    derivedPercentBp: -1000,
    cancellationPolicy: { nonRefundable: true },
  });
  return { roomType, units, plan };
}

export async function seedDemo(db: Database): Promise<{ orgId: string }> {
  if (await isSetupComplete(db)) {
    throw new DomainError(
      'conflict',
      'This database already has an organisation. The demo seed only fills an empty one.',
    );
  }
  const { orgId, userId } = await setupOrganization(db, {
    orgName: 'Sea Breeze Hotels & Villas',
    adminName: 'Demo Admin',
    adminEmail: DEMO_ADMIN.email,
    adminPassword: DEMO_ADMIN.password,
  });
  const admin: Actor = {
    type: 'user',
    orgId,
    userId,
    label: DEMO_ADMIN.email,
    grants: [{ role: 'org_admin', propertyId: null }],
  };

  const hotel = await createProperty(db, admin, {
    code: 'GOA',
    name: 'Sea Breeze Candolim',
    kind: 'hotel',
    city: 'Candolim',
    state: 'Goa',
    stateCode: '30',
    country: 'IN',
    addressLine1: 'Fort Aguada Road',
    postalCode: '403515',
  });
  const standard = await buildType(db, admin, hotel.id, {
    code: 'STD',
    name: 'Standard Room',
    unitNames: ['101', '102', '103', '104', '105', '106'],
    rate: 450_000,
  });
  const deluxe = await buildType(db, admin, hotel.id, {
    code: 'DLX',
    name: 'Deluxe Sea View',
    unitNames: ['201', '202', '203', '204'],
    rate: 720_000,
  });
  const suite = await buildType(db, admin, hotel.id, {
    code: 'STE',
    name: 'Suite',
    unitNames: ['301', '302'],
    rate: 1_250_000,
    maxAdults: 4,
  });

  const azure = await createProperty(db, admin, {
    code: 'AZR',
    name: 'Villa Azure',
    kind: 'villa',
    city: 'Assagao',
    state: 'Goa',
    stateCode: '30',
    country: 'IN',
  });
  const azureWhole = await buildType(db, admin, azure.id, {
    code: 'VILLA',
    name: 'Entire Villa',
    unitNames: ['Villa Azure'],
    rate: 3_200_000,
    maxAdults: 8,
  });
  const azureRooms = await buildType(db, admin, azure.id, {
    code: 'BED',
    name: 'Bedroom',
    unitNames: ['Azure Bedroom 1', 'Azure Bedroom 2', 'Azure Bedroom 3'],
    rate: 1_100_000,
    maxAdults: 2,
    parentUnitId: azureWhole.units[0]!.id,
  });

  const coral = await createProperty(db, admin, {
    code: 'CRL',
    name: 'Coral Cottage',
    kind: 'villa',
    city: 'Alibaug',
    state: 'Maharashtra',
    stateCode: '27',
    country: 'IN',
  });
  const coralWhole = await buildType(db, admin, coral.id, {
    code: 'VILLA',
    name: 'Entire Cottage',
    unitNames: ['Coral Cottage'],
    rate: 1_800_000,
    maxAdults: 6,
  });

  await createUser(db, admin, {
    email: 'frontdesk@example.com',
    name: 'Front Desk',
    password: DEMO_ADMIN.password,
    grants: [{ role: 'front_desk', propertyId: hotel.id }],
  });
  await createUser(db, admin, {
    email: 'revenue@example.com',
    name: 'Revenue Manager',
    password: DEMO_ADMIN.password,
    grants: [{ role: 'revenue_manager', propertyId: null }],
  });

  const today = todayIn('Asia/Kolkata');

  // Weekend rates for the next two months.
  for (const setup of [standard, deluxe, suite, azureWhole, coralWhole]) {
    await setRates(db, admin, {
      propertyId: setup.roomType.propertyId,
      ratePlanId: setup.plan.id,
      range: { from: today, to: addDays(today, 60) },
      daysOfWeek: [5, 6],
      change: {
        rate: Math.round(setup.plan.baseRate * 1.25),
        minStayArrival: setup === azureWhole || setup === coralWhole ? 2 : null,
      },
    });
  }

  // A deterministic spread of stays so the demo looks the same on every run.
  let seed = 42;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Take the high bits: the low bits of this generator repeat with a short period.
    return Math.floor((seed / 0x80000000) * n);
  };
  const book = async (
    propertyId: string,
    setup: TypeSetup,
    offset: number,
    nights: number,
  ): Promise<void> => {
    const channel = CHANNELS[rnd(CHANNELS.length)]!;
    const first = FIRST_NAMES[rnd(FIRST_NAMES.length)]!;
    const last = LAST_NAMES[rnd(LAST_NAMES.length)]!;
    const checkIn = addDays(today, offset);
    const input: CreateReservationInput = {
      propertyId,
      source: channel ? 'ota' : (['direct', 'phone', 'walk_in'] as const)[rnd(3)]!,
      channelCode: channel,
      paymentCollect: channel === 'ABB' ? 'channel' : 'property',
      guest: {
        firstName: first,
        lastName: last,
        email: `${first}.${last}.${offset + 20}@example.com`.toLowerCase(),
        phone: `+9198${String(20_000_000 + rnd(9_999_999)).padStart(8, '0')}`,
      },
      rooms: [
        {
          roomTypeId: setup.roomType.id,
          ratePlanId: setup.plan.id,
          checkIn,
          checkOut: addDays(checkIn, nights),
          adults: 1 + rnd(2),
        },
      ],
    };
    try {
      await createReservation(db, admin, input);
    } catch (err) {
      // Sold out for those dates: skip, as a real booking attempt would.
      if (!(err instanceof DomainError)) throw err;
    }
  };

  for (let i = 0; i < 46; i++)
    await book(
      hotel.id,
      [standard, standard, deluxe, deluxe, suite][rnd(5)]!,
      rnd(40) - 4,
      1 + rnd(5),
    );
  for (let i = 0; i < 6; i++)
    await book(azure.id, rnd(3) === 0 ? azureWhole : azureRooms, rnd(36) - 2, 2 + rnd(4));
  for (let i = 0; i < 7; i++) await book(coral.id, coralWhole, rnd(40) - 2, 2 + rnd(4));

  const tryBlock = async (input: Parameters<typeof createBlock>[2]): Promise<void> => {
    try {
      await createBlock(db, admin, input);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
    }
  };
  await tryBlock({
    propertyId: hotel.id,
    unitId: standard.units[5]!.id,
    kind: 'maintenance',
    startDate: addDays(today, 2),
    endDate: addDays(today, 5),
    reason: 'Bathroom refit',
  });
  await tryBlock({
    propertyId: coral.id,
    unitId: coralWhole.units[0]!.id,
    kind: 'owner_stay',
    startDate: addDays(today, 44),
    endDate: addDays(today, 49),
    reason: 'Owner family visit',
  });
  await tryBlock({
    propertyId: hotel.id,
    roomTypeId: deluxe.roomType.id,
    quantity: 2,
    kind: 'hold',
    startDate: addDays(today, 45),
    endDate: addDays(today, 48),
    reason: 'Wedding party (tentative)',
  });

  return { orgId };
}
