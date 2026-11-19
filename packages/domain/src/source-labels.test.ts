import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNEL_NAMES, sourceName } from './source-labels';

describe('names of booking sites', () => {
  it('has a name for every code the three routes can give a booking', () => {
    // The codes live with the adapters, in another package that depends on this one, so
    // they are read from its source rather than imported.
    const root = new URL('../../channels/src/', import.meta.url);
    const sources = ['channex/mapping.ts', 'email/parse.ts', 'ical/feeds.ts']
      .map((file) => readFileSync(new URL(file, root), 'utf8'))
      .join('\n');
    const codes = new Set(
      [...sources.matchAll(/(?:code: |: )'([A-Z]{3})'/g)].map((match) => match[1]!),
    );
    expect(codes.size).toBeGreaterThan(12);
    // Two are not sites but ways in, shown by their own code.
    const unnamed = [...codes].filter(
      (code) => !CHANNEL_NAMES[code] && !['GDS', 'OPN'].includes(code),
    );
    expect(unnamed).toEqual([]);
  });

  it('names a site whatever the case of its code, and leaves an unknown code as it is', () => {
    expect(sourceName('bdc')).toBe('Booking.com');
    expect(sourceName('GIB')).toBe('Goibibo');
    expect(sourceName('GOI')).toBe('Goibibo');
    expect(sourceName('phone')).toBe('Phone');
    expect(sourceName('XYZ')).toBe('XYZ');
  });
});
