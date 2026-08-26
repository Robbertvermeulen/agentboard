#!/usr/bin/env bash
# End-to-end probe for the trigger/scheduler layer (spec 2026-08-26): the
# gate, --check-after parsing, path/schedule hardenings, the runner (lock,
# prompt, session, notify), and the serve-hook. Composed from the verified
# probes of Tasks 1-4. Throwaway AGENTBOARD_DATA per leg; exits non-zero on
# the first deviation. Every leg that spawns a session uses a fake
# AGENTBOARD_SESSION_CMD -- never the real `claude -p`.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
CLI="node dist/cli/index.js"
CLI_ABS="node $ROOT/dist/cli/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi }
id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

# ============================================================================
# Leg 1: gate matrix -- ready free vs blocked, bare vs expired vs future
# needs_input, next unchanged (Task 1)
# ============================================================================
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null

A=$($CLI card new --type task --title "ready-vrij" --json | id_of)
$CLI card move "$A" ready --reason t >/dev/null
B=$($CLI card new --type task --title "ready-geblokt" --json | id_of)
$CLI card move "$B" ready --reason t >/dev/null
$CLI card new --type ops --title "blocker" --blocks "$B" --as agent >/dev/null
C=$($CLI card new --type task --title "kale needs_input" --json | id_of)
$CLI card move "$C" needs_input --reason t >/dev/null
D=$($CLI card new --type task --title "verlopen check" --json | id_of)
$CLI card move "$D" needs_input --reason t >/dev/null
$CLI card log "$D" "check mail" --as agent --check-after 2020-01-01T00:00:00Z >/dev/null
E=$($CLI card new --type task --title "toekomstige check" --json | id_of)
$CLI card move "$E" needs_input --reason t >/dev/null
$CLI card log "$E" "check deploy" --as agent --check-after 2d >/dev/null

$CLI gate --json | python3 -c "
import json,sys
ids=[c['id'] for c in json.load(sys.stdin)['cards']]
assert '$A' in ids, ('gate missing free ready card', ids)
assert '$D' in ids, ('gate missing expired needs_input', ids)
assert '$B' not in ids, ('gate included blocked ready card', ids)
assert '$C' not in ids, ('gate included bare needs_input', ids)
assert '$E' not in ids, ('gate included future needs_input', ids)
" || fail "gate matrix mismatch"

$CLI card show "$E" --json | grep -q '"check_after"' || fail "check_after not recorded on E"

$CLI next --json | python3 -c "
import json,sys
ids=[c['id'] for c in json.load(sys.stdin)['cards']]
assert '$C' in ids and '$E' in ids, ('next changed: lost bare/future needs_input', ids)
" || fail "next is no longer unchanged for needs_input cards"

