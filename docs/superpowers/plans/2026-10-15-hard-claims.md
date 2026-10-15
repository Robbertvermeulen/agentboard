# Hard Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two runner sessions never work the same card, and an agent never writes on a card from a stale read: the runner assigns one card per session and claims it before the session starts, and the core refuses agent writes on cards the session does not hold or has not seen the latest of.

**Architecture:** A `claimed_by` column on `card` replaces the event-derived claim. The runner picks and claims a card in the same immediate transaction that creates the session row. A new leaf module `src/core/claims.ts` holds the write guard, the freshness check, `card claim`, claim release and boot recovery; `src/core/slots.ts` takes the lock-file and liveness helpers out of `runner.ts` so `claims.ts` can use them without an import cycle; `src/core/workdirs.ts` owns per-card workdirs, per-session TMPDIR and pruning.

**Tech Stack:** TypeScript (tsc, ESM), better-sqlite3, commander CLI, Hono server, bash verify scripts with fake `AGENTBOARD_SESSION_CMD`.

**Spec:** `docs/superpowers/specs/2026-10-15-hard-claims-design.md`

## Global Constraints

- No test framework. Each task extends `docs/superpowers/plans/verify-claims.sh` (throwaway `AGENTBOARD_DATA`, fake session commands, never a real `claude`, never `~/.agentboard`). Run with `npm run build && bash docs/superpowers/plans/verify-claims.sh`.
- Guards apply only when `AGENTBOARD_SESSION_ID` is set. Outside a session (ssh CLI, server API, local runs) behavior is unchanged.
- Defaults: `AGENTBOARD_SESSION_TIMEOUT_MIN` = 45 (decimals allowed), `AGENTBOARD_RESUME_LIMIT` = 2.
- Status-change reasons, verbatim: `Assigned to session N`, `Check due, assigned to session N`, `Resumed: session M ended without finishing`, `Resumed: unclaimed doing card`. Crash-loop error event: `Stopped resuming: sessions M, N ended without finishing this card`.
- Error texts, verbatim: `Card X is held by session M. Use 'card comment X --request' to ask, or wait.` / `Card X is not yours. Claim it first: agentboard card claim X` / `Read the card first: agentboard card show X` / `An agent session cannot act as human`.
- Never write `#NNN` for session numbers in commit messages or the PR (semantic-release turns them into issue links). Write "session 328".
- Conventional commits on branch `feat/hard-claims` (the spec commit is already there). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match the surrounding style: comments explain why, not what; no new dependencies.

## Review Focus

1. An agent comment written outside a session (`--as agent` over ssh, `session_id` NULL) must count as new for the holder. Test in Task 3, leg 4.
2. A held doing card must not show up in the gate, or a UI poke during the session would hand it to a second session. Test in Task 3, leg 3 (and Task 4, leg 2 from inside a session).
3. A request comment from a session with an assigned card links that card; without `AGENTBOARD_ORIGIN` the link is relative. Test in Task 3, leg 3.
4. The crash-loop counter resets on a human comment, not only on a human move. Test in Task 4, leg 7.
5. `card show` by a session that is not the holder must not move the holder's `claim_seen_at`. Test in Task 3, leg 4.

Known accepted gap (document, do not test): the guard runs in its own transaction just before the write, so a human action landing in the milliseconds between guard and write is not caught by that write; the next write catches it.

---

### Task 1: Extract slots.ts and move addEventIn (no behavior change)

**Files:**
- Create: `src/core/slots.ts`
- Modify: `src/core/runner.ts:1-170` (lock helpers move out; `liveSessionIds` delegates)
- Modify: `src/core/db.ts` (receives `addEventIn`)
- Modify: `src/core/cards.ts:257-271` (remove `addEventIn`, re-export it)

**Interfaces:**
- Produces: `slots.ts`: `lockPath(slot: number): string`, `maxSessions(): number`, `interface SessionLock { pid; hostname; started_at; session_id? }`, `processAlive(pid: number): boolean`, `readLock(slot: number): SessionLock | null`, `liveSessionIdsIn(db: Database.Database): number[]`.
- Produces: `db.ts`: `addEventIn(db, cardId, kind: EventKind, actor: Actor, payload): void` (cards.ts re-exports it, so `context.ts` and `uploads.ts` imports keep working).

- [ ] **Step 1: Baseline the existing probes**

Run: `npm run build && for s in trigger sessions realtime agentlog blockers session-env; do bash docs/superpowers/plans/verify-$s.sh || echo "BASELINE FAIL $s"; done`
Expected: every script prints its `OK:` line. Note any pre-existing failure; it is not yours to fix.

- [ ] **Step 2: Create `src/core/slots.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataDir } from './db.js';

// One numbered lock file per slot ('session.lock' for slot 0, matching the
// pre-pool name so existing boot cleanup keeps working at the default N=1).
// Lives apart from runner.ts so claims.ts can ask "is this session alive?"
// without importing the runner (which imports cards.ts, which imports claims).
export const lockPath = (slot: number) => path.join(dataDir(), slot === 0 ? 'session.lock' : `session.lock.${slot}`);

// How many sessions may run at once. Default 1 keeps single-flight behavior.
export const maxSessions = () => Math.max(1, Number(process.env.AGENTBOARD_MAX_SESSIONS ?? 1));

export interface SessionLock {
  pid: number;
  hostname: string;
  started_at: string;
  session_id?: number; // set once the session record exists (see markLockSession)
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLock(slot: number): SessionLock | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath(slot), 'utf8')) as SessionLock;
  } catch {
    return null;
  }
}

// Heartbeat: which runner-started sessions are alive right now? A lock with
// a live process proves it; the open session row confirms it. Both required:
// a stale row after a crash must not read as "live".
export function liveSessionIdsIn(db: Database.Database): number[] {
  const ids: number[] = [];
  for (let slot = 0; slot < maxSessions(); slot++) {
    const lock = readLock(slot);
    if (lock && lock.hostname === os.hostname() && processAlive(lock.pid) && typeof lock.session_id === 'number') {
      ids.push(lock.session_id);
    }
  }
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT id FROM session WHERE ended_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(ids) as { id: number }[];
  return rows.map((r) => r.id);
}
```

- [ ] **Step 3: Point runner.ts at slots.ts**

In `src/core/runner.ts`: delete the local `lockPath`, `maxSessions`, `SessionLock`, `processAlive` definitions and add
`import { SessionLock, liveSessionIdsIn, lockPath, maxSessions, processAlive, readLock } from './slots.js';`.
Replace the body of `liveSessionIds()` with:

```ts
export function liveSessionIds(): number[] {
  const db = openDb();
  try {
    return liveSessionIdsIn(db);
  } finally {
    db.close();
  }
}
```

In `runnersAhead`, replace its local `read` helper with `readLock` (this function is deleted in Task 4; keep it compiling until then).

- [ ] **Step 4: Move `addEventIn` to db.ts**

Cut `addEventIn` from `src/core/cards.ts` (lines 257-271) and paste it unchanged at the end of `src/core/db.ts` (db.ts already imports `Database` and defines `now`, `Actor`, `EventKind`). In `cards.ts` add `addEventIn` to the existing `import { ... } from './db.js'` list and add the line `export { addEventIn } from './db.js';` below the imports.

- [ ] **Step 5: Build and re-run the baseline**

Run: `npm run build && for s in trigger sessions realtime agentlog blockers session-env; do bash docs/superpowers/plans/verify-$s.sh || echo "FAIL $s"; done`
Expected: the same `OK:` lines as Step 1, no new FAIL.

- [ ] **Step 6: Commit**

