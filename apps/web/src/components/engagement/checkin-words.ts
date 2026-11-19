import { formatDateTime } from '@/lib/format';
import type { Checkin, CheckinPerson } from './types';

type Status = Checkin['status'];

export const CHECKIN_LABELS: Record<Status, string> = {
  not_started: 'Not started',
  started: 'Started, not sent in',
  submitted: 'Waiting to be checked',
  verified: 'Checked',
};

export const CHECKIN_TONES: Record<Status, 'neutral' | 'warning' | 'success'> = {
  not_started: 'neutral',
  started: 'neutral',
  submitted: 'warning',
  verified: 'success',
};

/** When the guest sent the details in and when the front desk checked them. */
export function checkinTimes(checkin: Checkin, checkedBy?: string | null): string | null {
  const parts: string[] = [];
  if (checkin.submittedAt) parts.push(`Sent in ${formatDateTime(checkin.submittedAt)}`);
  if (checkin.verifiedAt) {
    parts.push(
      `checked ${formatDateTime(checkin.verifiedAt)}${checkedBy ? ` by ${checkedBy}` : ''}`,
    );
  }
  if (parts.length === 0) return null;
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ID_TYPE_LABELS: Record<NonNullable<CheckinPerson['idType']>, string> = {
  passport: 'Passport',
  aadhaar: 'Aadhaar card',
  driving_licence: 'Driving licence',
  voter_id: 'Voter ID card',
  national_id: 'National identity card',
  other: 'Other document',
};

export function idTypeLabel(type: CheckinPerson['idType']): string | null {
  return type ? (ID_TYPE_LABELS[type] ?? type) : null;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** `India` from `IN`. The code itself when the browser has no name for it. */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** `245 KB`, `1.2 MB` */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
