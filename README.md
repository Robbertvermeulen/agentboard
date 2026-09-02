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
A re-request after a failed value (a new comment with a `secret_ref:`
line) renders the intake under that comment and marks the earlier chips
"needed again".

The web UI also has an Agent log page (sidebar, next to Routines): the
session list with derived outcomes, and a running session's detail page
that follows along live via the same realtime channel.

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

Session logs (`sessions/*.jsonl`, `.stderr.log`, `*-observation.md`)
are deliberately excluded — they're working logs, not source data.
`sessions prune --older-than 30d|12h|45m` is the cleanup channel for
them.

## Routines

Recurring work is a context file (`kind: routine`) under a board dir:
a 5-field cron `schedule:` (local machine time — "mon 09:00" does not
shift with DST), the ops `card:` it was approved on, an optional
`name:` and `enabled:`, and a free-text body: the instruction for the
agent. Job or watcher is phrasing, not mechanism.

Run-state lives in SQLite (`routine_run`), not in git. A routine is
seeded at first sight (not due right after approval); `agentboard
routines due --json` is the scheduler's question, `routines mark
<path>` stamps a run at session start, `routines list` shows
everything. Cards spawned by a routine (`card new --routine <path>`)
start in ready — the approval happened on the routine — and carry the
path for the dedup check (`card list --routine/--ref`). The UI lists
routines read-only; pausing is the only direct action and commits
`enabled: false` through the normal context channel.

## Trigger

Unattended operation is three layers: the gate, the runner, and your clock:

1. **Gate** — `agentboard gate --json` is the scheduler's question: ready
   cards without open blockers, cards in doing@agent, and cards with
   expired wait-checks. Bare needs_input never counts — one unanswered
   question must not start a session every minute. Only an expired
   wait-check brings a needs_input card back to the gate.
2. **Runner** — `agentboard runner` is a single-flight lock protecting
   the gate + session. Lock lives in `session.lock` (stale if a dead
   process owns it or if `AGENTBOARD_LOCK_MAX_AGE` minutes have passed,
   default 120). The runner marks due routines, spawns a headless agent
   session via `AGENTBOARD_SESSION_CMD` (default `claude -p
   --output-format stream-json --verbose`), passes `AGENTBOARD_AGENT_MD`
   (path to AGENT.md) and the due routine paths to the prompt, logs raw
   output to `sessions/<nr>.jsonl` (+ `.stderr.log`), and sends a
   one-line handback summary to `AGENTBOARD_NOTIFY_CMD` (optional — e.g.
   a script that posts to a webhook). Dry-run: `agentboard runner
   --dry-run`.
3. **Clock** — install the scheduler via cron or launchd (macOS). Cron:

   ```
   * * * * * cd ~ && agentboard runner --trigger cron
   ```

   Or launchd plist (save as `~/Library/LaunchAgents/agentboard.plist`,
   then `launchctl load` it):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
   "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>uk.agentboard</string>
     <key>ProgramArguments</key>
     <array>
       <string>/usr/local/bin/agentboard</string>
       <string>runner</string>
       <string>--trigger</string>
       <string>cron</string>
     </array>
     <key>EnvironmentVariables</key>
     <dict>
       <key>AGENTBOARD_DATA</key>
       <string>/Users/your-user/.agentboard</string>
       <key>AGENTBOARD_LOCK_MAX_AGE</key>
       <string>120</string>
     </dict>
     <key>StartInterval</key>
     <integer>60</integer>
   </dict>
   </plist>
   ```

**One machine per data dir.** Synced SQLite + PID locks across
machines creates silent corruption; the lock refuses foreign
hostnames. Install agentboard on each machine separately.

**Serve-hook** — when `AGENTBOARD_AUTORUN=1`, a human move or
comment via the UI pokes the runner (to surface an urgent card
immediately, rather than wait for the cron tick).

**Wait-states** — log a wait with `card log <id> "check thread X
in gmail-zakelijk" --as agent --check-after 2d`. The card leaves
"Needs me" and the gate brings it back when the check time expires,
allowing the next session to pick up where you left off.

## Sessions

