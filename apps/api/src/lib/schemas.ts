import { z } from 'zod';
import { isValidDate } from '@pms/domain';

/** A calendar date, `YYYY-MM-DD`. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD')
  .refine(isValidDate, 'Not a real calendar date');

export const uuid = z.uuid();

/** Money in minor units (paise, cents): a non-negative whole number. */
export const money = z.number().int().min(0).max(1_000_000_000_000);

export const idParams = z.object({ id: uuid });
export const propertyParams = z.object({ propertyId: uuid });

export const dateRangeQuery = z.object({ from: dateString, to: dateString });

/** Comma-separated UUID list in a query string. */
export const uuidList = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(',').filter(Boolean) : undefined))
  .pipe(z.array(uuid).max(200).optional());

export const guestInput = z.object({
  id: uuid.optional(),
  firstName: z.string().min(1).max(120).optional(),
  lastName: z.string().max(120).optional(),
  email: z.email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  language: z.string().max(12).nullable().optional(),
  nationality: z.string().max(60).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().max(60).nullable().optional(),
  company: z.string().max(160).nullable().optional(),
  gstin: z.string().max(20).nullable().optional(),
});

export const roomInput = z.object({
  roomTypeId: uuid,
  ratePlanId: uuid.nullable().optional(),
  unitId: uuid.nullable().optional(),
  checkIn: dateString,
  checkOut: dateString,
  adults: z.number().int().min(1).max(30),
  children: z.number().int().min(0).max(30).optional(),
  guestName: z.string().max(160).nullable().optional(),
  nightlyRates: z.array(money).max(400).optional(),
});