```bash
git add src/core/slots.ts src/core/runner.ts src/core/db.ts src/core/cards.ts
git commit -m "refactor(runner): move lock and liveness helpers to slots.ts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema, types and boot recovery

**Files:**
- Modify: `src/core/db.ts` (SCHEMA `card`, `comment`, `session` tables; migrations in `initData`)
- Modify: `src/core/cards.ts:25-48` (`Card`, `Comment` interfaces)
- Modify: `src/core/sessions.ts:26-38` (`startSessionRecordIn`)
- Create: `src/core/claims.ts` (first functions: `ownSession`, `releaseSessionClaims`, `recoverSessions`)
- Modify: `src/cli/index.ts` (`sessions recover`)
- Modify: `bin/run.sh`
- Create: `docs/superpowers/plans/verify-claims.sh` (header, helpers, legs 9 and 11)

**Interfaces:**
- Consumes: `liveSessionIdsIn` (Task 1), `addEventIn` in db.ts (Task 1).
- Produces: columns `card.claimed_by INTEGER`, `card.claim_seen_at TEXT`, `card.human_edited_at TEXT`, `comment.session_id INTEGER`, `session.card_id TEXT`. `Card` gains `claimed_by: number | null; claim_seen_at: string | null; human_edited_at: string | null`. `Comment` gains `session_id: number | null`.
- Produces: `claims.ts`: `ownSession(): number | undefined`, `releaseSessionClaims(sessionId: number): number`, `recoverSessions(): { sessions: number; claims: number }`.
- Produces: `sessions.ts`: `startSessionRecordIn(db, trigger: string): { id: number; jsonl: string; stderr: string }`.

- [ ] **Step 1: Write the probe skeleton with legs 9 and 11**

Create `docs/superpowers/plans/verify-claims.sh`:

```bash
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
kill "$P"; rm -f "$AGENTBOARD_DATA"/session.lock*
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
```

Run: `chmod +x docs/superpowers/plans/verify-claims.sh && npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: FAIL at leg 9 (`sessions recover` is an unknown command).

- [ ] **Step 2: Add the columns to SCHEMA and the migrations**

In `src/core/db.ts` SCHEMA, add to `card` after `routine TEXT,`:

```sql
  claimed_by      INTEGER,
  claim_seen_at   TEXT,
  human_edited_at TEXT,
```

add `  session_id INTEGER,` to `comment` (after its last existing column, keep commas valid), and `  card_id TEXT,` to `session` before `total_cost_usd` (keep commas valid).

In `initData`, directly after the `card.routine` migration block:

```ts
  // Migration: hard claims (spec 2026-10-15). The holder session, how far it
  // has read the card, and when a human last edited it (title/body edits
  // write no event, so the freshness check needs this column to see them).
  if (!cardCols.some((c) => c.name === 'claimed_by')) {
    db.exec(`
      ALTER TABLE card ADD COLUMN claimed_by INTEGER;
      ALTER TABLE card ADD COLUMN claim_seen_at TEXT;
      ALTER TABLE card ADD COLUMN human_edited_at TEXT;
    `);
    created.push('card claim columns');
  }
```

After the `total_cost_usd` session block:

```ts
  // Migration: the card the runner assigned to a session (hard claims).
  if (!sessionCols.some((c) => c.name === 'card_id')) {
    db.exec('ALTER TABLE session ADD COLUMN card_id TEXT');
    created.push('session.card_id');
  }
```

After the `comment.updated_at` block:

```ts
  // Migration: which session wrote an agent comment (hard claims): a holder
  // must see comments from other sessions, not its own.
  if (!commentCols.some((c) => c.name === 'session_id')) {
    db.exec('ALTER TABLE comment ADD COLUMN session_id INTEGER');
    created.push('comment.session_id');
  }
```

- [ ] **Step 3: Extend the interfaces**

In `src/core/cards.ts` `interface Card`, after `routine: string | null;` add:

```ts
  claimed_by: number | null; // holder session (hard claims); only counts while that session lives
  claim_seen_at: string | null;
  human_edited_at: string | null;
```

In `interface Comment`, after `updated_at`, add `session_id: number | null;`.

- [ ] **Step 4: `startSessionRecordIn` in sessions.ts**

Replace `startSessionRecord` in `src/core/sessions.ts` with:

```ts
// In-transaction variant: the runner creates the session row in the same
// transaction that claims its card, so a claim never names a missing row.
export function startSessionRecordIn(db: Database.Database, trigger: string): { id: number; jsonl: string; stderr: string } {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const info = db.prepare(`INSERT INTO session (started_at, "trigger", handed_back) VALUES (?, ?, '[]')`).run(now(), trigger);
  const id = Number(info.lastInsertRowid);
  return { id, jsonl: sessionJsonlPath(id), stderr: sessionStderrPath(id) };
}

export function startSessionRecord(trigger: string): { id: number; jsonl: string; stderr: string } {
  const db = openDb();
  try {
    return startSessionRecordIn(db, trigger);
  } finally {
    db.close();
  }
}
```

Add `import type Database from 'better-sqlite3';` to sessions.ts if it is not imported yet.

- [ ] **Step 5: Create `src/core/claims.ts` with release and recover**

```ts
import { now, openDb } from './db.js';
import { liveSessionIdsIn } from './slots.js';

// Hard claims (spec 2026-10-15): card.claimed_by names the session that
// holds a card. A claim only counts while that session lives, so a crash
// never wedges a card; releasing and recovering are hygiene on top.

// Inside a runner session AGENTBOARD_SESSION_ID names the caller. Outside
// one (ssh CLI, server API, local runs) the guards below stand down.
export function ownSession(): number | undefined {
  return Number(process.env.AGENTBOARD_SESSION_ID) || undefined;
}

// The runner calls this when a session ends, crash or not.
export function releaseSessionClaims(sessionId: number): number {
  const db = openDb();
  try {
    return db.prepare('UPDATE card SET claimed_by = NULL, claim_seen_at = NULL WHERE claimed_by = ?').run(sessionId).changes;
  } finally {
    db.close();
  }
}

// Boot only (bin/run.sh, after the stale locks are gone): a machine restart
// skips the runner's finally-block, so close the rows it left open and drop
// every claim. Refuses while any session is live.
export function recoverSessions(): { sessions: number; claims: number } {
  const db = openDb();
  try {
    if (liveSessionIdsIn(db).length) throw new Error('A session is live; recover only runs at boot');
    return db
      .transaction(() => ({
        sessions: db.prepare('UPDATE session SET ended_at = ? WHERE ended_at IS NULL').run(now()).changes,
        claims: db
          .prepare('UPDATE card SET claimed_by = NULL, claim_seen_at = NULL WHERE claimed_by IS NOT NULL')
          .run().changes,
      }))
      .immediate();
  } finally {
    db.close();
  }
}
```

- [ ] **Step 6: CLI `sessions recover` and run.sh**

In `src/cli/index.ts`, import `recoverSessions` from `'../core/claims.js'` and add after the `sessions prune` command:

```ts
sessions
  .command('recover')
  .description('boot cleanup: close session rows left open by a restart and clear their card claims')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const r = recoverSessions();
      output(opts, `Recovered: ${r.sessions} open sessions closed, ${r.claims} claims cleared`, r);
    })
  );
```

In `bin/run.sh`, directly after the `rm -f "$AGENTBOARD_DATA"/session.lock*` line:

```bash
agentboard sessions recover   # rows and claims a restart left behind (the runner's finally never ran)
```

- [ ] **Step 7: Build and run the probe**

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: `OK: hard claims verified`.

- [ ] **Step 8: Commit**

