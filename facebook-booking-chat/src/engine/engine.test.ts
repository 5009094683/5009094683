import { beforeEach, describe, expect, it } from 'vitest';
import companySettings from '../../config/business';
import { TestClock, demoBusiness, memoryStore } from '../../test/helpers';
import { Desk } from '../bookings/desk';
import { type Business, type Lang, parseBusiness } from '../business/schema';
import type { Store } from '../store';
import { type EngineResult, Engine } from './engine';
import { DRAFT_EXPIRY_MS } from './state';

/** One customer talking to the assistant; remembers the state between messages. */
class Chat {
  state: unknown = undefined;
  lang: Lang;
  last!: EngineResult;

  constructor(
    private readonly engine: Engine,
    private readonly store: Store,
    private readonly clock: TestClock,
    readonly threadId = 't1',
    private readonly customerName: string | null = 'John Smith',
    lang: Lang = 'en',
  ) {
    this.lang = lang;
    store.conversations.open(threadId, lang, clock.now());
  }

  /** Sends a message and returns the assistant's reply as one text. */
  say(text: string, attachments = 0): string {
    this.last = this.engine.handle(
      this.state,
      { text, attachments },
      {
        threadId: this.threadId,
        lang: this.lang,
        customerName: this.customerName,
        now: this.clock.now(),
      },
    );
    this.state = JSON.parse(JSON.stringify(this.last.state));
    this.lang = this.last.lang;
    return this.last.replies.join('\n---\n');
  }
}

let store: Store;
let clock: TestClock;
let business: Business;
let engine: Engine;
let chat: Chat;

function setUp(settings: Business = demoBusiness(), customerName: string | null = 'John Smith') {
  store = memoryStore();
  clock = new TestClock();
  business = settings;
  engine = new Engine(business, new Desk(store, business, clock.now), store.bookings);
  chat = new Chat(engine, store, clock, 't1', customerName);
}

beforeEach(() => setUp());

describe('first contact', () => {
  it('welcomes, says it is automatic, and lists what can be booked', () => {
    const reply = chat.say('Hi!');
    expect(reply).toContain('automatic booking assistant of Cao Bằng Travel Guide');
    expect(reply).toContain('1. Motorbike rental');
    expect(reply).toContain('3. Easy Rider');
    expect(reply).toContain('type "staff"');
  });

  it('answers in Vietnamese to a Vietnamese greeting', () => {
    const reply = chat.say('Xin chào shop');
    expect(reply).toContain('trợ lý đặt chỗ tự động');
    expect(reply).toContain('1. Thuê xe máy');
    expect(chat.last.lang).toBe('vi');
  });

  it('introduces itself once when the customer opens with a question', () => {
    const first = chat.say('How much is a scooter?');
    expect(first).toMatch(/^Hello! I am the automatic booking assistant/);
    expect(first).toContain('Honda Vision (automatic): 200,000 VND');
    const second = chat.say('and what is included?');
    expect(second).not.toContain('automatic booking assistant');
    expect(second).toContain(
      'Motorbike rental includes: helmet, raincoat and copy of the vehicle papers.',
    );
  });

  it('does not answer a message with nothing in it', () => {
    expect(chat.say('   ')).toBe('');
  });
});

