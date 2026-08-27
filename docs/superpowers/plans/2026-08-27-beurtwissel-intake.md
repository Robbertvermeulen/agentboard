# Beurtwissel + Intake (UI-batch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De beurtwissel wordt één handeling (Reply & hand back), geen enkele UI-sneltoets stuurt nog naar `doing`, en de secrets-intake nestelt onder de agent-comment die erom vraagt — met een "needed again"-staat voor opnieuw gevraagde secrets.

**Architecture:** Pure UI-batch in `web/js/views/card.js` + `web/style.css`, plus één AGENT.md/README-verfijning. Geen schema-, core- of endpointwijzigingen: hand back = twee bestaande API-aanroepen (comment eerst, dán de move). "Needed again" is afgeleid: naam gevraagd in een comment jónger dan zijn laatste `secret_stored`-event.

**Tech Stack:** vanilla-JS web UI (no-build), Playwright-verificatie.

**Spec:** `docs/superpowers/specs/2026-08-27-beurtwissel-intake-design.md` (design v4 artboards 2b/2c/2d leidend; vision besluit I, journey 2).

## Global Constraints

- **Geen enkele quick action, composer-knop of mobiele primaire actie mag nog `doing` als doel hebben.** Het volledige statusmenu blijft ongewijzigd compleet (incl. doing) — de escape hatch.
- Hand-back-volgorde is bindend: **comment eerst, dan de move** (de agent-sessie moet het antwoord zien vóór de status wisselt en de serve-hook vuurt).
- Vaste redenen: `answered in comment` (needs_input) en `changes requested in comment` (review).
- Kaarten in andere statussen renderen byte-identiek; alle bestaande gedrag (comment-edit, uploads, filters, tabs, polling-guards) blijft werken.
- Verificatie: Playwright tegen een wegwerp-`AGENTBOARD_DATA` (nooit ~/.agentboard, nooit `AGENTBOARD_AUTORUN`), screenshots naar `docs/design/verify/beurtwissel/`; regressie = de vier verify-scripts groen.
- Comments Engels, chirurgisch. Git: NEW commits only — never amend.

---

### Task 1: Reply & hand back + review-retarget (design 2b + 2c-rest)

**Files:**
- Modify: `web/js/views/card.js`
- Modify: `web/style.css` (alleen indien `.btn-dark:disabled` nog niet bestaat)

**Interfaces:**
- Consumes: bestaande `api.comment`/`api.move`, `moveWithReason`.
- Produces: composer-knoppen `#hand-back` (needs_input), `#request-changes` (review), mobiel `#m-hand-back`; quick action "Send back to doing" en "Request changes → doing" bestaan niet meer.

- [ ] **Step 1: Quick-array herzien**

Vervang in `renderCard` het huidige blok:

```js
  const quick = [];
  if (card.status === 'inbox') quick.push({ label: 'Ready', cls: 'btn-dark', to: 'ready', icon: icons.arrowRight(14, '#fff') });
  if (card.status === 'needs_input') quick.push({ label: 'Send back to doing', cls: 'btn-amber', to: 'doing', icon: icons.arrowRight(14) });
  if (card.status === 'review') {
    quick.push({ label: 'Approve → Done', cls: 'btn-green', to: 'done', icon: icons.check(14) });
    quick.push({ label: 'Request changes', cls: 'btn-ghost', to: 'doing' });
  }
```

door:

```js
  // Vision besluit I: quick actions never target doing — the human always
  // hands back to ready; doing is exclusively the agent's claim.
  const quick = [];
  if (card.status === 'inbox') quick.push({ label: 'Ready', cls: 'btn-dark', to: 'ready', icon: icons.arrowRight(14, '#fff') });
  if (card.status === 'review') quick.push({ label: 'Approve → Done', cls: 'btn-green', to: 'done', icon: icons.check(14) });
```

- [ ] **Step 2: Composer-knoppen per status**

Vervang de composer-actions (het blok met `#comment-send` en de spacer) door een status-afhankelijke variant:

```js
            <div class="composer-actions">
              ${
                card.status === 'needs_input'
                  ? `<button type="button" id="hand-back" class="btn-dark">${icons.arrowRight(14, '#fff')}Reply & hand back → ready</button>
                     <button type="button" id="comment-send" class="btn-ghost">Just comment</button>`
                  : `<button type="button" id="comment-send" class="btn-dark">Comment</button>`
              }
              <div class="spacer">
                ${quick.map((q, i) => `<button type="button" class="${q.cls}" data-move="${q.to}" data-q="${i}">${q.icon ?? ''}${esc(q.label)}</button>`).join('')}
                ${card.status === 'review' ? `<button type="button" id="request-changes" class="btn-ghost">Request changes → ready</button>` : ''}
                ${canArchive ? `<button type="button" class="btn-ghost" data-move="archived">${icons.archive()}Archive</button>` : ''}
              </div>
            </div>
            <span id="composer-error" class="field-error" hidden>${icons.alert()}<span></span></span>
```

