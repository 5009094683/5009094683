import type { Business } from '../business/schema';
import type { Engine, HandoffReason } from '../engine/engine';
import { bookingMessage, bookingTitle } from '../engine/view';
import { formatDate } from '../nlu/dates';
import type { Booking, Conversation, Store } from '../store';
import type { IncomingMessage, Transport } from '../transport/types';

export interface BotOptions {
  /** How long to wait for the customer to finish writing before answering. */
  debounceMs: number;
  /** Shows "typing" this long per character of the answer, within the two bounds. */
  typingMsPerChar: number;
  minTypingMs: number;
  maxTypingMs: number;
  /**
   * How long the assistant stays out of a chat after a person of the team
   * wrote in it, or after it passed the chat to a person.
   */
  staffPauseMs: number;
  /** Answers in one chat within an hour, after which the assistant stops and calls a person. */
  maxRepliesPerHour: number;
  /** Chats of team members who get a Messenger message when something needs them. */
  staffThreadIds: string[];
  /** Address of the dashboard, put into those messages. '' leaves the link out. */
  dashboardUrl: string;
}

export const DEFAULT_BOT_OPTIONS: BotOptions = {
  debounceMs: 2500,
  typingMsPerChar: 25,
  minTypingMs: 800,
  maxTypingMs: 4000,
  staffPauseMs: 12 * 60 * 60 * 1000,
  maxRepliesPerHour: 40,
  staffThreadIds: [],
  dashboardUrl: '',
};

export interface BotLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

const SILENT: BotLog = { info() {}, warn() {}, error() {} };

const HANDOFF_NOTES: Record<HandoffReason, string> = {
  asked: 'The customer asked for a person.',
  confused: 'The assistant could not understand the customer.',
  cancel_request: 'The customer asks to cancel a booking.',
  change_request: 'The customer asks to change a booking.',
  large_request: 'The request is larger than the assistant may take.',
  delete_request:
    'The customer asks for their data to be deleted. Answer them, then use "Delete this chat" on this page.',
};

/** A sent message is recognised in what Facebook reports back for this long. */
const ECHO_WINDOW_MS = 10 * 60 * 1000;
/** Within this time of sending, a report that only begins like the message is still taken for it. */
const JUST_SENT_MS = 30 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface Waiting {
  messages: IncomingMessage[];
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
}

/**
 * Joins the chat service to the assistant: takes each message in once, waits
 * for the customer to finish, answers at a human pace, and stays out of chats
 * a person of the team is handling.
 */
export class Bot {
  private readonly transport: Transport;
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly business: Business;
  private readonly options: BotOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: BotLog;

  private readonly waiting = new Map<string, Waiting>();
  private readonly background = new Set<Promise<void>>();
  private stopped = false;

  constructor(deps: {
    transport: Transport;
    store: Store;
    engine: Engine;
    business: Business;
    options?: Partial<BotOptions>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: BotLog;
  }) {
    this.transport = deps.transport;
    this.store = deps.store;
    this.engine = deps.engine;
    this.business = deps.business;
    this.options = { ...DEFAULT_BOT_OPTIONS, ...deps.options };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? SILENT;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.transport.start((message) => this.onMessage(message));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.waiting.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
    await this.settled();
    await this.transport.stop();
  }

  /** Resolves when every message taken in so far has been dealt with. */
  async settled(): Promise<void> {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    for (;;) {
      const busy = [...this.waiting.values()].filter((entry) => entry.timer || entry.running);
      if (busy.length === 0 && this.background.size === 0) return;
      await Promise.all([...busy.map((entry) => entry.running ?? tick()), ...this.background]);
    }
  }

  // ------------------------------------------------------------- incoming

  private onMessage(message: IncomingMessage): void {
    if (this.stopped || message.isGroup) return;
    // The chats in which the team is told of new bookings are not customers.
    if (this.options.staffThreadIds.includes(message.threadId)) return;

    try {
      if (message.fromSelf) this.onOwnMessage(message);
      else this.onCustomerMessage(message);
    } catch (error) {
      this.log.error(
        { threadId: message.threadId, error: describe(error) },
        'A message could not be taken in',
      );
    }
  }

  private onCustomerMessage(message: IncomingMessage): void {
    // Nothing written and nothing sent along: nothing to record or answer.
    if (message.text.trim() === '' && message.attachments === 0) return;
    const now = this.now();
    this.store.conversations.open(message.threadId, this.business.defaultLanguage, now);
    const recorded = this.store.messages.addReceived({
      threadId: message.threadId,
      externalId: message.messageId,
      sender: 'customer',
      text: message.text,
      attachments: message.attachments,
      at: now,
    });
    if (!recorded) return; // Facebook delivered this one before.

    const entry = this.entryFor(message.threadId);
    entry.messages.push(message);
    this.schedule(message.threadId, entry);
  }

