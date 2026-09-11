import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionStatus } from './runner.js';

// Releases never deploy (spec Part 4): a running Agentboard notices the
// newest GitHub release and pulls it on request. Three strategies, chosen
// from the environment: fly (swap the machine image), git (checkout the
// tag and rebuild), image (notice only).
export const IMAGE = 'ghcr.io/robbertvermeulen/agentboard';
const RELEASES_URL = 'https://api.github.com/repos/Robbertvermeulen/agentboard/releases/latest';
const CACHE_MS = 60 * 60 * 1000;

const appRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function currentVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { version: string };
  return String(pkg.version);
}

export interface Release {
  version: string;
  url: string;
  published_at: string | null;
}

let cache: { at: number; release: Release | null } | null = null;

export async function latestRelease(opts?: { fresh?: boolean }): Promise<Release | null> {
  if (!opts?.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.release;
  let release: Release | null = null;
  try {
    const res = await fetch(process.env.AGENTBOARD_RELEASES_URL ?? RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentboard' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const j = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string | null };
      const version = String(j.tag_name ?? '').replace(/^v/, '');
      if (version) release = { version, url: String(j.html_url ?? ''), published_at: j.published_at ?? null };
    }
  } catch {
    release = null; // offline, rate-limited, or a stub that is not there: no notice, no error
  }
  cache = { at: Date.now(), release };
  return release;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type Strategy = 'fly' | 'git' | 'image';

export function strategy(): Strategy {
  if (process.env.FLY_APP_NAME && process.env.FLY_MACHINE_ID && process.env.FLY_API_TOKEN) return 'fly';
  if (fs.existsSync(path.join(appRoot(), '.git'))) return 'git';
  return 'image';
}

export interface VersionInfo {
  version: string;
  latest: Release | null;
  strategy: Strategy;
  updateAvailable: boolean;
}

export async function versionInfo(opts?: { fresh?: boolean }): Promise<VersionInfo> {
  const version = currentVersion();
  const latest = await latestRelease(opts);
  return {
    version,
    latest,
    strategy: strategy(),
    updateAvailable: latest !== null && compareVersions(version, latest.version) < 0,
  };
}
