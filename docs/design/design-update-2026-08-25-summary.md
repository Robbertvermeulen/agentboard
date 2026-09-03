# Design-update 2026-08-25 — vergelijking met de brief

Bron: Claude Design project `0d7cbc29-0e6b-40b5-b4ed-bdca8f7e8989` (`Agentboard.dc.html`
+ `support.js`). Vergeleken: lokale backup van de oude bestanden (vóór deze ronde) tegen
de nieuw weggeschreven bestanden in `docs/design/`, en tegen
`docs/superpowers/specs/2026-08-25-design-brief.md`. Niet gecommit — staat klaar voor
review.

> Let op: dit bestand is door een sandbox-beperking geschreven in de worktree-kopie
> (`.claude/worktrees/feat-blockers-claiming/docs/design/…`) in plaats van de echte
> checkout-locatie — deze sessie mag de shared checkout alleen lezen, niet beschrijven.
> Verplaats/kopieer dit bestand naar
> `docs/design/design-update-2026-08-25-summary.md`.

## Belangrijk: het gefetchte bestand is afgekapt (256 KiB cap)

`Agentboard.dc.html` is nu precies 262.144 bytes (= 256 KiB) groot en eindigt midden in
een attribuut (`color:oklch` zonder afsluiting, geen `</x-dc></body></html>`). Dit is de
bekende ophaal-cap van de tool, geen ontwerpkeuze.

**Wat dit wél/niet raakt:**
- Alle **nieuwe** content voor deze ronde (artboards `2a`–`2h`, zie hieronder) staat aan
  het begin van het bestand, vóór een `<!-- T2-END -->`-marker op regel 1030, en is
  **volledig en intact** binnen de cap. De vergelijking hieronder is dus betrouwbaar.
- Wat wél is afgekapt: het **oude, vooraf bestaande** deel ná de T2-sectie —
  artboard `1d` is halverwege afgebroken, en de oude artboards `1e` ("Context viewer —
  read-only") en `1f` ("States — all clear, archive, quick add") ontbreken nu volledig
  op schijf. Dit zijn geen brief-onderwerpen, maar het bestand is hierdoor wel technisch
  kapot (ongeldige HTML) en mist content die er eerder wél was.
- Er zijn geen `href="#2…"`-verwijzingen gevonden binnen de oude `1a/1b/1c/1g`-secties,
  en het aantal toegevoegde/verwijderde regels in een ruwe diff (~1010 toegevoegd, ~351
  verwijderd) komt overeen met "het hele 2a–2h-blok is toegevoegd, de rest is ongewijzigd
  maar deels afgekapt". Sterke aanwijzing dat `1a`, `1b`, `1c`, `1g` en het zichtbare deel
  van `1d` **ongewijzigd** zijn t.o.v. de vorige ronde.
- `support.js`: **byte-voor-byte identiek** aan de vorige versie (0 regels diff). Niet
  aangepast in deze ronde.

**Aanbeveling:** opnieuw ophalen zonder de cap te raken (bv. in delen), of de ontbrekende
staart (rest van `1d`, plus `1e`/`1f`, plus de sluit-tags) terugzetten vanuit de vorige
versie — dat is voor zover te beoordelen ongewijzigde content. Niet zelf gedaan in deze
taak om geen aannames in een niet-gecommit bestand te bakken.

## Structuur van de update

Nieuwe ronde = 8 artboards, allemaal vooraan toegevoegd: `2a` t/m `2h`. Elk brief-item
mapt op precies één (of twee) van deze artboards — een schone 1-op-1 vertaling van de
brief, geen losse eindjes.

## Per brief-oppervlak

### 1. Beurtwissel-interacties — gedekt (`2b`, `2c`)
- `2b`: composer op een needs_input-kaart toont primair **"Reply & hand back → ready"**
  (donkere knop, `background:oklch(0.21 0.006 285.885)`, wit label) met **"Just comment"**
  als secundaire, ongestylede knop ernaast. Geen reason-dialog. Copy onder de composer:
  *"No reason dialog here: your comment is the reason. Only the agent moves a card to
  doing."*
- Annotatiepaneel "Quick actions, retargeted" laat expliciet **was → is** zien:
  doorgestreept "Send back to doing" / "Request changes → doing", vervangen door
  "Reply & hand back → ready" en "Request changes → ready".
- `2c` (review): **Approve → done** (groene knop, `oklch(0.42 0.13 145)`), "Request
  changes → ready" ernaast. Bij open blocker verschijnt een bevestigings-popover (zie
  "done-warning" hieronder) — verder gedekt onder item 3.

