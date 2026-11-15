/** A message as it arrives from the chat service. */
export interface IncomingMessage {
  /** The chat. In a one-to-one chat this is the other person's id. */
  threadId: string;
  senderId: string;
  /** The service's own id of the message, when it gives one. */
  messageId: string | null;
  text: string;
  /** Photos, stickers, files and voice clips sent with the message. */
  attachments: number;
  /** The message is nothing but the thumbs-up button. */
  likeOnly: boolean;
  timestamp: number;
  /**
   * Sent from the company's own account: by the assistant, or by a person of
   * the team writing in Messenger itself.
   */
  fromSelf: boolean;
  isGroup: boolean;
}

export type TransportState = 'starting' | 'connected' | 'disconnected' | 'stopped';

export interface TransportStatus {
  state: TransportState;
  /** When it entered this state. */
  since: number;
  /** The account the assistant answers as, once known. */
  account: { id: string; name: string | null; kind: 'page' | 'profile' | 'simulator' } | null;
  lastError: string | null;
  lastMessageAt: number | null;
}

/**
 * The connection to the chat service. The assistant knows nothing of Facebook
 * beyond this: another way of connecting is another implementation of it.
 */
export interface Transport {
  readonly name: string;
  /** Connects and keeps connected. Trouble shows in `status()`, not as a thrown error. */
  start(onMessage: (message: IncomingMessage) => void): Promise<void>;
  stop(): Promise<void>;
  status(): TransportStatus;
  /** Throws when the message could not be handed to the service. */
  sendText(threadId: string, text: string): Promise<{ messageId: string | null }>;
  markRead(threadId: string): Promise<void>;
  setTyping(threadId: string, typing: boolean): Promise<void>;
  /** The name of a person as the service shows it, or null when it cannot be had. */
  nameOf(userId: string): Promise<string | null>;
}