```bash
git add src/core/db.ts src/core/cards.ts src/core/sessions.ts src/core/claims.ts src/cli/index.ts bin/run.sh docs/superpowers/plans/verify-claims.sh
git commit -m "feat(claims): claim columns, session card_id and boot recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Write guards, freshness, `card claim` and request comments

**Files:**
- Modify: `src/core/claims.ts` (guard, freshness, claim, seen)
- Modify: `src/core/cards.ts` (`moveCard`, `addComment`, `editComment`, `editCard`, `removeBlocker`, `logEvent`, `createCard`)
- Modify: `src/core/context.ts:76-115` (`writeContext`)
- Modify: `src/cli/index.ts` (`card show`, new `card claim`, `card comment --request`)
- Modify: `docs/superpowers/plans/verify-claims.sh` (legs 3-6)

**Interfaces:**
- Consumes: `ownSession`, columns from Task 2, `liveSessionIdsIn`.
- Produces: `claims.ts`:
  - `type GuardResult = 'unguarded' | 'holder' | 'request'`
  - `assertNotHumanInSession(actor: string): void`
  - `guardAgentWrite(cardId: string, actor: string, opts?: { request?: boolean }): GuardResult`
  - `newSinceIn(db, cardId: string, since: string, own: number): string[]`
  - `liveHolderIn(db, claimedBy: number | null, live?: ReadonlySet<number>): number | null`
  - `claimCard(cardId: string): void`
  - `markSeen(cardId: string, at: string): void`
  - `requestPrefixIn(db, own: number): string`
- Produces: `addComment(id, body, author, opts?: { request?: boolean }): Comment`.

- [ ] **Step 1: Write legs 3-6 (failing)**

Insert before the final `echo "OK: ..."` line of `verify-claims.sh`:

```bash
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
as_s $S1 card comment "$X" "too early" 2>&1 | grep -q "is not yours. Claim it first" || fail "unclaimed write: wrong error"
as_s $S1 card claim "$X" | grep -q "^$X  x" || fail "card claim did not print the card"
as_s $S1 card comment "$X" "mine" >/dev/null
q "UPDATE card SET claim_seen_at = NULL WHERE id = '$X';"   # what an assignment leaves behind
as_s $S1 card log "$X" "x" 2>&1 | grep -q "Read the card first" || fail "write before reading: wrong error"
as_s $S1 card show "$X" >/dev/null
as_s $S1 card log "$X" "after show" >/dev/null
as_s $S2 card comment "$X" "intrude" 2>&1 | grep -q "is held by session $S1" || fail "write on a held card: wrong error"
as_s $S2 card comment "$X" --request "please rebase" >/dev/null
q "SELECT body FROM comment WHERE card_id = '$X' ORDER BY id DESC LIMIT 1;" | grep -q "^Request from session $S2:" || fail "request prefix (no card) missing"
q "UPDATE session SET card_id = '$FREE' WHERE id = $S2;"
as_s $S2 card comment "$X" --request "second ask" >/dev/null
q "SELECT body FROM comment WHERE card_id = '$X' ORDER BY id DESC LIMIT 1;" | grep -qF "Request from [$FREE](#/card/$FREE) (session $S2):" || fail "request prefix (with card, no origin) wrong"
as_s $S2 card comment "$FREE" --request "x" 2>&1 | grep -q "is free: claim it instead" || fail "request on a free card: wrong error"
as_s $S1 card comment "$X" "x" --as human 2>&1 | grep -q "An agent session cannot act as human" || fail "--as human in a session not refused"
NEW=$(as_s $S1 card new --type ops --title "own ops" --json | id_of)
as_s $S1 card comment "$NEW" "fine" >/dev/null || fail "own new card not writable"
as_s $S2 card new --type ops --title "b" --blocks "$X" 2>&1 | grep -q "is held by session $S1" || fail "--blocks on a held card not refused"
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
as_s $B card claim "$Y" 2>&1 | grep -q "is held by session $A" || fail "second claim not refused"
end_fake_session "$A" "$AP"
$CLI card comment "$Y" "laatste opdracht" >/dev/null
as_s $B card claim "$Y" | grep -q "laatste opdracht" || fail "claim output misses the newest comment"

# ============================================================================
# Leg 6: a human status move revokes the claim (Task 3)
# ============================================================================
$CLI card move "$Y" needs_input --reason "terug naar mij" >/dev/null
[ "$(q "SELECT claimed_by IS NULL FROM card WHERE id = '$Y';")" = 1 ] || fail "human move kept the claim"
as_s $B card comment "$Y" "x" 2>&1 | grep -q "is not yours" || fail "write after revocation: wrong error"
```

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: FAIL in leg 3 (`card claim` unknown command).

- [ ] **Step 2: Guard, freshness, claim and seen in claims.ts**

Append to `src/core/claims.ts`:

```ts
interface ClaimRow {
  id: string;
  status: string;
  claimed_by: number | null;
  claim_seen_at: string | null;
  human_edited_at: string | null;
}

function claimRowIn(db: Database.Database, id: string): ClaimRow {
  const row = db
    .prepare('SELECT id, status, claimed_by, claim_seen_at, human_edited_at FROM card WHERE id = ?')
    .get(id) as ClaimRow | undefined;
  if (!row) throw new Error(`Card not found: ${id}`);
  return row;
}

// The holder only counts while its session lives: a crashed session's claim
// reads as free everywhere, without any cleanup having run.
export function liveHolderIn(
  db: Database.Database,
  claimedBy: number | null,
  live?: ReadonlySet<number>
): number | null {
  if (claimedBy === null) return null;
  return (live ?? new Set(liveSessionIdsIn(db))).has(claimedBy) ? claimedBy : null;
}

const heldBy = (id: string, holder: number) =>
  `Card ${id} is held by session ${holder}. Use 'card comment ${id} --request' to ask, or wait.`;

export function assertNotHumanInSession(actor: string): void {
  if (ownSession() !== undefined && actor === 'human') throw new Error('An agent session cannot act as human');
}

// What the holder has not seen yet: comments from anyone but itself, human
// events, and silent human edits. Own writes are never news.
export function newSinceIn(db: Database.Database, cardId: string, since: string, own: number): string[] {
  const comments = db
    .prepare(
      `SELECT author, body, created_at, session_id FROM comment
       WHERE card_id = ? AND (created_at > ? OR updated_at > ?) AND (session_id IS NULL OR session_id != ?)
       ORDER BY created_at, id`
    )
    .all(cardId, since, since, own) as { author: string; body: string; created_at: string; session_id: number | null }[];
  const events = db
    .prepare(
      `SELECT kind, payload, created_at FROM event
       WHERE card_id = ? AND actor = 'human' AND created_at > ? ORDER BY created_at, id`
    )
    .all(cardId, since) as { kind: string; payload: string; created_at: string }[];
  const card = claimRowIn(db, cardId);
  const items = [
    ...comments.map((c) => ({
      at: c.created_at,
      text: `comment by ${c.author}${c.session_id ? ` (session ${c.session_id})` : ''} at ${c.created_at}: ${c.body.slice(0, 300)}`,
    })),
    ...events.map((e) => {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      const detail = p.reason ?? p.note ?? p.blocker ?? p.name ?? p.path ?? '';
      return { at: e.created_at, text: `${e.kind} by human at ${e.created_at}${detail ? `: ${String(detail).slice(0, 300)}` : ''}` };
    }),
  ];
  if (card.human_edited_at && card.human_edited_at > since) {
    items.push({ at: card.human_edited_at, text: `card edited by human at ${card.human_edited_at} (title, body, labels or refs): run card show` });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at)).map((i) => i.text);
}

```

Then the guard. A throw inside `db.transaction` rolls back the read-mark update, so the refusal for news is raised after the transaction commits:

```ts
export type GuardResult = 'unguarded' | 'holder' | 'request';

// Every agent write inside a session passes here first (spec section 4):
// the session must hold the card, must have read it, and must have seen
// everything new since. A refusal for news moves the read mark, so the
// retry passes once the agent has taken it in. Runs in its own short
// transaction before the caller's write; a human action landing in the
// milliseconds between the two is caught by the next write instead.
export function guardAgentWrite(cardId: string, actor: string, opts: { request?: boolean } = {}): GuardResult {
  const own = ownSession();
  if (own === undefined) return 'unguarded';
  assertNotHumanInSession(actor);
  const db = openDb();
  try {
    const outcome = db
      .transaction((): GuardResult | string[] => {
        const card = claimRowIn(db, cardId);
        const holder = liveHolderIn(db, card.claimed_by);
        if (holder !== own) {
          if (opts.request && holder !== null) return 'request';
          if (opts.request) throw new Error(`Card ${cardId} is free: claim it instead (agentboard card claim ${cardId})`);
          if (holder !== null) throw new Error(heldBy(cardId, holder));
          throw new Error(`Card ${cardId} is not yours. Claim it first: agentboard card claim ${cardId}`);
        }
        if (card.claim_seen_at === null) throw new Error(`Read the card first: agentboard card show ${cardId}`);
        const at = now();
        const news = newSinceIn(db, cardId, card.claim_seen_at, own);
        // The mark moves before the refusal so it commits with this transaction.
        if (news.length) db.prepare('UPDATE card SET claim_seen_at = ? WHERE id = ?').run(at, cardId);
        return news.length ? news : 'holder';
      })
      .immediate();
    if (Array.isArray(outcome)) {
      throw new Error(
        `Card ${cardId} changed since you read it. Take this into account, then retry:\n` +
          outcome.map((t) => `- ${t}`).join('\n')
      );
    }
    return outcome;
  } finally {
    db.close();
  }
}
```

Then append:

```ts
// `card claim`: one immediate transaction, never waits. The read mark is the
// claim moment, so the caller prints the card right after and has seen it all.
export function claimCard(cardId: string): void {
  const own = ownSession();
  if (own === undefined) throw new Error('card claim only works inside a runner session (AGENTBOARD_SESSION_ID)');
  const db = openDb();
  try {
    db.transaction(() => {
      const at = now();
      const card = claimRowIn(db, cardId);
      if (card.status === 'done' || card.status === 'archived') throw new Error(`Card ${cardId} is ${card.status}; nothing to claim`);
      const holder = liveHolderIn(db, card.claimed_by);
      if (holder !== null && holder !== own) throw new Error(heldBy(cardId, holder));
      db.prepare('UPDATE card SET claimed_by = ?, claim_seen_at = ? WHERE id = ?').run(own, at, cardId);
      if (holder !== own) addEventIn(db, cardId, 'action_taken', 'agent', { note: `Claimed by session ${own}`, session: own });
    }).immediate();
  } finally {
    db.close();
  }
}

