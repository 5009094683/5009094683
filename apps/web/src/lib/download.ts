import { ApiError } from './api';

/**
 * Saves a file the API makes (a spreadsheet of a report or a register). The name is the one
 * the server gives it. A refusal is thrown as an `ApiError` with the server's own words, so
 * that the screen can show it; a plain link would open the refusal as a page of its own.
 */
export async function downloadFromApi(path: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'error',
      body?.error?.message ?? `The server answered ${response.status}.`,
    );
  }
  const named = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = named?.[1] ?? 'download.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
