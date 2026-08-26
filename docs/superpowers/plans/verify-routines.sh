#!/usr/bin/env bash
# End-to-end probe for routines (spec 2026-08-26). Throwaway AGENTBOARD_DATA;
# exits non-zero on the first deviation.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLI="node dist/cli/index.js"
export AGENTBOARD_DATA="$(mktemp -d)/abdata"

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi }
id_of() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }

$CLI init >/dev/null

OPS=$($CLI card new --type ops --title "Routine: weekly test" --json | id_of)
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\nname: Weekly test\n---\nDo the weekly thing.\n' "$OPS" \
  | $CLI ctx write main/weekly-test.md --content - --card "$OPS" >/dev/null

# validation refusals
printf -- '---\nkind: routine\ncard: %s\n---\nx\n' "$OPS" | expect_fail $CLI ctx write main/no-schedule.md --content - --card "$OPS"
printf -- '---\nkind: routine\nschedule: nope\ncard: %s\n---\nx\n' "$OPS" | expect_fail $CLI ctx write main/bad-cron.md --content - --card "$OPS"
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\n---\nx\n' | expect_fail $CLI ctx write main/no-card.md --content - --card "$OPS"

# seeding: first sight is never due
$CLI routines list --json | grep -q '"last_run_at"' || fail "seeding missing"
[ "$($CLI routines due --json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['routines']))")" = "0" ] || fail "fresh routine is due"

# force due -> mark -> not due
sqlite3 "$AGENTBOARD_DATA/board.db" "UPDATE routine_run SET last_run_at = '2020-01-01T00:00:00.000Z'"
$CLI routines due | grep -q weekly-test || fail "forced routine not due"
$CLI routines mark main/weekly-test.md >/dev/null
if $CLI routines due | grep -q weekly-test; then fail "marked routine still due"; fi

# broken file breaks nothing
printf -- '---\nkind: routine\nschedule: nope\ncard: %s\n---\nx\n' "$OPS" > "$AGENTBOARD_DATA/context/main/broken.md"
$CLI routines due | grep -q '! main/broken.md' || fail "broken file not reported"
$CLI routines list | grep -q weekly-test || fail "broken file broke the sweep"

# auto-ready + dedup tooling
R=$($CLI card new --type task --title "Weekly run" --routine main/weekly-test.md --as agent --json | id_of)
$CLI card show "$R" | grep -q "status: ready" || fail "routine card not in ready"
$CLI card list --routine main/weekly-test.md | grep -q "$R" || fail "card list --routine miss"
T=$($CLI card new --type task --title "Ticket" --json | id_of)
$CLI card edit "$T" --refs '[{"label":"SP-123","url":"https://support.example/SP-123"}]' >/dev/null
$CLI card list --ref sp-123 | grep -q "$T" || fail "card list --ref miss"
expect_fail $CLI card list

# migration: a pre-routines db gains the column and the table on init
OLD="$(mktemp -d)/abdata-old"
mkdir -p "$OLD"
sqlite3 "$OLD/board.db" "
CREATE TABLE board (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE card (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, owner TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', context_refs TEXT NOT NULL DEFAULT '[]', blocked_by TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE comment (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES card(id), kind TEXT NOT NULL CHECK (kind IN ('status_changed','action_taken','context_written','error','upload_added','secret_stored','blocker_added')), actor TEXT NOT NULL CHECK (actor IN ('human','agent')), payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
INSERT INTO board VALUES ('main','main','2026-01-01T00:00:00.000Z');
"
AGENTBOARD_DATA="$OLD" $CLI init | grep -q 'card.routine' || fail "routine column migration did not fire on old db"
sqlite3 "$OLD/board.db" ".schema routine_run" | grep -q last_run_at || fail "routine_run missing on old db"

echo "OK: routines verified ($OPS, $R, $T)"
