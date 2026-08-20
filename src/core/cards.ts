import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ACTORS,
  Actor,
  CardType,
  EventKind,
  STATUSES,
  Status,
  TYPES,
  now,
  openDb,
} from './db.js';

export interface Board {
  id: string;
  name: string;
  created_at: string;
}

export interface Card {
  id: string;
  board_id: string;
  type: CardType;
  title: string;
  body: string | null;
  status: Status;
  owner: Actor;
  labels: string[];
  refs: unknown[];
  context_refs: string[];
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  card_id: string;
  author: Actor;
  body: string;
  created_at: string;
}

export interface BoardEvent {
  id: number;
  card_id: string;
  kind: EventKind;
  actor: Actor;
  payload: Record<string, unknown>;
  created_at: string;
}

function assertOneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid ${what} '${value}'. Allowed: ${allowed.join(', ')}`);
  }
  return value as T;
}

export const assertStatus = (v: string) => assertOneOf(v, STATUSES, 'status');
export const assertActor = (v: string) => assertOneOf(v, ACTORS, 'actor');
export const assertType = (v: string) => assertOneOf(v, TYPES, 'type');

function rowToCard(row: any): Card {
  return {
    ...row,
    labels: JSON.parse(row.labels),
    refs: JSON.parse(row.refs),
    context_refs: JSON.parse(row.context_refs),
  };
}

function rowToEvent(row: any): BoardEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}

function getCardIn(db: Database.Database, id: string): Card {
  const row = db.prepare('SELECT * FROM card WHERE id = ?').get(id);
  if (!row) throw new Error(`Card not found: ${id}`);
  return rowToCard(row);
}

export function addEventIn(
  db: Database.Database,
  cardId: string,
  kind: EventKind,
  actor: Actor,
  payload: Record<string, unknown>
): void {
  db.prepare('INSERT INTO event (card_id, kind, actor, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(
    cardId,
    kind,
    actor,
    JSON.stringify(payload),
    now()
  );
}

export function listBoards(): Board[] {
  const db = openDb();
  try {
    return db.prepare('SELECT * FROM board ORDER BY created_at').all() as Board[];
  } finally {
    db.close();
  }
}

export function createBoard(id: string, name?: string): Board {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid board id '${id}'. Use a slug: lowercase letters, digits, dashes`);
  }
  const db = openDb();
  try {
    if (db.prepare('SELECT 1 FROM board WHERE id = ?').get(id)) {
      throw new Error(`Board '${id}' already exists`);
    }
    db.prepare('INSERT INTO board (id, name, created_at) VALUES (?, ?, ?)').run(id, name ?? id, now());
    return db.prepare('SELECT * FROM board WHERE id = ?').get(id) as Board;
  } finally {
    db.close();
  }
}

// No board given: unambiguous with one board, an error with more.
function resolveBoardIn(db: Database.Database, boardId?: string): string {
  const boards = db.prepare('SELECT id FROM board ORDER BY created_at').all() as { id: string }[];
  if (boards.length === 0) throw new Error("No boards yet. Run 'agentboard init' first.");
  if (boardId) {
    if (!boards.some((b) => b.id === boardId)) {
      throw new Error(`Unknown board '${boardId}'. Boards: ${boards.map((b) => b.id).join(', ')}`);
    }
    return boardId;
  }
  if (boards.length === 1) return boards[0].id;
  throw new Error(`Multiple boards (${boards.map((b) => b.id).join(', ')}). Pass --board`);
}

