import { readResponse, unreachable } from './api-error';

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api/public${path}`, { cache: 'no-store', ...init });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw unreachable();
  }
}

/**
 * Calls the API's public routes from the browser, through this site's own
 * `/api/public` proxy so that no request leaves the origin. Failures are
 * thrown as `ApiError`s carrying the server's code and message.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const response = await send(path, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    // The API refuses a JSON request without a body, so a bare POST sends an empty object.
    body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
    signal: options.signal,
  });
  return readResponse<T>(response);
}

/** Sends a file as the request body itself, the way the document upload route takes it. */
export async function upload<T>(path: string, file: File): Promise<T> {
  const response = await send(path, {
    method: 'POST',
    headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  return readResponse<T>(response);
}

export const bookingPath = (token: string, rest = ''): string =>
  `/bookings/${encodeURIComponent(token)}${rest}`;
