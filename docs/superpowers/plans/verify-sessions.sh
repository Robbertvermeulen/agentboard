#!/usr/bin/env bash
# End-to-end probe for session logging (spec 2026-08-27): runner capture into
# <id>.jsonl/<id>.stderr.log, crash-safe session rows, the transcript card
# scan, secret redaction (plain + base64), the stream-json parser, prune, the
# API endpoints and the idle heartbeat. Composed from the verified probes of
# Tasks 1-5. One throwaway AGENTBOARD_DATA for the whole run, so session
# numbering stays predictable across legs; exits non-zero on the first
# deviation. Every leg that spawns a session uses a fake
# AGENTBOARD_SESSION_CMD -- never a real `claude` session.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLI="node dist/cli/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi }
id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
SCRATCH="$(mktemp -d)"

# ============================================================================
# Leg 1: runner capture -- session row (trigger, exit 0, ended_at), clean
# jsonl vs noisy stderr.log, card scan (known id linked, pattern-noise id
# ignored) (Tasks 1, 2)
# ============================================================================
A=$($CLI card new --type task --title "sessiekaart" --json | id_of)
$CLI card move "$A" ready --reason t >/dev/null

cat > "$SCRATCH/fake1.sh" << EOF
#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"werk aan $A en task_dead"}]}}'
echo "ruis op stderr" >&2
EOF
chmod +x "$SCRATCH/fake1.sh"

AGENTBOARD_SESSION_CMD="$SCRATCH/fake1.sh" $CLI runner --trigger cron >/dev/null

sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT id, "trigger", exit_status, ended_at IS NOT NULL FROM session WHERE id = 1;' \
  | grep -qx '1|cron|0|1' || fail "session #1 row mismatch (trigger/exit_status/ended_at)"

grep -q "werk aan $A" "$AGENTBOARD_DATA/sessions/1.jsonl" || fail "session #1 jsonl missing its transcript line"
if grep -q "ruis" "$AGENTBOARD_DATA/sessions/1.jsonl"; then fail "stderr noise leaked into 1.jsonl"; fi
grep -q "ruis op stderr" "$AGENTBOARD_DATA/sessions/1.stderr.log" || fail "1.stderr.log missing the stderr noise"
if grep -q "werk aan" "$AGENTBOARD_DATA/sessions/1.stderr.log"; then fail "jsonl transcript leaked into 1.stderr.log"; fi

CARDS1=$(sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT card_id FROM session_card WHERE session_id = 1;')
echo "$CARDS1" | grep -qx "$A" || fail "known card id not linked in session_card"
if echo "$CARDS1" | grep -qx "task_dead"; then fail "pattern-noise id (task_dead) wrongly linked in session_card"; fi

# ============================================================================
# Leg 2: crash path -- exit 7, ended_at still set, `sessions list` reports
# "ended early" (Tasks 2, 3)
# ============================================================================
cat > "$SCRATCH/crash.sh" << 'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$SCRATCH/crash.sh"

AGENTBOARD_SESSION_CMD="$SCRATCH/crash.sh" $CLI runner >/dev/null

sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT id, exit_status, ended_at IS NOT NULL FROM session WHERE id = 2;' \
  | grep -qx '2|7|1' || fail "crashed session #2 row mismatch (exit_status/ended_at)"
$CLI sessions list | grep -q "ended early (7)" || fail "'sessions list' does not report the crash as ended early"

# ============================================================================
# Leg 3: redaction -- raw file keeps the planted secret (by design); CLI
# `sessions show` redacts both a plain secret and a base64-stored one
# (Tasks 1, 3)
# ============================================================================
echo "supergeheim123" | $CLI secret set demo_secret >/dev/null
printf 'geheimesleutelvoorssh\n' > "$SCRATCH/keyfile"
$CLI secret set sshkey --file "$SCRATCH/keyfile" >/dev/null

B=$($CLI card new --type task --title "redactie-kaart" --json | id_of)
$CLI card move "$B" ready --reason t >/dev/null

cat > "$SCRATCH/fake3.sh" << EOF
#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"kaart $B: key is supergeheim123"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"kaart $B: ssh geheim geheimesleutelvoorssh"}]}}'
EOF
chmod +x "$SCRATCH/fake3.sh"

AGENTBOARD_SESSION_CMD="$SCRATCH/fake3.sh" $CLI runner --trigger manual >/dev/null

grep -q "supergeheim123" "$AGENTBOARD_DATA/sessions/3.jsonl" || fail "raw 3.jsonl missing the planted plain secret (should leak by design)"
grep -q "geheimesleutelvoorssh" "$AGENTBOARD_DATA/sessions/3.jsonl" || fail "raw 3.jsonl missing the planted base64-derived secret (should leak by design)"

$CLI sessions show 3 | grep -q '\[secret:demo_secret\]' || fail "'sessions show' did not redact the plain secret"
$CLI sessions show 3 | grep -q '\[secret:sshkey\]' || fail "'sessions show' did not redact the base64-derived secret"
if $CLI sessions show 3 | grep -q "supergeheim123"; then fail "'sessions show' leaked the plain secret"; fi
if $CLI sessions show 3 | grep -q "geheimesleutelvoorssh"; then fail "'sessions show' leaked the base64-derived secret"; fi

# ============================================================================
# Leg 4: parser fixture -- text/tool/result/raw steps, "reasoning · N words"
# label (Task 3)
# ============================================================================
printf '%s\n' \
  '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"drie woorden hier"}]}}' \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"agentboard next"}}]}}' \
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"task_ff00 not found"}]}}' \
  '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"array result task_XXXX"}]}]}}' \
  'geen json' >> "$AGENTBOARD_DATA/sessions/1.jsonl"

