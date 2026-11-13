import { CHANNEL_NAMES } from '@/lib/format';
import type { Mood } from './types';

export const MOODS: Mood[] = ['positive', 'neutral', 'negative'];

export const MOOD_LABELS: Record<Mood, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
};

export const MOOD_TONES: Record<Mood, 'success' | 'neutral' | 'danger'> = {
  positive: 'success',
  neutral: 'neutral',
  negative: 'danger',
};

/** What a subject is called when a guest spoke of it in this mood. */
export const MENTION_LABELS: Record<Mood, string> = {
  positive: 'Praised',
  negative: 'Criticised',
  neutral: 'Mentioned',
};

const TOPIC_LABELS: Record<string, string> = {
  cleanliness: 'Cleanliness',
  staff: 'Staff',
  location: 'Location',
  room: 'Room',
  food: 'Food',
  value: 'Value for money',
  facilities: 'Facilities',
  'check-in': 'Check-in',
  noise: 'Noise',
  wifi: 'Wi-Fi',
};

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** The subjects come from a fixed list on the server; one it adds later still reads as a word. */
export function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? capitalised(topic.replace(/[-_]+/g, ' '));
}

/** Booking sites name their score categories in their own way. */
const CATEGORY_LABELS: Record<string, string> = {
  clean: 'Cleanliness',
  cleanliness: 'Cleanliness',
  staff: 'Staff',
  communication: 'Communication',
  location: 'Location',
  comfort: 'Comfort',
  value: 'Value for money',
  facilities: 'Facilities',
  checkin: 'Check-in',
  accuracy: 'Accuracy',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category.toLowerCase()] ?? capitalised(category.replace(/[-_]+/g, ' '));
}

export function siteName(channelCode: string | null): string {
  if (!channelCode) return 'Booking site not named';
  return CHANNEL_NAMES[channelCode.toUpperCase()] ?? channelCode;
}

/** A score out of 10 with at most one decimal: `8`, `8.5`. */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** Reviews are stored out of 100 and read out of 10. */
export const scoreOutOfTen = (overallScore: number): string => formatScore(overallScore / 10);

const day = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const month = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * `14 Nov 2026`. In UTC, as the server's date filter and its months are, so that a review
 * never shows a day under which the date range would not find it.
 */
export const formatReviewDay = (timestamp: string): string => day.format(new Date(timestamp));

/** `Nov 2026` from `2026-11`. */
export const formatReviewMonth = (yearMonth: string): string =>
  month.format(new Date(`${yearMonth}-01T00:00:00Z`));