// `card show` by the holder: `at` is taken before the read, so anything
// landing during the read still counts as new.
export function markSeen(cardId: string, at: string): void {
  const own = ownSession();
  if (own === undefined) return;
  const db = openDb();
  try {
    db.prepare('UPDATE card SET claim_seen_at = ? WHERE id = ? AND claimed_by = ?').run(at, cardId, own);
  } finally {
    db.close();
  }
}

// "Request from [task_y](origin/#/card/task_y) (session N):" -- the card is
// the requesting session's assigned card; without one, just the session.
export function requestPrefixIn(db: Database.Database, own: number): string {
  const row = db.prepare('SELECT card_id FROM session WHERE id = ?').get(own) as { card_id: string | null } | undefined;
  const origin = (process.env.AGENTBOARD_ORIGIN ?? '').trim().replace(/\/$/, '');
  return row?.card_id
    ? `Request from [${row.card_id}](${origin}/#/card/${row.card_id}) (session ${own}):\n\n`
    : `Request from session ${own}:\n\n`;
}
```

Extend the claims.ts imports to `import type Database from 'better-sqlite3';` and `import { addEventIn, now, openDb } from './db.js';`.

- [ ] **Step 3: Wire the guard into cards.ts**

Add to the imports of `src/core/cards.ts`:
`import { assertNotHumanInSession, guardAgentWrite, ownSession, requestPrefixIn } from './claims.js';`

`moveCard`: after the `actor === 'agent' && status === 'done'` check add `guardAgentWrite(id, actor);`. Inside the transaction, directly after `addEventIn(db, id, 'status_changed', ...)`, add:

```ts
      // A human status change takes the card back: whichever session held it
      // gets "not yours" on its next write (spec section 6).
      if (actor === 'human') db.prepare('UPDATE card SET claimed_by = NULL, claim_seen_at = NULL WHERE id = ?').run(id);
```

`addComment`: change the signature and body to:

```ts
export function addComment(id: string, body: string, author: string, opts: { request?: boolean } = {}): Comment {
  const a = assertActor(author);
  if (!body.trim()) throw new Error('Comment cannot be empty');
  const guard = guardAgentWrite(id, a, opts);
  const db = openDb();
  try {
    getCardIn(db, id);
    const own = ownSession();
    const text = guard === 'request' && own !== undefined ? requestPrefixIn(db, own) + body : body;
    const result = db
      .prepare('INSERT INTO comment (card_id, author, body, created_at, session_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, a, text, now(), own ?? null);
    return db.prepare('SELECT * FROM comment WHERE id = ?').get(result.lastInsertRowid) as Comment;
  } finally {
    db.close();
  }
}
```

`editComment`: after the author check (`Only the author ...`), add `guardAgentWrite(comment.card_id, a);`.

`editCard`: after the `Nothing to edit` check, add:

```ts
  guardAgentWrite(id, a);
  // Title/body edits stay silent in the timeline; this column lets a holder's
  // freshness check see them (spec section 1).
  if (a === 'human') {
    sets.push('human_edited_at = ?');
    values.push(now());
  }
```

`removeBlocker`: after `const a = assertActor(actor);` add `guardAgentWrite(id, a);`.

`logEvent`: after `const a = assertActor(actor);` add `guardAgentWrite(id, a);`.

`createCard`: after `const actor = assertActor(input.actor ?? 'human');` add:

```ts
  assertNotHumanInSession(actor);
  if (input.blocks) guardAgentWrite(input.blocks, actor);
  const own = actor === 'agent' ? ownSession() : undefined;
```

and inside the `create` transaction, directly after the `INSERT INTO card` statement:

```ts
      // A session owns what it creates: its ops card or routine card can take
      // a comment right away (spec section 4).
      if (own !== undefined) db.prepare('UPDATE card SET claimed_by = ?, claim_seen_at = ? WHERE id = ?').run(own, ts, id);
```

- [ ] **Step 4: Guard `writeContext`**

In `src/core/context.ts`, import `guardAgentWrite` from `'./claims.js'` and add `guardAgentWrite(opts.cardId, actor);` directly after `const actor = assertActor(opts.actor);`.

- [ ] **Step 5: CLI: show marks seen, `card claim`, `--request`**

In `src/cli/index.ts`: import `claimCard`, `markSeen` from `'../core/claims.js'` and `now` from `'../core/db.js'` (extend the existing `initData` import).

Turn the `card show` action body into a named helper above the command and use it twice:

```ts
// Shared by `card show` and `card claim`: the claim prints the card it just
// took, so the agent starts from the current state, not an older read.
function printCard(opts: OutputOpts, id: string): void {
  const detail = cardDetail(id);
  const c = detail.card;
  const lines = [`${c.id}  ${c.title}`, `board: ${c.board_id}  type: ${c.type}  status: ${c.status}  owner: ${c.owner}`];
  if (c.labels.length) lines.push(`labels: ${c.labels.join(', ')}`);
  if (c.refs.length) lines.push(`refs: ${JSON.stringify(c.refs)}`);
  if (c.context_refs.length) lines.push(`context: ${c.context_refs.join(', ')}`);
  if (detail.blockers.length) lines.push(`blocked by: ${detail.blockers.map((b) => `${b.id} (${b.status})`).join(', ')}`);
  if (detail.blocks.length) lines.push(`unblocks: ${detail.blocks.map((b) => `${b.id} (${b.status})`).join(', ')}`);
  lines.push(`created: ${c.created_at}  updated: ${c.updated_at}`);
  if (c.body) lines.push('', c.body);
  const timeline = renderTimeline(detail.comments, detail.events);
  if (timeline.length) lines.push('', ...timeline);
  output(opts, lines.join('\n'), detail);
}
```

`card show` action becomes:

```ts
    run((opts, id: string) => {
      const at = now();
      printCard(opts, id);
      markSeen(id, at);
    })
```

New command after `card show`:

```ts
card
  .command('claim <id>')
  .description('inside a session: hold one more card (fails at once if another live session holds it), then print it')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string) => {
      claimCard(id);
      printCard(opts, id);
    })
  );
```

`card comment`: add `.option('--request', "ask the session holding this card; the only write allowed on another session's card")` and call `addComment(id, body, opts.as, { request: opts.request === true })`.

- [ ] **Step 6: Build and run the probe**

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: `OK: hard claims verified`. Also re-run `bash docs/superpowers/plans/verify-blockers.sh` (its agent writes run outside a session and must still pass).

- [ ] **Step 7: Commit**

```bash
git add src/core/claims.ts src/core/cards.ts src/core/context.ts src/cli/index.ts docs/superpowers/plans/verify-claims.sh
git commit -m "feat(claims): guard agent writes on held, unread and changed cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The runner assigns cards

