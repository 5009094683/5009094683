import demoSettings from '../config/business.demo';
import { type Business, type BusinessInput, parseBusiness } from '../src/business/schema';
import { Store } from '../src/store';

/** The sample settings, with changes laid over them when a test needs other values. */
export function demoBusiness(change?: (settings: BusinessInput) => void): Business {
  const settings = structuredClone(demoSettings);
  change?.(settings);
  return parseBusiness(settings);
}

export function memoryStore(): Store {
  return Store.open(':memory:');
}

/** A clock the test moves by hand. Starts on Sunday 15 November 2026, 09:00 in Vietnam. */
export class TestClock {
  ms = Date.parse('2026-11-15T02:00:00Z');
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const TODAY = '2026-11-15';
