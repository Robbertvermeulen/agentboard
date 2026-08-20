import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export const STATUSES = ['inbox', 'ready', 'doing', 'needs_input', 'review', 'done', 'archived'] as const;
export const TYPES = ['task', 'ops'] as const;
export const ACTORS = ['human', 'agent'] as const;
export const EVENT_KINDS = ['status_changed', 'action_taken', 'context_written', 'error'] as const;

export type Status = (typeof STATUSES)[number];
export type CardType = (typeof TYPES)[number];
export type Actor = (typeof ACTORS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];

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
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL REFERENCES card(id),
  author     TEXT NOT NULL CHECK (author IN ('human','agent')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL REFERENCES card(id),
  kind       TEXT NOT NULL CHECK (kind IN ('status_changed','action_taken','context_written','error')),
  actor      TEXT NOT NULL CHECK (actor IN ('human','agent')),
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
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
  db.exec(SCHEMA);

  // Migration: card tables from before multi-board lack board_id. The
  // column is added without a REFERENCES clause (SQLite cannot add a
  // NOT NULL FK column to a filled table); core validates board ids.
  const cardCols = db.prepare('PRAGMA table_info(card)').all() as { name: string }[];
  if (!cardCols.some((c) => c.name === 'board_id')) {
    db.exec(`ALTER TABLE card ADD COLUMN board_id TEXT NOT NULL DEFAULT '${boardId}'`);
    created.push(`card.board_id (existing cards -> board '${boardId}')`);
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
