import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClock, demoBusiness, memoryStore } from '../../test/helpers';
import { Desk } from '../bookings/desk';
import { Engine } from '../engine/engine';
import type { Store } from '../store';
import { SimulatorTransport } from '../transport/simulator';
import { type BotOptions, Bot } from './bot';

const business = demoBusiness();
const HOUR = 60 * 60 * 1000;

let store: Store;
let clock: TestClock;
let facebook: SimulatorTransport;
let desk: Desk;
let bot: Bot;

async function setUp(options: Partial<BotOptions> = {}): Promise<void> {
  store = memoryStore();
  clock = new TestClock();
  facebook = new SimulatorTransport(clock.now);
  desk = new Desk(store, business, clock.now);
  bot = new Bot({
    transport: facebook,
    store,
    engine: new Engine(business, desk, store.bookings),
    business,
    options: { debounceMs: 0, typingMsPerChar: 0, minTypingMs: 0, maxTypingMs: 0, ...options },
    now: clock.now,
  });
  await bot.start();
}

/** A customer writes, and the test waits until the assistant has dealt with it. */
async function customer(threadId: string, text: string): Promise<string[]> {
  const before = facebook.sentTo(threadId).length;
  facebook.customerSays(threadId, text);
  await bot.settled();
  return facebook.sentTo(threadId).slice(before);
}

async function bookTour(threadId = 'anna'): Promise<string> {
  if (!facebook.names.has(threadId)) facebook.names.set(threadId, `Customer ${threadId}`);
  await customer(threadId, 'book the waterfall tour for 2 people on 21/11');
  await customer(threadId, 'skip');
  await customer(threadId, 'skip');
  await customer(threadId, 'yes');
  return store.bookings.ofThread(threadId)[0]!.code;
}

beforeEach(() => setUp());
afterEach(() => bot.stop());

describe('answering customers', () => {
  it('answers a message and keeps both sides of the chat', async () => {
    facebook.names.set('anna', 'Anna Müller');
    const replies = await customer('anna', 'Hello');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('automatic booking assistant');

    const conversation = store.conversations.get('anna')!;
    expect(conversation).toMatchObject({ customerName: 'Anna Müller', mode: 'bot', unread: 1 });
    expect(store.messages.list('anna').map((m) => [m.sender, m.status])).toEqual([
      ['customer', 'received'],
      ['bot', 'sent'],
    ]);
  });

  it('carries a booking through several messages', async () => {
    facebook.names.set('anna', 'Anna Müller');
    await customer('anna', 'I want to rent 1 Honda Wave from 20/11 for 2 days');
    await customer('anna', '0914 674 724');
    const [summary] = await customer('anna', 'Sunny Hotel');
    expect(summary).toContain('Name: Anna Müller');
    const [confirmation] = await customer('anna', 'yes');
    expect(confirmation).toContain('is confirmed');
    expect(store.bookings.ofThread('anna')[0]).toMatchObject({
      status: 'confirmed',
      customerName: 'Anna Müller',
      totalPrice: 300_000,
    });
  });

  it('takes in once a message that Facebook delivers twice', async () => {
    facebook.customerSays('anna', 'Hello', { messageId: 'mid.1' });
    facebook.customerSays('anna', 'Hello', { messageId: 'mid.1' });
    await bot.settled();
    expect(facebook.sentTo('anna')).toHaveLength(1);
    expect(store.messages.list('anna').filter((m) => m.sender === 'customer')).toHaveLength(1);
  });

  it('waits for the customer to finish and answers several messages as one', async () => {
    await bot.stop();
    await setUp({ debounceMs: 40 });
    facebook.names.set('anna', 'Anna Müller');
    facebook.customerSays('anna', 'hi');
    facebook.customerSays('anna', 'I want to rent 2 Honda Wave');
    facebook.customerSays('anna', 'from 20/11 for 3 days');
    await bot.settled();
    const replies = facebook.sentTo('anna');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Which phone number');
  });

  it('answers each chat on its own', async () => {
    facebook.customerSays('anna', 'I want to rent a wave');
    facebook.customerSays('ben', 'xin chào');
    await bot.settled();
    expect(facebook.sentTo('anna')[0]).toContain('From which date');
    expect(facebook.sentTo('ben')[0]).toContain('Xin chào anh/chị!');
  });

  it('ignores group chats', async () => {
    await bot.stop();
    await setUp();
    // Emitted by hand: the simulator has no groups of its own.
    (facebook as unknown as { emit(m: object): void }).emit({
      threadId: 'group1',
      senderId: 'anna',
      text: 'hello everyone',
      fromSelf: false,
      isGroup: true,
    });
    await bot.settled();
    expect(facebook.sent).toHaveLength(0);
    expect(store.conversations.get('group1')).toBeUndefined();
  });

  it('marks a message that could not be sent, flags the chat, and sends it again on request', async () => {
    facebook.failSendsWith = 'Not logged in';
    await customer('anna', 'Hello');
    const failed = store.messages.list('anna').find((m) => m.sender === 'bot')!;
    expect(failed).toMatchObject({ status: 'failed', error: 'Not logged in' });
    expect(store.conversations.get('anna')).toMatchObject({
      needsStaff: true,
      needsStaffReason: 'A message could not be sent: Not logged in',
    });

    facebook.failSendsWith = null;
    expect(await bot.resend(failed.id)).toBe(true);
    expect(facebook.sentTo('anna')).toHaveLength(1);
    expect(await bot.resend(failed.id + 1)).toBe(false);
  });

  it('stops after too many answers in an hour and calls a person', async () => {
    await bot.stop();
    await setUp({ maxRepliesPerHour: 3 });
    for (let i = 0; i < 5; i += 1) await customer('loop', 'hello');
    expect(facebook.sentTo('loop')).toHaveLength(3);
    expect(store.conversations.get('loop')).toMatchObject({ mode: 'human', needsStaff: true });
    expect(store.conversations.get('loop')!.needsStaffReason).toContain('3 messages');
  });
});

