# Spec: Agent log, live tail & observer (bouwblok 4b)

Datum: 2026-08-28. Kader: `2026-08-24-agentboard-vision.md` (journey 8,
besluit J; design 2f). Sluit bouwblok 4 af: 4a legde vast en toonde per
kaart; 4b maakt het overzicht, de live-volging en de feedbackloop.
Ontwerp in-chat goedgekeurd op 2026-08-28.

## Doel

Eén plek die de vraag "wat heeft de agent gedaan — en ging dat goed?"
beantwoordt: een Agent log-overzicht met samenvatting, een sessiedetail
dat live meeloopt zolang de sessie draait, en een observer die een
afgeronde sessie natoetst en bevindingen terugvoert als ops card.

## 1. Agent log-overzicht (design 2f links)

- Nieuwe route `#/sessions`, sidebar-ingang "Agent log" (naast
  Routines), zichtbaar in board- én all-boards-context (sessies zijn
  data-dir-breed, niet board-gebonden).
- **Stat-tegels, laatste 7 dagen:** sessies · afgerond · teruggegeven ·
  vroegtijdig gestopt. Daarboven een samenvattingszin als **template
  uit dezelfde cijfers** ("Draaide N sessies en raakte M kaarten.
  X afgerond, Y teruggegeven, Z vroegtijdig gestopt.") — geen
  gegenereerd proza; alles afgeleid, niets geclaimd.
- **Sessielijst** (nieuwste eerst): nummer, trigger-label, duur of
  live-stip, geraakte kaarten (ids, klikbaar), uitkomst in één regel.
- **Uitkomst is afgeleid**, per rij: `ended_at` gezet + exit 0 →
  "completed"; exit ≠ 0 → "ended early"; `handed_back` niet leeg →
  "N handed back" (telt uit de bestaande `handed_back`-kolom). Een rij
  zónder `ended_at` is alleen "live" als de runner-lock hem bevestigt:
  de API annoteert (zelfde patroon als `/api/changes`) elke open rij
  met `live` uit `sessionStatus()` (`running` én `session_id` gelijk).
  Niet bevestigd → **"ended early (crash)"** — dit sluit het geparkeerde
  4a-punt "SIGKILL laat een eeuwige running-rij achter". Geen
  schrijfreparatie in v1: de waarheid is afgeleid bij lezen, de rij
  blijft zoals hij is.
- Geen nieuw aggregaat-endpoint: de client rekent de tegels uit de
  bestaande sessielijst (`GET /api/sessions`, plus de `live`-annotatie).
  Prune houdt de lijst klein; op deze schaal is dat gratis.
- **Trigger-labels** (4a-parkeerpunt): rauwe waarden krijgen in de UI
  een nette weergave (cron, na jouw actie [serve], routine, handmatig,
  observer). Onbekende waarden tonen als-is.

## 2. Live tail op de sessie-detailpagina (design 2f rechts)

- De detailpagina van een **lopende** sessie loopt live mee via het
  bestaande realtime-kanaal — de cursor draagt sinds blok 5
  sessie-liveness, dus er is géén nieuw poll-kanaal. De poller in
  `app.js` krijgt voor de sessie-route een hook (zelfde patroon als
  kaartdetail): bij `changed` een **incrementele poke**, nooit een
  blinde rerender (het blok-5-besluit dat de sessieweergave statisch
  bleef, vervalt hiermee — dit is de 4b-invulling waarvoor dat wachtte).
- **Incrementeel endpoint:** `GET /api/sessions/:id/steps?offset=<b>&n=<k>`
  → `{ steps, offset, n, live }`. De server leest de JSONL vanaf
  byte-offset `b`, parset alleen de nieuwe regels, nummert stappen
  door vanaf `k`, redigeert per stap zoals nu, en geeft de nieuwe
  cursor terug. Een onafgemaakte laatste regel (sessie schrijft nog, of
  crash mid-regel) wordt genegeerd én de offset schuift er niet
  voorbij — de volgende poll leest hem alsnog compleet. Zonder
  parameters: vanaf het begin (de eerste laad gebruikt dit ook, zodat
  detail en tail één pad delen).
- **Client:** appendt de nieuwe stappen onderaan de stappenlijst —
  opengeklapte reasoning-blokken blijven onaangeroerd, geen
  scroll-reset. Een "Follow"-toggle (default aan zolang de sessie
  live is) scrollt automatisch naar de nieuwste stap; handmatig
  omhoog scrollen zet follow uit. De kop toont "live · laatste stap
  Xs geleden" zolang `live`, en klapt om naar de normale
  afgerond-weergave (duur, exit) zodra de sessie eindigt — dezelfde
  eerlijkheidsregel als de heartbeat op het board.
- Een afgeronde sessie rendert zoals nu (één keer, statisch); de hook
  doet dan niets meer.

## 3. Observer (besluit J)

- **CLI:** `agentboard observe <sessienr>`. Weigert een lopende sessie
  (transcript onvolledig) en een sessie met trigger `observe` (geen
  observer-op-observer-recursie).
- **Uitvoering via de bestaande runner-machinerie:** `runSession`
  krijgt een prompt-override-optie; observe gebruikt die met trigger
  `observe`. Daarmee gelden vanzelf: de single-flight-lock (geen
  observer naast een werksessie), sessie-capture (de observatie is
  zelf een genummerde, terugleesbare sessie), crash-vangnet en
  stderr-logging. De gate wordt bij een prompt-override niet
  geraadpleegd — observe start onvoorwaardelijk (na de lock).
- **Promptcontract** (de prompt doet het werk, geen beslislogica in
  code): de observer-sessie krijgt de opdracht om (1) het transcript
  **geredigeerd** te lezen via `agentboard sessions show <nr>`
  — nooit de rauwe JSONL; (2) het verloop te toetsen aan AGENT.md
  (pad in de prompt) en, indien beschikbaar, het visiedocument;
  (3) een kort rapport te schrijven naar
  `<data>/sessions/<nr>-observation.md` (verdict, bevindingen,
  concrete verbeterpunten); (4) **alleen bij een regelschending** een
  ops card aan te maken via de CLI op het board van de geraakte kaart
  (meerdere boards → het board van de eerst geschonden kaart; geen
  kaart geraakt → alleen het rapport). Geen schending → geen kaart.
- **Visiedocument-pad:** het visiedoc leeft in de tool-repo, niet in de
  data-dir. `observe --vision <pad>` of `AGENTBOARD_VISION` levert het
  aan; zonder beide toetst de observer alleen aan AGENT.md. *Bewuste
  afwijking van besluit J's letter (transcript + visiedoc + AGENT.md):
  het visiedoc is optionele input omdat het buiten de installatie
  leeft; AGENT.md is het contract dat de sessie werkelijk had.*
- **UI:** de sessie-detailpagina toont een "Observation"-blok zodra
  `<nr>-observation.md` bestaat (inhoud door de bestaande
  display-redactie, verdediging in de diepte). De sessielijst markeert
  geobserveerde sessies met een klein oog-icoon.
- Kosten: elke observe is een volwaardige claude-sessie. Default
  handmatig; cron'en is een latere keuze van de gebruiker, geen
  onderdeel van dit blok.

## 4. Ride-alongs (4a-parkeerpunten)

- **Redactor:** naast plain en base64 ook de JSON-string-geëscapete
  variant van elke secret-waarde herkennen (waarden met quotes,
  backslashes of niet-ASCII ontsnappen anders aan de redactie in
  stream-json-transcripten).
- **README:** noteren dat `agentboard backup` de sessies (JSONL,
  observaties) bewust uitsluit — transcripten zijn reproduceerbare
  werklogs, geen brondata; prune is het opruimkanaal.
- **Parser-validatie tegen echt materiaal:** eenmalig, read-only, de
  parser en redactie draaien tegen de echte sessies op het live board
  en de bevindingen rapporteren (geen client-data in het repo; dit is
  een verificatiestap in de bouw, geen artefact).

## 5. Buiten scope (bewust)

- SSE (zelfde kanaal, later transport).
- Observer-automatisering (cron) en het terugschrijven van
  observer-feedback naar AGENT.md.
- Sessies filteren/zoeken in het overzicht; paginering (prune volstaat).
- Wijzigingen aan capture, lock of gate buiten de prompt-override.

## 6. Verificatie

1. API-probes: sessielijst-annotatie (open rij + eigen lock → `live`;
   open rij zonder lock → niet live), steps-endpoint incrementeel
   (offset/n lopen door, onafgemaakte regel blijft staan, redactie
   actief), observe-weigering (lopende sessie, observe-sessie).
2. Browser (Playwright, wegwerp-data): overzichtstab met tegels en
   lijst; live tail — stappen verschijnen zonder rerender terwijl een
   fake sessie schrijft, follow scrollt mee, open details blijven
   open; crash-rij toont "ended early (crash)"; Observation-blok
   verschijnt.
3. Observer end-to-end met een **fake** sessiecommando (nooit een
   echte claude-sessie in verificatie): lock gehouden, rapport
   geschreven, sessie gelogd met trigger `observe`.
4. Redactor-probe: secret met quote/backslash → JSON-geëscapete
   variant geredigeerd in de weergave.
5. Regressie: de vijf bestaande verify-scripts groen; realtime-gedrag
   op board/kaart onaangetast.
