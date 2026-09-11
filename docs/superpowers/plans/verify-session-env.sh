#!/usr/bin/env bash
# Probe: the agent session must not inherit the server-only secrets
# (FLY_API_TOKEN, AGENTBOARD_SESSION_SECRET) while the rest of the
# environment passes through. Throwaway AGENTBOARD_DATA; the fake session
# command dumps its environment into the transcript, which is then grepped
# raw (redaction only happens at display time, and these values are not in
# secrets.env anyway).
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLI="node dist/cli/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }

export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
ID=$($CLI card new --type task --title "env probe" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
$CLI card move "$ID" ready --reason probe >/dev/null

SCRATCH="$(mktemp -d)"
printf '#!/bin/sh\nenv\n' > "$SCRATCH/dump.sh"
chmod +x "$SCRATCH/dump.sh"

export FLY_API_TOKEN="probe-fly-token-must-not-leak"
export AGENTBOARD_SESSION_SECRET="probe-session-secret-must-not-leak"
export AGENTBOARD_PROBE_MARKER="passes-through"
AGENTBOARD_SESSION_CMD="$SCRATCH/dump.sh" $CLI runner --trigger manual >/dev/null

LOG=$(ls "$AGENTBOARD_DATA"/sessions/*.jsonl | head -1)
grep -q 'AGENTBOARD_PROBE_MARKER=passes-through' "$LOG" || fail "ordinary env must pass through to the session"
grep -q 'AGENTBOARD_DATA=' "$LOG" || fail "AGENTBOARD_DATA must reach the session"
if grep -q 'probe-fly-token' "$LOG"; then fail "FLY_API_TOKEN leaked into the session env"; fi
if grep -q 'probe-session-secret' "$LOG"; then fail "AGENTBOARD_SESSION_SECRET leaked into the session env"; fi
echo "OK: the session env strips FLY_API_TOKEN and AGENTBOARD_SESSION_SECRET and passes the rest"