# ============================================================================
# Leg 2: --check-after parsing -- shorthand lands as ISO; garbage refused
# (Task 1)
# ============================================================================
$CLI card show "$E" --json | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
ev=[e for e in d['events'] if e['kind']=='action_taken' and 'check_after' in e['payload']][-1]
ts=ev['payload']['check_after']
dt=datetime.datetime.fromisoformat(ts.replace('Z','+00:00'))
delta=(dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
assert 1.9*86400 < delta < 2.1*86400, ('2d shorthand did not land ~2d out as ISO', ts, delta)
" || fail "check-after shorthand did not resolve to an ISO timestamp ~2d out"

expect_fail $CLI card log "$A" bad --check-after niet-goed
ERR=$($CLI card log "$A" bad --check-after niet-goed 2>&1 1>/dev/null) || true
echo "$ERR" | grep -q "Invalid --check-after 'niet-goed'" || fail "garbage --check-after error message wrong: $ERR"

# ============================================================================
# Leg 3: hardenings -- ./_global path escapes refused, @daily/6-field cron
# refused (Task 2)
# ============================================================================
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null

OPS=$($CLI card new --type ops --title r --json | id_of)
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nx\n' "$OPS" \
  | expect_fail $CLI ctx write "./_global/rogue.md" --content - --card "$OPS"
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nx\n' "$OPS" \
  | expect_fail $CLI ctx write "main/../_global/rogue.md" --content - --card "$OPS"
printf -- '---\nkind: routine\nschedule: "@daily"\ncard: %s\n---\nx\n' "$OPS" \
  | expect_fail $CLI ctx write main/nick.md --content - --card "$OPS"
printf -- '---\nkind: routine\nschedule: "*/5 * * * * *"\ncard: %s\n---\nx\n' "$OPS" \
  | expect_fail $CLI ctx write main/six.md --content - --card "$OPS"
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nx\n' "$OPS" \
  | $CLI ctx write main/ok.md --content - --card "$OPS" >/dev/null

# ============================================================================
# Legs 4-6: the runner -- fake session cmd, lock, notify (Task 3)
# ============================================================================
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
SCRATCH="$(mktemp -d)"
export FAKE_OUT="$SCRATCH/calls.log"
cat > "$SCRATCH/fake.sh" << 'EOF'
#!/usr/bin/env bash
printf 'PROMPT-START\n%s\nPROMPT-END\n' "$1" >> "$FAKE_OUT"
EOF
chmod +x "$SCRATCH/fake.sh"
export AGENTBOARD_SESSION_CMD="$SCRATCH/fake.sh"

# --- Leg 4: empty gate -> no spawn, no lock left ---
$CLI runner | grep -q "gate empty" || fail "empty gate did not report 'gate empty'"
if [ -f "$AGENTBOARD_DATA/session.lock" ]; then fail "lock left behind after an empty-gate run"; fi

# --- Leg 4: non-empty gate -> prompt has AGENT.md + routine path, routine
#     marked before spawn, log file exists ---
WORK=$($CLI card new --type task --title "werk" --json | id_of)
$CLI card move "$WORK" ready --reason t >/dev/null
ROPS=$($CLI card new --type ops --title r --json | id_of)
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nWeekly.\n' "$ROPS" \
  | $CLI ctx write main/weekly.md --content - --card "$ROPS" >/dev/null
$CLI routines list >/dev/null   # seed the run-state row
sqlite3 "$AGENTBOARD_DATA/board.db" "UPDATE routine_run SET last_run_at = '2020-01-01T00:00:00.000Z'"

$CLI runner --dry-run --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['started'] is False, d
assert d['gate'] == {'cards': 1, 'routines': 1}, d['gate']
assert 'AGENT.md' in d['prompt'] and 'main/weekly.md' in d['prompt'], d['prompt']
" || fail "dry-run gate/prompt mismatch"
if [ -f "$AGENTBOARD_DATA/session.lock" ]; then fail "dry-run left a lock file"; fi

$CLI runner >/dev/null
[ "$(grep -c PROMPT-START "$FAKE_OUT")" = "1" ] || fail "fake session was not spawned exactly once"
grep -q "main/weekly.md" "$FAKE_OUT" || fail "routine path missing from the prompt"
grep -q "AGENT.md" "$FAKE_OUT" || fail "AGENT.md path missing from the prompt"
$CLI routines due --json | python3 -c "
import json,sys
assert len(json.load(sys.stdin)['routines']) == 0
" || fail "routine still due after a run: not marked before spawn"
[ -n "$(ls "$AGENTBOARD_DATA/sessions/" 2>/dev/null)" ] || fail "no session log file written"

# ============================================================================
# Leg 5: lock -- contention, stale dead-pid cleanup, foreign-hostname hard
# error (Task 3)
# ============================================================================
cat > "$SCRATCH/slow.sh" << 'EOF'
#!/usr/bin/env bash
sleep 5
EOF
chmod +x "$SCRATCH/slow.sh"

AGENTBOARD_SESSION_CMD="$SCRATCH/slow.sh" $CLI runner >/dev/null &
SLOW_PID=$!
PIDS+=("$SLOW_PID")
sleep 1
$CLI runner | grep -q "session already running" || fail "lock contention not detected by a second runner"
wait "$SLOW_PID"
if [ -f "$AGENTBOARD_DATA/session.lock" ]; then fail "lock not released after the slow session finished"; fi

# stale lock: dead pid is cleaned up, runner proceeds
echo '{"pid":999999,"hostname":"'"$(hostname)"'","started_at":"2020-01-01T00:00:00.000Z"}' > "$AGENTBOARD_DATA/session.lock"
$CLI runner >/dev/null
if [ -f "$AGENTBOARD_DATA/session.lock" ]; then fail "stale dead-pid lock was not cleaned up"; fi

# foreign hostname: hard error, lock left untouched (not this process's to clean)
echo '{"pid":1,"hostname":"other-machine","started_at":"2020-01-01T00:00:00.000Z"}' > "$AGENTBOARD_DATA/session.lock"
expect_fail $CLI runner
ERR=$($CLI runner 2>&1 1>/dev/null) || true
echo "$ERR" | grep -q "owned by host 'other-machine'" || fail "foreign-hostname error message wrong: $ERR"
rm -f "$AGENTBOARD_DATA/session.lock"

# ============================================================================
# Leg 6: notify -- handback -> NOTIFY line; missing binary -> "notify failed"
# on stderr; no env -> silent (Task 3, incl. its spawnSync-result fix)
# ============================================================================
NOTE1=$($CLI card new --type task --title "notify-handback" --json | id_of)
$CLI card move "$NOTE1" ready --reason t >/dev/null
cat > "$SCRATCH/hand1.sh" << EOF
#!/usr/bin/env bash
$CLI_ABS card move $NOTE1 review --from ready --as agent --reason done >> "\$FAKE_OUT" 2>&1
EOF
chmod +x "$SCRATCH/hand1.sh"
cat > "$SCRATCH/notify.sh" << 'EOF'
#!/usr/bin/env bash
echo "NOTIFY:$1" >> "$FAKE_OUT"
EOF
chmod +x "$SCRATCH/notify.sh"

: > "$FAKE_OUT"
AGENTBOARD_SESSION_CMD="$SCRATCH/hand1.sh" AGENTBOARD_NOTIFY_CMD="$SCRATCH/notify.sh" $CLI runner >/dev/null
grep "NOTIFY:1 card" "$FAKE_OUT" | grep -q "(review)" || fail "notify line missing/malformed on handback"

NOTE2=$($CLI card new --type task --title "notify-missing-binary" --json | id_of)
$CLI card move "$NOTE2" ready --reason t >/dev/null
cat > "$SCRATCH/hand2.sh" << EOF
#!/usr/bin/env bash
$CLI_ABS card move $NOTE2 review --from ready --as agent --reason done >> "\$FAKE_OUT" 2>&1
EOF
chmod +x "$SCRATCH/hand2.sh"
: > "$SCRATCH/err.log"
AGENTBOARD_SESSION_CMD="$SCRATCH/hand2.sh" AGENTBOARD_NOTIFY_CMD=/no/such/binary $CLI runner >/dev/null 2>"$SCRATCH/err.log"
grep -q "notify failed" "$SCRATCH/err.log" || fail "missing notify binary did not log 'notify failed' to stderr"

NOTE3=$($CLI card new --type task --title "notify-no-env" --json | id_of)
$CLI card move "$NOTE3" ready --reason t >/dev/null
cat > "$SCRATCH/hand3.sh" << EOF
#!/usr/bin/env bash
$CLI_ABS card move $NOTE3 review --from ready --as agent --reason done >> "\$FAKE_OUT" 2>&1
EOF
chmod +x "$SCRATCH/hand3.sh"
: > "$SCRATCH/err.log"
AGENTBOARD_SESSION_CMD="$SCRATCH/hand3.sh" $CLI runner >/dev/null 2>"$SCRATCH/err.log"
[ ! -s "$SCRATCH/err.log" ] || fail "notify produced stderr output with no AGENTBOARD_NOTIFY_CMD set"

# ============================================================================
# Leg 7: serve-hook -- AUTORUN=1 + comment spawns the runner (fake evidence);
# without the env var, silent (Task 4)
# ============================================================================
export AGENTBOARD_DATA="$(mktemp -d)/abdata"
$CLI init >/dev/null
SCRATCH2="$(mktemp -d)"
export FAKE_OUT="$SCRATCH2/calls.log"
cat > "$SCRATCH2/fake.sh" << 'EOF'
#!/usr/bin/env bash
echo HOOKED >> "$FAKE_OUT"
EOF
chmod +x "$SCRATCH2/fake.sh"

HOOK=$($CLI card new --type task --title x --json | id_of)
$CLI card move "$HOOK" ready --reason t >/dev/null

AGENTBOARD_AUTORUN=1 AGENTBOARD_SESSION_CMD="$SCRATCH2/fake.sh" $CLI serve --port 4671 &
SERVE_PID=$!
PIDS+=("$SERVE_PID")
sleep 1
curl -s -X POST "localhost:4671/api/cards/$HOOK/comments" -H 'Content-Type: application/json' -d '{"text":"go"}' >/dev/null
sleep 2
[ "$(grep -c HOOKED "$FAKE_OUT")" -ge 1 ] || fail "AUTORUN=1 did not poke the runner via the serve-hook"
kill "$SERVE_PID" >/dev/null 2>&1 || true
wait "$SERVE_PID" 2>/dev/null || true

: > "$FAKE_OUT"
$CLI serve --port 4672 &
SERVE_PID=$!
PIDS+=("$SERVE_PID")
sleep 1
curl -s -X POST "localhost:4672/api/cards/$HOOK/comments" -H 'Content-Type: application/json' -d '{"text":"stil"}' >/dev/null
sleep 2
if [ -s "$FAKE_OUT" ]; then fail "runner was spawned without AGENTBOARD_AUTORUN set"; fi
kill "$SERVE_PID" >/dev/null 2>&1 || true
wait "$SERVE_PID" 2>/dev/null || true

echo "OK: trigger/scheduler verified (gate, check-after, hardenings, runner+lock+notify, serve-hook)"
