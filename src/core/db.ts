import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export const STATUSES = ['inbox', 'ready', 'doing', 'needs_input', 'review', 'done', 'archived'] as const;
export const TYPES = ['task', 'ops'] as const;
export const ACTORS = ['human', 'agent'] as const;
export const EVENT_KINDS = [
  'status_changed',
  'action_taken',
  'context_written',
  'error',
  'upload_added',
  'secret_stored',
  'blocker_added',
] as const;

export type Status = (typeof STATUSES)[number];
export type CardType = (typeof TYPES)[number];
export type Actor = (typeof ACTORS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];

// Shared between SCHEMA and the event-table rebuild in initData: the CHECK
// must list every event kind, and SQLite cannot alter a CHECK in place.
const EVENT_TABLE_BODY = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL REFERENCES card(id),
  kind       TEXT NOT NULL CHECK (kind IN (${EVENT_KINDS.map((k) => `'${k}'`).join(',')})),
  actor      TEXT NOT NULL CHECK (actor IN ('human','agent')),
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS board (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('task','ops')),
  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL CHECK (status IN ('inbox','ready','doing','needs_input','review','done','archived')),
  owner         TEXT NOT NULL CHECK (owner IN ('human','agent')),
  labels        TEXT NOT NULL DEFAULT '[]',
  refs          TEXT NOT NULL DEFAULT '[]',
  context_refs  TEXT NOT NULL DEFAULT '[]',
  blocked_by    TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL REFERENCES card(id),
  author     TEXT NOT NULL CHECK (author IN ('human','agent')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS event (${EVENT_TABLE_BODY});
`;

export function dataDir(): string {
  return process.env.AGENTBOARD_DATA || path.join(os.homedir(), '.agentboard');
}

export function contextDir(): string {
  return path.join(dataDir(), 'context');
}

export function secretsPath(): string {
  return path.join(dataDir(), 'secrets.env');
}

export function dbPath(): string {
  return path.join(dataDir(), 'board.db');
}

export function now(): string {
  return new Date().toISOString();
}

export function openDb(): Database.Database {
  if (!fs.existsSync(dbPath())) {
    throw new Error(`Not initialized at ${dataDir()}. Run 'agentboard init' first.`);
  }
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export async function initData(opts?: {
  defaultBoard?: string;
  defaultBoardName?: string;
}): Promise<{ dataDir: string; created: string[] }> {
  const dir = dataDir();
  const created: string[] = [];

  const boardId = opts?.defaultBoard ?? 'main';
  if (!/^[a-z0-9-]+$/.test(boardId)) {
    throw new Error(`Invalid board id '${boardId}'. Use a slug: lowercase letters, digits, dashes`);
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
  }

  if (!fs.existsSync(dbPath())) {
    created.push(dbPath());
  }
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  // Migration: card tables from before multi-board lack board_id. The
  // column is added without a REFERENCES clause (SQLite cannot add a
  // NOT NULL FK column to a filled table); core validates board ids.
  const cardCols = db.prepare('PRAGMA table_info(card)').all() as { name: string }[];
  if (!cardCols.some((c) => c.name === 'board_id')) {
    db.exec(`ALTER TABLE card ADD COLUMN board_id TEXT NOT NULL DEFAULT '${boardId}'`);
    created.push(`card.board_id (existing cards -> board '${boardId}')`);
  }

  // Migration: card tables from before blockers lack blocked_by.
  if (!cardCols.some((c) => c.name === 'blocked_by')) {
    db.exec("ALTER TABLE card ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'");
    created.push('card.blocked_by');
  }

  // Migration: comment tables from before comment editing lack updated_at.
  const commentCols = db.prepare('PRAGMA table_info(comment)').all() as { name: string }[];
  if (!commentCols.some((c) => c.name === 'updated_at')) {
    db.exec('ALTER TABLE comment ADD COLUMN updated_at TEXT');
    created.push('comment.updated_at');
  }

  // Migration: event tables with outdated kind checks. SQLite cannot alter a
  // CHECK constraint, so rebuild the table once in one transaction if any kind
  // is missing. Table rewrite per SQLite's schema-change pattern; FK-disabled
  // to allow tampered/orphaned rows without crashing init. Idempotent.
  const eventSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'event'").get() as { sql: string } | undefined)
    ?.sql;
  if (eventSql && EVENT_KINDS.some((k) => !eventSql.includes(`'${k}'`))) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE event_new (${EVENT_TABLE_BODY});
      INSERT INTO event_new (id, card_id, kind, actor, payload, created_at)
        SELECT id, card_id, kind, actor, payload, created_at FROM event;
      DROP TABLE event;
      ALTER TABLE event_new RENAME TO event;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
    created.push('event table rebuilt (event kinds brought up to date)');
  }
  if (!db.prepare('SELECT 1 FROM board LIMIT 1').get()) {
    db.prepare('INSERT INTO board (id, name, created_at) VALUES (?, ?, ?)').run(
      boardId,
      opts?.defaultBoardName ?? boardId,
      now()
    );
    created.push(`board '${boardId}'`);
  }
  db.close();

  if (!fs.existsSync(secretsPath())) {
    fs.writeFileSync(secretsPath(), '# name=value, chmod 600, never in git\n', { mode: 0o600 });
    created.push(secretsPath());
  }

  if (!fs.existsSync(contextDir())) {
    fs.mkdirSync(contextDir(), { recursive: true });
    created.push(contextDir());
  }
  if (!fs.existsSync(path.join(contextDir(), '.git'))) {
    await simpleGit(contextDir()).init();
    created.push(path.join(contextDir(), '.git'));
  }

  return { dataDir: dir, created };
}
