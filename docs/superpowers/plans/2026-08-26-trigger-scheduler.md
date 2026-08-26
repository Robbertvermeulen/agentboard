# Trigger/Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unattended operation: `agentboard gate` (the narrow scheduler question), structured wait-checks (`card log --check-after`), a single-flight `agentboard runner` (lock → gate → mark → headless session → notify), the serve-hook behind `AGENTBOARD_AUTORUN=1`, the minimal waiting-UI split, and two hardenings from the block-2 parked list.

**Architecture:** Gate + wait-check enrichment live in `src/core/cards.ts` (they are card queries); the runner is a new `src/core/runner.ts` (lock file, prompt builder, session spawn, notify hook) + a thin CLI command. The clock stays outside the tool (cron/launchd docs). Everything is testable without real claude sessions via `AGENTBOARD_SESSION_CMD`.

**Tech Stack:** TypeScript, better-sqlite3, node:child_process, commander, Hono, vanilla-JS web UI.

**Spec:** `docs/superpowers/specs/2026-08-26-trigger-scheduler-design.md` (kader: `docs/superpowers/specs/2026-08-24-agentboard-vision.md`, besluiten C/H/Concurrency).

## Global Constraints

- **No test framework.** `npm run build` + CLI probes against `export AGENTBOARD_DATA=$(mktemp -d)/abdata` (never `~/.agentboard`). "id -> X" = capture real ids from `--json` and substitute.
- **Never start a real claude session in verification.** Every runner probe sets `AGENTBOARD_SESSION_CMD` to a fake script. The serve-hook fires only when `AGENTBOARD_AUTORUN=1`.
- Gate semantics (spec §1, exact): `ready` without open blockers + `doing`@agent + `needs_input` with expired wait-check (latest `check_after` ≤ now) + due routines. Bare `needs_input` never counts. `next` stays unchanged.
- Lock semantics (spec §3): `<data>/session.lock` JSON `{pid, hostname, started_at}`; stale = dead pid OR older than `AGENTBOARD_LOCK_MAX_AGE` minutes (default 120); foreign hostname = hard error (one-machine assumption); release in try/finally.
- Comments English, surgical, core throws `Error`, CLI/API logic-free. Git: NEW commits only — never amend.

---

### Task 1: Wait-checks + gate (core + CLI)

