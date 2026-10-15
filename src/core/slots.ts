import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataDir } from './db.js';

// One numbered lock file per slot ('session.lock' for slot 0, matching the
// pre-pool name so existing boot cleanup keeps working at the default N=1).
// Lives apart from runner.ts so claims.ts can ask "is this session alive?"
// without importing the runner (which imports cards.ts, which imports claims).
export const lockPath = (slot: number) => path.join(dataDir(), slot === 0 ? 'session.lock' : `session.lock.${slot}`);

// How many sessions may run at once. Default 1 keeps single-flight behavior.
export const maxSessions = () => Math.max(1, Number(process.env.AGENTBOARD_MAX_SESSIONS ?? 1));

export interface SessionLock {
  pid: number;
  hostname: string;
  started_at: string;
  session_id?: number; // set once the session record exists (see markLockSession)
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLock(slot: number): SessionLock | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(slot), 'utf8')) as SessionLock;
  } catch {
    return null;
  }
}

// Heartbeat: which runner-started sessions are alive right now? A lock with
// a live process proves it; the open session row confirms it. Both required:
// a stale row after a crash must not read as "live".
export function liveSessionIdsIn(db: Database.Database): number[] {
  const ids: number[] = [];
  for (let slot = 0; slot < maxSessions(); slot++) {
    const lock = readLock(slot);
    if (lock && lock.hostname === os.hostname() && processAlive(lock.pid) && typeof lock.session_id === 'number') {
      ids.push(lock.session_id);
    }
  }
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT id FROM session WHERE ended_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(ids) as { id: number }[];
  return rows.map((r) => r.id);
}
