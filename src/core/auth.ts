import crypto from 'node:crypto';
import { now, openDb } from './db.js';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

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

export interface User {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
}

export interface Credential {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string[];
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface AuthSession {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_MS = 15 * 60 * 1000;
const TOUCH_MS = 24 * 60 * 60 * 1000;

// One owner for now (spec: multi-user is a non-goal). Created on first use.
export function ensureOwner(): User {
  const db = openDb();
  try {
    const row = db.prepare('SELECT * FROM user ORDER BY created_at LIMIT 1').get() as User | undefined;
    if (row) return row;
    const user: User = { id: b64url(crypto.randomBytes(12)), name: 'owner', email: null, created_at: now() };
    db.prepare('INSERT INTO user (id, name, email, created_at) VALUES (?, ?, ?, ?)').run(
      user.id,
      user.name,
      user.email,
      user.created_at
    );
    return user;
  } finally {
    db.close();
  }
}

export function createEnrolToken(name: string): { token: string; expires_at: string; name: string } {
  const label = name.trim();
  if (!label) throw new Error('--name is required: a label for the device, e.g. iPhone');
  const user = ensureOwner();
  const token = b64url(crypto.randomBytes(32));
  const expires_at = plusMs(TOKEN_MS);
  const db = openDb();
  try {
    db.prepare('INSERT INTO enrol_token (token_hash, user_id, name, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256(token),
      user.id,
      label,
      expires_at
    );
  } finally {
    db.close();
  }
  return { token, expires_at, name: label };
}

interface EnrolRow {
  user_id: string;
  name: string;
  expires_at: string;
  used_at: string | null;
}

export function lookupEnrolToken(token: string): { user: User; name: string } {
  const db = openDb();
  try {
    const row = db.prepare('SELECT * FROM enrol_token WHERE token_hash = ?').get(sha256(token)) as EnrolRow | undefined;
    if (!row || row.used_at !== null || row.expires_at < now()) {
      throw new Error("Enrol link is invalid or expired. Run 'agentboard auth enrol' again");
    }
    const user = db.prepare('SELECT * FROM user WHERE id = ?').get(row.user_id) as User;
    return { user, name: row.name };
  } finally {
    db.close();
  }
}

export function consumeEnrolToken(token: string): void {
  const db = openDb();
  try {
    db.prepare('UPDATE enrol_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now(), sha256(token));
  } finally {
    db.close();
  }
}

function rowToCredential(r: any): Credential {
  return { ...r, transports: JSON.parse(r.transports ?? '[]') };
}

export function listCredentials(): Credential[] {
  const db = openDb();
  try {
    return (db.prepare('SELECT * FROM credential ORDER BY created_at').all() as any[]).map(rowToCredential);
  } finally {
    db.close();
  }
}

function getCredential(id: string): Credential | null {
  const db = openDb();
  try {
    const r = db.prepare('SELECT * FROM credential WHERE id = ?').get(id) as any;
    return r ? rowToCredential(r) : null;
  } finally {
    db.close();
  }
}

export async function registrationOptions(user: User): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const cfg = authConfig();
  const existing = listCredentials().filter((c) => c.user_id === user.id);
  return generateRegistrationOptions({
    rpName: 'Agentboard',
    rpID: cfg.rpID,
    userName: user.name,
    userDisplayName: user.name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })),
  });
}

export async function verifyRegistration(
  user: User,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  name: string
): Promise<Credential> {
  const cfg = authConfig();
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserVerification: false,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('Registration could not be verified');
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const row: Credential = {
    id: credential.id,
    user_id: user.id,
    public_key: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp ? 1 : 0,
    name,
    created_at: now(),
    last_used_at: null,
  };
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO credential (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      row.id,
      row.user_id,
      row.public_key,
      row.counter,
      JSON.stringify(row.transports),
      row.device_type,
      row.backed_up,
      row.name,
      row.created_at
    );
  } finally {
    db.close();
  }
  return row;
}

// No allowCredentials: the authenticator offers its discoverable passkeys,
// so the login page is one button and no username (spec Part 1).
export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const cfg = authConfig();
  return generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'preferred' });
}

export async function verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string): Promise<User> {
  const cfg = authConfig();
  const cred = getCredential(response.id);
  if (!cred) throw new Error('This passkey is not registered here');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserVerification: false,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(cred.public_key),
      counter: cred.counter,
      transports: cred.transports as AuthenticatorTransportFuture[],
    },
  });
  if (!v.verified) throw new Error('Sign-in could not be verified');
  const db = openDb();
  try {
    db.prepare('UPDATE credential SET counter = ?, last_used_at = ? WHERE id = ?').run(
      v.authenticationInfo.newCounter,
      now(),
      cred.id
    );
    return db.prepare('SELECT * FROM user WHERE id = ?').get(cred.user_id) as User;
  } finally {
    db.close();
  }
}

export function createSession(userId: string, userAgent: string | null): AuthSession {
  const at = now();
  const s: AuthSession = {
    id: b64url(crypto.randomBytes(32)),
    user_id: userId,
    created_at: at,
    expires_at: plusMs(SESSION_MS),
    last_seen_at: at,
    user_agent: userAgent,
  };
  const db = openDb();
  try {
    db.prepare(
      'INSERT INTO auth_session (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.user_agent);
  } finally {
    db.close();
  }
  return s;
}

export function getSession(id: string): AuthSession | null {
  const db = openDb();
  try {
    const s = db.prepare('SELECT * FROM auth_session WHERE id = ?').get(id) as AuthSession | undefined;
    if (!s || s.expires_at < now()) return null;
    return s;
  } finally {
    db.close();
  }
}

// Rolling expiry, written at most once a day so a 2.5 s poller does not
// turn every tick into a write.
export function touchSession(session: AuthSession): void {
  if (Date.now() - new Date(session.last_seen_at).getTime() < TOUCH_MS) return;
  const db = openDb();
  try {
    db.prepare('UPDATE auth_session SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
      now(),
      plusMs(SESSION_MS),
      session.id
    );
  } finally {
    db.close();
  }
}

export function deleteSession(id: string): void {
  const db = openDb();
  try {
    db.prepare('DELETE FROM auth_session WHERE id = ?').run(id);
  } finally {
    db.close();
  }
}

export function pruneAuth(): { sessions: number; tokens: number } {
  const db = openDb();
  try {
    const t = now();
    const sessions = db.prepare('DELETE FROM auth_session WHERE expires_at < ?').run(t).changes;
    const tokens = db.prepare('DELETE FROM enrol_token WHERE used_at IS NOT NULL OR expires_at < ?').run(t).changes;
    return { sessions, tokens };
  } finally {
    db.close();
  }
}