describe('questions', () => {
  beforeEach(() => {
    chat.say('hello');
  });

  it('gives every price when no service is named', () => {
    const reply = chat.say('What are your prices?');
    expect(reply).toContain('Motorbike rental, price per motorbike per day:');
    expect(reply).toContain('- Honda Wave 110 (semi-automatic): 150,000 VND');
    expect(reply).toContain('Tour package, price per person:');
    expect(reply).toContain(
      'Easy Rider (motorbike with driver): 1,300,000 VND per passenger per day.',
    );
    expect(reply).toContain('Would you like to book?');
  });

  it('gives the prices of the service asked about', () => {
    const reply = chat.say('how much is the easy rider?');
    expect(reply).toContain('1,300,000 VND per passenger per day');
    expect(reply).not.toContain('Honda Wave');
  });

  it('tells what a mention of a service costs and offers to book', () => {
    const reply = chat.say('do you have scooters?');
    expect(reply).toContain('Motorbike rental, price per motorbike per day:');
    expect(reply).toContain('Would you like to book?');
  });

  it('explains payment and the deposit', () => {
    expect(chat.say('do I have to pay a deposit?')).toBe(
      'You can pay by cash or bank transfer. For Tour package and Easy Rider (motorbike with driver), ' +
        'a deposit of 30% confirms the booking and the balance is paid before the start. ' +
        'Bank transfer: Sample Bank, account 0000 000 000 (example).',
    );
  });

  it('explains the cancellation terms from the settings', () => {
    const reply = chat.say('Can I get a refund if I cancel?');
    expect(reply).toContain(
      'Tour package and Easy Rider (motorbike with driver). Cancellation: free up to 72 hours before the start',
    );
    expect(reply).toContain('between 72 and 24 hours before, 50% of the total price is charged');
    expect(reply).toContain('Motorbike rental: our team will tell you the terms');
  });

  it('tells what to bring, how to reach the team and where it is', () => {
    expect(chat.say('do I need my passport?')).toContain('passport or ID card');
    expect(chat.say('what is your whatsapp?')).toContain('WhatsApp: +(84) 0352 476 994');
    expect(chat.say('where are you located?')).toContain('12 Sample Street');
  });

  it('answers the extra questions written in the settings', () => {
    expect(chat.say('are you open on Sunday?')).toContain('open every day from 7:00 to 21:00');
    chat.say('xin chào');
    expect(chat.say('mấy giờ mở cửa?')).toContain('mở cửa hằng ngày');
  });

  it('answers several questions of one message', () => {
    const reply = chat.say('How much is the day tour and what is included?');
    expect(reply).toContain('Ban Gioc waterfall & Nguom Ngao cave (1 day): 1,200,000 VND');
    expect(reply).toContain('Tour package includes: transport, guide, meals and entrance tickets.');
  });
});

