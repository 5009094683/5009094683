import type { RateSuggestion } from './types';

export interface SuggestionGroup {
  /** The rate plan: suggestions are made per plan per night. */
  ratePlanId: string;
  roomTypeId: string;
  roomTypeName: string;
  ratePlanName: string;
  /** Ordered by night. */
  suggestions: RateSuggestion[];
}

/** Suggestions by room type and rate plan, each group's nights in order. */
export function groupSuggestions(suggestions: RateSuggestion[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const suggestion of suggestions) {
    let group = groups.get(suggestion.ratePlanId);
    if (!group) {
      group = {
        ratePlanId: suggestion.ratePlanId,
        roomTypeId: suggestion.roomTypeId,
        roomTypeName: suggestion.roomTypeName,
        ratePlanName: suggestion.ratePlanName,
        suggestions: [],
      };
      groups.set(suggestion.ratePlanId, group);
    }
    group.suggestions.push(suggestion);
  }
  const list = [...groups.values()];
  for (const group of list) group.suggestions.sort((a, b) => a.date.localeCompare(b.date));
  return list.sort(
    (a, b) =>
      a.roomTypeName.localeCompare(b.roomTypeName) || a.ratePlanName.localeCompare(b.ratePlanName),
  );
}

const trimmed = (value: number): string => String(Number(value.toFixed(1)));

/** How far the suggested rate is from the current one, in percent: 12.5 or -8. */
export function changePercent(suggestion: RateSuggestion): number {
  if (suggestion.currentRate <= 0) return 0;
  const change =
    ((suggestion.recommendedRate - suggestion.currentRate) * 100) / suggestion.currentRate;
  return Number(change.toFixed(1));
}

/** `75%` from 7500 basis points. */
export function shareText(basisPoints: number): string {
  return `${Math.round(basisPoints / 100)}%`;
}

/** `+15%` or `-5%` from a driver's effect in basis points. */
export function effectText(basisPoints: number): string {
  return `${basisPoints > 0 ? '+' : ''}${trimmed(basisPoints / 100)}%`;
}
