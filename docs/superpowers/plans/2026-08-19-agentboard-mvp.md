# Agentboard MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lean CLI for an agent-driven Kanban board: cards in SQLite, long-lived context in markdown + git, both outside the repo.

**Architecture:** `src/core/` holds all domain logic (cards.ts, context.ts, db.ts); `src/cli/index.ts` is a thin commander layer with zero logic. Data lives at `AGENTBOARD_DATA` (default `~/.agentboard`): `board.db` (SQLite), `secrets.env` (chmod 600), `context/` (its own git repo).

**Tech Stack:** Node 24 + TypeScript (NodeNext ESM), better-sqlite3 (raw SQL, no ORM), commander, gray-matter, simple-git.

**Spec:** `startprompt-agentboard.md` (removed from the tree on 2026-09-03, see git history) — the plan argues from that spec; read both.

## Global Constraints

- Build nothing that is not in the spec. Small, readable, minimal abstraction.
- No tests (spec: "Geen tests"). Every task verifies via real CLI runs against a scratch `AGENTBOARD_DATA`. Clear error messages required.
- No auth, no sync, no scheduler, no UI, no HTTP server.
- The four invariants live in core, never in the CLI:
  1. Every status change writes an `event` with `from`, `to`, `reason`.
  2. An agent actor may not move a card to `done` — only to `review`. (Spec wording is "owner: agent"; AGENT.md clarifies the rule is "You never move a card to done. The user does that from review." Enforced on the acting party, else nobody could ever complete an agent-owned card.)
  3. Every write to `context/` = exactly one git commit (card id in the message) + one `context_written` event.
  4. Delete does not exist. `status: archived` for cards, `git rm` for context.
- `refs` stays unstructured JSON. Do not add structure.
- Plain-text compact output; `--json` on every command.
- Statuses: `inbox|ready|doing|needs_input|review|done|archived`. Types: `task|ops`. Owner/author/actor: `human|agent`.
- Card ids: `<type>_<4 hex>`, e.g. `task_a3f2`.
- Frontmatter contract for context files: `kind` required always; `secret_ref` required when `kind: connection`. A real secret value in a `.md` is a bug → refuse content containing a `PRIVATE KEY` block.
- Necessary CLI additions not literally in the spec's command list (each forced by the schema or an invariant): `card new --owner`, `--as <human|agent>` on `card move` / `card comment` / `ctx write` (event actor / comment author, default `human`), `ctx write --card <id>` (invariant 3 needs a card id for commit message + event), `ctx write --message` (optional override; default `ctx: add|update <name> (<card>)`).

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`

**Interfaces:**
- Produces: `npm run build` → `dist/`; bin `agentboard` → `dist/cli/index.js`. Deps: better-sqlite3, commander, gray-matter, simple-git; dev: typescript, @types/node, @types/better-sqlite3.

- [x] Step 1: `npm init`-style package.json — `"type": "module"`, bin `agentboard`, scripts `build: tsc`.
- [x] Step 2: tsconfig — NodeNext module/resolution, ES2022 target, strict, outDir dist, rootDir src.
- [x] Step 3: `npm install` deps + dev deps. Verify: exit 0, better-sqlite3 native build succeeds.
- [x] Step 4: Commit `chore: scaffold node+ts project`.

### Task 2: db.ts + `agentboard init`

**Files:**
- Create: `src/core/db.ts`, `src/cli/index.ts` (init command only)

**Interfaces:**
- Produces: `dataDir(): string` (env `AGENTBOARD_DATA` or `~/.agentboard`); `openDb(): Database` (clear error "Not initialized. Run 'agentboard init' first." when board.db missing); `initData(): { dataDir: string; created: string[] }` — creates dir, board.db schema (card/comment/event exactly per spec, comment/event id INTEGER PK AUTOINCREMENT, card id TEXT PK), `secrets.env` mode 0600, `context/` with `git init` via simple-git. Idempotent: skips what exists, reports what it created.

- [x] Step 1: Implement db.ts with schema SQL verbatim from spec columns; timestamps as ISO-8601 UTC strings.
- [x] Step 2: Wire `agentboard init` in CLI with `--json`; global error handler prints `Error: <msg>` to stderr, exit 1 (`{"error": ...}` under --json).
- [x] Step 3: Verify with `AGENTBOARD_DATA=<scratch>`: run init twice (second run creates nothing), `ls -la` shows `-rw-------` on secrets.env, `git -C context status` works, sqlite tables exist.
- [x] Step 4: Commit `feat: init + db layer`.

### Task 3: cards.ts + card/board commands

**Files:**
- Create: `src/core/cards.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Produces:
  - `createCard({type, title, body?, owner?}): Card` — id `<type>_<hex4>` with collision retry, status `inbox`, owner default `human`.
  - `getCard(id): Card` (JSON columns parsed; "Card not found: <id>").
  - `boardView(): Record<status, Card[]>` — status order as spec, archived excluded (board is a working view; archived stays queryable via `card show`).
  - `moveCard(id, to, {actor, reason}): Card` — validates status; invariant 2 (`actor==='agent' && to==='done'` → error telling agent to use review); writes `status_changed` event `{from,to,reason}`; bumps updated_at. Reason required (invariant 1).
  - `addComment(id, body, author): Comment`.
  - `editCard(id, {title?, body?, labels?, refs?, contextRefs?}): Card` — labels/context-refs comma-separated in CLI, refs raw JSON string (stays unstructured); bumps updated_at.
  - `cardDetail(id): {card, comments, events}`; CLI renders body then one chronological timeline of comments+events.
  - `addEvent(cardId, kind, actor, payload)` — exported for context.ts (invariant 3).