### 2. Twee soorten wachten — gedekt, maar alleen op het board (`2a`)
- needs_input-kolom toont drie varianten naast elkaar: **"your turn"** (amberkleurige pil,
  telt mee), **"waiting on external"** (grijze pil met klok-icoon, copy: *"not in 'needs
  me'"*) en een **verouderde** kaart (dikkere rand + schaduw, vetgedrukte rode/oranje
  "12d"-badge, copy: *"has been sitting here for 12 days — 3 cards are blocked behind
  it"*).
- Board-header toont expliciet: *"Needs me · 2"* naast *"3 cards in needs_input — one is
  waiting on something external, so it is not counted"* — het mentale model uit de brief
  staat letterlijk in de UI.
- **Afwijking van de brief:** de brief vraagt dit voor "board + card-detail"; het
  ontwerp toont de twee wacht-soorten alleen op het bord (`2a`). De card-detail-artboard
  (`2b`) demonstreert alleen de "your turn"-variant, niet los een external-wait-status op
  de kaart zelf.

### 3. Blocker-chips — gedekt (`2a`, `2b`, `2d`) — **details voor de implementatie**
- **Boardkaart, compact aantal:** pil-chip, tekst "2 blockers" / "1 blocker".
  `font-size:11px; font-weight:500; color:oklch(0.42 0.14 255); background:color-mix(in oklch, oklch(0.55 0.16 255) 9%, #fff); border-radius:999px; padding:1px 7px;`
  met een link/ketting-icoon (`stroke:oklch(0.48 0.15 255)`).
- **Card-detail, open blocker-chip** (klikbaar, in de "Blocked by"-rij):
  `font-family:JetBrains Mono; font-size:12px; color:oklch(0.42 0.14 255); background:color-mix(in oklch, oklch(0.55 0.16 255) 7%, #fff); border:1px solid color-mix(in oklch, oklch(0.55 0.16 255) 28%, #fff); border-radius:999px; padding:3px 10px;`
  — tekst "ops_2ae1 · acme.com SSH" + een **geneste leeftijds-badge** "blocked 12d":
  `font-size:11px; font-weight:600; color:oklch(0.44 0.13 45); background:color-mix(in oklch, oklch(0.60 0.17 45) 12%, #fff); border-radius:999px; padding:0 6px`
  (amber/oranjerode kleurfamilie, dezelfde hue als de veroudering in item 2).
- **Afgevinkte/gedimde chip** (opgelost): zelfde pilvorm, maar grijs
  (`color:oklch(0.606…); background:oklch(0.967…); border:oklch(0.92…)`), tekst
  doorgestreept (`text-decoration:line-through; decoration-color:oklch(0.72 0.02 286)`),
  met een groen vinkje-icoon (`stroke:oklch(0.45 0.13 145)`) dat wél zichtbaar blijft.
  Ernaast staat los een tekstje "1 of 2 resolved".
- **Ops card, omgekeerde groep "Unblocks"** (`2d`): label "UNBLOCKS" (11px, uppercase,
  grijs, letter-spacing 0.04em) gevolgd door chips in dezelfde blauwe pil-stijl, nu met de
  taak die erdoor geblokkeerd wordt: "task_5b34 · cookie consent banner [blocked 12d]",
  "task_4d02 · relaunch sitemap [blocked 5d]".
- **Timeline-regel:** `blocker_added by agent: ops_2ae1 — no SSH access to acme.com ·
  12d ago` (monospace, ketting-icoon in blauw) én, als bonus t.o.v. de brief-tekst,
  ook een `blocker_resolved by Robbert: … · 4d ago`-regel (groen vinkje-icoon).

### "Done-warning" — de approve-met-open-blocker-bevestiging (`2c`)
Dit is de popover die verschijnt als je in review op **Approve** klikt terwijl er nog een
open blocker is (brief: "bevestiging, signaleren niet blokkeren"):
- Kaart: wit, `border:1px solid oklch(0.92 0.004 286.32)`, `border-radius:12px`,
  `padding:14px`, breedte 420px, schaduw `0 12px 32px rgb(15 23 42/.14), 0 2px 8px
  rgb(15 23 42/.06)`.
- Icoon: cirkel met uitroepteken (alert-circle), `stroke:oklch(0.60 0.17 45)` — dezelfde
  amber/oranjerode kleur als de blocker-leeftijdsbadges, 16px.
- Titel (14px, 600): **"Approve with 1 open blocker?"**
- Body (13px, `oklch(0.35 0.01 285.9)`): *"This card still has an unresolved blocker.
  Approving closes the card anyway — the blocker stays open on its own card."*
- Toont de betrokken blocker-chip inline (zelfde blauwe pil + "blocked 6d"-badge).
- Knoppen: **"Approve anyway"** — nadrukkelijk **dezelfde groene kleur** als de normale
  Approve-knop (`oklch(0.42 0.13 145)`, geen rode/danger-styling), plus een gewone
  "Cancel"-knop en een tekstlink "open the blocker".
- **Geen blockers open → geen dialog überhaupt**: Approve gaat dan direct naar `done`.
  Toelichtingspaneel ernaast heet expliciet "Signal, don't block".

### 4. Routines — gedekt (`2e` modal, ↻-chip in `2a`/`2c`)
- Modal "Routines", read-only, gegroepeerd per board (all-boards-variant getoond: groep
  "Client Work" met 3 routines, groep "Products" met 1). Per routine: naam, schedule
  (monospace pilletje, bv. "mon 08:00"), "last run <klikbare kaart> · datum — resultaat ·
  next run …", en een pauze-toggle (groene pil-switch = actief, grijze switch = paused;
  gepauzeerde rij krijgt een lichtgrijze achtergrond en gedimde tekst).
