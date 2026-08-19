import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { simpleGit } from 'simple-git';
import { contextDir, openDb, secretsPath } from './db.js';
import { addEventIn, assertActor } from './cards.js';

// Paths are always relative to context/, e.g. 'chris/vakantiewoningen-nl.md'.
function resolveContextPath(relPath: string): string {
  const root = contextDir();
  if (!fs.existsSync(root)) {
    throw new Error(`No context dir at ${root}. Run 'agentboard init' first.`);
  }
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the context dir: ${relPath}`);
  }
  return abs;
}

export function listContextFiles(sub?: string): string[] {
  const root = resolveContextPath(sub ?? '.');
  if (!fs.existsSync(root)) {
    throw new Error(`No such context path: ${sub}`);
  }
  if (fs.statSync(root).isFile()) return [path.relative(contextDir(), root)];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(contextDir(), full));
    }
  };
  walk(root);
  return files;
}

export function readContext(relPath: string): {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  raw: string;
} {
  const abs = resolveContextPath(relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`No such context file: ${relPath}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = matter(raw);
  return { path: relPath, frontmatter: parsed.data, content: parsed.content, raw };
}

function validateContent(relPath: string, content: string): void {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
    throw new Error('Content contains a private key. A real secret in a .md is a bug — store it in secrets.env and use secret_ref.');
  }
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    throw new Error(`Invalid frontmatter in ${relPath}: ${err instanceof Error ? err.message : err}`);
  }
  if (!parsed.data.kind) {
    throw new Error(`Frontmatter is missing required field 'kind' (${relPath})`);
  }
  if (parsed.data.kind === 'connection' && !parsed.data.secret_ref) {
    throw new Error(`kind: connection requires 'secret_ref' — a name pointing into secrets.env, never a value (${relPath})`);
  }
}

export async function writeContext(
  relPath: string,
  content: string,
  opts: { cardId: string; actor: string; message?: string }
): Promise<{ path: string; action: 'add' | 'update'; message: string; commit: string }> {
  const actor = assertActor(opts.actor);
  validateContent(relPath, content);
  const abs = resolveContextPath(relPath);

  const db = openDb();
  try {
    // Card must exist: the commit message and the event both reference it.
    const card = db.prepare('SELECT id FROM card WHERE id = ?').get(opts.cardId);
    if (!card) throw new Error(`Card not found: ${opts.cardId}`);

    const action = fs.existsSync(abs) ? 'update' : 'add';
    const name = path.basename(relPath, '.md');
    const message = opts.message ?? `ctx: ${action} ${name} (${opts.cardId})`;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);

    // Invariant 3: one write = one git commit + one context_written event.
    const git = simpleGit(contextDir());
    await git.add(relPath);
    const result = await git.commit(message);

    addEventIn(db, opts.cardId, 'context_written', actor, { path: relPath, message, action });
    return { path: relPath, action, message, commit: result.commit };
  } finally {
    db.close();
  }
}

export function getSecret(name: string): string {
  const file = secretsPath();
  if (!fs.existsSync(file)) {
    throw new Error(`No secrets.env at ${file}. Run 'agentboard init' first.`);
  }
  const key = name.toUpperCase();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim();
  }
  throw new Error(`No secret named ${key} in secrets.env`);
}
