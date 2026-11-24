import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ARTIFACT_KINDS, CATEGORIES, CHANNELS, PILES, STATUSES } from "./types";

export type Db = Database.Database;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  notes        TEXT,
  category     TEXT NOT NULL DEFAULT 'other' CHECK (category IN (${list(CATEGORIES)})),
  pile         TEXT CHECK (pile IN (${list(PILES)})),
  priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  rationale    TEXT,
  status       TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN (${list(STATUSES)})),
  agent        TEXT,
  summary      TEXT,
  deliverable  TEXT,
  verdict      TEXT CHECK (verdict IN ('pass', 'flag')),
  review_notes TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS steps (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN (${list(ARTIFACT_KINDS)})),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The approval gate. There is deliberately no 'sent' status: nothing in this app can send.
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN (${list(CHANNELS)})),
  recipient  TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  verdict    TEXT NOT NULL CHECK (verdict IN ('pass', 'revise', 'flag')),
  issues     TEXT NOT NULL DEFAULT '[]',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  task_id INTEGER,
  agent   TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('info', 'start', 'done', 'error', 'review')),
  message TEXT NOT NULL
);

-- Model router: providers, their keys, and the (key, model) pool the agent draws from.
CREATE TABLE IF NOT EXISTS llm_providers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  preset    TEXT NOT NULL,
  base_url  TEXT NOT NULL UNIQUE,
  free_only INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  key_value   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_error  TEXT
);

CREATE TABLE IF NOT EXISTS llm_models (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id         INTEGER NOT NULL REFERENCES llm_keys(id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  priority       INTEGER NOT NULL DEFAULT 100,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cooling_down', 'disabled')),
  cooldown_until TEXT,
  last_error     TEXT,
  UNIQUE (key_id, model_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  role        TEXT NOT NULL,
  provider    TEXT,
  model       TEXT,
  key_label   TEXT,
  status_code INTEGER NOT NULL,
  latency_ms  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
`;

export function openDb(file: string = process.env.TODO_DB || ":memory:"): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(/* turbopackIgnore: true */ file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
