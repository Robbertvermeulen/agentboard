# Blockers & Claiming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Task cards can be structurally blocked by ops cards (`blocked_by`), `next` skips blocked cards, the web UI shows blockers read-only, and claiming a card is race-free via a conditional status move.

**Architecture:** One new JSON column on `card` (`blocked_by`), one new event kind (`blocker_added`), a compare-and-swap on `moveCard`, and derived-only "open blocker" logic (no unblock write ever exists). All domain logic in `src/core/`, thin flags in `src/cli/`, passthrough in `src/api/`, display-only chips in `web/`.

**Tech Stack:** TypeScript, better-sqlite3 (WAL), commander, Hono, no-build vanilla-JS web UI.

**Spec:** `docs/superpowers/specs/2026-08-25-blockers-claiming-design.md` (kader: `docs/superpowers/specs/2026-08-24-agentboard-vision.md`, besluiten A/B/Concurrency).

## Global Constraints

- **No test framework, by design** (README: "No ORM, no tests"). Every task verifies with `npm run build` + CLI probes against a throwaway `AGENTBOARD_DATA` and states the expected output. Do not add a test framework.
- All verification uses a scratch dir: `export AGENTBOARD_DATA=$(mktemp -d)/abdata` then `node dist/cli/index.js init` (never the real `~/.agentboard`).
- Comments in code are English, match existing comment density and style.
- Core throws `Error` with a clear message; CLI/API layers stay logic-free.
- "Open blocker" everywhere means: blocker card status is not `done` and not `archived`. Resolved blockers stay in `blocked_by` (provenance); nothing ever removes them.
- Surgical changes only: do not reformat or restructure code you are not changing.

---

### Task 1: Schema, migrations, busy_timeout

**Files:**
- Modify: `src/core/db.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EVENT_KINDS` includes `'blocker_added'`; `card` table has `blocked_by TEXT NOT NULL DEFAULT '[]'`; both `openDb()` and the `initData` connection set `busy_timeout = 5000`. Later tasks rely on the column and the event kind existing after `agentboard init`.

- [ ] **Step 1: Add the event kind**

In `src/core/db.ts`, extend `EVENT_KINDS`:

```ts
export const EVENT_KINDS = [
  'status_changed',
  'action_taken',
  'context_written',
  'error',
  'upload_added',
  'secret_stored',
  'blocker_added',
] as const;
```

- [ ] **Step 2: Add the column to SCHEMA**

In the `CREATE TABLE IF NOT EXISTS card` block, after the `context_refs` line:

```sql
  context_refs  TEXT NOT NULL DEFAULT '[]',
  blocked_by    TEXT NOT NULL DEFAULT '[]',
```

- [ ] **Step 3: Add the column migration in `initData`**

Directly after the existing `board_id` migration block (which follows the `PRAGMA table_info(card)` query — reuse its `cardCols`):

```ts
  // Migration: card tables from before blockers lack blocked_by.
  if (!cardCols.some((c) => c.name === 'blocked_by')) {
    db.exec("ALTER TABLE card ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'");
    created.push('card.blocked_by');
  }
```

- [ ] **Step 4: Generalize the event-table rebuild guard**

The current guard only fires for `upload_added` and would skip already-migrated databases (review-punt dev a4). Replace the condition:

```ts
  if (eventSql && !eventSql.includes('upload_added')) {
```

with:

```ts
  if (eventSql && EVENT_KINDS.some((k) => !eventSql.includes(`'${k}'`))) {
```

and update the `created.push(...)` message in that block to:

```ts
    created.push('event table rebuilt (event kinds brought up to date)');
```

The rebuild body itself already uses `EVENT_TABLE_BODY`, which interpolates `EVENT_KINDS` — no change needed there.

- [ ] **Step 5: Set busy_timeout on every connection**

In `openDb()`, after the `foreign_keys` pragma:

```ts
  db.pragma('busy_timeout = 5000');
```

In `initData`, after its `journal_mode` pragma:

```ts
  db.pragma('busy_timeout = 5000');
```

