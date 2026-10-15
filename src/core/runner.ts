import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { now, openDb } from './db.js';
import { Card, gateWork, pickAndClaimIn } from './cards.js';
import { releaseSessionClaims } from './claims.js';
import { checkWorkDir, pruneWorkdirs, removeTmpDir, sessionTmpDir, sessionWorkDir } from './workdirs.js';
import { RoutineError, RoutineInfo, dueRoutines, markRoutineRun } from './routines.js';
import { finishSessionRecord, observationPath, scanSessionCards, startSessionRecordIn } from './sessions.js';
import { getSettings, languageLabel } from './settings.js';
import { SessionLock, liveSessionIdsIn, lockPath, maxSessions, processAlive } from './slots.js';

function anyLockHeld(): boolean {
  const slots = maxSessions();
  for (let slot = 0; slot < slots; slot++) if (fs.existsSync(lockPath(slot))) return true;
  return false;
}

// A pool of N lock slots (vision Concurrency; N=1 is single-flight). A lock
// is stale when its process is dead or it outlived the max-age safety net —
// a crash may never wedge the scheduler shut. A foreign hostname is a hard
// error: agentboard assumes ONE machine per data dir; synced SQLite plus
// PID locks across machines is silent corruption. Returns the slot number
// claimed so the caller can give that slot its own workdir (two concurrent
// sessions must never share a repo checkout).
export function acquireLock(): number | 'held' {
  const maxAgeMs = Number(process.env.AGENTBOARD_LOCK_MAX_AGE ?? 120) * 60_000;
  const slots = maxSessions();
  for (let slot = 0; slot < slots; slot++) {
    const file = lockPath(slot);
    if (fs.existsSync(file)) {
      let lock: SessionLock | null = null;
      try {
        lock = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
      } catch {
        lock = null; // unreadable lock = stale
      }
      if (lock && lock.hostname !== os.hostname()) {
        throw new Error(
          `${file} is owned by host '${lock.hostname}' (this is '${os.hostname()}') — one machine per data dir`
        );
      }
      const fresh = lock ? Date.now() - new Date(lock.started_at).getTime() < maxAgeMs : false;
      if (lock && fresh && processAlive(lock.pid)) continue; // slot busy, try the next one
      fs.rmSync(file, { force: true });
    }
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: now() }), {
        flag: 'wx',
      });
    } catch {
      continue; // lost the write race on this slot to a concurrent runner — try the next
    }
    return slot;
  }
  return 'held'; // every slot busy
}

// Only remove a lock this process owns. After a max-age steal, the old
// (hung-but-alive) session's finally-block must not delete the successor's
// fresh lock — that would reopen the slot it just reclaimed. Scans every
// slot since this process doesn't track which one it claimed.
export function releaseLock(): void {
  const slots = maxSessions();
  for (let slot = 0; slot < slots; slot++) {
    const file = lockPath(slot);
    try {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
      if (lock.pid !== process.pid) continue; // not ours (stolen by a successor, or a different slot)
      fs.rmSync(file, { force: true });
      return;
    } catch {
      // missing or unreadable: nothing safe to remove at this slot
    }
  }
}

// Name the session in this process's lock, so liveSessionIds can map every
// held slot to the session it runs (several can be live at N>1).
function markLockSession(slot: number, sessionId: number): void {
  const file = lockPath(slot);
  const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
  if (lock.pid !== process.pid) return; // not ours anymore (max-age steal)
  fs.writeFileSync(file, JSON.stringify({ ...lock, session_id: sessionId }));
}

const resumeLimit = () => Math.max(1, Number(process.env.AGENTBOARD_RESUME_LIMIT ?? 2));
// spawnSync throws on a non-integer or NaN timeout, after the card is claimed:
// a bad env value must fall back instead of stranding healthy cards.
const sessionTimeoutMs = () => {
  const minutes = Number(process.env.AGENTBOARD_SESSION_TIMEOUT_MIN ?? 45);
  return Math.max(1, Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : 45) * 60_000));
};

