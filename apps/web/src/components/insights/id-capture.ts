import type { IdCapture } from './types';

/**
 * Everything about reading an identity document from a photo that needs no browser: which
 * photos can be sent, what the server's answer means, and what goes onto the guest's profile.
 * It uses nothing from the rest of the app, so that it can be checked on its own
 * (`id-capture.test.ts`).
 */

/** The formats `POST /reservations/:id/id-capture` takes. */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The server refuses anything larger. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** What is wrong with a chosen file, in words, or null when it can be sent. */
export function photoProblem(file: { type: string; size: number }): string | null {
  if (!PHOTO_TYPES.includes(file.type)) {
    return 'This is not a JPEG, PNG or WebP photo. Take a photo of the document, or choose one in those formats.';
  }
  if (file.size === 0) return 'This photo is empty. Take it again.';
  if (file.size > MAX_PHOTO_BYTES) {
    return 'This photo is larger than 8 MB. Take it at a lower quality or crop it to the document, then try again.';
  }
  return null;
}

/** What `ApiError` is made from when the server refuses, as in `lib/api.ts`. */
export interface CaptureFailure {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const DOCUMENT_TYPES = [
  'passport',
  'aadhaar',
  'driving_licence',
  'voter_id',
  'national_id',
  'other',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** A real calendar day written `YYYY-MM-DD`, or null: a date input shows nothing else. */
function day(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

/**
 * Reads the answer of the id-capture route the way `api()` reads any answer: a failure carries
 * the server's own code and message. What was read is taken field by field, so that a missing
 * or misshapen field is simply "not read" and the photo counts as legible only on a plain yes.
 */
export function readCaptureAnswer(
  status: number,
  body: string,
): { capture: IdCapture } | { failure: CaptureFailure } {
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : undefined;
  } catch {
    data = undefined;
  }
  if (status < 200 || status > 299) {
    const error = isRecord(data) && isRecord(data.error) ? data.error : {};
    return {
      failure: {
        status,
        code: typeof error.code === 'string' ? error.code : 'error',
        message:
          typeof error.message === 'string' ? error.message : `The server answered ${status}`,
        details: isRecord(error.details) ? error.details : undefined,
      },
    };
  }
  if (!isRecord(data)) {
    return {
      failure: {
        status,
        code: 'unreadable',
        message: 'The answer from the server could not be understood. Try again.',
      },
    };
  }
  return {
    capture: {
      documentType: DOCUMENT_TYPES.find((type) => type === data.documentType) ?? null,
      fullName: text(data.fullName),
      documentNumber: text(data.documentNumber),
      nationality: text(data.nationality),
      issuingCountry: text(data.issuingCountry),
      dateOfBirth: day(data.dateOfBirth),
      expiryDate: day(data.expiryDate),
      address: text(data.address),
      legible: data.legible === true,
    },
  };
}

const FIELDS = ['idType', 'idNumber', 'nationality', 'dateOfBirth', 'idExpiry'] as const;

/**
 * The identity details of a guest profile, as form values and under the names
 * `PATCH /guests/:id` takes them. An empty string is "nothing".
 */
export type IdentityFields = Record<(typeof FIELDS)[number], string>;

/** The form as a reading fills it. Nothing here is saved until a person has checked it. */
export function fieldsFrom(capture: IdCapture): IdentityFields {
  return {
    idType: capture.documentType ?? '',
    idNumber: capture.documentNumber ?? '',
    nationality: capture.nationality ?? '',
    dateOfBirth: capture.dateOfBirth ?? '',
    idExpiry: capture.expiryDate ?? '',
  };
}

/** True when a reading has nothing in it that the profile keeps. */
export function nothingRead(capture: IdCapture): boolean {
  const fields = fieldsFrom(capture);
  return FIELDS.every((key) => fields[key] === '');
}

/** What must be put right before saving. `today` is `YYYY-MM-DD`. */
export function fieldProblems(fields: IdentityFields, today: string): Partial<IdentityFields> {
  const problems: Partial<IdentityFields> = {};
  const hasNumber = fields.idNumber.trim() !== '';
  // A number without its kind of document, or the kind without a number, tells nobody anything.
  if (hasNumber && fields.idType === '') {
    problems.idType = 'Choose what kind of document this is.';
  }
  if (!hasNumber && fields.idType !== '') {
    problems.idNumber = 'Type the number as it is printed on the document.';
  }
  if (fields.dateOfBirth !== '' && fields.dateOfBirth > today) {
    problems.dateOfBirth = 'This date is in the future. Check it against the document.';
  }
  return problems;
}

/** True when the document's last day of validity has passed. */
export function hasExpired(fields: IdentityFields, today: string): boolean {
  return fields.idExpiry !== '' && fields.idExpiry < today;
}

/**
 * The body for `PATCH /guests/:id`: only what is filled in, so that an empty field leaves
 * whatever the profile already holds.
 */
export function guestPatch(fields: IdentityFields): Partial<IdentityFields> {
  const patch: Partial<IdentityFields> = {};
  for (const key of FIELDS) {
    const value = fields[key].trim();
    if (value !== '') patch[key] = value;
  }
  return patch;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** `India` from `IN` or `in`. Null when the text is not a country code the browser knows. */
export function countryName(code: string): string | null {
  const wanted = code.trim().toUpperCase();
  // ZZ is the code for "unknown", which the browser would spell out as if it were a place.
  if (!/^[A-Z]{2}$/.test(wanted) || wanted === 'ZZ') return null;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    const name = regionNames?.of(wanted);
    // An unknown code comes back as the code itself.
    return name && name !== wanted ? name : null;
  } catch {
    return null;
  }
}
