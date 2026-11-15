import { z } from 'zod';

export const LANGS = ['en', 'vi'] as const;
export type Lang = (typeof LANGS)[number];

export const SERVICE_KINDS = ['rental', 'tour', 'easy_rider'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

const slug = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'use lower-case letters, digits and dashes, e.g. "honda-wave"',
  );

const bilingual = z.object({ en: z.string(), vi: z.string() });
const bilingualList = z.object({ en: z.array(z.string()), vi: z.array(z.string()) });

/** One wording for both languages, or one per language. */
const flexibleText = z
  .union([z.string(), bilingual])
  .transform((value) => (typeof value === 'string' ? { en: value, vi: value } : value));

const emptyText = { en: '', vi: '' };
const emptyList = { en: [], vi: [] };

const cancellationSchema = z
  .object({
    freeHours: z.number().int().positive(),
    lateHours: z.number().int().nonnegative(),
    midChargePercent: z.number().int().min(0).max(100),
  })
  .refine((c) => c.lateHours < c.freeHours, {
    message: 'lateHours must be smaller than freeHours',
  });

const optionSchema = z.object({
  id: slug,
  name: flexibleText,
  aliases: z.array(z.string().min(1)).default([]),
  price: z.number().int().positive().nullable().default(null),
  days: z.number().int().positive().max(60).optional(),
  capacity: z.number().int().positive().nullable().default(null),
});

const serviceSchema = z.object({
  id: slug,
  kind: z.enum(SERVICE_KINDS),
  name: bilingual,
  options: z.array(optionSchema).min(1),
  included: bilingualList.default(emptyList),
  note: bilingual.default(emptyText),
  depositPercent: z.number().int().min(0).max(100).default(0),
  cancellation: cancellationSchema.nullable().default(null),
  autoConfirm: z.boolean().default(false),
  keywords: z.array(z.string().min(1)).default([]),
});

const faqSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1),
  answer: flexibleText,
});

export const businessSchema = z
  .object({
    company: z.object({
      name: z.string().min(1),
      signature: z.string().default(''),
      contacts: z
        .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
        .default([]),
      address: flexibleText.default(emptyText),
      mapUrl: z.string().default(''),
    }),
    timezone: z.string().default('Asia/Ho_Chi_Minh'),
    defaultLanguage: z.enum(LANGS).default('en'),
    booking: z
      .object({
        codePrefix: z
          .string()
          .regex(/^[A-Z]{1,4}$/, 'one to four capital letters')
          .default('CB'),
        maxAdvanceDays: z.number().int().positive().default(365),
        maxDays: z.number().int().positive().default(30),
        maxQuantity: z.number().int().positive().default(20),
        askPhone: z.boolean().default(true),
        askPickup: z.boolean().default(true),
      })
      .prefault({}),
    payment: z
      .object({
        methods: bilingualList.default(emptyList),
        instructions: flexibleText.default(emptyText),
      })
      .prefault({}),
    services: z.array(serviceSchema).min(1),
    faq: z.array(faqSchema).default([]),
  })
  .superRefine((business, ctx) => {
    const serviceIds = new Set<string>();
    business.services.forEach((service, s) => {
      if (serviceIds.has(service.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', s, 'id'],
          message: `two services share the id "${service.id}"`,
        });
      }
      serviceIds.add(service.id);

      const optionIds = new Set<string>();
      service.options.forEach((option, o) => {
        if (optionIds.has(option.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', s, 'options', o, 'id'],
            message: `two options of "${service.id}" share the id "${option.id}"`,
          });
        }
        optionIds.add(option.id);

        if (service.autoConfirm && (option.price === null || option.capacity === null)) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', s, 'options', o],
            message:
              `"${service.id}" has autoConfirm: true, so every option needs a price and a capacity ` +
              `("${option.id}" lacks one). Without them the assistant cannot know what it is confirming.`,
          });
        }
      });
    });

    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: business.timezone });
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: `"${business.timezone}" is not a time zone name such as "Asia/Ho_Chi_Minh"`,
      });
    }
  });

export type Business = z.output<typeof businessSchema>;
export type BusinessInput = z.input<typeof businessSchema>;
export type Service = Business['services'][number];
export type ServiceOption = Service['options'][number];
export type Cancellation = NonNullable<Service['cancellation']>;
export type Bilingual = { en: string; vi: string };

/** Gives a settings file type checking and completion in the editor. */
export function defineBusiness(input: BusinessInput): BusinessInput {
  return input;
}

export class BusinessConfigError extends Error {}

export function parseBusiness(input: unknown, source = 'business settings'): Business {
  const result = businessSchema.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(top level)';
      return `  - ${where}: ${issue.message}`;
    });
    throw new BusinessConfigError(`${source} cannot be used:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function findService(business: Business, serviceId: string): Service | undefined {
  return business.services.find((service) => service.id === serviceId);
}

export function findOption(service: Service, optionId: string): ServiceOption | undefined {
  return service.options.find((option) => option.id === optionId);
}
