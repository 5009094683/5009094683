/** A failed API call, carrying the server's own code and message so pages can show the message as it is. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

const OUR_FAULT = 'Something went wrong on our side. Please try again in a moment.';

/** Reads a response: the parsed body when it succeeded, an `ApiError` thrown when it did not. */
export async function readResponse<T>(response: Response): Promise<T> {
  const text = response.status === 204 ? '' : await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = (data as ErrorBody | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'error',
      error?.message ?? OUR_FAULT,
      error?.details,
    );
  }
  return data as T;
}

export function unreachable(): ApiError {
  return new ApiError(
    0,
    'network',
    'We could not reach the server. Check your connection and try again.',
  );
}

export interface FieldIssue {
  /** Where in the request the problem is, such as `guest.email`. */
  path: string;
  message: string;
}

/** The fields the server's request schema refused, when that is why a call failed. */
export function fieldIssues(err: unknown): FieldIssue[] {
  if (!(err instanceof ApiError)) return [];
  const issues = err.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is FieldIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as FieldIssue).path === 'string' &&
      typeof (issue as FieldIssue).message === 'string',
  );
}

/** The rate limiter answers in its own words; guests get ours. */
const LIMITER_MESSAGE = /^rate limit exceeded/i;

/**
 * What to tell the guest about a failure. The server's sentences for things a
 * guest can act on are written for guests and shown as they are; schema
 * refusals and server faults are not, and get a plain sentence instead.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (err.status === 429 && LIMITER_MESSAGE.test(err.message)) {
    return 'That was a lot of tries in a short time. Please wait a minute and try again.';
  }
  if (err.status >= 500) return OUR_FAULT;
  if (fieldIssues(err).length > 0 || err.code === 'bad_request' || err.code === 'error') {
    return 'Some of these details could not be accepted. Please check them and try again.';
  }
  return err.message;
}

/** A guest link the server does not recognise: wrong, revoked, expired, or not a link at all. */
export function isDeadLink(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.code === 'validation');
}