// One immediate transaction makes the session row, names it in this slot's
// lock and claims the first gate card, so a concurrent runner either sees
// all of it or none. The lock write happens inside the transaction on
// purpose: a runner that commits after us reads the lock as live. With no
// card and nothing else to do, the row is deleted again, while a crash-loop
// park made during the pick still commits.
function beginSession(
  slot: number,
  trigger: string,
  opts: { assign: boolean; allowEmpty: boolean }
): { rec: { id: number; jsonl: string; stderr: string }; card: Card | null } | null {
  const db = openDb();
  try {
    return db
      .transaction(() => {
        const live = new Set(liveSessionIdsIn(db));
        const rec = startSessionRecordIn(db, trigger);
        markLockSession(slot, rec.id);
        const card = opts.assign ? pickAndClaimIn(db, rec.id, live, resumeLimit()) : null;
        if (!card && !opts.allowEmpty) {
          db.prepare('DELETE FROM session WHERE id = ?').run(rec.id);
          return null;
        }
        if (card) db.prepare('UPDATE session SET card_id = ? WHERE id = ?').run(card.id, rec.id);
        return { rec, card };
      })
      .immediate();
  } finally {
    db.close();
  }
}

// Start the next runner the way the server's autorun does: detached, opt-in.
// A finished session uses it so a waiting card does not wait for the cron.
export function pokeRunner(trigger: string): void {
  if (process.env.AGENTBOARD_AUTORUN !== '1') return;
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
  const child = spawn(process.execPath, [cli, 'runner', '--trigger', trigger], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Heartbeat: which runner-started sessions are alive right now? A lock with
// a live process proves it; the open session row confirms it. Both required —
// a stale row after a crash must not read as "live".
export function liveSessionIds(): number[] {
  const db = openDb();
  try {
    return liveSessionIdsIn(db);
  } finally {
    db.close();
  }
}

// session_id stays the newest live session for existing callers; session_ids
// lists every live one.
export function sessionStatus(): { running: boolean; session_id: number | null; session_ids: number[] } {
  const ids = liveSessionIds();
  return { running: ids.length > 0, session_id: ids.length ? ids[ids.length - 1] : null, session_ids: ids };
}

// Sessions never inherit the caller's cwd: a repo checkout's CLAUDE.md (or
// any stray project context) would leak into the session. Workdirs come
// from workdirs.ts.

// The session gets the environment minus the secrets only the server
// process needs: the Fly deploy token (it can replace this machine) and the
// cookie-signing secret. A headless session that runs repo code with
// --dangerously-skip-permissions must not be able to read either.
const SESSION_ENV_STRIP = ['FLY_API_TOKEN', 'AGENTBOARD_SESSION_SECRET'];

// AGENT.md rule 12 derives repo paths from $AGENTBOARD_WORK, so it points at
// this card's workdir; TMPDIR is per session so two sessions never share
// scratch files. With a session id, the session stamps its claims (moveCard)
// and finds its own id among the live ones.
function sessionEnv(work?: string, tmp?: string, sessionId?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOARD_ACTOR: 'agent' };
  for (const key of SESSION_ENV_STRIP) delete env[key];
  if (work !== undefined) env.AGENTBOARD_WORK = work;
  if (tmp !== undefined) Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  if (sessionId !== undefined) env.AGENTBOARD_SESSION_ID = String(sessionId);
  return env;
}

function agentMdPath(): string {
  return (
    process.env.AGENTBOARD_AGENT_MD ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../AGENT.md')
  );
}

export type DueRoutine = RoutineInfo & { checkOutput?: string };

export function buildPrompt(due: DueRoutine[], cardId: string | null): string {
  const routineBlock = due.length
    ? `Due routines this run — read each with \`agentboard ctx show <path>\` and act per rule 16:\n${due
        .map((r) => `- ${r.path}${r.checkOutput ? ` (check found:\n${r.checkOutput})` : ''}`)
        .join('\n')}\n\n`
    : '';
  const accountLanguage = getSettings().language;
  const languageLine = accountLanguage
    ? `Preferred language for this session: ${languageLabel(accountLanguage)}. Write all card comments, log ` +
      `lines and drafted external messages in this language, unless the profile chain (_global/user.md -> ` +
      `_board.md -> _client.md) or a board's own preferred language (\`agentboard board <id>\`) explicitly ` +
      `overrides it for a specific piece of writing.\n\n`
    : '';
  return (
    `You are the agentboard agent. Read and follow every rule in ${agentMdPath()} before doing anything else.\n\n` +
    languageLine +
    routineBlock +
    (cardId
      ? `Your card this session: ${cardId}. Start with \`agentboard card show ${cardId}\`. Work only this card; ` +
        'touching another card needs `agentboard card claim <id>` first (AGENT.md rule 15). Handing the card ' +
        'back is your last step.'
      : 'You hold no card this session; touching a card needs `agentboard card claim <id>` first (AGENT.md rule 15).')
  );
}

// A routine's `check` runs before its session: empty stdout means nothing
// actionable, so the routine is skipped this run (but still marked run, like
// every due routine). A failing or timed-out check counts as "found"
// (fail-open) with the error surfaced instead — a broken check must never
// make a routine silently vanish.
function runRoutineCheck(check: string): { output: string; failed: boolean } {
  const result = spawnSync('sh', ['-c', check], {
    cwd: checkWorkDir(),
    env: sessionEnv(),
    timeout: 30_000,
    encoding: 'utf8',
  });
  if (result.error) return { output: `check errored: ${result.error.message}`, failed: true };
  if (result.signal) return { output: `check killed by ${result.signal} (timeout?)`, failed: true };
  if (result.status !== 0) return { output: `check exited ${result.status}: ${(result.stderr ?? '').trim()}`, failed: true };
  return { output: (result.stdout ?? '').trim(), failed: false };
}

// Runs each due routine's check (if it has one) and keeps only the routines
// with something to act on: no check, non-empty stdout, or a failed check
// (fail-open). Every due routine still gets marked run by the caller,
// whether or not it survives this filter.
function checkDueRoutines(due: RoutineInfo[]): DueRoutine[] {
  const active: DueRoutine[] = [];
  for (const r of due) {
    if (!r.check) {
      active.push(r);
      continue;
    }
    const { output, failed } = runRoutineCheck(r.check);
    if (failed) {
      console.error(`runner: check failed for ${r.path}: ${output}`);
      active.push({ ...r, checkOutput: output });
    } else if (output) {
      active.push({ ...r, checkOutput: output });
    } else {
      console.error(`runner: check for ${r.path} found nothing`);
    }
  }
  return active;
}

// Turn handovers to the human into one line for AGENTBOARD_NOTIFY_CMD:
// cards the agent moved to needs_input or review during this session and
// that still sit there (a later move onward un-notifies it). Only this
// session's own moves count — a concurrent session's hand-backs are its own.
function handbacksSince(since: string, sessionId: number): { id: string; to: string }[] {
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
      const p = JSON.parse(r.payload) as { to?: string; session?: number };
      if (p.session !== sessionId) continue;
      const to = p.to ?? '';
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
    const result = spawnSync(parts[0], [...parts.slice(1), summary], {
      stdio: 'ignore',
      timeout: 30_000,
      env: sessionEnv(), // the notify script needs neither server secret either
    });
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
    const cards = gateWork(new Set(liveSessionIds()));
    const due = dueRoutines();
    return {
      started: false,
      reason: anyLockHeld() ? 'dry-run (lock file present)' : 'dry-run',
      gate: { cards: cards.length, routines: due.routines.length },
      prompt: buildPrompt(due.routines, cards[0]?.id ?? null),
    };
  }
  const slot = acquireLock();
  if (slot === 'held') {
    console.error('runner: lock held');
    return { started: false, reason: 'session already running' };
  }
  console.error(`runner: lock acquired (slot ${slot})`);
  let sessionId: number | undefined;
  try {
    const due = promptOverride ? { routines: [] as RoutineInfo[], errors: [] as RoutineError[] } : dueRoutines();
    const active = promptOverride ? [] : checkDueRoutines(due.routines);
    for (const r of due.routines) markRoutineRun(r.path); // before the spawn: a crash may not retrigger every minute (every due routine, checked or not)
    console.error(`runner: marked ${due.routines.length} routines`);
    const begun = beginSession(slot, trigger, { assign: !promptOverride, allowEmpty: !!promptOverride || active.length > 0 });
    if (!begun) return { started: false, reason: 'gate empty' };
    const { rec, card } = begun;
    sessionId = rec.id;
    const work = sessionWorkDir(card?.id ?? null, rec.id);
    const tmp = sessionTmpDir(rec.id);
    const sessionStart = now();
    console.error(`runner: session #${rec.id}${card ? ` (${card.id})` : ''} -> ${rec.jsonl}`);
    const parts = (process.env.AGENTBOARD_SESSION_CMD ?? 'claude -p --output-format stream-json --verbose').split(/\s+/);
    let status: number | null = null;
    let notified: { id: string; to: string }[] = [];
    try {
      const out = fs.openSync(rec.jsonl, 'w');
      const err = fs.openSync(rec.stderr, 'w');
      try {
        // stdout is the JSONL transcript; stderr goes to its own file so a
        // stray warning can never corrupt a transcript line. A session past
        // the time limit is stopped and counts as stranded (spec section 7).
        const result = spawnSync(parts[0], [...parts.slice(1), promptOverride ?? buildPrompt(active, card?.id ?? null)], {
          stdio: ['ignore', out, err],
          cwd: work,
          env: sessionEnv(work, tmp, rec.id),
          timeout: sessionTimeoutMs(),
          killSignal: 'SIGTERM',
        });
        status = result.status;
        if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
          console.error(`runner: session #${rec.id} timed out`);
        }
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      console.error(`runner: session exited ${status ?? 'null'}`);
      scanSessionCards(rec.id);
      notified = handbacksSince(sessionStart, rec.id);
      notify(notified);
      if (process.env.AGENTBOARD_NOTIFY_CMD && notified.length > 0) {
        console.error(`runner: notified: ${notified.length}`);
      }
      return { started: true, reason: `session exited ${status ?? 'null'}`, log: rec.jsonl, session: rec.id, notified };
    } finally {
      // ended_at is always set, crash or not; then the claims go, so the
      // gate can hand a stranded card to the next session.
      finishSessionRecord(rec.id, status, notified);
      releaseSessionClaims(rec.id);
      removeTmpDir(rec.id);
    }
  } finally {
    if (sessionId !== undefined) pruneWorkdirs();
    releaseLock();
    if (sessionId !== undefined) pokeRunner('chain');
  }
}

// Observer (vision besluit J): re-read a finished session and judge it
// against the rulebook. The prompt does the work — report to a fixed path,
// an ops card only on a real violation. Runs through runSession, so the
// slot pool and session capture apply to the observer itself.
export function observeSession(
  nr: number,
  visionPath?: string
): ReturnType<typeof runSession> & { report: string } {
  const db = openDb();
  let row: { ended_at: string | null; trigger: string } | undefined;
  try {
    row = db.prepare('SELECT ended_at, "trigger" FROM session WHERE id = ?').get(nr) as
      | { ended_at: string | null; trigger: string }
      | undefined;
  } finally {
    db.close();
  }
  if (!row) throw new Error(`Session not found: ${nr}`);
  if (row.ended_at === null) {
    // An open row is only "still running" when the lock confirms it. SIGKILL
    // leaves an open row with no live lock forever — exactly the crash most
    // worth observing, and "still running" would contradict the UI's own
    // "ended early (crash)" for the same row.
    if (liveSessionIds().includes(nr)) throw new Error(`Session #${nr} is still running — observe finished sessions only`);
  }
  if (row.trigger === 'observe') throw new Error(`Session #${nr} is itself an observation — nothing to observe`);
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