en vervang de `reason-hint`-regel door de 2b-copy op beurtwissel-kaarten:

```js
          <p class="reason-hint">${
            card.status === 'needs_input' || card.status === 'review'
              ? 'No reason dialog here: your comment is the reason. Only the agent moves a card to doing.'
              : 'Every status change asks for a short reason — it is written to the timeline as an event.'
          }</p>
```

- [ ] **Step 3: Handlers**

Na de bestaande `#comment-send`-wiring:

```js
  const composerError = root.querySelector('#composer-error');
  const showComposerError = (msg) => {
    composerError.querySelector('span:last-child').textContent = msg;
    composerError.hidden = false;
  };
  // One action, two calls — comment FIRST so the agent session reads the
  // answer before the status flips (and the serve-hook fires on the move).
  const handBackWith = async (reason) => {
    const text = input.value.trim();
    try {
      await api.comment(card.id, text);
      await api.move(card.id, 'ready', reason);
      input.value = '';
      rerender();
    } catch (err) {
      showComposerError(err.message);
    }
  };
  const handBack = root.querySelector('#hand-back');
  if (handBack) {
    const sync = () => (handBack.disabled = !input.value.trim());
    sync();
    input.addEventListener('input', sync);
    handBack.onclick = () => handBackWith('answered in comment');
  }
  const reqChanges = root.querySelector('#request-changes');
  if (reqChanges) {
    reqChanges.onclick = () => {
      if (input.value.trim()) handBackWith('changes requested in comment');
      else moveWithReason(card, 'ready', rerender); // empty composer: dialog, target ready
    };
  }
```

- [ ] **Step 4: Mobiele actiebalk**

In de `m-actionbar`: vervang de needs_input-tak

```js
            : card.status === 'needs_input'
              ? `<button type="button" class="m-primary amber" data-move="doing">${icons.arrowRight(16, '#fff')}Send back to doing</button>`
```

door

```js
            : card.status === 'needs_input'
              ? `<button type="button" class="m-primary amber" id="m-hand-back">${icons.arrowRight(16, '#fff')}Hand back → ready</button>`
```

met wiring (bij de andere m-handlers):

```js
  const mHand = root.querySelector('#m-hand-back');
  if (mHand)
    mHand.onclick = () => {
      if (input.value.trim()) handBackWith('answered in comment');
      else {
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        input.focus();
      }
    };
```

- [ ] **Step 5: CSS-check**

Controleer of `web/style.css` een disabled-stijl voor `.btn-dark` heeft; zo niet, voeg toe naast de bestaande knopstijlen:

```css
.btn-dark:disabled { opacity: 0.45; cursor: default; }
```

- [ ] **Step 6: Verify (Playwright, 1440px, screenshots → docs/design/verify/beurtwissel/)**

Seed: kaart in needs_input, kaart in review (beide met wat timeline), serve op een vrije poort.
1. needs_input, lege composer → "Reply & hand back" disabled; typ tekst → enabled; klik → comment op de kaart, status `ready`, jongste status_changed-event heeft reden `answered in comment` (check via `card show --json`) → `handback-1440.png`.
2. "Just comment" plaatst alleen een comment, status blijft needs_input.
3. Review + tekst → "Request changes → ready": comment + status ready, reden `changes requested in comment`; leeg → reason-dialog verschijnt met doel ready → `request-changes-1440.png`.
4. Grep-bewijs: `grep -n '"doing"' web/js/views/card.js` toont geen data-move/quick-doel meer naar doing (statusmenu in components.js blijft ongemoeid).
5. Regressie: inbox-kaart toont "Ready", archiveren werkt, comment-edit werkt, done/archived-kaart rendert als voorheen.

- [ ] **Step 7: Commit**

```bash
git add web/
git commit -m "feat(web): Reply & hand back — beurtwissel in één handeling, quick actions nooit naar doing"
```

---

### Task 2: Secrets-intake onder de agent-comment + "needed again" (design 2d)

**Files:**
- Modify: `web/js/views/card.js`
- Modify: `web/style.css`

**Interfaces:**
- Consumes: bestaande `api.storeSecret`; comments/events al aanwezig in `renderCard`.
- Produces: intake genest onder de jongste agent-comment met een `secret_ref:`-regel; chips met drie staten (prefill / stored / needed again); body-only verzoeken blijven op de huidige plek renderen.

- [ ] **Step 1: Verzoeken uit body én comments parsen**

Vervang het huidige `requestedSecrets`/`showSecretIntake`-blok door:

```js
  const SECRET_LINE = /^secret_ref:\s*(.+)$/m;
  const parseSecretNames = (text) =>
    (text?.match(SECRET_LINE)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const bodySecrets = parseSecretNames(card.body);
  // A targeted re-request is an agent comment with its own secret_ref: line
  // (AGENT.md rule 3); the intake nests under the newest one (design 2d).
  const secretRequests = comments
    .filter((c) => c.author === 'agent' && SECRET_LINE.test(c.body))
    .map((c) => ({ comment: c, names: parseSecretNames(c.body) }));
  const latestRequest = secretRequests.at(-1) ?? null;
  const requestedSecrets = [...new Set([...bodySecrets, ...secretRequests.flatMap((r) => r.names)])];
  const showSecretIntake =
    card.type === 'ops' && card.status !== 'done' && card.status !== 'archived' && requestedSecrets.length > 0;
```

en vervang de platte `storedSecrets`-berekening door een per-naam-jongste-tijd (de props-panel-chips blijven de namenlijst gebruiken):

```js
  const storedAt = new Map(); // name -> newest secret_stored time
  for (const e of events) {
    if (e.kind !== 'secret_stored') continue;
    const n = String(e.payload.name ?? '').toLowerCase();
    const prev = storedAt.get(n);
    if (!prev || e.created_at > prev) storedAt.set(n, e.created_at);
  }
  const storedSecrets = [...storedAt.keys()];
  // "Needed again": requested in a comment newer than its latest store —
  // a chip may never keep saying "stored" about a rejected value.
  const neededAgain = (n) => {
    const req = secretRequests
      .filter((r) => r.names.includes(n))
      .map((r) => r.comment.created_at)
      .sort()
      .at(-1);
    const st = storedAt.get(n);
    return !!req && !!st && req > st;
  };
```

- [ ] **Step 2: Eén box-bouwer, twee plaatsingen**

Zet de bestaande secret-box-markup om in een helper `secretBoxHtml(names, { nested })` (zelfde ids `sec-name`/`sec-value`/`sec-file`/`sec-file-btn`/`sec-store`/`sec-error`; er is altijd maximaal één box). Chip-rendering per naam:

```js
    ${names
      .map((n) => {
        if (neededAgain(n))
          return `<button type="button" class="sb-prefill sb-needed" data-name="${esc(n)}">${icons.lock(11)}${esc(n)}<span class="again">needed again</span></button>`;
        if (storedAt.has(n)) return `<span class="sb-stored">${esc(n)}<span class="ok">stored</span></span>`;
        return `<button type="button" class="sb-prefill" data-name="${esc(n)}">${esc(n)}</button>`;
      })
      .join('')}
```

Nested variant: root-class `secret-box nested`, kop "agent asks again for N secret(s)" wanneer alle `names` needed-again zijn, en een notitieregel `only ${names.length === 1 ? 'this one value' : 'these values'} — the rest stays stored` wanneer er daarnaast nog opgeslagen namen op de kaart zijn. Plaatsing:

- `latestRequest` aanwezig → de box-html wordt onderdeel van de timeline-entry van díe comment: in de `timeline`-array krijgt de betreffende comment `html: commentCard(c) + secretBoxHtml(latestRequest.names, { nested: true })` (zo overleeft hij de filter-rerenders). De standalone box boven de timeline vervalt dan.
- Alleen `bodySecrets` (bestaande kaarten) → standalone box op de huidige plek, met de volledige `requestedSecrets`, zoals nu.

- [ ] **Step 3: Handlers delegeren**

De huidige eenmalig-gebonden secret-handlers (het `if (secName)`-blok) breken zodra de box in `#timeline-list` leeft (filter-rerenders vervangen de innerHTML). Vervang ze door delegatie op `root`, met de `keyFile`-state in de closure:

```js
  // Delegated: the intake may live inside the timeline (filter re-renders
  // replace that DOM) or standalone — one code path serves both.
  let keyFile = null;
  root.addEventListener('click', async (ev) => {
    const prefill = ev.target.closest('.sb-prefill');
    if (prefill) {
      const name = root.querySelector('#sec-name');
      name.value = prefill.dataset.name;
      (keyFile ? name : root.querySelector('#sec-value'))?.focus();
      return;
    }
    if (ev.target.closest('#sec-file-btn')) {
      root.querySelector('#sec-file')?.click();
      return;
    }
    if (ev.target.closest('#sec-store')) {
      const name = root.querySelector('#sec-name').value.trim();
      const secValue = root.querySelector('#sec-value');
      const secError = root.querySelector('#sec-error');
      let value;
      let encoding;
      if (keyFile) {
        const bytes = new Uint8Array(await keyFile.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        value = btoa(bin);
        encoding = 'base64';
      } else {
        value = secValue.value;
      }
      // The value leaves the fields before the request even settles.
      secValue.value = '';
      secValue.disabled = false;
      secValue.placeholder = 'Paste or type the value';
      keyFile = null;
      secError.hidden = true;
      try {
        await api.storeSecret(card.id, { name, value, encoding });
        rerender();
      } catch (err) {
        secError.querySelector('span:last-child').textContent = err.message;
        secError.hidden = false;
      }
    }
  });
  root.addEventListener('change', (ev) => {
    if (ev.target?.id !== 'sec-file') return;
    const secValue = root.querySelector('#sec-value');
    keyFile = ev.target.files[0] ?? null;
    secValue.value = '';
    secValue.disabled = !!keyFile;
    secValue.placeholder = keyFile ? `key file: ${keyFile.name}` : 'Paste or type the value';
    ev.target.value = '';
  });
```

