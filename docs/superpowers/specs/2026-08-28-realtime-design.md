# Spec: realtime UI (bouwblok 5)

Datum: 2026-08-28. Kader: `2026-08-24-agentboard-vision.md` (besluit K,
journey 8; design 2h minimaal — datacorrect eerst, choreografie is
polish). Ontwerp in-chat goedgekeurd op 2026-08-27, inclusief de
afwijking van besluit K's letter hieronder.

## Doel

Het board en de kaartweergave verversen zichzelf: een kaart schuift
naar doing terwijl je kijkt, een comment verschijnt zonder refresh, de
heartbeat wisselt live. Eén goedkoop poll-kanaal dat later ongewijzigd
de SSE-drager wordt — en in blok 4b de live tail voedt.

## 1. Het kanaal: samengestelde versie-cursor (K-amendement)

Besluit K sprak van een cursor over de event-tabel. Bij uitwerking
blijkt dat te smal: een **nieuwe kaart** schrijft geen event (alleen
statuswissels doen dat), een kaart-edit ook niet, en comments zijn geen
events. Daarom:

`GET /api/changes[?since=<cursor>]` → `{ cursor, changed }`

- De cursor is een opaque string, samengesteld uit drie maxima:
  hoogste event-id, hoogste comment-id, jongste `card.updated_at`
  (formaat `e<id>.c<id>.u<iso>`; alleen de server interpreteert hem).
- `changed` = een van de drie componenten is voorbij de meegegeven
  `since`. Zonder `since`: huidige cursor, `changed: false`.
- Drie MAX-queries per aanroep — vrijwel gratis, elke 2,5 s aan te
  roepen. SSE wordt later een tweede transport op ditzelfde endpoint;
  het cursorbegrip verandert niet. Het visiedocument (besluit K) krijgt
  in dezelfde commit een amendement dat deze verbreding vastlegt.
- *Amendement 2026-08-28 (eindreview blok 5):* de cursor draagt ook
  sessie-liveness mee (max sessie-id + running-vlag), zodat
  heartbeat-presence ook bij een sessiecrash of -stilte binnen enkele
  ticks omklapt.

## 2. De client-loop (app-shell)

- Eén poller in `app.js`: elke 2,5 s `api.changes(cursor)`; alleen bij
  `changed` wordt de huidige view ververst. Fouten zijn stil (volgende
  tick probeert opnieuw).
- **Pauzeert** wanneer het tabblad onzichtbaar is (`visibilitychange`);
  hervat met een directe check bij zichtbaar worden.
- **Verversgedrag per route:**
  - Board / all-boards / archief / ctx: de route opnieuw renderen
    (goedkoop, lokale API) — sidebar-tellers en heartbeat-presence
    verversen automatisch mee. **Guard:** nooit verversen terwijl een
    overlay open staat (create-dialog, statusmenu, reason-dialog,
    routines-modal) — check op de overlay-container.
  - Kaartdetail: géén blinde rerender. De bestaande beschermmachinerie
    (fingerprint + `dirty()`: composer-tekst, intake-invoer, open
    comment-editor, staged uploads, scroll-behoud) blijft de poort; de
    globale poller vervangt alleen de trage interne 30s-timer als
    signaalbron. De kaartview exporteert daarvoor een
    refresh-hook die de poller aanroept.
- De sessie-status (heartbeat) rijdt mee in de view-verversing; geen
  aparte poll.

## 3. Zichtbaar leven (design 2h, minimaal)

- Board: een kaart die sinds de vorige render van kolom wisselde of
  nieuw verscheen krijgt een korte highlight-pulse (vergelijking op een
  id→status-kaartje in modulestate; bestaande `flash`-stijl als basis).
- Kaartdetail: een binnengekomen comment krijgt de bestaande
  flash-markering.
- De volledige 2h-choreografie (ghost-slot, "arriving live"-schuif)
  blijft polish-batch.

## 4. Ride-along (klein)

Routines-modal: een overdue routine toont "overdue" in plaats van de
verwarrende verleden-tijd-copy ("next 3h ago") — het blok-2-parkeerpunt.

## 5. Buiten scope (bewust)

- SSE (zelfde endpoint, later transport).
- Selectieve DOM-updates (v1 rendert de view; goedkoop op deze schaal).
- Wijzigingen aan de wachten-scheiding, blockers of sessies-UI.
- 4b (logs-overzicht + live tail) — gebruikt dit kanaal straks wel.

## 6. Verificatie

1. API-probes: cursor beweegt bij (a) status-move (event), (b) comment,
   (c) kaart-edit, (d) kaart-aanmaak; `changed` is false bij een
   identieke cursor en true bij elke component afzonderlijk.
2. Browser (Playwright): board open → kaart via CLI verplaatsen →
   binnen ~3 s zichtbaar verplaatst mét highlight, zonder reload.
   Kaartdetail open → comment via CLI → verschijnt met flash; met
   tekst in de composer → verversing wacht (dirty-guard), na legen komt
   hij alsnog. Overlay open (create-dialog) → geen verversing.
3. Heartbeat: runner-loop aan/uit → presence wisselt vanzelf op het
   board binnen enkele ticks.
4. Overdue-routine toont "overdue" in de modal.
5. Regressie: de vier verify-scripts groen; kaartview-gedrag
   (comment-edit, uploads, intake, tabs) onaangetast.
