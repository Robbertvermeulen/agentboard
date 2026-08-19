# Startprompt — Agentboard MVP

Plak dit in Claude Code, in een lege map.

---

## De prompt

Bouw een lean CLI voor een agent-aangestuurd Kanban-board. Ik ga hem gebruiken terwijl ik hem doorontwikkel — dus klein, leesbaar, weinig abstractie. Bouw niets wat hier niet staat.

### Twee opslaglagen

**Kaarten in SQLite** — kortlevend, veel statuswijzigingen, moet snel te queryen zijn.
**Context in markdown + git** — langlevend, moet leesbaar en diff-baar zijn.

Beide staan buiten de repo, op `AGENTBOARD_DATA` (default `~/.agentboard`):

```
~/.agentboard/
  board.db              SQLite
  secrets.env           chmod 600, nooit in git
  context/              git repo
    _global/
      gmail-zakelijk.md
    chris/
      _client.md
      vakantiewoningen-nl.md
      vakantiewoningen-nl.ssh.md
```

Zo kan ik in dezelfde map de tool gebruiken én de repo verbeteren zonder klantdata in git.

### Stack

Node + TypeScript. better-sqlite3, commander, gray-matter, simple-git. Geen ORM, gewoon SQL. Geen HTTP-server in V1 — core is een losse module zodat er later een API en UI overheen kan.

```
src/core/    domeinlogica: cards.ts, context.ts, db.ts
src/cli/     dunne laag, nul logica
AGENT.md     system prompt
```

### Schema

```sql
card
  id            TEXT PK      -- 'task_a3f2' / 'ops_b71c'
  type          TEXT         -- task | ops
  title         TEXT NOT NULL
  body          TEXT
  status        TEXT         -- inbox|ready|doing|needs_input|review|done|archived
  owner         TEXT         -- human | agent
  labels        TEXT         -- JSON array
  refs          TEXT         -- JSON array [{label, url?, note?}]
  context_refs  TEXT         -- JSON array van paden: ["chris/vakantiewoningen-nl.md"]
  created_at, updated_at

comment
  id, card_id, author (human|agent), body, created_at

event
  id, card_id, kind, actor, payload (JSON), created_at
  -- kind: status_changed | action_taken | context_written | error
```

`refs` blijft bewust ongestructureerd. Ik weet nog niet hoe ik ze gebruik. Niet verder structureren tot ik echte voorbeelden heb.

### Contextbestanden

Markdown met YAML-frontmatter. Mapnaam = klant, `_global/` voor niet-klantgebonden. Vrije vorm, behalve `kind` (verplicht) en `secret_ref` bij connecties.

```markdown
---
kind: connection
protocol: ssh
host: web03.hosting.nl
user: chrisvw
secret_ref: ssh_chris_web03
verified_at: 2026-08-19
---

# SSH — vakantiewoningen.nl

WP-root: /var/www/vakantiewoningen/public
```

`secret_ref` is altijd een naam, nooit een waarde. De waarde staat in `secrets.env` als `SSH_CHRIS_WEB03`. Een echte key in een `.md` is een bug.

Elke schrijfactie naar `context/` doet meteen `git commit` met de kaart-id in het bericht:

```
ctx: add site vakantiewoningen-nl (ops_b71c)
```

### Invarianten (in core, niet in de CLI)

1. Elke statuswissel schrijft een `event` met `from`, `to`, `reason`.
2. `owner: agent` mag niet naar `done` — alleen naar `review`.
3. Elke schrijfactie naar context = één git commit + één `context_written`-event.
4. Verwijderen bestaat niet. `status: archived` voor kaarten, `git rm` voor context (staat in de historie).

### CLI

```
agentboard init                       datamap + schema + git init

board                                 kaarten gegroepeerd per status
card new --type --title [--body]
card show <id>                        body + comments + events chronologisch
card move <id> <status> --reason
card comment <id> <text>
card edit <id> [--title|--body|--labels|--refs|--context-refs]

ctx list [pad]                        boom van contextbestanden
ctx show <pad>
ctx write <pad> --content -           schrijft + commit
secret get <naam>                     leest uit secrets.env
```

Output plain text, compact. `--json` op elk commando.

### Verder

- README: de drie tabellen, de vier invarianten, hoe ik draai.
- Geen tests. Wel duidelijke foutmeldingen.
- Geen auth, geen sync, geen scheduler, geen UI, geen HTTP.

---

## AGENT.md

Root van de repo. De agent leest dit elke sessie.

```markdown
# Agent instructions

You work a Kanban board. Each card is a self-contained unit of work with its
own conversation, timeline and context references. You never start from a
blank chat — you always start from a card.

## Card types
- **task** — work to be done: code, research, an email, a post.
- **ops** — work on the system itself: a missing connection, credential,
  decision or piece of context. You create these when you are blocked.

## Statuses
inbox → ready → doing → needs_input → review → done, plus archived.

- Only the user moves inbox → ready.
- You may move ready → doing → review.
- Blocked? Move to needs_input and create an ops card stating exactly what
  you need and which card it unblocks.
- You never move a card to done. The user does that from review.

## Rules
1. Every status change writes an event. No exceptions.
2. Before acting: read the card body, its comments, and its context refs.
3. Never invent credentials, hosts, or facts. Missing means an ops card.
4. Never write a secret into a context file. Only a secret_ref.
5. Context changes go through an ops card. Write the file, show the user the
   diff, and only ask for approval on what you actually wrote — not on a plan.
6. Log what you did as events. Comments are for talking to the user.

## Tone
Write in Dutch. Max 100 words per comment unless more is genuinely needed.
The user scans ten cards in the morning and must be able to answer without
reading himself in. Give enough context to decide — nothing more. No jargon,
no summaries of summaries. If you need a decision, ask one clear question.
```

---

## Eerste sessie met Chris

1. `ctx write chris/_client.md` — wie is Chris, welke sites, hoe communiceert hij.
2. Per site een **ops**-kaart: *"Toegang nodig: site X"*. Jij plakt de gegevens in een comment, de agent schrijft het contextbestand, jij ziet de diff en keurt goed vanuit `review`.
3. Na 2–3 sites weet je of de frontmatter klopt. Pas het dán aan.
4. Eerste **task**-kaart pakken en kijken waar het schuurt.

Wat je die eerste week leert over `refs` en over de frontmatter is meer waard dan alles wat je nu vooraf kunt bedenken.
