# Spec: polish-batch (mobiel, doing-bevestiging, intake-anker, veroudering, choreografie, kleintjes)

Datum: 2026-09-02. Kader: `2026-08-24-agentboard-vision.md`; design-ronde 3
(artboards 3a/3b/3c, geïmporteerd 2026-09-02) + bestaande artboards 2a/2h.
De laatste geplande ronde: hierna is de visie gebouwd én gepolijst.

## Doel

De gaten dichten die livegebruik en de eindreviews van blok 5/4b
aanwezen: mobiel bereik voor alle bestemmingen, het doing-ontsnappingsluik
met bevestiging, een onverbergbaar intake-anker, zichtbare veroudering,
een nettere aankomst-animatie, en de geparkeerde kleintjes.

## 1. Mobiele navigatie (3a)

- Tabbar wordt drie bestemmingen + **More**: Board, Context, Agent log,
  More. More opent een bottom-sheet (via de bestaande `#overlay`-
  machinerie, dus de poll-guard geldt vanzelf) met: Routines (opent de
  bestaande read-only modal, over het board), Archive, en de
  board-switcher (lijst met boards, huidige gemarkeerd).
- De More-tab draagt een badge wanneer ten minste één routine gepauzeerd
  staat (`enabled: false` in de bestaande `GET /api/routines`-respons) —
  de verstopte laag mag niet stil falen. De sheet toont per regel de
  meta uit het ontwerp ("4 · 1 paused", "128 cards · searchable").
- Agent log op mobiel: tegels 2×2, samenvattingszin en lijstrijen
  gestapeld (ontwerp 3a, vierde paneel) — CSS-only, geen aparte view.

## 2. Doing-bevestiging in het statusmenu (3b)

- Dit voert de middenoptie uit en sluit daarmee het open besluit
  (laten/bevestigen/weghalen → **bevestigen**).
- Het menu-item `doing` blijft, maar gemarkeerd als uitzonderingspad:
  gestippelde rand, "agent"-label, voetnoot "doing is the agent's
  column — asks first." (vormtaal 3b).