describe('booking a motorbike, step by step', () => {
  it('asks for each missing detail, sums up, and books on yes', () => {
    chat.say('Hello');
    expect(chat.say('I want to rent a motorbike')).toBe(
      'Which motorbike would you like?\n' +
        '1. Honda Wave 110 (semi-automatic) – 150,000 VND per motorbike per day\n' +
        '2. Honda Vision (automatic) – 200,000 VND per motorbike per day\n' +
        '3. Honda XR 150 (manual) – 400,000 VND per motorbike per day',
    );
    expect(chat.say('2')).toBe('From which date do you need the motorbike? (for example 20/11)');
    expect(chat.say('20/11')).toBe('For how many days?');
    expect(chat.say('3')).toBe('How many motorbikes do you need?');
    expect(chat.say('2')).toContain('Which phone number can we reach you on');
    expect(chat.say('+44 7700 900123')).toContain('Where are you staying?');

    expect(chat.say('Sunny Hotel, Kim Dong street')).toBe(
      'Please check your booking:\n' +
        'Service: Motorbike rental – Honda Vision (automatic)\n' +
        'Dates: Fri 20 Nov 2026 to Sun 22 Nov 2026 (3 days)\n' +
        'Motorbikes: 2\n' +
        'Name: John Smith\n' +
        'Phone: +44 7700 900123\n' +
        'Pick-up: Sunny Hotel, Kim Dong street\n' +
        'Price: 200,000 VND × 2 motorbikes × 3 days = 1,200,000 VND\n' +
        '\n' +
        'Reply YES to book, or tell me what to change.',
    );

    const confirmation = chat.say('Yes');
    const booking = chat.last.booking!;
    expect(booking).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'auto',
      optionId: 'honda-vision',
      startDate: '2026-11-20',
      endDate: '2026-11-22',
      quantity: 2,
      totalPrice: 1_200_000,
      customerName: 'John Smith',
      phone: '+44 7700 900123',
      pickup: 'Sunny Hotel, Kim Dong street',
    });
    expect(confirmation).toContain(`Your booking ${booking.code} is confirmed.`);
    expect(confirmation).toContain('Price: 200,000 VND × 2 motorbikes × 3 days = 1,200,000 VND');
    expect(confirmation).toContain(
      'Please bring your passport or ID card and your driving licence.',
    );
    expect(confirmation).toContain('see you on Fri 20 Nov 2026!\nThu Hien, Cao Bằng Travel Guide');
    expect(confirmation).not.toContain('Deposit');
    expect(store.bookings.ofThread('t1')).toHaveLength(1);
  });

  it('takes everything from one message', () => {
    const reply = chat.say(
      'Hi, I would like to rent 2 Honda Wave from 20 to 22 November. My number is 0914 674 724, staying at Sunny Hotel',
    );
    expect(reply).toContain('Please check your booking:');
    expect(reply).toContain('Service: Motorbike rental – Honda Wave 110 (semi-automatic)');
    expect(reply).toContain('Dates: Fri 20 Nov 2026 to Sun 22 Nov 2026 (3 days)');
    expect(reply).toContain('Motorbikes: 2');
    expect(reply).toContain('Phone: 0914 674 724');
    expect(reply).toContain('Pick-up: Sunny Hotel');
    expect(reply).toContain('= 900,000 VND');
  });

  it('lets the customer skip the phone number and the pick-up place', () => {
    chat.say('rent 1 wave tomorrow for 1 day');
    expect(chat.say('skip')).toContain('Where are you staying?');
    const summary = chat.say('skip');
    expect(summary).toContain('Please check your booking:');
    expect(summary).not.toContain('Phone:');
    expect(summary).not.toContain('Pick-up:');
    chat.say('yes');
    expect(chat.last.booking).toMatchObject({ phone: null, pickup: null, quantity: 1, days: 1 });
  });

  it('notes the place, not the words around it', () => {
    chat.say('rent 1 wave tomorrow, just for the day');
    chat.say('skip');
    expect(chat.say('we are staying at Primrose Homestay')).toContain(
      'Pick-up: Primrose Homestay\n',
    );
    chat.say('no');
    expect(chat.say('pick up at Sunny Hotel')).toContain('Pick-up: Sunny Hotel\n');
  });

  it('asks for the name when Facebook gives none', () => {
    setUp(demoBusiness(), null);
    chat.say('rent 1 wave on 20/11 for 2 days');
    expect(chat.last.replies[0]).toContain('Under which name should I make the booking?');
    expect(chat.say('yes')).toContain('Sorry, I did not get that.');
    expect(chat.say('My name is Anna Müller')).toContain('Which phone number');
    chat.say('skip');
    expect(chat.say('skip')).toContain('Name: Anna Müller');
  });

  it('answers a question in the middle and then asks again', () => {
    chat.say('I want to rent a motorbike');
    chat.say('wave');
    expect(chat.say('what is included?')).toBe(
      'Motorbike rental includes: helmet, raincoat and copy of the vehicle papers. ' +
        'Fuel is paid by the renter. A deposit or collateral is left with us at pick-up.\n\n' +
        'From which date do you need the motorbike? (for example 20/11)',
    );
    expect(chat.say('tomorrow')).toBe('For how many days?');
  });

  it('takes a question for a question, not for a name or an address', () => {
    chat.say('rent 1 wave on 20/11 for 2 days');
    chat.say('0914 674 724');
    const reply = chat.say('how much is the deposit?');
    expect(reply).toContain('You can pay by cash or bank transfer.');
    expect(reply).toContain('Where are you staying?');
    expect(chat.say('Hotel Max')).toContain('Pick-up: Hotel Max');
  });
});