describe('a person of the team in the chat', () => {
  it('knows its own messages when Facebook reports them back', async () => {
    await customer('anna', 'Hello');
    await customer('anna', 'how much is a scooter?');
    expect(store.conversations.get('anna')!.mode).toBe('bot');
    expect(store.messages.list('anna').filter((m) => m.sender === 'staff')).toHaveLength(0);
    expect(store.messages.list('anna')).toHaveLength(4);
  });

  it('steps back when a person writes in Messenger itself, and returns later', async () => {
    await customer('anna', 'Hello');
    facebook.staffWritesInMessenger('anna', 'Hi Anna, this is Hien. I will call you in a minute.');
    await bot.settled();

    const paused = store.conversations.get('anna')!;
    expect(paused).toMatchObject({ mode: 'human', pausedUntil: clock.now() + 12 * HOUR });
    expect(store.messages.list('anna').at(-1)).toMatchObject({
      sender: 'staff',
      text: 'Hi Anna, this is Hien. I will call you in a minute.',
    });

    expect(await customer('anna', 'ok thank you. how much is a scooter?')).toEqual([]);
    expect(store.conversations.get('anna')!.unread).toBe(2);

    clock.advance(12 * HOUR + 1);
    const replies = await customer('anna', 'how much is a scooter?');
    expect(replies[0]).toContain('200,000 VND');
    expect(store.conversations.get('anna')!.mode).toBe('bot');
  });

  it('does not answer what a person has picked up in the meantime', async () => {
    await bot.stop();
    await setUp({ debounceMs: 40 });
    facebook.customerSays('anna', 'how much is a scooter?');
    facebook.staffWritesInMessenger('anna', '200k a day :)');
    await bot.settled();
    expect(facebook.sentTo('anna')).toEqual([]);
  });

  it('sends what a person writes in the dashboard and steps back', async () => {
    await customer('anna', 'can I talk to someone please, staff?');
    expect(store.conversations.get('anna')).toMatchObject({ mode: 'human', needsStaff: true });

    expect(await bot.sendAsStaff('anna', 'Hello Anna, Hien here. How can I help?')).toBe(true);
    await bot.settled();
    expect(facebook.sentTo('anna').at(-1)).toBe('Hello Anna, Hien here. How can I help?');
    expect(store.messages.list('anna').at(-1)).toMatchObject({ sender: 'staff', status: 'sent' });
    expect(store.conversations.get('anna')).toMatchObject({ mode: 'human', needsStaff: false });
    expect(await bot.sendAsStaff('nobody', 'hello')).toBe(false);
  });

  it('keeps out until handed back when a person takes the chat over', async () => {
    await customer('anna', 'Hello');
    bot.takeOver('anna');
    clock.advance(48 * HOUR);
    expect(await customer('anna', 'how much is a scooter?')).toEqual([]);

    bot.handBack('anna');
    const replies = await customer('anna', 'how much is a scooter?');
    expect(replies[0]).toContain('200,000 VND');
  });
});

