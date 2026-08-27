# Session Logging (4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every runner session is numbered, captured as JSONL, indexed in SQLite, linked to its cards, and viewable — redacted — from the card ("Agent activity" tab) and a minimal session-detail page, plus a dormant/live heartbeat on doing cards and a prune command.

**Architecture:** New core module `src/core/sessions.ts` (records, card scan, redaction, parser, list/detail/prune, card-fragments) importing only `db.ts` + fs. `runner.ts` imports sessions.ts (one-way; sessions.ts never imports runner.ts — `sessionStatus` lives in runner.ts because it owns the lock). API is passthrough; UI is display-only.

**Tech Stack:** TypeScript, better-sqlite3, commander, Hono, vanilla-JS web UI.

**Spec:** `docs/superpowers/specs/2026-08-27-session-logging-design.md` (kader: vision besluit J; design artboards 2g + het 2f-detailpaneel).

## Global Constraints

- **No test framework.** Build + CLI probes against `export AGENTBOARD_DATA=$(mktemp -d)/abdata`. "id -> X" = capture real ids from `--json`.
- **NEVER a real claude session in probes**: every runner invocation uses a fake `AGENTBOARD_SESSION_CMD`, exported in the same shell call.
- Redaction happens at display time only (`sessions show`, all session API endpoints); the raw JSONL on disk is deliberately unredacted (same trust boundary as secrets.env).
- `trigger` is a **reserved word in SQLite** — quote it as `"trigger"` in every DDL/SQL statement that names the column.
- Sessions with `ended_at IS NULL` are never pruned.
- Comments English, surgical, NEW commits only — never amend.

---

### Task 1: Schema + sessions core (records, scan, redaction)

**Files:**
- Modify: `src/core/db.ts` (SCHEMA)
- Create: `src/core/sessions.ts` (first half)

**Interfaces:**
- Produces (Task 2/3 rely on exact names): `startSessionRecord(trigger): { id, jsonl, stderr }`, `finishSessionRecord(id, exitStatus, handedBack)`, `scanSessionCards(id): string[]`, `secretRedactor(): (text) => string`, `redactSecrets(text)`, `sessionJsonlPath(id)`, `sessionStderrPath(id)`, `interface SessionMeta`.

- [ ] **Step 1: SCHEMA**

Append to `SCHEMA` in `src/core/db.ts` (after `routine_run`):

```sql
CREATE TABLE IF NOT EXISTS session (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  "trigger"   TEXT NOT NULL,
  exit_status INTEGER,
  handed_back TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS session_card (
  session_id INTEGER NOT NULL REFERENCES session(id),
  card_id    TEXT NOT NULL REFERENCES card(id),
  PRIMARY KEY (session_id, card_id)
);
```

(`IF NOT EXISTS` + init re-exec covers existing dbs; no ALTER needed.)

- [ ] **Step 2: src/core/sessions.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataDir, now, openDb, secretsPath } from './db.js';

export interface SessionMeta {
  id: number;
  started_at: string;
  ended_at: string | null;
  trigger: string;
  exit_status: number | null;
  handed_back: { id: string; to: string }[];
  cards: string[];
}

const sessionsDir = () => path.join(dataDir(), 'sessions');
export const sessionJsonlPath = (id: number) => path.join(sessionsDir(), `${id}.jsonl`);
export const sessionStderrPath = (id: number) => path.join(sessionsDir(), `${id}.stderr.log`);

export function startSessionRecord(trigger: string): { id: number; jsonl: string; stderr: string } {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const db = openDb();
  try {
    const info = db
      .prepare(`INSERT INTO session (started_at, "trigger", handed_back) VALUES (?, ?, '[]')`)
      .run(now(), trigger);
    const id = Number(info.lastInsertRowid);
    return { id, jsonl: sessionJsonlPath(id), stderr: sessionStderrPath(id) };
  } finally {
    db.close();
  }
}

export function finishSessionRecord(
  id: number,
  exitStatus: number | null,
  handedBack: { id: string; to: string }[]
): void {
  const db = openDb();
  try {
    db.prepare('UPDATE session SET ended_at = ?, exit_status = ?, handed_back = ? WHERE id = ?').run(
      now(),
      exitStatus,
      JSON.stringify(handedBack),
      id
    );
  } finally {
    db.close();
  }
}