describe('correcting and dropping', () => {
  beforeEach(() => {
    chat.say('rent 2 wave from 20/11 for 3 days');
    chat.say('skip');
    chat.say('skip');
  });

  it('changes a detail named at the summary and sums up again', () => {
    const reply = chat.say('make it 3 bikes please');
    expect(reply).toContain('Motorbikes: 3');
    expect(reply).toContain('= 1,350,000 VND');
    expect(chat.say('from 21/11 instead')).toContain('Dates: Sat 21 Nov 2026 to Mon 23 Nov 2026');
    expect(chat.say('my name is Jane Doe')).toContain('Name: Jane Doe');
  });

  it('asks what to change on "no"', () => {
    expect(chat.say('no')).toBe(
      'Of course. What would you like to change? (for example the date, the number of days or the number of motorbikes)',
    );
    expect(chat.say('4 days')).toContain('Dates: Fri 20 Nov 2026 to Mon 23 Nov 2026 (4 days)');
  });

  it('does not book on "yes, but"', () => {
    const reply = chat.say('yes but for 2 days only');
    expect(chat.last.booking).toBeNull();
    expect(reply).toContain('(2 days)');
    chat.say('ok');
    expect(chat.last.booking).toMatchObject({ days: 2 });
  });

  it('drops the booking on "cancel" and books nothing', () => {
    expect(chat.say('cancel')).toBe(
      'No problem, I have dropped that request. Tell me whenever you would like to book.',
    );
    expect(chat.say('yes')).not.toContain('confirmed');
    expect(store.bookings.list()).toHaveLength(0);
  });

  it('reminds how to confirm when the answer is neither yes nor a change', () => {
    expect(chat.say('hmm')).toBe(
      'Sorry, I did not get that.\n\nReply YES to book, or tell me what to change.',
    );
  });

  it('does not switch service because another one is mentioned in passing', () => {
    const reply = chat.say('we need them for a trip to the waterfall');
    expect(chat.last.booking).toBeNull();
    expect(reply).not.toContain('Tour package');
  });

  it('switches service when the customer says so', () => {
    const reply = chat.say('actually I would rather book an easy rider');
    expect(reply).toBe('How many passengers? (each passenger rides with their own driver)');
    expect(chat.say('2')).toContain('Service: Easy Rider (motorbike with driver)');
  });
});

describe('dates and limits', () => {
  it('refuses a date that has passed and asks again', () => {
    chat.say('I want to rent a wave');
    expect(chat.say('10/11/2026')).toBe(
      'Tue 10 Nov 2026 has already passed.\n\nFrom which date do you need the motorbike? (for example 20/11)',
    );
  });

  it('refuses a date beyond the booking horizon', () => {
    chat.say('I want to rent a wave');
    expect(chat.say('20/11/2028')).toContain('I can take bookings up to 365 days ahead.');
  });

  it('reads a lone number as the day when the date was asked', () => {
    chat.say('I want to rent a wave');
    expect(chat.say('20')).toBe('For how many days?');
    expect(chat.last.state.draft.startDate).toBe('2026-11-20');
  });

  it('reads a number in a short answer as the answer to what was asked', () => {
    chat.say('I want to rent a wave');
    expect(chat.say('ok then the 25th')).toBe('For how many days?');
    expect(chat.last.state.draft.startDate).toBe('2026-11-25');
    expect(chat.say('3 then')).toBe('How many motorbikes do you need?');
    expect(chat.last.state.draft.days).toBe(3);
    expect(chat.say('make it 2 please')).toContain('Which phone number');
    expect(chat.last.state.draft.quantity).toBe(2);
  });

  it('does not take a number meant for something else as the answer', () => {
    chat.say('I want to rent a wave');
    // Asked for the date; the customer gives the length and the count instead.
    expect(chat.say('3 days')).toContain('From which date');
    expect(chat.say('2 bikes')).toContain('From which date');
    expect(chat.last.state.draft).toMatchObject({ days: 3, quantity: 2 });
    expect(chat.last.state.draft.startDate).toBeUndefined();

    setUp();
    chat.say('I want to rent a wave from 20/11');
    // Asked for the days; the customer gives the count instead.
    expect(chat.say('2 bikes')).toBe('For how many days?');
    expect(chat.last.state.draft.days).toBeUndefined();
    chat.say('3');
    setUp();
    chat.say('I want to rent a wave from 20/11 for 2 days');
    // Asked how many motorbikes; "3 days" changes the length, not the count.
    expect(chat.say('3 days')).toBe('How many motorbikes do you need?');
    expect(chat.last.state.draft).toMatchObject({ days: 3 });
    expect(chat.last.state.draft.quantity).toBeUndefined();
  });

  it('passes a very large or very long request to a person', () => {
    chat.say('hello');
    const reply = chat.say('easy rider for 25 people on 20/11 for 2 days');
    expect(reply).toContain('Our team arranges a request of this size personally');
    expect(chat.last.handoff).toBe('large_request');
  });

  it('forgets a booking left unfinished for half a day', () => {
    expect(chat.say('I want to rent a wave')).toContain('From which date');
    clock.advance(DRAFT_EXPIRY_MS + 1);
    expect(chat.say('20/11')).toBe(
      'What would you like to book?\n1. Motorbike rental\n2. Tour package\n3. Easy Rider (motorbike with driver)',
    );
    expect(chat.last.state.draft.optionId).toBeUndefined();
  });

  it('takes "20/11 for 2 days" to be about what was just asked', () => {
    chat.say('how much is a scooter?');
    expect(chat.say('ok, 1 bike from 20/11 for 2 days')).toContain('Which phone number');
    expect(chat.last.state.draft).toMatchObject({
      serviceId: 'motorbike-rental',
      optionId: 'honda-vision',
      startDate: '2026-11-20',
      days: 2,
      quantity: 1,
    });
  });
});

