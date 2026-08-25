#!/usr/bin/env bash
# End-to-end probe for blockers & claiming (spec 2026-08-25). Runs against a
# throwaway AGENTBOARD_DATA; exits non-zero on the first deviation.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLI="node dist/cli/index.js"
export AGENTBOARD_DATA="$(mktemp -d)/abdata"

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi }
id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }

$CLI init >/dev/null

T=$($CLI card new --type task --title "Geblokte taak" --json | id_of)
$CLI card move "$T" ready --reason triage >/dev/null
$CLI next | grep -q "$T" || fail "ready card missing from next"

O1=$($CLI card new --type ops --title "Blocker 1" --blocks "$T" --as agent --json | id_of)
O2=$($CLI card new --type ops --title "Blocker 2" --blocks "$T" --as agent --json | id_of)
if $CLI next | grep -q "$T"; then fail "blocked card still in next"; fi
$CLI card show "$T" | grep -q "blocked by: $O1 (inbox), $O2 (inbox)" || fail "blocked-by line wrong"
$CLI card show "$O1" | grep -q "unblocks: $T" || fail "reverse unblocks line missing"

expect_fail $CLI card new --type ops --title "Wees" --blocks task_nope
B=$($CLI card new --type task --title "B" --json | id_of)
$CLI card edit "$B" --blocked-by "$T" >/dev/null
expect_fail $CLI card edit "$T" --blocked-by "$B"      # cycle
expect_fail $CLI card edit "$T" --blocked-by "$T"      # self
$CLI card edit "$B" --blocked-by "" >/dev/null

$CLI card move "$O1" done --reason ok >/dev/null
if $CLI next | grep -q "$T"; then fail "card resurfaced with one blocker still open"; fi
$CLI card move "$O2" done --reason ok >/dev/null
$CLI next | grep -q "$T" || fail "card did not resurface after last blocker"

$CLI card move "$T" doing --from ready --as agent --reason claim >/dev/null
expect_fail $CLI card move "$T" doing --from ready --as agent --reason claim
$CLI card show "$T" --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
moves=[(e['payload']['from'],e['payload']['to']) for e in d['events'] if e['kind']=='status_changed']
assert moves == [('inbox','ready'),('ready','doing')], moves
assert [b['id'] for b in d['blockers']] == ['$O1','$O2'], d['blockers']
"
expect_fail $CLI card move "$T" done --as agent --reason nope   # invariant 2 intact

echo "OK: blockers & claiming verified ($T, $O1, $O2, $B)"
