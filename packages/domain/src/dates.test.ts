import { describe, expect, it } from 'vitest';
import {
  addDays,
  datesToRanges,
  dayOfWeek,
  diffDays,
  eachDate,
  isValidDate,
  mergeRanges,
  parseDateRangeLiteral,
  timeIn,
  toDateRangeLiteral,
  todayIn,
} from './dates';

describe('date helpers', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is unaffected by daylight-saving transitions', () => {
    // US and EU clocks change on these nights; calendar arithmetic must not lose a day.
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('counts nights between dates', () => {
    expect(diffDays('2026-12-12', '2026-12-15')).toBe(3);
    expect(diffDays('2026-12-15', '2026-12-12')).toBe(-3);
  });

  it('lists the nights of a stay, excluding the departure date', () => {
    expect(eachDate('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ]);
    expect(eachDate('2026-12-30', '2026-12-30')).toEqual([]);
  });

  it('rejects impossible dates', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('26-01-01')).toBe(false);
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(() => addDays('2026-02-30', 1)).toThrow(/Invalid date/);
  });

  it('knows the day of the week', () => {
    expect(dayOfWeek('2026-11-13')).toBe(5); // a Friday
    expect(dayOfWeek('2026-11-15')).toBe(0);
  });

  it('gives the calendar date and time in a property time zone', () => {
    const instant = new Date('2026-11-13T20:00:00Z');
    expect(todayIn('Asia/Kolkata', instant)).toBe('2026-11-14'); // 01:30 next day in India
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-11-13');
    expect(timeIn('Asia/Kolkata', instant)).toEqual({ hour: 1, minute: 30 });
  });

  it('merges overlapping and touching ranges', () => {
    expect(
      mergeRanges([
        { from: '2026-01-10', to: '2026-01-12' },
        { from: '2026-01-01', to: '2026-01-03' },
        { from: '2026-01-03', to: '2026-01-05' },
        { from: '2026-01-11', to: '2026-01-15' },
      ]),
    ).toEqual([
      { from: '2026-01-01', to: '2026-01-05' },
      { from: '2026-01-10', to: '2026-01-15' },
    ]);
  });

  it('groups dates into consecutive ranges', () => {
    expect(
      datesToRanges(['2026-01-03', '2026-01-01', '2026-01-02', '2026-01-07', '2026-01-02']),
    ).toEqual([
      { from: '2026-01-01', to: '2026-01-04' },
      { from: '2026-01-07', to: '2026-01-08' },
    ]);
    expect(datesToRanges([])).toEqual([]);
  });

  it('round-trips PostgreSQL daterange literals', () => {
    const literal = toDateRangeLiteral({ from: '2026-12-12', to: '2026-12-15' });
    expect(literal).toBe('[2026-12-12,2026-12-15)');
    expect(parseDateRangeLiteral(literal)).toEqual({ from: '2026-12-12', to: '2026-12-15' });
  });
});
