# Agentboard

Lean CLI for an agent-driven Kanban board. Cards live in SQLite (short-lived,
lots of status changes, fast to query). Context lives in markdown + git
(long-lived, readable, diffable). Both live outside this repo, at
`AGENTBOARD_DATA` (default `~/.agentboard`):

```
~/.agentboard/
  board.db              SQLite (all boards)
  secrets.env           chmod 600, never in git
  artifacts/<card-id>/  card-bound work products (agent → you), kept forever
  uploads/<card-id>/    card-bound input files (you → agent), kept forever
  work/                 disposable workdirs (AGENTBOARD_WORK overrides)
  context/              its own git repo
    _global/            above the boards: user.md (profile), shared connections
    freelance/          one dir per board
      _board.md         board profile, overrides _global
      happyshopper/     one dir per client
        _client.md      client profile, overrides board and _global
        akudeco.ssh.md
```

One data dir = one package, holding any number of boards (one per
business). Identity, secrets and context are shared across boards; the
card streams are separated. The profile chain user → board → client is
read top-down; the most specific file wins.

## Run

```
npm install
npm run build
node dist/cli/index.js init      # or: npm link && agentboard init
```

Daily flow:

```
agentboard board                 # all boards; agentboard board <id> for one
agentboard boards list
agentboard boards new plugins --name "Pluginbedrijf"
agentboard card new --type task --title "Fix DNS record" --body "TTL te hoog" --board freelance
agentboard card move task_a3f2 ready --reason "Ochtendtriage"
agentboard card show task_a3f2
agentboard card comment task_a3f2 "Gedaan, TTL nu 300" --as agent
git diff | agentboard card comment task_a3f2 - --as agent   # '-' reads stdin
agentboard card log task_a3f2 "Config aangepast op server" --as agent
agentboard card edit task_a3f2 --labels wp,dns --context-refs chris/vakantiewoningen-nl.md

agentboard ctx list [pad]
agentboard ctx show chris/_client.md
cat file.md | agentboard ctx write chris/_client.md --content - --card ops_b71c --as agent
agentboard secret set ssh_chris_web03   # hidden prompt; or: echo "..." | agentboard secret set naam
agentboard secret get ssh_chris_web03
```

`secret set` never takes the value as an argument (shell history, process
list). On a TTY it prompts with echo off; otherwise it reads stdin.
Multiline secrets (SSH keys): `secret set naam --file <pad>` stores the
file base64 on one line; `secret get naam --out <pad>` writes it back
(chmod 600). So `AGENTBOARD_DATA` stays one portable package.

The web UI has the same rule in write-only form: the secret intake on an
ops card POSTs a value in, and no endpoint can ever read one back —
secret values never travel to the browser, in any form. The card only
shows lock-chips with stored names, fed by `secret_stored` events.

## Files: uploads, workdir, artifacts, context

Four homes, one decision rule — input from you? → uploads. Needed today?
→ workdir. Output belonging to this card? → artifacts. Makes the next
card smarter? → context.

- **Uploads** (`uploads/<card-id>/`): what went in, you → agent. Added
  through the UI (drag-drop, multi-file, zips as-is — the agent unpacks
  deliberately). Permanent: a name conflict gets a suffix, nothing is
  ever overwritten or deleted. Each file writes an `upload_added` event.

- **Workdir** (`AGENTBOARD_WORK`, default `<data>/work`): disposable,
  reconstructable from context + secrets, excluded from backups.
  Disposable means replaceable, not short-lived — a clone may sit there
  for weeks; the remote repo is the durable home of code work. The path
  mirrors the resource file that describes the repo or system
  (`freelance/acme/site-repo.md` → `work/freelance/acme/site-repo/`).
  Repo work: branch `card/<id>`, card id in commit messages, and every
  working session ends with commit + push plus a timeline event.
- **Artifacts** (`artifacts/<card-id>/`): work products that must outlive
  the workdir — a generated PDF awaiting approval, proof of what was
  delivered. Part of the package, never deleted (invariant 4), referenced
  from timeline events.
- **Context**: knowledge only. Binaries go under `<client>/assets/` with
  a companion markdown file (`kind: resource`, `file:` field) as the
  findable, diffable item. Context is not an archive; deliverables ship
  via their channel (mail, Trello, a repo) and leave an event behind.

## Backup

Everything except `work/` is irreplaceable. `agentboard backup` writes
one `tar.gz` (chmod 600 — it contains secrets.env) to
`~/.agentboard-backups` or `--out <dir>`: a `VACUUM INTO` snapshot of
the db (a live WAL db cannot be cp'd safely) plus secrets.env,
artifacts/, uploads/ and the context repo with its git history.
Schedule it daily (cron/launchd) with `--out` on a second disk or
synced folder, and give the context repo a git remote — the tool does
neither for you.

## Trigger (design, not built)

Unattended operation is three layers; only the first lives in this tool:

1. `agentboard next` — the worklist query (ready, doing@agent,
   needs_input). Empty list = no agent session, so a scheduler stays
   cheap.
2. A launchd/cron job outside the tool: run `agentboard next --json`;
   if non-empty, start a headless agent session with AGENT.md.
3. Session behavior is already covered by AGENT.md rules 2 and 8
   (timeline as memory) and rule 11 (no external sends without approval).

## External refs

A ref on a card says *what* (a Trello card, an email, a repo). *How* to
reach it runs through the card's `context_refs`: resource file (e.g.
`happyshopper/trello-board.md`) → `connection` file (e.g.
`_global/trello.md`) → `secret_ref` → `secrets.env`. New services (Gmail,
GitHub, ...) become new `kind: connection` files in the same chain — no
extra structure in `refs` itself.

