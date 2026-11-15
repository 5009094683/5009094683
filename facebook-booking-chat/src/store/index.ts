import { Bookings } from './bookings';
import { Conversations } from './conversations';
import { type Db, openDb } from './db';
import { Messages } from './messages';

export class Store {
  readonly conversations: Conversations;
  readonly messages: Messages;
  readonly bookings: Bookings;

  constructor(readonly db: Db) {
    this.conversations = new Conversations(db);
    this.messages = new Messages(db);
    this.bookings = new Bookings(db);
  }

  static open(file: string): Store {
    return new Store(openDb(file));
  }

  /** Runs several changes as one: all of them happen, or none. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  close(): void {
    this.db.close();
  }
}

export type { Booking, BookingStatus, NewBooking } from './bookings';
export { BOOKING_STATUSES } from './bookings';
export type { Conversation, ConversationMode, ConversationSummary } from './conversations';
export type { MessageStatus, Sender, StoredMessage } from './messages';
