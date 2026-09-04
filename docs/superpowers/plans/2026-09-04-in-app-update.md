# In-App Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Agentboard knows its version, notices a newer GitHub release, and pulls it on request from the CLI (`agentboard update`) or the UI (a button in the sidebar and the More-sheet) — on Fly by swapping the machine image through the Machines API, on a git checkout by checking out the tag and rebuilding, elsewhere by showing the `docker pull` line.

**Architecture:** One core module `src/core/update.ts` (version, latest release with an hourly cache, strategy detection, `performUpdate`). Two API routes, two CLI commands, one UI dialog with a restart-poller. The Fly path is exercised in the probe against a stub of the Machines API (`FLY_API_HOSTNAME` override) and a stub of the GitHub releases endpoint (`AGENTBOARD_RELEASES_URL` override).

**Tech Stack:** Node 22 `fetch`, Fly Machines API (`GET`/`POST /v1/apps/{app}/machines/{id}`), GitHub REST (`releases/latest`), the existing Hono server and no-build UI.

**Spec:** `docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md` — Part 4.

## Global Constraints

- Image name is a constant: `ghcr.io/robbertvermeulen/agentboard`.
- Strategy: `fly` iff `FLY_APP_NAME`, `FLY_MACHINE_ID` and `FLY_API_TOKEN` are all set; else `git` iff `<app root>/.git` exists; else `image`.
- The Fly update refuses while `sessionStatus().running` is true (a reboot mid-session would kill it). The git update refuses on a dirty working tree.
- Machines API base: `http://${FLY_API_HOSTNAME ?? '_api.internal:4280'}`; the update sends the **full** config back with only `image` changed.
- Release check: `GET` `AGENTBOARD_RELEASES_URL ?? https://api.github.com/repos/Robbertvermeulen/agentboard/releases/latest`, 5 s timeout, `null` on any failure, one-hour in-memory cache in the serve process; the CLI fetches fresh.
- Probe: `docs/superpowers/plans/verify-update.sh`. No test framework. Never touch `~/.agentboard`.
- Conventional commits on branch `feat/in-app-update` off `main`.

---

### Task 1: Core: version, latest release, strategy

**Files:**
- Create: `src/core/update.ts`
- Create: `docs/superpowers/plans/verify-update.sh` (leg 1), `docs/superpowers/plans/verify-update-stub.mjs`

**Interfaces:**
- Produces (exported from `src/core/update.ts`):
  - `const IMAGE = 'ghcr.io/robbertvermeulen/agentboard'`
  - `currentVersion(): string`
  - `interface Release { version: string; url: string; published_at: string | null }`
  - `latestRelease(opts?: { fresh?: boolean }): Promise<Release | null>`
  - `compareVersions(a: string, b: string): -1 | 0 | 1`
  - `type Strategy = 'fly' | 'git' | 'image'`; `strategy(): Strategy`
  - `interface VersionInfo { version: string; latest: Release | null; strategy: Strategy; updateAvailable: boolean }`; `versionInfo(opts?: { fresh?: boolean }): Promise<VersionInfo>`

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/in-app-update
```

- [ ] **Step 2: Write the stub server the probe uses**

Create `docs/superpowers/plans/verify-update-stub.mjs`:

```js
// Stub for two remote APIs the update path talks to:
//   GET  /releases/latest                      → GitHub "latest release" JSON
//   GET  /v1/apps/:app/machines/:id            → Fly machine with a config
//   POST /v1/apps/:app/machines/:id            → records the body, returns ok
// Usage: node verify-update-stub.mjs <port> <latest version> <record file>
import http from 'node:http';
import fs from 'node:fs';

