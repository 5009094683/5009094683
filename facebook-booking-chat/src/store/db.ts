import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/*
  Each entry brings the database one version further and is applied once, in
  order. Never edit an entry that has been released: add a new one.
*/
const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversations (
    thread_id          TEXT PRIMARY KEY,
    customer_name      TEXT,
    lang               TEXT NOT NULL,
    state              TEXT NOT NULL DEFAULT '{}',
    -- 'bot': the assistant answers. 'human': a person has taken the chat over.
    mode               TEXT NOT NULL DEFAULT 'bot',
    -- With mode 'human': when the assistant takes the chat back by itself; NULL = never.
    paused_until       INTEGER,
    needs_staff        INTEGER NOT NULL DEFAULT 0,
    needs_staff_reason TEXT,
    unread             INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    last_customer_at   INTEGER,
    last_message_at    INTEGER
  );

  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   TEXT NOT NULL REFERENCES conversations(thread_id),
    -- Facebook's id of the message; a message is taken in once however often it arrives.
    external_id TEXT,
    -- 'customer' | 'bot' | 'staff'
    sender      TEXT NOT NULL,
    text        TEXT NOT NULL,
    attachments INTEGER NOT NULL DEFAULT 0,
    -- 'received' | 'pending' | 'sent' | 'failed'
    status      TEXT NOT NULL,
    error       TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX messages_external_id ON messages(external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX messages_thread ON messages(thread_id, id);

  CREATE TABLE bookings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,
    thread_id       TEXT NOT NULL REFERENCES conversations(thread_id),
    -- 'pending' | 'confirmed' | 'declined' | 'cancelled'
    status          TEXT NOT NULL,
    service_id      TEXT NOT NULL,
    service_kind    TEXT NOT NULL,
    service_name    TEXT NOT NULL,
    option_id       TEXT NOT NULL,
    option_name     TEXT NOT NULL,
    start_date      TEXT NOT NULL,
    days            INTEGER NOT NULL,
    -- Last day, inclusive.
    end_date        TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    customer_name   TEXT NOT NULL,
    phone           TEXT,
    pickup          TEXT,
    -- VND. NULL until a person has quoted the price.
    unit_price      INTEGER,
    total_price     INTEGER,
    deposit_percent INTEGER NOT NULL DEFAULT 0,
    lang            TEXT NOT NULL,
    -- 'auto' | 'staff'
    confirmed_by    TEXT,
    staff_note      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX bookings_thread ON bookings(thread_id);
  CREATE INDEX bookings_load ON bookings(service_id, option_id, status, start_date, end_date);
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database is at version ${current}, newer than this program knows (${MIGRATIONS.length}). ` +
        'Update the program before starting it on this database.',
    );
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