- Klik opent één bevestigingsdialog (bestaande overlay): wat er gebeurt,
  waarom `ready` de normale route is, en twee uitwegen ("Move to doing
  anyway" / annuleren). Geen reden-veld — de move zelf krijgt de vaste
  reason `moved to doing by user (confirmed)`.
- *Afwijking van het artboard:* de regel "Next scheduled session: 09:00
  tomorrow" vervalt — de serve-laag kent de cron-cadans niet en de UI
  claimt niets dat hij niet weet (eerlijkheidsprincipe). Wel de wél
  afleidbare regel: "no live session right now" / "a session is running
  now" uit de bestaande sessiestatus.

## 3. Intake-anker (3c)

- Kaartkop krijgt een blijvende chip zodra er een **onbeantwoord**
  secret-verzoek staat: "N open request(s) · secret". Afleiding: het
  nieuwste agent-comment met een `secret_ref:`-regel waarvan nog niet
  alle namen een later `secret_stored`-event hebben — dezelfde afleiding
  die de intake en "needed again" al gebruiken. **Geen nieuwe
  event-kinds** (het artboard tekent een `secret_requested`-event; dat
  bestaat bewust niet — de chip vervangt die zichtbaarheid).
- Klik: timeline-filter terug naar All (indien nodig), scroll naar de
  intake, korte markering ("jumped here"-flash in de bestaande
  flash-stijl).
- Onder het Events-filter (of elk filter dat het verzoek verbergt) een
  hintregel in de timeline: "This filter hides an open request." met een
  Show all-link — zelfde sprong.
- Boardkaart: mini-chip "N request(s)" in de bestaande chip-rij; de
  kaart telt al mee in "Needs me" (needs_input zonder wait-check),
  daar verandert niets aan.

## 4. Veroudering (2a — het restant)

- Kaarten in `needs_input` (zonder wait-check) en `review` tonen hoe
  lang de bal al bij de mens ligt: "waiting on you · 4m/3h/6d", afgeleid
  van de laatste statuswissel (events zijn er al). Vanaf 3 dagen wordt
  de weergave zwaarder (accentkleur, zelfde drempelidee als het
  artboard).
- Blocker-chips op kaartdetail tonen de leeftijd van de blokkade
  ("blocked 12d", uit het `blocker_added`-event van de open blocker).
- Geen nieuwe data, alles afgeleid uit bestaande events; geen zwaardere
  weergave voor externe waits (die zijn al gedempt met het klokje).

## 5. Aankomst-choreografie (2h — minimaal)

- De bestaande tile-pulse op verplaatste/nieuwe kaarten wordt de
  2h-aankomst: korte slide-in + settle (translateY + schaduwring die
  uitdooft), en een tijdelijk "just moved here"-labeltje dat na de
  animatie verdwijnt. Puur CSS + de bestaande lastSeen-vergelijking.
- De eigen-move-flash (blok-5-parkeerpunt) wordt hier meteen gedempt:
  een move die deze client zelf initieerde (module-vlag rond de eigen
  API-call) flitst niet.

## 6. Kleintjes (geparkeerd uit blok 5/4b, met ruling al vastgelegd)

- Intake: half ingevuld naam/waarde-veld en gekozen key-file overleven
  een filterwissel (state buiten de rerender bewaren, zoals de composer).
- Card Activity-tab gebruikt `triggerLabel` (nu rauwe triggerwaarde).
- Agent log: de "touched M cards"-tegel telt kaarten van
  observe-sessies niet mee ("touched" blijft letterlijk); de
  sessies-tegel telt ze wel (eerlijk).
- Sessiedetail: heartbeat toont kaal "live" tot de eerste waargenomen
  nieuwe stap (geen "last step 2s ago" op paginalaad-seed).
- Sessiedetail: de eindrender na `!live` krijgt een routeguard
  (`parseRoute().name === 'session'`) tegen de wegnavigeer-race.
- CLI `sessions list/show`: een open rij zonder lock-bevestiging heet
  ook daar "ended early (crash)" (CLI mag `sessionStatus` gebruiken;
  cli importeert runner al).
- Realtime: comment-edits propageren — extra cursorcomponent
  `MAX(comment.updated_at)` in `changesSince` én dezelfde term in de
  kaart-fingerprint. Cursor blijft opaque; formaatwijziging is gratis.
- Sidebar-boardlijst ververst mee bij een poll-rerender (cache-bust in
  `route()`), zodat een elders aangemaakt board zonder reload verschijnt.

## 7. Buiten scope (bewust)

- Volledige 2h-ghost-slots en "arriving live"-schuif per kolom.
- Crash-rij trailing-partial-line (vergt liveness-kennis in het
  core-leespad), overlay/tail-cadans-asymmetrie, observe-lockmelding-
  variant: genoteerd, geaccepteerd.
- Sessies filteren/zoeken; SSE; observer-cron.
- Desktop-navigatie en alle bestaande gedragscontracten (dirty-guards,
  overlay-guard, busy-flag) blijven ongewijzigd.

## 8. Verificatie

1. Browser mobiel (Playwright, 390×844): vier tabs, More-sheet met
   badge bij gepauzeerde routine, routines-modal over het board,
   Agent log gestapeld.
2. Doing-pad: statusmenu toont markering; bevestigen → move met vaste
   reason; annuleren → niets; dialog toont alleen afleidbare
   liveness-copy.
3. Intake-anker: verzoek + Events-filter → chip én hintregel zichtbaar,
   klik herstelt filter en springt; na `secret_stored` van alle namen
   verdwijnen chip en mini-chip.
4. Veroudering: kaart >3d in needs_input toont zwaardere copy
   (event-datum backdaten in de wegwerp-db); blocker-chip toont "blocked
   Nd".
5. Choreografie: CLI-move → slide-in + label, eigen UI-move → geen flash.
6. Kleintjes elk een probe- of Playwright-leg; comment-edit-propagatie
   als extra leg in verify-realtime.sh (edit beweegt cursor én
   fingerprint).
7. Regressie: alle zes verify-scripts groen; kaartdetail-gedrag
   (composer, uploads, intake, tabs, hand-back) onaangetast.
