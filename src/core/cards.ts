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
  blocked_by: string[];
  routine: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  card_id: string;
  author: Actor;
  body: string;
  created_at: string;
  updated_at: string | null;
}

export interface BoardEvent {
  id: number;
  card_id: string;
  kind: EventKind;
  actor: Actor;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface BlockerInfo {
  id: string;
  type: CardType;
  title: string;
  status: Status;
}

// Card plus how-it-got-here: reason and moment of the last status change.
// No status_changed event yet (card still in inbox) -> created_at, null.
export interface EnrichedCard extends Card {
  status_reason: string | null;
  status_since: string;
  blockers: BlockerInfo[];
  wait_check: string | null;
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

export function blockerInfoIn(db: Database.Database, ids: string[]): BlockerInfo[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, type, title, status FROM card WHERE id IN (${placeholders})`)
    .all(ids) as BlockerInfo[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is BlockerInfo => r !== undefined);
}

export const isOpenStatus = (s: Status) => s !== 'done' && s !== 'archived';

// Latest check_after per card (vision besluit H): a needs_input card with a
// live wait-check is "waiting on external" — not the user's turn, and only
// the scheduler brings it back once the check time passes. Scoped to events
// after the card's latest status_changed: a stale check_after left over
// from an earlier needs_input episode must not govern the card again.
function waitCheckIn(db: Database.Database, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const since = new Map(
    (
      db
        .prepare(
          `SELECT card_id, MAX(id) AS id FROM event WHERE card_id IN (${placeholders}) AND kind = 'status_changed' GROUP BY card_id`
        )
        .all(ids) as { card_id: string; id: number }[]
    ).map((r) => [r.card_id, r.id])
  );
  const rows = db
    .prepare(
      `SELECT id, card_id, payload FROM event WHERE card_id IN (${placeholders}) AND kind = 'action_taken' ORDER BY id`
    )
    .all(ids) as { id: number; card_id: string; payload: string }[];
  const latest = new Map<string, string>();
  for (const r of rows) {
    const cutoff = since.get(r.card_id);
    if (cutoff !== undefined && r.id <= cutoff) continue; // from a previous needs_input episode
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    if (typeof p.check_after === 'string') latest.set(r.card_id, p.check_after);
  }
  return latest;
}

function rowToCard(row: any): Card {
  return {
    ...row,
    labels: JSON.parse(row.labels),
    refs: JSON.parse(row.refs),
    context_refs: JSON.parse(row.context_refs),
    blocked_by: JSON.parse(row.blocked_by ?? '[]'),
  };
}

function rowToEvent(row: any): BoardEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}

function enrichCardsIn(db: Database.Database, cards: Card[]): EnrichedCard[] {
  if (cards.length === 0) return [];
  const placeholders = cards.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.card_id, e.payload, e.created_at FROM event e
       JOIN (SELECT card_id, MAX(id) AS id FROM event WHERE kind = 'status_changed' GROUP BY card_id) last
         ON e.id = last.id
       WHERE e.card_id IN (${placeholders})`
    )
    .all(cards.map((c) => c.id)) as { card_id: string; payload: string; created_at: string }[];
  const lastChange = new Map(rows.map((r) => [r.card_id, r]));
  const blockerIds = [...new Set(cards.flatMap((c) => c.blocked_by))];
  const blockerById = new Map(blockerInfoIn(db, blockerIds).map((b) => [b.id, b]));
  const waits = waitCheckIn(db, cards.filter((c) => c.status === 'needs_input').map((c) => c.id));
  return cards.map((card) => {
    const last = lastChange.get(card.id);
    const reason = last ? JSON.parse(last.payload).reason : null;
    return {
      ...card,
      status_reason: typeof reason === 'string' ? reason : null,
      status_since: last ? last.created_at : card.created_at,
      blockers: card.blocked_by.map((id) => blockerById.get(id)).filter((b): b is BlockerInfo => b !== undefined),
      wait_check: waits.get(card.id) ?? null,
    };
  });
}

function getCardIn(db: Database.Database, id: string): Card {
  const row = db.prepare('SELECT * FROM card WHERE id = ?').get(id);
  if (!row) throw new Error(`Card not found: ${id}`);
  return rowToCard(row);
}

// A cycle in blocked_by would silently keep both cards out of next forever
// (open-ness is derived, nothing errors). Refuse it at write time.
function assertNoBlockerCycle(db: Database.Database, cardId: string, blockedBy: string[]): void {
  const seen = new Set<string>();
  const stack = [...blockedBy];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === cardId) {
      throw new Error(`Blocker cycle: ${cardId} would (transitively) block itself`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    const row = db.prepare('SELECT blocked_by FROM card WHERE id = ?').get(cur) as
      | { blocked_by: string }
      | undefined;
    if (row) stack.push(...(JSON.parse(row.blocked_by) as string[]));
  }
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
  labels?: string[];
  blocks?: string;
  actor?: string;
  routine?: string;
}): Card {
  const type = assertType(input.type);
  const owner = assertActor(input.owner ?? 'human');
  const actor = assertActor(input.actor ?? 'human');
  if (!input.title.trim()) throw new Error('Title cannot be empty');

  const db = openDb();
  try {
    const boardId = resolveBoardIn(db, input.board);
    let id: string;
    do {
      id = `${type}_${crypto.randomBytes(2).toString('hex')}`;
    } while (db.prepare('SELECT 1 FROM card WHERE id = ?').get(id));

    const ts = now();
    // --blocks is one transaction: card + blocked_by append + event, or nothing.
    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO card (id, board_id, type, title, body, status, owner, labels, refs, context_refs, routine, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?)`
      ).run(
        id,
        boardId,
        type,
        input.title,
        input.body ?? null,
        // Routine cards start in ready: the approval happened on the routine
        // itself, and this keeps "only the user moves inbox -> ready" intact.
        input.routine ? 'ready' : 'inbox',
        owner,
        JSON.stringify(input.labels ?? []),
        input.routine ?? null,
        ts,
        ts
      );
      if (input.blocks) {
        const target = getCardIn(db, input.blocks);
        db.prepare('UPDATE card SET blocked_by = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify([...target.blocked_by, id]),
          ts,
          target.id
        );
        addEventIn(db, target.id, 'blocker_added', actor, { blocker: id });
      }
    });
    create.immediate();
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
export function boardView(boardId?: string): { board: Board; columns: Partial<Record<Status, EnrichedCard[]>> }[] {
  const db = openDb();
  try {
    let boards = db.prepare('SELECT * FROM board ORDER BY created_at').all() as Board[];
    if (boardId) {
      boards = boards.filter((b) => b.id === boardId);
      if (boards.length === 0) throw new Error(`Unknown board '${boardId}'`);
    }
    return boards.map((board) => {
      const rows = enrichCardsIn(
        db,
        db
          .prepare("SELECT * FROM card WHERE board_id = ? AND status != 'archived' ORDER BY updated_at DESC")
          .all(board.id)
          .map(rowToCard)
      );
      const columns: Partial<Record<Status, EnrichedCard[]>> = {};
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

// Dedup tooling (vision besluit E): the anti-duplicate rule only works if
// the check is cheap. --ref is the watcher key, --routine the job key.
export function listCards(filter: { ref?: string; routine?: string; board?: string }): Card[] {
  if (!filter.ref && !filter.routine) {
    throw new Error('Pass --ref <text> and/or --routine <path>');
  }
  const db = openDb();
  try {
    if (filter.board) resolveBoardIn(db, filter.board);
    const rows = (
      filter.board
        ? db.prepare('SELECT * FROM card WHERE board_id = ? ORDER BY updated_at DESC').all(filter.board)
        : db.prepare('SELECT * FROM card ORDER BY updated_at DESC').all()
    ).map(rowToCard);
    const ref = filter.ref?.toLowerCase();
    return rows.filter(
      (c) =>
        (!ref || JSON.stringify(c.refs).toLowerCase().includes(ref)) &&
        (!filter.routine || c.routine === filter.routine)
    );
  } finally {
    db.close();
  }
}

// Archived cards of one board, newest first. Same enrichment as boardView:
// the archive shows why and when a card was put away (invariant 4 keeps them).
export function archivedCards(boardId: string): EnrichedCard[] {
  const db = openDb();
  try {
    resolveBoardIn(db, boardId);
    return enrichCardsIn(
      db,
      db
        .prepare("SELECT * FROM card WHERE board_id = ? AND status = 'archived' ORDER BY updated_at DESC")
        .all(boardId)
        .map(rowToCard)
    );
  } finally {
    db.close();
  }
}

export function moveCard(id: string, to: string, opts: { actor: string; reason: string; from?: string }): Card {
  const status = assertStatus(to);
  const actor = assertActor(opts.actor);
  const expectedFrom = opts.from !== undefined ? assertStatus(opts.from) : undefined;
  if (!opts.reason?.trim()) throw new Error('A reason is required for every status change');
  // Invariant 2: an agent never moves a card to done, only to review.
  if (actor === 'agent' && status === 'done') {
    throw new Error("An agent may not move a card to 'done'. Move it to 'review'; the human moves it to done.");
  }

  const db = openDb();
  try {
    // Read + conditional UPDATE inside one transaction: the claim. The event's
    // `from` comes from this read, so it can never describe a move that did
    // not happen.
    const move = db.transaction(() => {
      const card = getCardIn(db, id);
      if (expectedFrom && card.status !== expectedFrom) {
        throw new Error(`Card ${id} is not in '${expectedFrom}' (now '${card.status}' — already claimed?)`);
      }
      const result = db
        .prepare('UPDATE card SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .run(status, now(), id, card.status);
      if (result.changes === 0) {
        throw new Error(`Card ${id} changed status concurrently — read it again and retry`);
      }
      // Invariant 1: every status change writes an event with from, to, reason.
      addEventIn(db, id, 'status_changed', actor, { from: card.status, to: status, reason: opts.reason });
    });
    move.immediate();
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

// Bare edit, no history: the old text is gone on purpose (accidentally
// pasted secrets stay recoverable nowhere). The timeline gets an event.
export function editComment(commentId: number, body: string, actor: string): Comment {
  const a = assertActor(actor);
  if (!body.trim()) throw new Error('Comment cannot be empty');
  const db = openDb();
  try {
    const comment = db.prepare('SELECT * FROM comment WHERE id = ?').get(commentId) as Comment | undefined;
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    if (comment.author !== a) throw new Error(`Only the author (${comment.author}) may edit this comment`);
    const edit = db.transaction(() => {
      db.prepare('UPDATE comment SET body = ?, updated_at = ? WHERE id = ?').run(body, now(), commentId);
      addEventIn(db, comment.card_id, 'action_taken', a, { note: `comment ${commentId} edited` });
    });
    edit();
    return db.prepare('SELECT * FROM comment WHERE id = ?').get(commentId) as Comment;
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
    blockedBy?: string[];
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
  if (fields.blockedBy !== undefined) {
    sets.push('blocked_by = ?');
    values.push(JSON.stringify(fields.blockedBy));
  }
  if (sets.length === 0 && fields.board === undefined) {
    throw new Error('Nothing to edit. Pass --title, --body, --labels, --refs, --context-refs, --blocked-by or --board');
  }

  const db = openDb();
  try {
    // Validation + UPDATE in one transaction: concurrent edits cannot each
    // pass the cycle check against a stale blocked_by and jointly commit one.
    const edit = db.transaction(() => {
      getCardIn(db, id);
      if (fields.blockedBy !== undefined) {
        for (const bid of fields.blockedBy) {
          if (bid === id) throw new Error(`Card ${id} cannot block itself`);
          getCardIn(db, bid); // throws Card not found for dangling ids
        }
        assertNoBlockerCycle(db, id, fields.blockedBy);
      }
      if (fields.board !== undefined) {
        sets.push('board_id = ?');
        values.push(resolveBoardIn(db, fields.board));
      }
      sets.push('updated_at = ?');
      values.push(now(), id);
      db.prepare(`UPDATE card SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    });
    edit.immediate();
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}