const [port, latest, record] = process.argv.slice(2);
const calls = [];
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: body || null });
      fs.writeFileSync(record, JSON.stringify(calls, null, 2));
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/releases/latest') {
        return res.end(JSON.stringify({ tag_name: `v${latest}`, html_url: `https://example.test/releases/v${latest}`, published_at: '2026-09-04T10:00:00Z' }));
      }
      if (req.url.startsWith('/v1/apps/') && req.method === 'GET') {
        return res.end(JSON.stringify({ id: 'm1', config: { image: 'ghcr.io/robbertvermeulen/agentboard:0.1.0', env: { TZ: 'Europe/Amsterdam' }, services: [] } }));
      }
      if (req.url.startsWith('/v1/apps/') && req.method === 'POST') {
        return res.end(JSON.stringify({ id: 'm1', state: 'replacing' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  })
  .listen(Number(port), '127.0.0.1');
```

- [ ] **Step 3: Write the failing probe leg 1**

Create `docs/superpowers/plans/verify-update.sh`:

```bash
#!/usr/bin/env bash
# Probe for the in-app update (spec 2026-09-04 Part 4): version, release
# check with cache, strategy detection, the fly path against a Machines API
# stub, refusals, the API routes and the CLI. Throwaway AGENTBOARD_DATA;
# exits non-zero on the first deviation.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
CLI="node dist/cli/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
wait_port() { for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$1/$2" && return 0; perl -e 'select(undef,undef,undef,0.1)'; done; fail "port $1 never came up"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
PKG_VERSION=$(node -p "require('$ROOT/package.json').version")

STUB_PORT=$(free_port)
RECORD="$(mktemp)"
node docs/superpowers/plans/verify-update-stub.mjs "$STUB_PORT" "99.0.0" "$RECORD" & PIDS+=($!)
wait_port "$STUB_PORT" "releases/latest"
export AGENTBOARD_RELEASES_URL="http://127.0.0.1:$STUB_PORT/releases/latest"

# ============================================================================
# Leg 1: core — version, latest, compare, strategy (Task 1)
# ============================================================================
node --input-type=module -e "
import { currentVersion, latestRelease, compareVersions, strategy, versionInfo } from '$ROOT/dist/core/update.js';
if (currentVersion() !== '$PKG_VERSION') throw new Error('currentVersion');
const r = await latestRelease({ fresh: true });
if (!r || r.version !== '99.0.0' || !r.url) throw new Error('latestRelease ' + JSON.stringify(r));
if (compareVersions('0.2.0', '0.10.0') !== -1 || compareVersions('1.0.0', '0.9.9') !== 1 || compareVersions('0.2.0', '0.2.0') !== 0) throw new Error('compareVersions');
if (strategy() !== 'git') throw new Error('strategy in a checkout must be git, got ' + strategy());
process.env.FLY_APP_NAME = 'a'; process.env.FLY_MACHINE_ID = 'm'; process.env.FLY_API_TOKEN = 't';
if (strategy() !== 'fly') throw new Error('strategy with fly env must be fly');
const info = await versionInfo();
if (!info.updateAvailable || info.latest.version !== '99.0.0') throw new Error('versionInfo');
process.env.AGENTBOARD_RELEASES_URL = 'http://127.0.0.1:1/nope';
if ((await latestRelease({ fresh: true })) !== null) throw new Error('failure must yield null');
"
echo "leg 1 ok: core"
```

Run: `chmod +x docs/superpowers/plans/verify-update.sh && npm run build && docs/superpowers/plans/verify-update.sh`
Expected: FAIL (`Cannot find module …/dist/core/update.js`).

- [ ] **Step 4: Write `src/core/update.ts` (first half)**

```ts
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
```

(`execFileSync` and `sessionStatus` are used in Task 2; leaving the imports in place now avoids a second edit — TypeScript does not error on unused imports with this repo's tsconfig. If `tsc` reports `noUnusedLocals`, add them in Task 2 instead.)

- [ ] **Step 5: Build and run the probe**

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: `leg 1 ok: core`.

- [ ] **Step 6: Commit**

```bash
git add src/core/update.ts docs/superpowers/plans/verify-update.sh docs/superpowers/plans/verify-update-stub.mjs
git commit -m "feat(update): core — version, latest release, strategy"
```

---

### Task 2: Core: `performUpdate` for fly, git and image

**Files:**
- Modify: `src/core/update.ts`
- Modify: `docs/superpowers/plans/verify-update.sh` (leg 2)

**Interfaces:**
- Consumes: `IMAGE`, `strategy()`, `sessionStatus()` (from `src/core/runner.ts`).
- Produces: `type UpdateResult = { mode: 'fly'; restarting: true; image: string } | { mode: 'git'; restartRequired: true; version: string } | { mode: 'image'; command: string }`; `performUpdate(version: string): Promise<UpdateResult>`.

- [ ] **Step 1: Write the failing probe leg 2**

Append to `verify-update.sh`:

```bash
# ============================================================================
# Leg 2: performUpdate — fly path against the stub, refusals, image path (Task 2)
# ============================================================================
export FLY_APP_NAME=probe-app FLY_MACHINE_ID=m1 FLY_API_TOKEN=probe-token FLY_API_HOSTNAME="127.0.0.1:$STUB_PORT"
node --input-type=module -e "
import { performUpdate } from '$ROOT/dist/core/update.js';
const r = await performUpdate('99.0.0');
if (r.mode !== 'fly' || r.image !== 'ghcr.io/robbertvermeulen/agentboard:99.0.0') throw new Error('fly result ' + JSON.stringify(r));
"
python3 - "$RECORD" <<'PY'
import json, sys
calls = json.load(open(sys.argv[1]))
fly = [c for c in calls if c['url'].startswith('/v1/apps/probe-app/machines/m1')]
assert [c['method'] for c in fly] == ['GET', 'POST'], fly
assert all(c['auth'] == 'Bearer probe-token' for c in fly), 'auth header'
body = json.loads(fly[1]['body'])
assert body['config']['image'] == 'ghcr.io/robbertvermeulen/agentboard:99.0.0', body
assert body['config']['env'] == {'TZ': 'Europe/Amsterdam'}, 'full config must be sent back, not just the image'
PY
# refuse while a session runs: a live lock owned by this host + an open session row
# the lock must name a live process: the stub server's pid (this shell's python exits at once)
node -e "
const fs = require('fs'), os = require('os'), path = require('path');
fs.writeFileSync(path.join(process.env.AGENTBOARD_DATA, 'session.lock'), JSON.stringify({ pid: Number(process.argv[1]), hostname: os.hostname(), started_at: new Date().toISOString() }));
" "${PIDS[0]}"
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.AGENTBOARD_DATA + '/board.db');
db.prepare('INSERT INTO session (started_at, ended_at, \"trigger\", exit_status) VALUES (?, NULL, ?, NULL)').run('2026-09-04T10:00:00Z', 'cron');
"
node --input-type=module -e "
import { performUpdate } from '$ROOT/dist/core/update.js';
let msg = ''; try { await performUpdate('99.0.0'); } catch (e) { msg = e.message; }
if (!/session is running/.test(msg)) throw new Error('must refuse while a session runs, got: ' + msg);
"
rm -f "$AGENTBOARD_DATA/session.lock"
node -e "
const Database = require('better-sqlite3');
new Database(process.env.AGENTBOARD_DATA + '/board.db').prepare(\"UPDATE session SET ended_at = '2026-09-04T10:01:00Z', exit_status = 0\").run();
"
# image path: no fly env, no .git → notice only
( unset FLY_APP_NAME FLY_MACHINE_ID FLY_API_TOKEN
  TMPAPP="$(mktemp -d)"; cp -R "$ROOT/dist" "$ROOT/package.json" "$TMPAPP/"; mkdir -p "$TMPAPP/node_modules"; ln -s "$ROOT/node_modules/"* "$TMPAPP/node_modules/" 2>/dev/null || true
  node --input-type=module -e "
import { performUpdate, strategy } from '$TMPAPP/dist/core/update.js';
if (strategy() !== 'image') throw new Error('strategy without .git must be image, got ' + strategy());
const r = await performUpdate('99.0.0');
if (r.mode !== 'image' || !r.command.includes('docker pull ghcr.io/robbertvermeulen/agentboard:99.0.0')) throw new Error('image result ' + JSON.stringify(r));
" )
echo "leg 2 ok: performUpdate"
```

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: FAIL (`does not provide an export named 'performUpdate'`).

- [ ] **Step 2: Implement `performUpdate`**

Append to `src/core/update.ts`:

```ts
export type UpdateResult =
  | { mode: 'fly'; restarting: true; image: string }
  | { mode: 'git'; restartRequired: true; version: string }
  | { mode: 'image'; command: string };

export async function performUpdate(version: string): Promise<UpdateResult> {
  const mode = strategy();

  if (mode === 'fly') {
    // The machine reboots on the new image; a running agent session would
    // die mid-task. Refuse and let the caller retry after it ends.
    if (sessionStatus().running) throw new Error('An agent session is running — try again when it has finished');
    const base = `http://${process.env.FLY_API_HOSTNAME ?? '_api.internal:4280'}`;
    const url = `${base}/v1/apps/${process.env.FLY_APP_NAME}/machines/${process.env.FLY_MACHINE_ID}`;
    const headers = { Authorization: `Bearer ${process.env.FLY_API_TOKEN}`, 'Content-Type': 'application/json' };
    const cur = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!cur.ok) throw new Error(`Fly API: reading the machine failed (${cur.status})`);
    const machine = (await cur.json()) as { config: Record<string, unknown> };
    const image = `${IMAGE}:${version}`;
    // Partial updates are not supported: send the whole config back with
    // only the image changed.
    const upd = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ config: { ...machine.config, image } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upd.ok) throw new Error(`Fly API: update failed (${upd.status}) ${await upd.text()}`);
    return { mode: 'fly', restarting: true, image };
  }

  if (mode === 'git') {
    const root = appRoot();
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    if (git('status', '--porcelain').trim()) throw new Error('Working tree has local changes — commit or stash them first');
    git('fetch', '--tags', '--quiet');
    git('checkout', '--quiet', `v${version}`);
    execFileSync('npm', ['ci', '--silent'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'inherit' });
    return { mode: 'git', restartRequired: true, version };
  }

  return { mode: 'image', command: `docker pull ${IMAGE}:${version}` };
}
```

- [ ] **Step 3: Build and run the probe**

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: `leg 2 ok: performUpdate`. If the "refuse while a session runs" check fails, confirm `sessionStatus()` reads the lock from `AGENTBOARD_DATA/session.lock` and needs an open `session` row (both are set up by the leg).

- [ ] **Step 4: Commit**

```bash
git add src/core/update.ts docs/superpowers/plans/verify-update.sh
git commit -m "feat(update): performUpdate — fly image swap, git checkout, image notice"
```

---

### Task 3: API routes and CLI commands

**Files:**
- Modify: `src/api/server.ts` (two routes next to `/api/session-status`)
- Modify: `src/cli/index.ts` (two commands after `backup`)
- Modify: `docs/superpowers/plans/verify-update.sh` (leg 3)

**Interfaces:**
- Consumes: `versionInfo`, `performUpdate` from `src/core/update.ts`.
- Produces: `GET /api/version` → `VersionInfo`; `POST /api/update` → `UpdateResult` or `409 { error }`. CLI: `agentboard version [--json]`, `agentboard update [--check] [--json]`.

- [ ] **Step 1: Write the failing probe leg 3**

Append to `verify-update.sh`:

```bash
# ============================================================================
# Leg 3: API + CLI (Task 3) — auth off (no origin), fly env set, stub as remote
# ============================================================================
$CLI version | grep -q "$PKG_VERSION" || fail "cli version"
$CLI version --json | python3 -c "import json,sys; i=json.load(sys.stdin); assert i['updateAvailable'] and i['latest']['version']=='99.0.0' and i['strategy']=='fly', i"
$CLI update --check | grep -q "99.0.0" || fail "update --check"
$CLI update --json | python3 -c "import json,sys; r=json.load(sys.stdin); assert r['mode']=='fly' and r['image'].endswith(':99.0.0'), r"

PORT=$(free_port)
$CLI serve --port "$PORT" >/dev/null 2>&1 & PIDS+=($!)
wait_port "$PORT" "api/boards"
B="http://127.0.0.1:$PORT"
curl -sf "$B/api/version" | python3 -c "import json,sys; i=json.load(sys.stdin); assert i['version']=='$PKG_VERSION' and i['updateAvailable'], i"
curl -s -X POST "$B/api/update" | python3 -c "import json,sys; r=json.load(sys.stdin); assert r['mode']=='fly', r"
# nothing newer → 409: a second stub that reports the running version, and a second serve pointed at it
SAME_PORT=$(free_port); node docs/superpowers/plans/verify-update-stub.mjs "$SAME_PORT" "$PKG_VERSION" "$(mktemp)" & PIDS+=($!)
wait_port "$SAME_PORT" "releases/latest"
PORT2=$(free_port)
AGENTBOARD_RELEASES_URL="http://127.0.0.1:$SAME_PORT/releases/latest" $CLI serve --port "$PORT2" >/dev/null 2>&1 & PIDS+=($!)
wait_port "$PORT2" "api/boards"
[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT2/api/update")" = "409" ] || fail "update with nothing newer must be 409"
echo "leg 3 ok: api + cli"
```

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: FAIL (`error: unknown command 'version'`).

- [ ] **Step 2: API routes**

In `src/api/server.ts` add to the imports `import { performUpdate, versionInfo } from '../core/update.js';` and, after the `/api/session-status` route:

```ts
  app.get('/api/version', async (c) => {
    try {
      return c.json(await versionInfo());
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Pull the newest release. 409 when there is nothing newer, when an agent
  // session runs (fly) or when the checkout is dirty (git).
  app.post('/api/update', async (c) => {
    try {
      const info = await versionInfo({ fresh: true });
      if (!info.updateAvailable || !info.latest) return c.json({ error: 'Already on the newest release' }, 409);
      return c.json(await performUpdate(info.latest.version));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 409);
    }
  });
```

- [ ] **Step 3: CLI commands**

In `src/cli/index.ts` add to the imports `import { performUpdate, versionInfo } from '../core/update.js';` and, after the `backup` command:

```ts
program
  .command('version')
  .description('running version, newest release, and how this install updates')
  .option('--json', 'JSON output')
  .action(
    run(async (opts) => {
      const info = await versionInfo({ fresh: true });
      const latest = info.latest ? `${info.latest.version}${info.updateAvailable ? ' (update available)' : ''}` : 'unknown (offline?)';
      output(opts, `agentboard ${info.version}  latest ${latest}  strategy ${info.strategy}`, info);
    })
  );

program
  .command('update')
  .description('pull the newest release (fly: swap the machine image; git: checkout + build; image: print the pull line)')
  .option('--check', 'only report whether an update is available')
  .option('--json', 'JSON output')
  .action(
    run(async (opts) => {
      const info = await versionInfo({ fresh: true });
      if (!info.updateAvailable || !info.latest) {
        output(opts, `Already on the newest release (${info.version})`, { ...info, updated: false });
        return;
      }
      if (opts.check) {
        output(opts, `Update available: ${info.version} -> ${info.latest.version}  ${info.latest.url}`, info);
        return;
      }
      const result = await performUpdate(info.latest.version);
      const text =
        result.mode === 'fly'
          ? `Machine is restarting on ${result.image} — back in about a minute`
          : result.mode === 'git'
            ? `Installed ${result.version}. Restart 'agentboard serve' to finish`
            : `This install updates by pulling the image:\n  ${result.command}`;
      output(opts, text, result);
    })
  );
```

- [ ] **Step 4: Build and run the probe**

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: `leg 3 ok: api + cli`.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts src/cli/index.ts docs/superpowers/plans/verify-update.sh
git commit -m "feat(update): GET /api/version, POST /api/update, cli version and update"
```

---

### Task 4: UI: version in the sidebar and More-sheet, update dialog, restart poller

**Files:**
- Create: `web/js/views/update.js`
- Modify: `web/js/api.js` (two calls), `web/js/app.js` (sidebar footer, More-sheet row, hourly refresh), `web/style.css` (`.side-foot`)
- Modify: `docs/superpowers/plans/verify-update.sh` (leg 4), Create: `docs/superpowers/plans/verify-update-browser.mjs`

**Interfaces:**
- Consumes: `GET /api/version`, `POST /api/update`.
- Produces: `api.version()`, `api.update()`; `openUpdateDialog(info)` from `web/js/views/update.js`; elements `#side-version` (sidebar) and `#more-version` (More-sheet), button `#update-ok` in the dialog.

- [ ] **Step 1: Write the failing browser probe**

Create `docs/superpowers/plans/verify-update-browser.mjs`:

```js
// Clicks through the update dialog. Usage: node verify-update-browser.mjs <base url> <expected version>
import { chromium } from 'playwright';

const [base, version] = process.argv.slice(2);
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/#/');
await page.waitForSelector('#side-version', { timeout: 15000 }).catch(() => fail('no version in sidebar'));
const text = await page.textContent('#side-version');
if (!text.includes(version + ' available')) fail('sidebar must announce the update, got: ' + text);
await page.click('#side-version button');
await page.waitForSelector('#update-ok', { timeout: 5000 }).catch(() => fail('update dialog did not open'));
await page.click('#update-ok');
await page.waitForFunction(() => /Updating/.test(document.querySelector('.dialog-sub')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => fail('dialog did not switch to Updating'));
await browser.close();
console.log('update dialog ok');
```

Append to `verify-update.sh` (before the final echo, after leg 3):

```bash
# ============================================================================
# Leg 4: UI — sidebar notice, dialog, POST, "Updating…" state (Task 4)
# ============================================================================
node docs/superpowers/plans/verify-update-browser.mjs "$B" "99.0.0"
python3 - "$RECORD" <<'PY'
import json, sys
calls = json.load(open(sys.argv[1]))
posts = [c for c in calls if c['method'] == 'POST' and c['url'].startswith('/v1/apps/')]
assert len(posts) >= 2, 'the UI click must reach the stub as a second POST'
PY
echo "leg 4 ok: ui"
echo "ALL OK"
```

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: FAIL at `no version in sidebar`.

- [ ] **Step 2: `api.js`**

Inside `export const api = { … }` add:

```js
  version: () => req('/api/version'),
  update: () => req('/api/update', json('POST', {})),
```

- [ ] **Step 3: The dialog — `web/js/views/update.js`**

```js
// Update dialog: one confirmation, then per strategy — fly: wait for the
// machine to come back on the new version; git: tell the user to restart;
// image: show the pull line and no button.
import { api } from '../api.js';
import { esc } from '../util.js';
import { closeOverlay, openOverlay } from '../components.js';

const IMAGE = 'ghcr.io/robbertvermeulen/agentboard';

export function openUpdateDialog(info) {
  const v = info.latest.version;
  const line =
    info.strategy === 'fly'
      ? 'The board restarts on the new version. About a minute.'
      : info.strategy === 'git'
        ? 'Installs the new version; then restart agentboard serve.'
        : `This install updates by pulling the image: docker pull ${IMAGE}:${v}`;
  const el = openOverlay(`<div class="dialog" role="dialog" aria-label="Update">
    <span class="dialog-title">Update to ${esc(v)}?</span>
    <p class="dialog-sub">${esc(line)} <a href="${esc(info.latest.url)}" target="_blank" rel="noopener">Release notes</a></p>
    <p id="update-error" class="field-error" hidden></p>
    <div class="dialog-actions">
      <button type="button" id="update-cancel" class="btn-ghost">${info.strategy === 'image' ? 'Close' : 'Cancel'}</button>
      ${info.strategy === 'image' ? '' : '<button type="button" id="update-ok" class="btn-dark">Update</button>'}
    </div>
  </div>`);
  const sub = el.querySelector('.dialog-sub');
  const err = el.querySelector('#update-error');
  const ok = el.querySelector('#update-ok');
  const cancel = el.querySelector('#update-cancel');
  cancel.onclick = closeOverlay;
  const showError = (m) => {
    err.textContent = m;
    err.hidden = false;
    if (ok) ok.disabled = false;
  };
  const awaitRestart = () => {
    sub.textContent = 'Updating… the board restarts in a minute.';
    if (ok) ok.remove();
    cancel.textContent = 'Close';
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const i = await api.version();
        if (i.version === v) {
          clearInterval(timer);
          sub.textContent = `Updated to ${v}.`;
          setTimeout(() => location.reload(), 1200);
          return;
        }
      } catch {
        /* still restarting */
      }
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(timer);
        showError('Still not back after five minutes — check fly logs.');
      }
    }, 3000);
  };
  if (ok) {
    ok.onclick = async () => {
      ok.disabled = true;
      err.hidden = true;
      try {
        const r = await api.update();
        if (r.mode === 'fly') awaitRestart();
        else if (r.mode === 'git') {
          sub.textContent = `Installed ${v}. Restart agentboard serve to finish.`;
          ok.remove();
          cancel.textContent = 'Close';
        } else sub.textContent = r.command;
      } catch (e) {
        // The fly machine may reboot before the response lands: a network
        // error right after the click means it is already on its way.
        if (info.strategy === 'fly' && /fetch|network/i.test(e.message)) awaitRestart();
        else showError(e.message);
      }
    };
  }
}
```

- [ ] **Step 4: `app.js` — footer, More-sheet row, refresh**

Imports: `import { openUpdateDialog } from './views/update.js';`

State: after `let authState = …` (or after `let boards = [];` if auth is not merged yet) add:

```js
let versionState = null; // { version, latest, strategy, updateAvailable }

function versionLabel(id) {
  if (!versionState) return `<span id="${id}" class="side-foot"></span>`;
  const v = versionState.version;
  return versionState.updateAvailable
    ? `<span id="${id}" class="side-foot">v${esc(v)} · <button type="button" class="link">${esc(versionState.latest.version)} available</button></span>`
    : `<span id="${id}" class="side-foot">v${esc(v)}</span>`;
}

function wireVersion(root, id) {
  const btn = root.querySelector(`#${id} button`);
  if (btn) btn.onclick = () => openUpdateDialog(versionState);
}

async function refreshVersion() {
  try {
    versionState = await api.version();
  } catch {
    versionState = null;
  }
}
```

`renderSidebar`: append `${versionLabel('side-version')}` as the last line of the template (after the Sign out block if present), and after the other `onclick` wiring add `wireVersion(sidebar, 'side-version');`.

`openMoreSheet`: append `<div class="sheet-head"><span>About</span></div><div class="more-row">${versionLabel('more-version')}</div>` at the end of the sheet template, then `wireVersion(el, 'more-version');` after the other wiring.

Boot: the version is fetched once before the first render and then hourly. Change the boot to:

```js
window.addEventListener('hashchange', route);
Promise.all([
  api.auth ? api.auth.state().then((s) => { authState = s; }).catch(() => {}) : Promise.resolve(),
  refreshVersion(),
]).finally(route);
setInterval(async () => {
  await refreshVersion();
  const el = document.getElementById('side-version');
  if (el) {
    el.outerHTML = versionLabel('side-version');
    wireVersion(sidebar, 'side-version');
  }
}, 60 * 60 * 1000);
```

(If PR 1 landed, `api.auth` exists and `authState` is declared; the ternary keeps this task mergeable either way.)

- [ ] **Step 5: CSS**

Append to `web/style.css`:

```css
/* ---------- version + update notice ---------- */
.side-foot { margin-top: auto; padding: 8px; font-size: 11px; color: var(--mut-2); }
.side-foot .link { color: var(--brand); font-size: 11px; font-weight: 500; }
.more-row .side-foot { padding: 0; margin: 0; }
```

- [ ] **Step 6: Build and run the whole probe**

Run: `npm run build && docs/superpowers/plans/verify-update.sh`
Expected: `leg 4 ok: ui` and `ALL OK`. Leg 4 runs against the leg-3 server on `$B` (auth off, fly env set, stub as remote), so the click's POST reaches the stub.

- [ ] **Step 7: Commit**

```bash
git add web/js/views/update.js web/js/api.js web/js/app.js web/style.css docs/superpowers/plans/verify-update.sh docs/superpowers/plans/verify-update-browser.mjs
git commit -m "feat(update): version in sidebar and more-sheet, update dialog with restart poller"
```

---

### Task 5: Docs and PR

**Files:**
- Modify: `docs/reference.md` (new "Updates" section after "Backup")

- [ ] **Step 1: Reference section**

```markdown
## Updates

Releases never deploy. A running Agentboard checks GitHub's newest release
once an hour and shows it in the sidebar and the mobile More-sheet.

```
agentboard version           # running version, newest release, strategy
agentboard update --check
agentboard update
```

How an install updates is derived from its environment:

- **fly** — `FLY_APP_NAME`, `FLY_MACHINE_ID` and `FLY_API_TOKEN` (a deploy
  token, stored as a Fly secret) are set. The update reads the machine's
  config through the internal Machines API, swaps `image` for
  `ghcr.io/robbertvermeulen/agentboard:<version>` and sends it back; Fly
  reboots the machine on the new image, the volume persists. Refused while
  an agent session is running.
- **git** — the app root is a git checkout: fetch tags, check out
  `v<version>`, `npm ci`, `npm run build`; then restart `agentboard serve`.
  Refused on a dirty working tree.
- **image** — anything else: the notice shows the `docker pull` line.

`AGENTBOARD_RELEASES_URL` overrides the GitHub endpoint (probes);
`FLY_API_HOSTNAME` overrides `_api.internal:4280`.
```

- [ ] **Step 2: Probe, commit, push, PR**

```bash
npm run build && docs/superpowers/plans/verify-update.sh
git add docs/reference.md
git commit -m "docs(update): reference section"
git push -u origin feat/in-app-update
gh pr create --title "feat(update): release notice and in-app update" --body "$(cat <<'EOF'
In-app update — spec Part 4 (docs/superpowers/specs/2026-09-04-auth-deploy-release-update-design.md).

- src/core/update.ts: version, newest release (hourly cache, AGENTBOARD_RELEASES_URL override), strategy fly/git/image, performUpdate
- fly: full machine config read + image swap via the internal Machines API; refused while a session runs
- GET /api/version, POST /api/update; cli `version` and `update [--check]`
- UI: version in the sidebar and More-sheet, update dialog, restart poller
- Probe: docs/superpowers/plans/verify-update.sh with a Machines API + releases stub

Merging this is the first `feat` after the pipeline: it releases 0.2.0 and publishes the first image.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `ALL OK`; after merge, release `v0.2.0` and image `ghcr.io/robbertvermeulen/agentboard:0.2.0` appear (Plan 3, Task 4 Step 3), and the Fly instance shows `0.2.0 available` — the first real run of the fly path.
