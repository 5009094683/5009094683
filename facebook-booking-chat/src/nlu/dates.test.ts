import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  formatDate,
  parseBareDay,
  parseDates,
  todayIn,
  weekdayOf,
} from './dates';

// A Sunday.
const TODAY = '2026-11-15';

describe('date arithmetic', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('counts days between two dates', () => {
    expect(diffDays('2026-11-20', '2026-11-22')).toBe(2);
    expect(diffDays('2026-11-22', '2026-11-20')).toBe(-2);
  });

  it('knows the weekday', () => {
    expect(weekdayOf(TODAY)).toBe(0);
    expect(weekdayOf('2026-11-20')).toBe(5);
  });

  it('takes today from the time zone, not from the server clock', () => {
    // 18:30 UTC on the 14th is already 01:30 on the 15th in Vietnam.
    const now = new Date('2026-11-14T18:30:00Z');
    expect(todayIn('Asia/Ho_Chi_Minh', now)).toBe('2026-11-15');
    expect(todayIn('UTC', now)).toBe('2026-11-14');
  });
});

describe('parseDates: single dates', () => {
  const cases: Array<[string, string]> = [
    ['20/11', '2026-11-20'],
    ['on 20/11/2026 please', '2026-11-20'],
    ['20.11.2026', '2026-11-20'],
    ['20-11-2026', '2026-11-20'],
    ['20/11/26', '2026-11-20'],
    ['20.11', '2026-11-20'],
    ['20 Nov', '2026-11-20'],
    ['20th of November', '2026-11-20'],
    ['Nov 20', '2026-11-20'],
    ['November 20th, 2026', '2026-11-20'],
    ['I arrive on 3 December', '2026-12-03'],
    ['ngày 20 tháng 11', '2026-11-20'],
    ['ngay 20 thang 11 nam 2026', '2026-11-20'],
    ['20 thg 11', '2026-11-20'],
    ['ngày 20/11', '2026-11-20'],
    ['today', '2026-11-15'],
    ['hôm nay', '2026-11-15'],
    ['tomorrow morning', '2026-11-16'],
    ['ngày mai', '2026-11-16'],
    ['sáng mai', '2026-11-16'],
    ['mai', '2026-11-16'],
    ['mai em nhận xe được không', '2026-11-16'],
    ['day after tomorrow', '2026-11-17'],
    ['ngày kia', '2026-11-17'],
    ['Saturday', '2026-11-21'],
    ['this Friday', '2026-11-20'],
    ['thứ 7', '2026-11-21'],
    ['thứ bảy tuần sau', '2026-11-21'],
    ['chủ nhật', '2026-11-22'],
    ['ngày 20', '2026-11-20'],
    ['mùng 5', '2026-12-05'],
    ['we arrive on the 20th', '2026-11-20'],
  ];
  it.each(cases)('%s', (text, start) => {
    expect(parseDates(text, TODAY).start).toBe(start);
  });

  it('reads day before month, and swaps only when that is no date', () => {
    expect(parseDates('5/12', TODAY).start).toBe('2026-12-05');
    expect(parseDates('11/20', TODAY).start).toBe('2026-11-20');
  });

  it('takes the next time a date comes round when no year is given', () => {
    expect(parseDates('3/1', TODAY).start).toBe('2027-01-03');
    expect(parseDates('10 Nov', TODAY).start).toBe('2027-11-10');
    expect(parseDates('15/11', TODAY).start).toBe('2026-11-15');
  });

  it('keeps a past date that carries its year, for the caller to refuse', () => {
    expect(parseDates('20/10/2026', TODAY).start).toBe('2026-10-20');
  });

  it('refuses dates that do not exist', () => {
    expect(parseDates('31/02', TODAY).start).toBeUndefined();
    expect(parseDates('45/13', TODAY).start).toBeUndefined();
  });

  it('prefers the date to the weekday named with it', () => {
    expect(parseDates('Saturday 28 Nov', TODAY)).toEqual({ start: '2026-11-28' });
    expect(parseDates('thứ hai ngày 23/11', TODAY)).toEqual({ start: '2026-11-23' });
  });

  it('takes "Monday next week" from the week after this one', () => {
    // Today is Sunday the 15th: the coming Monday is the 16th, and it is also next week's.
    expect(parseDates('Monday next week', TODAY).start).toBe('2026-11-16');
    // From Wednesday the 18th, "Friday next week" is the 27th, not the 20th.
    expect(parseDates('Friday next week', '2026-11-18').start).toBe('2026-11-27');
    expect(parseDates('thứ 6 tuần sau', '2026-11-18').start).toBe('2026-11-27');
  });
});

