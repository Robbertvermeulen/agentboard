import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { addEventIn, dataDir, now, openDb } from './db.js';
import { liveSessionIdsIn } from './slots.js';

// Hard claims (spec 2026-10-15): card.claimed_by names the session that
// holds a card. A claim only counts while that session lives, so a crash
// never wedges a card; releasing and recovering are hygiene on top.

// Inside a runner session AGENTBOARD_SESSION_ID names the caller. Outside
// one (ssh CLI, server API, local runs) the guards below stand down.
export function ownSession(): number | undefined {
  return Number(process.env.AGENTBOARD_SESSION_ID) || undefined;
}

// The runner calls this when a session ends, crash or not.
export function releaseSessionClaims(sessionId: number): number {
  const db = openDb();
  try {
    return db.prepare('UPDATE card SET claimed_by = NULL, claim_seen_at = NULL WHERE claimed_by = ?').run(sessionId).changes;
  } finally {
    db.close();
  }
}

// Boot only (bin/run.sh, after the stale locks are gone): a machine restart
// skips the runner's finally-block, so close the rows it left open, drop
// every claim and sweep the per-session TMPDIRs it never removed. Refuses
// while any session is live.
export function recoverSessions(): { sessions: number; claims: number } {
  const db = openDb();
  try {
    if (liveSessionIdsIn(db).length) throw new Error('A session is live; recover only runs at boot');
    const result = db
      .transaction(() => ({
        sessions: db.prepare('UPDATE session SET ended_at = ? WHERE ended_at IS NULL').run(now()).changes,
        claims: db
          .prepare('UPDATE card SET claim_seen_at = NULL, claimed_by = NULL WHERE claimed_by IS NOT NULL')
          .run().changes,
      }))
      .immediate();
    fs.rmSync(path.join(dataDir(), 'tmp'), { recursive: true, force: true });
    return result;
  } finally {
    db.close();
  }
}

interface ClaimRow {
  id: string;
  status: string;
  claimed_by: number | null;
  claim_seen_at: string | null;
  human_edited_at: string | null;
}

function claimRowIn(db: Database.Database, id: string): ClaimRow {
  const row = db
    .prepare('SELECT id, status, claimed_by, claim_seen_at, human_edited_at FROM card WHERE id = ?')
    .get(id) as ClaimRow | undefined;
  if (!row) throw new Error(`Card not found: ${id}`);
  return row;
}

// The holder only counts while its session lives: a crashed session's claim
// reads as free everywhere, without any cleanup having run.
export function liveHolderIn(
  db: Database.Database,
  claimedBy: number | null,
  live?: ReadonlySet<number>
): number | null {
  if (claimedBy === null) return null;
  return (live ?? new Set(liveSessionIdsIn(db))).has(claimedBy) ? claimedBy : null;
}

