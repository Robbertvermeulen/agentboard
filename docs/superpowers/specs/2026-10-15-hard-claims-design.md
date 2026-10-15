# Spec: harde claims, de runner deelt kaarten uit

Datum: 2026-10-15. Vervangt het claim-deel van
`2026-08-25-blockers-claiming-design.md` (regel 15-ritueel) en de
gelijktijdigheidsfixes uit 0.22.1 en 0.22.2 (`doingClaimsIn`,
`adoptOrphanedDoing`, `runnersAhead`).

## Aanleiding

Op 2026-10-15 werkten sessies 337 en 338 tegelijk aan dezelfde kaarten:

- **task_94f4:** 337 was klaar met zijn eigen kaart, zag task_94f4 in de
  gate en bouwde er tien minuten aan zonder te claimen. Intussen claimde
  338 hem, legde twee vragen voor en zette hem op needs_input. 337 opende
  daarna PR #114 alsof er niets gebeurd was.
- **task_5ae3:** 338 las de kaart om 11:00, claimde om 11:04:52 en
  beantwoordde een vraag die 337 al beantwoord had. Jouw nieuwe opdracht
  van 11:04:01 miste hij.
- Om 10:19 schreef een sessie een comment op task_5ae3 voor zijn claim.

Oorzaak: claimen is een afspraak in AGENT.md en een claim controleert
alleen de status, niet of de kaart veranderd is. Sessies kiezen zelf
kaarten op basis van een beeld dat verouderd kan zijn.

## Doel

Twee sessies werken nooit tegelijk aan dezelfde kaart, en een agent
schrijft nooit op een kaart op basis van een verouderd beeld. Afgedwongen
in de core, niet alleen in AGENT.md.

Succescriteria:

1. Twee runners die tegelijk starten met één ready kaart: precies één
   sessie krijgt hem.
2. Een agent kan niet schrijven op een kaart die zijn sessie niet
   vasthoudt (behalve een verzoek-comment, sectie 5).
3. Een agent kan niet schrijven als er sinds zijn laatste lezing iets
   nieuws op de kaart staat van een mens of een andere sessie; de fout
   toont wat er nieuw is.
4. Een gecrashte, vastgelopen of door een herstart gestopte sessie laat
   geen claim achter die werk blokkeert.
5. Een kaart die steeds sessies laat stranden, start niet eindeloos
   nieuwe sessies.
6. Een kaart staat binnen enkele seconden op doing nadat jij hem op
   ready zet, als er een slot vrij is.

## Begrippen

- **Houder:** de sessie waarvan het nummer in `card.claimed_by` staat.
- **Levende sessie:** zoals nu in `liveSessionIds()`: lockfile met levend
  proces op deze host plus een open sessierecord.
- **Geldige claim:** `claimed_by` verwijst naar een levende sessie. Een
  claim van een dode sessie geldt overal als vrij; opruimen is hygiëne,
  geen voorwaarde voor correctheid.
- **Toegewezen kaart:** de kaart die de runner bij de start aan een
  sessie geeft (`session.card_id`). Hooguit één per sessie.
- **Extra claim:** een kaart die een sessie zelf vastpakt met
  `card claim`.

## 1. Datamodel en migratie

Nieuwe kolommen, via `ALTER TABLE ADD COLUMN` in `initData` (bestaand
patroon):

- `card.claimed_by INTEGER` (NULL = vrij): sessienummer van de houder.
- `card.claim_seen_at TEXT` (NULL = houder heeft de kaart nog niet
  gelezen): tot welk moment de houder de kaart gezien heeft.
- `card.human_edited_at TEXT`: gezet bij elke `editCard` door een mens.
  Titel- en tekstbewerkingen blijven stil in de tijdlijn; deze kolom
  maakt ze zichtbaar voor de versheidscheck.
- `comment.session_id INTEGER`: sessie die het comment schreef (NULL
  voor mens en voor agent-writes buiten een sessie).
- `session.card_id TEXT`: de toegewezen kaart van die sessie (NULL voor
  routine-only en observer-sessies).

Geen nieuwe event-kinds. Overgang: kaarten die bij de deploy op doing
staan hebben `claimed_by` NULL en zijn dus vrij; de runner wijst ze toe
als hervatting (sectie 7). Bestaande `/data/work` en `/data/work-slot-N`
blijven staan en worden niet meer gebruikt; opruimen doet de mens.

## 2. Toewijzen door de runner

`runSession` (zonder `promptOverride`) doet na het nemen van een slot,
in één `immediate`-transactie:

1. Kandidaten zoals de huidige gate: ready zonder open blockers, doing,
   needs_input met verlopen wachtpunt. Kaarten met een geldige claim
   vallen af. Volgorde: `updated_at ASC` (ongewijzigd).
