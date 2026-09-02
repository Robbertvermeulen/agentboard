import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataDir, now, openDb, secretsPath } from './db.js';

export interface SessionMeta {
  id: number;
  started_at: string;
  ended_at: string | null;
  trigger: string;
  exit_status: number | null;
  handed_back: { id: string; to: string }[];
  cards: string[];
}

const sessionsDir = () => path.join(dataDir(), 'sessions');
export const sessionJsonlPath = (id: number) => path.join(sessionsDir(), `${id}.jsonl`);
export const sessionStderrPath = (id: number) => path.join(sessionsDir(), `${id}.stderr.log`);
export const observationPath = (id: number) => path.join(sessionsDir(), `${id}-observation.md`);

export function startSessionRecord(trigger: string): { id: number; jsonl: string; stderr: string } {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const db = openDb();
  try {
    const info = db
      .prepare(`INSERT INTO session (started_at, "trigger", handed_back) VALUES (?, ?, '[]')`)
      .run(now(), trigger);
    const id = Number(info.lastInsertRowid);
    return { id, jsonl: sessionJsonlPath(id), stderr: sessionStderrPath(id) };
  } finally {
    db.close();
  }
}

export function finishSessionRecord(
  id: number,
  exitStatus: number | null,
  handedBack: { id: string; to: string }[]
): void {
  const db = openDb();
  try {
    db.prepare('UPDATE session SET ended_at = ?, exit_status = ?, handed_back = ? WHERE id = ?').run(
      now(),
      exitStatus,
      JSON.stringify(handedBack),
      id
    );
  } finally {
    db.close();
  }
}

// Which cards did this session touch? Mined from the transcript, so cards
// the session created mid-run are linked too. Only ids that really exist
// survive (the pattern alone would match hex noise).
export function scanSessionCards(id: number): string[] {
  const file = sessionJsonlPath(id);
  if (!fs.existsSync(file)) return [];
  const ids = [...new Set(fs.readFileSync(file, 'utf8').match(/\b(?:task|ops)_[0-9a-f]{4}\b/g) ?? [])];
  const db = openDb();
  try {
    const known = ids.filter((c) => db.prepare('SELECT 1 FROM card WHERE id = ?').get(c));
    const insert = db.prepare('INSERT OR IGNORE INTO session_card (session_id, card_id) VALUES (?, ?)');
    for (const c of known) insert.run(id, c);
    return known;
  } finally {
    db.close();
  }
}

// The vault never reaches a viewer: every secrets.env value — and for
// base64: values every printable decoded line — becomes [secret:name] at
// display time. The raw file on disk shares secrets.env's trust boundary;
// AGENT.md rule 4 is the first line of defense, this is the net.
export function secretRedactor(): (text: string) => string {
  const file = secretsPath();
  if (!fs.existsSync(file)) return (t) => t;
  const replacements: { value: string; name: string }[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (!value) continue;
    replacements.push({ value, name });
    if (value.startsWith('base64:')) {
      try {
        for (const decoded of Buffer.from(value.slice(7), 'base64').toString('utf8').split('\n')) {
          const d = decoded.trim();
          if (d.length >= 6 && /^[\x20-\x7e]+$/.test(d)) replacements.push({ value: d, name });
        }
      } catch {
        /* not decodable: the raw value replacement still applies */
      }
    }
  }
  // A secret inside a stream-json transcript appears JSON-escaped; a value
  // with quotes, backslashes or non-ASCII would otherwise slip past.
  for (const r of [...replacements]) {
    const escaped = JSON.stringify(r.value).slice(1, -1);
    if (escaped !== r.value) replacements.push({ value: escaped, name: r.name });
  }
  replacements.sort((a, b) => b.value.length - a.value.length); // longest first
  return (text) => {
    let out = text;
    for (const r of replacements) out = out.split(r.value).join(`[secret:${r.name}]`);
    return out;
  };
}

export const redactSecrets = (text: string): string => secretRedactor()(text);

export interface SessionStep {
  n: number;
  type: 'text' | 'tool' | 'result' | 'raw';
  label: string;
  detail: string;
  card_ids: string[];
}

const CARD_RE = /\b(?:task|ops)_[0-9a-f]{4}\b/g;
const firstLine = (s: string) => (s.split('\n')[0] ?? '').slice(0, 120);

// stream-json lines -> flat steps. Unparseable lines stay visible as 'raw',
// so a session captured with a non-JSON command still renders.
export function parseSessionSteps(jsonlText: string, baseN = 0): SessionStep[] {
  const steps: SessionStep[] = [];
  const push = (type: SessionStep['type'], label: string, detail: string) =>
    steps.push({
      n: baseN + steps.length + 1,
      type,
      label,
      detail,
      card_ids: [...new Set(`${label}\n${detail}`.match(CARD_RE) ?? [])],
    });
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      push('raw', firstLine(line), line);
      continue;
    }
    const blocks = msg?.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          push('text', firstLine(b.text), b.text);
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          push('text', `reasoning · ${b.thinking.trim().split(/\s+/).length} words`, b.thinking);
        } else if (b.type === 'tool_use') {
          push('tool', String(b.name ?? 'tool'), JSON.stringify(b.input ?? {}).slice(0, 500));
        } else if (b.type === 'tool_result') {
          let content: string;
          if (typeof b.content === 'string') {
            content = b.content;
          } else if (Array.isArray(b.content)) {
            content = b.content
              .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c ?? '')))
              .join('\n');
          } else {
            content = JSON.stringify(b.content ?? '');
          }
          push('result', firstLine(content), content.slice(0, 2000));
        }
      }
    } else if (msg?.type === 'result' && typeof msg.result === 'string') {
      push('text', firstLine(msg.result), msg.result);
    }
  }
  return steps;
}