describe('parseDates: ranges', () => {
  const range = { start: '2026-11-20', end: '2026-11-22', days: 3 };
  const cases: string[] = [
    '20-22/11',
    '20 - 22/11/2026',
    '20–22/11',
    'from 20/11 to 22/11',
    '20/11 - 22/11',
    '20/11/2026 to 22/11/2026',
    '20 to 22 Nov',
    '20-22 November 2026',
    'from the 20th to the 22nd of November',
    'Nov 20-22',
    'November 20 to 22',
    '20 Nov to 22 Nov',
    'từ 20 đến 22/11',
    'từ ngày 20 đến ngày 22 tháng 11',
    '20 đến 22 tháng 11',
    'từ 20/11 đến 22/11',
  ];
  it.each(cases)('%s', (text) => {
    expect(parseDates(text, TODAY)).toEqual(range);
  });

  it('crosses the end of a month and of a year', () => {
    expect(parseDates('29/11 - 2/12', TODAY)).toEqual({
      start: '2026-11-29',
      end: '2026-12-02',
      days: 4,
    });
    expect(parseDates('30/12 to 2/1', TODAY)).toEqual({
      start: '2026-12-30',
      end: '2027-01-02',
      days: 4,
    });
  });

  it('reads "from tomorrow to 18/11"', () => {
    expect(parseDates('from tomorrow to 18/11', TODAY)).toEqual({
      start: '2026-11-16',
      end: '2026-11-18',
      days: 3,
    });
  });

  it('counts the days of the range over a day count that disagrees', () => {
    expect(parseDates('20-22/11, 2 days', TODAY).days).toBe(3);
  });
});

describe('parseDates: lengths', () => {
  const cases: Array<[string, number]> = [
    ['3 days', 3],
    ['for 3 days', 3],
    ['1 day', 1],
    ['two days', 2],
    ['3-day rental', 3],
    ['3 ngày', 3],
    ['ba ngày', 3],
    ['thuê 2 ngày', 2],
    ['2 nights', 3],
    ['3 days 2 nights', 3],
    ['3 ngày 2 đêm', 3],
    ['3d2n', 3],
    ['a week', 7],
    ['2 weeks', 14],
    ['1 tuần', 7],
    ['for a day', 1],
    ['half day', 1],
  ];
  it.each(cases)('%s', (text, days) => {
    expect(parseDates(text, TODAY)).toEqual({ days });
  });

  it('reads a date and a length together', () => {
    expect(parseDates('3 days from 20/11', TODAY)).toEqual({ start: '2026-11-20', days: 3 });
    expect(parseDates('thuê 3 ngày từ ngày 20/11', TODAY)).toEqual({
      start: '2026-11-20',
      days: 3,
    });
    expect(parseDates('tomorrow for 2 days', TODAY)).toEqual({ start: '2026-11-16', days: 2 });
    expect(parseDates('thứ 7 tuần sau, 2 ngày', '2026-11-18')).toEqual({
      start: '2026-11-28',
      days: 2,
    });
  });
});

describe('parseDates: things that are not dates', () => {
  const cases: string[] = [
    'how much is a scooter a day?',
    'price per day',
    '2 people',
    '2-3 people',
    'are you open 24/7?',
    'it costs 1.5 million',
    'may I book 2 bikes?',
    'my number is 0914 674 724',
    'call +84 352 476 994',
    'my name is Mai',
    'the 2nd bike is for my friend',
    'Thu Hien',
    'we are 4',
    'hello',
  ];
  it.each(cases)('%s', (text) => {
    expect(parseDates(text, TODAY)).toEqual({});
  });
});

describe('parseBareDay', () => {
  it('reads a lone day number as the next such day', () => {
    expect(parseBareDay('20', TODAY)).toBe('2026-11-20');
    expect(parseBareDay('the 20th', TODAY)).toBe('2026-11-20');
    expect(parseBareDay('5', TODAY)).toBe('2026-12-05');
    expect(parseBareDay('ngày 20', TODAY)).toBe('2026-11-20');
    expect(parseBareDay('31', '2027-01-31')).toBe('2027-01-31');
  });

  it('ignores anything else', () => {
    expect(parseBareDay('20 people', TODAY)).toBeUndefined();
    expect(parseBareDay('45', TODAY)).toBeUndefined();
    expect(parseBareDay('hello', TODAY)).toBeUndefined();
  });
});

describe('formatDate', () => {
  it('writes the date out in each language', () => {
    expect(formatDate('2026-11-20', 'en')).toBe('Fri 20 Nov 2026');
    expect(formatDate('2026-11-20', 'vi')).toBe('Thứ sáu, 20/11/2026');
    expect(formatDate('2026-12-05', 'vi')).toBe('Thứ bảy, 05/12/2026');
  });
});
