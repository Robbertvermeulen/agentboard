# Spec: beurtwissel + secrets-intake (UI-batch, design 2b/2c/2d)

Datum: 2026-08-27. Kader: `2026-08-24-agentboard-vision.md` (besluit I,
journey 1 en 2; UX-review a2/a3/b8). Design v4 artboards 2b, 2c en 2d
zijn leidend. Pure UI-batch plus één AGENT.md-regelverfijning; geen
schema- of API-wijzigingen.

## Doel

De beurtwissel wordt één handeling in plaats van vijf, quick actions
sturen nooit meer naar `doing`, en de secrets-intake verhuist naar de
plek waar het gesprek gebeurt: onder de agent-comment die erom vraagt —
met een eerlijke "needed again"-staat voor afgekeurde secrets.

## 1. Reply & hand back (design 2b)

- Composer op een **needs_input**-kaart: primaire donkere knop
  **"Reply & hand back → ready"** naast een secundaire "Just comment".
  Hand back: comment plaatsen én `move ready` met reden
  `answered in comment`, in die volgorde (comment eerst, zodat de
  agent-sessie hem ziet vóór de status wisselt en de serve-hook vuurt).
  Twee bestaande API-aanroepen; geen nieuw endpoint.
- De knop is disabled bij een lege composer (je antwoord ís de reden);
  de copy onder de composer wordt design 2b's "No reason dialog here:
  your comment is the reason. Only the agent moves a card to doing."
- Mobiel: de primaire actie op een needs_input-kaart wordt
  "Hand back → ready" (composer-tekst als comment+reden; leeg →
  focus op de composer).

## 2. Review-kaart (design 2c-rest)

- "Request changes" richt voortaan op **`ready`**, nooit `doing`:
  composer met tekst → comment + move ready (reden
  `changes requested in comment`); lege composer → de bestaande
  reason-dialog, maar met doel `ready`.
- "Approve → Done" blijft zoals hij is, inclusief de
  open-blocker-waarschuwing uit blok 1.
- De quick action "Send back to doing" verdwijnt overal (desktop én
  mobiele actiebalk). **Het volledige statusmenu blijft compleet** —
  ook `doing` — als escape hatch: invarianten beperken de agent, nooit
  de mens. Alleen de aangeboden sneltoetsen sturen op het beurten-model.

## 3. Secrets-intake in de timeline (design 2d)

- De intake nestelt zich **onder de jongste agent-comment die een
  `secret_ref:`-regel bevat** (ingesprongen, border-left, per design).
  Verzoeken worden dus voortaan uit body **én** agent-comments geparsed;
  staat het verzoek alleen in de body (bestaande kaarten), dan rendert
  de intake op de huidige plek boven de timeline — geen breuk.
- **Gerichte her-aanvraag zonder nieuw event-kind:** een naam is
  "needed again" wanneer hij voorkomt in een secret_ref-verzoek
  (comment) dat jónger is dan zijn laatste `secret_stored`-event. De
  chip toont dan de amber "needed again"-staat uit design 2d
  (waarschuwings-hangslot, vetgedrukt) in plaats van groen "stored" —
  een chip mag nooit "stored" blijven zeggen over een afgekeurde
  waarde (journey 2). De mini-intake onder die comment toont alléén de
  opnieuw gevraagde namen, met design-copy in de trant van "only this
  one value — the rest stays stored".
- Opslaan werkt via het bestaande write-only endpoint; niets aan de
  vault-kant verandert.

## 4. AGENT.md — regel 3 verfijning

Eén toevoeging: een gerichte her-aanvraag is een **nieuwe comment met
een eigen `secret_ref:`-regel** die alleen de afgekeurde namen noemt —
de UI rendert daar de mini-intake onder en zet de eerdere chips op
"needed again". (De bestaande regels over de vault blijven ongewijzigd.)

## 5. Buiten scope (bewust)

- `doing` uit het statusmenu halen (escape hatch blijft).
- Aging-badges, 2h-choreografie (polish-batch), realtime (blok 5).
- Een `secret_rejected`-event-kind — de her-aanvraag-comment ís het
  structurele signaal; afgeleid uit bestaande data.

## 6. Verificatie

Playwright-flows tegen een wegwerp-datadir, screenshots naast design
2b/2c/2d:

1. needs_input + tekst → "Reply & hand back": comment staat op de
   kaart, status `ready`, event-reden `answered in comment`; lege
   composer → knop disabled.
2. Review + tekst → "Request changes": comment + status `ready`; leeg →
   reason-dialog met doel ready. Geen enkel pad in de UI-sneltoetsen
   leidt nog naar `doing`.
3. Ops-kaart: agent-comment met `secret_ref:` → intake rendert onder
   díe comment; body-only verzoek → intake op de oude plek (regressie).
4. Her-aanvraag: naam opslaan → "stored"; nieuwe agent-comment met
   dezelfde naam → chip wordt "needed again" en de mini-intake toont
   alleen die naam; opnieuw opslaan → weer "stored".
5. Regressie: statusmenu kan nog steeds alles (incl. doing, met
   reason-dialog); Approve-met-blocker-waarschuwing intact;
   verify-blockers/routines/trigger/sessions blijven groen.