  /** A message sent from the company's own account, as Facebook reports it back. */
  private onOwnMessage(message: IncomingMessage): void {
    const now = this.now();
    const { messages, conversations } = this.store;
    if (message.messageId !== null && messages.hasExternalId(message.messageId)) return;
    const ours = messages.adoptEcho(
      message.threadId,
      message.text,
      message.messageId,
      now - ECHO_WINDOW_MS,
      now - JUST_SENT_MS,
    );
    if (ours) return;

    // Nobody here sent it: a person of the team wrote in Messenger itself.
    // The assistant keeps out of the chat for a while.
    conversations.open(message.threadId, this.business.defaultLanguage, now);
    messages.addReceived({
      threadId: message.threadId,
      externalId: message.messageId,
      sender: 'staff',
      text: message.text,
      attachments: message.attachments,
      at: now,
    });
    conversations.pause(message.threadId, now + this.options.staffPauseMs);
    conversations.clearFlag(message.threadId);
    this.dropWaiting(message.threadId);
    this.log.info(
      { threadId: message.threadId },
      'A person wrote in the chat; the assistant steps back',
    );
  }

  private entryFor(threadId: string): Waiting {
    let entry = this.waiting.get(threadId);
    if (!entry) {
      entry = { messages: [], timer: null, running: null };
      this.waiting.set(threadId, entry);
    }
    return entry;
  }