(Het oude `if (secName)`-blok vervalt; de `dirty()`-guard blijft werken — hij query't `#sec-name`/`#sec-value` die nu evengoed bestaan. Let op: `const secName/secValue` bovenaan dat blok worden nog door `dirty()` gebruikt — vervang die twee regels door live queries in `dirty()`: `[input, root.querySelector('#sec-name'), root.querySelector('#sec-value')]`.)

- [ ] **Step 4: CSS**

Naast de bestaande `.secret-box`-stijlen (kleuren per design-summary §7):

```css
.secret-box.nested {
  margin: 6px 0 14px 34px;
  border-left: 3px solid var(--line, #e5e7eb);
}
.sb-prefill.sb-needed {
  font-weight: 700;
  color: oklch(0.4 0.13 45);
  background: color-mix(in oklch, oklch(0.6 0.17 45) 9%, #fff);
  border: 1px solid color-mix(in oklch, oklch(0.6 0.17 45) 34%, #fff);
}
.sb-needed .again {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-left: 4px;
}
```

- [ ] **Step 5: Verify (Playwright, screenshots → docs/design/verify/beurtwissel/)**

Seed op een ops-kaart:
1. Alleen body-`secret_ref` → box op de oude plek, chips werken (regressie).
2. Agent-comment met `secret_ref: acme_host, acme_key` (via `card comment ... --as agent`) → box genest ónder die comment (ook na wisselen van timeline-filters) → `intake-nested-1440.png`.
3. Sla `acme_host` op → chip "stored". Nieuwe agent-comment `secret_ref: acme_key` nadat ook `acme_key` was opgeslagen → chip `acme_key` wordt "needed again" (amber), mini-intake onder de nieuwe comment toont alléén `acme_key` + de "rest stays stored"-regel → `needed-again-1440.png`. Opnieuw opslaan → weer "stored".
4. Key-file-flow en foutpad (lege naam → API-fout in `#sec-error`) blijven werken vanuit de geneste box.
5. Props-panel SECRETS-chips ongewijzigd.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat(web): secrets-intake onder de agent-comment, met needed-again-staat"
```

---

### Task 3: AGENT.md regel 3 + README-zin

**Files:**
- Modify: `AGENT.md`
- Modify: `README.md`

- [ ] **Step 1:** In AGENT.md regel 3, direct na de zin die eindigt op "…buried mid-sentence it renders nothing.", invoegen (zelfde wrap-stijl):

```
   A targeted re-request after a failed value is a new comment with its
   own `secret_ref:` line naming only the failed secrets — the UI
   renders the intake under that comment and marks the earlier chips
   "needed again".
```

- [ ] **Step 2:** In de README-alinea over de write-only intake ("The web UI has the same rule in write-only form: …") één zin toevoegen dat het intake-formulier onder de vragende agent-comment rendert en her-aanvragen de chip op "needed again" zetten. Wrap-band van de alinea aanhouden.

- [ ] **Step 3:** Verify: de rule-3-regel beschrijft exact wat Task 2 bouwde (geen commando's om te draaien — wel de `secret_ref:`-regelvorm checken tegen de parser uit Task 2: zelfde `^secret_ref:\s*` op een eigen regel). Line widths in band.

- [ ] **Step 4: Commit**

```bash
git add AGENT.md README.md
git commit -m "docs: gerichte secret-heraanvraag als comment met secret_ref-regel (rule 3)"
```

---

### Task 4: Regressie-afsluiting

- [ ] **Step 1:** `npm run build && docs/superpowers/plans/verify-sessions.sh && docs/superpowers/plans/verify-trigger.sh && docs/superpowers/plans/verify-routines.sh && docs/superpowers/plans/verify-blockers.sh` — vier OK-regels (deze batch raakt geen core, maar de vier probes zijn de goedkoopste bewaking dat dat klopt). Geen commit; alleen bewijs in het rapport.
