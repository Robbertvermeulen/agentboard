# Spec: trigger/scheduler (bouwblok 3)

Datum: 2026-08-26. Kader: `2026-08-24-agentboard-vision.md` (besluiten C,
H en Concurrency; journeys 1 en 8). Erfenis uit blok 2: `routines due`/
`mark` bestaan; `GET /api/routines` seedt óók (de runner mag daar niet
van schrikken).

## Doel

Onbeheerde werking: een minuut-cron en de serve-laag roepen allebei
hetzelfde idempotente runner-commando aan; een single-flight-lock
arbitreert; een smalle gate beslist of er een headless agentsessie
start. Wait-checks krijgen hun structurele vorm zodat "wachten op
extern" de scheduler en de "Needs me"-teller niet meer vervuilt.

## 1. De gate: `agentboard gate --json`

Nieuw core-functie + CLI-commando, apart van `next` (dat ongewijzigd de
agent-worklist blijft). De gate telt:

- `ready`-kaarten **zonder open blockers** (zelfde afgeleide open-regel
  als `next`);
- `doing`-kaarten met owner agent (impliciet crash-herstel: een
  gestorven sessie laat de kaart in doing achter en de volgende sessie
  hervat vanaf de timeline — dit is een feature, geen bug);
- `needs_input`-kaarten met een **verlopen wait-check** (zie §2) —
  kale needs_input telt nooit mee;
- due-routines (via `dueRoutines()`; parse-errors als `errors` mee in
  de output, ze blokkeren niets).

Output: `{ cards, routines, errors }`. Leeg = geen sessie; de
minuut-cron blijft bijna gratis. Tekstuitvoer volgt het `next`-format.

## 2. Wait-checks (besluit H structureel)

`card log <id> "<note>" --check-after <waarde>` — het bestaande
`action_taken`-event krijgt een `check_after`-veld (ISO) in zijn
payload. `<waarde>` is een ISO-timestamp óf een duur-shorthand
(`30m`, `6h`, `2d`), door de CLI omgerekend naar ISO.

Gate-regel: per needs_input-kaart geldt het **jongste** event met een
`check_after` van ná de laatste statuswissel — een oude wait-check uit
een eerdere needs_input-episode telt niet. Verstreken (≤ nu) → de kaart
telt mee in de gate. Geen enkel check_after-event → de kaart komt
alleen terug via een human-actie. AGENT.md-regel 8 wordt aangescherpt:
een wait-state logt altijd mét `--check-after`.

## 3. De runner: `agentboard runner`

Eén testbaar CLI-commando in plaats van een los shellscript; alleen de
klok blijft buiten de tool. Verloop:

1. **Lock verwerven**: `<data>/session.lock` (JSON: pid, hostname,
   started_at). Bestaat hij: staleness-check — proces dood
   (`process.kill(pid, 0)` faalt) óf ouder dan het max-leeftijd-vangnet
   (default 2 uur, `AGENTBOARD_LOCK_MAX_AGE` in minuten) → stale lock
   opruimen en doorgaan; anders exit 0 ("session already running").
   Hostname ≠ eigen hostname → weigeren met duidelijke fout (één-
   machine-aanname; zie §8).
2. **Gate checken**: leeg → lock los, exit 0.
3. **Due-routines marken** (`markRoutineRun` per due-routine) — vóór de
   sessie start, zodat een crashende sessie niet elke minuut
   hertriggert.