// AGENT.md rule 6: the agent logs what it did as events. Only action_taken
// and error are free-form; status_changed and context_written stay reserved
// for the invariants in core.
export function logEvent(id: string, kind: string, actor: string, note: string, checkAfter?: string): BoardEvent {
  if (kind !== 'action_taken' && kind !== 'error') {
    throw new Error(`Invalid event kind '${kind}'. Loggable: action_taken, error`);
  }
  const a = assertActor(actor);
  if (!note.trim()) throw new Error('Event note cannot be empty');
  const db = openDb();
  try {
    getCardIn(db, id);
    addEventIn(db, id, kind, a, checkAfter ? { note, check_after: checkAfter } : { note });
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
    const cards = db
      .prepare(
        `SELECT * FROM card
         WHERE status = 'ready' OR status = 'needs_input'
            OR (status = 'doing' AND owner = 'agent')
         ORDER BY updated_at ASC`
      )
      .all()
      .map(rowToCard);
    // A card with an open blocker is not workable: it resurfaces by itself
    // when the last blocker goes done/archived (open-ness is derived).
    const blockerIds = [...new Set(cards.flatMap((c) => c.blocked_by))];
    if (blockerIds.length === 0) return cards;
    const open = new Set(
      blockerInfoIn(db, blockerIds)
        .filter((b) => isOpenStatus(b.status))
        .map((b) => b.id)
    );
    return cards.filter((c) => !c.blocked_by.some((b) => open.has(b)));
  } finally {
    db.close();
  }
}

