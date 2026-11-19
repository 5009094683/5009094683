import { ApiError } from '@/lib/api';
import type { Statement } from './types';

/**
 * Saves a statement as the spreadsheet file the server makes of it. `path` is
 * the statement's address in the API, which differs for staff and for owners.
 */
export async function downloadStatement(path: string, statement: Statement): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}?format=csv`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Check your connection and try again.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiError(
      response.status,
      'error',
      body?.error?.message ?? `The server answered ${response.status}.`,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `owner-statement-${statement.periodStart.slice(0, 7)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