// Which cards did this session touch? Mined from the transcript, so cards
// the session created mid-run are linked too. Only ids that really exist
// survive (the pattern alone would match hex noise).
export function scanSessionCards(id: number): string[] {
  const file = sessionJsonlPath(id);
  if (!fs.existsSync(file)) return [];
  const ids = [...new Set(fs.readFileSync(file, 'utf8').match(/\b(?:task|ops)_[0-9a-f]{4}\b/g) ?? [])];
  const db = openDb();
  try {
    const known = ids.filter((c) => db.prepare('SELECT 1 FROM card WHERE id = ?').get(c));
    const insert = db.prepare('INSERT OR IGNORE INTO session_card (session_id, card_id) VALUES (?, ?)');
    for (const c of known) insert.run(id, c);
    return known;
  } finally {
    db.close();
  }
}

// The vault never reaches a viewer: every secrets.env value — and for
// base64: values every printable decoded line — becomes [secret:name] at
// display time. The raw file on disk shares secrets.env's trust boundary;
// AGENT.md rule 4 is the first line of defense, this is the net.
export function secretRedactor(): (text: string) => string {
  const file = secretsPath();
  if (!fs.existsSync(file)) return (t) => t;
  const replacements: { value: string; name: string }[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (!value) continue;
    replacements.push({ value, name });
    if (value.startsWith('base64:')) {
      try {
        for (const decoded of Buffer.from(value.slice(7), 'base64').toString('utf8').split('\n')) {
          const d = decoded.trim();
          if (d.length >= 6 && /^[\x20-\x7e]+$/.test(d)) replacements.push({ value: d, name });
        }
      } catch {
        /* not decodable: the raw value replacement still applies */
      }
    }
  }
  replacements.sort((a, b) => b.value.length - a.value.length); // longest first
  return (text) => {
    let out = text;
    for (const r of replacements) out = out.split(r.value).join(`[secret:${r.name}]`);
    return out;
  };
}

export const redactSecrets = (text: string): string => secretRedactor()(text);
```

- [ ] **Step 3: Build and verify with node -e probes**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
node dist/cli/index.js card new --type task --title "sessiekaart" --json   # id -> T
echo "supergeheim123" | node dist/cli/index.js secret set demo_secret
node --input-type=module -e "
import fs from 'node:fs';
const s = await import('file://$PWD/dist/core/sessions.js');
const rec = s.startSessionRecord('manual');
fs.writeFileSync(rec.jsonl, 'werkte aan T en task_zzzz en supergeheim123\n');
console.log('cards:', JSON.stringify(s.scanSessionCards(rec.id)));
s.finishSessionRecord(rec.id, 0, [{id:'T',to:'review'}]);
console.log(s.redactSecrets('waarde is supergeheim123 einde'));
"
sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT id, "trigger", exit_status, ended_at IS NOT NULL FROM session;'
sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT * FROM session_card;'
```

Expected (with the real T substituted): `cards: ["T"]` (task_zzzz filtered out — unknown card), redacted line prints `waarde is [secret:demo_secret] einde`, session row shows trigger manual/exit 0/ended 1, session_card holds (1, T). ESM note: if `require` fails under `"type": "module"`, use `import(...)` in the -e script instead — report which you used.

- [ ] **Step 4: Commit**

```bash
git add src/core/db.ts src/core/sessions.ts
git commit -m "feat(core): session/session_card schema + sessions core (records, card scan, redaction)"
```

---

### Task 2: Runner integration (--trigger, JSONL capture, crash-safe record)

**Files:**
- Modify: `src/core/runner.ts`
- Modify: `src/cli/index.ts` (runner command)
- Modify: `src/api/server.ts` (serve-hook arg)
- Modify: `docs/superpowers/plans/verify-trigger.sh` (only the legs the capture change breaks)

**Interfaces:**
- Consumes: Task 1's record functions.
- Produces: `runSession(dryRun?: boolean, trigger?: string)` — result gains `session?: number`; CLI `runner --trigger <label>` (default `manual`); serve-hook spawns `runner --trigger serve`; default `AGENTBOARD_SESSION_CMD` becomes `claude -p --output-format stream-json --verbose`; capture split stdout→`<id>.jsonl`, stderr→`<id>.stderr.log`.

- [ ] **Step 1: runner.ts**

Import at top: `import { finishSessionRecord, scanSessionCards, startSessionRecord } from './sessions.js';`

Change the signature: `export function runSession(dryRun = false, trigger = 'manual')` and add `session?: number` to the return type.

Replace the block from `const sessionsDir = path.join(dataDir(), 'sessions');` through the `return { started: true, ... }` with:

