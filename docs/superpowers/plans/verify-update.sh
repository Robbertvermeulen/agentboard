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