Transcripts live in `sessions/` (JSONL + stderr). Each session gets a
numeric id; the runner stamps `started_at`, `ended_at` (null if running),
`trigger` (cron|serve|manual|observe), `exit_status`, and `handed_back`
(cards returned to the user). The session is the working log; the
timeline (event history on cards) stays the durable truth.

Commands: `agentboard sessions list` (all, newest first), `sessions
show <nr>` (meta + parsed steps, secrets redacted), `sessions prune
--older-than 30d|12h|45m` (logs + index rows; running sessions kept).
Pruning is the one place delete exists; it's safe because the timeline
outlives the transcript.

Secrets redaction happens at display time. The raw JSONL file on disk
shares `secrets.env`'s trust boundary — AGENT.md rule 4 guards the
prompt, this is the net. Every `secrets.env` value (and decoded lines
from base64 values) becomes `[secret:name]` in show/web views.

The runner records a heartbeat: `session.started_at` is when the session
began. If a session never ends (`ended_at` is null), the runner crashed
or hung; the lock timeout (default 120 minutes) will unblock the next
cron tick.

### Observer

`agentboard observe <nr>` re-reads a finished session and judges it
against AGENT.md (and, if given, a vision document): a short markdown
report lands at `sessions/<nr>-observation.md` — verdict (pass or
violation), findings, concrete improvements — and, only on a real
violation, one ops card on the board of the card involved. It refuses
a still-running session (`ended_at` is null — the transcript is
incomplete) and a session whose own trigger is `observe` (no observing
the observer).

`--vision <path>` or `AGENTBOARD_VISION` points at the vision document
the rulebook serves; without either, the observer judges against
AGENT.md alone. The observation runs through `runSession` itself
(trigger `observe`), so it is a session like any other — same lock,
same capture, same crash net — and shows up in `sessions list`.

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

Wait-states ("mailed Chris, awaiting reply") are logged with
`check_after`, a structured timestamp on the event payload. The gate
brings the card back when the check time expires, allowing the next
session (cron or manual) to pick it up — see rule 8 and the Trigger
section for details.

Every command takes `--json`. Errors go to stderr with exit code 1.

## The tables

**board** — `id` (slug, e.g. `freelance`), `name`, `created_at`. One row
per business.

**card** — `id` (`task_a3f2` / `ops_b71c`), `board_id`, `type` (task|ops), `title`,
`body`, `status` (inbox|ready|doing|needs_input|review|done|archived),
`owner` (human|agent), `labels` (JSON array), `refs` (JSON array
`[{label, url?, note?}]`, deliberately unstructured), `context_refs`
(JSON array of context paths), `blocked_by` (JSON array of card ids;
a card with an open blocker is skipped by `next`), `routine` (nullable
routine path; spawned cards start in ready), `created_at`,
`updated_at`.

**comment** — `id`, `card_id`, `author` (human|agent), `body`, `created_at`.
Comments are for talking to the user.

**event** — `id`, `card_id`, `kind` (status_changed | action_taken |
context_written | error | upload_added | secret_stored | blocker_added), `actor`
(human|agent), `payload` (JSON), `created_at`. Events are the log of
what happened. `secret_stored` carries the name only, never the value.

**routine_run** — `path`, `last_run_at`. One row per routine, stamped at
session start.

**session** — `id` (autoincrement), `started_at`, `ended_at` (null if
still running), `trigger` (cron|serve|manual), `exit_status` (null if
running), `handed_back` (JSON array of `{id, to}` handbacks). One row
per runner invocation; the transcript lives in `sessions/<id>.jsonl` +
`.stderr.log`.

**session_card** — `session_id`, `card_id`. Many-to-many: mined from the
transcript at session end. Used to link sessions to cards they touched.

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
- `card new --routine <path>` — spawns a card from a routine file; the
  card starts in ready (the routine holds the approval), and records the
  routine path for the rule-16 dedup check.
- `card list --routine <path>` — find cards spawned by a routine.
- `card list --ref <key>` — find cards tagged with a given ref key
  (rule-16 dedup check for watchers).
- `card log --check-after <when>` — log a wait-state: the scheduler
  brings the card back when the check time expires (30m/6h/2d or ISO
  format). Mandatory for wait states; without it the card only returns
  when the user acts.

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