describe('availability', () => {
  it('says so when the dates are full, and takes another date', () => {
    // Both XR 150 are out from the 20th to the 22nd.
    const other = new Chat(engine, store, clock, 't2', 'Maria');
    other.say('rent 2 xr 150 from 20/11 for 3 days');
    other.say('skip');
    other.say('skip');
    other.say('yes');
    expect(other.last.booking?.status).toBe('confirmed');

    const reply = chat.say('I want to rent 1 XR 150 on 21/11 for 1 day');
    expect(reply).toContain('Sorry, we are fully booked on those dates.');
    expect(chat.say('23/11')).toContain('Which phone number');
  });

  it('says how many are left when fewer are free than asked for', () => {
    const reply = chat.say('rent 3 xr 150 on 21/11 for 1 day');
    expect(reply).toContain('only 2 motorbikes are left');
    expect(chat.say('ok 2 bikes then')).toContain('Which phone number');
  });

  it('does not sell the last one twice when two customers say yes', () => {
    const other = new Chat(engine, store, clock, 't2', 'Maria');
    for (const customer of [chat, other]) {
      customer.say('rent 2 xr 150 on 21/11 for 1 day');
      customer.say('skip');
      expect(customer.say('skip')).toContain('Please check your booking:');
    }
    chat.say('yes');
    expect(chat.last.booking?.status).toBe('confirmed');
    expect(other.say('yes')).toContain('Sorry, we are fully booked on those dates.');
    expect(other.last.booking).toBeNull();
    expect(store.bookings.list()).toHaveLength(1);
  });
});

