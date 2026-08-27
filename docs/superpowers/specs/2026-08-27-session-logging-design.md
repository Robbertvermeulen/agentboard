# Spec: sessielogging (bouwblok 4a)

Datum: 2026-08-27. Kader: `2026-08-24-agentboard-vision.md` (besluit J,
journey 8). Knip vastgesteld met de user: **4a = het vertrouwen-deel**
(capture, index, kaart-koppeling, redactie, kaart-eerst-UI);
**4b = geparkeerd** tot er echte sessies liggen (logs-overzichtstab 2f,
live tail, observer). Reden-rangorde: grondwaarheid voor review- en
crashvragen eerst, heartbeat tweede, de leer-loop derde.

## Doel

Elke runner-sessie wordt genummerd, als JSONL vastgelegd en aan zijn
kaarten gekoppeld, zodat "wat heeft hij hier gedaan?" vanaf de kaart in
seconden te beantwoorden is — met secret-redactie op elk
weergavemoment.

## 1. Sessieregistratie & capture

- Nieuwe tabel `session`: `id INTEGER PRIMARY KEY AUTOINCREMENT`,
  `started_at`, `ended_at` (NULL zolang lopend), `trigger`
  (cron|serve|manual), `exit_status` (INTEGER, NULL bij crash),
  `handed_back` (JSON array `[{id,to}]` — de runner berekent dit al).
- De runner maakt de rij aan vóór de spawn en werkt hem bij in de
  finally (ended_at altijd gezet, ook bij een crashende sessie).
- `agentboard runner --trigger <label>` (default `manual`); de
  launchd/cron-voorbeelden in de README geven `--trigger cron` mee, de
  serve-hook spawnt met `--trigger serve`.
- Capture: **stdout → `<data>/sessions/<id>.jsonl`**, stderr apart naar
  `<id>.stderr.log` (mengen zou JSONL-regels corrumperen). De default
  `AGENTBOARD_SESSION_CMD` wordt
  `claude -p --output-format stream-json --verbose`; een afwijkend
  commando blijft gewoon werken — de parser (zie §5) behandelt
  niet-JSON-regels als ruwe tekstregels.
- Blok-3-`.log`-bestanden blijven liggen; de index start leeg. De
  runner-stderr-stapregels (blok 3) blijven zoals ze zijn.

## 2. Kaart-koppeling & uitkomst

- Nieuwe tabel `session_card` (`session_id`, `card_id`, PRIMARY KEY op
  beide). Na afloop scant de runner de JSONL op card-ids
  (patroon `\b(task|ops)_[0-9a-f]{4}\b`) en upsert per gevonden id —
  ook ids van kaarten die de sessie zelf aanmaakte.
- Uitkomst is afgeleid, geen kolom: exit_status + handed_back +
  ended_at NULL ("ended early" = exit ≠ 0 of nooit afgesloten).

## 3. Redactie op het weergavemoment

- Eén functie `redactSecrets(text)` in core: leest secrets.env, bouwt
  de vervanglijst uit elke waarde én — voor `base64:`-waarden — de
  gedecodeerde inhoud (regel voor regel, alleen printbare regels ≥ 6
  tekens), en vervangt elk voorkomen door `[secret:naam]` (naam in
  lowercase, zoals de UI-chips).
- Toegepast op élk weergavepad: `sessions show`, beide
  API-sessie-endpoints, en straks de observer (4b). **Niet** op schijf:
  de rauwe JSONL ligt binnen dezelfde trust boundary als secrets.env
  zelf, en streaming redigeren is fragiel. AGENT.md-regel 4 blijft de
  eerste verdedigingslinie; dit is het vangnet.

## 4. CLI

- `agentboard sessions list [--json]` — nummer, trigger, start, duur,
  exit, kaarten (uit session_card), handed back.
- `agentboard sessions show <nr> [--json]` — meta + de geparste,
  geredigeerde stappen (§5).
