# Spec: routines (bouwblok 2)

Datum: 2026-08-26. Kader: `2026-08-24-agentboard-vision.md` (besluiten D,
E en G; journey 7). Design: artboard `2e` (+ ↻-chip in `2a`/`2c`) van
design v4, samengevat in `docs/design/design-update-2026-08-25-summary.md`.

## Doel

Terugkerend werk als review-gated definitie: een routine is een
context-file met een schedule en een vrije-tekst-instructie. Dit blok
bouwt de definities, de due-berekening, het dedup-gereedschap en de
routines-UI. De cron/runner die due-routines in een sessie omzet is
bouwblok 3 — hier bouwen we alles wat die runner aanroept.

## 1. De routine-file

Context-markdown, geplaatst onder een board-dir; het board is het
eerste padsegment (`freelance/happyshopper/weekly-plugin-updates.md` →
board `freelance`). Een klant-subdir mag; `_global/` is géén geldige
plek voor routines.

Frontmatter:

- `kind: routine` — verplicht.
- `schedule:` — verplicht; 5-velden cron-expressie (bijv. `0 9 * * 1`),
  geëvalueerd in lokale machinetijd. Parser: `croner` (zero-dependency;
  bewust de eerste nieuwe runtime-dependency — een eigen mini-parser is
  de lean-valkuil). DST-gedrag documenteren in README: "ma 09:00"
  verspringt niet.
- `card:` — verplicht; het id van de ops card waaruit de routine
  ontstond. Dit veld ankert elke latere wijziging via de UI (de
  pauze-toggle) aan invariant 3: één commit + één `context_written`-
  event op déze kaart.
- `enabled:` — optioneel, default `true`.
- `name:` — optioneel; weergavenaam voor de UI. Fallback: bestandsnaam
  zonder `.md`.

Body: vrije tekst — de instructie aan de agent. Job-routine of watcher
is geen mechanisme maar formulering (besluit E/G).

**Validatie** in de bestaande frontmatter-validatiehaak
(`validateContent`): `kind: routine` ⇒ `schedule:` aanwezig én
parseerbaar door croner, `card:` aanwezig. Een syntactisch kapotte
routine kan zo vrijwel niet ontstaan; `ctx write` weigert hem.

## 2. Run-state & CLI

Nieuwe SQLite-tabel: `routine_run (path TEXT PRIMARY KEY,
last_run_at TEXT NOT NULL)` — migratie volgens het bestaande patroon.
Run-state hoort in de db, niet in git (geen commit-ruis per run).

**Seeding:** een routine zonder run-state-rij wordt bij de eerste keer
dat `routines list`/`due` hem ziet geseed met `last_run_at = nu`, en is
op dat moment níet due. Effect: een net goedgekeurde routine wacht op
zijn eerste geplande moment en vuurt niet direct bij approval.

**Due-regel:** enabled ∧ `croner.nextRun(last_run_at) ≤ nu`.

Commando's (alle met `--json`, fouten naar stderr/exit 1):

- `agentboard routines list [--board <id>]` — alle routines: pad,
  board, naam, schedule, enabled, last_run_at, next_run, en de jongste
  kaart met dit routinepad (`{id, status}` of null) voor de
  "last run"-link in de UI.
- `agentboard routines due` — alleen de due-routines (zelfde velden).
  Per file try/catch: één onleesbare/kapotte file wordt als
  `{path, error}` gerapporteerd en sloopt de sweep niet.
- `agentboard routines mark <pad>` — stempelt `last_run_at = nu`
  (upsert). De runner van blok 3 roept dit aan bij sessiestart, zodat
  een crashende sessie niet elke minuut hertriggert.

Wees-run-state (file verwijderd, rij blijft): onschuldig; `list`/`due`
tonen alleen bestaande files.

## 3. Dedup-gereedschap (besluit E uitvoerbaar)

- Nieuwe nullable kolom `card.routine` (TEXT; het routinepad) +
  migratie. Gezet bij aanmaak, daarna onveranderlijk via de normale
  edit-vlaggen (geen `--routine` op `card edit`).