2. Neem de eerste kandidaat X. Is X doing (hervatting), pas eerst de
   crash-lus-check toe (sectie 7); valt X daardoor af, neem de volgende.
3. Zet `claimed_by` = nieuw sessienummer, `claim_seen_at` = NULL, en
   status op doing als hij dat nog niet was. Event `status_changed` met
   actor `agent`, `session` gestempeld, reden:
   - uit ready: `Assigned to session N`
   - uit needs_input: `Check due, assigned to session N`
   - doing blijft doing: `Resumed: session M ended without finishing`
     (of `Resumed: unclaimed doing card`)
4. Zet `session.card_id` = X.

Het sessierecord wordt in dezelfde transactie aangemaakt, zodat er nooit
een claim bestaat naar een sessienummer zonder record. Geen kandidaat en
geen due routines: geen sessie (zoals nu `gate empty`).

Hierdoor vervallen `runnersAhead`, `adoptOrphanedDoing`,
`doingClaimsIn` en `claimingSessions`; de transactie maakt ze overbodig.
Het sessiestempel op `status_changed` blijft (historie).

Routines: due routines gaan mee met de sessie zoals nu, naast hooguit één
toegewezen kaart. Een sessie met alleen routines krijgt geen kaart.

## 3. Prompt en `next`

- `buildPrompt` krijgt de toegewezen kaart: "Your card this session: X.
  Start with `agentboard card show X`. Work only this card; touching
  another card needs `agentboard card claim <id>` first (AGENT.md rule
  15)." Zonder kaart (routine-only) blijft de routinetekst zoals nu.
- `next` binnen een sessie (`AGENTBOARD_SESSION_ID` gezet) toont alleen
  kaarten die deze sessie vasthoudt. Buiten een sessie ongewijzigd.
- `gate` sluit kaarten met een geldige claim uit (vervangt de huidige
  `busy`-logica).

## 4. Schrijfregels in de core

Geldt voor elke schrijfactie met actor `agent` terwijl
`AGENTBOARD_SESSION_ID` gezet is: `moveCard`, `addComment`, `logEvent`,
`editCard`, `removeBlocker`, `writeContext` (via `--card`), en
`createCard` met `--blocks` (dat schrijft op de doelkaart).

1. **Houder-check:** de sessie moet geldige houder van de kaart zijn.
   Anders fout:
   - kaart heeft een andere levende houder: `Card X is held by session
     M. Use 'card comment X --request' to ask, or wait.`
   - kaart is vrij: `Card X is not yours. Claim it first: agentboard card
     claim X`
   - claim is ingetrokken door de mens (sectie 6): dezelfde "not yours"
     fout.
2. **Lees-check:** `claim_seen_at` is NULL, dan fout: `Read the card
   first: agentboard card show X`.
3. **Versheidscheck:** er is iets nieuw na `claim_seen_at`, dan fout met
   de lijst nieuwe items (soort, tijd, auteur, eerste 300 tekens), en
   `claim_seen_at` wordt op nu gezet. Een tweede poging slaagt dus, nadat
   de agent het gezien heeft. Nieuw telt:
   - comments met `created_at` of `updated_at` na `claim_seen_at`, van
     een mens, of van een agent met een ander `session_id`;
   - events met actor `human` na `claim_seen_at`;
   - `human_edited_at` na `claim_seen_at`.

`card show X` door de houder zet `claim_seen_at` op nu. Een geslaagde
schrijfactie door de houder verschuift `claim_seen_at` niet: wat de
agent zelf schrijft is niet nieuw voor hem, en wat anderen schreven moet
hij nog zien.

`--as human` binnen een sessie: fout (`An agent session cannot act as
human`). `secret set` heeft geen actor en blijft toegestaan: regel 14
laat de agent een duurzaam token in de vault zetten.

`createCard` door een agent in een sessie maakt de nieuwe kaart direct
eigendom van de sessie (`claimed_by` gezet, `claim_seen_at` = nu). Een
ops card of routinekaart kan dus meteen een comment krijgen. Een
routinekaart die als ready begint, wordt pas toegewezen als de routine-
sessie stopt; de sessie werkt hem zelf niet uit, tenzij hij hem zelf naar
doing zet.

`card claim X` op een kaart die de sessie al vasthoudt, slaagt zonder
iets te wijzigen behalve `claim_seen_at` (zoals `card show`).

Buiten een sessie (CLI via ssh, lokale handmatige runs) gelden deze
regels niet; ongewijzigd gedrag. Zie Buiten scope.

## 5. Extra claims en verzoeken

