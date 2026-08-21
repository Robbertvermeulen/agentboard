import fs from 'node:fs';
import path from 'node:path';
import { dataDir, openDb } from './db.js';
import { addEventIn, assertActor } from './cards.js';

export interface Upload {
  name: string;
  bytes: number;
  mtime: string;
}

// Same guard as artifactsDir: a card id can never walk out of uploads/.
function uploadsDir(cardId: string): string {
  if (!/^(task|ops)_[0-9a-f]+$/.test(cardId)) {
    throw new Error(`Invalid card id '${cardId}'`);
  }
  return path.join(dataDir(), 'uploads', cardId);
}

function assertPlainName(name: string): void {
  if (name !== path.basename(name) || name === '.' || name === '..' || !name) {
    throw new Error(`Invalid upload name '${name}'`);
  }
}

// The dir may not exist (no uploads yet) -> empty list.
export function listUploads(cardId: string): Upload[] {
  const dir = uploadsDir(cardId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, entry.name));
      return { name: entry.name, bytes: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// Uploads are permanent: never overwrite. A name conflict gets a suffix
// (file-2.ext, file-3.ext, ...).
function freeName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 2;
  while (fs.existsSync(path.join(dir, `${stem}-${n}${ext}`))) n++;
  return `${stem}-${n}${ext}`;
}

// One file in, one upload_added event with {name, bytes} — never the content.
export function addUpload(cardId: string, name: string, data: Buffer, actor: string): Upload {
  const a = assertActor(actor);
  assertPlainName(name);
  const dir = uploadsDir(cardId);
  const db = openDb();
  try {
    if (!db.prepare('SELECT 1 FROM card WHERE id = ?').get(cardId)) {
      throw new Error(`Card not found: ${cardId}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const finalName = freeName(dir, name);
    const abs = path.resolve(dir, finalName);
    if (path.dirname(abs) !== dir) {
      throw new Error(`Invalid upload name '${name}'`);
    }
    fs.writeFileSync(abs, data);
    addEventIn(db, cardId, 'upload_added', a, { name: finalName, bytes: data.length });
    const stat = fs.statSync(abs);
    return { name: finalName, bytes: stat.size, mtime: stat.mtime.toISOString() };
  } finally {
    db.close();
  }
}

// Absolute path of one upload for read-only serving; mirrors artifactPath.
export function uploadPath(cardId: string, name: string): string {
  const dir = uploadsDir(cardId);
  assertPlainName(name);
  const abs = path.resolve(dir, name);
  if (path.dirname(abs) !== dir) {
    throw new Error(`Invalid upload name '${name}'`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`No such upload: ${name}`);
  }
  return abs;
}
