import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  -- Tickets submitted by Roblox
  CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  TEXT UNIQUE,
    user_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    category    TEXT NOT NULL,
    explanation TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL
  );

  -- Responses to tickets. ticket_id is UNIQUE: one response per ticket, ever.
  -- acked_at marks delivery to Roblox; leased_until prevents two Roblox servers
  -- from receiving the same response at the same time.
  CREATE TABLE IF NOT EXISTS responses (
    id           TEXT PRIMARY KEY,
    ticket_id    INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
    user_id      INTEGER NOT NULL,
    response     TEXT NOT NULL,
    minutes      INTEGER NOT NULL DEFAULT 0,
    responder_id TEXT,
    created_at   INTEGER NOT NULL,
    leased_until INTEGER NOT NULL DEFAULT 0,
    acked_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_responses_pending ON responses(acked_at, leased_until);

  -- Bot: which tickets have been posted to Discord (prevents duplicate posts after restarts)
  CREATE TABLE IF NOT EXISTS discord_tickets (
    ticket_id  INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    payload    TEXT NOT NULL,
    posted_at  INTEGER
  );

  -- Bot: outgoing admin responses and their delivery state
  CREATE TABLE IF NOT EXISTS bot_responses (
    id              TEXT PRIMARY KEY,
    ticket_id       INTEGER NOT NULL UNIQUE,
    admin_id        TEXT NOT NULL,
    admin_tag       TEXT,
    response        TEXT NOT NULL,
    minutes         INTEGER NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('queued', 'sent', 'rejected')),
    last_error      TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    message_updated INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  -- Bot: cursor for polling new tickets
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function closeDb() {
  db.close();
}
