import { ApiError, errorMessage } from '@/lib/api';

/** True when the server asked for fewer requests. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * The server's own message, except when it asks for fewer requests: that is a matter of
 * waiting rather than a fault, and "Rate limit exceeded" reads like one.
 */
export function calmErrorMessage(err: unknown): string {
  if (isRateLimited(err)) {
    return 'That is a lot of requests in a short time. Wait a minute, then try again.';
  }
  return errorMessage(err);
}

/** True when the request never got as far as a decision, so asking again can work. */
export function isTransient(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500);
}
