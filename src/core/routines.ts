import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { Cron } from 'croner';
import type Database from 'better-sqlite3';
import { contextDir, now, openDb } from './db.js';

export interface RoutineInfo {
  path: string; // context-relative, e.g. 'freelance/happyshopper/weekly.md'
  board: string; // first path segment
  name: string; // frontmatter name, fallback: basename without .md
  schedule: string; // 5-field cron, local machine time
  enabled: boolean; // frontmatter enabled, default true
  card: string; // the ops card the routine was approved on
  last_run_at: string;
  next_run: string | null; // ISO; null if the pattern never fires again
  last_card: { id: string; status: string } | null; // youngest card with this routine path
}

export interface RoutineError {
  path: string;
  error: string;
}

// Shared with context.ts's validateContent: what makes a routine file valid.
// Lives here (not in context.ts) so the import stays one-way, no cycle.
export function assertRoutineFrontmatter(relPath: string, data: Record<string, unknown>): void {
  if (relPath.startsWith('_global/') || !relPath.includes('/')) {
    throw new Error(`kind: routine must live under a board dir, not '${relPath}'`);
  }
  if (typeof data.schedule !== 'string' || !data.schedule.trim()) {
    throw new Error(`kind: routine requires 'schedule' — a 5-field cron expression (${relPath})`);
  }
  try {
    new Cron(data.schedule); // parse-only: no callback, nothing is scheduled
  } catch (err) {
    throw new Error(`Invalid schedule '${data.schedule}' in ${relPath}: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof data.card !== 'string' || !data.card.trim()) {
    throw new Error(`kind: routine requires 'card' — the ops card it was approved on (${relPath})`);
  }
}

// Own tiny path guard instead of importing context.ts (would create a cycle).
function resolveInContext(relPath: string): string {
  const root = contextDir();
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the context dir: ${relPath}`);
  }
  return abs;
}

// Walk context/ for kind: routine files. A broken file becomes an error
// entry instead of breaking the sweep — one bad file may not stop the cron.
function readRoutineFiles(): { found: { relPath: string; data: Record<string, unknown> }[]; errors: RoutineError[] } {
  const root = contextDir();
  const found: { relPath: string; data: Record<string, unknown> }[] = [];
  const errors: RoutineError[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const relPath = path.relative(root, full);
      let data: Record<string, unknown>;
      try {
        data = matter(fs.readFileSync(full, 'utf8')).data;
      } catch (err) {
        errors.push({ path: relPath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (data.kind !== 'routine') continue;
      try {
        assertRoutineFrontmatter(relPath, data);
        found.push({ relPath, data });
      } catch (err) {
        errors.push({ path: relPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return { found, errors };
}

// Seed-at-first-sight: a routine without run-state gets last_run_at = now
// and is not due at that moment — a freshly approved routine waits for its
// first scheduled occurrence instead of firing right after approval.
function toInfo(db: Database.Database, relPath: string, data: Record<string, unknown>): RoutineInfo {
  const row = db.prepare('SELECT last_run_at FROM routine_run WHERE path = ?').get(relPath) as
    | { last_run_at: string }
    | undefined;
  let last = row?.last_run_at;
  if (!last) {
    last = now();
    db.prepare('INSERT OR IGNORE INTO routine_run (path, last_run_at) VALUES (?, ?)').run(relPath, last);
  }
  const next = new Cron(data.schedule as string).nextRun(new Date(last));
  const lastCard = (db
    .prepare('SELECT id, status FROM card WHERE routine = ? ORDER BY created_at DESC LIMIT 1')
    .get(relPath) ?? null) as { id: string; status: string } | null;
  return {
    path: relPath,
    board: relPath.split('/')[0],
    name: typeof data.name === 'string' && data.name.trim() ? data.name : path.basename(relPath, '.md'),
    schedule: data.schedule as string,
    enabled: data.enabled !== false,
    card: data.card as string,
    last_run_at: last,
    next_run: next ? next.toISOString() : null,
    last_card: lastCard,
  };
}

export function listRoutines(boardId?: string): { routines: RoutineInfo[]; errors: RoutineError[] } {
  const { found, errors } = readRoutineFiles();
  const db = openDb();
  try {
    const routines = found
      .filter((r) => !boardId || r.relPath.split('/')[0] === boardId)
      .map((r) => toInfo(db, r.relPath, r.data));
    return { routines, errors };
  } finally {
    db.close();
  }
}

export function dueRoutines(): { routines: RoutineInfo[]; errors: RoutineError[] } {
  const all = listRoutines();
  const cutoff = now();
  return {
    routines: all.routines.filter((r) => r.enabled && r.next_run !== null && r.next_run <= cutoff),
    errors: all.errors,
  };
}

export function markRoutineRun(relPath: string): { path: string; last_run_at: string } {
  resolveInContext(relPath);
  const db = openDb();
  try {
    const ts = now();
    db.prepare(
      'INSERT INTO routine_run (path, last_run_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET last_run_at = excluded.last_run_at'
    ).run(relPath, ts);
    return { path: relPath, last_run_at: ts };
  } finally {
    db.close();
  }
}
