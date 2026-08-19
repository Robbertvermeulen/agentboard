# Agentboard

Lean CLI for an agent-driven Kanban board. Cards live in SQLite (short-lived,
lots of status changes, fast to query). Context lives in markdown + git
(long-lived, readable, diffable). Both live outside this repo, at
`AGENTBOARD_DATA` (default `~/.agentboard`):

```
~/.agentboard/
  board.db              SQLite
  secrets.env           chmod 600, never in git
  context/              its own git repo
    _global/
    chris/
      _client.md
      vakantiewoningen-nl.ssh.md
```

## Run

```
npm install
npm run build
node dist/cli/index.js init      # or: npm link && agentboard init
```

Daily flow:

```
agentboard board
agentboard card new --type task --title "Fix DNS record" --body "TTL te hoog"
agentboard card move task_a3f2 ready --reason "Ochtendtriage"
agentboard card show task_a3f2
agentboard card comment task_a3f2 "Gedaan, TTL nu 300" --as agent
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

## External refs

A ref on a card says *what* (a Trello card, an email, a repo). *How* to
reach it runs through the card's `context_refs`: resource file (e.g.
`happyshopper/trello-board.md`) → `connection` file (e.g.
`_global/trello.md`) → `secret_ref` → `secrets.env`. New services (Gmail,
GitHub, ...) become new `kind: connection` files in the same chain — no
extra structure in `refs` itself.

Every command takes `--json`. Errors go to stderr with exit code 1.

## The three tables

**card** — `id` (`task_a3f2` / `ops_b71c`), `type` (task|ops), `title`,
`body`, `status` (inbox|ready|doing|needs_input|review|done|archived),
`owner` (human|agent), `labels` (JSON array), `refs` (JSON array
`[{label, url?, note?}]`, deliberately unstructured), `context_refs`
(JSON array of context paths), `created_at`, `updated_at`.

**comment** — `id`, `card_id`, `author` (human|agent), `body`, `created_at`.
Comments are for talking to the user.

**event** — `id`, `card_id`, `kind` (status_changed | action_taken |
context_written | error), `actor` (human|agent), `payload` (JSON),
`created_at`. Events are the log of what happened.

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
- `kind` values seen so far: `client`, `connection`, `board`. Observed, not
  enforced — only `connection` has rules.
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

## Structure

```
src/core/    all domain logic: cards.ts, context.ts, db.ts
src/cli/     thin commander layer, zero logic
AGENT.md     system prompt for the agent working the board
```

No ORM, no HTTP server, no tests, no auth, no sync, no scheduler, no UI.
Core is a plain module so an API and UI can land on top later.
