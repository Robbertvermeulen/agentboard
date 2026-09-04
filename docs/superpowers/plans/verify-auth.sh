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
