# Agentboard — visiedocument

Datum: 2026-08-24, bijgewerkt 2026-08-25 na onafhankelijke UX- en
senior-dev-review (zie `2026-08-25-review-ux.md` en
`2026-08-25-review-dev.md`). Status: vastgesteld.

Dit document is het toetsingskader voor agentboard: de journeys zoals ze
horen te werken, de vastgelegde ontwerpbesluiten, en de bouwvolgorde.
Elke toekomstige spec verwijst hiernaar. De huidige applicatie wordt
tegen dit document gehouden; afwijkingen zijn óf bugs, óf aanleiding om
dit document bij te stellen.

## Kernprincipes

- **Status = wie is aan zet.** Het board is een beurten-spel per kaart:
  `ready` = agent aan zet, `doing` = agent bezig, `needs_input` = user
  aan zet, `review` = user beoordeelt, `done` = user keurde goed.
  Comments zijn het gesprek; de statuswissel is de beurtwissel.
- **Task cards zijn klantwerk, ops cards bouwen het fundament** —
  connecties, secrets, context, skills, routines. De agent maakt ops
  cards op het moment dat hij ontdekt dat fundament mist: één per
  entiteit, direct bij ontdekking, nooit achteraf of gebundeld.
- **Minimale structuur, intelligentie bij de agent.** Gedragsregels
  leven in AGENT.md, niet in database-machinerie, zolang de review-gate
  het gedrag zichtbaar en corrigeerbaar houdt.
- **De review-gate is onaantastbaar.** De agent zet nooit iets op
  `done`. Goedkeuring kan wel verschuiven van per-kaart naar
  per-definitie (zie routines), maar verdwijnt nooit.
- **De timeline is het geheugen van de agent** tussen sessies; de kaart
  is de plek waar werk, connecties, notities en discussie samenkomen
  tot het done is.

## De journeys

### 1. Ping-pong op een kaart (basispatroon)

- User maakt een kaart (task of ops) en zet hem op `ready`.
- Agent pakt hem op: `ready → doing`, realtime zichtbaar op het board.
- Agent leest eerst alles: body, comments, uploads, context refs,
  profielketen (user → board → client).
- Heeft de agent iets van de user nodig → comment met één duidelijke
  vraag, status `needs_input`.
- Wacht de agent op iets externs (een reply, een deploy) → óók
  `needs_input`, maar met een wait-check: een gestructureerd event met
  wat te checken en vanaf wanneer. De UI toont dan een klokje in
  plaats van de kaart mee te tellen in "Needs me" — de teller telt
  alleen kaarten waar de user écht iets kan doen.
- User antwoordt met één handeling: **"Reply & hand back"** — comment
  plaatsen én de kaart terug naar `ready` in één knop (reden:
  "answered in comment"). Los commenten of los verplaatsen blijft
  mogelijk; de beurtwissel zelf is nooit meer dan één handeling.
- Dit herhaalt tot de agent het werk af acht: comment met resultaat,
  status `review`.
- User keurt goed (`done`) of stuurt terug met een comment (`ready`,
  nooit `doing`). **De mens zet nooit een kaart op `doing`** — alles
  wat de user teruggeeft gaat naar `ready`; `doing` is exclusief de
  claim van de agent, anders liegt het board tot de volgende sessie.
- Elke statuswissel schrijft een event; milestones logt de agent als
  `action_taken`/`error` events.

### 2. Connectie opzetten (ops)

- Aanleiding: user maakt zelf een ops card, óf de agent maakt hem als
  blocker vanuit een task card. Beide kan.
- Agent onderzoekt wat er nodig is (API, CLI-tool, SSH, library) en
  stelt zo nodig eerst de "hoe wil je koppelen"-vraag (`needs_input`).
- Agent benoemt de benodigde secrets op de kaart
  (`secret_ref: naam_a, naam_b`); de UI toont daarop een write-only
  secrets-intake onder zijn comment in de timeline. Status
  `needs_input`.
- User plakt de waarden in de intake en zet de kaart op `ready`.
  Waarden reizen nooit terug naar de browser; de kaart toont alleen
  lock-chips per opgeslagen naam (`secret_stored` events).
- Agent test de verbinding. Faalt één secret → gerichte her-aanvraag:
  comment die benoemt wélke, nieuwe intake voor alleen die secret,
  `needs_input`. De her-aanvraag is een gestructureerd signaal dat de
  eerdere lock-chip omzet naar "opnieuw nodig" — een chip mag nooit
  "stored" blijven zeggen over een afgekeurde waarde.
- Werkt de verbinding → agent slaat context op (connection-file met
  `secret_ref`, resource-files) en zet de kaart op `review`.
