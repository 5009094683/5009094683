import type { IncomingMessage, Transport, TransportStatus } from './types';

export interface SimulatedSend {
  threadId: string;
  text: string;
  messageId: string;
}

/**
 * Stands in for Facebook: customers "write" through `customerSays`, and what
 * the assistant sends is kept in `sent`. Used by the demo, the try-out page
 * and the tests. Like Facebook, it reports every message sent from the
 * company's side back to the listener.
 */
export class SimulatorTransport implements Transport {
  readonly name = 'simulator';
  readonly sent: SimulatedSend[] = [];
  /** Names shown for simulated customers, by chat. */
  readonly names = new Map<string, string>();
  /** When set, sending fails with this message: for trying out failures. */
  failSendsWith: string | null = null;
  /** When set, a sent message is reported back changed like this, and without its id. */
  reportBackAs: ((text: string) => string) | null = null;

  private onMessage: ((message: IncomingMessage) => void) | null = null;
  private counter = 0;
  private startedAt = 0;
  private lastMessageAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.startedAt = this.now();
  }

  async stop(): Promise<void> {
    this.onMessage = null;
  }

  status(): TransportStatus {
    return {
      state: this.onMessage ? 'connected' : 'stopped',
      since: this.startedAt,
      account: { id: 'simulator', name: 'Simulated page', kind: 'simulator' },
      lastError: null,
      lastMessageAt: this.lastMessageAt,
    };
  }

  async sendText(threadId: string, text: string): Promise<{ messageId: string | null }> {
    if (this.failSendsWith !== null) throw new Error(this.failSendsWith);
    const messageId = this.nextId();
    this.sent.push({ threadId, text, messageId });
    if (this.reportBackAs) {
      // As over the live Messenger connection: no id comes back from sending.
      this.emit({ threadId, senderId: 'simulator', text: this.reportBackAs(text), fromSelf: true });
      return { messageId: null };
    }
    this.emit({ threadId, senderId: 'simulator', messageId, text, fromSelf: true });
    return { messageId };
  }

  async markRead(): Promise<void> {}

  async setTyping(): Promise<void> {}

  async nameOf(userId: string): Promise<string | null> {
    return this.names.get(userId) ?? null;
  }

  /** A customer writes in a chat. */
  customerSays(
    threadId: string,
    text: string,
    extra: Partial<Pick<IncomingMessage, 'attachments' | 'likeOnly' | 'messageId'>> = {},
  ): void {
    this.emit({ threadId, senderId: threadId, text, fromSelf: false, ...extra });
  }

  /** A person of the team writes in the chat from Messenger itself, past the assistant. */
  staffWritesInMessenger(threadId: string, text: string): void {
    this.emit({ threadId, senderId: 'simulator', text, fromSelf: true });
  }

  /** What the assistant sent to a chat, oldest first. */
  sentTo(threadId: string): string[] {
    return this.sent.filter((send) => send.threadId === threadId).map((send) => send.text);
  }

  private nextId(): string {
    this.counter += 1;
    return `sim.${this.counter}`;
  }

  private emit(
    message: Pick<IncomingMessage, 'threadId' | 'senderId' | 'text' | 'fromSelf'> &
      Partial<IncomingMessage>,
  ): void {
    this.lastMessageAt = this.now();
    this.onMessage?.({
      messageId: this.nextId(),
      attachments: 0,
      likeOnly: false,
      timestamp: this.now(),
      isGroup: false,
      ...message,
    });
  }
}
