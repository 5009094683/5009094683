import { organizations, roleAssignments, users, type Database, type Role } from '@pms/db';
import type { Actor, Grant } from './context';
import { hashPassword } from './auth/passwords';
import {
  createProperty,
  createRatePlan,
  createRoomType,
  createUnit,
  type PropertyRow,
  type RatePlanRow,
  type RoomTypeRow,
  type UnitRow,
} from './properties';

export { startMockOidcProvider, type MockOidcProvider } from './testing/mock-oidc';
export { DEMO_ADMIN, seedDemo } from './demo-seed';
export { seedDemoHistory, type DemoHistorySummary } from './demo-history';

export const TEST_PASSWORD = 'correct horse battery staple';

let cachedHash: Promise<string> | undefined;

/** One scrypt hash shared by all fixtures; hashing per user would dominate test time. */
function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export interface TestOrg {
  orgId: string;
  adminUserId: string;
  admin: Actor;
}

export async function createTestOrg(db: Database, name = 'Test Hotels'): Promise<TestOrg> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizations).values({ name, slug }).returning();
  const user = await createTestUser(db, org!.id, {
    email: `admin-${slug}@example.com`,
    grants: [{ role: 'org_admin', propertyId: null }],
  });
  return { orgId: org!.id, adminUserId: user.id, admin: user.actor };
}

export async function createTestUser(
  db: Database,
  orgId: string,
  options: {
    email?: string;
    name?: string;
    grants?: Grant[];
    role?: Role;
    propertyId?: string | null;
  } = {},
): Promise<{ id: string; email: string; actor: Actor }> {
  const email = options.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const grants =
    options.grants ??
    (options.role ? [{ role: options.role, propertyId: options.propertyId ?? null }] : []);
  const [user] = await db
    .insert(users)
    .values({
      orgId,
      email,
      name: options.name ?? 'Test User',
      status: 'active',
      passwordHash: await testPasswordHash(),
    })
    .returning();
  if (grants.length > 0) {
    await db
      .insert(roleAssignments)
      .values(grants.map((g) => ({ userId: user!.id, role: g.role, propertyId: g.propertyId })));
  }
  return {
    id: user!.id,
    email,
    actor: { type: 'user', orgId, userId: user!.id, label: email, grants },
  };
}

export interface TestRoomType {
  roomType: RoomTypeRow;
  units: UnitRow[];
  ratePlan: RatePlanRow;
}

export interface TestHotel {
  property: PropertyRow;
  standard: TestRoomType;
  deluxe: TestRoomType;
}

let propertySeq = 0;

/**
 * A hotel with two room types sold by count: `standardRooms` standard rooms
 * and `deluxeRooms` deluxe rooms. With `autoAssign: false` bookings get no
 * room until one is chosen, which is how run-of-house hotels work.
 */
export async function createTestHotel(
  db: Database,
  org: TestOrg,
  options: {
    standardRooms?: number;
    deluxeRooms?: number;
    name?: string;
    autoAssign?: boolean;
  } = {},
): Promise<TestHotel> {
  const seq = ++propertySeq;
  const property = await createProperty(db, org.admin, {
    code: `HTL${seq}`,
    name: options.name ?? `Test Hotel ${seq}`,
    kind: 'hotel',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
  });
  const build = async (
    code: string,
    name: string,
    count: number,
    rate: number,
  ): Promise<TestRoomType> => {
    const roomType = await createRoomType(db, org.admin, property.id, {
      code,
      name,
      maxAdults: 3,
      maxChildren: 2,
      maxOccupancy: 4,
      autoAssign: options.autoAssign,
    });
    const units: UnitRow[] = [];
    for (let i = 1; i <= count; i++) {
      units.push(
        await createUnit(db, org.admin, property.id, {
          roomTypeId: roomType.id,
          name: `${code}-${100 + i}`,
        }),
      );
    }
    const ratePlan = await createRatePlan(db, org.admin, property.id, {
      roomTypeId: roomType.id,
      code: `${code}-BAR`,
      name: `${name} flexible`,
      baseRate: rate,
      extraAdultRate: 100_000,
      extraChildRate: 50_000,
    });
    return { roomType, units, ratePlan };
  };
  return {
    property,
    standard: await build('STD', 'Standard Room', options.standardRooms ?? 3, 450_000),
    deluxe: await build('DLX', 'Deluxe Room', options.deluxeRooms ?? 2, 700_000),
  };
}

export interface TestVilla {
  property: PropertyRow;
  /** The villa sold as a whole. */
  whole: TestRoomType;
  /** Its bedrooms sold individually, linked to the villa. Absent when `bedrooms` is 0. */
  bedrooms?: TestRoomType;
}

/**
 * A villa property. With `bedrooms` > 0 the villa is also sold by the room:
 * each bedroom is a unit linked to the villa unit.
 */
export async function createTestVilla(
  db: Database,
  org: TestOrg,
  options: { bedrooms?: number; name?: string } = {},
): Promise<TestVilla> {
  const seq = ++propertySeq;
  const property = await createProperty(db, org.admin, {
    code: `VIL${seq}`,
    name: options.name ?? `Test Villa ${seq}`,
    kind: 'villa',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
  });
  const wholeType = await createRoomType(db, org.admin, property.id, {
    code: 'VILLA',
    name: 'Entire Villa',
    baseOccupancy: 6,
    maxAdults: 8,
    maxChildren: 4,
    maxOccupancy: 10,
  });
  const villaUnit = await createUnit(db, org.admin, property.id, {
    roomTypeId: wholeType.id,
    name: 'Villa',
  });
  const wholePlan = await createRatePlan(db, org.admin, property.id, {
    roomTypeId: wholeType.id,
    code: 'VILLA-BAR',
    name: 'Villa flexible',
    baseRate: 2_500_000,
  });
  const whole: TestRoomType = { roomType: wholeType, units: [villaUnit], ratePlan: wholePlan };

  const count = options.bedrooms ?? 0;
  if (count === 0) return { property, whole };

  const bedroomType = await createRoomType(db, org.admin, property.id, {
    code: 'BED',
    name: 'Bedroom',
  });
  const bedroomUnits: UnitRow[] = [];
  for (let i = 1; i <= count; i++) {
    bedroomUnits.push(
      await createUnit(db, org.admin, property.id, {
        roomTypeId: bedroomType.id,
        name: `Bedroom ${i}`,
        parentUnitId: villaUnit.id,
      }),
    );
  }
  const bedroomPlan = await createRatePlan(db, org.admin, property.id, {
    roomTypeId: bedroomType.id,
    code: 'BED-BAR',
    name: 'Bedroom flexible',
    baseRate: 900_000,
  });
  return {
    property,
    whole,
    bedrooms: { roomType: bedroomType, units: bedroomUnits, ratePlan: bedroomPlan },
  };
}
