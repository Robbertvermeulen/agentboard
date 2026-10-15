import { now, openDb } from './db.js';
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
// skips the runner's finally-block, so close the rows it left open and drop
// every claim. Refuses while any session is live.
export function recoverSessions(): { sessions: number; claims: number } {
  const db = openDb();
  try {
    if (liveSessionIdsIn(db).length) throw new Error('A session is live; recover only runs at boot');
    return db
      .transaction(() => ({
        sessions: db.prepare('UPDATE session SET ended_at = ? WHERE ended_at IS NULL').run(now()).changes,
        claims: db
          .prepare('UPDATE card SET claim_seen_at = NULL, claimed_by = NULL WHERE claimed_by IS NOT NULL')
          .run().changes,
      }))
      .immediate();
  } finally {
    db.close();
  }
}
