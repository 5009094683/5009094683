import type { Lang } from '../business/schema';
import type { Db } from './db';

export type ConversationMode = 'bot' | 'human';

export interface Conversation {
  threadId: string;
  customerName: string | null;
  lang: Lang;
  /** What the assistant remembers of the chat, as it wrote it. */
  state: unknown;
  mode: ConversationMode;
  pausedUntil: number | null;
  needsStaff: boolean;
  needsStaffReason: string | null;
  unread: number;
  createdAt: number;
  lastCustomerAt: number | null;
  lastMessageAt: number | null;
}

interface Row {
  thread_id: string;
  customer_name: string | null;
  lang: string;
  state: string;
  mode: string;
  paused_until: number | null;
  needs_staff: number;
  needs_staff_reason: string | null;
  unread: number;
  created_at: number;
  last_customer_at: number | null;
  last_message_at: number | null;
}

function fromRow(row: Row): Conversation {
  let state: unknown = {};
  try {
    state = JSON.parse(row.state);
  } catch {
    // A state that cannot be read is a chat that starts afresh.
  }
  return {
    threadId: row.thread_id,
    customerName: row.customer_name,
    lang: row.lang === 'vi' ? 'vi' : 'en',
    state,
    mode: row.mode === 'human' ? 'human' : 'bot',
    pausedUntil: row.paused_until,
    needsStaff: row.needs_staff === 1,
    needsStaffReason: row.needs_staff_reason,
    unread: row.unread,
    createdAt: row.created_at,
    lastCustomerAt: row.last_customer_at,
    lastMessageAt: row.last_message_at,
  };
}

export interface ConversationSummary extends Conversation {
  lastText: string | null;
  lastSender: string | null;
}

export class Conversations {
  constructor(private readonly db: Db) {}

  get(threadId: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE thread_id = ?').get(threadId) as
      Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** The chat with this customer, started now if there was none. */
  open(threadId: string, lang: Lang, now: number): Conversation {
    this.db
      .prepare(
        `INSERT INTO conversations (thread_id, lang, created_at) VALUES (?, ?, ?)
         ON CONFLICT (thread_id) DO NOTHING`,
      )
      .run(threadId, lang, now);
    return this.get(threadId)!;
  }

  saveState(threadId: string, state: unknown, lang: Lang): void {
    this.db
      .prepare('UPDATE conversations SET state = ?, lang = ? WHERE thread_id = ?')
      .run(JSON.stringify(state), lang, threadId);
  }

  setCustomerName(threadId: string, name: string): void {
    this.db
      .prepare('UPDATE conversations SET customer_name = ? WHERE thread_id = ?')
      .run(name, threadId);
  }

  /** A person takes the chat over, for good (`until` null) or until a time. */
  pause(threadId: string, until: number | null): void {
    this.db
      .prepare(`UPDATE conversations SET mode = 'human', paused_until = ? WHERE thread_id = ?`)
      .run(until, threadId);
  }

  /** The assistant answers again. What it remembered of the chat is dropped. */
  resume(threadId: string): void {
    this.db
      .prepare(
        `UPDATE conversations SET mode = 'bot', paused_until = NULL, state = '{}' WHERE thread_id = ?`,
      )
      .run(threadId);
  }

  flag(threadId: string, reason: string): void {
    this.db
      .prepare(
        'UPDATE conversations SET needs_staff = 1, needs_staff_reason = ? WHERE thread_id = ?',
      )
      .run(reason, threadId);
  }

  clearFlag(threadId: string): void {
    this.db
      .prepare(
        'UPDATE conversations SET needs_staff = 0, needs_staff_reason = NULL WHERE thread_id = ?',
      )
      .run(threadId);
  }

  markRead(threadId: string): void {
    this.db.prepare('UPDATE conversations SET unread = 0 WHERE thread_id = ?').run(threadId);
  }

  list(limit = 200): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, m.text AS last_text, m.sender AS last_sender
           FROM conversations c
           LEFT JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE thread_id = c.thread_id)
          ORDER BY c.needs_staff DESC, COALESCE(c.last_message_at, c.created_at) DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Row & { last_text: string | null; last_sender: string | null }>;
    return rows.map((row) => ({
      ...fromRow(row),
      lastText: row.last_text,
      lastSender: row.last_sender,
    }));
  }

  countNeedingStaff(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE needs_staff = 1')
      .get() as { n: number };
    return row.n;
  }
}