**Files:**
- Modify: `src/core/cards.ts` (`gateWork`, `nextWork`, new `pickAndClaimIn`; delete `doingClaimsIn`, `claimingSessions`, `adoptOrphanedDoing`)
- Modify: `src/core/runner.ts` (`runSession`, `buildPrompt`, `beginSession`, `pokeRunner`, timeout; delete `runnersAhead`, `otherLiveSessions`)
- Modify: `src/api/server.ts:131-139` (`maybeAutorun` uses `pokeRunner`)
- Modify: `src/cli/index.ts` (`next`, `gate`)
- Modify: `docs/superpowers/plans/verify-claims.sh` (legs 1, 2, 2b, 7, 8, 11b)

**Interfaces:**
- Consumes: `startSessionRecordIn` (Task 2), `liveSessionIdsIn`, `releaseSessionClaims`, `ownSession` (Tasks 1-3).
- Produces: `cards.ts`: `gateWorkIn(db, live: ReadonlySet<number>): Card[]`, `gateWork(live?: ReadonlySet<number>): Card[]`, `nextWork(live?: ReadonlySet<number>, own?: number): Card[]`, `pickAndClaimIn(db, sessionId: number, live: ReadonlySet<number>, resumeLimit: number): Card | null`.
- Produces: `runner.ts`: `buildPrompt(due: DueRoutine[], cardId: string | null): string`, `pokeRunner(trigger: string): void`.

- [ ] **Step 1: Write legs 1, 2, 2b, 7, 8 and 11b (failing)**

Insert before the final `echo` of `verify-claims.sh`:

```bash
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
$CLI_ABS next >> "\$FAKE_OUT"
$CLI_ABS gate >> "\$FAKE_OUT"
EOF
chmod +x "$SCR/look.sh"; : > "$FAKE_OUT"
AGENTBOARD_SESSION_CMD="$SCR/look.sh" $CLI runner >/dev/null
SID1=$(q "SELECT id FROM session ORDER BY id DESC LIMIT 1;")
grep -q "PROMPT:.*Your card this session: $A" "$FAKE_OUT" || fail "prompt does not name the assigned card"
grep -q "STATUS:doing:$SID1" "$FAKE_OUT" || fail "card not doing+claimed when the session started"
grep -q "^  $A " "$FAKE_OUT" || fail "next in the session misses its own card"
[ "$(grep -c "^  $B " "$FAKE_OUT")" = 1 ] || fail "next in the session lists a card it does not hold (or gate lost the free card)"
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

# ============================================================================
# Leg 11b: the doing card from the v0.23.0 database is resumed (Task 4)
# ============================================================================
export AGENTBOARD_DATA="$MIGDATA"
AGENTBOARD_SESSION_CMD="$SCR/slow.sh" $CLI runner >/dev/null
q "SELECT payload FROM event WHERE card_id = '$MIG' AND kind = 'status_changed' ORDER BY id DESC LIMIT 1;" | grep -q "Resumed" || fail "migrated doing card not resumed"
```

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: FAIL at leg 1 or 2 (two sessions start, or the prompt has no card).

- [ ] **Step 2: Gate, next and pick in cards.ts**

In `src/core/cards.ts` delete `doingClaimsIn`, `claimingSessions` and `adoptOrphanedDoing`. Import `liveHolderIn` from `'./claims.js'` is not needed here; the live set is passed in. Replace `nextWork` and `gateWork` with:

```ts
const heldByLive = (c: Card, live: ReadonlySet<number>) => c.claimed_by !== null && live.has(c.claimed_by);

// Worklist for an agent. Inside a session it is exactly the cards that
// session holds (the runner assigned one; `card claim` adds more). Outside
// one: ready, doing and needs_input, minus cards a live session holds and
// cards with an open blocker.
export function nextWork(live: ReadonlySet<number> = new Set(), own?: number): Card[] {
  const db = openDb();
  try {
    if (own !== undefined) {
      return db
        .prepare("SELECT * FROM card WHERE claimed_by = ? AND status NOT IN ('done','archived') ORDER BY updated_at ASC")
        .all(own)
        .map(rowToCard);
    }
    const cards = db
      .prepare(
        `SELECT * FROM card WHERE status = 'ready' OR status = 'needs_input' OR status = 'doing' ORDER BY updated_at ASC`
      )
      .all()
      .map(rowToCard)
      .filter((c) => !heldByLive(c, live));
    const blockerIds = [...new Set(cards.flatMap((c) => c.blocked_by))];
    if (blockerIds.length === 0) return cards;
    const open = new Set(
      blockerInfoIn(db, blockerIds)
        .filter((b) => isOpenStatus(b.status))
        .map((b) => b.id)
    );
    return cards.filter((c) => !c.blocked_by.some((b) => open.has(b)));
  } finally {
    db.close();
  }
}

// The scheduler's question (vision besluit C): ready without open blockers,
// doing (a stranded session's card, resumable), needs_input whose wait-check
// is due. A card a live session holds is being worked and never counts.
export function gateWorkIn(db: Database.Database, live: ReadonlySet<number>): Card[] {
  const cards = db
    .prepare(
      `SELECT * FROM card WHERE status = 'ready' OR status = 'needs_input' OR status = 'doing' ORDER BY updated_at ASC`
    )
    .all()
    .map(rowToCard)
    .filter((c) => !heldByLive(c, live));
  const blockerIds = [...new Set(cards.filter((c) => c.status === 'ready').flatMap((c) => c.blocked_by))];
  const open = new Set(
    blockerInfoIn(db, blockerIds)
      .filter((b) => isOpenStatus(b.status))
      .map((b) => b.id)
  );
  const waits = waitCheckIn(db, cards.filter((c) => c.status === 'needs_input').map((c) => c.id));
  const cutoff = now();
  return cards.filter((c) => {
    if (c.status === 'ready') return !c.blocked_by.some((b) => open.has(b));
    if (c.status === 'doing') return true;
    const check = waits.get(c.id);
    return check !== undefined && check <= cutoff;
  });
}

export function gateWork(live: ReadonlySet<number> = new Set()): Card[] {
  const db = openDb();
  try {
    return gateWorkIn(db, live);
  } finally {
    db.close();
  }
}

// The session stamp on the card's latest status change: who had it last.
function lastSessionIn(db: Database.Database, id: string): number | null {
  const row = db
    .prepare("SELECT payload FROM event WHERE card_id = ? AND kind = 'status_changed' ORDER BY id DESC LIMIT 1")
    .get(id) as { payload: string } | undefined;
  const s = row ? (JSON.parse(row.payload) as { session?: unknown }).session : undefined;
  return typeof s === 'number' ? s : null;
}

// Resumes since the human last acted on the card (an event or a comment):
// a human touch means "try again", so it resets the crash-loop count.
function resumesSinceHumanIn(db: Database.Database, id: string): { count: number; sessions: number[] } {
  const rows = db
    .prepare(
      `SELECT payload FROM event
       WHERE card_id = ? AND kind = 'status_changed' AND json_extract(payload, '$.reason') LIKE 'Resumed:%'
         AND created_at > COALESCE((SELECT MAX(t) FROM (
               SELECT MAX(created_at) AS t FROM event WHERE card_id = ? AND actor = 'human'
               UNION ALL SELECT MAX(created_at) FROM comment WHERE card_id = ? AND author = 'human')), '')
       ORDER BY id`
    )
    .all(id, id, id) as { payload: string }[];
  const sessions = rows
    .map((r) => (JSON.parse(r.payload) as { session?: unknown }).session)
    .filter((s): s is number => typeof s === 'number');
  return { count: rows.length, sessions };
}

// The runner's half of a claim (spec section 2), inside its immediate
// transaction: the first gate card wins, gets status doing and this session
// as holder, all before the session process starts. A doing card past the
// resume limit goes to the human instead of starting yet another session.
export function pickAndClaimIn(
  db: Database.Database,
  sessionId: number,
  live: ReadonlySet<number>,
  resumeLimit: number
): Card | null {
  for (const card of gateWorkIn(db, live)) {
    let reason: string;
    if (card.status === 'doing') {
      const loop = resumesSinceHumanIn(db, card.id);
      const prev = lastSessionIn(db, card.id);
      if (loop.count >= resumeLimit) {
        const stranded = [...new Set([...loop.sessions, ...(prev !== null ? [prev] : [])])].sort((a, b) => a - b);
        db.prepare("UPDATE card SET status = 'needs_input', claimed_by = NULL, claim_seen_at = NULL, updated_at = ? WHERE id = ?").run(now(), card.id);
        addEventIn(db, card.id, 'status_changed', 'agent', {
          from: 'doing',
          to: 'needs_input',
          reason: 'Stopped resuming after repeated failed sessions',
        });
        addEventIn(db, card.id, 'error', 'agent', {
          note: `Stopped resuming: sessions ${stranded.join(', ')} ended without finishing this card`,
        });
        continue;
      }
      reason = prev !== null ? `Resumed: session ${prev} ended without finishing` : 'Resumed: unclaimed doing card';
    } else {
      reason = card.status === 'ready' ? `Assigned to session ${sessionId}` : `Check due, assigned to session ${sessionId}`;
    }
    db.prepare("UPDATE card SET status = 'doing', claimed_by = ?, claim_seen_at = NULL, updated_at = ? WHERE id = ?").run(
      sessionId,
      now(),
      card.id
    );
    addEventIn(db, card.id, 'status_changed', 'agent', { from: card.status, to: 'doing', reason, session: sessionId });
    return getCardIn(db, card.id);
  }
  return null;
}
```

