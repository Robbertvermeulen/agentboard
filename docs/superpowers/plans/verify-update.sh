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
