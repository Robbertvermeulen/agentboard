# Passkey Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passkey (WebAuthn) login for the web UI: one owner, enrol from the CLI, sign in with one tap on the phone; the API is closed without a session; `serve` without an origin stays localhost-only.

**Architecture:** A new core module `src/core/auth.ts` wraps `@simplewebauthn/server` and owns four new SQLite tables. `src/api/server.ts` gets two middlewares (Origin check, session check) and six `/auth/*` routes; challenges and the session id travel in signed cookies. The no-build UI gets a login view and an enrol view on the existing hash router, plus a vendored copy of `@simplewebauthn/browser`. Verification follows the repo convention: a bash probe (`verify-auth.sh`) with curl legs and one Playwright leg using a virtual authenticator.

**Tech Stack:** Node 22, TypeScript, Hono 4 (`hono/cookie`), better-sqlite3, `@simplewebauthn/server` 13, `@simplewebauthn/browser` 13 (vendored), Playwright (devDependency, probe only).

**Spec:** `docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md` — Part 1.

## Global Constraints

- Node `>=22` (package.json `engines`). No test framework: verification is `docs/superpowers/plans/verify-auth.sh`, exit non-zero on the first deviation, throwaway `AGENTBOARD_DATA` per leg. Never touch `~/.agentboard`.
- Style: match `src/api/server.ts` (try/`errorResponse` per route, `c.json`), `src/cli/index.ts` (`run()` wrapper, `output(opts, text, json)`, `--json` on every command), `web/js` (ES modules, template literals, `esc()` for every interpolated string, existing CSS classes).
- Conventional commits, one per task, on branch `feat/auth-passkeys` off `main`.
- Auth is on iff `AGENTBOARD_ORIGIN` is set. `AGENTBOARD_SESSION_SECRET` must be ≥ 32 chars when auth is on. Table names: `user`, `credential`, `auth_session`, `enrol_token` (never `session`: taken by agent sessions).
- Cookies: `ab_session` (30 days, rolling), `ab_chal` (300 s). Flags: `HttpOnly`, `Secure` iff origin is https, `SameSite=Lax`, `Path=/`.
- Login uses discoverable credentials: `generateAuthenticationOptions` without `allowCredentials`; `residentKey: 'required'` at registration.
- `requireUserVerification: false` on both verifies (phones verify anyway; laptops without a PIN must not be locked out).

---

### Task 1: Schema, config, dependencies, branch

**Files:**
- Modify: `src/core/db.ts:36-90` (SCHEMA)
- Create: `src/core/auth.ts` (config part only in this task)
- Modify: `package.json` (dependencies, devDependencies, `vendor` script)
- Create: `docs/superpowers/plans/verify-auth.sh` (leg 0)

**Interfaces:**
- Produces: `authConfig(): AuthConfig` with `AuthConfig = { enabled: boolean; origin: string; rpID: string; secret: string; secure: boolean }`. Four tables in `board.db`.

- [ ] **Step 1: Branch and dependencies**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/auth-passkeys
npm install @simplewebauthn/server@^13
npm install --save-dev @simplewebauthn/browser@^13 playwright@^1
ls node_modules/@simplewebauthn/browser/dist/bundle/
```

Expected: the `ls` shows the UMD bundles (`index.umd.min.js`, `index.es5.umd.min.js`). The package ships no single-file ESM bundle (its `esm/` entry is a multi-file tree), so the UI vendors the UMD build and reads it from the global `window.SimpleWebAuthnBrowser`.

- [ ] **Step 2: Add the `vendor` script**

In `package.json` `scripts`:

```json
"scripts": {
  "build": "tsc",
  "vendor": "mkdir -p web/js/vendor && cp node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js web/js/vendor/simplewebauthn-browser.js"
}
```

- [ ] **Step 3: Write the failing probe leg 0 (tables exist after init)**

Create `docs/superpowers/plans/verify-auth.sh`:

```bash
#!/usr/bin/env bash
# End-to-end probe for passkey auth (spec 2026-09-04 Part 1): schema, config,
# enrol tokens, cookies, Origin check, 401/403, localhost-only when off, and a
# full register + login round trip with a virtual authenticator (Playwright).
# Throwaway AGENTBOARD_DATA per leg; exits non-zero on the first deviation.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
CLI="node dist/cli/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
wait_port() { for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$1/" && return 0; perl -e 'select(undef,undef,undef,0.1)'; done; fail "serve on $1 never came up"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

# ============================================================================
# Leg 0: init creates the four auth tables (Task 1)
# ============================================================================
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.AGENTBOARD_DATA + '/board.db');
const names = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name);
for (const t of ['user','credential','auth_session','enrol_token']) if (!names.includes(t)) { console.error('missing table ' + t); process.exit(1); }
"
echo "leg 0 ok: auth tables"
```

Run: `chmod +x docs/superpowers/plans/verify-auth.sh && npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: FAIL with `missing table user`.

