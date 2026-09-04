import crypto from 'node:crypto';
import { now, openDb } from './db.js';

// Auth is on iff AGENTBOARD_ORIGIN is set. The RP ID is the origin's
// hostname; the expected origin is the origin itself. Without an origin
// `serve` binds localhost only (see startServer) — never open and unlocked.
export interface AuthConfig {
  enabled: boolean;
  origin: string;
  rpID: string;
  secret: string;
  secure: boolean;
}

export function authConfig(): AuthConfig {
  const raw = (process.env.AGENTBOARD_ORIGIN ?? '').trim();
  if (!raw) return { enabled: false, origin: '', rpID: '', secret: '', secure: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AGENTBOARD_ORIGIN must be a URL like https://board.example.com (got '${raw}')`);
  }
  const secret = process.env.AGENTBOARD_SESSION_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error('AGENTBOARD_SESSION_SECRET must be set (at least 32 characters) when AGENTBOARD_ORIGIN is set');
  }
  return { enabled: true, origin: url.origin, rpID: url.hostname, secret, secure: url.protocol === 'https:' };
}

export const b64url = (buf: Buffer): string => buf.toString('base64url');
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const plusMs = (ms: number): string => new Date(Date.now() + ms).toISOString();

// Re-exported so later tasks in this module can use them without re-importing.
export { now, openDb };
