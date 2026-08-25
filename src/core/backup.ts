import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dataDir, dbPath } from './db.js';

// One backup = the package minus what is reconstructable: a VACUUM INTO
// snapshot of the db (a live WAL db cannot be cp'd safely), plus
// secrets.env, artifacts/, uploads/ and the context repo (including its
// git history). work/ stays out: disposable by definition (rule 12).
export function createBackup(outDir?: string): { archive: string; bytes: number } {
  if (!fs.existsSync(dbPath())) {
    throw new Error(`Not initialized at ${dataDir()}. Run 'agentboard init' first.`);
  }
  const out = outDir || path.join(os.homedir(), '.agentboard-backups');
  if (path.resolve(out).startsWith(path.resolve(dataDir()) + path.sep)) {
    throw new Error('Backup directory must live outside the data dir');
  }
  fs.mkdirSync(out, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const name = `agentboard-${stamp}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-backup-'));
  try {
    const root = path.join(staging, name);
    fs.mkdirSync(root);

    const db = new Database(dbPath());
    try {
      db.exec(`VACUUM INTO '${path.join(root, 'board.db').replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }

    for (const entry of ['secrets.env', 'artifacts', 'uploads', 'context']) {
      const src = path.join(dataDir(), entry);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(root, entry), { recursive: true });
    }

    const archive = path.join(out, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', staging, name]);
    fs.chmodSync(archive, 0o600); // the tar contains secrets.env
    return { archive, bytes: fs.statSync(archive).size };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
