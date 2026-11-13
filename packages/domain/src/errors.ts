export type DomainErrorCode =
  | 'validation'
  | 'not_found'
  | 'forbidden'
  | 'unauthenticated'
  | 'conflict'
  | 'no_availability'
  | 'unit_occupied'
  | 'restriction_violated'
  | 'stale_version'
  | 'invalid_state'
  | 'rate_limited'
  /** A guest already holds as many unpaid bookings as one guest may. */
  | 'too_many_holds'
  | 'upstream_failed'
  | 'not_configured';

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  validation: 400,
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  conflict: 409,
  no_availability: 409,
  unit_occupied: 409,
  restriction_violated: 409,
  stale_version: 409,
  invalid_state: 409,
  rate_limited: 429,
  too_many_holds: 429,
  upstream_failed: 502,
  not_configured: 503,
};

/** A failure the caller can act on. Anything else is a bug or an outage. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export const validationError = (message: string, details?: Record<string, unknown>) =>
  new DomainError('validation', message, details);

export const notFound = (what: string, id?: string) =>
  new DomainError('not_found', id ? `${what} ${id} was not found` : `${what} was not found`);

export const forbidden = (message = 'You do not have permission to do this') =>
  new DomainError('forbidden', message);

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new DomainError('conflict', message, details);

export const invalidState = (message: string, details?: Record<string, unknown>) =>
  new DomainError('invalid_state', message, details);

export function isDomainError(err: unknown, code?: DomainErrorCode): err is DomainError {
  return err instanceof DomainError && (code === undefined || err.code === code);
}
