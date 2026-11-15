import type { Db } from './db';

export type Sender = 'customer' | 'bot' | 'staff';
export type MessageStatus = 'received' | 'pending' | 'sent' | 'failed';

export interface StoredMessage {
  id: number;
  threadId: string;
  externalId: string | null;
  sender: Sender;
  text: string;
  attachments: number;
  status: MessageStatus;
  error: string | null;
  createdAt: number;
}

interface Row {
  id: number;
  thread_id: string;
  external_id: string | null;
  sender: string;
  text: string;
  attachments: number;
  status: string;
  error: string | null;
  created_at: number;
}

function fromRow(row: Row): StoredMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    externalId: row.external_id,
    sender: row.sender as Sender,
    text: row.text,
    attachments: row.attachments,
    status: row.status as MessageStatus,
    error: row.error,
    createdAt: row.created_at,
  };
}

export class Messages {
  constructor(private readonly db: Db) {}

  /**
   * Records a message that arrived from Facebook: from the customer, or typed
   * by a person of the team in Messenger itself. Returns undefined when this
   * very message was recorded before (Facebook delivers some twice).
   */
  addReceived(input: {
    threadId: string;
    externalId: string | null;
    sender: 'customer' | 'staff';
    text: string;
    attachments: number;
    at: number;
  }): StoredMessage | undefined {
    return this.db.transaction(() => {
      if (input.externalId !== null) {
        const seen = this.db
          .prepare('SELECT 1 FROM messages WHERE external_id = ?')
          .get(input.externalId);
        if (seen) return undefined;
      }
      const id = this.insert(input.threadId, input.externalId, input.sender, input.text, input.attachments, 'received', input.at); // prettier-ignore
      if (input.sender === 'customer') {
        this.db
          .prepare(
            `UPDATE conversations
                SET unread = unread + 1, last_customer_at = ?, last_message_at = ?
              WHERE thread_id = ?`,
          )
          .run(input.at, input.at, input.threadId);
      } else {
        this.touch(input.threadId, input.at);
      }
      return this.get(id)!;
    })();
  }

  /** Records a message about to be sent; `markSent` or `markFailed` follows. */
  addOutgoing(input: {
    threadId: string;
    sender: 'bot' | 'staff';
    text: string;
    at: number;
  }): StoredMessage {
    return this.db.transaction(() => {
      const id = this.insert(
        input.threadId,
        null,
        input.sender,
        input.text,
        0,
        'pending',
        input.at,
      );
      this.touch(input.threadId, input.at);
      return this.get(id)!;
    })();
  }

  markSent(id: number, externalId: string | null): void {
    if (externalId !== null) {
      // The echo of this message may have been recorded first; keep one row.
      const echo = this.db
        .prepare('SELECT id FROM messages WHERE external_id = ? AND id <> ?')
        .get(externalId, id) as { id: number } | undefined;
      if (echo) this.db.prepare('DELETE FROM messages WHERE id = ?').run(echo.id);
    }
    this.db
      .prepare(
        `UPDATE messages SET status = 'sent', external_id = COALESCE(?, external_id) WHERE id = ?`,
      )
      .run(externalId, id);
  }

  markFailed(id: number, error: string): void {
    this.db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).run(error, id);
  }

  get(id: number): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  hasExternalId(externalId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM messages WHERE external_id = ?').get(externalId) !== undefined
    );
  }

  /** The messages of a chat, oldest first; with `afterId`, only newer ones. */
  list(threadId: string, afterId = 0, limit = 500): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id`,
      )
      .all(threadId, afterId, limit) as Row[];
    return rows.map(fromRow);
  }

  /** How many messages the assistant sent in this chat since a time. */
  countBotSince(threadId: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE thread_id = ? AND sender = 'bot' AND status <> 'failed' AND created_at >= ?`,
      )
      .get(threadId, since) as { n: number };
    return row.n;
  }

  private insert(
    threadId: string,
    externalId: string | null,
    sender: Sender,
    text: string,
    attachments: number,
    status: MessageStatus,
    at: number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO messages (thread_id, external_id, sender, text, attachments, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, externalId, sender, text, attachments, status, at);
    return Number(result.lastInsertRowid);
  }

  private touch(threadId: string, at: number): void {
    this.db
      .prepare('UPDATE conversations SET last_message_at = ? WHERE thread_id = ?')
      .run(at, threadId);
  }
}