- **`card claim X`** (nieuw CLI-commando, core `claimCard`): één
  `immediate`-transactie. Lukt als X geen geldige houder heeft en niet
  done of archived is. Zet `claimed_by` en `claim_seen_at` = nu, verandert
  de status niet, schrijft een event `action_taken` (`Claimed by
  session N`). Uitvoer: dezelfde weergave als `card show`, dus de
  actuele kaart met alle comments. Mislukt met de houder-fout als een
  andere levende sessie hem heeft.
- Een houder mag de status van een extra geclaimde kaart wijzigen zoals
  van zijn toegewezen kaart (bijvoorbeeld ready naar doing).
- **`card comment X --request "<tekst>"`**: de enige schrijfactie op een
  kaart van een andere levende houder. Alleen toevoegen. De core zet er
  `Request from [<eigen kaart>](<origin>/#/card/<id>) (session N):`
  voor, met de toegewezen kaart van de sessie, of alleen `(session N)`
  zonder toegewezen kaart. `session_id` wordt gestempeld, dus de houder
  ziet het bij zijn volgende schrijfactie via de versheidscheck. Op een
  vrije kaart weigert `--request` met "claim it instead"; op een eigen
  kaart is het een gewoon comment.
- Twee sessies die elkaars kaart willen, lopen niet vast: een claim
  wacht nooit, hij mislukt direct.

## 6. Einde van een claim

- **Sessie stopt** (normaal, crash of timeout): de runner wist in zijn
  afsluitcode `claimed_by` en `claim_seen_at` voor alle kaarten van die
  sessie.
- **Machine herstart:** de afsluitcode draait niet. `run.sh` roept na het
  verwijderen van de lockfiles `agentboard sessions recover` aan: sluit
  open sessierecords (`ended_at` = nu, `exit_status` NULL) en wist alle
  claims. Tot dan geldt de claim al als ongeldig (geen levend proces).
- **Statuswijziging door een mens:** `moveCard` met actor `human` wist
  `claimed_by` en `claim_seen_at` in dezelfde transactie. De sessie die
  hem had, krijgt bij zijn volgende schrijfactie de "not yours" fout. Een
  comment of bewerking door een mens trekt de claim niet in; die gaat
  via de versheidscheck.
- **Inleveren door de agent** (doing naar needs_input, review of ready)
  trekt de claim niet in. Met één kaart per sessie stopt de sessie kort
  daarna; zo kan de agent na zijn move nog een comment of log schrijven.

## 7. Tijdslimiet en crash-lus

- **Tijdslimiet:** `spawnSync` krijgt `timeout` uit
  `AGENTBOARD_SESSION_TIMEOUT_MIN` (standaard 45, decimalen toegestaan
  voor tests) en `killSignal` SIGTERM. Afloop telt als gestrand: het
  sessierecord krijgt `exit_status` NULL en de runner logt
  `session timed out`.
- **Crash-lus:** bij een hervatting (stap 2 van sectie 2) telt de runner
  de `Resumed`-events op X sinds de laatste event of comment van een
  mens. Is dat aantal al `AGENTBOARD_RESUME_LIMIT` (standaard 2), dan
  wijst hij X niet toe maar zet hem op needs_input met een `error`-event:
  `Stopped resuming: sessions M, N ended without finishing this card`.
  Een menselijke actie zet de teller dus terug.

## 8. Direct de volgende sessie

Na afloop van een sessie (na het wissen van de claims en het vrijgeven
van het slot) start de runner een nieuwe runner op dezelfde manier als
`maybeAutorun` in de server: losgekoppeld, alleen als
`AGENTBOARD_AUTORUN=1`. Is de gate leeg, dan stopt die meteen. Zo hoeft
een kaart die wacht op een vrij slot niet op de cron te wachten.

## 9. Werkmap en tijdelijke bestanden

- **Werkmap per kaart:** `AGENTBOARD_WORK` en de cwd van de sessie worden
  `<base>/cards/<kaart-id>` voor een sessie met toegewezen kaart, en
  `<base>/sessions/<sessienummer>` voor een sessie zonder (routines,
  observer). `<base>` is zoals nu `AGENTBOARD_WORK` van de server of
  `<data>/work`. Werk aan extra geclaimde kaarten gebeurt in de werkmap
  van de toegewezen kaart; branches per kaart (regel 12) houden het
  gescheiden.
- **Opruimen:** na afloop van elke sessie verwijdert de runner
  `cards/<id>` voor kaarten die done of archived zijn en geen geldige
  houder hebben, en `sessions/<n>` van afgelopen sessies. Een map met een
  git-repo met ongecommit werk of commits die niet op de remote staan
  wordt overgeslagen en gelogd (`workdir kept: <pad>, unpushed work`).
  Reden: het volume is 2,9 GB en een clone per kaart groeit sneller dan
  een clone per slot.
