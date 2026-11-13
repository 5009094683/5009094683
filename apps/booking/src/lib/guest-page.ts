import 'server-only';
import { notFound } from 'next/navigation';
import { ApiError, isDeadLink } from './api-error';

/** Stands for an answer the API would not give because it had been asked too often. */
export const BUSY: unique symbol = Symbol('busy');

/**
 * Waits for what a page opened with a guest's booking link needs from the API.
 * A link the API does not know ends in the "this link does not work any more"
 * page. Being asked too often comes back as `BUSY`, for the page to say so
 * calmly rather than fail. Anything else is a fault, and is thrown.
 */
export async function forGuestPage<T>(reading: Promise<T>): Promise<T | typeof BUSY> {
  try {
    return await reading;
  } catch (err) {
    if (isDeadLink(err)) notFound();
    if (err instanceof ApiError && err.status === 429) return BUSY;
    throw err;
  }
}

/**
 * The same wait, for the title of such a page: a link the API does not know takes the title
 * of the page that says so. Any other fault is left to the page itself, which asks for the
 * same thing and shows what went wrong. Thrown from here as well, it would leave that page
 * without a title, and a browser then shows the address, the guest's link with it, instead.
 */
export async function forGuestTitle(reading: Promise<unknown>): Promise<void> {
  try {
    await reading;
  } catch (err) {
    if (isDeadLink(err)) notFound();
  }
}