```ts
    const rec = startSessionRecord(trigger);
    console.error(`runner: session #${rec.id} -> ${rec.jsonl}`);
    const parts = (process.env.AGENTBOARD_SESSION_CMD ?? 'claude -p --output-format stream-json --verbose').split(
      /\s+/
    );
    let status: number | null = null;
    let notified: { id: string; to: string }[] = [];
    try {
      const out = fs.openSync(rec.jsonl, 'w');
      const err = fs.openSync(rec.stderr, 'w');
      try {
        // stdout is the JSONL transcript; stderr goes to its own file so a
        // stray warning can never corrupt a transcript line.
        status = spawnSync(parts[0], [...parts.slice(1), buildPrompt(due.routines)], {
          stdio: ['ignore', out, err],
        }).status;
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
      console.error(`runner: session exited ${status ?? 'null'}`);
      scanSessionCards(rec.id);
      notified = handbacksSince(sessionStart);
      notify(notified);
      if (process.env.AGENTBOARD_NOTIFY_CMD && notified.length > 0) {
        console.error(`runner: notified: ${notified.length}`);
      }
      return { started: true, reason: `session exited ${status ?? 'null'}`, log: rec.jsonl, session: rec.id, notified };
    } finally {
      // ended_at is always set, crash or not — a session row may never
      // stay open forever (the heartbeat and prune both depend on it).
      finishSessionRecord(rec.id, status, notified);
    }
```

(The unused `dataDir` import stays — check: it is still used by `lockPath`. Remove the old `sessionsDir`/`logFile` lines and the now-unused `const sessionsDir` only.)

- [ ] **Step 2: CLI + serve-hook**

`runner` command gains:

```ts
  .option('--trigger <label>', 'what started this runner (cron | serve | manual)', 'manual')
```

and calls `runSession(opts.dryRun === true, opts.trigger)`.

In `src/api/server.ts` `maybeAutorun()`, the spawn args become `[cli, 'runner', '--trigger', 'serve']`.

- [ ] **Step 3: verify-trigger.sh legs**

Run `docs/superpowers/plans/verify-trigger.sh`. Fix ONLY legs the capture change breaks (expected: any assertion on the log filename pattern or a leg reading the merged log — stderr now lands in `<id>.stderr.log`; the prompt-content greps must point at `<id>.jsonl`... note the fake writes its output via `$FAKE_OUT`, which is unaffected). Document each leg change in your report with the reason.

- [ ] **Step 4: Build and verify**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
SCRATCH=$(mktemp -d); export FAKE_OUT="$SCRATCH/calls.log"
cat > "$SCRATCH/fake.sh" << 'EOF'
#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hallo van de sessie"}]}}'
echo "ruis op stderr" >&2
EOF
chmod +x "$SCRATCH/fake.sh"
A=$(node dist/cli/index.js card new --type task --title "werk" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
node dist/cli/index.js card move $A ready --reason t
AGENTBOARD_SESSION_CMD="$SCRATCH/fake.sh" node dist/cli/index.js runner --trigger cron
sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT id, "trigger", exit_status FROM session;'   # 1|cron|0
cat "$AGENTBOARD_DATA/sessions/1.jsonl"          # exactly the JSON line, no stderr noise
cat "$AGENTBOARD_DATA/sessions/1.stderr.log"     # ruis op stderr
# crash path: ended_at still set, exit != 0
cat > "$SCRATCH/crash.sh" << 'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$SCRATCH/crash.sh"
node dist/cli/index.js card move $A ready --reason again --as human >/dev/null 2>&1 || true
AGENTBOARD_SESSION_CMD="$SCRATCH/crash.sh" node dist/cli/index.js runner
sqlite3 "$AGENTBOARD_DATA/board.db" 'SELECT id, exit_status, ended_at IS NOT NULL FROM session WHERE id = 2;'   # 2|7|1
docs/superpowers/plans/verify-trigger.sh   # green (with your leg fixes)
```

- [ ] **Step 5: Commit**

```bash
git add src/core/runner.ts src/cli/index.ts src/api/server.ts docs/superpowers/plans/verify-trigger.sh
git commit -m "feat(runner): genummerde sessies — JSONL-capture, --trigger, crash-vaste registratie"
```

---

### Task 3: Parser, list/detail/prune, card-fragments + `sessions` CLI

**Files:**
- Modify: `src/core/sessions.ts` (second half)
- Modify: `src/cli/index.ts` (new `sessions` group)

**Interfaces:**
- Produces: `interface SessionStep { n; type: 'text'|'tool'|'result'|'raw'; label; detail; card_ids }`, `parseSessionSteps(jsonlText): SessionStep[]`, `listSessions(): SessionMeta[]`, `sessionDetail(id): { session; steps }` (redacted), `cardSessions(cardId): { session; steps }[]` (fragments: steps touching the card ± 1 context step), `pruneSessions(olderThan): { removed: number[] }`; CLI `sessions list|show <nr>|prune --older-than <dur>`.

- [ ] **Step 1: Parser + queries in sessions.ts**

```ts
export interface SessionStep {
  n: number;
  type: 'text' | 'tool' | 'result' | 'raw';
  label: string;
  detail: string;
  card_ids: string[];
}

const CARD_RE = /\b(?:task|ops)_[0-9a-f]{4}\b/g;
const firstLine = (s: string) => (s.split('\n')[0] ?? '').slice(0, 120);

// stream-json lines -> flat steps. Unparseable lines stay visible as 'raw',
// so a session captured with a non-JSON command still renders.
export function parseSessionSteps(jsonlText: string): SessionStep[] {
  const steps: SessionStep[] = [];
  const push = (type: SessionStep['type'], label: string, detail: string) =>
    steps.push({
      n: steps.length + 1,
      type,
      label,
      detail,
      card_ids: [...new Set(`${label}\n${detail}`.match(CARD_RE) ?? [])],
    });
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      push('raw', firstLine(line), line);
      continue;
    }
    const blocks = msg?.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          push('text', firstLine(b.text), b.text);
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          push('text', `reasoning · ${b.thinking.trim().split(/\s+/).length} words`, b.thinking);
        } else if (b.type === 'tool_use') {
          push('tool', String(b.name ?? 'tool'), JSON.stringify(b.input ?? {}).slice(0, 500));
        } else if (b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          push('result', firstLine(content), content.slice(0, 2000));
        }
      }
    } else if (msg?.type === 'result' && typeof msg.result === 'string') {
      push('text', firstLine(msg.result), msg.result);
    }
  }
  return steps;
}

function rowToMeta(db: Database.Database, row: any): SessionMeta {
  const cards = (
    db.prepare('SELECT card_id FROM session_card WHERE session_id = ? ORDER BY card_id').all(row.id) as {
      card_id: string;
    }[]
  ).map((r) => r.card_id);
  return { ...row, handed_back: JSON.parse(row.handed_back ?? '[]'), cards };
}

export function listSessions(): SessionMeta[] {
  const db = openDb();
  try {
    return (db.prepare('SELECT * FROM session ORDER BY id DESC').all() as any[]).map((r) => rowToMeta(db, r));
  } finally {
    db.close();
  }
}

export function sessionDetail(id: number): { session: SessionMeta; steps: SessionStep[] } {
  const db = openDb();
  try {
    const row = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    const file = sessionJsonlPath(id);
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const redact = secretRedactor();
    const steps = parseSessionSteps(raw).map((s) => ({ ...s, label: redact(s.label), detail: redact(s.detail) }));
    return { session: rowToMeta(db, row), steps };
  } finally {
    db.close();
  }
}

// Card-first (design 2g): per session that touched this card, only the
// steps mentioning it, padded with one step of context on each side.
export function cardSessions(cardId: string): { session: SessionMeta; steps: SessionStep[] }[] {
  const db = openDb();
  let ids: number[];
  try {
    ids = (
      db.prepare('SELECT session_id FROM session_card WHERE card_id = ? ORDER BY session_id DESC').all(cardId) as {
        session_id: number;
      }[]
    ).map((r) => r.session_id);
  } finally {
    db.close();
  }
  return ids.map((id) => {
    const { session, steps } = sessionDetail(id);
    const keep = new Set<number>();
    steps.forEach((s, i) => {
      if (s.card_ids.includes(cardId)) {
        keep.add(i - 1);
        keep.add(i);
        keep.add(i + 1);
      }
    });
    return { session, steps: steps.filter((_, i) => keep.has(i)) };
  });
}

// The one place delete exists: session logs are working material, not card
// history — the timeline stays the durable truth. Running sessions
// (ended_at NULL) are never pruned.
export function pruneSessions(olderThan: string): { removed: number[] } {
  const m = olderThan.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`Invalid --older-than '${olderThan}'. Use 30d, 12h or 45m`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  const cutoff = new Date(Date.now() - Number(m[1]) * unit).toISOString();
  const db = openDb();
  try {
    const rows = db
      .prepare('SELECT id FROM session WHERE started_at < ? AND ended_at IS NOT NULL')
      .all(cutoff) as { id: number }[];
    const remove = db.transaction((sids: number[]) => {
      for (const sid of sids) {
        db.prepare('DELETE FROM session_card WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM session WHERE id = ?').run(sid);
      }
    });
    remove(rows.map((r) => r.id));
    for (const r of rows) {
      fs.rmSync(sessionJsonlPath(r.id), { force: true });
      fs.rmSync(sessionStderrPath(r.id), { force: true });
    }
    return { removed: rows.map((r) => r.id) };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: CLI group** (import the new functions; add a small duration helper)

```ts
const sessions = program.command('sessions').description('recorded runner sessions (JSONL + index)');

function sessionLine(s: any): string {
  const dur =
    s.ended_at !== null
      ? `${Math.max(1, Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000))}s`
      : 'running';
  const outcome =
    s.ended_at === null ? 'running' : s.exit_status === 0 ? 'completed' : `ended early (${s.exit_status ?? 'crash'})`;
  const handed = s.handed_back.length ? `  handed back: ${s.handed_back.map((h: any) => h.id).join(', ')}` : '';
  return `  #${String(s.id).padEnd(4)} ${s.trigger.padEnd(7)} ${s.started_at}  ${dur.padEnd(8)} ${outcome}${
    s.cards.length ? `  [${s.cards.join(', ')}]` : ''
  }${handed}`;
}

sessions
  .command('list')
  .description('all recorded sessions, newest first')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const all = listSessions();
      output(opts, all.length ? all.map(sessionLine).join('\n') : 'No sessions yet', { sessions: all });
    })
  );