- Footer-copy: *"Read-only. Pausing is the only change you make here — creating, editing
  or deleting a routine goes through an ops card."* — één-op-één de brief-eis.
- ↻-chip: pil met klok/geschiedenis-icoon en tekst "routine", zowel op een board-kaart
  (`2a`) als op een review-kaart (`2c`).

### 5. Agent-logs-tab — gedekt (`2f`, `2g`)
- `2f` links: samenvatting eerst (lopende tekst + 4 stat-tegels: sessions/completed/
  handed back/ended early), daaronder de sessielijst — één regel per sessie: nummer,
  trigger-chip (status-change/cron 09:00/routine), duur (of "live" met pulse), geraakte
  kaarten in het kort, uitkomst (running/1 handed back/ended early/completed).
- `2f` rechts: sessiedetail — stappen als één-regel-items (tijd · tool-call · doel ·
  resultaat), een **standaard ingeklapte** reasoning-regel (cursief, "reasoning · 340
  words", chevron-icoon), en onderaan een donkere **live tail**-console met pulserende
  stip en blinkende cursor.
- `2g`: vanaf een kaart een tweede tab "Agent activity" naast "Timeline" — toont alléén de
  sessie-fragmenten die déze kaart raakten, met link "open full session →" naar `2f`.
  Toelichting ernaast: *"Card-first, log-second… this is the main question"* — exact de
  brief-prioriteit dat dit belangrijker is dan de sessielijst zelf.

### 6. Realtime- en aanwezigheidssignalen — gedekt (`2a`, `2h`)
- `2h` "live move": kaart schuift met een ring/pulse-animatie naar `doing`, met een
  tijdelijke "ghost slot" (gestippeld) op de plek waar hij vandaan kwam, en een
  "connected"-badge.
- `2h` "live comment": bestaande comment gedimd (opacity 0.6) als context, nieuwe
  agent-comment schuift in gemarkeerd "arriving live" — geen refresh, copy: *"the composer
  keeps your typed text and your scroll position."*
- `2a`: `doing`-kolom toont expliciet live (pulserende stip, "heartbeat 2s ago") náást
  dormant (gestippelde rand, "no live session", copy: *"Session #480 ended mid-task —
  picks up again at the next session (cron 14:00)."*) — nooit "kapot", exact de brief-eis.

### 7. Secrets-intake in de timeline — gedekt (`2d`, één artboard voor het hele item)
- Intake staat nu **ingesprongen direct onder** de vragende agent-comment (border-left
  inspringing), niet meer los op de ops card.
- Succesvol opgeslagen secrets: groen hangslot-icoon + tekst **"stored"** (groen).
- Bij een `secret_rejected`-event verschijnt een nieuwe agent-comment met gerichte
  heraanvraag, en daaronder een **mini-intake voor precies dat ene secret**
  (`ACME_SSH_KEY`), met copy *"only this one value — host and user stay stored"*.
- De eerder afgekeurde chip toont nooit meer "stored": amber/rode variant met
  waarschuwings-hangslot-icoon en vetgedrukt **"needed again"**
  (`color:oklch(0.40 0.13 45); background:color-mix(in oklch, oklch(0.60 0.17 45) 9%, #fff); border:color-mix(in oklch, oklch(0.60 0.17 45) 34%, #fff)`).

## Buiten scope van de brief?

Geen scope-creep aangetroffen in het nieuwe `2a`–`2h`-blok. Wel voegt het ontwerp per
artboard een **toelichtend paneel voor de reviewer** toe (bv. "What the chips mean" in
`2a`, "Quick actions, retargeted" in `2b`, "Signal, don't block" in `2c`, "Card-first,
log-second" in `2g`) — dit is documentatie voor de designreview, geen extra UI-feature.
De brief-uitsluitingen (notificatiekanaal, zoeken/filters, bulk-archiveren,
onboarding-seed) komen inderdaad nergens voor in het nieuwe blok.

## Brief-items die het ontwerp overslaat

Geen. Alle zeven oppervlakken zijn aanwezig en 1-op-1 te herleiden naar een artboard.
De enige kanttekening is bij item 2 (zie hierboven): alleen op het bord getoond, niet
apart op de kaart-detailweergave.

## Update: bestand hersteld (lokale splice)

`Agentboard.dc.html` is na deze review lokaal gerepareerd: de fetch kapt namelijk af op
256 KiB (zie boven), dus het bestand op schijf is nu een **lokale splice** van (a) de
nieuwe fetch t/m en met artboard `1c` — waarin alle nieuwe artboards `2a`–`2h` en de oude
`1a`/`1g`/`1b`/`1c` zitten, gecontroleerd byte-voor-byte identiek aan de vorige versie —
plus (b) artboard `1d` t/m `1f` en de afsluitende tags, overgenomen uit de
scratchpad-backup van de vórige versie (want die zaten voorbij het afkap-punt van de
fetch). Geen inhoudelijke wijziging, puur reconstructie om een geldig document te krijgen.
Resultaat: 296.382 bytes, eindigt correct op `</script></body></html>`, `<section>`/
`</section>`, `<x-dc>`/`</x-dc>`, `<html>`/`</html>`, `<body>`/`</body>` en `<div>`/`</div>`
allemaal in balans, geen half attribuut meer. **claude.ai/design blijft de bron van
waarheid** — dit lokale bestand is alleen een werkbare stand-in totdat een volledige,
niet-afgekapte fetch mogelijk is.
