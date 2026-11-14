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

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Calls the API through the same-origin `/api` proxy. Failures become
 * `ApiError`s carrying the server's code and message, so callers can show the
 * message as-is.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      // Always send a JSON body on writes: the API rejects an empty one.
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(
      0,
      'network',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = (
      data as
        | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
        | undefined
    )?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'error',
      error?.message ?? `The server answered ${response.status}`,
      error?.details,
    );
  }
  return data as T;
}

/** SWR fetcher: the key is the API path. */
export const fetcher = <T>(path: string): Promise<T> => api<T>(path);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

/** Builds a query string, skipping empty values and joining arrays with commas. */
export function query(
  params: Record<string, string | number | boolean | string[] | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
