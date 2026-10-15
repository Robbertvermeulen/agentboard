import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, openDb } from './db.js';
import { liveSessionIdsIn } from './slots.js';

// Workdirs per card (spec section 9): a card resumed in another slot finds
// its own checkout, and no session switches branches under another card's
// uncommitted work. Sessions without a card get a per-session directory.
const base = () => process.env.AGENTBOARD_WORK ?? path.join(dataDir(), 'work');

function ensure(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionWorkDir(cardId: string | null, sessionId: number): string {
  return ensure(cardId ? path.join(base(), 'cards', cardId) : path.join(base(), 'sessions', String(sessionId)));
}

// Routine checks are short read-only shell lines that run before any session
// exists; they share one neutral directory.
export function checkWorkDir(): string {
  return ensure(path.join(base(), 'checks'));
}

export function sessionTmpDir(sessionId: number): string {
  return ensure(path.join(dataDir(), 'tmp', `session-${sessionId}`));
}

export function removeTmpDir(sessionId: number): void {
  fs.rmSync(path.join(dataDir(), 'tmp', `session-${sessionId}`), { recursive: true, force: true });
}

// Rule-12 layout puts repos at <board>/<client>/<resource>/, so four levels
// deep covers every checkout the agent makes.
function gitRepos(dir: string, depth = 4): string[] {
  if (fs.existsSync(path.join(dir, '.git'))) return [dir];
  if (depth === 0) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .flatMap((e) => gitRepos(path.join(dir, e.name), depth - 1));
}

// Uncommitted changes, or commits on any local branch that no remote has.
// A repo git cannot read counts as unpushed: keeping too much is cheap,
// deleting the only copy is not.
function hasUnpushedWork(repo: string): boolean {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return git('status', '--porcelain') !== '' || git('log', 'HEAD', '--branches', '--not', '--remotes', '--oneline') !== '';
  } catch {
    return true;
  }
}

// After every session: workdirs of done/archived cards nobody holds, and of
// sessions that have ended. The volume is small (2.9 GB on Fly) and a clone
// per card grows faster than a clone per slot.
export function pruneWorkdirs(log: (m: string) => void = (m) => console.error(m)): void {
  const candidates: string[] = [];
  const db = openDb();
  try {
    const live = new Set(liveSessionIdsIn(db));
    const cardsDir = path.join(base(), 'cards');
    if (fs.existsSync(cardsDir)) {
      for (const e of fs.readdirSync(cardsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const id = e.name;
        const row = db.prepare('SELECT status, claimed_by FROM card WHERE id = ?').get(id) as
          | { status: string; claimed_by: number | null }
          | undefined;
        const held = row?.claimed_by != null && live.has(row.claimed_by);
        if (row && (row.status === 'done' || row.status === 'archived') && !held) candidates.push(path.join(cardsDir, id));
      }
    }
    const sessionsDir = path.join(base(), 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const e of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const n = e.name;
        const row = db.prepare('SELECT ended_at FROM session WHERE id = ?').get(Number(n)) as { ended_at: string | null } | undefined;
        if (row?.ended_at) candidates.push(path.join(sessionsDir, n));
      }
    }
  } finally {
    db.close();
  }
  for (const dir of candidates) {
    // One unreadable directory must not stop the rest.
    try {
      if (gitRepos(dir).some(hasUnpushedWork)) {
        log(`runner: workdir kept: ${dir}, unpushed work`);
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      log(`runner: prune skipped ${dir}: ${(e as Error).message}`);
    }
  }
}
