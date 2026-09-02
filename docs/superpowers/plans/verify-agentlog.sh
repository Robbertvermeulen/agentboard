#!/usr/bin/env bash
# End-to-end probe for the agent log / observer feature (spec 2026-09-02):
# incremental session steps (GET /api/sessions/:id/steps offset/n round-trip,
# a trailing partial line while the row is open vs. after it closes, and a
# multibyte-UTF-8 step crossing that same incremental boundary), the
# live/observed annotations on GET /api/sessions and /api/sessions/:id,
# `agentboard observe` (refuses a lock-confirmed-live session and an observe
# session itself, but proceeds on a crashed one -- an open row with no live
# lock; runs through the normal runner machinery, its own row carries
# trigger 'observe'), observation-report + JSON-escaped secret redaction, and
# prune removing the observation file alongside the jsonl/stderr pair.
# Composed from the verified probes of Tasks 1-4. One throwaway
# AGENTBOARD_DATA for the whole run, so session numbering stays predictable
# across legs; exits non-zero on the first deviation. Every leg that spawns a
# session uses a fake AGENTBOARD_SESSION_CMD -- never a real `claude` session.
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

# Find a free port. macOS netstat prints addresses as "*.4700" (no colon
# before the port), so the pattern must match either separator.
PORT=4700
while netstat -an 2>/dev/null | grep -q "[.:]$PORT "; do PORT=$((PORT + 1)); done

$CLI serve --port "$PORT" &
SERVE_PID=$!
PIDS+=("$SERVE_PID")
sleep 1

# ============================================================================
# Leg 1: steps endpoint incremental (brief legs 1+2) -- offset/n round-trip
# across two appends to an open session's jsonl, a trailing line without a
# newline yet stays invisible (and does not advance offset/n) while the
# session is still open, and counts as its final step once the session ends.
# ============================================================================
mkdir -p "$AGENTBOARD_DATA/sessions"
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'manual', '[]')"
S1=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"eerste stap"}]}}' \
  >> "$AGENTBOARD_DATA/sessions/$S1.jsonl"

RESP=$(curl -s "localhost:$PORT/api/sessions/$S1/steps?offset=0&n=0")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert len(d['steps']) == 1, d
assert d['steps'][0]['label'] == 'eerste stap', d
assert d['steps'][0]['n'] == 1, d
assert d['n'] == 1, d
" || fail "steps endpoint: first increment did not return exactly the first step"

OFFSET1=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
N1=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['n'])")

printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"tweede stap"}]}}' \
  >> "$AGENTBOARD_DATA/sessions/$S1.jsonl"

RESP=$(curl -s "localhost:$PORT/api/sessions/$S1/steps?offset=$OFFSET1&n=$N1")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert len(d['steps']) == 1, d
assert d['steps'][0]['label'] == 'tweede stap', d
assert d['steps'][0]['n'] == 2, d
assert d['n'] == 2, d
assert d['offset'] > $OFFSET1, d
" || fail "steps endpoint: second increment did not return exactly the following step"

OFFSET2=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
N2=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['n'])")

# A third line, written without a trailing newline yet, is still being
# written -- it must not be parsed and must not advance offset/n.
printf '%s' '{"type":"assistant","message":{"content":[{"type":"text","text":"nog bezig"}]}}' \
  >> "$AGENTBOARD_DATA/sessions/$S1.jsonl"

RESP=$(curl -s "localhost:$PORT/api/sessions/$S1/steps?offset=$OFFSET2&n=$N2")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['steps'] == [], d
assert d['offset'] == $OFFSET2, d
assert d['n'] == $N2, d
" || fail "partial trailing line leaked while the session is still open"

# Close the session: that same partial line will never complete now, so it
# is parsed as the session's final step.
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "UPDATE session SET ended_at = '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', exit_status = 0 WHERE id = $S1"

RESP=$(curl -s "localhost:$PORT/api/sessions/$S1/steps?offset=$OFFSET2&n=$N2")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert len(d['steps']) == 1, d
assert d['steps'][0]['label'] == 'nog bezig', d
" || fail "partial line did not count once the session was closed"