  private schedule(threadId: string, entry: Waiting): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flush(threadId, entry);
    }, this.options.debounceMs);
  }

  private flush(threadId: string, entry: Waiting): void {
    // One answer at a time per chat; what arrives meanwhile waits its turn.
    if (entry.running || entry.messages.length === 0 || this.stopped) return;
    const batch = entry.messages.splice(0);
    entry.running = this.answer(threadId, batch)
      .catch((error) => {
        this.log.error({ threadId, error: describe(error) }, 'Answering a customer failed');
        this.store.conversations.flag(
          threadId,
          `The assistant failed while answering: ${describe(error)}`,
        );
      })
      .finally(() => {
        entry.running = null;
        if (entry.messages.length > 0) this.schedule(threadId, entry);
        else if (!entry.timer) this.waiting.delete(threadId);
      });
  }

  private dropWaiting(threadId: string): void {
    const entry = this.waiting.get(threadId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.messages.length = 0;
    if (!entry.running) this.waiting.delete(threadId);
  }

  // ------------------------------------------------------------ answering

  private async answer(threadId: string, batch: IncomingMessage[]): Promise<void> {
    const { conversations, messages } = this.store;
    let conversation = conversations.get(threadId);
    if (!conversation) return;

    if (conversation.customerName === null) {
      const name = await this.transport.nameOf(batch[0]!.senderId).catch(() => null);
      if (name) {
        conversations.setCustomerName(threadId, name);
        conversation = conversations.get(threadId)!;
      }
    }

    if (this.inHumanHands(conversation)) return;
    conversation = conversations.get(threadId)!;

    const now = this.now();
    if (messages.countBotSince(threadId, now - HOUR_MS) >= this.options.maxRepliesPerHour) {
      const reason =
        `The assistant sent ${this.options.maxRepliesPerHour} messages in this chat within an hour and has stopped. ` +
        'It may be talking to another automatic account.';
      conversations.pause(threadId, now + this.options.staffPauseMs);
      conversations.flag(threadId, reason);
      this.tellStaff(`${this.nameOf(conversation)}: ${reason}`, `/conversations/${threadId}`);
      return;
    }

    const text = batch
      .map((message) => message.text.trim())
      .filter((part) => part !== '')
      .join('\n');
    const attachments = batch.reduce((sum, message) => sum + message.attachments, 0);
    const result = this.engine.handle(
      conversation.state,
      { text, attachments, likeOnly: text === '' && batch.every((message) => message.likeOnly) },
      { threadId, lang: conversation.lang, customerName: conversation.customerName, now },
    );
    conversations.saveState(threadId, result.state, result.lang);

    if (result.booking) this.onBookingPlaced(conversation, result.booking);
    if (result.attention) {
      conversations.flag(threadId, result.attention);
      this.tellStaff(
        `${this.nameOf(conversation)}: ${result.attention}`,
        `/conversations/${threadId}`,
      );
    }
    if (result.handoff) {
      const note = HANDOFF_NOTES[result.handoff];
      conversations.pause(threadId, now + this.options.staffPauseMs);
      conversations.flag(threadId, note);
      this.tellStaff(`${this.nameOf(conversation)}: ${note}`, `/conversations/${threadId}`);
    }

    if (result.replies.length === 0) return;
    await this.transport.markRead(threadId).catch(() => undefined);
    for (const reply of result.replies) {
      await this.deliver(threadId, reply, 'bot', true);
    }
  }

  /** True while a person has the chat. Takes the chat back when their time is up. */
  private inHumanHands(conversation: Conversation): boolean {
    if (conversation.mode !== 'human') return false;
    if (conversation.pausedUntil === null || conversation.pausedUntil > this.now()) return true;
    this.store.conversations.resume(conversation.threadId);
    return false;
  }

  private onBookingPlaced(conversation: Conversation, booking: Booking): void {
    const summary = this.describeBooking(booking);
    if (booking.status === 'pending') {
      this.store.conversations.flag(
        booking.threadId,
        `Booking ${booking.code} waits to be confirmed.`,
      );
      this.tellStaff(`New booking to confirm: ${summary}`, `/bookings/${booking.code}`);
    } else {
      this.tellStaff(
        `New booking, confirmed automatically: ${summary}`,
        `/bookings/${booking.code}`,
      );
    }
    this.log.info({ code: booking.code, status: booking.status }, 'Booking placed');
  }

  private describeBooking(booking: Booking): string {
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const howMany =
      booking.serviceKind === 'rental'
        ? count(booking.quantity, 'motorbike', 'motorbikes')
        : booking.serviceKind === 'tour'
          ? count(booking.quantity, 'person', 'people')
          : count(booking.quantity, 'passenger', 'passengers');
    return (
      `${booking.code} for ${booking.customerName}. ${bookingTitle(booking, this.business)}. ` +
      `From ${formatDate(booking.startDate, 'en')}, ${count(booking.days, 'day', 'days')}, ${howMany}.`
    );
  }

  private nameOf(conversation: Conversation): string {
    return conversation.customerName ?? `Customer ${conversation.threadId}`;
  }

  /**
   * Sends one message and records how it went. A message that cannot be sent
   * is marked as failed and the chat flagged; nothing is retried by itself,
   * so that no customer gets the same message twice.
   *
   * `byPerson` says that a person of the team wrote the message or let it go
   * out from the dashboard, which Facebook allows for longer than it allows
   * the assistant's own answers.
   */
  private async deliver(
    threadId: string,
    text: string,
    sender: 'bot' | 'staff',
    paced: boolean,
    byPerson = false,
  ): Promise<boolean> {
    const { messages, conversations } = this.store;
    const message = messages.addOutgoing({ threadId, sender, text, at: this.now() });
    try {
      if (paced) {
        const { typingMsPerChar, minTypingMs, maxTypingMs } = this.options;
        const pause = Math.min(maxTypingMs, Math.max(minTypingMs, text.length * typingMsPerChar));
        if (pause > 0) {
          await this.transport.setTyping(threadId, true).catch(() => undefined);
          await this.sleep(pause);
        }
      }
      const sent = await this.transport.sendText(threadId, text, { byPerson });
      messages.markSent(message.id, sent.messageId);
      return true;
    } catch (error) {
      messages.markFailed(message.id, describe(error));
      conversations.flag(threadId, `A message could not be sent: ${describe(error)}`);
      this.log.error({ threadId, error: describe(error) }, 'A message could not be sent');
      return false;
    } finally {
      if (paced) void this.transport.setTyping(threadId, false).catch(() => undefined);
    }
  }

  /** Tells the team on Messenger. Never holds up or fails the customer's answer. */
  private tellStaff(text: string, path: string): void {
    const { staffThreadIds, dashboardUrl } = this.options;
    if (staffThreadIds.length === 0) return;
    const link = dashboardUrl ? `\n${dashboardUrl.replace(/\/$/, '')}${path}` : '';
    const task = (async () => {
      for (const staffThread of staffThreadIds) {
        try {
          await this.transport.sendText(staffThread, `${text}${link}`);
        } catch (error) {
          this.log.warn({ staffThread, error: describe(error) }, 'The team could not be told');
        }
      }
    })();
    this.background.add(task);
    void task.finally(() => this.background.delete(task));
  }

  // --------------------------------------------- what the team does itself

  /** A person answers from the dashboard. The assistant steps back from the chat. */
  async sendAsStaff(threadId: string, text: string): Promise<boolean> {
    const { conversations } = this.store;
    if (!conversations.get(threadId)) return false;
    conversations.pause(threadId, this.now() + this.options.staffPauseMs);
    conversations.clearFlag(threadId);
    this.dropWaiting(threadId);
    return this.deliver(threadId, text, 'staff', false, true);
  }

  /** A person takes the chat over until they hand it back. */
  takeOver(threadId: string): void {
    this.store.conversations.pause(threadId, null);
    this.dropWaiting(threadId);
  }

  /** The assistant answers in the chat again, starting afresh. */
  handBack(threadId: string): void {
    this.store.conversations.resume(threadId);
    this.store.conversations.clearFlag(threadId);
  }

  /** A person sends again a message that could not be sent. */
  async resend(messageId: number): Promise<boolean> {
    const message = this.store.messages.get(messageId);
    if (!message || message.status !== 'failed' || message.sender === 'customer') return false;
    return this.deliver(message.threadId, message.text, message.sender, false, true);
  }

  /**
   * Tells the customer where their booking stands now, after a person has
   * confirmed, declined or cancelled it in the dashboard.
   */
  async announce(booking: Booking): Promise<boolean> {
    const text = bookingMessage(booking, this.business);
    return this.deliver(booking.threadId, text, 'bot', false, true);
  }

  /**
   * Deletes a chat at the customer's request: its messages and what the
   * assistant remembers of it. Bookings stay, as the company's records.
   */
  forget(threadId: string): void {
    this.dropWaiting(threadId);
    this.store.conversations.forget(threadId);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