**Files:**
- Modify: `src/core/cards.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: existing `blockerInfoIn`, `isOpenStatus`, `rowToCard`, `logEvent`.
- Produces:
  - `logEvent(id, kind, actor, note, checkAfter?: string)` — payload gains `check_after` when given
  - `EnrichedCard.wait_check: string | null` (latest `check_after` from the card's events; computed for needs_input cards, null otherwise)
  - `gateWork(): Card[]` — the card side of the gate
  - CLI: `card log ... --check-after <30m|6h|2d|ISO>`, new `agentboard gate [--json]`

- [ ] **Step 1: logEvent gains checkAfter**

In `src/core/cards.ts`, change the `logEvent` signature and payload:

```ts
export function logEvent(id: string, kind: string, actor: string, note: string, checkAfter?: string): BoardEvent {
```

and the `addEventIn` call becomes:

```ts
    addEventIn(db, id, kind, a, checkAfter ? { note, check_after: checkAfter } : { note });
```

- [ ] **Step 2: waitCheckIn helper + enrichment**

Add near `blockerInfoIn`:

```ts
// Latest check_after per card (vision besluit H): a needs_input card with a
// live wait-check is "waiting on external" — not the user's turn, and only
// the scheduler brings it back once the check time passes.
function waitCheckIn(db: Database.Database, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT card_id, payload FROM event WHERE card_id IN (${placeholders}) AND kind = 'action_taken' ORDER BY id`)
    .all(ids) as { card_id: string; payload: string }[];
  const latest = new Map<string, string>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    if (typeof p.check_after === 'string') latest.set(r.card_id, p.check_after);
  }
  return latest;
}
```

`EnrichedCard` gains `wait_check: string | null`. In `enrichCardsIn`, next to the blocker lookup:

```ts
  const waits = waitCheckIn(db, cards.filter((c) => c.status === 'needs_input').map((c) => c.id));
```

and per returned card:

```ts
      wait_check: waits.get(card.id) ?? null,
```

- [ ] **Step 3: gateWork**

Add after `nextWork`:

```ts
// The scheduler's question (vision besluit C) — deliberately narrower than
// next: bare needs_input never counts (one unanswered question must not
// start a session every minute), and blocked ready cards wait for their
// blockers. doing@agent counting is the implicit crash recovery.
export function gateWork(): Card[] {
  const db = openDb();
  try {
    const cards = db
      .prepare(
        `SELECT * FROM card
         WHERE status = 'ready' OR status = 'needs_input'
            OR (status = 'doing' AND owner = 'agent')
         ORDER BY updated_at ASC`
      )
      .all()
      .map(rowToCard);
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
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: CLI — --check-after + gate command**

In `src/cli/index.ts`, add a helper near `splitList`:

```ts
// 30m/6h/2d shorthand or an ISO timestamp; stored as ISO in the event payload.
function parseCheckAfter(value: string): string {
  const m = value.match(/^(\d+)([mhd])$/);
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    return new Date(Date.now() + Number(m[1]) * unit).toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid --check-after '${value}'. Use 30m, 6h, 2d or an ISO timestamp`);
  }
  return d.toISOString();
}
```

`card log` gains:

```ts
  .option('--check-after <when>', 'wait-state: when the scheduler should bring this card back (30m/6h/2d or ISO)')
```

and its action passes `opts.checkAfter ? parseCheckAfter(opts.checkAfter) : undefined` as the fifth `logEvent` argument.

New top-level command (import `gateWork` and `dueRoutines`):

```ts
program
  .command('gate')
  .description('scheduler gate: ready w/o open blockers, doing@agent, needs_input with expired wait-check, due routines')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const cards = gateWork();
      const due = dueRoutines();
      const lines = cards.map((c) => `  ${c.id.padEnd(10)} ${c.board_id.padEnd(12)} ${c.status.padEnd(12)} ${c.title}`);
      lines.push(...due.routines.map((r) => `  routine    ${r.board.padEnd(12)} due          ${r.path}`));
      lines.push(...due.errors.map((e) => `  ! ${e.path}: ${e.error}`));
      output(opts, lines.length ? lines.join('\n') : 'Nothing to start a session for', {
        cards,
        routines: due.routines,
        errors: due.errors,
      });
    })
  );
```

- [ ] **Step 5: Build and verify the gate matrix**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
A=$(node dist/cli/index.js card new --type task --title "ready-vrij" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $A ready --reason t
B=$(node dist/cli/index.js card new --type task --title "ready-geblokt" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $B ready --reason t
node dist/cli/index.js card new --type ops --title "blocker" --blocks $B --as agent >/dev/null
C=$(node dist/cli/index.js card new --type task --title "kale needs_input" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $C needs_input --reason t
D=$(node dist/cli/index.js card new --type task --title "verlopen check" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $D needs_input --reason t
node dist/cli/index.js card log $D "check mail" --as agent --check-after 2020-01-01T00:00:00Z
E=$(node dist/cli/index.js card new --type task --title "toekomstige check" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $E needs_input --reason t
node dist/cli/index.js card log $E "check deploy" --as agent --check-after 2d
node dist/cli/index.js gate            # expect: A and D; NOT B (blocked), NOT C (bare), NOT E (future)
node dist/cli/index.js gate --json | python3 -c "
import json,sys
ids=[c['id'] for c in json.load(sys.stdin)['cards']]
assert '$A' in ids and '$D' in ids and '$B' not in ids and '$C' not in ids and '$E' not in ids, ids"
node dist/cli/index.js card show $E --json | grep '"check_after"'
node dist/cli/index.js next --json | python3 -c "
import json,sys
ids=[c['id'] for c in json.load(sys.stdin)['cards']]
assert '$C' in ids and '$E' in ids, ids"   # next is unchanged: needs_input still listed
node dist/cli/index.js card log $A bad --check-after niet-goed 2>&1   # must fail with the Invalid message
```

Expected: exactly as annotated; the last command exits 1.

- [ ] **Step 6: Commit**

```bash
git add src/core/cards.ts src/cli/index.ts
git commit -m "feat: structured wait-checks (--check-after) and the narrow scheduler gate"
```

---

### Task 2: Hardenings — path normalization + strict 5-field schedule

**Files:**
- Modify: `src/core/context.ts` (writeContext)
- Modify: `src/core/routines.ts` (assertRoutineFrontmatter)

**Interfaces:**
- Consumes: nothing new. Produces: `ctx write ./_global/x.md`-style bypasses refused; `@daily`/6-field schedules refused.

- [ ] **Step 1: Normalize relPath in writeContext**

At the top of `writeContext` in `src/core/context.ts`, before `validateContent`:

```ts
  // Normalize once so kind-placement rules (and event payloads) can't be
  // sidestepped with './' or 'board/../_global/' spellings.
  relPath = path.posix.normalize(relPath);
  if (relPath.startsWith('..') || path.posix.isAbsolute(relPath)) {
    throw new Error(`Invalid context path: ${relPath}`);
  }
```

(`resolveContextPath` keeps its own escape guard — defense in depth, unchanged.)

- [ ] **Step 2: 5-field guard in assertRoutineFrontmatter**

In `src/core/routines.ts`, inside `assertRoutineFrontmatter`, after the schedule-presence check and before `new Cron(...)`:

```ts
  if (data.schedule.trim().split(/\s+/).length !== 5) {
    throw new Error(`kind: routine requires a 5-field cron expression, got '${data.schedule}' (${relPath})`);
  }
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
OPS=$(node dist/cli/index.js card new --type ops --title r --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nx\n' "$OPS" | node dist/cli/index.js ctx write "./_global/rogue.md" --content - --card "$OPS" 2>&1   # refused: must live under a board dir
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nx\n' "$OPS" | node dist/cli/index.js ctx write "main/../_global/rogue.md" --content - --card "$OPS" 2>&1   # refused
printf -- '---\nkind: routine\nschedule: "@daily"\ncard: %s\n---\nx\n' "$OPS" | node dist/cli/index.js ctx write main/nick.md --content - --card "$OPS" 2>&1   # refused: 5-field
printf -- '---\nkind: routine\nschedule: "*/5 * * * * *"\ncard: %s\n---\nx\n' "$OPS" | node dist/cli/index.js ctx write main/six.md --content - --card "$OPS" 2>&1   # refused: 5-field
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nx\n' "$OPS" | node dist/cli/index.js ctx write main/ok.md --content - --card "$OPS"   # still works
docs/superpowers/plans/verify-routines.sh   # regression: still green
```

Expected: four refusals with the documented messages (exit 1), the valid write succeeds, the routines probe stays green.

- [ ] **Step 4: Commit**

```bash
git add src/core/context.ts src/core/routines.ts
git commit -m "fix(core): normalize context paths; enforce 5-field cron schedules"
```

---

### Task 3: The runner (lock, prompt, session, notify) + CLI

**Files:**
- Create: `src/core/runner.ts`
- Modify: `src/cli/index.ts` (new `runner` command)

**Interfaces:**
- Consumes: `gateWork` (Task 1), `dueRoutines`/`markRoutineRun`, `dataDir`/`now`/`openDb`.
- Produces: `runSession(dryRun?: boolean)` returning `{ started, reason, gate?, prompt?, log?, notified? }`; CLI `agentboard runner [--dry-run] [--json]`. Env contract: `AGENTBOARD_SESSION_CMD` (default `claude -p`), `AGENTBOARD_AGENT_MD` (default packaged AGENT.md), `AGENTBOARD_LOCK_MAX_AGE` (minutes, default 120), `AGENTBOARD_NOTIFY_CMD` (optional).

- [ ] **Step 1: Write src/core/runner.ts**

```ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, now, openDb } from './db.js';
import { gateWork } from './cards.js';
import { RoutineInfo, dueRoutines, markRoutineRun } from './routines.js';

const lockPath = () => path.join(dataDir(), 'session.lock');

interface SessionLock {
  pid: number;
  hostname: string;
  started_at: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Single-flight (vision Concurrency): one agent session per data dir. A lock
// is stale when its process is dead or it outlived the max-age safety net —
// a crash may never wedge the scheduler shut. A foreign hostname is a hard
// error: agentboard assumes ONE machine per data dir; synced SQLite plus
// PID locks across machines is silent corruption.
export function acquireLock(): 'acquired' | 'held' {
  const maxAgeMs = Number(process.env.AGENTBOARD_LOCK_MAX_AGE ?? 120) * 60_000;
  const file = lockPath();
  if (fs.existsSync(file)) {
    let lock: SessionLock | null = null;
    try {
      lock = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
    } catch {
      lock = null; // unreadable lock = stale
    }
    if (lock && lock.hostname !== os.hostname()) {
      throw new Error(
        `session.lock is owned by host '${lock.hostname}' (this is '${os.hostname()}') — one machine per data dir`
      );
    }
    const fresh = lock ? Date.now() - new Date(lock.started_at).getTime() < maxAgeMs : false;
    if (lock && fresh && processAlive(lock.pid)) return 'held';
    fs.rmSync(file, { force: true });
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: now() }), {
      flag: 'wx',
    });
  } catch {
    return 'held'; // lost the write race to a concurrent runner
  }
  return 'acquired';
}

export function releaseLock(): void {
  fs.rmSync(lockPath(), { force: true });
}

function agentMdPath(): string {
  return (
    process.env.AGENTBOARD_AGENT_MD ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../AGENT.md')
  );
}

export function buildPrompt(due: RoutineInfo[]): string {
  const routineBlock = due.length
    ? `Due routines this run — read each with \`agentboard ctx show <path>\` and act per rule 16:\n${due
        .map((r) => `- ${r.path}`)
        .join('\n')}\n\n`
    : '';
  return (
    `You are the agentboard agent. Read and follow every rule in ${agentMdPath()} before doing anything else.\n\n` +
    routineBlock +
    'Then work the board: run `agentboard next` and handle what it lists.'
  );
}

// Turn handovers to the human into one line for AGENTBOARD_NOTIFY_CMD:
// cards the agent moved to needs_input or review during this session and
// that still sit there (a later move onward un-notifies it).
function handbacksSince(since: string): { id: string; to: string }[] {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        `SELECT card_id, payload FROM event
         WHERE created_at >= ? AND kind = 'status_changed' AND actor = 'agent' ORDER BY id`
      )
      .all(since) as { card_id: string; payload: string }[];
    const latest = new Map<string, string>();
    for (const r of rows) {
      const to = (JSON.parse(r.payload) as { to?: string }).to ?? '';
      if (to === 'needs_input' || to === 'review') latest.set(r.card_id, to);
      else latest.delete(r.card_id);
    }
    return [...latest].map(([id, to]) => ({ id, to }));
  } finally {
    db.close();
  }
}

function notify(handbacks: { id: string; to: string }[]): void {
  const cmd = process.env.AGENTBOARD_NOTIFY_CMD;
  if (!cmd || handbacks.length === 0) return;
  const summary = `${handbacks.length} card${handbacks.length === 1 ? '' : 's'} wait on you: ${handbacks
    .map((h) => `${h.id} (${h.to})`)
    .join(', ')}`;
  const parts = cmd.split(/\s+/);
  try {
    spawnSync(parts[0], [...parts.slice(1), summary], { stdio: 'ignore', timeout: 30_000 });
  } catch (err) {
    console.error(`notify failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function runSession(dryRun = false): {
  started: boolean;
  reason: string;
  gate?: { cards: number; routines: number };
  prompt?: string;
  log?: string;
  notified?: { id: string; to: string }[];
} {
  if (dryRun) {
    const cards = gateWork();
    const due = dueRoutines();
    return {
      started: false,
      reason: fs.existsSync(lockPath()) ? 'dry-run (lock file present)' : 'dry-run',
      gate: { cards: cards.length, routines: due.routines.length },
      prompt: buildPrompt(due.routines),
    };
  }
  if (acquireLock() === 'held') return { started: false, reason: 'session already running' };
  try {
    const cards = gateWork();
    const due = dueRoutines();
    if (cards.length === 0 && due.routines.length === 0) {
      return { started: false, reason: 'gate empty' };
    }
    const sessionStart = now();
    for (const r of due.routines) markRoutineRun(r.path); // before the spawn: a crash may not retrigger every minute
    const sessionsDir = path.join(dataDir(), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const logFile = path.join(sessionsDir, `${sessionStart.replace(/[:.]/g, '-')}.log`);
    const parts = (process.env.AGENTBOARD_SESSION_CMD ?? 'claude -p').split(/\s+/);
    const out = fs.openSync(logFile, 'w');
    let status: number | null;
    try {
      status = spawnSync(parts[0], [...parts.slice(1), buildPrompt(due.routines)], {
        stdio: ['ignore', out, out],
      }).status;
    } finally {
      fs.closeSync(out);
    }
    const notified = handbacksSince(sessionStart);
    notify(notified);
    return { started: true, reason: `session exited ${status ?? 'null'}`, log: logFile, notified };
  } finally {
    releaseLock();
  }
}
```

- [ ] **Step 2: CLI command**

```ts
program
  .command('runner')
  .description('single-flight scheduler step: lock, gate, mark due routines, start a headless agent session')
  .option('--dry-run', 'print lock status, gate counts and the prompt without starting anything')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const result = runSession(opts.dryRun === true);
      const text = result.started
        ? `Session done (${result.reason}), log: ${result.log}${result.notified?.length ? `, handed back: ${result.notified.map((n) => n.id).join(', ')}` : ''}`
        : `No session: ${result.reason}${result.gate ? ` (gate: ${result.gate.cards} cards, ${result.gate.routines} routines)` : ''}`;
      output(opts, text, result);
    })
  );
```

(import `runSession` from `../core/runner.js`.)

- [ ] **Step 3: Build and verify with a fake session command**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
SCRATCH=$(mktemp -d)
export FAKE_OUT="$SCRATCH/calls.log"
cat > "$SCRATCH/fake.sh" << 'EOF'
#!/usr/bin/env bash
printf 'PROMPT-START\n%s\nPROMPT-END\n' "$1" >> "$FAKE_OUT"
EOF
chmod +x "$SCRATCH/fake.sh"
export AGENTBOARD_SESSION_CMD="$SCRATCH/fake.sh"

node dist/cli/index.js runner            # gate empty: "No session: gate empty"; no lock left
test ! -f "$AGENTBOARD_DATA/session.lock" && echo "lock clean"
A=$(node dist/cli/index.js card new --type task --title "werk" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $A ready --reason t
OPS=$(node dist/cli/index.js card new --type ops --title r --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
printf -- '---\nkind: routine\nschedule: "0 9 * * 1"\ncard: %s\n---\nWeekly.\n' "$OPS" | node dist/cli/index.js ctx write main/weekly.md --content - --card "$OPS" >/dev/null
node dist/cli/index.js routines list >/dev/null   # seed
sqlite3 "$AGENTBOARD_DATA/board.db" "UPDATE routine_run SET last_run_at = '2020-01-01T00:00:00.000Z'"
node dist/cli/index.js runner --dry-run  # shows gate 1 card, 1 routine + prompt, starts nothing
node dist/cli/index.js runner            # spawns fake once
grep -c PROMPT-START "$FAKE_OUT"         # 1
grep "main/weekly.md" "$FAKE_OUT"        # routine path in the prompt
grep "AGENT.md" "$FAKE_OUT"              # AGENT.md path in the prompt
node dist/cli/index.js routines due      # Nothing due (marked before spawn)
ls "$AGENTBOARD_DATA/sessions/" | head -1   # log file exists

# lock contention: slow fake + second runner
cat > "$SCRATCH/slow.sh" << 'EOF'
#!/usr/bin/env bash
sleep 3
EOF
chmod +x "$SCRATCH/slow.sh"
node dist/cli/index.js card move $A ready --reason again >/dev/null 2>&1 || node dist/cli/index.js card move $A doing --from ready --as agent --reason t >/dev/null 2>&1 || true
AGENTBOARD_SESSION_CMD="$SCRATCH/slow.sh" node dist/cli/index.js runner &
sleep 1
node dist/cli/index.js runner            # "No session: session already running"
wait
test ! -f "$AGENTBOARD_DATA/session.lock" && echo "lock released"

# stale lock: dead pid
echo '{"pid":999999,"hostname":"'$(hostname)'","started_at":"2020-01-01T00:00:00.000Z"}' > "$AGENTBOARD_DATA/session.lock"
node dist/cli/index.js runner            # cleans stale lock, then proceeds (gate may be empty: fine — reason shows)
# foreign hostname: hard error
echo '{"pid":1,"hostname":"other-machine","started_at":"2020-01-01T00:00:00.000Z"}' > "$AGENTBOARD_DATA/session.lock"
node dist/cli/index.js runner 2>&1       # Error: session.lock is owned by host 'other-machine' ...
rm "$AGENTBOARD_DATA/session.lock"

# notify: fake session hands a card back
cat > "$SCRATCH/hand.sh" << 'EOF'
#!/usr/bin/env bash
node dist/cli/index.js card move CARD review --as agent --reason done >> "$FAKE_OUT" 2>&1
EOF
# (substitute a real ready card id for CARD, chmod +x)
cat > "$SCRATCH/notify.sh" << 'EOF'
#!/usr/bin/env bash
echo "NOTIFY:$1" >> "$FAKE_OUT"
EOF
chmod +x "$SCRATCH/hand.sh" "$SCRATCH/notify.sh"
# seed a fresh ready card, patch hand.sh with its id, then:
AGENTBOARD_SESSION_CMD="$SCRATCH/hand.sh" AGENTBOARD_NOTIFY_CMD="$SCRATCH/notify.sh" node dist/cli/index.js runner
grep "NOTIFY:1 card" "$FAKE_OUT" | grep "(review)"
```

Expected: exactly as annotated (real ids substituted; the hand.sh probe needs `cd` context or absolute CLI path — use `node <absolute>/dist/cli/index.js` inside the fake scripts and export AGENTBOARD_DATA into them, which spawnSync inherits).

- [ ] **Step 4: Commit**

```bash
git add src/core/runner.ts src/cli/index.ts
git commit -m "feat: agentboard runner — single-flight lock, headless session, notify hook"
```

---

### Task 4: Serve-hook (AGENTBOARD_AUTORUN)

**Files:**
- Modify: `src/api/server.ts`

**Interfaces:**
- Consumes: the `runner` CLI (Task 3). Produces: after a successful human `POST /api/cards/:id/move` or `POST /api/cards/:id/comments`, the server spawns `node <cli> runner` detached — only when `AGENTBOARD_AUTORUN=1`.

- [ ] **Step 1: The hook**

In `src/api/server.ts` (import `spawn` from `node:child_process`; `path`/`fileURLToPath` are already used for `webDir`):

```ts
// v1.5 of vision besluit C: a human action pokes the same runner the cron
// uses; the single-flight lock arbitrates. Opt-in via AGENTBOARD_AUTORUN=1
// so dev servers and UI tests never start real sessions by accident.
function maybeAutorun(): void {
  if (process.env.AGENTBOARD_AUTORUN !== '1') return;
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
  const child = spawn(process.execPath, [cli, 'runner'], { detached: true, stdio: 'ignore' });
  child.unref();
}
```

Call `maybeAutorun()` in the `/api/cards/:id/move` and `/api/cards/:id/comments` handlers, directly before their successful `return c.json(...)`.

- [ ] **Step 2: Build and verify**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
SCRATCH=$(mktemp -d); export FAKE_OUT="$SCRATCH/calls.log"
printf '#!/usr/bin/env bash\necho HOOKED >> "%s"\n' "$FAKE_OUT" > "$SCRATCH/fake.sh"; chmod +x "$SCRATCH/fake.sh"
A=$(node dist/cli/index.js card new --type task --title x --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $A ready --reason t
AGENTBOARD_AUTORUN=1 AGENTBOARD_SESSION_CMD="$SCRATCH/fake.sh" FAKE_OUT="$FAKE_OUT" node dist/cli/index.js serve --port 4671 & SERVE=$!
sleep 1
curl -s -X POST localhost:4671/api/cards/$A/comments -H 'Content-Type: application/json' -d '{"text":"go"}' >/dev/null
sleep 2
grep -c HOOKED "$FAKE_OUT"      # >= 1
kill $SERVE
node dist/cli/index.js serve --port 4672 & SERVE=$!   # no AUTORUN
sleep 1
: > "$FAKE_OUT"
curl -s -X POST localhost:4672/api/cards/$A/comments -H 'Content-Type: application/json' -d '{"text":"stil"}' >/dev/null
sleep 2
test ! -s "$FAKE_OUT" && echo "no autorun without env"
kill $SERVE
```

Expected: HOOKED appears with AUTORUN=1, file stays empty without.

- [ ] **Step 3: Commit**

```bash
git add src/api/server.ts
git commit -m "feat(api): serve-hook pokes the runner after human actions (AGENTBOARD_AUTORUN=1)"
```

---

### Task 5: Minimal waiting-UI (Needs me + klokje)

**Files:**
- Modify: `web/js/views/board.js` (needYouCount)
- Modify: `web/js/components.js` (wait chip in cardTile)
- Modify: `web/style.css`

**Interfaces:**
- Consumes: `EnrichedCard.wait_check` (Task 1) — reaches the UI via the board API passthrough.
- Produces: needs_input cards with a live (future) wait-check are excluded from "Needs me" and show a grey clock chip (design 2a: "waiting on external").

- [ ] **Step 1: Shared predicate + count**

In `web/js/components.js`, export:

```js
// Vision besluit H: a needs_input card with a live wait-check is waiting on
// something external — not the user's turn.
export const isWaitingExternal = (card) =>
  card.status === 'needs_input' && !!card.wait_check && card.wait_check > new Date().toISOString();
```

In `web/js/views/board.js`, import it and change `needYouCount`:

```js
export const needYouCount = (columns) =>
  (columns.needs_input?.filter((c) => !isWaitingExternal(c)).length ?? 0) + (columns.review?.length ?? 0);
```

- [ ] **Step 2: The clock chip on the tile**

In `cardTile` (components.js), inside the `tile-top` span after the routine chip:

```js
      ${isWaitingExternal(card) ? `<span class="wait-chip" title="waiting on external — not in 'needs me'${card.wait_check ? ` · check ${esc(card.wait_check)}` : ''}">${icons.clock(10)}waiting</span>` : ''}
```

- [ ] **Step 3: CSS**

Next to the routine-chip styles:

```css
.wait-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  color: var(--mut);
  background: var(--chip-bg, #f4f4f5);
  border: 1px solid var(--line, #e5e7eb);
}
```

(Check design 2a's grey waiting-pill in `docs/design/Agentboard.dc.html` and match; `icons.clock` already exists — verify its name in `web/js/icons.js`, else use the existing clock glyph used by `reasonLine`.)

- [ ] **Step 4: Verify + screenshots**

Seed: one needs_input card with `--check-after 2d` (future), one with an expired check, one bare needs_input, one review card. Serve, Playwright 1440px → `docs/design/verify/trigger/`:
1. Board: "Needs me · 3" (bare + expired + review) while four cards sit in needs_input/review; the future-check card shows the grey clock chip → `needsme-waitcheck-1440.png`.
2. Expire the check (sqlite UPDATE on the event payload is fiddly — instead log a new `--check-after` in the past on that card) → reload → counter increments, chip gone → `needsme-expired-1440.png`.
3. Regression: cards without wait-check render as before.

- [ ] **Step 5: Commit**

```bash
git add web/ docs/design/verify/trigger/
git commit -m "feat(web): wachten-scheiding — wait-chip en Needs me telt externe waits niet mee"
```

---

### Task 6: Docs — README trigger section + AGENT.md rule 8

**Files:**
- Modify: `README.md`
- Modify: `AGENT.md`

**Interfaces:** consumes the CLI shapes from Tasks 1/3 (commands must run verbatim).

- [ ] **Step 1: README**

Replace the entire `## Trigger (design, not built)` section with `## Trigger` describing the built reality, in the README's voice and wrap width:

- Layer 1: `agentboard gate --json` — the scheduler's question (narrower than `next`: bare needs_input never counts; blocked ready cards wait; expired wait-checks return).
- Layer 2: `agentboard runner` — single-flight lock (`session.lock`, stale = dead pid or `AGENTBOARD_LOCK_MAX_AGE` minutes, default 120), marks due routines before the spawn, starts `AGENTBOARD_SESSION_CMD` (default `claude -p`) with a prompt naming `AGENTBOARD_AGENT_MD` and the due routine paths, raw output to `sessions/<ts>.log`, then `AGENTBOARD_NOTIFY_CMD` (optional) gets a one-line handback summary.
- Layer 3: the clock — a crontab line (`* * * * * agentboard runner`) and a short launchd plist example (macOS) with the env vars; installing it is the user's step.
- Serve-hook: human move/comment via the UI pokes the runner when `AGENTBOARD_AUTORUN=1`.
- **One machine per data dir** (bold): synced SQLite + PID locks across machines is silent corruption; the lock refuses foreign hostnames.
- Wait-states: `card log <id> "check thread X" --as agent --check-after 2d` — the card leaves "Needs me" and the gate brings it back when the check expires. Remove the old free-text-wait paragraph under External refs if it contradicts this (update it to mention `check_after` is now structured).
- CLI-flags list: add `card log --check-after`.

- [ ] **Step 2: AGENT.md rule 8**

Extend rule 8 (keep the existing text, sharpen the logging instruction):

```markdown
    that line. Always log a wait-state with a check time:
    `card log <id> "check thread X in gmail-zakelijk" --as agent
    --check-after 2d` — the scheduler brings the card back into the
    gate once the check time passes; without --check-after the card
    only returns when the user acts.
```

(Weave into rule 8's existing sentences per the file's wrap style; the command must run verbatim.)

- [ ] **Step 3: Verify**

Run every command cited in the new README section and rule 8 against a throwaway data dir (real ids). Check line-width bands per section.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENT.md
git commit -m "docs: trigger-laag gedocumenteerd (gate, runner, env-vars, één machine); rule 8 met --check-after"
```

---

### Task 7: End-to-end verification script

**Files:**
- Create: `docs/superpowers/plans/verify-trigger.sh`

- [ ] **Step 1: Write the script**

Compose from the verified probes of Tasks 1–4 (gate matrix, check-after parsing, runner with fake session incl. routine-mark + prompt content, lock contention/stale/foreign-host, notify, serve-hook on/off), in the house style of `verify-blockers.sh`/`verify-routines.sh`: `set -euo pipefail`, `fail()`/`expect_fail()`/`id_of()`, throwaway `AGENTBOARD_DATA` and scratch dir, fake scripts written with absolute CLI paths, servers always killed (trap). End with `echo "OK: trigger/scheduler verified (...)"`.

- [ ] **Step 2: Run all three probes**

```bash
chmod +x docs/superpowers/plans/verify-trigger.sh
npm run build && docs/superpowers/plans/verify-trigger.sh && docs/superpowers/plans/verify-routines.sh && docs/superpowers/plans/verify-blockers.sh
```

Expected: three OK lines, exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/verify-trigger.sh
git commit -m "test: end-to-end probe for the trigger/scheduler layer"
```
