# Spec: blockers & claiming (bouwblok 1)

Datum: 2026-08-25. Kader: `2026-08-24-agentboard-vision.md` (besluiten
A, B en Concurrency; journey 3). Reviewpunten uit
`2026-08-25-review-dev.md` en `-review-ux.md` zijn verwerkt.

## Doel

Een task card kan structureel geblokkeerd zijn door ops cards. De agent
legt blockers vast op het ontdekmoment, `next` slaat geblokkeerde
kaarten over, de UI toont het, en het claimen van een kaart wordt
race-vrij. Weergave-only in de UI: blockers koppelen doet de agent via
de CLI.

## 1. Datamodel & migraties

- Nieuwe kolom: `card.blocked_by TEXT NOT NULL DEFAULT '[]'` — JSON-
  array van card-ids. Migratie in `initData` via `ALTER TABLE ADD
  COLUMN` (patroon van `board_id`). `rowToCard` parseert de kolom;
  `Card` krijgt `blocked_by: string[]`.
- Nieuw event-kind: `blocker_added`, payload `{ blocker: "ops_x" }`,
  geschreven op de geblokkeerde (task) kaart.
- **Migratie-guard generaliseren** (dev a4): de event-tabel-rebuild in
  `initData` triggert nu op `!eventSql.includes('upload_added')`; dat
  wordt: rebuild zodra een kind uit `EVENT_KINDS` in de opgeslagen
  CHECK ontbreekt. Daarmee werkt deze én elke volgende kind-toevoeging
  op al gemigreerde databases.
- `openDb` zet expliciet `busy_timeout` (bijv. 5000 ms): serve, CLI en
  straks de cron schrijven met meerdere processen tegelijk.

Semantiek: een blocker is "open" zolang zijn status niet `done` of
`archived` is. Afgeronde blockers blijven in `blocked_by` staan
(provenance); er bestaat geen "unblock"-schrijfactie — open/dicht is
altijd afgeleid.

## 2. Core-API

**`createCard`** krijgt `blocks?: string` en `actor?: string`:

- Valideert dat de doelkaart bestaat.
- Eén transactie: kaart aanmaken + doelkaart `blocked_by` uitbreiden
  (+ `updated_at`) + `blocker_added`-event op de doelkaart met de
  gegeven actor. Alles of niets.

**`editCard`** krijgt `blockedBy?: string[]` (volledige lijst
vervangen, het correctiepad). Validatie bij elke `blocked_by`-write:

- Elk id bestaat.
- Geen self-reference.
- **Geen cykel** (dev a5): DFS over de `blocked_by`-graf; een cykel
  zou beide kaarten stil en voorgoed uit `next` laten verdwijnen.

**`moveCard`** krijgt `from?: string` (verwacht-status):

- De UPDATE wordt conditioneel: `... WHERE id = ? AND status = ?`
  (CAS). Nul rijen geraakt → duidelijke fout: `Card <id> is not in
  '<from>' (already claimed?)`.
- Ook zonder `from` verhuist de read de transactie in, en **het
  `from` in het `status_changed`-event komt uit die transactionele
  read** — het event mag nooit een andere overgang beschrijven dan er
  werkelijk plaatsvond (dev b1).

**`nextWork`** filtert geblokkeerde kaarten: kandidaten ophalen zoals
nu, alle blocker-ids verzamelen, hun statussen in één query checken,
kaarten met ≥1 open blocker eruit. In JS, geen SQL-JSON-acrobatiek.

**Verrijking** voor de API-laag: kaarten krijgen een `blockers`-array
`[{ id, title, status }]` (voorwaartse richting) en card-detail
daarnaast `blocks: [{ id, title, status }]` — de omgekeerde query
"welke kaarten hebben míj in hun `blocked_by`" (UX a4), zodat een ops
card "unblocks task_x" toont zonder dubbele boekhouding.

## 3. CLI

- `card new --type ops --blocks task_x --as agent ...` — het agent-pad:
  ops card aanmaken én koppelen in één commando. `--as` (default
  `human`) bepaalt de actor van het `blocker_added`-event.
- `card edit task_x --blocked-by ops_a,ops_b` — correctiepad; lege
  string = lijst leegmaken.
- `card move task_x doing --from ready --as agent` — de claim. De
  agent claimt áltijd met `--from ready`.

## 4. API (server.ts)

- Board- en detail-responses bevatten `blocked_by` plus de verrijkte
  `blockers` (en in detail `blocks`). Geen extra endpoints; de UI
  hoeft niets na te vragen.

## 5. Web-UI (weergave-only)

- Boardkaart: compact chipje met het aantal open blockers (alleen
  zichtbaar bij ≥1 open).
- Card-detail: één chip per blocker, klikbaar naar die kaart; afgerond
  = afgevinkt/gedimd. Op een ops card de omgekeerde groep: "unblocks
  task_x", klikbaar.
- Timeline rendert `blocker_added` als regel ("geblokkeerd door
  ops_x"); check dat onbekende event-kinds in `web/js/views/card.js`
  niet breken (dev b3).
- Zet de mens een kaart met open blockers op `done` → bevestiging
  vragen, niet blokkeren: invarianten beperken de agent, nooit de
  mens (dev-antwoord).

## 6. AGENT.md

Eén nieuwe regel (journey 3 + claiming):

- Blocker ontdekt → per entiteit direct één ops card via
  `card new --blocks <task> --as agent`; de task terug naar `ready`
  (die verdwijnt vanzelf uit `next` tot de blockers done zijn); bij
  het weer oppakken valideren dat de blockers echt weg zijn.
- Claimen bij `ready → doing` altijd met `--from ready`; faalt de
  move, dan is de kaart al geclaimd — pak de volgende.

## 7. Buiten scope (bewust)

- Blockers koppelen/losmaken in de web-UI (weergave-only besloten).
- Veroudering tonen ("blocked 12d") — design-ronde + bouwblok 5.
- Heartbeat/doing-zonder-sessie — bouwblok 3/4.
- Cross-board blockers: toegestaan, niet afgedwongen of gevalideerd
  op board-gelijkheid.

## 8. Verificatie

Script tegen een wegwerp-`AGENTBOARD_DATA` (scratchpad):

1. Migratie: db van vóór deze wijziging openen → kolom + event-rebuild
   draaien éénmalig; herhaald draaien is een no-op.
2. `card new --blocks`: kaart + koppeling + event in één keer; ref
   naar niet-bestaande kaart faalt zonder half werk.
3. Cykel-validatie: `edit --blocked-by` die een cykel of
   self-reference maakt, faalt.
4. `next`: geblokkeerde kaart onzichtbaar; blocker naar `done` →
   kaart verschijnt weer; tweede open blocker houdt hem weg.
5. Claim: twee keer `move doing --from ready` → tweede faalt met de
   al-geclaimd-fout; move zonder `--from` gedraagt zich als voorheen.
6. Event-integriteit: `from` in het event klopt met de werkelijke
   overgang, ook onder een gelijktijdige move.
7. UI-screenshots volgens het `docs/design/verify`-patroon: chip op
   boardkaart, blocker-chips + unblocks-groep in detail, timeline-
   regel, done-bevestiging.