- [ ] **Step 6: Build and verify fresh init + idempotence**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
node dist/cli/index.js init
sqlite3 "$AGENTBOARD_DATA/board.db" "PRAGMA table_info(card);" | grep blocked_by
sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT sql FROM sqlite_master WHERE name='event';" | grep blocker_added
```

Expected: build clean; second `init` prints `Already initialized`; both greps match.

- [ ] **Step 7: Verify the generalized guard rebuilds an old event table**

Simulate a pre-blockers database, then run init on it:

```bash
export AGENTBOARD_DATA=$(mktemp -d)/abdata-old
mkdir -p "$AGENTBOARD_DATA"
sqlite3 "$AGENTBOARD_DATA/board.db" "
CREATE TABLE board (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE card (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL, owner TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', context_refs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE comment (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES card(id), kind TEXT NOT NULL CHECK (kind IN ('status_changed','action_taken','context_written','error','upload_added','secret_stored')), actor TEXT NOT NULL CHECK (actor IN ('human','agent')), payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
INSERT INTO board VALUES ('main','main','2026-01-01T00:00:00.000Z');
INSERT INTO event (card_id, kind, actor, payload, created_at) VALUES ('task_0000','action_taken','human','{}','2026-01-01T00:00:00.000Z');
"
node dist/cli/index.js init
sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT sql FROM sqlite_master WHERE name='event';" | grep blocker_added
sqlite3 "$AGENTBOARD_DATA/board.db" "SELECT count(*) FROM event;"
sqlite3 "$AGENTBOARD_DATA/board.db" "PRAGMA table_info(card);" | grep blocked_by
```

Expected: init output includes `card.blocked_by` and `event table rebuilt (event kinds brought up to date)`; grep matches; event count is `1` (rows survive the rebuild).

- [ ] **Step 8: Commit**

```bash
git add src/core/db.ts
git commit -m "feat(core): blocked_by column, blocker_added kind, generalized event migration, busy_timeout"
```

---

### Task 2: Card type + createCard with `--blocks`

**Files:**
- Modify: `src/core/cards.ts`
- Modify: `src/cli/index.ts` (the `card new` command)

**Interfaces:**
- Consumes: Task 1 (`blocked_by` column, `blocker_added` kind).
- Produces: `Card.blocked_by: string[]`; `createCard(input)` accepts `blocks?: string` and `actor?: string` and links the new card as blocker of `blocks` in one transaction; CLI `card new --blocks <id> --as <actor>`. Later tasks rely on `Card.blocked_by` being parsed by `rowToCard`.

- [ ] **Step 1: Extend the Card interface and rowToCard**

In `src/core/cards.ts`, add to `interface Card` after `context_refs`:

```ts
  blocked_by: string[];
```

In `rowToCard`, add:

```ts
    blocked_by: JSON.parse(row.blocked_by ?? '[]'),
```

- [ ] **Step 2: Extend createCard**

Add `blocks?: string; actor?: string` to the input type of `createCard`. Replace the current bare `INSERT` call with a transaction that also links the blocker (the INSERT statement itself is unchanged):

```ts
export function createCard(input: {
  type: string;
  title: string;
  body?: string;
  owner?: string;
  board?: string;
  labels?: string[];
  blocks?: string;
  actor?: string;
}): Card {
  const type = assertType(input.type);
  const owner = assertActor(input.owner ?? 'human');
  const actor = assertActor(input.actor ?? 'human');
  if (!input.title.trim()) throw new Error('Title cannot be empty');

  const db = openDb();
  try {
    const boardId = resolveBoardIn(db, input.board);
    let id: string;
    do {
      id = `${type}_${crypto.randomBytes(2).toString('hex')}`;
    } while (db.prepare('SELECT 1 FROM card WHERE id = ?').get(id));

    const ts = now();
    // --blocks is one transaction: card + blocked_by append + event, or nothing.
    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO card (id, board_id, type, title, body, status, owner, labels, refs, context_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'inbox', ?, ?, '[]', '[]', ?, ?)`
      ).run(id, boardId, type, input.title, input.body ?? null, owner, JSON.stringify(input.labels ?? []), ts, ts);
      if (input.blocks) {
        const target = getCardIn(db, input.blocks);
        db.prepare('UPDATE card SET blocked_by = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify([...target.blocked_by, id]),
          ts,
          target.id
        );
        addEventIn(db, target.id, 'blocker_added', actor, { blocker: id });
      }
    });
    create();
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}
```

(A fresh card cannot introduce a cycle: its own `blocked_by` is empty and nothing references it yet, so no cycle check is needed here.)

- [ ] **Step 3: CLI flags on `card new`**

In `src/cli/index.ts`, add to the `card new` command options:

```ts
  .option('--blocks <id>', 'link this new card as a blocker of <id> (writes blocker_added on that card)')
  .option('--as <actor>', 'human | agent — actor of the blocker_added event', 'human')
```

and pass them through in the action:

```ts
      const c = createCard({
        type: opts.type,
        title: opts.title,
        body: opts.body,
        owner: opts.owner,
        board: opts.board,
        blocks: opts.blocks,
        actor: opts.as,
      });
      const suffix = opts.blocks ? `  blocks ${opts.blocks}` : '';
      output(opts, `Created ${c.id}  ${c.title}  (${c.board_id}, ${c.status})${suffix}`, c);
```

- [ ] **Step 4: Build and verify**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
node dist/cli/index.js card new --type task --title "Taak A" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"
# note the printed id, e.g. task_ab12 — use it below as TASK
node dist/cli/index.js card new --type ops --title "Trello connectie" --blocks TASK --as agent
node dist/cli/index.js card show TASK --json | python3 -m json.tool | grep -A3 blocked_by
node dist/cli/index.js card show TASK | grep blocker_added
node dist/cli/index.js card new --type ops --title "Wees" --blocks task_nope 2>&1
```

Expected: `blocked_by` on TASK contains the ops id; the timeline shows a `blocker_added` event `by agent`; the last command prints `Error: Card not found: task_nope` with exit code 1 and (check with `card show`) creates **no** orphan ops card.

- [ ] **Step 5: Commit**

```bash
git add src/core/cards.ts src/cli/index.ts
git commit -m "feat: card new --blocks links a new ops card as blocker in one transaction"
```

---

### Task 3: editCard `--blocked-by` with existence/self/cycle validation

**Files:**
- Modify: `src/core/cards.ts` (editCard + new helper)
- Modify: `src/cli/index.ts` (the `card edit` command)

**Interfaces:**
- Consumes: Task 2 (`Card.blocked_by`).
- Produces: `editCard(id, { blockedBy?: string[] })` replaces the full list with validation; CLI `card edit <id> --blocked-by ops_a,ops_b` (empty string clears).

- [ ] **Step 1: Add the cycle guard helper**

In `src/core/cards.ts`, near `getCardIn`:

```ts
// A cycle in blocked_by would silently keep both cards out of next forever
// (open-ness is derived, nothing errors). Refuse it at write time.
function assertNoBlockerCycle(db: Database.Database, cardId: string, blockedBy: string[]): void {
  const seen = new Set<string>();
  const stack = [...blockedBy];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === cardId) {
      throw new Error(`Blocker cycle: ${cardId} would (transitively) block itself`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    const row = db.prepare('SELECT blocked_by FROM card WHERE id = ?').get(cur) as
      | { blocked_by: string }
      | undefined;
    if (row) stack.push(...(JSON.parse(row.blocked_by) as string[]));
  }
}
```

- [ ] **Step 2: Extend editCard**

Add `blockedBy?: string[]` to the `fields` type. In the pre-db block, add the sets/values handling next to the other fields:

```ts
  if (fields.blockedBy !== undefined) {
    sets.push('blocked_by = ?');
    values.push(JSON.stringify(fields.blockedBy));
  }
```

Update the "Nothing to edit" error message to include `--blocked-by`. Inside the db block, after `getCardIn(db, id)` and before the board handling, validate:

```ts
    if (fields.blockedBy !== undefined) {
      for (const bid of fields.blockedBy) {
        if (bid === id) throw new Error(`Card ${id} cannot block itself`);
        getCardIn(db, bid); // throws Card not found for dangling ids
      }
      assertNoBlockerCycle(db, id, fields.blockedBy);
    }
```

- [ ] **Step 3: CLI flag on `card edit`**

```ts
  .option('--blocked-by <ids>', 'comma-separated card ids that block this card, empty string clears')
```

and in the action pass:

```ts
        blockedBy: opts.blockedBy !== undefined ? splitList(opts.blockedBy) : undefined,
```

- [ ] **Step 4: Build and verify**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
node dist/cli/index.js card new --type task --title "A" --json   # id -> A
node dist/cli/index.js card new --type task --title "B" --json   # id -> B
node dist/cli/index.js card edit B --blocked-by A                 # B blocked by A: ok
node dist/cli/index.js card edit A --blocked-by B 2>&1            # cycle: must fail
node dist/cli/index.js card edit A --blocked-by A 2>&1            # self: must fail
node dist/cli/index.js card edit A --blocked-by task_nope 2>&1    # dangling: must fail
node dist/cli/index.js card edit B --blocked-by ""                # clears
node dist/cli/index.js card show B --json | grep '"blocked_by": \[\]'
```

Expected: the three failing commands print `Error: Blocker cycle: ...`, `Error: Card A cannot block itself` (with real id), `Error: Card not found: task_nope`; the clear leaves `blocked_by: []`.

- [ ] **Step 5: Commit**

```bash
git add src/core/cards.ts src/cli/index.ts
git commit -m "feat: card edit --blocked-by with existence, self and cycle validation"
```

---

### Task 4: Race-free moveCard (`--from` CAS) with truthful events

**Files:**
- Modify: `src/core/cards.ts` (moveCard)
- Modify: `src/cli/index.ts` (the `card move` command)

**Interfaces:**
- Consumes: nothing beyond Task 1.
- Produces: `moveCard(id, to, { actor, reason, from? })`; CLI `card move <id> <status> --from <status>`. The `status_changed` event's `from` always reflects the transactional read.

- [ ] **Step 1: Rewrite moveCard**

Replace the body of `moveCard` (keep the assert/invariant lines above the db block unchanged, add the `from` assert):

```ts
export function moveCard(id: string, to: string, opts: { actor: string; reason: string; from?: string }): Card {
  const status = assertStatus(to);
  const actor = assertActor(opts.actor);
  const expectedFrom = opts.from !== undefined ? assertStatus(opts.from) : undefined;
  if (!opts.reason?.trim()) throw new Error('A reason is required for every status change');
  // Invariant 2: an agent never moves a card to done, only to review.
  if (actor === 'agent' && status === 'done') {
    throw new Error("An agent may not move a card to 'done'. Move it to 'review'; the human moves it to done.");
  }

  const db = openDb();
  try {
    // Read + conditional UPDATE inside one transaction: the claim. The event's
    // `from` comes from this read, so it can never describe a move that did
    // not happen.
    const move = db.transaction(() => {
      const card = getCardIn(db, id);
      if (expectedFrom && card.status !== expectedFrom) {
        throw new Error(`Card ${id} is not in '${expectedFrom}' (now '${card.status}' — already claimed?)`);
      }
      const result = db
        .prepare('UPDATE card SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .run(status, now(), id, card.status);
      if (result.changes === 0) {
        throw new Error(`Card ${id} changed status concurrently — read it again and retry`);
      }
      // Invariant 1: every status change writes an event with from, to, reason.
      addEventIn(db, id, 'status_changed', actor, { from: card.status, to: status, reason: opts.reason });
    });
    move();
    return getCardIn(db, id);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: CLI flag on `card move`**

```ts
  .option('--from <status>', 'only move when the card is still in this status (the claim)')
```

and pass it: `moveCard(id, status, { actor: opts.as, reason: opts.reason, from: opts.from })`.

- [ ] **Step 3: Build and verify the claim semantics**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
node dist/cli/index.js card new --type task --title "Claim me" --json   # id -> T
node dist/cli/index.js card move T ready --reason "triage"
node dist/cli/index.js card move T doing --from ready --as agent --reason "claim"
node dist/cli/index.js card move T doing --from ready --as agent --reason "claim" 2>&1   # must fail
node dist/cli/index.js card show T --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
ev=[e for e in d['events'] if e['kind']=='status_changed']
print([(e['payload']['from'],e['payload']['to']) for e in ev])"
node dist/cli/index.js card move T review --reason "no from still works"
```

Expected: second claim prints `Error: Card T is not in 'ready' (now 'doing' — already claimed?)` with exit 1; the events list is exactly `[('inbox','ready'), ('ready','doing')]`; the final move without `--from` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/core/cards.ts src/cli/index.ts
git commit -m "feat: conditional status move — card move --from is the race-free claim"
```

---

### Task 5: next filters blocked cards; enrichment (blockers + reverse blocks)

**Files:**
- Modify: `src/core/cards.ts` (nextWork, enrichCardsIn, cardDetail, new BlockerInfo)
- Modify: `src/cli/index.ts` (`card show` text output)

**Interfaces:**
- Consumes: Tasks 1–2 (`blocked_by` parsed on Card).
- Produces:
  - `interface BlockerInfo { id: string; type: CardType; title: string; status: Status }`
  - `EnrichedCard.blockers: BlockerInfo[]` (forward, order of `blocked_by`)
  - `cardDetail(id)` returns `{ card, comments, events, blockers: BlockerInfo[], blocks: BlockerInfo[] }` — `blocks` is the reverse query (cards that have this id in their `blocked_by`).
  - `nextWork()` excludes cards with ≥1 open blocker.
  - The web API exposes all of this unchanged (passthrough), so Task 6 reads `card.blockers` on board tiles and `blockers`/`blocks` on detail.

- [ ] **Step 1: Add BlockerInfo + lookup helper**

In `src/core/cards.ts`:

```ts
export interface BlockerInfo {
  id: string;
  type: CardType;
  title: string;
  status: Status;
}

function blockerInfoIn(db: Database.Database, ids: string[]): BlockerInfo[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, type, title, status FROM card WHERE id IN (${placeholders})`)
    .all(ids) as BlockerInfo[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is BlockerInfo => r !== undefined);
}

const isOpenStatus = (s: Status) => s !== 'done' && s !== 'archived';
```

- [ ] **Step 2: Filter nextWork**

```ts
export function nextWork(): Card[] {
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
    // A card with an open blocker is not workable: it resurfaces by itself
    // when the last blocker goes done/archived (open-ness is derived).
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
```

- [ ] **Step 3: Enrich board cards with blockers**

Add to `interface EnrichedCard`:

```ts
  blockers: BlockerInfo[];
```

In `enrichCardsIn`, resolve all blockers in one query and attach per card. After the existing `lastChange` map is built, add:

```ts
  const blockerIds = [...new Set(cards.flatMap((c) => c.blocked_by))];
  const blockerById = new Map(blockerInfoIn(db, blockerIds).map((b) => [b.id, b]));
```

and extend the returned object per card:

```ts
      blockers: card.blocked_by.map((id) => blockerById.get(id)).filter((b): b is BlockerInfo => b !== undefined),
```

- [ ] **Step 4: cardDetail returns blockers + reverse blocks**

```ts
export function cardDetail(id: string): {
  card: Card;
  comments: Comment[];
  events: BoardEvent[];
  blockers: BlockerInfo[];
  blocks: BlockerInfo[];
} {
  const db = openDb();
  try {
    const card = getCardIn(db, id);
    const comments = db
      .prepare('SELECT * FROM comment WHERE card_id = ? ORDER BY created_at, id')
      .all(id) as Comment[];
    const events = db
      .prepare('SELECT * FROM event WHERE card_id = ? ORDER BY created_at, id')
      .all(id)
      .map(rowToEvent);
    // Reverse direction from the same source of truth (no double bookkeeping):
    // which cards have me in their blocked_by. JS scan — data stays small.
    const rows = db
      .prepare("SELECT id, type, title, status, blocked_by FROM card WHERE blocked_by != '[]'")
      .all() as (BlockerInfo & { blocked_by: string })[];
    const blocks = rows
      .filter((r) => (JSON.parse(r.blocked_by) as string[]).includes(id))
      .map(({ id, type, title, status }) => ({ id, type, title, status }));
    return { card, comments, events, blockers: blockerInfoIn(db, card.blocked_by), blocks };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5: `card show` text output**

In `src/cli/index.ts`, in the `card show` action after the `context:` line:

```ts
      if (detail.blockers.length)
        lines.push(`blocked by: ${detail.blockers.map((b) => `${b.id} (${b.status})`).join(', ')}`);
      if (detail.blocks.length)
        lines.push(`unblocks: ${detail.blocks.map((b) => `${b.id} (${b.status})`).join(', ')}`);
```

- [ ] **Step 6: Build and verify the resurface loop**

```bash
npm run build
export AGENTBOARD_DATA=$(mktemp -d)/abdata
node dist/cli/index.js init
node dist/cli/index.js card new --type task --title "Geblokte taak" --json     # id -> T
node dist/cli/index.js card move T ready --reason triage
node dist/cli/index.js next | grep T                                           # present
node dist/cli/index.js card new --type ops --title "Blocker 1" --blocks T --as agent --json  # -> O1
node dist/cli/index.js card new --type ops --title "Blocker 2" --blocks T --as agent --json  # -> O2
node dist/cli/index.js next | grep -c T                                        # 0: blocked
node dist/cli/index.js card show O1 | grep "unblocks: T"
node dist/cli/index.js card move O1 done --reason "geregeld"
node dist/cli/index.js next | grep -c T                                        # still 0: O2 open
node dist/cli/index.js card move O2 done --reason "geregeld"
node dist/cli/index.js next | grep T                                           # back, untouched
node dist/cli/index.js card show T | grep "blocked by: O1 (done), O2 (done)"
```

Expected: exactly as annotated — T disappears from `next` while any blocker is open and resurfaces by itself, with both resolved blockers still listed on the card. (Use the real generated ids for T/O1/O2 throughout.)

- [ ] **Step 7: Commit**

```bash
git add src/core/cards.ts src/cli/index.ts
git commit -m "feat: next skips cards with open blockers; blockers/unblocks enrichment on board and detail"
```

---

### Task 6: Web UI — chips, timeline line, done-confirmation

**Files:**
- Modify: `web/js/icons.js` (one new icon)
- Modify: `web/js/components.js` (cardTile chip, askReason warning, moveWithReason)
- Modify: `web/js/views/card.js` (structural groups, blocker chips, timeline branch)
- Modify: `web/style.css` (chip styles)

**Interfaces:**
- Consumes: Task 5's API shape — board cards carry `blockers: [{id, type, title, status}]`; `/api/cards/:id` returns top-level `blockers` and `blocks` arrays.
- Produces: display-only UI; no new endpoints, no write paths.

- [ ] **Step 1: Add the block icon**

In `web/js/icons.js`, add to the `icons` object, following the style of the existing entries (size/color params, stroke-based):

```js
  block: (s = 12, c = 'var(--amber-icon, #b45309)') =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m6.3 6.3 11.4 11.4"/></svg>`,
```

(If the file's entries take different parameter names, match them; keep the no-entry glyph.)

- [ ] **Step 2: Blocker chip on the board tile**

In `web/js/components.js`, inside `cardTile`, compute the open count before the template:

```js
  const openBlockers = (card.blockers ?? []).filter((b) => b.status !== 'done' && b.status !== 'archived').length;
```

and render it in the `tile-top` span, directly after `${ageChip(card)}`:

```js
      <span class="tile-id">${idChip(card, { size: compact ? 'sm' : 'md' })}${ageChip(card)}${
        openBlockers ? `<span class="blocked-chip" title="${openBlockers} open blocker${openBlockers === 1 ? '' : 's'}">${icons.block(10)}${openBlockers}</span>` : ''
      }</span>
```

- [ ] **Step 3: Done-confirmation for open blockers**

In `web/js/components.js`:

`askReason` gains an optional warning line. Change the signature to `askReason({ title, toStatus, warning })` and add directly under the `dialog-sub` paragraph:

```js
      ${warning ? `<p class="dialog-warning">${icons.block(12)}${esc(warning)}</p>` : ''}
```

`moveWithReason` computes it (signal, never block — the human stays in charge):

```js
export async function moveWithReason(card, toStatus, onDone) {
  const openBlockers = (card.blockers ?? []).filter((b) => b.status !== 'done' && b.status !== 'archived');
  const warning =
    toStatus === 'done' && openBlockers.length
      ? `Still ${openBlockers.length} open blocker${openBlockers.length === 1 ? '' : 's'}: ${openBlockers.map((b) => b.id).join(', ')}`
      : '';
  const title = toStatus === 'done' && card.status === 'review' ? 'Approve → Done' : `Move to ${toStatus}`;
  const reason = await askReason({ title, toStatus, warning });
  if (reason == null) return;
  try {
    await api.move(card.id, toStatus, reason);
    onDone();
  } catch (err) {
    alertError(err.message);
  }
}
```

- [ ] **Step 4: Card detail — structural groups + chips**

In `web/js/views/card.js`:

Destructure the new keys (the api helper passes JSON through):

```js
  const [{ card, comments, events, blockers = [], blocks = [] }, { artifacts }, { uploads }] = await Promise.all([
```

Attach for `moveWithReason` (which receives `card`): after the destructure add

```js
  card.blockers = blockers;
```

Seed the linked-card groups from structure first, refs second (dedupe by id) — replace the current `groups` block:

```js
  // Linked cards: structural blocked_by/blocks first, ref-labeled cards as
  // the manual fallback (deduped) — the query is the source of truth.
  const groups = { 'blocked by': [...blockers], unblocks: [...blocks], linked: [] };
  const linked = cardRefs(card);
  const seen = new Set([...blockers, ...blocks].map((t) => t.id));
  await Promise.all(
    linked.map(async (ref) => {
      const target = ref.label.match(CARD_ID_RE)[0];
      if (seen.has(target)) return;
      try {
        const { card: t } = await api.card(target);
        const key = /^blocked/i.test(ref.label) ? 'blocked by' : /^unblocks/i.test(ref.label) ? 'unblocks' : 'linked';
        groups[key].push(t);
      } catch {
        /* dangling ref: skip */
      }
    })
  );
```

(The props-panel render of `groups` needs no change: `idChip` uses `type`, `relStatusNote` uses `status` — both present on `BlockerInfo`.)

Add blocker chips in the main chip-row. Replace the chip-row condition/content:

```js
          ${
            card.context_refs?.length || linked.length || blockers.length
              ? `<div class="chip-row">
                  ${blockers
                    .map((b) => {
                      const open = b.status !== 'done' && b.status !== 'archived';
                      return `<a class="blocker-chip${open ? '' : ' resolved'}" href="#/card/${esc(b.id)}">${
                        open ? icons.block(11) : icons.check(11, 'var(--green-icon)')
                      }${esc(b.id)}</a>`;
                    })
                    .join('')}
                  ${(card.context_refs ?? []).map((p) => `<a class="ctx-chip" href="#/ctx/${esc(p)}">${icons.file()}${esc(p)}</a>`).join('')}
                  ${linked.map((r) => cardRefChip(r)).join('')}
                </div>`
              : ''
          }
```

- [ ] **Step 5: Timeline branch for blocker_added**

In `eventLine` in `web/js/views/card.js`, add before the final `else`:

```js
  } else if (e.kind === 'blocker_added') {
    icon = icons.block(14);
    const b = String(e.payload.blocker ?? '');
    text = `<span class="kind">blocker_added</span> by ${esc(e.actor)}: blocked by <a href="#/card/${esc(b)}">${esc(b)}</a>`;
```

- [ ] **Step 6: Styles**

In `web/style.css`, next to the existing chip styles (search for `.label-chip`), add — match the exact font-size/radius/padding idiom used by the neighbouring chips in this file:

```css
.blocked-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fcd34d;
}
.blocker-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  text-decoration: none;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fcd34d;
}
.blocker-chip.resolved {
  color: var(--mut, #6b7280);
  background: transparent;
  border-color: var(--line, #e5e7eb);
  opacity: 0.75;
}
.dialog-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #b45309;
  margin: 2px 0 0;
}
```

- [ ] **Step 7: Verify in the browser + screenshots**

Seed and serve (reuse the Task 5 scratch data or rebuild it), then check with Playwright:

```bash
export AGENTBOARD_DATA=...   # the dir from Task 5 step 6, or recreate it up to "still 0: O2 open"
node dist/cli/index.js serve --port 4667
```

Checks (viewport 1440 wide, screenshots to `docs/design/verify/blockers/`):
1. Board: the blocked task tile shows the amber chip with the open-blocker count → `board-blocked-chip-1440.png`.
2. Task detail: blocker chips in the chip-row (open amber, resolved dimmed with check), "BLOCKED BY" group in the props panel → `detail-blocker-chips-1440.png`.
3. Ops-card detail: "UNBLOCKS" group shows the task → `detail-unblocks-1440.png`.
4. Timeline shows the `blocker_added` rows with clickable card links → `timeline-blocker-added-1440.png`.
5. On the task with an open blocker: status pill → done → the reason dialog shows the amber warning line → `done-warning-1440.png`.
6. Regression: a card without blockers renders identically to before (no empty chip-row artifacts).

- [ ] **Step 8: Commit**

```bash
git add web/ docs/design/verify/blockers/
git commit -m "feat(web): blocker chips, unblocks group, blocker_added timeline line, done warning"
```

---

### Task 7: AGENT.md rule + README table docs

**Files:**
- Modify: `AGENT.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the CLI flags from Tasks 2–4 (exact command shapes below must match them).
- Produces: the framework rule agents follow from the next session on.

- [ ] **Step 1: Add rule 15 to AGENT.md**

After rule 14:

```markdown
15. Blocked on missing foundation? One ops card per missing entity, the
    moment you discover it: `card new --type ops --blocks <task-id>
    --as agent ...` — this links it as a blocker on the task. Then move
    the task back to ready: `next` skips cards with open blockers, and
    the task resurfaces by itself when the last blocker is done. When
    you pick it up again, verify the blockers are really gone. Claim
    every card with `card move <id> doing --from ready --as agent`; if
    that fails, another session got there first — take the next card.
```

- [ ] **Step 2: Update README's table section**

In `README.md` under `## The tables`, extend the **card** row description: after `context_refs` add `` `blocked_by` (JSON array of card ids; a card with an open blocker is skipped by `next`) ``. In the **event** row, extend the kind list with `blocker_added`.

- [ ] **Step 3: Verify consistency**

Read the new rule and run each command in it against the Task 5 scratch data verbatim (substituting real ids). Every command must work exactly as written — the rule is agent-facing documentation and may not drift from the CLI.

- [ ] **Step 4: Commit**

```bash
git add AGENT.md README.md
git commit -m "docs: AGENT.md rule 15 (blockers + claiming), README table update"
```

---

### Task 8: End-to-end verification script

**Files:**
- Create: `docs/superpowers/plans/verify-blockers.sh` (checked in as the reproducible probe for this feature)

**Interfaces:**
- Consumes: everything above.
- Produces: one script that runs the whole spec-§8 scenario and exits non-zero on any deviation.

- [ ] **Step 1: Write the script**

```bash
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
```

- [ ] **Step 2: Run it**

```bash
chmod +x docs/superpowers/plans/verify-blockers.sh
npm run build && docs/superpowers/plans/verify-blockers.sh
```

Expected: `OK: blockers & claiming verified (...)`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/verify-blockers.sh
git commit -m "test: end-to-end probe for blockers & claiming"
```