describe('tours and Easy Rider', () => {
  it('books a tour for a person to confirm, with the deposit named', () => {
    chat.say('hello');
    expect(chat.say('I would like to book a tour')).toContain('Which tour would you like?');
    expect(chat.say('the waterfall one')).toBe(
      'On which date would you like to start the tour? (for example 20/11)',
    );
    expect(chat.say('Saturday')).toBe('How many people are travelling?');
    chat.say('we are 2');
    chat.say('skip');
    const summary = chat.say('Sunny Hotel');
    expect(summary).toContain(
      'Service: Tour package – Ban Gioc waterfall & Nguom Ngao cave (1 day)',
    );
    expect(summary).toContain('Date: Sat 21 Nov 2026 (1 day)');
    expect(summary).toContain('Travellers: 2');
    expect(summary).toContain('Price: 1,200,000 VND × 2 people = 2,400,000 VND');
    expect(summary).toContain(
      'A deposit of 30% (720,000 VND) is asked for when the booking is confirmed.',
    );

    const reply = chat.say('yes please');
    const booking = chat.last.booking!;
    expect(booking).toMatchObject({ status: 'pending', days: 1, quantity: 2, depositPercent: 30 });
    expect(reply).toBe(
      `Thank you, John Smith! Your request ${booking.code} has been passed to our team. A person will confirm it here shortly.`,
    );
  });

  it('keeps the length of a tour whatever the customer writes', () => {
    chat.say('book the loop tour for 2 people from 20/11 for 5 days');
    chat.say('skip');
    expect(chat.say('skip')).toContain('Dates: Fri 20 Nov 2026 to Sun 22 Nov 2026 (3 days)');
  });

  it('books an Easy Rider trip and names deposit and cancellation terms', () => {
    const summary = chat.say(
      'Easy rider for 2 people, 20-21/11, phone 0914 674 724, pick up at Sunny Hotel',
    );
    expect(summary).toContain('Service: Easy Rider (motorbike with driver)\n');
    expect(summary).toContain('Passengers: 2');
    expect(summary).toContain('Price: 1,300,000 VND × 2 passengers × 2 days = 5,200,000 VND');
    const confirmation = chat.say('OK');
    expect(chat.last.booking).toMatchObject({ status: 'confirmed', totalPrice: 5_200_000 });
    expect(confirmation).toContain(
      'Deposit: please pay 30% (1,560,000 VND) by cash or bank transfer to secure your booking; ' +
        'the balance is paid before the start. Bank transfer: Sample Bank, account 0000 000 000 (example).',
    );
    expect(confirmation).toContain('Cancellation: free up to 72 hours before the start');
    expect(confirmation).toContain('the original is required in the border area');
  });

  it('counts motorbikes for a rental and people for a tour', () => {
    expect(chat.say('we are 2 people and want to rent motorbikes on 20/11 for 2 days')).toContain(
      'Which motorbike would you like?',
    );
    expect(chat.say('wave')).toBe('How many motorbikes do you need?');
  });

  it('asks which service when the message fits more than one', () => {
    expect(chat.say('2 people on 20/11')).toContain('What would you like to book?');
    expect(chat.say('3')).toBe('For how many days?');
    expect(chat.last.state.draft).toMatchObject({ serviceId: 'easy-rider', quantity: 2 });
  });
});

describe('Vietnamese', () => {
  it('books a motorbike in Vietnamese', () => {
    setUp(demoBusiness(), 'Nguyễn Văn An');
    chat.say('xin chào');
    expect(chat.say('mình muốn thuê 2 xe số từ ngày 20/11, thuê 3 ngày')).toContain(
      'Anh/chị cho em xin số điện thoại',
    );
    expect(chat.say('0914 674 724')).toContain('Anh/chị đang ở đâu ạ?');
    expect(chat.say('bỏ qua')).toBe(
      'Anh/chị kiểm tra giúp em thông tin đặt chỗ:\n' +
        'Dịch vụ: Thuê xe máy – Honda Wave 110 (xe số)\n' +
        'Thời gian: Thứ sáu, 20/11/2026 đến Chủ nhật, 22/11/2026 (3 ngày)\n' +
        'Số xe: 2\n' +
        'Tên: Nguyễn Văn An\n' +
        'Điện thoại: 0914 674 724\n' +
        'Giá: 150.000 VND × 2 xe × 3 ngày = 900.000 VND\n' +
        '\n' +
        'Anh/chị nhắn “ĐỒNG Ý” để đặt, hoặc cho em biết cần sửa gì ạ.',
    );
    const confirmation = chat.say('đồng ý');
    expect(chat.last.booking).toMatchObject({ lang: 'vi', serviceName: 'Thuê xe máy' });
    expect(confirmation).toContain('đã được xác nhận');
    expect(confirmation).toContain('giấy phép lái xe');
  });

  it('answers questions written without tone marks', () => {
    expect(chat.say('thue xe may gia bao nhieu 1 ngay vay shop')).toContain(
      'Thuê xe máy, giá mỗi xe mỗi ngày:',
    );
    expect(chat.say('co can dat coc khong')).toContain('đặt cọc 30%');
  });

  it('keeps the language when a message does not show it', () => {
    chat.say('cho mình thuê xe');
    expect(chat.say('1')).toBe('Anh/chị cần xe từ ngày nào ạ? (ví dụ 20/11)');
    expect(chat.say('20/11')).toBe('Anh/chị thuê mấy ngày ạ?');
  });

  it('follows the customer into another language', () => {
    chat.say('xin chào');
    expect(chat.say('Sorry, do you speak English? How much is a scooter?')).toContain(
      'price per motorbike per day',
    );
  });
});