- CLI: `board`, `card new --type --title [--body] [--owner]`, `card show <id>`, `card move <id> <status> --reason <r> [--as]`, `card comment <id> <text> [--as]`, `card edit <id> [--title|--body|--labels|--refs|--context-refs]`. All with `--json`.

- [x] Step 1: Implement cards.ts.
- [x] Step 2: Wire CLI subcommands (thin: parse flags → call core → print).
- [x] Step 3: Verify against scratch data dir: new → board shows under inbox → move with reason → show lists event with from/to/reason → `--as agent` move to done errors → move to review succeeds → comment + edit reflected → bad status / missing card / missing --reason give clear errors → `--json` emits valid JSON on each.
- [x] Step 4: Commit `feat: cards core + card/board commands`.

### Task 4: context.ts + ctx/secret commands

**Files:**
- Create: `src/core/context.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Produces:
  - `listContextFiles(sub?): string[]` — sorted relative paths under `context/` (skip `.git`), error if sub doesn't exist.
  - `readContext(path): {path, raw, frontmatter, content}` via gray-matter.
  - `writeContext(path, content, {cardId, actor, message?})` — validates card exists, frontmatter `kind` required, `secret_ref` required when `kind: connection`, refuses `PRIVATE KEY` blocks; mkdir -p; one `git add`+`commit` (default msg `ctx: add|update <basename sans .md> (<cardId>)`); one `context_written` event `{path, message, action}`. Returns `{path, action, message, commit}`.
  - `getSecret(name): string` — parses `secrets.env`, lookup `name.toUpperCase()`, clear errors for missing file/name.
- CLI: `ctx list [pad]` (indented tree render — presentation only), `ctx show <pad>`, `ctx write <pad> --content <text|-> --card <id> [--message] [--as]` (`-` = stdin), `secret get <naam>`. All with `--json`.

- [x] Step 1: Implement context.ts.
- [x] Step 2: Wire CLI.
- [x] Step 3: Verify: write a connection file via stdin against an ops card → git log in context repo shows exactly one commit with card id → card show lists `context_written` event → second write = update commit → missing `kind` / missing `secret_ref` on connection / unknown card / PRIVATE KEY content each refused with clear message and no commit → `ctx list` tree, `ctx show`, `secret get` (hit + miss) work.
- [x] Step 4: Commit `feat: context core + ctx/secret commands`.

### Task 5: AGENT.md + README

**Files:**
- Create: `AGENT.md` (verbatim from spec), `README.md`

**Interfaces:**
- README covers: the three tables, the four invariants, how to run (install, build, init, daily flow, `AGENTBOARD_DATA`), the small CLI additions (`--as`, `--owner`, `--card`) and why.

- [x] Step 1: Write both files.
- [x] Step 2: Cross-check README invariants/tables against code.
- [x] Step 3: Commit `docs: AGENT.md + README`.

### Task 6: End-to-end pass

- [x] Step 1: Fresh scratch `AGENTBOARD_DATA`; run the spec's "first session with a client" flow: init → ops card "Toegang nodig: site X" → comment with details → ctx write `acme/webshop.ssh.md` → move to review → move to done as human.
- [x] Step 2: Confirm every command supports `--json` and non-zero exit + stderr on errors.
- [x] Step 3: Commit any fixes; merge branch to main.

## Self-Review

- Spec coverage: init/board/card new-show-move-comment-edit/ctx list-show-write/secret get → Tasks 2–4. Storage layout + chmod 600 → Task 2. Invariants 1–4 → Task 3 (1,2), Task 4 (3), 4 = absence of delete. AGENT.md + README → Task 5. First-session flow → Task 6. No HTTP/auth/sync/scheduler/UI → nothing planned. ✓
- No placeholders: each step names exact behavior, flags, and error cases. ✓
- Type consistency: `addEvent` produced in Task 3, consumed in Task 4; status/type/owner literals fixed in Global Constraints. ✓
