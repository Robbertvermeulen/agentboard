# Senior-dev-review agentboard-visie (2026-08-25)

Onafhankelijke review door een senior-dev-reviewer met volledige
gesprekscontext, visiedocument, README, AGENT.md en de volledige codebase.

## Wat gewoon goed is

- De scheiding core (invariants) / dunne CLI / dunne API is in de code echt waargemaakt; invariant 2 en 3 zitten waar ze horen (`moveCard`, `writeContext`).
- Blocked als **afgeleide** toestand (besluit B) is juist: er is geen "unblock"-schrijfactie die vergeten kan worden.
- Claim = conditionele UPDATE is het correcte primitief onder WAL met meerdere processen.
- Routines in context-markdown hergebruiken gratis het bestaande review-kanaal én de frontmatter-validatiehaak — het leanste ontwerp denkbaar.
- `nextWork` met `doing@agent` is impliciet crash-herstel: een gestorven sessie laat een kaart in doing achter en de volgende sessie hervat vanaf de timeline. Expliciet benoemen in de spec van bouwblok 3.

## (a) Fundamenteel — beslissen/aanpassen vóór de bouw

1. **De cron-gate mag niet `next` zijn.** `nextWork()` bevat `needs_input`; een minuut-cron die "next niet leeg → sessie" hanteert, start bij één onbeantwoorde vraag elke minuut een zinloze sessie. De gate moet smaller: `ready` (zonder open blockers) + `doing@agent` + routines-due. `needs_input` wordt alleen heroverwogen door een human-actie of een expliciete wait-check. README noemt `next` nu "the cheap gate for a cron trigger" — corrigeren; overweeg een aparte `agentboard gate --json`.
2. **Secrets lekken straks de sessielogs in.** `secret get` print naar stdout; in een gelogde headless sessie is elke tool-output transcript. Nu al AGENT.md aanscherpen ("waarde nooit naar stdout; altijd `secret get --out`"), en in de blok-4-spec een redactiepas (transcript scannen tegen secrets.env vóór opslag/weergave).
3. **Backups bestaan niet.** board.db, secrets.env, artifacts/, uploads/ zijn onvervangbaar; context-git heeft geen remote. Dagelijkse `VACUUM INTO` (géén `cp` van een WAL-db) + tar naar tweede locatie + remote voor de context-repo. Regelen vóór of naast bouwblok 1.
4. **De event-migratie-guard in `initData` vuurt niet voor `blocker_added`.** De conditie is `!eventSql.includes('upload_added')`; al gemigreerde databases slaan de rebuild over en de CHECK weigert elk `blocker_added`-event. Generaliseer: rebuild zodra een kind uit `EVENT_KINDS` in de opgeslagen CHECK ontbreekt.
5. **Cykels in `blocked_by` zijn stil dodelijk.** A blokkeert B, B blokkeert A → beide voor eeuwig uit `next`, zonder foutmelding. Valideer bij `card edit --blocked-by`: geen self-reference, geen cykel (DFS). Hoort in bouwblok 1.

## (b) Belangrijk — inplannen per bouwblok

**Bouwblok 1 (blockers/claiming):**
- CAS-move: het `from` in het event moet uit de CAS komen (status binnen de transactie), niet uit de losse read ervoor.
- `card new --blocks` als één transactie: kaart + append blocked_by + event, met validatie dat het doel bestaat.
- `web/js/views/card.js`: timeline-rendering moet `blocker_added` kennen.
- Zet `busy_timeout` expliciet in `openDb` — serve + CLI + straks cron schrijven met drie processen.
- UI: bevestiging (geen blokkade) wanneer de mens een kaart met open blockers naar done zet.

**Bouwblok 2 (routines):**
- Schedule-formaat: 5-velden-cron via bestaande parser (`cron-parser`/`croner`), lokale machinetijd; documenteer DST-gedrag.
- Valideer `kind: routine` (parseerbare `schedule:`) in `validateContent`; `routines due` per file try/catch zodat één kapotte file de sweep niet sloopt.
- **Maak de dedup-regel uitvoerbaar:** `card list --ref <url>` (substring over refs) + een nullable `routine`-kolom op card (routinepad). Die kolom voedt ook de ↻-chip en "loopt er nog een kaart van deze routine" — één query.
- Sessie-instructie: de runner geeft due-routinepaden mee in de startprompt; de agent leest ze met `ctx show`. Stille watcher-runs zijn bewust onzichtbaar op het board; last-run-kolom + sessielog zijn de zichtbaarheid.
- Run-state van een verwijderde routine-file is een onschuldige wees.

**Bouwblok 3 (trigger):**
- Eén idempotent `maybe-start-session`-script; twee aanroepers (minuut-cron + serve-laag na human move/comment); de single-flight-lock arbitreert. Event-driven is dus geen tweede architectuur maar dezelfde runner (v1.5 binnen blok 3).
- Lock-file in de data-dir: PID + hostname + started_at; staleness = `process.kill(pid, 0)` + max-leeftijd-vangnet. Documenteer expliciet: **één machine** — gesyncte SQLite + PID-locks over machines is stille corruptie.

**Bouwblok 4/5 (logging/realtime):**
- Logging: headless via `claude -p --output-format stream-json`, JSONL naar `<data>/sessions/<n>.jsonl`; SQLite alleen de index (nummer, start/eind, trigger, exit) + koppeltabel sessie↔kaart (af te leiden uit `agentboard card ...`-aanroepen in de JSONL). Transcripten niet in SQLite. Live = file-tail + SSE.
- Observer-v1: `agentboard observe <sessie>` (handmatig/cron): transcript + visiedocument + AGENT.md beoordelen, rapport als artifact, eventueel ops card bij regelschending. Geen hot-path-magie.
- Realtime: cursor-endpoint `GET /api/events?after=<id>` + 2–3s-polling eerst; SSE later op hetzelfde endpoint. Let op: **comments zijn geen events** — introduceer `comment_added`-event of leg de cursor over beide tabellen. Beslissen in de blok-5-spec.

## (c) Parkeren

- Cross-board blockers: toestaan, niet afdwingen.
- secrets.env read-modify-write-race en gelijktijdige context-commits: theoretisch; single-flight dekt het agent-pad.
- Forward-compat parallelle agents: ooit `session_id` op events (env-var).
- Bulk-archiveren van done-kaarten.
- Reverse-weergave via JS-scan volstaat op deze schaal.

## Antwoorden op de expliciete twijfelvragen

- **JSON-kolom vs join-tabel:** JSON-kolom is juist — consistent met labels/refs, kleine aantallen; join-tabel pas als reverse queries of integriteit echt knellen.
- **Done met open blockers:** toestaan voor de mens, met UI-signaal. Invarianten beperken de agent, nooit de mens.
- **Event-driven nodig voor v1?** Nee — maar "ik zie de kaart realtime naar doing gaan" haalt een kale minuut-cron niet; de serve-hook op dezelfde runner is het goedkoopste dat dat wél haalt (v1.5 binnen blok 3).

**Eindoordeel:** de visie is coherent, de lean-keuzes vrijwel overal juist; geen fundamentele ontwerpfout. De vijf (a)-punten zijn klein maar reëel — vooral de cron-gate en secrets-in-transcripts. Met die vijf verwerkt kan bouwblok 1 zonder voorbehoud gebouwd worden.
