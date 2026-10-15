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
  kill "$2" >/dev/null 2>&1 || true; wait "$2" 2>/dev/null || true
  q "UPDATE session SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1;"
}
# Run a CLI command as an agent inside session $1.
as_s() { local s=$1; shift; AGENTBOARD_SESSION_ID=$s AGENTBOARD_ACTOR=agent $CLI "$@"; }
# Combined output of a command that is expected to fail (pipefail-safe).
err_of() { "$@" 2>&1 || true; }
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

# ============================================================================
# Leg 3: write rules (Task 3) -- not yours, read first, held by another,
# request comments, no acting as human, own new cards, gate skips held cards
# ============================================================================
fresh_data
X=$(new_ready "x")
FREE=$(new_ready "free")
fake_live_session 0; S1=$SID
fake_live_session 1; S2=$SID
expect_fail as_s $S1 card comment "$X" "too early"
err_of as_s $S1 card comment "$X" "too early" | grep -q "is not yours. Claim it first" || fail "unclaimed write: wrong error"
as_s $S1 card claim "$X" | grep -q "^$X  x" || fail "card claim did not print the card"
as_s $S1 card comment "$X" "mine" >/dev/null
q "UPDATE card SET claim_seen_at = NULL WHERE id = '$X';"   # what an assignment leaves behind
err_of as_s $S1 card log "$X" "x" | grep -q "Read the card first" || fail "write before reading: wrong error"
as_s $S1 card show "$X" >/dev/null
as_s $S1 card log "$X" "after show" >/dev/null
err_of as_s $S2 card comment "$X" "intrude" | grep -q "is held by session $S1" || fail "write on a held card: wrong error"
as_s $S2 card comment "$X" --request "please rebase" >/dev/null
q "SELECT body FROM comment WHERE card_id = '$X' ORDER BY id DESC LIMIT 1;" | grep -q "^Request from session $S2:" || fail "request prefix (no card) missing"
q "UPDATE session SET card_id = '$FREE' WHERE id = $S2;"
as_s $S2 card comment "$X" --request "second ask" >/dev/null
q "SELECT body FROM comment WHERE card_id = '$X' ORDER BY id DESC LIMIT 1;" | grep -qF "Request from [$FREE](/#/card/$FREE) (session $S2):" || fail "request prefix (with card, no origin) wrong"
err_of as_s $S2 card comment "$FREE" --request "x" | grep -q "is free: claim it instead" || fail "request on a free card: wrong error"
err_of as_s $S1 card comment "$X" "x" --as human | grep -q "An agent session cannot act as human" || fail "--as human in a session not refused"
NEW=$(as_s $S1 card new --type ops --title "own ops" --json | id_of)
as_s $S1 card comment "$NEW" "fine" >/dev/null || fail "own new card not writable"
err_of as_s $S2 card new --type ops --title "b" --blocks "$X" | grep -q "is held by session $S1" || fail "--blocks on a held card not refused"
$CLI card comment "$X" "human outside any session" >/dev/null || fail "human write outside a session refused"
as_s $S1 card show "$X" >/dev/null
as_s $S1 card move "$X" doing --reason "working" >/dev/null
$CLI gate --json | python3 -c "
import json,sys
ids=[c['id'] for c in json.load(sys.stdin)['cards']]
assert '$X' not in ids, ('held doing card in the gate', ids)
" || fail "gate lists a card held by a live session"

# ============================================================================
# Leg 4: freshness (Task 3) -- human comment, human title edit, request and
# an agent comment from outside any session all count; a non-holder's show
# does not reset the holder; the refusal advances the read mark once
# ============================================================================
as_s $S1 card show "$X" >/dev/null
$CLI card comment "$X" "nieuw van mens" >/dev/null
$CLI card edit "$X" --title "nieuwe titel" >/dev/null
as_s $S2 card comment "$X" --request "van S2" >/dev/null
$CLI card comment "$X" "ops via ssh" --as agent >/dev/null
as_s $S2 card show "$X" >/dev/null
ERR=$(as_s $S1 card log "$X" "stale" 2>&1 || true)
for want in "nieuw van mens" "card edited by human" "van S2" "ops via ssh" "changed since you read it"; do
  echo "$ERR" | grep -q "$want" || fail "freshness error misses '$want': $ERR"
done
as_s $S1 card log "$X" "now informed" >/dev/null || fail "retry after a freshness refusal failed"
as_s $S1 card comment "$X" "own words" >/dev/null
as_s $S1 card log "$X" "own words are not news" >/dev/null || fail "own comment tripped the freshness check"