Multiple connections of the same type can coexist (two business
mailboxes): each gets its own file in `_global/`, and the client or
resource file names which one applies.

Wait-states ("mailed Chris, awaiting reply") are free-text events on the
blocked card — the timeline is the agent's memory between sessions
(AGENT.md rule 8). If that ever proves too fragile for a cron trigger,
the landing spot is a structured `check` field in the event payload
(already JSON) — not a new card type or table.

Every command takes `--json`. Errors go to stderr with exit code 1.

## The tables

**board** — `id` (slug, e.g. `freelance`), `name`, `created_at`. One row
per business.

**card** — `id` (`task_a3f2` / `ops_b71c`), `board_id`, `type` (task|ops), `title`,
`body`, `status` (inbox|ready|doing|needs_input|review|done|archived),
`owner` (human|agent), `labels` (JSON array), `refs` (JSON array
`[{label, url?, note?}]`, deliberately unstructured), `context_refs`
(JSON array of context paths), `blocked_by` (JSON array of card ids;
a card with an open blocker is skipped by `next`), `created_at`,
`updated_at`.

**comment** — `id`, `card_id`, `author` (human|agent), `body`, `created_at`.
Comments are for talking to the user.

**event** — `id`, `card_id`, `kind` (status_changed | action_taken |
context_written | error | upload_added | secret_stored | blocker_added), `actor`
(human|agent), `payload` (JSON), `created_at`. Events are the log of
what happened. `secret_stored` carries the name only, never the value.

## The four invariants (enforced in core, not in the CLI)

1. Every status change writes an event with `from`, `to`, `reason`.
2. An agent (`--as agent`) may not move a card to `done` — only to `review`.
   The human moves it to done from review.
3. Every write to `context/` is exactly one git commit (card id in the
   message, e.g. `ctx: add site vakantiewoningen-nl (ops_b71c)`) plus one
   `context_written` event on that card. Failed validation commits nothing.
4. Delete does not exist. Cards get `status: archived`; context files go via
   `git rm` (they stay in history).

## Context files

Markdown with YAML frontmatter. Directory name = client, `_global/` for
everything not client-bound. Free-form, except: `kind` is required, and
`kind: connection` requires `secret_ref`. A `secret_ref` is always a name —
the value lives in `secrets.env` (`ssh_chris_web03` → `SSH_CHRIS_WEB03`).
A real key in a `.md` is a bug; `ctx write` refuses content containing a
private key block.

Learned in practice (first week):

- `secret_ref` is a name **or a list of names** — real connections tend to
  need two (Trello: key + token, SSH: key + passphrase).
- Secrets are named after what they *are*, not per client
  (`ssh_macbook16`), so one key can serve multiple connection files.
- `kind` says how a file is *treated*, not what it happens to be. The
  vocabulary: `profile` (the user, `_global/user.md`), `board` (a board's
  `_board.md`), `client` (a client's `_client.md`), `connection` (how to
  reach something, has `secret_ref`), `resource` (an external thing,
  points to its connection). Observed, not enforced — only `connection`
  has rules.
- File names, frontmatter keys and `kind` values are English; file
  *content* is in the user's language.
- Resource files point to their connection via a `connection:` field
  (see External refs below).

## CLI flags beyond the bare minimum

Each of these exists because the schema or an invariant needs it:

- `--as <human|agent>` on `card move`, `card comment`, `ctx write` — who is
  acting; becomes the event `actor` / comment `author`. Default `human`.
- `card new --owner <human|agent>` — sets the card's owner column.
- `ctx write --card <id>` — invariant 3 needs a card for the commit message
  and the `context_written` event. `--message` overrides the default commit
  message.
- `card new --blocks <id>` — links the new card as blocker in one
  transaction with the `blocker_added` event; `--as` sets that event's
  actor.
- `card move --from <status>` — the race-free claim: moves the card only
  if it is still in that status.
- `card edit --blocked-by <ids>` — full-list replace, validated for
  existence, self-blocking and cycles.

## Structure

```
src/core/    all domain logic: cards.ts, context.ts, db.ts
src/cli/     thin commander layer, zero logic
AGENT.md     static framework prompt for the agent working the board
```

`AGENT.md` is the same for every user of agentboard. The dynamic,
user-specific part of the system prompt lives in the data layer:
`_global/user.md` (who you are, language, writing rules) and per-client
`_client.md` files. AGENT.md points there; the user fills it in.

No ORM, no tests, no auth, no sync, no scheduler. Core is a plain
module; the thin Hono API and the no-build web UI (`agentboard serve`)
sit on top of it.