- [ ] **Step 3: Runner: begin, prompt, timeout, release, chain**

In `src/core/runner.ts`:

1. Imports: replace the cards.js import with `import { Card, gateWork, pickAndClaimIn } from './cards.js';`, add `import { spawn, spawnSync } from 'node:child_process';` (extend the existing import), `import { releaseSessionClaims } from './claims.js';`, and `startSessionRecordIn` to the sessions.js import (drop `startSessionRecord` if unused).
2. Delete `runnersAhead` and `otherLiveSessions`.
3. Add below `markLockSession`:

```ts
const resumeLimit = () => Math.max(1, Number(process.env.AGENTBOARD_RESUME_LIMIT ?? 2));
const sessionTimeoutMs = () => Number(process.env.AGENTBOARD_SESSION_TIMEOUT_MIN ?? 45) * 60_000;

// One immediate transaction makes the session row, names it in this slot's
// lock and claims the first gate card, so a concurrent runner either sees
// all of it or none. The lock write happens inside the transaction on
// purpose: a runner that commits after us reads the lock as live. With no
// card and nothing else to do, the row is deleted again, while a crash-loop
// park made during the pick still commits.
function beginSession(
  slot: number,
  trigger: string,
  opts: { assign: boolean; allowEmpty: boolean }
): { rec: { id: number; jsonl: string; stderr: string }; card: Card | null } | null {
  const db = openDb();
  try {
    return db
      .transaction(() => {
        const live = new Set(liveSessionIdsIn(db));
        const rec = startSessionRecordIn(db, trigger);
        markLockSession(slot, rec.id);
        const card = opts.assign ? pickAndClaimIn(db, rec.id, live, resumeLimit()) : null;
        if (!card && !opts.allowEmpty) {
          db.prepare('DELETE FROM session WHERE id = ?').run(rec.id);
          return null;
        }
        if (card) db.prepare('UPDATE session SET card_id = ? WHERE id = ?').run(card.id, rec.id);
        return { rec, card };
      })
      .immediate();
  } finally {
    db.close();
  }
}

// Start the next runner the way the server's autorun does: detached, opt-in.
// A finished session uses it so a waiting card does not wait for the cron.
export function pokeRunner(trigger: string): void {
  if (process.env.AGENTBOARD_AUTORUN !== '1') return;
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
  const child = spawn(process.execPath, [cli, 'runner', '--trigger', trigger], { detached: true, stdio: 'ignore' });
  child.unref();
}
```

4. `buildPrompt(due, cardId)`: replace the final `'Then work the board: ...'` string with:

```ts
    (cardId
      ? `Your card this session: ${cardId}. Start with \`agentboard card show ${cardId}\`. Work only this card; ` +
        'touching another card needs `agentboard card claim <id>` first (AGENT.md rule 15). Handing the card ' +
        'back is your last step.'
      : 'You hold no card this session; touching a card needs `agentboard card claim <id>` first (AGENT.md rule 15).')
```

5. `runSession`: the dry-run branch becomes

```ts
  if (dryRun) {
    const cards = gateWork(new Set(liveSessionIds()));
    const due = dueRoutines();
    return {
      started: false,
      reason: anyLockHeld() ? 'dry-run (lock file present)' : 'dry-run',
      gate: { cards: cards.length, routines: due.routines.length },
      prompt: buildPrompt(due.routines, cards[0]?.id ?? null),
    };
  }
```

and the body after `console.error(\`runner: lock acquired (slot ${slot})\`);` becomes:

```ts
  let sessionId: number | undefined;
  try {
    const due = promptOverride ? { routines: [] as RoutineInfo[], errors: [] as RoutineError[] } : dueRoutines();
    const active = promptOverride ? [] : checkDueRoutines(due.routines, slot);
    for (const r of due.routines) markRoutineRun(r.path); // before the spawn: a crash may not retrigger every minute (every due routine, checked or not)
    console.error(`runner: marked ${due.routines.length} routines`);
    const begun = beginSession(slot, trigger, { assign: !promptOverride, allowEmpty: !!promptOverride || active.length > 0 });
    if (!begun) return { started: false, reason: 'gate empty' };
    const { rec, card } = begun;
    sessionId = rec.id;
    const sessionStart = now();
    console.error(`runner: session #${rec.id}${card ? ` (${card.id})` : ''} -> ${rec.jsonl}`);
    const parts = (process.env.AGENTBOARD_SESSION_CMD ?? 'claude -p --output-format stream-json --verbose').split(/\s+/);
    let status: number | null = null;
    let notified: { id: string; to: string }[] = [];
    try {
      const out = fs.openSync(rec.jsonl, 'w');
      const err = fs.openSync(rec.stderr, 'w');
      try {
        // stdout is the JSONL transcript; stderr goes to its own file so a
        // stray warning can never corrupt a transcript line. A session past
        // the time limit is stopped and counts as stranded (spec section 7).
        const result = spawnSync(parts[0], [...parts.slice(1), promptOverride ?? buildPrompt(active, card?.id ?? null)], {
          stdio: ['ignore', out, err],
          cwd: workDir(slot),
          env: sessionEnv(slot, rec.id),
          timeout: sessionTimeoutMs(),
          killSignal: 'SIGTERM',
        });
        status = result.status;
        if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
          console.error(`runner: session #${rec.id} timed out`);
        }
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      console.error(`runner: session exited ${status ?? 'null'}`);
      scanSessionCards(rec.id);
      notified = handbacksSince(sessionStart, rec.id);
      notify(notified);
      if (process.env.AGENTBOARD_NOTIFY_CMD && notified.length > 0) {
        console.error(`runner: notified: ${notified.length}`);
      }
      return { started: true, reason: `session exited ${status ?? 'null'}`, log: rec.jsonl, session: rec.id, notified };
    } finally {
      // ended_at is always set, crash or not; then the claims go, so the
      // gate can hand a stranded card to the next session.
      finishSessionRecord(rec.id, status, notified);
      releaseSessionClaims(rec.id);
    }
  } finally {
    releaseLock();
    if (sessionId !== undefined) pokeRunner('chain');
  }
```

(`workDir(slot)` and `sessionEnv(slot, rec.id)` stay as they are in this task; Task 5 replaces them.)

6. `src/api/server.ts`: replace the body of `maybeAutorun()` with `pokeRunner('serve');` and import `pokeRunner` from `'../core/runner.js'`. Drop the now-unused `spawn`, `path`/`fileURLToPath` imports only if nothing else in server.ts uses them (it does use `fileURLToPath` for `webDir`; check before removing).

- [ ] **Step 4: CLI `next` and `gate`**

In `src/cli/index.ts`: import `ownSession` from `'../core/claims.js'`, drop `otherLiveSessions` from the runner import. `next` calls `nextWork(new Set(liveSessionIds()), ownSession())`; `gate` calls `gateWork(new Set(liveSessionIds()))`.

- [ ] **Step 5: Build, run the probes**

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: `OK: hard claims verified`.

- [ ] **Step 6: Commit**

```bash
git add src/core/cards.ts src/core/runner.ts src/api/server.ts src/cli/index.ts docs/superpowers/plans/verify-claims.sh
git commit -m "feat(runner): assign one card per session and claim it before the start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Workdir per card, TMPDIR per session, pruning

