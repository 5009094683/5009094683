import { describe, expect, it } from 'vitest';
import demoSettings from '../../config/business.demo';
import companySettings from '../../config/business';
import { parseBusiness } from '../business/schema';
import { matchOption, matchService } from './catalog';
import { detectIntents, isAbort, isNo, isSkip, isYes } from './intents';
import { findBikes, findPeople, findPhone, parseCount, parseName } from './numbers';
import { detectLanguage, fold, hasPhrase } from './text';

const demo = parseBusiness(demoSettings);
const company = parseBusiness(companySettings);

describe('fold', () => {
  it('drops Vietnamese marks, case and extra spaces', () => {
    expect(fold('  Thuê  XE MÁY  ')).toBe('thue xe may');
    expect(fold('Đặt tour Bản Giốc')).toBe('dat tour ban gioc');
    expect(fold('20–22/11')).toBe('20-22/11');
  });
});

describe('hasPhrase', () => {
  it('matches whole words only', () => {
    expect(hasPhrase('gia bao nhieu', 'gia')).toBe(true);
    expect(hasPhrase('giao xe', 'gia')).toBe(false);
    expect(hasPhrase('on facebook', 'book')).toBe(false);
    expect(hasPhrase('book now', 'book')).toBe(true);
  });
});

describe('detectLanguage', () => {
  const cases: Array<[string, 'en' | 'vi' | null]> = [
    ['Hello, how much is a motorbike?', 'en'],
    ['Xin chào, cho mình hỏi giá thuê xe', 'vi'],
    ['xin chao shop', 'vi'],
    ['thue xe bao nhieu 1 ngay', 'vi'],
    ['gia?', 'vi'],
    ['price?', 'en'],
    ['I want to book a tour', 'en'],
    ['20/11', null],
    ['2', null],
    ['John Smith', null],
    ['Nguyễn Văn An', 'vi'],
    ['ok', null],
    ['Café près de la gare', null],
  ];
  it.each(cases)('%s', (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });
});

describe('people and motorbikes', () => {
  const people: Array<[string, number | undefined]> = [
    ['2 people', 2],
    ['we are 3', 3],
    ['we are three', 3],
    ['a tour for 2 on 20/11', 2],
    ['for 2 days', undefined],
    ['4 pax', 4],
    ['2 adults', 2],
    ['just me', 1],
    ['mot minh', 1],
    ['we are a couple', 2],
    ['a couple of days', undefined],
    ['me and my wife', 2],
    ['2 nguoi', 2],
    ['hai nguoi', 2],
    ['hai vo chong', 2],
    ['gia dinh 4 nguoi', 4],
    ['3 days', undefined],
    ['20/11', undefined],
    ['for 150k', undefined],
  ];
  it.each(people)('people in "%s"', (text, n) => {
    expect(findPeople(fold(text))).toBe(n);
  });

  const bikes: Array<[string, number | undefined]> = [
    ['2 bikes', 2],
    ['rent a motorbike', 1],
    ['two scooters', 2],
    ['3 motorbikes for 2 days', 3],
    ['thue 2 xe may', 2],
    ['hai xe', 2],
    ['1 chiec', 1],
    ['thue xe 2 ngay', undefined],
    ['2 people', undefined],
  ];
  it.each(bikes)('motorbikes in "%s"', (text, n) => {
    expect(findBikes(fold(text))).toBe(n);
  });

  it('reads a bare count given in answer to "how many?"', () => {
    expect(parseCount('2')).toBe(2);
    expect(parseCount('Two.')).toBe(2);
    expect(parseCount('hai')).toBe(2);
    expect(parseCount('just 1')).toBe(1);
    expect(parseCount('3 people')).toBe(3);
    expect(parseCount('2 xe')).toBe(2);
    expect(parseCount('just me')).toBe(1);
    expect(parseCount('20/11')).toBeUndefined();
    expect(parseCount('hello')).toBeUndefined();
  });
});

describe('findPhone', () => {
  const found: Array<[string, string]> = [
    ['my number is 0914 674 724', '0914 674 724'],
    ['WhatsApp +84 352 476 994 please', '+84 352 476 994'],
    ['+(84) 0352 476 994', '+(84) 0352 476 994'],
    ['call 0914.674.724', '0914.674.724'],
    ['+44 7700 900123', '+44 7700 900123'],
    ['0352476994', '0352476994'],
  ];
  it.each(found)('%s', (text, phone) => {
    expect(findPhone(text)).toBe(phone);
  });

  const none = [
    '20.11.2026',
    '20/11/2026 - 22/11/2026',
    '2 people for 3 days',
    '1 200 000 VND',
    '150000',
  ];
  it.each(none)('none in "%s"', (text) => {
    expect(findPhone(text)).toBeUndefined();
  });

  it('takes a shorter number when the question was "your phone number?"', () => {
    expect(findPhone('555 0199', true)).toBe('555 0199');
    expect(findPhone('555 0199')).toBeUndefined();
  });
});

describe('parseName', () => {
  const names: Array<[string, string | undefined]> = [
    ['John Smith', 'John Smith'],
    ['my name is John Smith.', 'John Smith'],
    ["I'm Anna", 'Anna'],
    ['Tên tôi là Nguyễn Văn An', 'Nguyễn Văn An'],
    ['em tên là Lan', 'Lan'],
    ['toi la Minh', 'Minh'],
    ["Sean O'Brien", "Sean O'Brien"],
    ['Jean-Luc Picard', 'Jean-Luc Picard'],
    ['0914 674 724', undefined],
    ['what is the price?', undefined],
    ['x', undefined],
  ];
  it.each(names)('%s', (text, name) => {
    expect(parseName(text)).toBe(name);
  });
});