# ============================================================================
# Leg 2 (added -- coordinator ruling on the Task-1 review): a multibyte-UTF-8
# step crossing an incremental read boundary. Offset math must use byte
# length (Buffer.byteLength), not JS string length, or a following line can
# come back truncated, shifted or mangled.
# ============================================================================
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'manual', '[]')"
S2=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"multibyte é 中文 😀"}]}}' \
  >> "$AGENTBOARD_DATA/sessions/$S2.jsonl"

RESP=$(curl -s "localhost:$PORT/api/sessions/$S2/steps?offset=0&n=0")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert len(d['steps']) == 1, d
assert d['steps'][0]['label'] == 'multibyte é 中文 😀', d
assert d['steps'][0]['n'] == 1, d
" || fail "multibyte step was not parsed intact on the first increment"

OFFSET=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
N=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['n'])")

printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"volgende stap na multibyte"}]}}' \
  >> "$AGENTBOARD_DATA/sessions/$S2.jsonl"

RESP=$(curl -s "localhost:$PORT/api/sessions/$S2/steps?offset=$OFFSET&n=$N")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert len(d['steps']) == 1, d
assert d['steps'][0]['label'] == 'volgende stap na multibyte', d
assert d['steps'][0]['n'] == 2, d
" || fail "step after a multibyte line was mangled or misaligned by offset math"

sqlite3 "$AGENTBOARD_DATA/board.db" \
  "UPDATE session SET ended_at = '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', exit_status = 0 WHERE id = $S2"

# ============================================================================
# Leg 3: live annotation -- an open session row with no lock reports
# live:false on both GET /api/sessions and GET /api/sessions/:id; once this
# script's own (alive) pid holds session.lock in acquireLock's exact shape
# (src/core/runner.ts: pid/hostname/started_at) and names that same row,
# both flip to true.
# ============================================================================
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'manual', '[]')"
S3=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

curl -s "localhost:$PORT/api/sessions" | python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(s for s in d['sessions'] if s['id'] == $S3)
assert row['live'] is False, row
" || fail "open session without a lock was reported live on GET /api/sessions"

curl -s "localhost:$PORT/api/sessions/$S3" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['session']['live'] is False, d['session']
" || fail "open session without a lock was reported live on GET /api/sessions/:id"

cat > "$AGENTBOARD_DATA/session.lock" << EOF
{"pid": $$, "hostname": "$(hostname)", "started_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
EOF

curl -s "localhost:$PORT/api/sessions" | python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(s for s in d['sessions'] if s['id'] == $S3)
assert row['live'] is True, row
" || fail "open session with its own live lock was not reported live on GET /api/sessions"

curl -s "localhost:$PORT/api/sessions/$S3" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['session']['live'] is True, d['session']
" || fail "open session with its own live lock was not reported live on GET /api/sessions/:id"

rm -f "$AGENTBOARD_DATA/session.lock"
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "UPDATE session SET ended_at = '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', exit_status = 0 WHERE id = $S3"

# ============================================================================
# Leg 4: observed + observation redaction -- a session with no observation
# file reports observed:false on GET /api/sessions; once a report lands at
# observationPath(id), observed flips true and the report's secret is
# redacted the same way as a transcript on GET /api/sessions/:id.
# ============================================================================
echo "supergeheim123" | $CLI secret set demo_secret >/dev/null

sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, ended_at, \"trigger\", exit_status, handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'cron', 0, '[]')"
S4=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

curl -s "localhost:$PORT/api/sessions" | python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(s for s in d['sessions'] if s['id'] == $S4)
assert row['observed'] is False, row
" || fail "session without an observation file was reported observed:true"

cat > "$AGENTBOARD_DATA/sessions/$S4-observation.md" << 'EOF'
verdict: pass
Zag geen probleem. Sleutel ter controle: supergeheim123
EOF

curl -s "localhost:$PORT/api/sessions" | python3 -c "
import json, sys
d = json.load(sys.stdin)
row = next(s for s in d['sessions'] if s['id'] == $S4)
assert row['observed'] is True, row
" || fail "session with an observation file was not reported observed:true"

curl -s "localhost:$PORT/api/sessions/$S4" | python3 -c "
import json, sys
d = json.load(sys.stdin)
obs = d['observation']
assert obs is not None, d
assert '[secret:demo_secret]' in obs, obs
assert 'supergeheim123' not in obs, obs
" || fail "observation report was not redacted"

# ============================================================================
# Leg 5: JSON-escape redaction in steps -- a secret containing a character
# JSON escapes (a double quote) must still be caught when it resurfaces
# inside a tool step's JSON.stringify'd detail, not just in its raw form.
# ============================================================================
echo 'sec"ret' | $CLI secret set quotesecret >/dev/null

cat >> "$AGENTBOARD_DATA/sessions/$S4.jsonl" << 'EOF'
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo sec\"ret"}}]}}
EOF

