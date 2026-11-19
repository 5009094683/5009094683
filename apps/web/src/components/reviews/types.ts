import type { queueReviewReply } from '@pms/channels';
import type { Serialized } from '@/lib/types';

/** A row of `reviews` (`ReviewRow` in `packages/ai/src/reviews.ts`), as `POST /reviews/:id/reply` answers. */
export type ReviewRow = Serialized<Awaited<ReturnType<typeof queueReviewReply>>>;

/** What `GET /reviews` lists: `listReviews` in `packages/ai/src/reviews.ts` adds the property's name. */
export type Review = ReviewRow & { propertyName: string };

export type Mood = NonNullable<Review['sentiment']>;

/**
 * Mirrors `ReviewInsights` in `packages/ai/src/reviews.ts`, the answer of `GET /reviews/insights`.
 * The web app does not depend on `@pms/ai`, so the shape is written out here and must follow it.
 */
export interface ReviewInsights {
  count: number;
  /** Out of 10, one decimal. Null when no review carried a score. */
  averageScore: number | null;
  sentiment: Record<Mood, number>;
  /** How many reviews wait for a reply. */
  unanswered: number;
  topics: { topic: string; positive: number; negative: number; neutral: number }[];
  byChannel: { channelCode: string | null; count: number; averageScore: number | null }[];
  /** Month by month (`2026-11`), oldest first. */
  trend: { month: string; count: number; averageScore: number | null }[];
}

/** Mirrors what `draftReviewReply` in `packages/ai/src/reviews.ts` returns. */
export interface DraftReply {
  draft: string;
  /** `rules` when a standard wording was used because no AI service is configured. */
  source: 'llm' | 'rules';
}