# ============================================================================
# Leg 5: scenario task_5ae3 (Task 3) -- B cannot claim while A holds; after
# A ends, B claims and the claim output carries the newest human comment
# ============================================================================
fresh_data
Y=$(new_ready "y")
fake_live_session 0; A=$SID; AP=$SPID
fake_live_session 1; B=$SID
as_s $A card claim "$Y" >/dev/null
err_of as_s $B card claim "$Y" | grep -q "is held by session $A" || fail "second claim not refused"
end_fake_session "$A" "$AP"
$CLI card comment "$Y" "laatste opdracht" >/dev/null
as_s $B card claim "$Y" | grep -q "laatste opdracht" || fail "claim output misses the newest comment"

# ============================================================================
# Leg 6: a human status move revokes the claim (Task 3)
# ============================================================================
$CLI card move "$Y" needs_input --reason "terug naar mij" >/dev/null
[ "$(q "SELECT claimed_by IS NULL FROM card WHERE id = '$Y';")" = 1 ] || fail "human move kept the claim"
err_of as_s $B card comment "$Y" "x" | grep -q "is not yours" || fail "write after revocation: wrong error"

# ============================================================================
# Leg 1: race (Task 4) -- one ready card, two runners at once: one session
# gets it, the other starts no session at all
# ============================================================================
fresh_data
SCR="$(mktemp -d)"; export FAKE_OUT="$SCR/out.log"; : > "$FAKE_OUT"
printf '#!/usr/bin/env bash\nsleep 2\n' > "$SCR/slow.sh"; chmod +x "$SCR/slow.sh"
R=$(new_ready "race")
AGENTBOARD_SESSION_CMD="$SCR/slow.sh" $CLI runner >/dev/null & R1=$!
AGENTBOARD_SESSION_CMD="$SCR/slow.sh" $CLI runner >/dev/null & R2=$!
wait $R1 $R2
[ "$(q "SELECT COUNT(*) FROM session;")" = 1 ] || fail "race: expected exactly one session, got $(q 'SELECT COUNT(*) FROM session;')"
[ "$(q "SELECT card_id FROM session;")" = "$R" ] || fail "race: the session does not name the card"

# ============================================================================
# Leg 2: assignment (Task 4) -- doing + event before the session runs, the
# prompt names the card, next shows only that card, the gate skips it
# ============================================================================
fresh_data
A=$(new_ready "first")
B=$(new_ready "second")
cat > "$SCR/look.sh" << EOF
#!/usr/bin/env bash
echo "PROMPT:\$(echo "\${@: -1}" | tr '\n' ' ')" >> "\$FAKE_OUT"
$CLI_ABS card show $A --json | python3 -c "import json,sys; d=json.load(sys.stdin)['card']; print('STATUS:'+d['status']+':'+str(d['claimed_by']))" >> "\$FAKE_OUT"
echo NEXT-START >> "\$FAKE_OUT"
$CLI_ABS next >> "\$FAKE_OUT"
echo GATE-START >> "\$FAKE_OUT"
$CLI_ABS gate >> "\$FAKE_OUT"
EOF
chmod +x "$SCR/look.sh"; : > "$FAKE_OUT"
AGENTBOARD_SESSION_CMD="$SCR/look.sh" $CLI runner >/dev/null
SID1=$(q "SELECT id FROM session ORDER BY id DESC LIMIT 1;")
grep -q "PROMPT:.*Your card this session: $A" "$FAKE_OUT" || fail "prompt does not name the assigned card"
grep -q "STATUS:doing:$SID1" "$FAKE_OUT" || fail "card not doing+claimed when the session started"
NEXT_OUT=$(sed -n '/^NEXT-START/,/^GATE-START/p' "$FAKE_OUT"); GATE_OUT=$(sed -n '/^GATE-START/,$p' "$FAKE_OUT")
echo "$NEXT_OUT" | grep -q "^  $A " || fail "next in the session misses its own card"
echo "$NEXT_OUT" | grep -q "^  $B " && fail "next in the session lists a card it does not hold"
echo "$GATE_OUT" | grep -q "^  $A " && fail "gate in the session lists the held card"
echo "$GATE_OUT" | grep -q "^  $B " || fail "gate lost the free card"
q "SELECT payload FROM event WHERE card_id = '$A' AND kind = 'status_changed' ORDER BY id DESC LIMIT 1;" | grep -q "Assigned to session $SID1" || fail "assignment event reason wrong"
[ "$(q "SELECT claimed_by IS NULL FROM card WHERE id = '$A';")" = 1 ] || fail "claim not released at session end"