$CLI sessions show "$S4" --json | python3 -c "
import json, sys
d = json.load(sys.stdin)
detail = next(s['detail'] for s in d['steps'] if s['type'] == 'tool')
raw = 'sec' + chr(34) + 'ret'
assert '[secret:quotesecret]' in detail, detail
assert raw not in detail, detail
" || fail "JSON-escaped secret was not redacted in a tool step's detail"

# ============================================================================
# Leg 6: observe -- an open row is only "still running" when the lock
# confirms it (fix-round coordinator ruling, 2026-09-02): a crashed session
# (open row, no live lock) is now observable -- exactly the session most
# worth observing, since SIGKILL would otherwise leave it forever
# unreviewable and "still running" would contradict the UI's own "ended
# early (crash)" for that same row. A row this script's own lock names
# (same acquireLock shape as leg 3, using $$) is still refused. Refusing to
# observe an observe session itself is unaffected either way.
# ============================================================================
cat > "$SCRATCH/fakeobs.sh" << 'EOF'
#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"observatie gedraaid"}]}}'
EOF
chmod +x "$SCRATCH/fakeobs.sh"

# S5: open row, no lock at all -- a crash, so observe now proceeds.
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'manual', '[]')"
S5=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

AGENTBOARD_SESSION_CMD="$SCRATCH/fakeobs.sh" $CLI observe "$S5" >/dev/null \
  || fail "observe refused a crashed session (open row, no live lock)"

# S5B: a second open row, this time named by this script's own (alive) lock
# -- lock-confirmed live, so observe still refuses.
sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'manual', '[]')"
S5B=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")
cat > "$AGENTBOARD_DATA/session.lock" << EOF
{"pid": $$, "hostname": "$(hostname)", "started_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
EOF

expect_fail $CLI observe "$S5B"
ERR=$($CLI observe "$S5B" 2>&1 1>/dev/null) || true
echo "$ERR" | grep -q "still running" || fail "observe did not refuse a lock-confirmed-live session: $ERR"

rm -f "$AGENTBOARD_DATA/session.lock"

AGENTBOARD_SESSION_CMD="$SCRATCH/fakeobs.sh" $CLI observe "$S4" >/dev/null
S6=$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT max(id) FROM session")

sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT \"trigger\", ended_at IS NOT NULL FROM session WHERE id = $S6;" \
  | grep -qx 'observe|1' || fail "observe session row did not carry trigger=observe / ended_at set"

expect_fail $CLI observe "$S6"
ERR=$($CLI observe "$S6" 2>&1 1>/dev/null) || true
echo "$ERR" | grep -q "itself an observation" || fail "observe did not refuse observing an observe-session"

# ============================================================================
# Leg 7: prune removes the observation file too -- not just the jsonl/stderr
# pair.
# ============================================================================
sqlite3 "$AGENTBOARD_DATA/board.db" "UPDATE session SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = $S4"

$CLI sessions prune --older-than 30d | grep -q "Pruned 1 session(s): $S4" || fail "prune did not remove exactly session #$S4"

if [ -f "$AGENTBOARD_DATA/sessions/$S4.jsonl" ]; then fail "prune left $S4.jsonl on disk"; fi
if [ -f "$AGENTBOARD_DATA/sessions/$S4.stderr.log" ]; then fail "prune left $S4.stderr.log on disk"; fi
if [ -f "$AGENTBOARD_DATA/sessions/$S4-observation.md" ]; then fail "prune left $S4-observation.md on disk"; fi
[ -z "$(sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT id FROM session WHERE id = $S4")" ] || fail "pruned session row still present"

kill "$SERVE_PID" >/dev/null 2>&1 || true
wait "$SERVE_PID" 2>/dev/null || true

echo "OK: agentlog verified (steps-incremental, live/observed, observe, redaction, prune, utf8-boundary)"