// The scheduler's question (vision besluit C) — deliberately narrower than
// next: bare needs_input never counts (one unanswered question must not
// start a session every minute), and blocked ready cards wait for their
// blockers. doing@agent counting is the implicit crash recovery.
export function gateWork(): Card[] {
  const db = openDb();
  try {
    const cards = db
      .prepare(
        `SELECT * FROM card
         WHERE status = 'ready' OR status = 'needs_input'
            OR (status = 'doing' AND owner = 'agent')
         ORDER BY updated_at ASC`
      )
      .all()
      .map(rowToCard);
    const blockerIds = [...new Set(cards.filter((c) => c.status === 'ready').flatMap((c) => c.blocked_by))];
    const open = new Set(
      blockerInfoIn(db, blockerIds)
        .filter((b) => isOpenStatus(b.status))
        .map((b) => b.id)
    );
    const waits = waitCheckIn(db, cards.filter((c) => c.status === 'needs_input').map((c) => c.id));
    const cutoff = now();
    return cards.filter((c) => {
      if (c.status === 'ready') return !c.blocked_by.some((b) => open.has(b));
      if (c.status === 'doing') return true;
      const check = waits.get(c.id);
      return check !== undefined && check <= cutoff;
    });
  } finally {
    db.close();
  }
}

// One cheap question for the UI poller (vision besluit K, amended): did
// anything change? Events alone are too narrow — card creation and edits
// only touch card.updated_at, and comments are not events. Session liveness
// rides along too (amendement 2026-08-28): a session start/end/crash moves
// neither an event, comment nor card, so without it a crashed session could
// leave presence showing "live" forever on an otherwise quiet board. The
// cursor is opaque to clients; any advance changes the string.
export function changesSince(since?: string, running = false): { cursor: string; changed: boolean } {
  const db = openDb();
  try {
    const e = (db.prepare('SELECT MAX(id) AS m FROM event').get() as { m: number | null }).m ?? 0;
    const c = (db.prepare('SELECT MAX(id) AS m FROM comment').get() as { m: number | null }).m ?? 0;
    const s = (db.prepare('SELECT MAX(id) AS m FROM session').get() as { m: number | null }).m ?? 0;
    const u = (db.prepare('SELECT MAX(updated_at) AS m FROM card').get() as { m: string | null }).m ?? '';
    const cursor = `e${e}.c${c}.s${s}.r${running ? 1 : 0}.u${u}`;
    return { cursor, changed: since !== undefined && since !== cursor };
  } finally {
    db.close();
  }
}

export function cardDetail(id: string): {
  card: Card;
  comments: Comment[];
  events: BoardEvent[];
  blockers: BlockerInfo[];
  blocks: BlockerInfo[];
} {
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
    // Reverse direction from the same source of truth (no double bookkeeping):
    // which cards have me in their blocked_by. JS scan — data stays small.
    const rows = db
      .prepare("SELECT id, type, title, status, blocked_by FROM card WHERE blocked_by != '[]'")
      .all() as (BlockerInfo & { blocked_by: string })[];
    const blocks = rows
      .filter((r) => (JSON.parse(r.blocked_by) as string[]).includes(id))
      .map(({ id, type, title, status }) => ({ id, type, title, status }));
    return { card, comments, events, blockers: blockerInfoIn(db, card.blocked_by), blocks };
  } finally {
    db.close();
  }
}