- [ ] **Step 4: Add the tables to SCHEMA**

In `src/core/db.ts`, after the `session_card` table inside the `SCHEMA` template string, add:

```sql
CREATE TABLE IF NOT EXISTS user (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id),
  public_key   BLOB NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '[]',
  device_type  TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_session (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS enrol_token (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id),
  name       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
```

`initData` already runs `SCHEMA` with `IF NOT EXISTS` on every init, so an existing `board.db` gains the tables on the next `agentboard init` — no migration code needed.

- [ ] **Step 5: Create `src/core/auth.ts` with the config function**

```ts
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
```

- [ ] **Step 6: Run the probe**

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: `leg 0 ok: auth tables`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/core/db.ts src/core/auth.ts docs/superpowers/plans/verify-auth.sh
git commit -m "feat(auth): schema, config and dependencies for passkey login"
```

---

### Task 2: Core: users, enrol tokens, credentials, sessions

**Files:**
- Modify: `src/core/auth.ts`
- Modify: `docs/superpowers/plans/verify-auth.sh` (leg 1)

**Interfaces:**
- Consumes: `authConfig()`, `b64url`, `sha256`, `plusMs`, `now`, `openDb` from Task 1.
- Produces (all exported from `src/core/auth.ts`):
  - `interface User { id: string; name: string; email: string | null; created_at: string }`
  - `interface Credential { id: string; user_id: string; public_key: Buffer; counter: number; transports: string[]; device_type: string | null; backed_up: number; name: string; created_at: string; last_used_at: string | null }`
  - `interface AuthSession { id: string; user_id: string; created_at: string; expires_at: string; last_seen_at: string; user_agent: string | null }`
  - `ensureOwner(): User`
  - `createEnrolToken(name: string): { token: string; expires_at: string; name: string }`
  - `lookupEnrolToken(token: string): { user: User; name: string }` (throws on unknown/expired/used)
  - `consumeEnrolToken(token: string): void`
  - `registrationOptions(user: User): Promise<PublicKeyCredentialCreationOptionsJSON>`
  - `verifyRegistration(user: User, response: RegistrationResponseJSON, expectedChallenge: string, name: string): Promise<Credential>`
  - `authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>`
  - `verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string): Promise<User>`
  - `listCredentials(): Credential[]`
  - `createSession(userId: string, userAgent: string | null): AuthSession`
  - `getSession(id: string): AuthSession | null` (null when missing or expired)
  - `touchSession(session: AuthSession): void`
  - `deleteSession(id: string): void`
  - `pruneAuth(): { sessions: number; tokens: number }`

- [ ] **Step 1: Write the failing probe leg 1 (tokens and sessions via a node script)**

Append to `verify-auth.sh`:

```bash
# ============================================================================
# Leg 1: core — owner, enrol token lifecycle, sessions (Task 2)
# ============================================================================
export AGENTBOARD_ORIGIN="http://localhost:4666"
export AGENTBOARD_SESSION_SECRET="probe-secret-probe-secret-probe-secret-1234"
node --input-type=module -e "
import { ensureOwner, createEnrolToken, lookupEnrolToken, consumeEnrolToken, createSession, getSession, deleteSession, pruneAuth, registrationOptions, authenticationOptions } from '$ROOT/dist/core/auth.js';
const u = ensureOwner();
if (u.name !== 'owner' || ensureOwner().id !== u.id) throw new Error('ensureOwner not idempotent');
const t = createEnrolToken('iPhone');
if (!t.token || t.name !== 'iPhone') throw new Error('token shape');
if (lookupEnrolToken(t.token).name !== 'iPhone') throw new Error('lookup');
let threw = false; try { lookupEnrolToken('nope'); } catch { threw = true; } if (!threw) throw new Error('bogus token accepted');
consumeEnrolToken(t.token);
threw = false; try { lookupEnrolToken(t.token); } catch { threw = true; } if (!threw) throw new Error('used token accepted');
const s = createSession(u.id, 'probe-agent');
if (!getSession(s.id)) throw new Error('session missing');
deleteSession(s.id);
if (getSession(s.id)) throw new Error('session not deleted');
const ro = await registrationOptions(u);
if (ro.rp.id !== 'localhost' || ro.authenticatorSelection.residentKey !== 'required') throw new Error('registration options');
const ao = await authenticationOptions();
if (ao.rpId !== 'localhost' || ao.allowCredentials !== undefined) throw new Error('authentication options must be discoverable');
const p = pruneAuth();
if (typeof p.tokens !== 'number') throw new Error('prune');
"
echo "leg 1 ok: core"
```

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: FAIL (`does not provide an export named 'ensureOwner'`).

- [ ] **Step 2: Implement the core in `src/core/auth.ts`**

Append below the config section:

```ts
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
```

Move the `import crypto` line to the top of the file (imports must come first); the `export { now, openDb }` line from Task 1 can be deleted now that this file uses them directly.

- [ ] **Step 3: Build and run the probe**

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: `leg 0 ok`, `leg 1 ok: core`. If `tsc` complains about `registrationInfo.credential`, check the installed `@simplewebauthn/server` is ≥ 13 (`npm ls @simplewebauthn/server`).

- [ ] **Step 4: Commit**

```bash
git add src/core/auth.ts docs/superpowers/plans/verify-auth.sh
git commit -m "feat(auth): core — owner, enrol tokens, credentials, sessions"
```

---

### Task 3: CLI: `auth enrol`, `auth list`

**Files:**
- Modify: `src/cli/index.ts` (add after the `secret` command group, before `sessions`)
- Modify: `docs/superpowers/plans/verify-auth.sh` (leg 2)

**Interfaces:**
- Consumes: `authConfig`, `createEnrolToken`, `listCredentials` from `src/core/auth.ts`.
- Produces: `agentboard auth enrol --name <label> [--json]` → text `Open this link on the device you want to enrol (valid 15 minutes):\n  <url>` / JSON `{ url, expires_at, name }`. `agentboard auth list [--json]` → one line per credential / JSON `{ credentials }`.

- [ ] **Step 1: Write the failing probe leg 2**

Append to `verify-auth.sh`:

```bash
# ============================================================================
# Leg 2: CLI — auth enrol prints a fragment URL, auth list, off without origin (Task 3)
# ============================================================================
URL=$($CLI auth enrol --name "Probe phone" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
case "$URL" in "http://localhost:4666/#/enrol/"*) ;; *) fail "enrol url shape: $URL";; esac
$CLI auth list | grep -q "No passkeys yet" || fail "auth list before enrol"
( unset AGENTBOARD_ORIGIN; expect_fail $CLI auth enrol --name x )
echo "leg 2 ok: cli"
```

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: FAIL (`error: unknown command 'auth'`).

- [ ] **Step 2: Add the command group**

In `src/cli/index.ts`, add to the imports: `import { authConfig, createEnrolToken, listCredentials } from '../core/auth.js';`. After the `secret get` command, add:

```ts
const auth = program.command('auth').description('passkey login for the web UI (on when AGENTBOARD_ORIGIN is set)');