describe('bookings already made', () => {
  function bookTour(): string {
    chat.say('book the waterfall tour for 2 people on 21/11');
    chat.say('skip');
    chat.say('skip');
    chat.say('yes');
    return chat.last.booking!.code;
  }

  it('tells where a booking stands', () => {
    expect(chat.say('is my booking confirmed?')).toContain(
      'I cannot find a booking made in this chat.',
    );
    const code = bookTour();
    expect(chat.say('is my booking confirmed yet?')).toBe(
      `Your bookings:\n- ${code}: Tour package, Sat 21 Nov 2026, 1 day: waiting for our team to confirm`,
    );
    expect(chat.say(code.toLowerCase())).toContain(`${code}: Tour package`);
  });

  it('does not show a booking to someone else who names its number', () => {
    const code = bookTour();
    const stranger = new Chat(engine, store, clock, 't2', 'Eve');
    expect(stranger.say(`status of ${code}?`)).toContain(
      'I cannot find a booking made in this chat.',
    );
  });

  it('passes a cancellation to a person with the terms, and cancels nothing itself', () => {
    const code = bookTour();
    const reply = chat.say('I need to cancel my booking');
    expect(reply).toContain(`I have passed your request to cancel booking ${code} to our team.`);
    expect(reply).toContain('Cancellation: free up to 72 hours before the start');
    expect(chat.last.handoff).toBe('cancel_request');
    expect(store.bookings.get(code)?.status).toBe('pending');
  });

  it('passes a change of date to a person', () => {
    const code = bookTour();
    expect(chat.say('can I change the date of my booking?')).toContain(
      `I have passed your request to change booking ${code} to our team.`,
    );
    expect(chat.last.handoff).toBe('change_request');
  });

  it('says so when there is nothing to cancel', () => {
    expect(chat.say('cancel my booking')).toContain('I cannot find a booking made in this chat.');
    expect(chat.last.handoff).toBeNull();
  });
});

