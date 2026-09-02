# Design-brief: polish-ronde Agentboard (mobiel, bevestiging, intake-vindbaarheid)

Datum: 2026-09-02. Kader: `2026-08-24-agentboard-vision.md`. Basis: het
bestaande design-canvas in het Claude Design-project (artboards 1a–1g,
2a–2h) — alles hieronder is uitbreiding in dezelfde vormtaal, één kleine
samenhangende ronde. Artboards 2a (aging) en 2h (arrival-choreografie)
bestaan al en worden in de polish-batch gebouwd zoals ontworpen: niet
opnieuw ontwerpen.

Sinds de vorige ronde is gebouwd en live: realtime (2,5s-polling, kaarten
schuiven live met een pulse), het Agent log-overzicht met live tail (2f)
en de observer. De app heeft nu vijf hoofdingangen in de zijbalk: Board,
Context, Routines (modal), Agent log, Archive.

Principes die overal gelden:

- Status = wie is aan zet; de UI bewaakt dat mentale model.
- Nooit doen alsof: geen activiteitsclaims zonder levende sessie.
- "Needs me" telt alleen kaarten waar de user écht iets kan doen.

## 3a. Mobiele navigatie (het echte ontwerpvraagstuk)

De mobiele tabbar heeft nu twee items: Board en Context. Routines
(sinds de routines-ronde geparkeerd), Agent log en Archive zijn op
mobiel onbereikbaar. Ontwerp de mobiele navigatie voor vijf
bestemmingen, wetende dat Board veruit dominant is en Routines een
modal is (geen eigen pagina). Overweeg: tabbar uitbreiden vs. een
"meer"-ingang (sheet), en waar de routines-modal op mobiel vandaan
komt. Toon ook de Agent log-pagina éénmaal op mobiel formaat (tegels +
lijst gestapeld) zodat de lijstrij-compositie op smal scherm vastligt.

## 3b. Bevestigingsdialog "naar doing" (statusmenu)

Het statusmenu op kaartdetail is de enige plek waar een mens een kaart
nog naar `doing` kan zetten — bewust als ontsnappingsluik, maar doing
is agent-territorium (geen enkele quick action stuurt erheen). Ontwerp
de bevestigingsvariant: wat de dialog zegt (toon: signaleren, niet
betuttelen — "doing is van de agent; de scheduler pakt hem dan zelf
op"), de twee uitwegen (toch doen / terug), en hoe het menu-item zelf
subtiel markeert dat dit een uitzonderingspad is. NB: het besluit
laten/bevestigen/weghalen is nog niet genomen; dit ontwerp maakt de
middenoptie beoordeelbaar.

## 3c. Intake-vindbaarheid op kaartdetail

De secrets-intake nestelt onder het nieuwste agent-comment met een
secret_ref-regel. Twee gaten uit livegebruik: (1) wie het
timeline-filter op "Events" zet, ziet het comment — en dus de intake —
niet meer, terwijl de kaart wél op input wacht; (2) een half ingevuld
intake-veld gaat verloren bij filterwissel (gedrag, wordt gefixt) maar
er is geen visueel anker dat zegt "hier staat een openstaand verzoek".
Ontwerp een klein, blijvend signaal op de kaart (buiten de timeline)
dat een openstaand secret-verzoek markeert en bij klik naar de intake
springt/het filter herstelt — in de bestaande chip/badge-vormtaal, geen
nieuw paneel.

## Buiten scope

- Geen nieuwe pagina's of panelen; alleen de drie punten hierboven.
- 2a en 2h niet herontwerpen; wel mag 3a's mobiele Agent log de
  2f-vormtaal hergebruiken.
- Desktop-navigatie blijft zoals hij is.
