# Agentboard — visiedocument

Datum: 2026-08-24. Status: ter review.

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
- User antwoordt in een comment (of levert een upload/secret) en zet de
  kaart terug op `ready`.
- Dit herhaalt tot de agent het werk af acht: comment met resultaat,
  status `review`.
- User keurt goed (`done`) of stuurt terug met een comment (`ready`).
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
  `needs_input`.
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
- De UI heeft een agent-logs-tab: sessies chronologisch, live mee te
  lezen terwijl de agent werkt.
- Het board is realtime: statuswissels en nieuwe comments verschijnen
  zonder verversen.
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
- **C. Triggers zijn event-driven, cron is het vangnet.** Een
  user-actie (status → `ready`, comment op `needs_input`) triggert een
  sessie; die draait gewoon `next`. Daarnaast een minuut-cron voor
  routines en als vangnet.
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
    Definitief ontwerp via een Claude Design-ronde.
- **E. Auto-ready via de routine, anti-duplicaat via AGENT.md.**
  Goedkeuring verschuift van per-kaart naar per-routine; de agent kan
  nog steeds nooit naar `done`. Nooit stapels identieke kaarten: één
  levende kaart per sleutel (routine of externe ref), anders een
  comment.
- **F. Workdir-approval zit één niveau hoger.** De ops card die de
  repo/resource vastlegt is de goedkeuring; clonen en werken in de
  workdir is daarna gewone uitvoering met een event, geen ritueel per
  keer.
- **G. Polling is een watcher-routine.** Geen apart mechanisme;
  alleen een andere instructietekst.
- **Concurrency.** Single-flight: één agentsessie tegelijk per
  data-dir (lock met PID + staleness-check). Kaart-claim = de
  conditionele statusmove `ready → doing` (slaagt alleen als de kaart
  nog `ready` is). Vandaag een vangnet, morgen het fundament voor
  parallelle sessies.

## Bouwvolgorde

1. **Blockers & claiming** — `blocked_by`, conditionele moves, `next`
   filtert, blocker-chips.
2. **Routines** — routine-files, `routines due`, run-state-tabel,
   AGENT.md-regel, routines-UI (na design-ronde).
3. **Trigger/scheduler** — minuut-cron, single-flight lock,
   event-driven triggers, headless sessies.
4. **Sessielogging & observer** — sessies vastleggen en nummeren,
   agent-logs-tab, observer-loop.
5. **Realtime UI** — live board- en logs-updates (SSE over de
   event-tabel); mogelijk gevouwen in 4.

Elk bouwblok krijgt zijn eigen spec → plan → implementatie-cyclus, met
dit document als kader.