$CLI sessions show 1 --json | python3 -c "
import json, sys
d = json.load(sys.stdin)
types = [s['type'] for s in d['steps']]
assert 'text' in types, types
assert 'tool' in types, types
assert 'result' in types, types
assert 'raw' in types, types
assert any(s['label'].startswith('reasoning · 3 words') for s in d['steps']), [s['label'] for s in d['steps']]
assert any(s['label'] == 'array result task_XXXX' for s in d['steps']), [s['label'] for s in d['steps']]
assert not any(s['label'].startswith('[{\"') for s in d['steps']), [s['label'] for s in d['steps']]
" || fail "parser fixture: missing expected step types, reasoning label, or array tool_result content"

# ============================================================================
# Leg 5: prune -- backdated ended session removed (rows + both files),
# running and young sessions kept, garbage duration refused (Task 3)
# ============================================================================
sqlite3 "$AGENTBOARD_DATA/board.db" "UPDATE session SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = 1"
sqlite3 "$AGENTBOARD_DATA/board.db" "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('2020-01-01T00:00:00.000Z', 'manual', '[]')"
RUNNING_ID=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

$CLI sessions prune --older-than 30d | grep -q "Pruned 1 session(s): 1" || fail "prune did not remove exactly session #1"

if [ -f "$AGENTBOARD_DATA/sessions/1.jsonl" ]; then fail "prune left 1.jsonl on disk"; fi
if [ -f "$AGENTBOARD_DATA/sessions/1.stderr.log" ]; then fail "prune left 1.stderr.log on disk"; fi
[ -z "$(sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT id FROM session WHERE id = 1')" ] || fail "pruned session row still present"
[ -z "$(sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT session_id FROM session_card WHERE session_id = 1')" ] || fail "pruned session_card rows still present"

$CLI sessions show 2 >/dev/null || fail "young session #2 was pruned"
$CLI sessions show 3 >/dev/null || fail "young session #3 was pruned"
[ -n "$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT id FROM session WHERE id = $RUNNING_ID")" ] || fail "old but still-running session was pruned"

expect_fail $CLI sessions prune --older-than garbage
ERR=$($CLI sessions prune --older-than garbage 2>&1 1>/dev/null) || true
echo "$ERR" | grep -q "Invalid --older-than" || fail "garbage --older-than error message wrong: $ERR"

# ============================================================================
# Leg 6: API + heartbeat -- both /api/sessions/:id and /api/cards/:id/sessions
# redact the plain and base64 secrets; the card-fragments endpoint mentions
# the card id; /api/session-status is false/null while idle (Task 4)
# ============================================================================
$CLI serve --port 4680 &
SERVE_PID=$!
PIDS+=("$SERVE_PID")
sleep 1

DETAIL=$(curl -s "localhost:4680/api/sessions/3")
echo "$DETAIL" | grep -q '\[secret:demo_secret\]' || fail "GET /api/sessions/:id did not redact the plain secret"
echo "$DETAIL" | grep -q '\[secret:sshkey\]' || fail "GET /api/sessions/:id did not redact the base64-derived secret"
if echo "$DETAIL" | grep -q "supergeheim123"; then fail "GET /api/sessions/:id leaked the plain secret"; fi
if echo "$DETAIL" | grep -q "geheimesleutelvoorssh"; then fail "GET /api/sessions/:id leaked the base64-derived secret"; fi

FRAG=$(curl -s "localhost:4680/api/cards/$B/sessions")
echo "$FRAG" | grep -q "$B" || fail "GET /api/cards/:id/sessions response missing the card id"
echo "$FRAG" | grep -q '\[secret:demo_secret\]' || fail "GET /api/cards/:id/sessions did not redact the plain secret"
echo "$FRAG" | grep -q '\[secret:sshkey\]' || fail "GET /api/cards/:id/sessions did not redact the base64-derived secret"
if echo "$FRAG" | grep -q "supergeheim123"; then fail "GET /api/cards/:id/sessions leaked the plain secret"; fi
if echo "$FRAG" | grep -q "geheimesleutelvoorssh"; then fail "GET /api/cards/:id/sessions leaked the base64-derived secret"; fi

STATUS=$(curl -s localhost:4680/api/session-status)
echo "$STATUS" | grep -q '"running":false' || fail "session-status not false while idle"
echo "$STATUS" | grep -q '"session_id":null' || fail "session-status session_id not null while idle"

kill "$SERVE_PID" >/dev/null 2>&1 || true
wait "$SERVE_PID" 2>/dev/null || true

echo "OK: sessions verified (capture+scan, crash, redaction, parser, prune, api+heartbeat)"