describe('detectIntents', () => {
  const cases: Array<[string, string[]]> = [
    ['Hi!', ['greeting']],
    ['xin chào shop', ['greeting']],
    ['How much is a scooter per day?', ['price']],
    ['giá thuê xe bao nhiêu?', ['price']],
    ['gia đình mình 4 người', []],
    ['I want to book a tour', ['book']],
    ['mình muốn thuê xe', ['book']],
    ['what is included?', ['included']],
    ['do I need to pay a deposit?', ['payment']],
    ['có cần đặt cọc không', ['payment']],
    ['what if I cancel? is it refundable', ['cancel_policy']],
    ['I need to cancel my booking', ['cancel_booking']],
    ['mình muốn huỷ đơn', ['cancel_booking']],
    ['can I change the date of my booking', ['change_booking']],
    ['is my booking confirmed yet?', ['status']],
    ['do I need a driving licence?', ['documents']],
    ['where are you located?', ['location']],
    ['địa chỉ ở đâu', ['location']],
    ['can I talk to a real person', ['human']],
    ['cho mình gặp nhân viên', ['human']],
    ['thanks a lot', ['thanks']],
    ['cảm ơn shop', ['thanks']],
    ['found you on facebook', []],
    ['20/11 for 2 people', []],
  ];
  it.each(cases)('%s', (text, intents) => {
    expect([...detectIntents(fold(text))].sort()).toEqual([...intents].sort());
  });
});

describe('yes, no, skip, abort', () => {
  it('takes agreement in both languages', () => {
    for (const text of [
      'yes',
      'Yes!',
      'ok',
      'OK, book it',
      'yes please',
      'đúng rồi',
      'Được',
      'xác nhận',
      'ừ',
      'chốt',
    ]) {
      expect(isYes(fold(text), text), text).toBe(true);
    }
    expect(isYes(fold('👍'), '👍')).toBe(true);
  });

  it('does not take a "yes, but" for agreement', () => {
    for (const text of [
      'yes but change the date',
      'ok nhưng đổi ngày',
      'no',
      'not yet',
      'ok wait',
      'yes I would like to know the price of the tour',
    ]) {
      expect(isYes(fold(text), text), text).toBe(false);
    }
  });

  it('takes refusal, skipping and dropping', () => {
    expect(isNo(fold('No.'))).toBe(true);
    expect(isNo(fold('không'))).toBe(true);
    expect(isNo(fold('no problem, yes'))).toBe(false);
    expect(isSkip(fold('skip'))).toBe(true);
    expect(isSkip(fold('không có'))).toBe(true);
    expect(isSkip(fold("I don't have"))).toBe(true);
    expect(isAbort(fold('cancel'))).toBe(true);
    expect(isAbort(fold('never mind'))).toBe(true);
    expect(isAbort(fold('thôi'))).toBe(true);
    expect(isAbort(fold('cancel my booking'))).toBe(false);
  });
});

describe('matchService', () => {
  const cases: Array<[string, string | undefined]> = [
    ['I want to rent a motorbike', 'motorbike-rental'],
    ['do you have scooters?', 'motorbike-rental'],
    ['thuê xe máy', 'motorbike-rental'],
    ['easy rider for 2 people', 'easy-rider'],
    ['motorbike tour with a driver', 'easy-rider'],
    ['I cannot ride, do you have drivers?', 'easy-rider'],
    ['thuê xe máy có tài xế', 'easy-rider'],
    ['xe ôm đi Bản Giốc 1 ngày', 'easy-rider'],
    ['book a tour', 'tour-package'],
    ['Ban Gioc waterfall', 'tour-package'],
    ['tour thác Bản Giốc', 'tour-package'],
    ['hello', undefined],
    ['20/11 for 2 people', undefined],
  ];
  it.each(cases)('%s (sample settings)', (text, serviceId) => {
    expect(matchService(fold(text), demo).service?.id).toBe(serviceId);
  });

  it.each(cases.filter(([text]) => !/gioc/i.test(fold(text))))(
    '%s (company settings)',
    (text, serviceId) => {
      expect(matchService(fold(text), company).service?.id).toBe(serviceId);
    },
  );

  it('names the option when the message does', () => {
    expect(matchService(fold('rent a Honda Wave'), demo).option?.id).toBe('honda-wave');
    expect(matchService(fold('2 xe ga'), demo).option?.id).toBe('honda-vision');
    expect(matchService(fold('the 3 days 2 nights loop'), demo).option?.id).toBe('cao-bang-loop');
    expect(matchService(fold('rent a motorbike'), demo).option).toBeUndefined();
  });
});

describe('matchOption', () => {
  const rental = demo.services[0]!;

  it('finds a model by name, alias or part of its name', () => {
    expect(matchOption(fold('the XR 150 please'), rental)).toMatchObject({
      kind: 'one',
      option: { id: 'honda-xr150' },
    });
    expect(matchOption(fold('Honda Wave 110'), rental)).toMatchObject({
      kind: 'one',
      option: { id: 'honda-wave' },
    });
    expect(matchOption(fold('xe số'), rental)).toMatchObject({
      kind: 'one',
      option: { id: 'honda-wave' },
    });
  });

  it('says when a message fits several or none', () => {
    expect(matchOption(fold('a wave or a vision'), rental).kind).toBe('several');
    expect(matchOption(fold('any bike'), rental).kind).toBe('none');
  });
});