**Files:**
- Create: `src/core/workdirs.ts`
- Modify: `src/core/runner.ts` (`workDir`, `sessionEnv`, `runRoutineCheck`, `runSession`)
- Modify: `docs/superpowers/plans/verify-claims.sh` (leg 10)
- Modify: `docs/superpowers/plans/verify-trigger.sh` (leg 8b expectations)

**Interfaces:**
- Consumes: `liveSessionIdsIn` (Task 1), `session.card_id` (Task 2).
- Produces: `workdirs.ts`: `sessionWorkDir(cardId: string | null, sessionId: number): string`, `checkWorkDir(): string`, `sessionTmpDir(sessionId: number): string`, `removeTmpDir(sessionId: number): void`, `pruneWorkdirs(log?: (m: string) => void): void`.

- [ ] **Step 1: Write leg 10 (failing)**

Insert before the final `echo` of `verify-claims.sh`:

```bash
# ============================================================================
# Leg 10: workdir per card, TMPDIR per session, pruning that never drops
# unpushed work (Task 5)
# ============================================================================
fresh_data
cat > "$SCR/where.sh" << 'EOF'
#!/usr/bin/env bash
echo "WORK:$AGENTBOARD_WORK" >> "$FAKE_OUT"
echo "PWD:$(pwd -P)" >> "$FAKE_OUT"
echo "TMP:$TMPDIR" >> "$FAKE_OUT"
touch "$TMPDIR/scratch"
EOF
chmod +x "$SCR/where.sh"; : > "$FAKE_OUT"
W=$(new_ready "where")
AGENTBOARD_SESSION_CMD="$SCR/where.sh" $CLI runner >/dev/null
WS=$(q "SELECT id FROM session ORDER BY id DESC LIMIT 1;")
grep -qx "WORK:$AGENTBOARD_DATA/work/cards/$W" "$FAKE_OUT" || fail "AGENTBOARD_WORK is not the card's workdir"
grep -qx "PWD:$(cd "$AGENTBOARD_DATA/work/cards/$W" && pwd -P)" "$FAKE_OUT" || fail "session cwd is not the card's workdir"
grep -qx "TMP:$AGENTBOARD_DATA/tmp/session-$WS" "$FAKE_OUT" || fail "TMPDIR is not per session"
[ ! -e "$AGENTBOARD_DATA/tmp/session-$WS" ] || fail "TMPDIR not removed after the session"

# prune: a done card's workdir goes, a done card with an unpushed commit stays
$CLI card move "$W" done --reason klaar >/dev/null
KEEP=$(new_ready "unpushed"); $CLI card move "$KEEP" done --reason klaar >/dev/null
mkdir -p "$AGENTBOARD_DATA/work/cards/$KEEP/repo"
(cd "$AGENTBOARD_DATA/work/cards/$KEEP/repo" && git init -q && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m wip)
NEXT=$(new_ready "trigger prune")
AGENTBOARD_SESSION_CMD="$SCR/where.sh" $CLI runner >/dev/null 2>"$SCR/err.log"
[ ! -e "$AGENTBOARD_DATA/work/cards/$W" ] || fail "done card's workdir not pruned"
[ -d "$AGENTBOARD_DATA/work/cards/$KEEP/repo" ] || fail "workdir with unpushed work was pruned"
grep -q "workdir kept: .*$KEEP" "$SCR/err.log" || fail "kept workdir not logged"
```

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh`
Expected: FAIL at leg 10 (`AGENTBOARD_WORK is not the card's workdir`).

- [ ] **Step 2: Create `src/core/workdirs.ts`**

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, openDb } from './db.js';
import { liveSessionIdsIn } from './slots.js';

// Workdirs per card (spec section 9): a card resumed in another slot finds
// its own checkout, and no session switches branches under another card's
// uncommitted work. Sessions without a card get a per-session directory.
const base = () => process.env.AGENTBOARD_WORK ?? path.join(dataDir(), 'work');

function ensure(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionWorkDir(cardId: string | null, sessionId: number): string {
  return ensure(cardId ? path.join(base(), 'cards', cardId) : path.join(base(), 'sessions', String(sessionId)));
}

// Routine checks are short read-only shell lines that run before any session
// exists; they share one neutral directory.
export function checkWorkDir(): string {
  return ensure(path.join(base(), 'checks'));
}

export function sessionTmpDir(sessionId: number): string {
  return ensure(path.join(dataDir(), 'tmp', `session-${sessionId}`));
}

export function removeTmpDir(sessionId: number): void {
  fs.rmSync(path.join(dataDir(), 'tmp', `session-${sessionId}`), { recursive: true, force: true });
}

// Rule-12 layout puts repos at <board>/<client>/<resource>/, so four levels
// deep covers every checkout the agent makes.
function gitRepos(dir: string, depth = 4): string[] {
  if (fs.existsSync(path.join(dir, '.git'))) return [dir];
  if (depth === 0) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .flatMap((e) => gitRepos(path.join(dir, e.name), depth - 1));
}

// Uncommitted changes, or commits on any local branch that no remote has.
// A repo git cannot read counts as unpushed: keeping too much is cheap,
// deleting the only copy is not.
function hasUnpushedWork(repo: string): boolean {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return git('status', '--porcelain') !== '' || git('log', '--branches', '--not', '--remotes', '--oneline') !== '';
  } catch {
    return true;
  }
}