describe('passing chats on and telling the team', () => {
  it('stays silent after passing a chat to a person, and flags it', async () => {
    const replies = await customer('anna', 'I want to talk to a real person');
    expect(replies[0]).toContain('I have asked our team to join this chat.');
    expect(store.conversations.get('anna')).toMatchObject({
      mode: 'human',
      needsStaff: true,
      needsStaffReason: 'The customer asked for a person.',
    });
    expect(await customer('anna', 'hello?')).toEqual([]);
  });

  it('flags a waiting booking and tells the customer when a person confirms it', async () => {
    const code = await bookTour();
    expect(store.conversations.get('anna')).toMatchObject({
      mode: 'bot',
      needsStaff: true,
      needsStaffReason: `Booking ${code} waits to be confirmed.`,
    });

    const confirmed = desk.confirm(code);
    expect(await bot.announce(confirmed)).toBe(true);
    const message = facebook.sentTo('anna').at(-1)!;
    expect(message).toContain(`Your booking ${code} is confirmed.`);
    expect(message).toContain('Deposit: please pay 30% (720,000 VND)');
  });

  it('tells the customer of a declined and of a cancelled booking, with the reason', async () => {
    const code = await bookTour();
    await bot.announce(desk.decline(code, 'The road to the waterfall is closed that day.'));
    expect(facebook.sentTo('anna').at(-1)).toContain(
      `We are sorry: we cannot take booking ${code}. The road to the waterfall is closed that day.`,
    );

    const second = await bookTour('ben');
    await bot.announce(desk.cancel(second, ''));
    expect(facebook.sentTo('ben').at(-1)).toContain(`Your booking ${second} has been cancelled.`);
  });

  it('messages the team about bookings and chats that need them', async () => {
    await bot.stop();
    await setUp({ staffThreadIds: ['hien'], dashboardUrl: 'https://desk.example/' });
    facebook.names.set('anna', 'Anna Müller');

    const code = await bookTour();
    expect(facebook.sentTo('hien')).toEqual([
      `New booking to confirm: ${code}, Tour package (Ban Gioc waterfall & Nguom Ngao cave (1 day)), ` +
        `from Sat 21 Nov 2026, 1 day, quantity 2, for Anna Müller\nhttps://desk.example/bookings/${code}`,
    ]);

    facebook.names.set('ben', 'Ben Carter');
    await customer('ben', 'rent 1 xr 150 on 20/11 for 1 day');
    await customer('ben', 'skip');
    await customer('ben', 'skip');
    await customer('ben', 'yes');
    expect(facebook.sentTo('hien').at(-1)).toContain('New booking, confirmed automatically: CB-');

    await customer('carl', 'staff please');
    expect(facebook.sentTo('hien').at(-1)).toBe(
      'Customer carl: The customer asked for a person.\nhttps://desk.example/conversations/carl',
    );
  });

  it('does not take the team\u2019s own chat for a customer', async () => {
    await bot.stop();
    await setUp({ staffThreadIds: ['hien'] });
    expect(await customer('hien', 'ok thanks')).toEqual([]);
    expect(store.conversations.get('hien')).toBeUndefined();
  });

  it('flags a photo for the team and still answers the words', async () => {
    facebook.customerSays('anna', 'is this the bike? how much is a scooter?', { attachments: 1 });
    await bot.settled();
    expect(facebook.sentTo('anna')[0]).toContain('200,000 VND');
    expect(store.conversations.get('anna')).toMatchObject({
      mode: 'bot',
      needsStaff: true,
      needsStaffReason: 'The customer sent a photo, sticker or file.',
    });
  });
});