- `agentboard sessions prune --older-than <30d|12h>` — verwijdert
  jsonl/stderr-files én session/session_card-rijen ouder dan de duur;
  lost het blok-3-parkeerpunt (onbegrensde groei) op. Prune is de enige
  uitzondering op "delete bestaat niet": sessielogs zijn werkmateriaal,
  geen kaarthistorie — de timeline blijft de blijvende waarheid.

## 5. Parser & API

- `parseSessionSteps(jsonlText)` in core: stream-json-regels →
  stappen `{ n, type: 'text'|'tool'|'result'|'raw', label, detail,
  card_ids }`. Assistant-tekst wordt 'text' (eerste regel als label),
  tool_use wordt 'tool' (toolnaam + compacte input-samenvatting),
  tool_result 'result' (eerste regel), onparseerbare regels 'raw'.
  Reasoning-blokken krijgen type 'text' met label "reasoning · N
  words" en de inhoud in detail (de UI klapt ze standaard in, per
  design 2f).
- API:
  - `GET /api/sessions` — lijst met meta (incl. kaarten).
  - `GET /api/sessions/:id` — meta + geredigeerde stappen.
  - `GET /api/cards/:id/sessions` — per sessie die deze kaart raakte:
    meta + alléén de stappen waarvan `card_ids` de kaart bevat (plus
    één stap context vóór en ná), voor de 2g-tab.
  - `GET /api/session-status` — `{ running: bool, session_id }`:
    lopende sessie = session-rij met ended_at NULL én een levende lock.

## 6. UI (design 2g leidend; 2f-detail minimaal)

- **Card detail:** tab "Agent activity" naast "Timeline" (design 2g) —
  per sessie een blokje (nummer, trigger, tijd) met de fragmenten die
  déze kaart raakten, en "open full session →".
- **Sessie-detailpagina** (`#/session/<nr>`): het rechterpaneel van 2f
  minimaal — header (nummer, trigger, duur, exit, kaarten als chips)
  + stappenlijst, reasoning standaard ingeklapt. Geen live tail, geen
  overzichtslijst (4b).
- **Heartbeat, minimaal** (UX-reviewpunt a5): de board-view haalt
  `session-status` op; een `doing`-kaart zonder lopende sessie toont de
  eerlijke dormant-regel uit design 2a ("no live session — resumes at
  the next run"), met lopende sessie een klein pulse-stipje. Berekend
  bij render; echte realtime is blok 5.

## 7. Documentatie

README: sectie "Sessions" (waar de files liggen, de commands, de
redactie-afspraak, prune) + de Trigger-sectie bijwerken (`--trigger` in
de voorbeelden, jsonl i.p.v. .log). Geen AGENT.md-wijziging nodig.

## 8. Buiten scope (= 4b en later, bewust)

- Sessies-overzichtstab met stat-tegels en live tail (design 2f links).
- De observer (`agentboard observe`) en elke automatisering daarvan.
- SSE/realtime (blok 5).
- Redactie op schijf.

## 9. Verificatie

Probes met een nep-sessiecommando dat stream-json-achtige regels
(inclusief een geplante secret-waarde en card-ids) naar stdout schrijft:

1. Runner → session-rij (trigger, exit 0, ended_at gezet), `<id>.jsonl`
   bestaat, session_card bevat de geplante card-ids.
2. Crashend nep-commando → ended_at tóch gezet, exit_status ≠ 0,
   uitkomst "ended early" in `sessions list`.
3. Redactie: de geplante secret-waarde staat rauw in de file, maar
   `sessions show` en beide API-endpoints tonen `[secret:naam]`;
   base64-secret idem.
4. `sessions prune --older-than 0m` (na backdaten van started_at) ruimt
   file + rijen op; jongere sessies blijven.
5. Parser: tekst/tool/result/raw en reasoning-labels correct op een
   handgeschreven fixture-JSONL.
6. UI-screenshots: 2g-tab met fragmenten, sessie-detailpagina,
   dormant-regel op een doing-kaart zonder sessie (design-vergelijk).
7. Regressie: verify-trigger.sh, verify-routines.sh,
   verify-blockers.sh blijven groen (de runner-wijziging raakt legs!
   — het e2e-script asserteert log-bestandsnamen; die leg beweegt mee
   naar `<id>.jsonl`).