// Incremental read for the live tail: parse only the complete lines past
// `offset`, numbering steps from `n`. A trailing line without a newline is
// still being written (or died mid-write): skip it and do not advance the
// offset past it — unless the session has ended, in which case that line
// will never complete and is parsed as its final (possibly raw) step.
export function sessionStepsSince(
  id: number,
  offset = 0,
  n = 0
): { steps: SessionStep[]; offset: number; n: number } {
  const db = openDb();
  let ended: boolean;
  try {
    const row = db.prepare('SELECT ended_at FROM session WHERE id = ?').get(id) as
      | { ended_at: string | null }
      | undefined;
    if (!row) throw new Error(`Session not found: ${id}`);
    ended = row.ended_at !== null;
  } finally {
    db.close();
  }
  const file = sessionJsonlPath(id);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size <= offset) return { steps: [], offset, n };
  const fd = fs.openSync(file, 'r');
  let chunk: string;
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    chunk = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const cut = chunk.lastIndexOf('\n');
  const complete = ended ? chunk : cut === -1 ? '' : chunk.slice(0, cut + 1);
  const redact = secretRedactor();
  const steps = parseSessionSteps(complete, n).map((s) => ({
    ...s,
    label: redact(s.label),
    detail: redact(s.detail),
  }));
  return { steps, offset: offset + Buffer.byteLength(complete, 'utf8'), n: n + steps.length };
}

function rowToMeta(db: Database.Database, row: any): SessionMeta {
  const cards = (
    db.prepare('SELECT card_id FROM session_card WHERE session_id = ? ORDER BY card_id').all(row.id) as {
      card_id: string;
    }[]
  ).map((r) => r.card_id);
  return { ...row, handed_back: JSON.parse(row.handed_back ?? '[]'), cards };
}

export function listSessions(): SessionMeta[] {
  const db = openDb();
  try {
    return (db.prepare('SELECT * FROM session ORDER BY id DESC').all() as any[]).map((r) => rowToMeta(db, r));
  } finally {
    db.close();
  }
}

export function sessionDetail(id: number): {
  session: SessionMeta;
  steps: SessionStep[];
  observation: string | null;
  tail: { offset: number; n: number };
} {
  const db = openDb();
  let session: SessionMeta;
  try {
    const row = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    session = rowToMeta(db, row);
  } finally {
    db.close();
  }
  const { steps, offset, n } = sessionStepsSince(id, 0, 0);
  const obsFile = observationPath(id);
  const observation = fs.existsSync(obsFile) ? redactSecrets(fs.readFileSync(obsFile, 'utf8')) : null;
  return { session, steps, observation, tail: { offset, n } };
}

// Card-first (design 2g): per session that touched this card, only the
// steps mentioning it, padded with one step of context on each side.
export function cardSessions(cardId: string): { session: SessionMeta; steps: SessionStep[] }[] {
  const db = openDb();
  let ids: number[];
  try {
    ids = (
      db.prepare('SELECT session_id FROM session_card WHERE card_id = ? ORDER BY session_id DESC').all(cardId) as {
        session_id: number;
      }[]
    ).map((r) => r.session_id);
  } finally {
    db.close();
  }
  return ids.map((id) => {
    const { session, steps } = sessionDetail(id);
    const keep = new Set<number>();
    steps.forEach((s, i) => {
      if (s.card_ids.includes(cardId)) {
        keep.add(i - 1);
        keep.add(i);
        keep.add(i + 1);
      }
    });
    return { session, steps: steps.filter((_, i) => keep.has(i)) };
  });
}

// The one place delete exists: session logs are working material, not card
// history — the timeline stays the durable truth. Running sessions
// (ended_at NULL) are never pruned.
export function pruneSessions(olderThan: string): { removed: number[] } {
  const m = olderThan.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`Invalid --older-than '${olderThan}'. Use 30d, 12h or 45m`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  const cutoff = new Date(Date.now() - Number(m[1]) * unit).toISOString();
  const db = openDb();
  try {
    const rows = db
      .prepare('SELECT id FROM session WHERE started_at < ? AND ended_at IS NOT NULL')
      .all(cutoff) as { id: number }[];
    const remove = db.transaction((sids: number[]) => {
      for (const sid of sids) {
        db.prepare('DELETE FROM session_card WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM session WHERE id = ?').run(sid);
      }
    });
    remove(rows.map((r) => r.id));
    for (const r of rows) {
      fs.rmSync(sessionJsonlPath(r.id), { force: true });
      fs.rmSync(sessionStderrPath(r.id), { force: true });
      fs.rmSync(observationPath(r.id), { force: true });
    }
    return { removed: rows.map((r) => r.id) };
  } finally {
    db.close();
  }
}
