/**
 * What the insight routes in `apps/api/src/routes/ai.ts` answer, as it arrives over JSON.
 * The web app does not depend on `@pms/ai`, so the shapes are written out here; each names
 * the backend type it mirrors and must follow it.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

/** Mirrors `ReservationRisk` in `packages/ai/src/insights.ts`. */
export interface ReservationRisk {
  reservationId: string;
  /** 1 to 95: how likely the booking is to be cancelled. */
  cancellation: number;
  /** 1 to 95: how likely the guest is not to turn up. */
  noShow: number;
  level: RiskLevel;
  /** The reasons, most telling first, in words. */
  factors: string[];
}

/** Mirrors an entry of what `arrivalsAtRisk` in `packages/ai/src/insights.ts` returns. */
export interface ArrivalRisk extends ReservationRisk {
  code: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  /** The booking site's code when there is one, else where the booking came from. */
  source: string;
}

/** Mirrors `Stay` in `packages/ai/src/insights.ts`: one room of a reservation that has no room yet. */
export interface RoomlessStay {
  roomId: string;
  reservationId: string;
  code: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
}

/** Mirrors `Assignment` in `packages/ai/src/insights.ts`. */
export interface SuggestedRoom extends RoomlessStay {
  unitId: string;
  unitName: string;
  /** Empty nights left between this stay and the one before it in the same room. */
  gapBefore: number | null;
}

/** Mirrors `AssignmentPlan` in `packages/ai/src/insights.ts`. */
export interface AssignmentPlan {
  roomTypeId: string;
  roomTypeName: string;
  assignments: SuggestedRoom[];
  /** Stays no room can take without moving someone already placed. */
  unplaced: RoomlessStay[];
}

/** Mirrors what `applyAssignments` in `packages/ai/src/insights.ts` returns. */
export interface AssignmentOutcome {
  applied: number;
  failed: { roomId: string; reason: string }[];
}

/** Mirrors `HousekeepingDay` in `packages/ai/src/insights.ts`. */
export interface HousekeepingDay {
  date: string;
  departures: number;
  stayovers: number;
  arrivals: number;
  minutes: number;
  /** Housekeepers needed, at seven working hours each. */
  staff: number;
}

/** Mirrors what `housekeepingForecast` in `packages/ai/src/insights.ts` returns. */
export interface HousekeepingForecast {
  days: HousekeepingDay[];
  busiest: string | null;
}

/** Mirrors `IdCapture` in `packages/ai/src/documents.ts`, the answer of `POST /reservations/:id/id-capture`. */
export interface IdCapture {
  documentType:
    'passport' | 'aadhaar' | 'driving_licence' | 'voter_id' | 'national_id' | 'other' | null;
  fullName: string | null;
  documentNumber: string | null;
  /** Two-letter country code. */
  nationality: string | null;
  issuingCountry: string | null;
  dateOfBirth: string | null;
  expiryDate: string | null;
  address: string | null;
  /** False when the photo was too poor to trust. */
  legible: boolean;
}