- User keurt goed. De connectie is vanaf nu herbruikbaar fundament.

### 3. Blocker-discovery

- Agent werkt aan een task card en ontdekt dat fundament mist (geen
  connectie, geen schrijfstijl, geen repo in context).
- Agent maakt per ontbrekende entiteit direct één ops card aan en
  koppelt die als blocker aan de task card (`blocked_by`).
- De task card gaat terug naar `ready`, maar `next` slaat kaarten met
  open blockers over. De UI toont blocker-chips op de task card.
- De ops cards doorlopen hun eigen ping-pong (journey 1/2).
- Zodra de laatste blocker `done` is, is de task card vanzelf weer
  oppakbaar — niemand hoeft hem te resetten.
- Bij het oppakken valideert de agent of de blockers echt weg zijn.

### 4. Extern werk importeren

- User maakt een task card: "haal items op uit <bron> volgens
  <criteria>" (Trello cards, Supportpal tickets, ...).
- Agent gebruikt de bestaande connectie (of start journey 3).
- Per opgehaald item maakt de agent een task card met een ref naar het
  origineel; bevindingen komen als comments.
- De externe ref is de idempotentie-sleutel: bestaat er al een levende
  kaart met die ref (elke status behalve `done`/`archived`), dan komt
  er een comment op die kaart in plaats van een duplicaat.
- Daarna is elke geïmporteerde kaart een normale ping-pong-kaart.

### 5. Extern communiceren in de stijl van de user

- User vraagt via een task card om een bericht (mail, Trello-comment)
  in zijn schrijfstijl.
