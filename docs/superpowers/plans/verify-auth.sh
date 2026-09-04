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

# ============================================================================
# Leg 2: CLI — auth enrol prints a fragment URL, auth list, off without origin (Task 3)
# ============================================================================
URL=$($CLI auth enrol --name "Probe phone" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
case "$URL" in "http://localhost:4666/#/enrol/"*) ;; *) fail "enrol url shape: $URL";; esac
$CLI auth list | grep -q "No passkeys yet" || fail "auth list before enrol"
( unset AGENTBOARD_ORIGIN; expect_fail $CLI auth enrol --name x )
echo "leg 2 ok: cli"

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
LAST=$((${#PIDS[@]} - 1)); kill "${PIDS[$LAST]}"; unset "PIDS[$LAST]"

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