// After every session: workdirs of done/archived cards nobody holds, and of
// sessions that have ended. The volume is small (2.9 GB on Fly) and a clone
// per card grows faster than a clone per slot.
export function pruneWorkdirs(log: (m: string) => void = (m) => console.error(m)): void {
  const candidates: string[] = [];
  const db = openDb();
  try {
    const live = new Set(liveSessionIdsIn(db));
    const cardsDir = path.join(base(), 'cards');
    if (fs.existsSync(cardsDir)) {
      for (const id of fs.readdirSync(cardsDir)) {
        const row = db.prepare('SELECT status, claimed_by FROM card WHERE id = ?').get(id) as
          | { status: string; claimed_by: number | null }
          | undefined;
        const held = row?.claimed_by != null && live.has(row.claimed_by);
        if (row && (row.status === 'done' || row.status === 'archived') && !held) candidates.push(path.join(cardsDir, id));
      }
    }
    const sessionsDir = path.join(base(), 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const n of fs.readdirSync(sessionsDir)) {
        const row = db.prepare('SELECT ended_at FROM session WHERE id = ?').get(Number(n)) as { ended_at: string | null } | undefined;
        if (row?.ended_at) candidates.push(path.join(sessionsDir, n));
      }
    }
  } finally {
    db.close();
  }
  for (const dir of candidates) {
    if (gitRepos(dir).some(hasUnpushedWork)) {
      log(`runner: workdir kept: ${dir}, unpushed work`);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Use it in runner.ts**

In `src/core/runner.ts`:

1. Import `{ checkWorkDir, pruneWorkdirs, removeTmpDir, sessionTmpDir, sessionWorkDir } from './workdirs.js'`.
2. Delete `workDir(slot)`.
3. Replace `sessionEnv` with:

```ts
// The session gets the environment minus the secrets only the server needs
// (it can replace this machine / sign cookies). AGENT.md rule 12 derives
// repo paths from $AGENTBOARD_WORK, so it points at this card's workdir;
// TMPDIR is per session so two sessions never share scratch files.
function sessionEnv(work?: string, tmp?: string, sessionId?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBOARD_ACTOR: 'agent' };
  for (const key of SESSION_ENV_STRIP) delete env[key];
  if (work !== undefined) env.AGENTBOARD_WORK = work;
  if (tmp !== undefined) Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  if (sessionId !== undefined) env.AGENTBOARD_SESSION_ID = String(sessionId);
  return env;
}
```

4. `runRoutineCheck(check)`: drop the `slot` parameter; use `cwd: checkWorkDir(), env: sessionEnv()`. Drop `slot` from `checkDueRoutines(due)` and its call in `runSession`.
5. In `runSession`, after `sessionId = rec.id;` add:

```ts
    const work = sessionWorkDir(card?.id ?? null, rec.id);
    const tmp = sessionTmpDir(rec.id);
```

pass `cwd: work, env: sessionEnv(work, tmp, rec.id)` to `spawnSync`, and in the inner `finally` after `releaseSessionClaims(rec.id);` add `removeTmpDir(rec.id);`. In the outer `finally`, before `releaseLock();`, add `if (sessionId !== undefined) pruneWorkdirs();`.

- [ ] **Step 4: Update verify-trigger.sh leg 8b**

The neutral-cwd leg now expects the card's workdir. In `docs/superpowers/plans/verify-trigger.sh` replace

```bash
EXPECTED="$(cd "$AGENTBOARD_DATA/work" && pwd -P)"
```

with

```bash
EXPECTED="$(cd "$AGENTBOARD_DATA/work/cards/$STRAND" && pwd -P)"
```

and

```bash
EXPECTED="$(cd "$SCRATCH3/custom" && pwd -P)"
```

with

```bash
EXPECTED="$(cd "$SCRATCH3/custom/cards/$STRAND" && pwd -P)"
```

Update the leg comment to "default <data>/work/cards/<card>, override via AGENTBOARD_WORK".

- [ ] **Step 5: Build, run both probes**

Run: `npm run build && bash docs/superpowers/plans/verify-claims.sh && bash docs/superpowers/plans/verify-trigger.sh`
Expected: both `OK:` lines. If verify-trigger leg 6 fails, that is Task 6's fix; finish Task 6 Step 1 before judging this task.

- [ ] **Step 6: Commit**

```bash
git add src/core/workdirs.ts src/core/runner.ts docs/superpowers/plans/verify-claims.sh docs/superpowers/plans/verify-trigger.sh
git commit -m "feat(runner): workdir per card, TMPDIR per session, safe pruning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: AGENT.md, reference docs, old probes, PR

**Files:**
- Modify: `AGENT.md` (rules 6, 12, 15; new rule 17)
- Modify: `docs/reference.md` (workdir paragraph, runner paragraph, CLI flags, sessions commands)
- Modify: `docs/superpowers/plans/verify-trigger.sh` (leg 6 fake sessions)

**Interfaces:**
- Consumes: everything above. Produces: none.

- [ ] **Step 1: Fix verify-trigger leg 6**

The fake sessions in leg 6 claim with `--from ready`, but the runner already moved the card to doing and the guard wants a read first. In each of `hand1.sh`, `hand2.sh`, `hand3.sh` replace the single line

```bash
$CLI_ABS card move $NOTE1 review --from ready --as agent --reason done >> "\$FAKE_OUT" 2>&1
```

(with `NOTE2` / `NOTE3` respectively) by

```bash
$CLI_ABS card show $NOTE1 >/dev/null
$CLI_ABS card move $NOTE1 review --from doing --as agent --reason done >> "\$FAKE_OUT" 2>&1
```

Run: `npm run build && bash docs/superpowers/plans/verify-trigger.sh`
Expected: `OK: trigger/scheduler verified ...`.

- [ ] **Step 2: AGENT.md**

Rule 6, append after "...to reconstruct it later.":

```
   An external action (an issue, a PR, a Trello comment, a deploy) is
   logged as an intention first, then done, then logged with its result;
   when you resume a card, check whether it already exists before doing
   it again.
```

Rule 12, append after "...timeline event naming the branch and commit — waiting for review is too late.":

```
    `$AGENTBOARD_WORK` is per card: a resumed card may land on a fresh
    directory, so never assume an earlier clone is there.
```

Rule 15: replace from "Claim every card with `card move <id> doing --from ready --as agent --reason \"Claiming\"`; if that fails, another session got there first — take the next card." up to the end of that sentence with:

```
    The runner assigns your card and moves it to doing before you start;
    begin with `card show`. You never claim with `card move ... doing`.
    To touch another card, run `card claim <id>` first; if it fails,
    another session holds it and you write nothing on it: ask with
    `card comment <id> --request "..."`, put a wait-state on your own
    card, or hand the question to the human via needs_input. A refusal
    that lists what changed since you read the card means: take it in,
    then retry. Handing your card back is your last step.
```

New rule 17 after rule 16:

```
17. The workbench is shared with other sessions running at the same
    time. Temporary files go in `$TMPDIR` only; a test server listens on
    a free random port, never a fixed one.
```

Check: `grep -n "Claiming" AGENT.md` returns nothing; `grep -c "card claim" AGENT.md` is at least 1.

- [ ] **Step 3: docs/reference.md**

- Workdir paragraph (line ~135): change "(`AGENTBOARD_WORK`, default `<data>/work`)" to "(`AGENTBOARD_WORK`, default `<data>/work`; one directory per card under `cards/<id>/`, per card-less session under `sessions/<nr>/`, pruned after the card is done or archived unless it holds unpushed work)".
- Runner paragraph (line ~245): replace "Sessions run in a neutral working directory (`AGENTBOARD_WORK`, default `<data>/work`)" with "The runner assigns one card per session: in one transaction it creates the session row, claims the oldest gate card (status doing, `claimed_by` = the session) and only then starts the process, in that card's working directory". Append: "`AGENTBOARD_SESSION_TIMEOUT_MIN` (default 45) stops a session that runs too long; `AGENTBOARD_RESUME_LIMIT` (default 2) hands a card to the human after that many resumes without a human action in between. With `AGENTBOARD_AUTORUN=1` a finished session starts the next runner at once."
- CLI flags list: replace the `card move --from <status>` bullet with:

```
- `card move --from <status>`: moves the card only if it is still in
  that status. Inside a session the runner already claimed the card;
  agents use `--from doing` when handing back.
- `card claim <id>`: inside a session: hold one more card, or fail at
  once if another live session holds it; prints the card.
- `card comment --request`: the one write allowed on a card another
  session holds; prefixed with the requesting card and session.
```

- Sessions commands paragraph (line ~329): add "`sessions recover` (boot only: closes rows a restart left open and clears their claims)".

- [ ] **Step 4: Run every probe**

Run: `npm run build && for s in claims trigger sessions realtime agentlog blockers session-env routines; do bash docs/superpowers/plans/verify-$s.sh || echo "FAIL $s"; done`
Expected: every script prints its `OK:` line, no FAIL. A failure in a script that also failed in Task 1 Step 1 is pre-existing; mention it in the PR, do not fix it here.

- [ ] **Step 5: Commit and open the PR**

```bash
git add AGENT.md docs/reference.md docs/superpowers/plans/verify-trigger.sh
git commit -m "docs(agent): the runner assigns cards; claim, request and workbench rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/hard-claims
gh pr create --title "feat(runner): hard claims, the runner assigns one card per session" --body "$(cat <<'EOF'
Two sessions worked the same cards on 2026-10-15 (sessions 337 and 338 on task_94f4 and task_5ae3): claiming was only a rule in AGENT.md, and a claim checked the status, not whether the card had changed since the agent read it.

The runner now picks and claims a card in the same transaction that creates the session, and the core refuses agent writes on cards the session does not hold, has not read, or that changed since its last read. Spec: docs/superpowers/specs/2026-10-15-hard-claims-design.md.

- `card.claimed_by` replaces the event-derived claim; a claim only counts while its session lives.
- `card claim` for extra cards, `card comment --request` for a card another session holds.
- Session timeout (45 min) and crash-loop stop (2 resumes) are configurable.
- Workdir per card, TMPDIR per session, pruning that keeps unpushed work.
- `sessions recover` at boot.

Verified with docs/superpowers/plans/verify-claims.sh (race, assignment, write rules, freshness, revocation, crash loop, timeout, recover, workdirs, migration from v0.23.0) plus the existing probes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the PR URL. CI (build, pr-title) green.

- [ ] **Step 6: After merge (needs the user, not part of the PR)**

Deploy only the published release image (`fly deploy -a agentboard-app --image ghcr.io/robbertvermeulen/agentboard:<version>`), run by the user. Then: put one card on ready and check it is doing within a few seconds; follow `fly logs` for a few days. Create the out-of-scope cards on the agentboard board: local sessions without a session id, drain mode for updates, measuring memory and cost of 3 parallel sessions.