4. **Sessie starten**: spawn `AGENTBOARD_SESSION_CMD` (default
   `claude -p`) met de startprompt als laatste argument. Stdout+stderr
   gaan ruw naar `<data>/sessions/<ISO-timestamp>.log` (map wordt
   aangemaakt; blok 4 vervangt dit door de JSONL+index-structuur).
   De startprompt (Engels) bevat: het pad naar AGENT.md
   (`AGENTBOARD_AGENT_MD`, default het meegeleverde AGENT.md in de
   package-root), de opdracht die regels te volgen, de due-routinepaden
   van deze run ("read each with `agentboard ctx show <pad>` and act
   per rule 16"), en de afsluiter "then work the board: run
   `agentboard next`".
5. **Notificatie** (§5), daarna **lock los** — ook bij een sessie die
   met een fout eindigt (try/finally).

Flags: `--dry-run` (print lock-status + gate + prompt, start niets) en
`--json`. De runner logt zijn eigen verloop naar stderr, één regel per
stap.

## 4. Twee aanroepers

- **Minuut-cron/launchd** draait `agentboard runner`. README krijgt een
  launchd-plist-voorbeeld (macOS) en een crontab-regel; installeren is
  de stap van de user.
- **Serve-hook (v1.5)**: na een geslaagde human-actie via de API
  (`POST /api/cards/:id/move` en `POST /api/cards/:id/comments`) spawnt
  de server het runner-commando fire-and-forget (detached, stdio
  ignore). Loopt er al een sessie, dan kaatst de lock hem af — de
  lopende sessie pakt nieuw werk via `next` mee. **Default uit**: de
  hook vuurt alleen wanneer `AGENTBOARD_AUTORUN=1` gezet is, zodat
  ontwikkel- en testsessies (Playwright!) nooit per ongeluk echte
  claude-sessies starten.

## 5. Notificaties (ultra-lean)

Na afloop van de sessie query't de runner de events sinds sessiestart:
`status_changed` door de agent naar `needs_input` of `review` →
distincte kaarten. Is er ≥1 én is `AGENTBOARD_NOTIFY_CMD` gezet, dan
wordt dat commando aangeroepen met één argument: een éénregelige
samenvatting ("2 cards wait on you: task_x (review), ops_y
(needs_input)"). Kanaalkeuze (ntfy, mail, wat dan ook) is van de user;
geen env-var = geen notificatie, geen fout; een falend notify-commando
logt naar stderr en breekt niets.

## 6. Minimale UI: de wachten-scheiding

- `enrichCardsIn` levert per kaart `wait_check: string | null` — de
  jongste `check_after` uit de events (null als er geen is).
- `needYouCount` (web) telt een needs_input-kaart níet mee wanneer zijn
  `wait_check` bestaat en in de toekomst ligt.
- De boardkaart toont daarvoor het klokje uit design 2a: grijze pil met
  klok-icoon ("waiting on external"), in plaats van de amber
  "your turn"-stijl. Meer veroudering-visuals blijven voor de UI-batch.

## 7. Hardenings (meegenomen uit de blok-2-parkeerlijst)

- `validateContent`/`writeContext`: `relPath` eerst normaliseren
  (`path.posix.normalize`) en absolute of `..`-paden weigeren — dicht
  de `./_global/`-omzeiling van de routine-plaatsingsregel.
- `assertRoutineFrontmatter`: strikte 5-velden-guard op de schedule
  (croner accepteert anders ook 6-velden en `@daily`, buiten het
  gedocumenteerde contract).

## 8. Documentatie

- README: de sectie "Trigger (design, not built)" wordt vervangen door
  de gebouwde werkelijkheid — gate, runner, launchd/cron-voorbeeld, de
  env-vars (`AGENTBOARD_SESSION_CMD`, `AGENTBOARD_AGENT_MD`,
  `AGENTBOARD_AUTORUN`, `AGENTBOARD_NOTIFY_CMD`,
  `AGENTBOARD_LOCK_MAX_AGE`), en expliciet de **één-machine-aanname**
  (gesyncte SQLite + PID-locks over machines heen is stille corruptie).
- AGENT.md: regel 8 aangescherpt (`--check-after` verplicht bij een
  wait-state), en een korte notitie dat sessies door de runner gestart
  kunnen worden met due-routines in de startprompt.

## 9. Buiten scope (bewust)

- Sessie-JSONL, index, redactie, logs-tab, observer (blok 4).
- Realtime board-updates (blok 5).
- Notificatiekanaal-implementaties (user-keuze via de env-var).
- Parallelle sessies (de lock is er klaar voor; niet nu).

## 10. Verificatie

Probes tegen een wegwerp-`AGENTBOARD_DATA`, met
`AGENTBOARD_SESSION_CMD` op een nep-script dat zijn argumenten en env
naar een bestand schrijft (geen echte claude-sessies):

1. Gate-matrix: ready-zonder-blockers telt; ready-met-open-blocker
   niet; kale needs_input niet; needs_input met verlopen check wél, met
   toekomstige check niet; doing@agent telt; due-routine telt.
2. `--check-after 2d` en ISO-waarden landen als ISO in de payload;
   jongste event wint.
3. Runner: lege gate → geen spawn, lock weg. Niet-lege gate → nep-cmd
   ontving de prompt (bevat AGENT.md-pad + routinepad), due-routine is
   gemarkeerd, logfile bestaat.
4. Lock: twee runners tegelijk → precies één spawn. Stale lock (dood
   pid) → opgeruimd en doorgestart. Vers lock van levend proces →
   tweede runner exit 0 zonder spawn.
5. Notify: nep-sessie beweegt een kaart naar review → notify-cmd
   ontving de samenvatting; zonder env-var geen aanroep, geen fout.
6. Serve-hook: `AGENTBOARD_AUTORUN=1` + comment via API → runner
   gespawnd (nep-cmd-bewijs); zonder de env-var geen spawn.
7. Hardenings: `ctx write ./_global/x.md` met kind: routine wordt
   geweigerd; `@daily` en 6-velden-schedules worden geweigerd.
8. UI: needs_input-kaart met toekomstige wait-check telt niet in
   "Needs me" en toont het klokje (screenshot); verlopen check → telt
   weer mee.
9. Regressie: `verify-blockers.sh` en `verify-routines.sh` blijven
   groen.
