# Design-brief: uitbreiding Agentboard-UI

Datum: 2026-08-25. Kader: `2026-08-24-agentboard-vision.md`. Basis: het
bestaande design v3-canvas (`docs/design/Agentboard.dc.html`) — alles
hieronder is uitbreiding in dezelfde vormtaal, één samenhangende ronde.

Principes die overal gelden (uit de visie en de UX-review):

- Status = wie is aan zet; de UI bewaakt dat mentale model.
- Nooit doen alsof: geen activiteitsclaims zonder levende sessie (de
  bestaande "queued"-toon is de norm).
- "Needs me" telt alleen kaarten waar de user écht iets kan doen.

## 1. Beurtwissel-interacties (bestaande card-detail)

- **"Reply & hand back"** als primaire knop op de composer van een
  needs_input- of review-kaart: comment plaatsen + kaart naar `ready`
  in één handeling ("Just comment" secundair). De reason-dialog
  vervalt hier — de comment ís de reden.
- Quick actions sturen nooit naar `doing`: "Send back to doing" en
  "Request changes → doing" worden "hand back" naar `ready`. `doing`
  is exclusief de agent.
- Review-kaart: goedkeuren naar `done`; bij open blockers een
  bevestiging (signaleren, niet blokkeren).

## 2. Twee soorten wachten (board + card-detail)

- needs_input mét wait-check ("wacht op extern": mail, deploy) krijgt
  een klokje en telt niet mee in "Needs me"; zonder wait-check blijft
  het de bestaande "jouw beurt"-weergave.
- Veroudering zichtbaar: "blocked 12d" op blocker-chips, en een stille
  needs_input-kaart die dagen staat wordt visueel zwaarder.

## 3. Blockers (bouwblok 1 — chips volgen bestaand idioom)

- Boardkaart: compact chipje met aantal open blockers.
- Card-detail: chip per blocker (klikbaar; afgerond = afgevinkt/
  gedimd); op een ops card de omgekeerde groep "unblocks task_x".
- Timeline-regel voor `blocker_added`.

## 4. Routines

- Menu-item links. All-boards: alle routines gegroepeerd per board;
  board-view: alleen dat board. Lijst in een modal/popup, read-only.
- Per routine: naam, schedule, laatste run (klikbaar naar de
  gegenereerde kaart), volgende run — plus een directe pauze-toggle
  (de enige beheeractie in de UI; de rest gaat via ops cards).
- ↻-chip op board- en detailkaarten die uit een routine komen.

## 5. Agent-logs-tab (bouwblok 4)

- Samenvatting eerst. Sessielijst: nummer, trigger (cron /
  status-change / routine), duur, geraakte kaarten, uitkomst in één
  regel. Detail: stappen als één-regel-items (tool call → resultaat),
  reasoning standaard ingeklapt, live tail onderaan.
- Vanaf een kaart naar de sessie-fragmenten die díe kaart raakten —
  dit is de hoofdvraag ("wat heeft hij hier gedaan?"), belangrijker
  dan de sessielijst zelf.

## 6. Realtime- en aanwezigheidssignalen (bouwblok 5)

- Kaart schuift live naar `doing`; nieuwe comments verschijnen zonder
  verversen.
- `doing` mét levende sessie (pulse/heartbeat) versus `doing` zonder:
  "wordt hervat bij de volgende sessie" — een crash mag nooit als
  kapot aanvoelen.

## 7. Secrets-intake in de timeline

- De intake verhuist naar ónder de comment van de agent die erom
  vraagt (nu: los blok op de ops card).
- Gerichte her-aanvraag: één fout secret → nieuwe mini-intake voor
  alleen dat secret onder de nieuwe comment; de eerdere lock-chip
  wordt "opnieuw nodig" (nooit "stored" laten staan over een
  afgekeurde waarde).

## Buiten scope van deze ronde

Notificatie-kanaal (bouwblok 3, vorm nog open), zoeken/filters,
bulk-archiveren, onboarding-seed (geparkeerd in de visie).