sessions
  .command('show <nr>')
  .description('meta + parsed steps of one session (secrets redacted)')
  .option('--json', 'JSON output')
  .action(
    run((opts, nr: string) => {
      const detail = sessionDetail(Number(nr));
      const lines = [sessionLine(detail.session), ''];
      lines.push(...detail.steps.map((s) => `  [${s.type.padEnd(6)}] ${s.label}`));
      output(opts, lines.join('\n'), detail);
    })
  );

sessions
  .command('prune')
  .description('remove session logs + index rows older than a duration (running sessions are kept)')
  .requiredOption('--older-than <dur>', '30d, 12h or 45m')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const result = pruneSessions(opts.olderThan);
      output(opts, result.removed.length ? `Pruned ${result.removed.length} session(s): ${result.removed.join(', ')}` : 'Nothing to prune', result);
    })
  );
```

- [ ] **Step 3: Build and verify**

Reuse the Task 2 scratch (two sessions) or reseed, plus a fixture:

```bash
npm run build
node dist/cli/index.js sessions list                      # #2 ended early (7), #1 completed [A]
node dist/cli/index.js sessions show 1 | grep 'hallo van de sessie'
# redaction end-to-end: plant a secret in a transcript
echo "supergeheim123" | node dist/cli/index.js secret set demo_secret
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"key is supergeheim123"}]}}\n' >> "$AGENTBOARD_DATA/sessions/1.jsonl"
node dist/cli/index.js sessions show 1 | grep 'key is \[secret:demo_secret\]'
grep supergeheim123 "$AGENTBOARD_DATA/sessions/1.jsonl"    # raw file DOES contain it (by design)
# parser fixture: tool/result/reasoning/raw
printf '%s\n' \
 '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"drie woorden hier"}]}}' \
 '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"agentboard next"}}]}}' \
 '{"type":"user","message":{"content":[{"type":"tool_result","content":"task_ff00 not found"}]}}' \
 'geen json' >> "$AGENTBOARD_DATA/sessions/1.jsonl"