// A human status move after this session's latest claim on the card (the
// runner's assignment or its own `card claim`) took the card back for good:
// a plain "claim it first" would let the old holder grab it straight back
// and hide the human's move from the freshness check.
function revokedIn(db: Database.Database, cardId: string, own: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM event h
       WHERE h.card_id = ? AND h.kind = 'status_changed' AND h.actor = 'human'
         AND h.id > (SELECT MAX(id) FROM event c
                     WHERE c.card_id = ? AND json_extract(c.payload, '$.session') = ?
                       AND (c.kind = 'status_changed'
                            OR (c.kind = 'action_taken' AND json_extract(c.payload, '$.note') LIKE 'Claimed by session %')))
       LIMIT 1`
    )
    .get(cardId, cardId, own);
  return row !== undefined;
}

const tookBack = (card: ClaimRow) => `The human took card ${card.id} back (moved to ${card.status}); stop working on it.`;

const heldBy = (id: string, holder: number) =>
  `Card ${id} is held by session ${holder}. Use 'card comment ${id} --request' to ask, or wait.`;

export function assertNotHumanInSession(actor: string): void {
  if (ownSession() !== undefined && actor === 'human') throw new Error('An agent session cannot act as human');
}

// What the holder has not seen yet: comments from anyone but itself, human
// events, and silent human edits. Own writes are never news.
export function newSinceIn(db: Database.Database, cardId: string, since: string, own: number): string[] {
  const comments = db
    .prepare(
      `SELECT author, body, created_at, session_id FROM comment
       WHERE card_id = ? AND (created_at > ? OR updated_at > ?) AND (session_id IS NULL OR session_id != ?)
       ORDER BY created_at, id`
    )
    .all(cardId, since, since, own) as { author: string; body: string; created_at: string; session_id: number | null }[];
  const events = db
    .prepare(
      `SELECT kind, payload, created_at FROM event
       WHERE card_id = ? AND actor = 'human' AND created_at > ? ORDER BY created_at, id`
    )
    .all(cardId, since) as { kind: string; payload: string; created_at: string }[];
  const card = claimRowIn(db, cardId);
  const items = [
    ...comments.map((c) => ({
      at: c.created_at,
      text: `comment by ${c.author}${c.session_id ? ` (session ${c.session_id})` : ''} at ${c.created_at}: ${c.body.slice(0, 300)}`,
    })),
    ...events.map((e) => {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      const detail = p.reason ?? p.note ?? p.blocker ?? p.name ?? p.path ?? '';
      return { at: e.created_at, text: `${e.kind} by human at ${e.created_at}${detail ? `: ${String(detail).slice(0, 300)}` : ''}` };
    }),
  ];
  if (card.human_edited_at && card.human_edited_at > since) {
    items.push({ at: card.human_edited_at, text: `card edited by human at ${card.human_edited_at} (title, body, labels or refs): run card show` });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at)).map((i) => i.text);
}

export type GuardResult = 'unguarded' | 'holder' | 'request';

// Every agent write inside a session passes here first (spec section 4):
// the session must hold the card, must have read it, and must have seen
// everything new since. A refusal for news moves the read mark, so the
// retry passes once the agent has taken it in. Runs in its own short
// transaction before the caller's write; a human action landing in the
// milliseconds between the two is caught by the next write instead.
export function guardAgentWrite(cardId: string, actor: string, opts: { request?: boolean } = {}): GuardResult {
  const own = ownSession();
  if (own === undefined) return 'unguarded';
  assertNotHumanInSession(actor);
  const db = openDb();
  try {
    const outcome = db
      .transaction((): GuardResult | string[] => {
        const card = claimRowIn(db, cardId);
        const holder = liveHolderIn(db, card.claimed_by);
        if (holder !== own) {
          if (revokedIn(db, cardId, own)) throw new Error(tookBack(card));
          if (opts.request && holder !== null) return 'request';
          if (opts.request) throw new Error(`Card ${cardId} is free: claim it instead (agentboard card claim ${cardId})`);
          if (holder !== null) throw new Error(heldBy(cardId, holder));
          throw new Error(`Card ${cardId} is not yours. Claim it first: agentboard card claim ${cardId}`);
        }
        if (card.claim_seen_at === null) throw new Error(`Read the card first: agentboard card show ${cardId}`);
        const at = now();
        const news = newSinceIn(db, cardId, card.claim_seen_at, own);
        // The mark moves before the refusal so it commits with this transaction.
        if (news.length) db.prepare('UPDATE card SET claim_seen_at = ? WHERE id = ?').run(at, cardId);
        return news.length ? news : 'holder';
      })
      .immediate();
    if (Array.isArray(outcome)) {
      throw new Error(
        `Card ${cardId} changed since you read it. Take this into account, then retry:\n` +
          outcome.map((t) => `- ${t}`).join('\n')
      );
    }
    return outcome;
  } finally {
    db.close();
  }
}

// `card claim`: one immediate transaction, never waits. The read mark is the
// claim moment, so the caller prints the card right after and has seen it all.
export function claimCard(cardId: string): void {
  const own = ownSession();
  if (own === undefined) throw new Error('card claim only works inside a runner session (AGENTBOARD_SESSION_ID)');
  const db = openDb();
  try {
    db.transaction(() => {
      const at = now();
      const card = claimRowIn(db, cardId);
      if (card.claimed_by !== own && revokedIn(db, cardId, own)) throw new Error(tookBack(card));
      if (card.status === 'done' || card.status === 'archived') throw new Error(`Card ${cardId} is ${card.status}; nothing to claim`);
      const holder = liveHolderIn(db, card.claimed_by);
      if (holder !== null && holder !== own) throw new Error(heldBy(cardId, holder));
      db.prepare('UPDATE card SET claimed_by = ?, claim_seen_at = ? WHERE id = ?').run(own, at, cardId);
      if (holder !== own) addEventIn(db, cardId, 'action_taken', 'agent', { note: `Claimed by session ${own}`, session: own });
    }).immediate();
  } finally {
    db.close();
  }
}

// `card show` by the holder: `at` is taken before the read, so anything
// landing during the read still counts as new.
export function markSeen(cardId: string, at: string): void {
  const own = ownSession();
  if (own === undefined) return;
  const db = openDb();
  try {
    db.prepare('UPDATE card SET claim_seen_at = ? WHERE id = ? AND claimed_by = ?').run(at, cardId, own);
  } finally {
    db.close();
  }
}

// "Request from [task_y](origin/#/card/task_y) (session N):" -- the card is
// the requesting session's assigned card; without one, just the session.
export function requestPrefixIn(db: Database.Database, own: number): string {
  const row = db.prepare('SELECT card_id FROM session WHERE id = ?').get(own) as { card_id: string | null } | undefined;
  const origin = (process.env.AGENTBOARD_ORIGIN ?? '').trim().replace(/\/$/, '');
  return row?.card_id
    ? `Request from [${row.card_id}](${origin}/#/card/${row.card_id}) (session ${own}):\n\n`
    : `Request from session ${own}:\n\n`;
}
