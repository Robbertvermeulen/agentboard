#!/usr/bin/env bash
# End-to-end probe for hard claims (spec 2026-10-15): schema + recover,
# write guards + freshness, runner assignment + crash loop + timeout,
# per-card workdirs. Throwaway AGENTBOARD_DATA per leg; fake session
# commands only, never a real `claude`. Exits non-zero on the first deviation.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
CLI="node dist/cli/index.js"
CLI_ABS="node $ROOT/dist/cli/index.js"
export AGENTBOARD_MAX_SESSIONS=3
unset AGENTBOARD_SESSION_ID AGENTBOARD_ACTOR AGENTBOARD_AUTORUN AGENTBOARD_WORK AGENTBOARD_ORIGIN

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi }
id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }
q() { sqlite3 "$AGENTBOARD_DATA/board.db" "$1"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

fresh_data() { export AGENTBOARD_DATA="$(mktemp -d)/abdata"; $CLI init >/dev/null; }

# A live session without the runner: an open session row plus a lock file
# whose pid is a sleeper we own. Sets SID (session id) and SPID (sleeper pid).
fake_live_session() {
  local slot=$1
  sleep 600 & SPID=$!; PIDS+=("$SPID")
  SID=$(q "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'manual', '[]'); SELECT last_insert_rowid();")
  local file="$AGENTBOARD_DATA/session.lock"; [ "$slot" -gt 0 ] && file="$file.$slot"
  echo "{\"pid\":$SPID,\"hostname\":\"$(hostname)\",\"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"session_id\":$SID}" > "$file"
}
end_fake_session() { # $1 sid, $2 pid
  kill "$2" >/dev/null 2>&1 || true
  q "UPDATE session SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1;"
}
# Run a CLI command as an agent inside session $1.
as_s() { local s=$1; shift; AGENTBOARD_SESSION_ID=$s AGENTBOARD_ACTOR=agent $CLI "$@"; }
new_ready() { local id; id=$($CLI card new --type task --title "$1" --json | id_of); $CLI card move "$id" ready --reason t >/dev/null; echo "$id"; }

# ============================================================================
# Leg 9: sessions recover -- refuses while a session is live; at boot it
# closes open session rows and clears every claim (Task 2)
# ============================================================================
fresh_data
X=$(new_ready "recover")
fake_live_session 0; S=$SID; P=$SPID
q "UPDATE card SET claimed_by = $S WHERE id = '$X';"
expect_fail $CLI sessions recover
kill "$P"; wait "$P" 2>/dev/null || true; rm -f "$AGENTBOARD_DATA"/session.lock*
$CLI sessions recover >/dev/null
[ "$(q "SELECT ended_at IS NOT NULL FROM session WHERE id = $S;")" = 1 ] || fail "recover did not close the open session row"
[ "$(q "SELECT claimed_by IS NULL FROM card WHERE id = '$X';")" = 1 ] || fail "recover did not clear the claim"

# ============================================================================
# Leg 11: migration -- a v0.23.0 database gains the claim columns on init
# (Task 2); the doing card it holds is resumed in Task 4's leg 11b
# ============================================================================
OLD="$(mktemp -d)/v0.23.0"
git worktree add -q "$OLD" v0.23.0
(cd "$OLD" && npm ci --silent >/dev/null 2>&1 && npm run build --silent >/dev/null)
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
node "$OLD/dist/cli/index.js" init >/dev/null
MIG=$(node "$OLD/dist/cli/index.js" card new --type task --title "old doing" --json | id_of)
node "$OLD/dist/cli/index.js" card move "$MIG" ready --reason t >/dev/null
node "$OLD/dist/cli/index.js" card move "$MIG" doing --from ready --as agent --reason Claiming >/dev/null
git worktree remove --force "$OLD"
$CLI init >/dev/null
for col in claimed_by claim_seen_at human_edited_at; do
  q "PRAGMA table_info(card);" | grep -q "|$col|" || fail "migration missing card.$col"
done
q "PRAGMA table_info(comment);" | grep -q "|session_id|" || fail "migration missing comment.session_id"
q "PRAGMA table_info(session);" | grep -q "|card_id|" || fail "migration missing session.card_id"
MIGDATA="$AGENTBOARD_DATA"   # leg 11b (Task 4) reuses this database

echo "OK: hard claims verified"
