import type { Property } from '@/lib/types';

/**
 * What the pricing routes in `apps/api/src/routes/ai.ts` answer, as it arrives over JSON. The
 * web app does not depend on `@pms/ai`, so the shapes are written out here; each names the
 * backend type it mirrors and must follow it.
 */

/** Mirrors `RecommendationDriver` in `packages/db/src/schema/ai.ts`. */
export interface SuggestionDriver {
  /** Why, in words. */
  label: string;
  /** What it does to the rate against the plan's base rate, in basis points: 1000 is +10%. */
  effectBp: number;
}

export type SuggestionConfidence = 'low' | 'medium' | 'high';

/** Mirrors `RecommendationView` in `packages/ai/src/pricing.ts`: a `rate_recommendations` row with names. */
export interface RateSuggestion {
  id: string;
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  currentRate: number;
  recommendedRate: number;
  /** Share of rooms sold now, and the share expected by the night itself, in basis points. */
  occupancyBp: number;
  forecastBp: number;
  drivers: SuggestionDriver[];
  /** How much booking history there was to go on. */
  confidence: SuggestionConfidence;
  status: 'pending' | 'applied' | 'dismissed' | 'superseded';
  appliedVia: 'manual' | 'autopilot' | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  roomTypeName: string;
  ratePlanName: string;
  currency: string;
}

/** Mirrors `PricingRun` in `packages/ai/src/pricing.ts`. */
export interface PricingRun {
  propertyId: string;
  created: number;
  /** Applied straight away for room types on autopilot. */
  autoApplied: number;
  /** Withdrawn because the picture changed. */
  superseded: number;
}

/** The part of a property's settings that steers suggestions (`PropertySettings` in `packages/db`). */
export type PricingSettings = Pick<
  Property['settings'],
  'pricingAutopilotRoomTypes' | 'pricingMaxChangePercent' | 'pricingRounding' | 'pricingEvents'
>;

export type PricingEvent = NonNullable<PricingSettings['pricingEvents']>[number];

/** What the suggestions use when a property has not chosen: see `packages/ai/src/pricing.ts`. */
export const PRICING_DEFAULTS = {
  maxChangePercent: 40,
  /** In minor units: fifty rupees. */
  rounding: 5000,
  eventUpliftPercent: 15,
} as const;
