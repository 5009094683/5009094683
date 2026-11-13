import { hasAdapter, registerAdapter } from './adapter';
import { channexAdapter } from './channex/adapter';
import { icalAdapter } from './ical/adapter';

/**
 * Makes the built-in routes available to the engine. Called at start-up by
 * every process that touches connections (the API and the worker). A kind
 * that already has an adapter (a test double, say) keeps it.
 */
export function registerDefaultAdapters(): void {
  if (!hasAdapter('channex')) registerAdapter('channex', channexAdapter);
  if (!hasAdapter('ical')) registerAdapter('ical', icalAdapter);
}