describe('passing the chat to a person', () => {
  it('does so when asked, in either language', () => {
    expect(chat.say('can I talk to a real person?')).toBe(
      'I have asked our team to join this chat. A person will reply here as soon as possible. ' +
        'You can also reach us on Zalo 0914 674 724 or WhatsApp +(84) 0352 476 994.',
    );
    expect(chat.last.handoff).toBe('asked');

    const other = new Chat(engine, store, clock, 't2');
    expect(other.say('cho mình gặp nhân viên')).toContain('Em đã báo nhân viên vào hỗ trợ.');
    expect(other.last.handoff).toBe('asked');
  });

  it('does so when a customer wants their data deleted, as the privacy notice tells them to ask', () => {
    expect(chat.say('Please delete my data')).toBe(
      'I have passed your request to our team. A person will delete your chat with me and tell you here when it is done.',
    );
    expect(chat.last.handoff).toBe('delete_request');

    const other = new Chat(engine, store, clock, 't2');
    expect(other.say('xóa dữ liệu của tôi')).toContain('Nhân viên sẽ xóa cuộc trò chuyện');
    expect(other.last.handoff).toBe('delete_request');
    expect(other.last.lang).toBe('vi');

    // In the middle of a booking too, and it is not taken for cancelling a booking.
    const busy = new Chat(engine, store, clock, 't3');
    busy.say('I want to rent 2 Honda Wave from 20/11 for 3 days');
    busy.say('forget me and delete my information please');
    expect(busy.last.handoff).toBe('delete_request');
  });

  it('does so after two messages in a row it cannot use', () => {
    chat.say('hello');
    expect(chat.say('asdf qwer')).toContain('Sorry, I did not understand that.');
    expect(chat.last.handoff).toBeNull();
    expect(chat.say('zxcv')).toContain('I am not sure I understand, so I have asked our team');
    expect(chat.last.handoff).toBe('confused');
  });

  it('starts counting again after a message it could use', () => {
    chat.say('hello');
    chat.say('asdf qwer');
    chat.say('how much is a scooter?');
    chat.say('zxcv');
    expect(chat.last.handoff).toBeNull();
  });

  it('flags a photo for a person without stopping', () => {
    expect(chat.say('', 1)).toContain('I can only read text');
    expect(chat.last.attention).toMatch(/photo/);
    expect(chat.last.handoff).toBeNull();
    chat.say('how much is a scooter?', 1);
    expect(chat.last.attention).toMatch(/photo/);
    expect(chat.last.replies[0]).toContain('200,000 VND');
  });

  it('tells a person about a wish for a discount, and carries on', () => {
    chat.say('hello');
    expect(chat.say('any discount for 5 days?')).toContain(
      'Our team decides on special prices. I have let them know',
    );
    expect(chat.last.attention).toMatch(/discount/);
    expect(chat.last.handoff).toBeNull();
  });

  it('leaves a lone emoji or thumbs-up unanswered, except as a yes to the summary', () => {
    chat.say('hello');
    expect(chat.say('👍')).toBe('');
    expect(chat.say('', 1)).toContain('I can only read text');
    chat.last = engine.handle(
      chat.state,
      { text: '', attachments: 1, likeOnly: true },
      {
        threadId: 't1',
        lang: 'en',
        customerName: 'John Smith',
        now: clock.now(),
      },
    );
    expect(chat.last.replies).toEqual([]);
    expect(chat.last.attention).toBeNull();

    chat.say('rent 1 wave tomorrow for 1 day');
    chat.say('skip');
    expect(chat.say('skip')).toContain('Please check your booking:');
    expect(chat.say('👍')).toContain('is confirmed');
    expect(chat.last.booking).not.toBeNull();
  });

  it('greets a first message it cannot use instead of apologising', () => {
    const reply = chat.say('Bonjour, vous louez des motos?');
    expect(reply).toContain('I am the automatic booking assistant');
    expect(reply).toContain('1. Motorbike rental');
    expect(reply).not.toContain('Sorry');
  });

  it('is polite to thanks and goodbyes', () => {
    chat.say('hello');
    expect(chat.say('thank you!')).toContain('You are welcome!');
    expect(chat.say('bye')).toContain('Goodbye');
  });
});

describe('with the settings as shipped (no prices yet)', () => {
  beforeEach(() => setUp(parseBusiness(companySettings)));

  it('promises no price and takes the booking for a person to quote', () => {
    expect(chat.say('How much to rent a motorbike?')).toContain(
      'Motorbike rental: our team will confirm the price for your dates.',
    );
    chat.say('rent 2 motorbikes from 20/11 for 3 days');
    chat.say('skip');
    const summary = chat.say('skip');
    expect(summary).toContain('Service: Motorbike rental\n');
    expect(summary).toContain('Price: our team will confirm the price with you.');
    const reply = chat.say('yes');
    expect(chat.last.booking).toMatchObject({ status: 'pending', totalPrice: null });
    expect(reply).toContain('A person will confirm it here shortly, together with the price.');
  });

  it('asks how long a tour should be, since none has a set length', () => {
    chat.say('I want to book a tour for 2 people on 20/11');
    expect(chat.last.replies[0]).toContain('How many days should the tour be?');
  });

  it('says the team will send the location, as no address is set', () => {
    expect(chat.say('where are you?')).toContain('Our team will send you our exact location here.');
  });
});
