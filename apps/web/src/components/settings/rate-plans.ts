import { formatMoney, plural } from '@/lib/format';
import type { RatePlan } from '@/lib/types';

/**
 * What a plan that follows another charges for a parent rate. Mirrors the
 * API's own rule so the amounts shown here match the ones it sells at.
 */
export function deriveRate(parentRate: number, percentBp: number, amount: number): number {
  return Math.max(0, Math.round((parentRate * (10_000 + percentBp)) / 10_000) + amount);
}

/**
 * The plan's nightly rate on a day without its own rate: its base rate, or
 * for a plan that follows another, that plan's rate with the adjustment.
 */
export function defaultNightlyRate(
  plan: RatePlan,
  plansById: ReadonlyMap<string, RatePlan>,
  depth = 0,
): number {
  const parent = plan.parentRatePlanId ? plansById.get(plan.parentRatePlanId) : undefined;
  // The depth limit matches the API's and stops a loop in bad data from hanging the page.
  if (!parent || depth >= 10) return plan.baseRate;
  return deriveRate(
    defaultNightlyRate(parent, plansById, depth + 1),
    plan.derivedPercentBp,
    plan.derivedAmount,
  );
}

/** `−10%`, `+₹500`, `−10% +₹500`, or nothing when the plan charges exactly what its parent does. */
export function adjustmentText(percentBp: number, amount: number, currency: string): string {
  const signed = (value: number, text: string) => `${value > 0 ? '+' : '−'}${text}`;
  return [
    percentBp !== 0 && signed(percentBp, `${Math.abs(percentBp) / 100}%`),
    amount !== 0 && signed(amount, formatMoney(Math.abs(amount), currency)),
  ]
    .filter(Boolean)
    .join(' ');
}

/** One line on what cancelling costs, or nothing when the plan has no policy. */
export function cancellationSummary(policy: RatePlan['cancellationPolicy']): string {
  if (policy.nonRefundable) return 'Non-refundable';
  const charge =
    policy.penalty === 'first_night'
      ? 'the first night'
      : policy.penalty === 'full'
        ? 'the full stay'
        : policy.penalty === 'percent'
          ? `${policy.penaltyPercent ?? 0}% of the stay`
          : null;
  if (policy.freeCancelDays === undefined) return charge ? `Cancelling costs ${charge}` : '';
  const until =
    policy.freeCancelDays === 0
      ? 'Free cancellation until the day of arrival'
      : `Free cancellation until ${plural(policy.freeCancelDays, 'day')} before arrival`;
  return charge ? `${until}, then ${charge}` : until;
}

/** Ids of the plans whose prices follow `planId`, directly or through other plans. */
export function followerIds(planId: string, plans: RatePlan[]): Set<string> {
  const found = new Set<string>();
  let frontier = [planId];
  while (frontier.length > 0) {
    const next = plans.filter(
      (plan) =>
        plan.parentRatePlanId !== null &&
        frontier.includes(plan.parentRatePlanId) &&
        !found.has(plan.id),
    );
    for (const plan of next) found.add(plan.id);
    frontier = next.map((plan) => plan.id);
  }
  return found;
}
