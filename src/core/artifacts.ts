import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db.js';

export interface Artifact {
  name: string;
  bytes: number;
  mtime: string;
}

// Card ids are `${type}_${hex}`; anything else is refused so a card id can
// never be used to walk out of artifacts/.
function artifactsDir(cardId: string): string {
  if (!/^(task|ops)_[0-9a-f]+$/.test(cardId)) {
    throw new Error(`Invalid card id '${cardId}'`);
  }
  return path.join(dataDir(), 'artifacts', cardId);
}

// Read-only view; the dir may not exist (no artifacts yet) -> empty list.
export function listArtifacts(cardId: string): Artifact[] {
  const dir = artifactsDir(cardId);
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

// Absolute path of one artifact file. Only plain file names inside the
// card's own artifacts dir resolve; anything path-like is refused.
export function artifactPath(cardId: string, name: string): string {
  const dir = artifactsDir(cardId);
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error(`Invalid artifact name '${name}'`);
  }
  const abs = path.resolve(dir, name);
  if (path.dirname(abs) !== dir) {
    throw new Error(`Invalid artifact name '${name}'`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`No such artifact: ${name}`);
  }
  return abs;
}