auth
  .command('enrol')
  .description('print a one-time link (15 min) to register a passkey on a device')
  .requiredOption('--name <label>', 'device label, e.g. iPhone')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const cfg = authConfig();
      if (!cfg.enabled) {
        throw new Error('Auth is off: set AGENTBOARD_ORIGIN (and AGENTBOARD_SESSION_SECRET) on the serve process first');
      }
      const t = createEnrolToken(opts.name);
      const url = `${cfg.origin}/#/enrol/${t.token}`;
      output(
        opts,
        `Open this link on the device you want to enrol (valid 15 minutes):\n  ${url}`,
        { url, expires_at: t.expires_at, name: t.name }
      );
    })
  );

auth
  .command('list')
  .description('registered passkeys')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const credentials = listCredentials();
      const lines = credentials.map(
        (c) =>
          `  ${c.name.padEnd(16)} ${(c.device_type ?? '-').padEnd(12)} ${c.backed_up ? 'synced ' : 'device '} created ${c.created_at}  last used ${c.last_used_at ?? 'never'}`
      );
      output(opts, lines.length ? lines.join('\n') : 'No passkeys yet', { credentials });
    })
  );
```

- [ ] **Step 3: Run the probe**

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: `leg 2 ok: cli`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts docs/superpowers/plans/verify-auth.sh
git commit -m "feat(auth): cli — auth enrol and auth list"
```

---

### Task 4: HTTP: middlewares, cookies, `/auth/*` routes, localhost-only bind

**Files:**
- Modify: `src/api/server.ts` (imports, top of `createApp`, new routes before `app.get('/api/boards'…)`, `startServer`)
- Modify: `docs/superpowers/plans/verify-auth.sh` (leg 3)

**Interfaces:**
- Consumes: everything exported from `src/core/auth.ts`.
- Produces: routes `GET /auth/state`, `POST /auth/register/options`, `POST /auth/register/verify`, `POST /auth/login/options`, `POST /auth/login/verify`, `POST /auth/logout`. Middleware behaviour: `401 { error: 'unauthenticated' }` on `/api/*` without a session; `403 { error: 'bad origin' }` on mutating requests with a wrong/missing `Origin`. `startServer(port)` binds `127.0.0.1` when auth is off, `0.0.0.0` when on.

- [ ] **Step 1: Write the failing probe leg 3**

Append to `verify-auth.sh`:

```bash
# ============================================================================
# Leg 3: HTTP — 401, Origin check, state, options endpoints, localhost-only (Task 4)
# ============================================================================
PORT=$(free_port)
export AGENTBOARD_ORIGIN="http://localhost:$PORT"
$CLI serve --port "$PORT" >/dev/null 2>&1 & PIDS+=($!)
wait_port "$PORT"
B="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
[ "$(code "$B/")" = "200" ] || fail "static shell must be public"
[ "$(code "$B/api/boards")" = "401" ] || fail "api without session must be 401"
[ "$(code -X POST -H "Content-Type: application/json" -d '{}' "$B/api/boards")" = "403" ] || fail "mutating request without Origin must be 403"
[ "$(code -X POST -H "Origin: http://evil.example" -H "Content-Type: application/json" -d '{}' "$B/api/boards")" = "403" ] || fail "wrong Origin must be 403"
curl -s "$B/auth/state" | grep -q '"auth":true' || fail "auth state on"
[ "$(code -X POST -H "Origin: $AGENTBOARD_ORIGIN" -H "Content-Type: application/json" -d '{"token":"bogus"}' "$B/auth/register/options")" = "400" ] || fail "bogus enrol token must be 400"
TOKEN=$($CLI auth enrol --name "Probe laptop" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'].split('/enrol/')[1])")
curl -s -c /tmp/ab-chal.txt -X POST -H "Origin: $AGENTBOARD_ORIGIN" -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" "$B/auth/register/options" | grep -q '"challenge"' || fail "register options"
grep -q ab_chal /tmp/ab-chal.txt || fail "challenge cookie not set"
curl -s -X POST -H "Origin: $AGENTBOARD_ORIGIN" -H "Content-Type: application/json" -d '{}' "$B/auth/login/options" | grep -q '"challenge"' || fail "login options"
kill "${PIDS[-1]}"; unset 'PIDS[-1]'

# auth off: localhost only, no 401
( unset AGENTBOARD_ORIGIN AGENTBOARD_SESSION_SECRET
  P2=$(free_port)
  $CLI serve --port "$P2" >/tmp/ab-serve-off.log 2>&1 & SP=$!
  for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$P2/api/boards" && break; perl -e 'select(undef,undef,undef,0.1)'; done
  curl -sf "http://127.0.0.1:$P2/api/boards" | grep -q '"boards"' || { kill $SP; fail "auth off must serve the api on localhost"; }
  curl -s "http://127.0.0.1:$P2/auth/state" | grep -q '"auth":false' || { kill $SP; fail "auth state off"; }
  grep -q "localhost only" /tmp/ab-serve-off.log || { kill $SP; fail "serve must announce localhost-only"; }
  kill $SP )
echo "leg 3 ok: http"
```

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: FAIL at `api without session must be 401`.

- [ ] **Step 2: Imports and helpers in `src/api/server.ts`**

Add to the imports:

```ts
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import {
  AuthConfig,
  authConfig,
  authenticationOptions,
  consumeEnrolToken,
  createSession,
  deleteSession,
  getSession,
  lookupEnrolToken,
  pruneAuth,
  registrationOptions,
  touchSession,
  verifyAuthentication,
  verifyRegistration,
} from '../core/auth.js';
```

Below `errorResponse`, add:

```ts
// Cookie rules (spec Part 1): HttpOnly always, Secure iff the origin is
// https, SameSite=Lax, Path=/. ab_session rolls 30 days; ab_chal lives 300 s.
const SESSION_COOKIE = 'ab_session';
const CHALLENGE_COOKIE = 'ab_chal';

function cookieOpts(auth: AuthConfig, maxAge: number) {
  return { path: '/', httpOnly: true, secure: auth.secure, sameSite: 'Lax' as const, maxAge };
}

interface Challenge {
  purpose: 'register' | 'login';
  challenge: string;
  token?: string;
}

async function setChallenge(c: Context, auth: AuthConfig, data: Challenge): Promise<void> {
  await setSignedCookie(c, CHALLENGE_COOKIE, JSON.stringify(data), auth.secret, cookieOpts(auth, 300));
}

async function takeChallenge(c: Context, auth: AuthConfig, purpose: Challenge['purpose']): Promise<Challenge> {
  const raw = await getSignedCookie(c, auth.secret, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: '/' });
  if (!raw) throw new Error('Challenge expired — try again');
  const data = JSON.parse(raw) as Challenge;
  if (data.purpose !== purpose) throw new Error('Challenge mismatch — try again');
  return data;
}

async function startSession(c: Context, auth: AuthConfig, userId: string): Promise<void> {
  const s = createSession(userId, c.req.header('user-agent') ?? null);
  await setSignedCookie(c, SESSION_COOKIE, s.id, auth.secret, cookieOpts(auth, 30 * 24 * 60 * 60));
}
```

- [ ] **Step 3: Middlewares and routes at the top of `createApp`**

Replace the first two lines of `createApp` (`const app = new Hono();`) with:

```ts
  const app = new Hono();
  const auth = authConfig();

  // Public: tells the UI whether to expect a login and whether to show Sign out.
  app.get('/auth/state', async (c) => {
    if (!auth.enabled) return c.json({ auth: false });
    const id = await getSignedCookie(c, auth.secret, SESSION_COOKIE);
    const session = id ? getSession(id) : null;
    return c.json({ auth: true, user: session ? { name: 'owner' } : null });
  });

  if (auth.enabled) {
    // Origin check on every mutating request replaces CSRF tokens: a
    // cross-site form or fetch never carries our origin.
    app.use('*', async (c, next) => {
      const m = c.req.method;
      const guarded = c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/');
      if (guarded && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && c.req.header('origin') !== auth.origin) {
        return c.json({ error: 'bad origin' }, 403);
      }
      await next();
    });

    // The static shell stays public (it carries no data); every /api route
    // needs a live session.
    app.use('/api/*', async (c, next) => {
      const id = await getSignedCookie(c, auth.secret, SESSION_COOKIE);
      const session = id ? getSession(id) : null;
      if (!session) return c.json({ error: 'unauthenticated' }, 401);
      touchSession(session);
      await next();
    });

    app.post('/auth/register/options', async (c) => {
      try {
        const body = await c.req.json();
        const token = String(body.token ?? '');
        const { user, name } = lookupEnrolToken(token);
        const options = await registrationOptions(user);
        await setChallenge(c, auth, { purpose: 'register', challenge: options.challenge, token });
        return c.json({ options, name });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/register/verify', async (c) => {
      try {
        const body = await c.req.json();
        const chal = await takeChallenge(c, auth, 'register');
        const token = String(body.token ?? '');
        if (chal.token !== token) throw new Error('Enrol token mismatch — open the link again');
        const { user, name } = lookupEnrolToken(token);
        const cred = await verifyRegistration(user, body.response, chal.challenge, String(body.name || name));
        consumeEnrolToken(token);
        await startSession(c, auth, user.id);
        return c.json({ ok: true, credential: { id: cred.id, name: cred.name } }, 201);
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/login/options', async (c) => {
      try {
        const options = await authenticationOptions();
        await setChallenge(c, auth, { purpose: 'login', challenge: options.challenge });
        return c.json({ options });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/login/verify', async (c) => {
      try {
        const body = await c.req.json();
        const chal = await takeChallenge(c, auth, 'login');
        const user = await verifyAuthentication(body.response, chal.challenge);
        await startSession(c, auth, user.id);
        return c.json({ ok: true });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/logout', async (c) => {
      const id = await getSignedCookie(c, auth.secret, SESSION_COOKIE);
      if (id) deleteSession(id);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
  }
```

`errorResponse` maps "invalid or expired" messages to 400 (its regex only promotes not-found wording to 404), which is what leg 3 expects.

- [ ] **Step 4: Bind and announce in `startServer`**

Replace `startServer`:

```ts
export function startServer(port: number): void {
  const auth = authConfig();
  if (auth.enabled) pruneAuth();
  // Without an origin there is no auth, so the server must not be reachable
  // from other hosts: bind the loopback interface only.
  const hostname = auth.enabled ? '0.0.0.0' : '127.0.0.1';
  serve({ fetch: createApp().fetch, port, hostname });
  console.log(
    auth.enabled
      ? `Agentboard on ${auth.origin} (port ${port}, passkey auth on)`
      : `Agentboard on http://localhost:${port} (auth off — listening on localhost only; set AGENTBOARD_ORIGIN to expose it)`
  );
}
```

- [ ] **Step 5: Run the probe**

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: `leg 3 ok: http`.

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts docs/superpowers/plans/verify-auth.sh
git commit -m "feat(auth): http — session and origin middlewares, /auth routes, localhost-only when off"
```

---

### Task 5: UI: vendored browser lib, 401 handling, login and enrol views, sign out

**Files:**
- Create: `web/js/vendor/simplewebauthn-browser.js` (via `npm run vendor`)
- Create: `web/js/views/login.js`, `web/js/views/enrol.js`
- Modify: `web/js/api.js` (status on errors, `auth` group)
- Modify: `web/js/app.js` (route parsing, 401 → login, enrol route, sign out in sidebar and More-sheet)
- Modify: `web/style.css` (`.auth-view`), `web/index.html` (script tag for the vendored library)
- Modify: `docs/superpowers/plans/verify-auth.sh` (leg 4, Playwright), Create: `docs/superpowers/plans/verify-auth-browser.mjs`

**Interfaces:**
- Consumes: `/auth/*` routes from Task 4.
- Produces: `api.auth.state()`, `api.auth.registerOptions(token)`, `api.auth.registerVerify(token, response, name)`, `api.auth.loginOptions()`, `api.auth.loginVerify(response)`, `api.auth.logout()`; `renderLogin(view, { next })`, `renderEnrol(view, { token })`; route `#/enrol/<token>`.

- [ ] **Step 1: Vendor the browser library**

```bash
npm run vendor
head -c 120 web/js/vendor/simplewebauthn-browser.js
```

Expected: the file begins with the MIT header (`/* [@simplewebauthn/browser@13.…] */`) followed by the UMD wrapper (`!function(e,t){…}`). It defines the global `window.SimpleWebAuthnBrowser` with `startRegistration` and `startAuthentication`. Load it from `web/index.html` with a classic script tag placed **before** the module script, so the global exists when the views run:

```html
<script src="./js/vendor/simplewebauthn-browser.js"></script>
<script type="module" src="./js/app.js"></script>
```

- [ ] **Step 2: Write the Playwright probe (failing)**

Create `docs/superpowers/plans/verify-auth-browser.mjs`:

```js
// Register + login round trip with a CDP virtual authenticator. Usage:
//   node verify-auth-browser.mjs <base url> <enrol url>
// Exits non-zero on the first deviation. Needs `npx playwright install chromium` once.
import { chromium } from 'playwright';

const [base, enrolUrl] = process.argv.slice(2);
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

// 1. Enrol: open the link, register, land on the board.
await page.goto(enrolUrl);
await page.getByRole('button', { name: 'Register this device' }).click();
await page.waitForSelector('.side-logo', { timeout: 15000 }).catch(() => fail('board did not render after enrol'));
const boards = await page.evaluate(() => fetch('/api/boards').then((r) => r.status));
if (boards !== 200) fail('api after enrol: ' + boards);

// 2. Sign out → 401 → login view.
await page.click('#side-signout');
await page.waitForSelector('#login-btn', { timeout: 15000 }).catch(() => fail('login view did not render after sign out'));
const after = await page.evaluate(() => fetch('/api/boards').then((r) => r.status));
if (after !== 401) fail('api after sign out: ' + after);

// 3. One-click login with the discoverable credential.
await page.click('#login-btn');
await page.waitForSelector('.side-logo', { timeout: 15000 }).catch(() => fail('board did not render after login'));
const again = await page.evaluate(() => fetch('/api/boards').then((r) => r.status));
if (again !== 200) fail('api after login: ' + again);

await browser.close();
console.log('browser round trip ok');
```

Append to `verify-auth.sh`:

```bash
# ============================================================================
# Leg 4: browser — enrol, sign out, one-click login with a virtual authenticator (Task 5)
# ============================================================================
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
PORT=$(free_port)
export AGENTBOARD_ORIGIN="http://localhost:$PORT"
$CLI serve --port "$PORT" >/dev/null 2>&1 & PIDS+=($!)
wait_port "$PORT"
ENROL=$($CLI auth enrol --name "Probe phone" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
node docs/superpowers/plans/verify-auth-browser.mjs "$AGENTBOARD_ORIGIN" "$ENROL"
$CLI auth list | grep -q "Probe phone" || fail "auth list after enrol"
$CLI auth list --json | python3 -c "import json,sys; c=json.load(sys.stdin)['credentials']; assert c[0]['last_used_at'], 'last_used_at not set by login'"
echo "leg 4 ok: browser"
echo "ALL OK"
```