node dist/cli/index.js sessions show 1 --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
types=[s['type'] for s in d['steps']]
assert 'tool' in types and 'result' in types and 'raw' in types, types
assert any(s['label'].startswith('reasoning · 3 words') for s in d['steps']), [s['label'] for s in d['steps']]
"
# prune: backdate session 2, prune, session 1 stays
sqlite3 "$AGENTBOARD_DATA/board.db" "UPDATE session SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = 2"
node dist/cli/index.js sessions prune --older-than 30d    # Pruned 1 session(s): 2
test ! -f "$AGENTBOARD_DATA/sessions/2.jsonl" && node dist/cli/index.js sessions show 1 >/dev/null && echo "prune ok"
node dist/cli/index.js sessions prune --older-than nonsens 2>&1   # Invalid --older-than
```

- [ ] **Step 4: Commit**

```bash
git add src/core/sessions.ts src/cli/index.ts
git commit -m "feat: sessions CLI — parser, list/show met redactie, prune"
```

---

### Task 4: API endpoints + session-status

**Files:**
- Modify: `src/core/runner.ts` (add `sessionStatus`)
- Modify: `src/api/server.ts` (four GET routes)

**Interfaces:**
- Produces: `sessionStatus(): { running: boolean; session_id: number | null }` (in runner.ts — it owns the lock; running = open session row AND live own-host lock); `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/cards/:id/sessions`, `GET /api/session-status`.

- [ ] **Step 1: sessionStatus in runner.ts**

```ts
// Heartbeat: is a runner-started session alive right now? The lock proves a
// live process; the open session row names it. Both required — a stale row
// after a crash must not read as "live".
export function sessionStatus(): { running: boolean; session_id: number | null } {
  let alive = false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as SessionLock;
    alive = lock.hostname === os.hostname() && processAlive(lock.pid);
  } catch {
    alive = false;
  }
  const db = openDb();
  try {
    const row = db.prepare('SELECT id FROM session WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as
      | { id: number }
      | undefined;
    return { running: alive && row !== undefined, session_id: alive && row ? row.id : null };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Routes in server.ts** (import `sessionStatus` from runner.js; `cardSessions, listSessions, sessionDetail` from sessions.js), after the routines routes:

```ts
  app.get('/api/sessions', (c) => {
    try {
      return c.json({ sessions: listSessions() });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/sessions/:id', (c) => {
    try {
      return c.json(sessionDetail(Number(c.req.param('id'))));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/cards/:id/sessions', (c) => {
    try {
      return c.json({ sessions: cardSessions(c.req.param('id')) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/session-status', (c) => {
    try {
      return c.json(sessionStatus());
    } catch (err) {
      return errorResponse(c, err);
    }
  });
```

(Route-order note: register `/api/cards/:id/sessions` near the other `/api/cards/:id/...` GETs; Hono matches exact segments so order vs `/api/cards/:id` is not a conflict, but keep the file grouped.)

- [ ] **Step 3: Build and verify**

Seed per Task 2/3, serve on 4673, then:

```bash
curl -s localhost:4673/api/sessions | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['sessions']))"
curl -s localhost:4673/api/sessions/1 | grep '\[secret:demo_secret\]'
curl -s localhost:4673/api/sessions/1 | (grep supergeheim123 && echo LEAK) || echo "redacted ok"
curl -s "localhost:4673/api/cards/$A/sessions" | python3 -m json.tool | grep '"session"' -m1
curl -s localhost:4673/api/session-status    # {"running":false,"session_id":null}
```

Kill the serve. Expected as annotated.

- [ ] **Step 4: Commit**

```bash
git add src/core/runner.ts src/api/server.ts
git commit -m "feat(api): sessies — list/detail/card-fragments/status, geredigeerd"
```

---

### Task 5: Web UI — Agent activity-tab, sessie-detail, heartbeat

**Files:**
- Create: `web/js/views/session.js`
- Modify: `web/js/api.js`, `web/js/app.js`, `web/js/views/card.js`, `web/js/views/board.js`, `web/js/components.js`, `web/style.css`

**Interfaces:**
- Consumes: Task 4's endpoints. Design 2g (card tab) is authoritative; the session-detail page is the 2f right pane minimal (steps, reasoning collapsed — no live tail, no list page). Heartbeat per design 2a's live/dormant doing-cards.

- [ ] **Step 1: api.js**

```js
  sessions: () => req('/api/sessions'),
  session: (id) => req(`/api/sessions/${encodeURIComponent(id)}`),
  cardSessions: (id) => req(`/api/cards/${encodeURIComponent(id)}/sessions`),
  sessionStatus: () => req('/api/session-status'),
```

- [ ] **Step 2: views/session.js** — route target `#/session/<nr>`:

```js
// Minimal session detail (design 2f right pane): header + flat steps,
// reasoning collapsed by default. The sessions overview/live tail is 4b.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime, absTime } from '../util.js';
import { crumb } from '../components.js';

const STEP_ICON = { text: 'fileText', tool: 'sliders', result: 'arrowDown', raw: 'alert' };

export async function renderSession(root, { id }) {
  const { session, steps } = await api.session(id);
  const dur =
    session.ended_at !== null
      ? `${Math.max(1, Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 1000))}s`
      : 'running';
  const outcome =
    session.ended_at === null ? 'running' : session.exit_status === 0 ? 'completed' : `ended early (${session.exit_status ?? 'crash'})`;
  root.innerHTML = `
    ${crumb([{ text: 'Agentboard', href: '#/' }, { text: `session #${session.id}`, strong: true }])}
    <div class="session-head">
      <span class="rt-sched">${esc(session.trigger)}</span>
      <span class="mut-sm" title="${esc(absTime(session.started_at))}">${esc(relTime(session.started_at))} · ${esc(dur)} · ${esc(outcome)}</span>
      ${session.cards.map((c) => `<a class="cardref-chip" href="#/card/${esc(c)}">${esc(c)}</a>`).join('')}
    </div>
    <div class="session-steps">
      ${steps
        .map((s) => {
          const reasoning = s.label.startsWith('reasoning ·');
          const icon = icons[STEP_ICON[s.type]] ? icons[STEP_ICON[s.type]](13) : '';
          if (reasoning)
            return `<details class="step reasoning"><summary>${icon}<em>${esc(s.label)}</em></summary><pre>${esc(s.detail)}</pre></details>`;
          return `<details class="step ${s.type}"><summary>${icon}<span class="step-type">${esc(s.type)}</span> ${esc(s.label)}</summary><pre>${esc(s.detail)}</pre></details>`;
        })
        .join('') || '<p class="mut-sm">Empty transcript.</p>'}
    </div>`;
}
```

- [ ] **Step 3: Router** — in `app.js` `parseRoute()` add before the card match:

```js
  if ((m = hash.match(/^\/session\/(\d+)$/))) return { name: 'session', id: Number(m[1]) };
```

import `renderSession` and add the branch `else if (r.name === 'session') await renderSession(view, { id: r.id });`

- [ ] **Step 4: Card tab (design 2g)** — in `views/card.js`: turn the timeline header into two tabs. Replace the `tl-head` block's title span with:

```js
          <div class="tl-head"><div class="tl-tabs">
              <button type="button" class="tl-tab active" data-tab="timeline">Timeline</button>
              <button type="button" class="tl-tab" data-tab="activity">Agent activity</button>
            </div>
            <div class="tl-filters">…(bestaand)…</div>
          </div>
          <div id="activity-pane" hidden></div>
```

Wiring after render: clicking "Agent activity" hides `#timeline-list` + secret-box + filters, shows `#activity-pane`, lazy-loads once via `api.cardSessions(card.id)` and renders per session:

```js
      const blocks = data.sessions.map(({ session, steps }) => `
        <div class="act-session">
          <div class="act-head">#${session.id} <span class="rt-sched">${esc(session.trigger)}</span>
            <span class="mut-sm">${esc(relTime(session.started_at))}</span>
            <a href="#/session/${session.id}">open full session →</a></div>
          ${steps.map((s) => `<p class="act-step ${s.type}">[${esc(s.type)}] ${esc(s.label)}</p>`).join('') || '<p class="mut-sm">No steps touched this card.</p>'}
        </div>`).join('');
      pane.innerHTML = blocks || '<p class="mut-sm">No agent sessions touched this card yet.</p>';
```

Clicking "Timeline" restores the original pane. (Keep the existing filter buttons working within the timeline tab only.)

- [ ] **Step 5: Heartbeat** — `cardTile` in components.js gains `opts.presence` (`'live' | 'dormant' | undefined`), rendered after `reasonLine`:

```js
    ${opts.presence === 'live' ? '<p class="presence live"><span class="live-dot"></span>live session</p>' : ''}
    ${opts.presence === 'dormant' ? '<p class="presence">no live session — resumes at the next run</p>' : ''}
```

In `board.js`: `renderBoard` fetches `api.sessionStatus()` alongside the board (Promise.all, failure-tolerant: `.catch(() => ({ running: false }))`), and the doing-column render passes presence for agent-owned cards: `cardTile(c, { presence: c.owner === 'agent' ? (status.running ? 'live' : 'dormant') : undefined })` (only in the doing column).

- [ ] **Step 6: CSS** (match design 2a/2f tokens in `docs/design/Agentboard.dc.html` — check and adjust toward the design):

```css
.tl-tabs { display: inline-flex; gap: 2px; }
.tl-tab { border: 0; background: none; font: inherit; font-weight: 600; padding: 2px 8px; border-radius: 6px; cursor: pointer; color: var(--mut); }
.tl-tab.active { color: var(--dark); background: var(--chip-bg, #f4f4f5); }
.session-head { display: flex; align-items: center; gap: 8px; margin: 10px 0 14px; flex-wrap: wrap; }
.session-steps .step { border-bottom: 1px solid var(--line, #e5e7eb); padding: 4px 2px; }
.session-steps summary { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
.session-steps .step-type { font-family: var(--mono, ui-monospace, monospace); font-size: 10.5px; text-transform: uppercase; color: var(--mut); }
.session-steps pre { white-space: pre-wrap; font-size: 12px; background: var(--chip-bg, #f4f4f5); border-radius: 8px; padding: 8px; margin: 6px 0 4px; overflow-x: auto; }
.session-steps .reasoning summary em { color: var(--mut); font-style: italic; }
.act-session { border: 1px solid var(--line, #e5e7eb); border-radius: 10px; padding: 8px 10px; margin: 8px 0; }
.act-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.act-step { font-size: 12px; margin: 3px 0; color: var(--mut); font-family: var(--mono, ui-monospace, monospace); }
.presence { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--mut); margin: 4px 0 0; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: oklch(0.55 0.16 255); animation: ab-pulse 1.6s infinite; }
@keyframes ab-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
```

- [ ] **Step 7: Verify + screenshots**

Seed per Tasks 2–4 (sessions touching card A incl. the redaction fixture; card A in doing@agent for the dormant probe). Serve, Playwright 1440px → `docs/design/verify/sessions/`:
1. Card A → "Agent activity"-tab: fragmentblokken met "open full session →" → `card-activity-1440.png`.
2. `#/session/1`: header + stappen, reasoning ingeklapt; klik hem open; secret toont `[secret:demo_secret]` → `session-detail-1440.png`.
3. Board met doing@agent-kaart zonder lopende sessie: dormant-regel zichtbaar → `doing-dormant-1440.png`.
4. Regressie: Timeline-tab en filters werken als voorheen; kaarten zonder sessies tonen een nette lege staat.
Playwright unavailable → DONE_WITH_CONCERNS.

- [ ] **Step 8: Commit**

```bash
git add web/ docs/design/verify/sessions/
git commit -m "feat(web): Agent activity-tab, sessie-detailpagina, doing-heartbeat"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** New `## Sessions` section (after `## Trigger`), in the README's voice/wrap: where transcripts live (`sessions/<nr>.jsonl` + `.stderr.log`), the index tables, `sessions list/show/prune` (prune = the one place delete exists; running sessions are kept; the timeline stays the durable truth), redaction-at-display (raw file shares secrets.env's trust boundary), and the heartbeat. Update the `## Trigger` section: `--trigger` in the cron/launchd examples, `<nr>.jsonl` instead of `<ts>.log`, and the new default `AGENTBOARD_SESSION_CMD`. Update `## The tables` with **session** and **session_card**. Verify every cited command verbatim (fake SESSION_CMD only); check wrap bands.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: sessions-sectie + trigger-sectie bijgewerkt (jsonl, --trigger, prune)"
```

---

### Task 7: End-to-end verification script

**Files:**
- Create: `docs/superpowers/plans/verify-sessions.sh`

- [ ] **Step 1:** Compose from Tasks 1–5's verified probes, house style (`set -euo pipefail`, `fail`/`expect_fail`/`id_of`, mktemp dirs, absolute CLI paths in fakes, trap kills serves, `if …; then fail; fi` for must-NOT-match): session row + jsonl/stderr split; crash path (ended_at set, exit 7); card scan (known id linked, fake id ignored); redaction (raw file leaks by design, show/API redact — plain + base64 secret); parser fixture (tool/result/raw/reasoning); prune (backdated pruned, running/young kept, garbage duration refused); session-status false na afloop; card-fragments endpoint bevat het card-id. End: `echo "OK: sessions verified (...)"`.

- [ ] **Step 2:**

```bash
chmod +x docs/superpowers/plans/verify-sessions.sh
npm run build && docs/superpowers/plans/verify-sessions.sh && docs/superpowers/plans/verify-trigger.sh && docs/superpowers/plans/verify-routines.sh && docs/superpowers/plans/verify-blockers.sh
```

Expected: four OK lines, exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/verify-sessions.sh
git commit -m "test: end-to-end probe voor sessielogging"
```
