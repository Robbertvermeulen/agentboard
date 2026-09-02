import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, now, openDb } from './db.js';
import { gateWork } from './cards.js';
import { RoutineError, RoutineInfo, dueRoutines, markRoutineRun } from './routines.js';
import { finishSessionRecord, observationPath, scanSessionCards, startSessionRecord } from './sessions.js';

const lockPath = () => path.join(dataDir(), 'session.lock');

interface SessionLock {
  pid: number;
  hostname: string;
  started_at: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Single-flight (vision Concurrency): one agent session per data dir. A lock
// is stale when its process is dead or it outlived the max-age safety net —
// a crash may never wedge the scheduler shut. A foreign hostname is a hard
// error: agentboard assumes ONE machine per data dir; synced SQLite plus
// PID locks across machines is silent corruption.
export function acquireLock(): 'acquired' | 'held' {
  const maxAgeMs = Number(process.env.AGENTBOARD_LOCK_MAX_AGE ?? 120) * 60_000;
  const file = lockPath();
  if (fs.existsSync(file)) {
    let lock: SessionLock | null = null;
    try {
      lock = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
    } catch {
      lock = null; // unreadable lock = stale
    }
    if (lock && lock.hostname !== os.hostname()) {
      throw new Error(
        `session.lock is owned by host '${lock.hostname}' (this is '${os.hostname()}') — one machine per data dir`
      );
    }
    const fresh = lock ? Date.now() - new Date(lock.started_at).getTime() < maxAgeMs : false;
    if (lock && fresh && processAlive(lock.pid)) return 'held';
    fs.rmSync(file, { force: true });
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: now() }), {
      flag: 'wx',
    });
  } catch {
    return 'held'; // lost the write race to a concurrent runner
  }
  return 'acquired';
}

// Only remove a lock this process owns. After a max-age steal, the old
// (hung-but-alive) session's finally-block must not delete the successor's
// fresh lock — that would reopen the single-flight window.
export function releaseLock(): void {
  const file = lockPath();
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
    if (lock.pid !== process.pid) return; // stolen by a successor — not ours to remove
    fs.rmSync(file, { force: true });
  } catch {
    // missing or unreadable: nothing safe to remove
  }
}

// Heartbeat: is a runner-started session alive right now? The lock proves a
// live process; the open session row names it. Both required — a stale row
// after a crash must not read as "live".
export function sessionStatus(): { running: boolean; session_id: number | null } {
  let alive = false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as SessionLock;
    alive = lock.hostname === os.hostname() && processAlive(lock.pid);
  } catch {
    alive = false;
  }
  const db = openDb();
  try {
    const row = db.prepare('SELECT id FROM session WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as
      | { id: number }
      | undefined;
    return { running: alive && row !== undefined, session_id: alive && row ? row.id : null };
  } finally {
    db.close();
  }
}

function agentMdPath(): string {
  return (
    process.env.AGENTBOARD_AGENT_MD ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../AGENT.md')
  );
}

export function buildPrompt(due: RoutineInfo[]): string {
  const routineBlock = due.length
    ? `Due routines this run — read each with \`agentboard ctx show <path>\` and act per rule 16:\n${due
        .map((r) => `- ${r.path}`)
        .join('\n')}\n\n`
    : '';
  return (
    `You are the agentboard agent. Read and follow every rule in ${agentMdPath()} before doing anything else.\n\n` +
    routineBlock +
    'Then work the board: run `agentboard next` and handle what it lists.'
  );
}

// Turn handovers to the human into one line for AGENTBOARD_NOTIFY_CMD:
// cards the agent moved to needs_input or review during this session and
// that still sit there (a later move onward un-notifies it).
function handbacksSince(since: string): { id: string; to: string }[] {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        `SELECT card_id, payload FROM event
         WHERE created_at >= ? AND kind = 'status_changed' AND actor = 'agent' ORDER BY id`
      )
      .all(since) as { card_id: string; payload: string }[];
    const latest = new Map<string, string>();
    for (const r of rows) {
      const to = (JSON.parse(r.payload) as { to?: string }).to ?? '';
      if (to === 'needs_input' || to === 'review') latest.set(r.card_id, to);
      else latest.delete(r.card_id);
    }
    return [...latest].map(([id, to]) => ({ id, to }));
  } finally {
    db.close();
  }
}