Run: `npx playwright install chromium` (once), then `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: FAIL at `board did not render after enrol` (no enrol view yet).

- [ ] **Step 3: `api.js` — status on errors and the auth group**

Replace `req()` and add the group:

```js
async function req(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
```

Inside `export const api = { … }` add:

```js
  auth: {
    state: () => req('/auth/state'),
    registerOptions: (token) => req('/auth/register/options', json('POST', { token })),
    registerVerify: (token, response, name) => req('/auth/register/verify', json('POST', { token, response, name })),
    loginOptions: () => req('/auth/login/options', json('POST', {})),
    loginVerify: (response) => req('/auth/login/verify', json('POST', { response })),
    logout: () => req('/auth/logout', json('POST', {})),
  },
```

- [ ] **Step 4: Login view**

Create `web/js/views/login.js`:

```js
// Login: one button, no username — the authenticator offers its passkeys.
import { api } from '../api.js';
import { icons } from '../icons.js';
// Vendored UMD build (web/index.html loads it before app.js): no import, a global.
const { startAuthentication } = window.SimpleWebAuthnBrowser;

export function renderLogin(view, { next }) {
  view.innerHTML = `<div class="auth-view">
    <div class="side-logo"><span class="mark">A</span><span class="name">Agentboard</span></div>
    <p class="dialog-sub">Sign in with the passkey registered on this device.</p>
    <button type="button" class="btn-dark" id="login-btn">${icons.lock(14, '#fff')}Sign in with passkey</button>
    <p id="login-error" class="field-error" hidden></p>
    <p class="mut-sm">No passkey here yet? Run <code>agentboard auth enrol --name &lt;device&gt;</code> and open the link on this device.</p>
  </div>`;
  const btn = view.querySelector('#login-btn');
  const err = view.querySelector('#login-error');
  btn.onclick = async () => {
    btn.disabled = true;
    err.hidden = true;
    try {
      const { options } = await api.auth.loginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.auth.loginVerify(response);
      location.hash = next && next !== '#/' ? next : '#/';
      location.reload();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
}
```

- [ ] **Step 5: Enrol view**

Create `web/js/views/enrol.js`:

```js
// Enrol: the one-time link from `agentboard auth enrol` lands here. The
// token lives in the hash, so it never reaches server logs.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc } from '../util.js';
// Vendored UMD build (web/index.html loads it before app.js): no import, a global.
const { startRegistration } = window.SimpleWebAuthnBrowser;

export async function renderEnrol(view, { token }) {
  view.innerHTML = `<div class="auth-view">
    <div class="side-logo"><span class="mark">A</span><span class="name">Agentboard</span></div>
    <p class="dialog-sub">Register a passkey for this device. Face ID, Touch ID or your PIN will confirm it.</p>
    <div class="field">
      <label class="field-label" for="enrol-name">Device name</label>
      <input id="enrol-name" type="text" autocomplete="off" value="">
    </div>
    <button type="button" class="btn-dark" id="enrol-btn">${icons.lock(14, '#fff')}Register this device</button>
    <p id="enrol-error" class="field-error" hidden></p>
  </div>`;
  const btn = view.querySelector('#enrol-btn');
  const err = view.querySelector('#enrol-error');
  const name = view.querySelector('#enrol-name');
  const showError = (m) => {
    err.textContent = m;
    err.hidden = false;
    btn.disabled = false;
  };
  btn.onclick = async () => {
    btn.disabled = true;
    err.hidden = true;
    try {
      const { options, name: label } = await api.auth.registerOptions(token);
      if (!name.value.trim()) name.value = label;
      const response = await startRegistration({ optionsJSON: options });
      await api.auth.registerVerify(token, response, name.value.trim() || label);
      location.hash = '#/';
      location.reload();
    } catch (e) {
      showError(e.message);
    }
  };
  // Prefill the label without spending the token: options are cheap and the
  // challenge cookie is replaced when the button is pressed.
  try {
    const { name: label } = await api.auth.registerOptions(token);
    name.value = label;
  } catch (e) {
    showError(esc(e.message));
    btn.disabled = true;
  }
}
```

- [ ] **Step 6: `app.js` — routes, 401, sign out**

Imports: add

```js
import { renderLogin } from './views/login.js';
import { renderEnrol } from './views/enrol.js';
```

State: after `let boards = [];` add `let authState = { auth: false, user: null };`.

`parseRoute`: before `return { name: 'all' };` add

```js
  if ((m = hash.match(/^\/enrol\/([^/]+)$/))) return { name: 'enrol', token: m[1] };
```

`renderSidebar`: append to the template, after the boards list (inside the same template literal, before the closing backtick):

```js
    ${authState.auth ? `<div class="side-sep"></div><button type="button" class="side-item" id="side-signout">${icons.user(16, 'var(--mut)')}<span>Sign out</span></button>` : ''}
```

and after the routines `onclick` wiring:

```js
  const so = sidebar.querySelector('#side-signout');
  if (so) so.onclick = signOut;
```

Add the helper above `renderSidebar`:

```js
async function signOut() {
  try {
    await api.auth.logout();
  } catch {
    /* already gone */
  }
  location.hash = '#/';
  location.reload();
}
```

`openMoreSheet`: after the board rows inside the sheet template add

```js
      ${authState.auth ? `<div class="sheet-head"><span>Account</span></div><button type="button" class="more-row" id="more-signout">${icons.user(18)}<span class="t">Sign out</span></button>` : ''}
```

and after the `#more-routines` wiring:

```js
  const so = el.querySelector('#more-signout');
  if (so) so.onclick = signOut;
```

`route()`: replace the function with

```js
async function route() {
  closeOverlay();
  stopCardPolling();
  stopSessionPolling();
  const r = parseRoute();
  if (r.name === 'enrol') {
    // Enrol has no session yet: no sidebar, no board fetches.
    sidebar.innerHTML = '';
    tabbar.innerHTML = '';
    view.innerHTML = '';
    await renderEnrol(view, { token: r.token });
    return;
  }
  renderTabbar(r);
  try {
    boards = (await api.boards()).boards;
    renderSidebar(r);
    if (r.name !== 'sessions') view.innerHTML = '';
    if (r.name === 'all') await renderAllBoards(view, { boards });
    else if (r.name === 'board') await renderBoard(view, { boards, boardId: r.boardId });
    else if (r.name === 'archive') await renderArchive(view, { boards, boardId: r.boardId });
    else if (r.name === 'card') await renderCard(view, { boards, cardId: r.cardId });
    else if (r.name === 'session') await renderSession(view, { id: r.id });
    else if (r.name === 'sessions') await renderSessions(view);
    else if (r.name === 'ctx') await renderCtx(view, { path: r.path });
    const views = await Promise.all(boards.map((b) => api.board(b.id)));
    renderSidebar(r, views);
  } catch (err) {
    if (err.status === 401) {
      sidebar.innerHTML = '';
      tabbar.innerHTML = '';
      renderLogin(view, { next: location.hash });
      return;
    }
    renderError(err);
  }
}
```

Keep the existing comment about the sessions overview scroll position above the `if (r.name !== 'sessions')` line.

Boot: replace the two lines `window.addEventListener('hashchange', route); route();` with

```js
window.addEventListener('hashchange', route);
api.auth
  .state()
  .then((s) => {
    authState = s;
  })
  .catch(() => {})
  .finally(route);
```

`tick()`: at the top of the `try`, nothing changes — a 401 from `/api/changes` is swallowed by the existing `catch`. Add one guard so an unauthenticated tab does not poll: right after `if (document.hidden || ticking) return;` add

```js
  if (document.getElementById('login-btn')) return; // login view: nothing to sync
```

- [ ] **Step 7: CSS**

Append to `web/style.css`:

```css
/* ---------- auth: login + enrol views ---------- */
.auth-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; }
.auth-view .side-logo { margin-bottom: 4px; }
.auth-view .field { width: 280px; max-width: 100%; text-align: left; }
.auth-view .mut-sm code { font-family: 'JetBrains Mono', monospace; font-size: 11px; }
```

- [ ] **Step 8: Run the probe**

Run: `npm run build && docs/superpowers/plans/verify-auth.sh`
Expected: `leg 4 ok: browser` and `ALL OK`. If the click on `Register this device` throws `Cannot destructure … SimpleWebAuthnBrowser`, the script tag in `web/index.html` is missing or placed after the module script.

- [ ] **Step 9: Manual check on a phone-sized viewport (optional but recommended)**

With `serve` running as in leg 4, open the enrol URL in Chrome with the device toolbar at 390 px: the view is single-column, the button is reachable without scrolling. Take a screenshot to `docs/design/verify/auth/enrol-390.png` and one of the login view to `docs/design/verify/auth/login-390.png` (Playwright MCP or the browser devtools).

- [ ] **Step 10: Commit**

```bash
git add web/index.html web/js/vendor/simplewebauthn-browser.js web/js/views/login.js web/js/views/enrol.js web/js/api.js web/js/app.js web/style.css docs/superpowers/plans/verify-auth.sh docs/superpowers/plans/verify-auth-browser.mjs
git add docs/design/verify/auth 2>/dev/null || true
git commit -m "feat(auth): ui — login and enrol views, sign out, vendored webauthn client"
```

---

### Task 6: Docs and PR

**Files:**
- Modify: `docs/reference.md` (new "Auth" section after "Run")
- Modify: `README.md` (one sentence under "Try it")

- [ ] **Step 1: Reference section**

Insert after the "Run" section of `docs/reference.md`:

```markdown
## Auth

The web UI is protected by passkeys (WebAuthn) as soon as `AGENTBOARD_ORIGIN`
is set on the `serve` process:

```
AGENTBOARD_ORIGIN=https://board.example.com
AGENTBOARD_SESSION_SECRET=$(openssl rand -base64 48)
agentboard serve
agentboard auth enrol --name iPhone     # prints a one-time link, valid 15 minutes
agentboard auth list
```

Open the link on the device you want to sign in from; Face ID, Touch ID or
the device PIN registers a passkey bound to the origin's hostname. Run
`auth enrol` again for every extra device. Signing in is one button.

Rules: every `/api` request needs the session cookie (`HttpOnly`, `Secure`
on https, `SameSite=Lax`, 30 days rolling); every mutating request must
carry an `Origin` header equal to `AGENTBOARD_ORIGIN`; the static UI shell
stays public because it carries no data. The agent needs none of this: it
uses the CLI on the same machine.

Without `AGENTBOARD_ORIGIN` there is no auth, and `serve` binds
`127.0.0.1` only. Changing the origin's hostname later invalidates every
passkey; enrol again.
```

- [ ] **Step 2: README sentence**

Under "Try it", after the `agentboard serve` block's paragraph, add one line:

```markdown
Without `AGENTBOARD_ORIGIN` the board listens on localhost only, no login needed. Exposing it is in [docs/reference.md](docs/reference.md#auth).
```

- [ ] **Step 3: Full probe, build, commit, push, PR**

```bash
npm run build && docs/superpowers/plans/verify-auth.sh
git add docs/reference.md README.md
git commit -m "docs(auth): reference section and README note"
git push -u origin feat/auth-passkeys
gh pr create --title "feat(auth): passkey login" --body "$(cat <<'EOF'
Passkey (WebAuthn) login for the web UI — spec Part 1 (docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md).

- On iff AGENTBOARD_ORIGIN is set; without it serve binds localhost only (was: all interfaces, no auth)
- Tables user / credential / auth_session / enrol_token; core in src/core/auth.ts
- CLI: auth enrol --name, auth list
- HTTP: Origin check on mutating requests, session middleware on /api, six /auth routes, signed cookies
- UI: login and enrol views on the hash router, Sign out, vendored @simplewebauthn/browser
- Probe: docs/superpowers/plans/verify-auth.sh (curl legs + Playwright virtual authenticator)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: probe prints `ALL OK`; the PR opens and the CI build passes.