- Schrijfstijl is context: bestaat die nog niet, dan is extractie een
  eigen ops card (bijv. "lees mailwisseling met klant X en leg
  schrijfstijl vast") — een blocker volgens journey 3. Stijl kan
  globaal, per board of per klant leven; specifiek wint.
- Agent drafts het bericht volgens de profielketen en legt de exacte
  tekst ter goedkeuring voor als comment, status `needs_input`.
- Zonder expliciete goedkeuring van de exacte tekst verstuurt de agent
  nooit iets naar een externe partij. Geen goedkeuring in de sessie →
  voorstel geparkeerd als comment, kaart op `needs_input`.
- Na verzending: event met wat, waar, link.

### 6. Codewerk

- Task card vraagt om een code-wijziging (bijv. vanuit een
  geïmporteerd ticket).
- Fundament via journey 3: GitHub-connectie (ops), repo als
  resource-file in context (ops). De goedkeuring van die resource-ops
  card ís de goedkeuring om de repo te clonen — daarna is clonen naar
  de workdir gewone uitvoering, zonder aparte approval per keer.
- Issues/PR's krijgen een ref op de task card; de agent logt de
  koppeling als comment + event.
- Repo-werk: workdir-pad volgt de resource-file, branch `card/<id>`,
  card-id in commits, elke werksessie eindigt met commit + push + een
  timeline event. De workdir is disposable; het remote repo is de
  durable home.

### 7. Routines

- Een routine is terugkerend werk: schedule + vrije-tekst-instructie
  aan de agent. Eén mechanisme voor zowel job-routines ("update
  wekelijks de plugins van deze 9 sites") als watchers ("check elk uur
  Supportpal op nieuwe tickets volgens criteria X").
- Ontstaan review-gated via een ops card: user vraagt (of agent stelt
  voor), agent schrijft de routine-file, user reviewt, done. De
  goedkeuring van de routine vervangt goedkeuring per kaart.
- Een run start een agentsessie met de instructie. De agent beslist
  wat er nodig is: een nieuwe task card, een comment op een bestaande
  kaart, of niets (stille run).
- Kaarten uit een routine starten direct op `ready` (geen inbox) en
  dragen een verwijzing naar hun routine (↻-chip in de UI).
- Anti-duplicaat is een framework-regel (AGENT.md), geen machinerie:
  maak nooit een kaart voor iets dat al een levende kaart heeft —
  check eerst op de routine-verwijzing of de externe ref en schrijf
  daar een comment.
- De review-gate blijft: ook routine-werk gaat via `review` naar
  `done`.

### 8. Observability

- Elke agentsessie wordt volledig vastgelegd: elk bericht, elke tool
  call, reasoning — en krijgt een sessienummer.
- Transcripten worden vóór opslag/weergave geredigeerd tegen de vault:
  een secret-waarde kan nooit in de logs verschijnen.
- De UI heeft een agent-logs-tab, samenvatting eerst: de sessielijst
  toont nummer, trigger (cron/status-change/routine), duur, geraakte
  kaarten en uitkomst in één regel; het detail toont stappen als
  één-regel-items met reasoning ingeklapt, live te volgen. Vanaf een
  kaart spring je naar de sessie-fragmenten die die kaart raakten —
  "wat heeft hij hier gedaan?" is de echte vraag.
- Het board is realtime: statuswissels en nieuwe comments verschijnen
  zonder verversen.
- Eerlijkheid boven activiteitsclaims: `doing` met een levende sessie
  (heartbeat) ziet er anders uit dan `doing` zonder ("wordt hervat bij
  de volgende sessie"). Een crash mag nooit als "kapot" aanvoelen.
- Notificaties: één kanaal dat alleen beurtwissels naar de mens meldt
  (kaart naar `needs_input` of `review`) — niet per event, maar per
  "de bal ligt bij jou".
- De sessielogs zijn de basis voor de observer-loop: een aparte
  "observer"-sessie leest een sessie na en toetst het verloop aan dit
  visiedocument. Bevindingen worden feedback (uitwerking volgt in de
  spec van bouwblok 4).

## Vastgelegde besluiten

- **A. Blockers zijn structuur.** `blocked_by: [card-ids]` als veld op
  de kaart. De timeline blijft het verhaal; state leeft in een kolom —
  zoals status ook kolom én event is. UI toont chips; de agent checkt
  blockers met één query, geen timeline-archeologie.
- **B. Geblokkeerd is geen status.** Een geblokkeerde kaart staat op
  `ready`; `next` filtert kaarten met open blockers eruit. Laatste
  blocker `done` → kaart is vanzelf weer oppakbaar. `needs_input`
  blijft gereserveerd voor "user is aan zet op déze kaart".
- **C. Triggers zijn event-driven, cron is het vangnet — met één
  runner en een smalle gate.** Er is één idempotent
  "maybe-start-session"-script; de minuut-cron en de serve-laag (na
  een human move/comment) roepen allebei datzelfde script aan, de
  single-flight-lock arbitreert. De gate voor de scheduler is
  **smaller dan `next`**: `ready` zonder open blockers + `doing` van
  de agent + routines-due + `needs_input` met een verlópen wait-check.
  Kale `needs_input` telt nooit mee — anders start één onbeantwoorde
  vraag elke minuut een zinloze sessie; die kaarten komen alleen terug
  via een human-actie.
- **D. Routines leven in context, run-state in SQLite.**
  - Definitie: markdown-file, `kind: routine` + machinaal parseerbare
    `schedule:` in de frontmatter, body = vrije instructie. Plaatsing
    volgt de profielketen (klant-routine bij de klant, boardbreed in
    de board-dir).
  - Run-state: klein SQLite-tabelletje (routine-pad + laatst
    gedraaid), gestempeld bij séssiestart zodat een crash niet elke
    minuut hertriggert. Geen git-commit per run.
  - CLI: `agentboard routines due --json` als spiegelbeeld van
    `agentboard next`; de cron buiten de tool checkt beide.
  - UI: routines links in het menu; all-boards toont alle routines
    gegroepeerd per board, board-view alleen die van dat board;
    lijstweergave in een modal, read-only — beheer gaat via ops cards.
    Eén uitzondering: **pauzeren is een handrem** en krijgt een
    directe toggle die als `human` een `enabled: false`-commit
    schrijft via het bestaande context-kanaal (invariant 3 blijft
    intact; de agent blijft van dit pad af). Definitief ontwerp via
    een Claude Design-ronde.
- **E. Auto-ready via de routine, anti-duplicaat via AGENT.md — maar
  uitvoerbaar gemaakt.** Goedkeuring verschuift van per-kaart naar
  per-routine; de agent kan nog steeds nooit naar `done`. Nooit
  stapels identieke kaarten: één levende kaart per sleutel (routine
  of externe ref), anders een comment. Een gedragsregel werkt alleen
  als de check goedkoop is, dus de agent krijgt gereedschap: een
  nullable `routine`-kolom op card (het routinepad — voedt ook de
  ↻-chip en "loopt er nog een kaart van deze routine") en
  `card list --ref <url>` om op externe refs te zoeken.
- **F. Workdir-approval zit één niveau hoger.** De ops card die de
  repo/resource vastlegt is de goedkeuring; clonen en werken in de
  workdir is daarna gewone uitvoering met een event, geen ritueel per
  keer.
- **G. Polling is een watcher-routine.** Geen apart mechanisme;
  alleen een andere instructietekst.
- **Concurrency.** Single-flight: één agentsessie tegelijk per
  data-dir (lock-file in de data-dir met PID + hostname + started_at;
  staleness via proces-check plus een max-leeftijd-vangnet).
  Kaart-claim = de conditionele statusmove `ready → doing` (slaagt
  alleen als de kaart nog `ready` is). Vandaag een vangnet, morgen het
  fundament voor parallelle sessies. Expliciete aanname: **één
  machine** — een gesyncte SQLite + PID-locks over machines heen is
  stille corruptie.
- **H. Twee soorten wachten, één status.** `needs_input` kent twee
  smaken, onderscheiden door een wait-check-markering (gestructureerd
  event met wat te checken en vanaf wanneer): zonder markering = "user
  is aan zet" (telt in "Needs me", komt terug via een human-actie);
  mét markering = "wacht op extern" (klokje in de UI, telt níet in
  "Needs me", komt terug via de scheduler zodra de check-tijd
  verstreken is). Geen zevende status.
- **I. De beurtwissel is één handeling.** "Reply & hand back" op
  needs_input- en review-kaarten: comment + move naar `ready` in één
  knop; de comment ís de reden. Quick actions sturen nooit naar
  `doing` — de mens geeft altijd terug aan `ready`.
- **J. Sessielogging (bouwblok 4) — de aanpak.** Headless sessies
  draaien met streamende JSON-output; het transcript gaat als JSONL
  naar `<data>/sessions/<n>.jsonl` (niet in SQLite). SQLite houdt
  alleen de index: sessienummer, start/eind, trigger, exit — plus een
  koppeltabel sessie ↔ kaart, afgeleid uit de agentboard-aanroepen in
  het transcript. Vóór opslag/weergave draait een redactiepas tegen
  de waarden in secrets.env. De observer-v1 is een los
  `agentboard observe <sessie>`-commando (handmatig of cron):
  transcript + visiedocument + AGENT.md beoordelen, rapport als
  artifact, eventueel een ops card bij een regelschending.
- **K. Realtime (bouwblok 5) — de aanpak.** Eén cursor-endpoint met
  2–3s-polling in de UI als eerste stap; SSE is een latere
  optimalisatie op hetzelfde endpoint, geen ander ontwerp.
  *Amendement 2026-08-28:* de cursor is samengesteld (max event-id +
  max comment-id + jongste card.updated_at) in plaats van alleen
  events — een nieuwe kaart en een kaart-edit schrijven geen event, en
  comments zijn geen events; `GET /api/changes?since=<cursor>` dekt
  alle drie zonder schemawijziging of `comment_added`-event.
  *Amendement 2026-08-28 (eindreview blok 5):* de cursor draagt ook
  sessie-liveness mee (max sessie-id + running-vlag), zodat
  heartbeat-presence ook bij een sessiecrash of -stilte binnen enkele
  ticks omklapt.

## Bouwvolgorde

1. **Blockers & claiming** — `blocked_by`, conditionele moves, `next`
   filtert, blocker-chips.
2. **Routines** — routine-files, `routines due`, run-state-tabel,
   AGENT.md-regel, routines-UI (na design-ronde).
3. **Trigger/scheduler** — minuut-cron, single-flight lock,
   event-driven triggers, headless sessies.
4. **Sessielogging & observer** — sessies vastleggen en nummeren,
   agent-logs-tab, observer-loop. Gesplitst tijdens de bouw: 4a
   (capture/index/redactie/kaart-tab — gereed) en 4b (logs-overzicht,
   live tail, observer — wacht bewust op echte sessies).
4½. **UI-batch beurtwissel + intake** (design 2b/2c/2d) — Reply & hand
   back, quick actions nooit naar doing, secrets-intake onder de
   agent-comment met "needed again". Ingevoegd 2026-08-27: deze batch
   was in besluit I voorzien maar had nog geen plek in de volgorde.
5. **Realtime UI** — live board- en logs-updates; per besluit K eerst
   een cursor-endpoint + polling, SSE later. Daarna 4b en de
   polish-batch (aging, 2h-choreografie, mobiel).

Elk bouwblok krijgt zijn eigen spec → plan → implementatie-cyclus, met
dit document als kader.

Los van de bouwblokken, direct geregeld (dev-review): een
`agentboard backup`-commando (`VACUUM INTO`-snapshot van de db + tar
van secrets/artifacts/uploads/context naar een tweede locatie, werkdir
uitgezonderd) en de AGENT.md-regel dat een secret-waarde nooit naar
stdout gaat (altijd `secret get --out`) — sessies worden straks
gelogd. De user regelt zelf een remote voor de context-repo en een
dagelijkse aanroep van het backup-commando.

Geparkeerd (bewust niet nu): zoeken/labelfilters, per-board-prioriteit
in `next`, bulk-archiveren, onboarding-seed-kaart bij een nieuw board,
`session_id` op events voor parallelle agents.