- **TMPDIR per sessie:** `TMPDIR`, `TMP` en `TEMP` wijzen naar
  `<data>/tmp/session-<n>`, aangemaakt bij de start en verwijderd in de
  afsluitcode.

## 10. AGENT.md

- **Regel 15:** het claim-ritueel (`card move doing --from ready`) vervalt.
  Nieuw: de runner wijst je kaart toe en zet hem op doing; begin met
  `card show`. Een andere kaart aanraken: eerst `card claim`; mislukt
  dat, dan schrijf je niets op die kaart. Je kunt wel een verzoek doen
  met `card comment --request`, of op je eigen kaart een wachtpunt
  zetten, of de kaart via needs_input aan de mens geven. Een fout van de
  versheidscheck betekent: lees wat nieuw is, neem het mee, probeer
  opnieuw. Inleveren is je laatste stap.
- **Regel 12:** `$AGENTBOARD_WORK` is per kaart; ga er niet van uit dat
  een eerdere clone er staat.
- **Regel 6:** een externe actie (issue, PR, Trello-comment, deploy)
  eerst als voornemen loggen, dan uitvoeren, dan het resultaat loggen.
  Bij hervatten eerst controleren of hij al bestaat.
- **Nieuw, werkplaats:** testservers op een vrije willekeurige poort,
  tijdelijke bestanden alleen in `$TMPDIR`.

## 11. Verificatie

`docs/superpowers/plans/verify-claims.sh`, in het patroon van de
bestaande verify-scripts: wegwerp `AGENTBOARD_DATA`, nep-
`AGENTBOARD_SESSION_CMD` scripts die CLI-commando's uitvoeren, nooit een
echte `claude`. Benen:

1. **Race:** één ready kaart, twee runners tegelijk gestart: precies één
   sessie met `card_id`, de andere zonder sessie.
2. **Toewijzing:** kaart staat op doing met het juiste event voordat het
   nepscript draait; prompt noemt de kaart; `next` in de sessie toont
   alleen die kaart.
3. **Schrijfregels:** schrijven zonder `card show` geweigerd; op een
   vrije kaart geweigerd; op een kaart van een andere (nagebootste
   levende) sessie geweigerd; `--request` daar toegestaan en met
   voorvoegsel; `--as human` geweigerd; nieuwe kaart direct schrijfbaar.
4. **Versheid:** nepsessie leest, daarna een comment door een mens (van
   buiten de sessie), en een titelbewerking door een mens; de volgende
   agent-write faalt met beide in de fout, de herhaling slaagt.
5. **Scenario 5ae3:** sessie A houdt X; sessie B probeert X te claimen:
   faalt. A stopt; B claimt; de uitvoer bevat het nieuwste comment.
6. **Mens trekt in:** mens zet de kaart terug naar ready tijdens de
   sessie; volgende agent-write faalt met "not yours".
7. **Crash:** nepsessie eindigt met exit 1 terwijl de kaart doing is:
   claim gewist, volgende runner hervat met `Resumed`-event; na twee
   hervattingen zonder menselijke actie: needs_input met `error`-event.
8. **Timeout:** `AGENTBOARD_SESSION_TIMEOUT_MIN=0.05` met een
   slapend nepscript: gestopt, claim gewist, telt als gestrand.
9. **Recover:** open sessierecord en claim achterlaten, `sessions
   recover`: record gesloten, claim weg.
10. **Werkmap en TMPDIR:** nepscript print `$AGENTBOARD_WORK`, cwd en
    `$TMPDIR`; paden kloppen; TMPDIR na afloop weg; werkmap van een done
    kaart opgeruimd, die van een done kaart met een niet-gepushte commit
    blijft staan.
11. **Migratie:** database aangemaakt met v0.23.0 (git worktree van de
    tag), daarna `init` met de nieuwe code: kolommen aanwezig, een
    bestaande doing kaart wordt toegewezen als hervatting.

Daarna één keer handmatig in productie na de deploy: een kaart op ready
zetten en zien dat hij binnen enkele seconden op doing staat, en een paar
dagen de logs volgen.

## Buiten scope (losse kaarten op het agentboard-bord)

- Lokale agent-sessies zonder sessienummer vallen buiten de schrijfregels.
- Drain-stand voor updates bij drukte.
- Geheugen en kosten van vaker 3 parallelle sessies meten; dagbudget.
- Een agent die werk doet zonder te schrijven, of rechtstreeks in de
  database schrijft, wordt niet tegengehouden (bewust; de regels vangen
  vergissingen, geen opzet).
- UI: de "live session"-regel nauwkeuriger maken met `claimed_by` hoort
  bij PR #114 (task_94f4).
