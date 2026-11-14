import { sql } from 'drizzle-orm';
import { bigint, customType, timestamp, uuid } from 'drizzle-orm/pg-core';

export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** Half-open date range, written and read as `[2026-12-12,2026-12-15)`. */
export const daterange = customType<{ data: string }>({
  dataType() {
    return 'daterange';
  },
});

export const id = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Money in minor units (paise, cents). Never floats. */
export const money = (name: string) => bigint(name, { mode: 'number' });

export const emptyJson = sql`'{}'::jsonb`;
export const emptyJsonArray = sql`'[]'::jsonb`;
