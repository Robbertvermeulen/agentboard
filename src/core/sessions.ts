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
  replacements.sort((a, b) => b.value.length - a.value.length); // longest first
  return (text) => {
    let out = text;
    for (const r of replacements) out = out.split(r.value).join(`[secret:${r.name}]`);
    return out;
  };
}

export const redactSecrets = (text: string): string => secretRedactor()(text);