# Leg 2b: chain -- with AUTORUN the finished session pokes the next runner
cat > "$SCR/hand.sh" << EOF
#!/usr/bin/env bash
CARD=\$(echo "\${@: -1}" | grep -o 'task_[0-9a-f]\{4\}' | head -1)
$CLI_ABS card show "\$CARD" >/dev/null
$CLI_ABS card move "\$CARD" review --from doing --reason done >> "\$FAKE_OUT" 2>&1
EOF
chmod +x "$SCR/hand.sh"
fresh_data
C1=$(new_ready "chain one"); C2=$(new_ready "chain two")
AGENTBOARD_MAX_SESSIONS=1 AGENTBOARD_AUTORUN=1 AGENTBOARD_SESSION_CMD="$SCR/hand.sh" $CLI runner >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(q "SELECT COUNT(*) FROM card WHERE status = 'review';")" = 2 ] && break; sleep 0.5; done
[ "$(q "SELECT COUNT(*) FROM card WHERE status = 'review';")" = 2 ] || fail "chain: the second card was not picked up right after the first session"

# ============================================================================
# Leg 7: crash loop (Task 4) -- stranded sessions resume with an event; a
# human comment resets the count; past the limit the card goes to the human
# ============================================================================
fresh_data
printf '#!/usr/bin/env bash\nexit 1\n' > "$SCR/crash.sh"; chmod +x "$SCR/crash.sh"
K=$(new_ready "crashy")
crash_run() { AGENTBOARD_SESSION_CMD="$SCR/crash.sh" $CLI runner >/dev/null 2>&1 || true; }
crash_run                                   # assigned, strands
crash_run                                   # resume 1
q "SELECT payload FROM event WHERE card_id = '$K' AND kind = 'status_changed' ORDER BY id DESC LIMIT 1;" | grep -q "Resumed: session .* ended without finishing" || fail "resume event missing"
$CLI card comment "$K" "probeer het anders" >/dev/null   # human comment resets the count
crash_run                                   # resume (count 0 again)
crash_run                                   # resume (count 1)
[ "$(q "SELECT status FROM card WHERE id = '$K';")" = doing ] || fail "parked too early: the human comment did not reset the count"
crash_run                                   # count 2 = limit: park
[ "$(q "SELECT status FROM card WHERE id = '$K';")" = needs_input ] || fail "crash loop not parked on needs_input"
q "SELECT payload FROM event WHERE card_id = '$K' AND kind = 'error' ORDER BY id DESC LIMIT 1;" | grep -q "Stopped resuming: sessions" || fail "crash-loop error event missing"

# ============================================================================
# Leg 8: timeout (Task 4) -- a hanging session is stopped and its claim freed
# ============================================================================
fresh_data
printf '#!/usr/bin/env bash\nsleep 30\n' > "$SCR/hang.sh"; chmod +x "$SCR/hang.sh"
H=$(new_ready "hangs")
START=$(date +%s)
AGENTBOARD_SESSION_TIMEOUT_MIN=0.02 AGENTBOARD_SESSION_CMD="$SCR/hang.sh" $CLI runner >/dev/null 2>"$SCR/err.log" || true
[ $(( $(date +%s) - START )) -lt 10 ] || fail "timeout did not stop the session"
grep -q "timed out" "$SCR/err.log" || fail "runner did not log the timeout"
[ "$(q "SELECT claimed_by IS NULL FROM card WHERE id = '$H';")" = 1 ] || fail "timed-out session kept its claim"

# Leg 8b: a non-integer timeout still stops the session; an invalid one falls back to the default
fresh_data
H=$(new_ready "hangs fractional")
START=$(date +%s)
AGENTBOARD_SESSION_TIMEOUT_MIN=0.017 AGENTBOARD_SESSION_CMD="$SCR/hang.sh" $CLI runner >/dev/null 2>"$SCR/err.log" || true
[ $(( $(date +%s) - START )) -lt 10 ] || fail "fractional timeout did not stop the session"
grep -q "ERR_OUT_OF_RANGE" "$SCR/err.log" && fail "fractional timeout threw ERR_OUT_OF_RANGE"
grep -q "timed out" "$SCR/err.log" || fail "fractional timeout not logged"
[ "$(q "SELECT claimed_by IS NULL FROM card WHERE id = '$H';")" = 1 ] || fail "fractional timeout kept the claim"
fresh_data
H=$(new_ready "bad timeout")
AGENTBOARD_SESSION_TIMEOUT_MIN=abc AGENTBOARD_SESSION_CMD="$SCR/slow.sh" $CLI runner >/dev/null 2>"$SCR/err.log" || fail "invalid timeout broke the runner"
grep -q "session exited 0" "$SCR/err.log" || fail "invalid timeout: session did not run normally"

# ============================================================================
# Leg 11b: the doing card from the v0.23.0 database is resumed (Task 4)
# ============================================================================
export AGENTBOARD_DATA="$MIGDATA"
AGENTBOARD_SESSION_CMD="$SCR/slow.sh" $CLI runner >/dev/null
q "SELECT payload FROM event WHERE card_id = '$MIG' AND kind = 'status_changed' ORDER BY id DESC LIMIT 1;" | grep -q "Resumed" || fail "migrated doing card not resumed"

echo "OK: hard claims verified"