- `card new --routine <pad>` — zet de kolom én laat de kaart **direct
  in `ready`** starten (auto-ready: de goedkeuring zit in de routine;
  zo schendt geen agent-move de regel "alleen de user zet inbox →
  ready"). Het pad wordt niet tegen het bestandssysteem gevalideerd —
  de agent geeft het pad van de routine die hem draaide; een typefout
  is zichtbaar in de UI, niet fataal.
- `card list --ref <tekst> | --routine <pad> [--board <id>]` — nieuw
  commando, minstens één filter verplicht. `--ref` matcht
  case-insensitive substring in de refs-JSON (de idempotentie-sleutel
  van watchers); `--routine` matcht de kolom exact. Output per kaart:
  id, board, status, titel — de agent beoordeelt zelf wat "levend" is
  (status ≠ done/archived).

## 4. AGENT.md — regel 16

Nieuw, na regel 15 (formulering definitief in de implementatie, strekking):

> Routine-runs: read the routine file (`ctx show <pad>`) and decide —
> a new card, a comment on an existing card, or nothing (a silent run
> is fine). Never create a card for something that already has a
> living card: check `card list --routine <pad>` for job-routines and
> `card list --ref <key>` for watcher items first, and comment there
> instead of duplicating. Cards you create for a routine:
> `card new --routine <pad> --as agent ...` — they start in ready; the
> review gate is unchanged (never to done).

## 5. API & web-UI (design 2e leidend)

**API:**

- `GET /api/routines` — passthrough van de `routines list`-data.
- `POST /api/routines/toggle` `{path, enabled}` — het enige schrijfpad:
  leest de file, zet/vervangt de `enabled:`-regel in de frontmatter, en
  schrijft via het bestaande `writeContext`-kanaal als `human`, met
  `cardId` uit het `card:`-veld en een commit message als
  `ctx: pause routine <naam> (<card>)` / `resume`. Invariant 3 blijft
  zo intact. Ontbreekt het `card:`-veld (legacy/handmatig bestand) →
  duidelijke fout; geen stille write.

**UI:**

- Menu-item "Routines" links in de bestaande navigatie. All-boards:
  alle routines gegroepeerd per board; board-view: alleen dat board.
- Modal per design `2e`: per routine naam, schedule als monospace
  pilletje (lichte humanisering voor gangbare patronen — "mon 09:00" —
  met de rauwe cron-expressie als fallback/tooltip), "last run" als
  klikbare kaart-link + uitkomst, "next run", en de pauze-toggle
  (groen = actief; gepauzeerde rij gedimd met grijze achtergrond).
  Footer-copy uit het design: "Read-only. Pausing is the only change
  you make here — creating, editing or deleting a routine goes through
  an ops card."
- ↻-chip: pil met klok/history-icoon en tekst "routine" op board- en
  detailkaart, gevoed door `card.routine`; op de detailkaart klikbaar
  naar de routines-modal (of toont het pad als tooltip).

## 6. Buiten scope (bewust)

- De minuut-cron, single-flight lock en sessie-start (bouwblok 3).
- Notificaties, zoeken/filters (geparkeerd in de visie).
- Routines aanmaken/bewerken/verwijderen via de UI — dat loopt via ops
  cards; alleen pauzeren is direct.
- `blocker_resolved`-timeline-event uit het design (bonus t.o.v. de
  brief; kan ooit mee met een UI-batch).

## 7. Verificatie

Zelfde stramien als blok 1 — build + CLI-probes tegen een
wegwerp-`AGENTBOARD_DATA`, afgesloten met een herhaalbaar script:

1. Routine-file schrijven via `ctx write` (met card) → validatie: file
   zonder schedule/card of met onparseerbare cron wordt geweigerd.
2. Eerste `routines list` seedt run-state; `due` is leeg.
3. Schedule in het verleden forceren (of last_run_at terugzetten in de
   db) → `due` toont de routine; `mark` → `due` weer leeg.
4. Kapotte file (handmatig, buiten ctx write om) → `due` rapporteert
   `{path, error}` en de rest van de sweep werkt.
5. `card new --routine <pad>` → status `ready`, kolom gezet;
   `card list --routine` vindt hem; `card list --ref` matcht op refs.
6. Toggle via API → `enabled: false` in de file, git-commit aanwezig,
   `context_written`-event op de kaart uit `card:`; `due` slaat de
   routine over.
7. UI-screenshots: modal (all-boards + board), pauze-staat, ↻-chip op
   board en detail, tegen design 2e.