export function createCard(input: {
  type: string;
  title: string;
  body?: string;
  owner?: string;
  board?: string;
}): Card {
  const type = assertType(input.type);
  const owner = assertActor(input.owner ?? 'human');
  if (!input.title.trim()) throw new Error('Title cannot be empty');

  const db = openDb();
  try {
    const boardId = resolveBoardIn(db, input.board);
    let id: string;
    do {
      id = `${type}_${crypto.randomBytes(2).toString('hex')}`;
    } while (db.prepare('SELECT 1 FROM card WHERE id = ?').get(id));

    const ts = now();
    db.prepare(
      `INSERT INTO card (id, board_id, type, title, body, status, owner, labels, refs, context_refs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'inbox', ?, '[]', '[]', '[]', ?, ?)`
    ).run(id, boardId, type, input.title, input.body ?? null, owner, ts, ts);
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}

export function getCard(id: string): Card {
  const db = openDb();
  try {
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}

// Board is the working view: every status except archived (invariant 4 keeps
// archived cards around forever, they would swamp the board). No boardId:
// all boards, so the morning scan stays one command.
export function boardView(boardId?: string): { board: Board; columns: Partial<Record<Status, Card[]>> }[] {
  const db = openDb();
  try {
    let boards = db.prepare('SELECT * FROM board ORDER BY created_at').all() as Board[];
    if (boardId) {
      boards = boards.filter((b) => b.id === boardId);
      if (boards.length === 0) throw new Error(`Unknown board '${boardId}'`);
    }
    return boards.map((board) => {
      const rows = db
        .prepare("SELECT * FROM card WHERE board_id = ? AND status != 'archived' ORDER BY updated_at DESC")
        .all(board.id)
        .map(rowToCard);
      const columns: Partial<Record<Status, Card[]>> = {};
      for (const status of STATUSES) {
        if (status === 'archived') continue;
        columns[status] = rows.filter((c) => c.status === status);
      }
      return { board, columns };
    });
  } finally {
    db.close();
  }
}

export function moveCard(id: string, to: string, opts: { actor: string; reason: string }): Card {
  const status = assertStatus(to);
  const actor = assertActor(opts.actor);
  if (!opts.reason?.trim()) throw new Error('A reason is required for every status change');
  // Invariant 2: an agent never moves a card to done, only to review.
  if (actor === 'agent' && status === 'done') {
    throw new Error("An agent may not move a card to 'done'. Move it to 'review'; the human moves it to done.");
  }

  const db = openDb();
  try {
    const card = getCardIn(db, id);
    const move = db.transaction(() => {
      db.prepare('UPDATE card SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
      // Invariant 1: every status change writes an event with from, to, reason.
      addEventIn(db, id, 'status_changed', actor, { from: card.status, to: status, reason: opts.reason });
    });
    move();
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}

export function addComment(id: string, body: string, author: string): Comment {
  const a = assertActor(author);
  if (!body.trim()) throw new Error('Comment cannot be empty');
  const db = openDb();
  try {
    getCardIn(db, id);
    const result = db
      .prepare('INSERT INTO comment (card_id, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(id, a, body, now());
    return db.prepare('SELECT * FROM comment WHERE id = ?').get(result.lastInsertRowid) as Comment;
  } finally {
    db.close();
  }
}

export function editCard(
  id: string,
  fields: {
    title?: string;
    body?: string;
    labels?: string[];
    refs?: unknown[];
    contextRefs?: string[];
    board?: string;
  }
): Card {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.title !== undefined) {
    if (!fields.title.trim()) throw new Error('Title cannot be empty');
    sets.push('title = ?');
    values.push(fields.title);
  }
  if (fields.body !== undefined) {
    sets.push('body = ?');
    values.push(fields.body);
  }
  if (fields.labels !== undefined) {
    sets.push('labels = ?');
    values.push(JSON.stringify(fields.labels));
  }
  if (fields.refs !== undefined) {
    if (!Array.isArray(fields.refs)) throw new Error('refs must be a JSON array');
    sets.push('refs = ?');
    values.push(JSON.stringify(fields.refs));
  }
  if (fields.contextRefs !== undefined) {
    sets.push('context_refs = ?');
    values.push(JSON.stringify(fields.contextRefs));
  }
  if (sets.length === 0 && fields.board === undefined) {
    throw new Error('Nothing to edit. Pass --title, --body, --labels, --refs, --context-refs or --board');
  }

  const db = openDb();
  try {
    getCardIn(db, id);
    if (fields.board !== undefined) {
      sets.push('board_id = ?');
      values.push(resolveBoardIn(db, fields.board));
    }
    sets.push('updated_at = ?');
    values.push(now(), id);
    db.prepare(`UPDATE card SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}

// AGENT.md rule 6: the agent logs what it did as events. Only action_taken
// and error are free-form; status_changed and context_written stay reserved
// for the invariants in core.
export function logEvent(id: string, kind: string, actor: string, note: string): BoardEvent {
  if (kind !== 'action_taken' && kind !== 'error') {
    throw new Error(`Invalid event kind '${kind}'. Loggable: action_taken, error`);
  }
  const a = assertActor(actor);
  if (!note.trim()) throw new Error('Event note cannot be empty');
  const db = openDb();
  try {
    getCardIn(db, id);
    addEventIn(db, id, kind, a, { note });
    return rowToEvent(db.prepare('SELECT * FROM event WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id));
  } finally {
    db.close();
  }
}

// Worklist for an agent session (and the cheap gate for a cron trigger:
// empty list = no session). ready = new work, doing@agent = resumable,
// needs_input = possibly self-unblockable via a wait-check in the timeline.
export function nextWork(): Card[] {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT * FROM card
         WHERE status = 'ready' OR status = 'needs_input'
            OR (status = 'doing' AND owner = 'agent')
         ORDER BY updated_at ASC`
      )
      .all()
      .map(rowToCard);
  } finally {
    db.close();
  }
}

export function cardDetail(id: string): { card: Card; comments: Comment[]; events: BoardEvent[] } {
  const db = openDb();
  try {
    const card = getCardIn(db, id);
    const comments = db
      .prepare('SELECT * FROM comment WHERE card_id = ? ORDER BY created_at, id')
      .all(id) as Comment[];
    const events = db
      .prepare('SELECT * FROM event WHERE card_id = ? ORDER BY created_at, id')
      .all(id)
      .map(rowToEvent);
    return { card, comments, events };
  } finally {
    db.close();
  }
}
