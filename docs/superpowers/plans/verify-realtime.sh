#!/usr/bin/env bash
# End-to-end probe for the realtime changesSince endpoint (spec 2026-08-28,
# amended eindreview blok 5): the composite cursor
# (e{maxEventId}.c{maxCommentId}.s{maxSessionId}.r{running}.u{maxUpdatedAt})
# responds correctly to card creation (no event, cursor advances via
# updated_at), move (event), comment, and label edit (updated_at only), plus
# session liveness (a live lock + open session row flips the running flag).
# The changed flag is false on identical since and on missing since; true
# against each previous cursor.
# Composed from the verified curl matrix of Task 1. One throwaway
# AGENTBOARD_DATA for the whole run, so cursors stay predictable. No real
# claude session is ever spawned and AGENTBOARD_AUTORUN is never set.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLI="node dist/cli/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }
id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null

# Find a free port. macOS netstat prints addresses as "*.4690" (no colon
# before the port), so the pattern must match either separator.
PORT=4690
while netstat -an 2>/dev/null | grep -q "[.:]$PORT "; do PORT=$((PORT + 1)); done

# Start the serve
$CLI serve --port "$PORT" &
SERVE_PID=$!
PIDS+=("$SERVE_PID")
sleep 1

# ============================================================================
# Test 1: Initial GET /api/changes → {cursor, changed:false}
# ============================================================================
RESP=$(curl -s "localhost:$PORT/api/changes")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'cursor' in d, ('missing cursor in response', d)
assert 'changed' in d, ('missing changed in response', d)
assert d['changed'] is False, ('changed should be False with no since parameter', d)
assert d['cursor'].startswith('e'), ('cursor should start with e (event)', d['cursor'])
assert 'c' in d['cursor'], ('cursor should contain c (comment)', d['cursor'])
assert 'u' in d['cursor'], ('cursor should contain u (updated_at)', d['cursor'])
" || fail "Initial GET /api/changes response structure mismatch"