function notify(handbacks: { id: string; to: string }[]): void {
  const cmd = process.env.AGENTBOARD_NOTIFY_CMD;
  if (!cmd || handbacks.length === 0) return;
  const summary = `${handbacks.length} card${handbacks.length === 1 ? '' : 's'} wait on you: ${handbacks
    .map((h) => `${h.id} (${h.to})`)
    .join(', ')}`;
  const parts = cmd.split(/\s+/);
  try {
    const result = spawnSync(parts[0], [...parts.slice(1), summary], { stdio: 'ignore', timeout: 30_000 });
    // spawnSync does not throw for the common failures (missing binary, non-zero
    // exit) — it reports them on the result instead, so they must be checked
    // explicitly or a failing notify silently vanishes.
    if (result.error) {
      console.error(`notify failed: ${result.error.message}`);
    } else if (result.status !== null && result.status !== 0) {
      console.error(`notify exited ${result.status}`);
    }
  } catch (err) {
    console.error(`notify failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function runSession(
  dryRun = false,
  trigger = 'manual',
  promptOverride?: string
): {
  started: boolean;
  reason: string;
  gate?: { cards: number; routines: number };
  prompt?: string;
  log?: string;
  session?: number;
  notified?: { id: string; to: string }[];
} {
  if (dryRun) {
    const cards = gateWork();
    const due = dueRoutines();
    return {
      started: false,
      reason: fs.existsSync(lockPath()) ? 'dry-run (lock file present)' : 'dry-run',
      gate: { cards: cards.length, routines: due.routines.length },
      prompt: buildPrompt(due.routines),
    };
  }
  if (acquireLock() === 'held') {
    console.error('runner: lock held');
    return { started: false, reason: 'session already running' };
  }
  console.error('runner: lock acquired');
  try {
    const cards = promptOverride ? [] : gateWork();
    const due = promptOverride ? { routines: [] as RoutineInfo[], errors: [] as RoutineError[] } : dueRoutines();
    console.error(`runner: gate: ${cards.length} cards, ${due.routines.length} routines`);
    if (!promptOverride && cards.length === 0 && due.routines.length === 0) {
      return { started: false, reason: 'gate empty' };
    }
    const sessionStart = now();
    for (const r of due.routines) markRoutineRun(r.path); // before the spawn: a crash may not retrigger every minute
    console.error(`runner: marked ${due.routines.length} routines`);
    const rec = startSessionRecord(trigger);
    console.error(`runner: session #${rec.id} -> ${rec.jsonl}`);
    const parts = (process.env.AGENTBOARD_SESSION_CMD ?? 'claude -p --output-format stream-json --verbose').split(
      /\s+/
    );
    let status: number | null = null;
    let notified: { id: string; to: string }[] = [];
    try {
      const out = fs.openSync(rec.jsonl, 'w');
      const err = fs.openSync(rec.stderr, 'w');
      try {
        // stdout is the JSONL transcript; stderr goes to its own file so a
        // stray warning can never corrupt a transcript line.
        status = spawnSync(parts[0], [...parts.slice(1), promptOverride ?? buildPrompt(due.routines)], {
          stdio: ['ignore', out, err],
        }).status;
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      console.error(`runner: session exited ${status ?? 'null'}`);
      scanSessionCards(rec.id);
      notified = handbacksSince(sessionStart);
      notify(notified);
      if (process.env.AGENTBOARD_NOTIFY_CMD && notified.length > 0) {
        console.error(`runner: notified: ${notified.length}`);
      }
      return { started: true, reason: `session exited ${status ?? 'null'}`, log: rec.jsonl, session: rec.id, notified };
    } finally {
      // ended_at is always set, crash or not — a session row may never
      // stay open forever (the heartbeat and prune both depend on it).
      finishSessionRecord(rec.id, status, notified);
    }
  } finally {
    releaseLock();
  }
}

// Observer (vision besluit J): re-read a finished session and judge it
// against the rulebook. The prompt does the work — report to a fixed path,
// an ops card only on a real violation. Runs through runSession, so the
// single-flight lock and session capture apply to the observer itself.
export function observeSession(
  nr: number,
  visionPath?: string
): ReturnType<typeof runSession> & { report: string } {
  const db = openDb();
  try {
    const row = db.prepare('SELECT ended_at, "trigger" FROM session WHERE id = ?').get(nr) as
      | { ended_at: string | null; trigger: string }
      | undefined;
    if (!row) throw new Error(`Session not found: ${nr}`);
    if (row.ended_at === null) throw new Error(`Session #${nr} is still running — observe finished sessions only`);
    if (row.trigger === 'observe') throw new Error(`Session #${nr} is itself an observation — nothing to observe`);
  } finally {
    db.close();
  }
  if (visionPath && !fs.existsSync(visionPath)) throw new Error(`Vision document not found: ${visionPath}`);
  const report = observationPath(nr);
  const prompt =
    `You are the agentboard observer. Review finished session #${nr}.\n\n` +
    `1. Read the redacted transcript: run \`agentboard sessions show ${nr}\`. Never read the raw JSONL.\n` +
    `2. Read the agent rulebook at ${agentMdPath()}.\n` +
    (visionPath ? `3. Read the vision document at ${visionPath} — the standard the rulebook serves.\n` : '') +
    `\nJudge the session against those rules: claiming, status moves, hand-backs, secret hygiene, routine dedup, scope.\n` +
    `Write a short markdown report to ${report}: first line \`verdict: pass\` or \`verdict: violation\`, then findings and concrete improvements.\n` +
    `Only if a rule was violated: also create one ops card describing it, owner human, on the board of the card involved ` +
    `(check \`agentboard card new --help\` for syntax). No violation, no card.\n` +
    `The report file is your only required output.`;
  return { ...runSession(false, 'observe', prompt), report };
}