CURSOR1=$(echo "$RESP" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

# ============================================================================
# Test 2: Same cursor as since → changed:false
# ============================================================================
RESP=$(curl -s "localhost:$PORT/api/changes?since=$CURSOR1")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['cursor'] == '$CURSOR1', ('cursor changed when it should not', d)
assert d['changed'] is False, ('changed should be False when since equals cursor', d)
" || fail "Same cursor (no change) test failed"

# ============================================================================
# Test 3: Create card (no event) → cursor advances via updated_at
# ============================================================================
CARD=$($CLI card new --type task --title "realtime-test" --json | id_of)

RESP=$(curl -s "localhost:$PORT/api/changes")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['cursor'] != '$CURSOR1', ('cursor did not advance after card creation', d)
" || fail "Cursor did not advance on card creation"

CURSOR2=$(echo "$RESP" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

# Verify: cursor change is in updated_at (no event created for card creation)
echo "$CURSOR2" | python3 -c "
import sys
c = sys.stdin.read().strip()
# Should still be e0 (no event), c0 (no comment), but u should have changed
parts = c.split('.')
assert parts[0] == 'e0', ('event id should still be 0 after card creation', c)
assert parts[1] == 'c0', ('comment id should still be 0 after card creation', c)
assert len(parts) > 2, ('cursor should have updated_at component', c)
" || fail "Card creation cursor did not have correct structure (should only update updated_at)"

# ============================================================================
# Test 4: Old cursor vs new (post-create) → changed:true
# ============================================================================
RESP=$(curl -s "localhost:$PORT/api/changes?since=$CURSOR1")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['changed'] is True, ('changed should be True when since is older than current', d)
assert d['cursor'] == '$CURSOR2', ('cursor mismatch', d)
" || fail "changed flag not true when old cursor is passed"

# ============================================================================
# Test 5: Move card (event) → cursor advances via event id
# ============================================================================
$CLI card move "$CARD" ready --reason t >/dev/null

RESP=$(curl -s "localhost:$PORT/api/changes")
CURSOR3=$(echo "$RESP" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

echo "$CURSOR3" | python3 -c "
import sys
c = sys.stdin.read().strip()
# Should have e1 (event created by move)
parts = c.split('.')
assert parts[0] == 'e1', ('event id should be 1 after move', c)
assert parts[1] == 'c0', ('comment id should still be 0', c)
" || fail "Move card cursor did not have event id incremented"

# Verify changed flag
curl -s "localhost:$PORT/api/changes?since=$CURSOR2" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['changed'] is True, ('changed should be True after move', d)
" || fail "changed flag not true after move"

# ============================================================================
# Test 6: Add comment → cursor advances via comment id
# ============================================================================
$CLI card comment "$CARD" "test comment" >/dev/null

RESP=$(curl -s "localhost:$PORT/api/changes")
CURSOR4=$(echo "$RESP" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

echo "$CURSOR4" | python3 -c "
import sys
c = sys.stdin.read().strip()
# Should have c1 (comment created)
parts = c.split('.')
assert parts[0] == 'e1', ('event id should still be 1', c)
assert parts[1] == 'c1', ('comment id should be 1 after comment', c)
" || fail "Comment cursor did not have comment id incremented"

# Verify changed flag
curl -s "localhost:$PORT/api/changes?since=$CURSOR3" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['changed'] is True, ('changed should be True after comment', d)
" || fail "changed flag not true after comment"

# ============================================================================
# Test 7: Edit labels (only updated_at) → cursor advances
# ============================================================================
$CLI card edit "$CARD" --labels bug,urgent >/dev/null

RESP=$(curl -s "localhost:$PORT/api/changes")
CURSOR5=$(echo "$RESP" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

echo "$CURSOR5" | python3 -c "
import sys
c = sys.stdin.read().strip()
# Should have e1 and c1 unchanged, only u should change
parts = c.split('.')
assert parts[0] == 'e1', ('event id should still be 1 after label edit', c)
assert parts[1] == 'c1', ('comment id should still be 1 after label edit', c)
" || fail "Label edit cursor did not preserve event/comment ids"

# Verify changed flag
curl -s "localhost:$PORT/api/changes?since=$CURSOR4" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['changed'] is True, ('changed should be True after label edit', d)
" || fail "changed flag not true after label edit"

# ============================================================================
# Test 8: All cursors are different and show progression
# ============================================================================
python3 -c "
cursors = ['$CURSOR1', '$CURSOR2', '$CURSOR3', '$CURSOR4', '$CURSOR5']
seen = set()
for c in cursors:
    assert c not in seen, ('duplicate cursor in sequence', c)
    seen.add(c)
print('All cursors unique and in sequence')
"

# ============================================================================
# Test 9: session liveness rides the cursor (eindreview blok 5 amendement).
# No real session is ever spawned; a lock is written in acquireLock's exact
# shape (src/core/runner.ts: pid/hostname/started_at at <data>/session.lock)
# using $$ (this script's own, alive pid) and the real hostname so it reads
# as live and owned, and an open session row is inserted directly (same
# approach as verify-sessions.sh) — sessionStatus() requires both a live
# lock AND an open row to report running:true.
# ============================================================================
CURSOR6=$(curl -s "localhost:$PORT/api/changes" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

sqlite3 "$AGENTBOARD_DATA/board.db" \
  "INSERT INTO session (started_at, \"trigger\", handed_back) VALUES ('$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 'manual', '[]')"
cat > "$AGENTBOARD_DATA/session.lock" << EOF
{"pid": $$, "hostname": "$(hostname)", "started_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
EOF

RESP=$(curl -s "localhost:$PORT/api/changes?since=$CURSOR6")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['changed'] is True, ('changed should be True once a live lock + open session appear', d)
assert '.r1.' in d['cursor'], ('cursor should carry running=1 while the lock is live', d['cursor'])
" || fail "liveness leg: changed/running not True with a live lock + open session row"

CURSOR7=$(echo "$RESP" | python3 -c "import json, sys; print(json.load(sys.stdin)['cursor'])")

rm -f "$AGENTBOARD_DATA/session.lock"

RESP=$(curl -s "localhost:$PORT/api/changes?since=$CURSOR7")
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['changed'] is True, ('changed should flip True again once the lock disappears', d)
assert '.r0.' in d['cursor'], ('cursor should carry running=0 once the lock is gone', d['cursor'])
" || fail "liveness leg: changed/running not True after the lock disappeared"

kill "$SERVE_PID" >/dev/null 2>&1 || true
wait "$SERVE_PID" 2>/dev/null || true

echo "OK: realtime verified (cursor progression, changed flag, create/move/comment/edit, session liveness)"
