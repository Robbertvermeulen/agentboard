# Agent log, live tail & observer (bouwblok 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Het Agent log-overzicht (design 2f links), een sessie-detailpagina die live meeloopt via het bestaande realtime-kanaal, en `agentboard observe <nr>` als feedbackloop — plus de 4a-parkeerpunten (crash-rijen, JSON-escape-redactie, trigger-labels, backup-noot).

**Architecture:** Incrementeel steps-endpoint op byte-offset + stapnummer (server her-parset nooit het hele transcript per poll); live/observed-annotatie in de API-laag (zelfde patroon als `/api/changes`, core blijft cycle-vrij); observer via `runSession` met prompt-override (zelfde lock, capture en crash-vangnet). Geen schemawijzigingen.

**Tech Stack:** TypeScript core/Hono, vanilla-JS UI, Playwright-verificatie.

**Spec:** `docs/superpowers/specs/2026-08-28-agentlog-observer-design.md` (vision journey 8, besluit J; design 2f).

## Global Constraints

- NOOIT een echte claude-sessie starten in verificatie: `AGENTBOARD_SESSION_CMD` altijd fake en geëxporteerd in dezélfde shell-invocatie als het commando dat hem gebruikt.
- Nooit `AGENTBOARD_AUTORUN` zetten. Alleen wegwerp-`AGENTBOARD_DATA`; nooit `~/.agentboard`. Elke gestarte serve wordt gekilld.
- De rauwe JSONL blijft ongeredigeerd op schijf (trust boundary = secrets.env); redactie is display-time, per stap, óók voor het observatierapport.
- UI-copy in het Engels (bestaande stijl); code-comments Engels, chirurgisch; NEW commits only — never amend.
- Screenshots naar `docs/design/verify/agentlog/`.
- De eenmalige parser-validatie tegen échte sessies (spec §4, derde punt) is een COÖRDINATOR-stap ná de merge — geen taak in dit plan; subagents raken het live board nooit aan.

---

### Task 1: Incrementele steps + annotaties + redactor-variant (core/API)

**Files:**
- Modify: `src/core/sessions.ts`, `src/api/server.ts`, `web/js/api.js`

**Interfaces:**
- Produces: `parseSessionSteps(jsonlText, baseN = 0)`; `sessionStepsSince(id, offset = 0, n = 0)`; `observationPath(id)`; `sessionDetail` → `{ session, steps, observation, tail: { offset, n } }`; `GET /api/sessions` → rijen met `live` en `observed`; `GET /api/sessions/:id/steps?offset=&n=` → `{ steps, offset, n, live }`; `api.sessionSteps(id, offset, n)`.

- [ ] **Step 1: parseSessionSteps krijgt een startnummer.** In `src/core/sessions.ts` de signatuur `export function parseSessionSteps(jsonlText: string, baseN = 0): SessionStep[]` en in de `push`-helper `n: baseN + steps.length + 1`. Bestaande callers compileren ongewijzigd door de default.

- [ ] **Step 2: observationPath + incrementele reader.** Na `sessionStderrPath`:

```ts
export const observationPath = (id: number) => path.join(sessionsDir(), `${id}-observation.md`);
```

en na `parseSessionSteps`:

```ts
// Incremental read for the live tail: parse only the complete lines past
// `offset`, numbering steps from `n`. A trailing line without a newline is
// still being written (or died mid-write): skip it and do not advance the
// offset past it — unless the session has ended, in which case that line
// will never complete and is parsed as its final (possibly raw) step.
export function sessionStepsSince(
  id: number,
  offset = 0,
  n = 0
): { steps: SessionStep[]; offset: number; n: number } {
  const db = openDb();
  let ended: boolean;
  try {
    const row = db.prepare('SELECT ended_at FROM session WHERE id = ?').get(id) as
      | { ended_at: string | null }
      | undefined;
    if (!row) throw new Error(`Session not found: ${id}`);
    ended = row.ended_at !== null;
  } finally {
    db.close();
  }
  const file = sessionJsonlPath(id);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size <= offset) return { steps: [], offset, n };
  const fd = fs.openSync(file, 'r');
  let chunk: string;
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    chunk = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const cut = chunk.lastIndexOf('\n');
  const complete = ended ? chunk : cut === -1 ? '' : chunk.slice(0, cut + 1);
  const redact = secretRedactor();
  const steps = parseSessionSteps(complete, n).map((s) => ({
    ...s,
    label: redact(s.label),
    detail: redact(s.detail),
  }));
  return { steps, offset: offset + Buffer.byteLength(complete, 'utf8'), n: n + steps.length };
}
```

(Offsets landen altijd op een regelgrens — `\n` is ASCII — dus een byte-start splitst nooit een multibyte-teken.)

- [ ] **Step 3: sessionDetail deelt het pad en levert observatie + tail-cursor.** Vervang de body van `sessionDetail`:

```ts
export function sessionDetail(id: number): {
  session: SessionMeta;
  steps: SessionStep[];
  observation: string | null;
  tail: { offset: number; n: number };
} {
  const db = openDb();
  let session: SessionMeta;
  try {
    const row = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    session = rowToMeta(db, row);
  } finally {
    db.close();
  }
  const { steps, offset, n } = sessionStepsSince(id, 0, 0);
  const obsFile = observationPath(id);
  const observation = fs.existsSync(obsFile) ? redactSecrets(fs.readFileSync(obsFile, 'utf8')) : null;
  return { session, steps, observation, tail: { offset, n } };
}
```

(`cardSessions` gebruikt `sessionDetail` en blijft werken; het negeert de extra velden.)

- [ ] **Step 4: redactor herkent JSON-geëscapete varianten.** In `secretRedactor`, direct vóór de `replacements.sort(...)`-regel:

```ts
  // A secret inside a stream-json transcript appears JSON-escaped; a value
  // with quotes, backslashes or non-ASCII would otherwise slip past.
  for (const r of [...replacements]) {
    const escaped = JSON.stringify(r.value).slice(1, -1);
    if (escaped !== r.value) replacements.push({ value: escaped, name: r.name });
  }
```

- [ ] **Step 5: prune ruimt observaties mee op.** In `pruneSessions`, naast de twee bestaande `fs.rmSync`-regels: `fs.rmSync(observationPath(r.id), { force: true });`

- [ ] **Step 6: API-annotaties + steps-route.** In `src/api/server.ts` (importeer `observationPath` en `sessionStepsSince` erbij; `fs` is er al): vervang de `GET /api/sessions`-handler-body en voeg de steps-route toe naast de andere sessie-routes:

```ts
  app.get('/api/sessions', (c) => {
    try {
      const status = sessionStatus();
      const sessions = listSessions().map((s) => ({
        ...s,
        live: s.ended_at === null && status.running && status.session_id === s.id,
        observed: fs.existsSync(observationPath(s.id)),
      }));
      return c.json({ sessions });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/sessions/:id/steps', (c) => {
    try {
      const id = Number(c.req.param('id'));
      const r = sessionStepsSince(id, Number(c.req.query('offset') ?? 0), Number(c.req.query('n') ?? 0));
      const status = sessionStatus();
      return c.json({ ...r, live: status.running && status.session_id === id });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
```

en de bestaande `GET /api/sessions/:id`-handler krijgt dezelfde annotatie op zijn sessie-object (anders toont de detailpagina een gecrashte open rij als "running"):

```ts
  app.get('/api/sessions/:id', (c) => {
    try {
      const d = sessionDetail(Number(c.req.param('id')));
      const status = sessionStatus();
      const live = d.session.ended_at === null && status.running && status.session_id === d.session.id;
      return c.json({ ...d, session: { ...d.session, live } });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
```

- [ ] **Step 7: api.js.**

```js
  sessionSteps: (id, offset, n) => req(`/api/sessions/${encodeURIComponent(id)}/steps?offset=${offset}&n=${n}`),
```

- [ ] **Step 8: Verify (curl-matrix, wegwerp-dir, serve op vrije poort).** Maak met een fake `AGENTBOARD_SESSION_CMD` (zelfde-shell-export!) via `agentboard runner --trigger cron` een sessie die 2 regels stream-json schrijft. Dan: (1) `GET /api/sessions/:id/steps` zonder params → 2 stappen, offset = bestandsgrootte, n=2; (2) append 1 complete regel + 1 regel zónder newline aan de JSONL, zet `ended_at` op NULL in de db (node-script met better-sqlite3), herhaal met de vorige offset/n → precies 1 stap, n=3, offset vóór de partial; (3) zet `ended_at` terug → zelfde call → de partial verschijnt als raw-stap en offset = bestandsgrootte; (4) `GET /api/sessions` → rij zonder `ended_at` en zonder lock heeft `live:false`; schrijf een lockfile met eigen pid/hostname (formaat van `acquireLock`) → `live:true`; (5) schrijf `<id>-observation.md` met daarin een secret-waarde → `GET /api/sessions/:id` bevat `observation` met `[secret:…]` en de lijst toont `observed:true`; (6) secret met een `"` in de waarde opslaan, JSONL-regel met de JSON-geëscapete vorm → stappen tonen `[secret:…]`. Serve killen, dir weg.

- [ ] **Step 9: Commit** — `feat: incremental session steps, live/observed annotations, JSON-escaped redaction`

---

### Task 2: Agent log-overzicht (design 2f links)

**Files:**
- Create: `web/js/views/sessions.js`
- Modify: `web/js/app.js`, `web/style.css`

**Interfaces:**
- Consumes: `api.sessions()` met `live`/`observed` (Task 1).
- Produces: route `#/sessions`, `renderSessions(root)`, export `triggerLabel(t)` (Task 3 gebruikt die).

- [ ] **Step 1: view.** `web/js/views/sessions.js`:

```js
// Agent log (design 2f left): 7-day summary tiles + the session list.
// Every number is derived from the session index — nothing is claimed.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime, absTime } from '../util.js';
import { crumb } from '../components.js';

const TRIGGER_LABELS = { cron: 'cron', serve: 'after your action', manual: 'manual', observe: 'observer' };
export const triggerLabel = (t) => TRIGGER_LABELS[t] ?? t;

export const sessionOutcome = (s) => {
  if (s.ended_at === null) return s.live ? { cls: 'live', text: 'running' } : { cls: 'crash', text: 'ended early (crash)' };
  if (s.exit_status === 0) return { cls: 'ok', text: 'completed' };
  return { cls: 'crash', text: `ended early (${s.exit_status ?? 'crash'})` };
};

const durText = (s) =>
  s.ended_at === null
    ? ''
    : `${Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 1000))}s`;

const tile = (n, label) => `<div class="al-tile"><span class="n">${n}</span><span class="lbl">${label}</span></div>`;

export async function renderSessions(root) {
  const { sessions } = await api.sessions();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const week = sessions.filter((s) => s.started_at >= weekAgo);
  const completed = week.filter((s) => s.ended_at !== null && s.exit_status === 0).length;
  const handed = week.reduce((n, s) => n + s.handed_back.length, 0);
  const early = week.length - completed - week.filter((s) => s.live).length;
  const cards = new Set(week.flatMap((s) => s.cards)).size;
  root.innerHTML = `
    ${crumb([{ text: 'Agentboard', href: '#/' }, { text: 'Agent log', strong: true }])}
    <div class="al-head"><h2>Agent log</h2><span class="mut-sm">last 7 days</span></div>
    <p class="al-summary">Ran <strong>${week.length}</strong> session${week.length === 1 ? '' : 's'} and touched <strong>${cards}</strong> card${cards === 1 ? '' : 's'} this week. ${completed} completed, ${handed} handed back, ${early} ended early.</p>
    <div class="al-tiles">${tile(week.length, 'sessions')}${tile(completed, 'completed')}${tile(handed, 'handed back')}${tile(early, 'ended early')}</div>
    <div class="al-list">
      ${sessions
        .map((s) => {
          const o = sessionOutcome(s);
          return `<a class="al-row" href="#/session/${s.id}">
            <span class="al-id">#${s.id}</span>
            <span class="rt-sched">${esc(triggerLabel(s.trigger))}</span>
            ${s.live ? '<span class="al-live"><span class="live-dot"></span>live</span>' : `<span class="mut-sm">${esc(durText(s))}</span>`}
            <span class="al-cards">${s.cards.length ? s.cards.map((c) => esc(c)).join(', ') : '—'}</span>
            ${s.handed_back.length ? `<span class="al-handed">${s.handed_back.length} handed back</span>` : ''}
            <span class="al-outcome ${o.cls}">${esc(o.text)}</span>
            ${s.observed ? `<span class="al-eye" title="observed">${icons.check(12, 'var(--mut)')}</span>` : ''}
            <span class="mut-sm" title="${esc(absTime(s.started_at))}">${esc(relTime(s.started_at))}</span>
          </a>`;
        })
        .join('') || '<p class="mut-sm">No sessions yet.</p>'}
    </div>`;
}
```

(`early` telt afgeronde niet-nul-exits én crash-rijen: alles in de week dat niet completed en niet live is. Icoon voor "observed": `icons.check` — er is geen oog-icoon in de set; geen nieuw icoon toevoegen.)

- [ ] **Step 2: route + sidebar.** In `web/js/app.js`: import `renderSessions` uit `./views/sessions.js`; in `parseRoute()` vóór de card-regel: `if (hash === '/sessions') return { name: 'sessions' };`; in `route()`: `else if (r.name === 'sessions') await renderSessions(view);`. In `renderSidebar`, tussen de Routines-knop en Archive:

```js
    <a class="side-item ${route.name === 'sessions' ? 'active' : ''}" href="#/sessions">
      ${icons.bot(16, route.name === 'sessions' ? 'var(--dark)' : 'var(--mut)')}<span>Agent log</span>
    </a>
```

- [ ] **Step 3: CSS.** In `web/style.css`, naast de bestaande view-stijlen (kleuren via bestaande tokens/oklch-idioom):

```css
.al-head { display: flex; align-items: baseline; gap: 10px; margin: 4px 0 2px; }
.al-summary { margin: 2px 0 12px; font-size: 13px; color: var(--mut); max-width: 60ch; }
.al-tiles { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
.al-tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; min-width: 92px; }
.al-tile .n { display: block; font-size: 20px; font-weight: 700; }
.al-tile .lbl { font-size: 11px; color: var(--mut); }
.al-list { display: flex; flex-direction: column; gap: 6px; }
.al-row { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: inherit; text-decoration: none; }
.al-row:hover { border-color: var(--mut-2); }
.al-id { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 600; }
.al-cards { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mut); }
.al-handed { font-size: 11px; color: oklch(0.44 0.13 45); }
.al-outcome.ok { color: oklch(0.5 0.11 155); }
.al-outcome.crash { color: oklch(0.5 0.16 25); }
.al-outcome.live, .al-live { color: oklch(0.5 0.11 155); font-weight: 600; font-size: 11px; display: inline-flex; align-items: center; gap: 5px; }
```

(Bestaat er al een `.live-dot`-stijl van de board-heartbeat: hergebruiken, anders een 7px pulserende dot toevoegen naast deze regels.)

- [ ] **Step 4: Verify (Playwright, wegwerp-data, screenshots → docs/design/verify/agentlog/).** Seed 3 sessies met een fake runner-cmd (1 exit 0, 1 exit ≠ 0, 1 open rij zonder lock): overzicht toont tegels met kloppende cijfers, de samenvattingszin, drie rijen met completed / ended early (N) / **ended early (crash)**, trigger-labels, en de sidebar-ingang actief → `agentlog-overview-1440.png`. Rij-klik → detailpagina.

- [ ] **Step 5: Commit** — `feat(web): Agent log-overzicht — tegels, templatezin, sessielijst met afgeleide uitkomst`

---

### Task 3: Live tail op de sessie-detailpagina

**Files:**
- Modify: `web/js/views/session.js`, `web/js/app.js`, `web/style.css`

**Interfaces:**
- Consumes: `api.session(id)` met `observation`+`tail`, `api.sessionSteps(id, offset, n)` (Task 1); `triggerLabel` (Task 2).
- Produces: `stopSessionPolling()` / `pokeSessionRefresh()` uit session.js; poller-wiring in app.js.

- [ ] **Step 1: session.js herschrijven** (zelfde stap-markup als nu, plus hook, follow en observatie):

```js
// Session detail (design 2f right): header + flat steps. A running session
// tails live via the global poller — append-only, so open <details> stay
// open and scroll is never yanked. Finished sessions render once, static.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime, absTime } from '../util.js';
import { crumb } from '../components.js';
import { triggerLabel } from './sessions.js';

const STEP_ICON = { text: 'fileText', tool: 'sliders', result: 'arrowDown', raw: 'alert' };

let refreshHook = null;
let cleanup = null; // removes the follow scroll-listeners of the previous render
export function stopSessionPolling() {
  refreshHook = null;
  cleanup?.();
  cleanup = null;
}
export function pokeSessionRefresh() {
  return refreshHook?.();
}

const stepHtml = (s) => {
  const reasoning = s.label.startsWith('reasoning ·');
  const icon = icons[STEP_ICON[s.type]] ? icons[STEP_ICON[s.type]](13) : '';
  if (reasoning)
    return `<details class="step reasoning"><summary>${icon}<em>${esc(s.label)}</em></summary><pre>${esc(s.detail)}</pre></details>`;
  return `<details class="step ${s.type}"><summary>${icon}<span class="step-type">${esc(s.type)}</span> ${esc(s.label)}</summary><pre>${esc(s.detail)}</pre></details>`;
};

export async function renderSession(root, { id }) {
  stopSessionPolling();
  const { session, steps, observation, tail } = await api.session(id);
  const live = session.live === true; // annotated by the API: open row + confirmed lock
  const dur =
    session.ended_at !== null
      ? `${Math.max(1, Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 1000))}s`
      : live
        ? 'running'
        : '—';
  const outcome =
    session.ended_at === null
      ? live
        ? 'running'
        : 'ended early (crash)'
      : session.exit_status === 0
        ? 'completed'
        : `ended early (${session.exit_status ?? 'crash'})`;
  root.innerHTML = `
    ${crumb([{ text: 'Agentboard', href: '#/' }, { text: `session #${session.id}`, strong: true }])}
    <div class="session-head">
      <span class="rt-sched">${esc(triggerLabel(session.trigger))}</span>
      <span class="mut-sm" title="${esc(absTime(session.started_at))}">${esc(relTime(session.started_at))} · ${esc(dur)} · <span id="s-outcome">${esc(outcome)}</span></span>
      ${session.cards.map((c) => `<a class="cardref-chip" href="#/card/${esc(c)}">${esc(c)}</a>`).join('')}
      ${live ? `<span class="al-live" id="s-live"><span class="live-dot"></span><span id="s-beat">live</span></span>
      <button type="button" class="follow-btn on" id="s-follow">follow</button>` : ''}
    </div>
    <div class="session-steps" id="s-steps">
      ${steps.map(stepHtml).join('') || '<p class="mut-sm">Empty transcript.</p>'}
    </div>
    ${observation ? `<div class="observation"><h3>Observation</h3><pre>${esc(observation)}</pre></div>` : ''}`;
  if (!live) return;

  let cursor = { offset: tail.offset, n: tail.n };
  let follow = true;
  let lastStepAt = Date.now();
  const list = root.querySelector('#s-steps');
  const followBtn = root.querySelector('#s-follow');
  followBtn.onclick = () => {
    follow = !follow;
    followBtn.classList.toggle('on', follow);
    if (follow) list.lastElementChild?.scrollIntoView({ block: 'end' });
  };
  // Scrolling up is an implicit "stop following"; the button turns it back on.
  const offFollow = () => {
    if (window.scrollY + window.innerHeight < document.body.scrollHeight - 40 && follow) {
      follow = false;
      followBtn.classList.remove('on');
    }
  };
  window.addEventListener('wheel', offFollow, { passive: true });
  window.addEventListener('touchmove', offFollow, { passive: true });
  cleanup = () => {
    window.removeEventListener('wheel', offFollow);
    window.removeEventListener('touchmove', offFollow);
  };

  refreshHook = async () => {
    const r = await api.sessionSteps(id, cursor.offset, cursor.n);
    cursor = { offset: r.offset, n: r.n };
    if (r.steps.length) {
      if (list.firstElementChild?.tagName === 'P') list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', r.steps.map(stepHtml).join(''));
      lastStepAt = Date.now();
      if (follow) list.lastElementChild?.scrollIntoView({ block: 'end' });
    }
    const beat = root.querySelector('#s-beat');
    if (beat) beat.textContent = `live · last step ${Math.max(0, Math.round((Date.now() - lastStepAt) / 1000))}s ago`;
    if (!r.live) {
      // The session ended: one final static render shows duration, exit and
      // the observation block if one appeared.
      stopSessionPolling();
      await renderSession(root, { id });
    }
  };
}
```

- [ ] **Step 2: poller-wiring.** In `web/js/app.js`: import wordt `import { renderSession, stopSessionPolling, pokeSessionRefresh } from './views/session.js';`; in `route()` naast `stopCardPolling()` ook `stopSessionPolling();`. In `tick()` vervangt de sessie-tak het policy-comment:

```js
    else if (name === 'session') await pokeSessionRefresh(); // live tail: append-only, no rerender (4b)
```

(De hook is alleen gezet op een live sessie; op een afgeronde sessie is dit een no-op. De overlay-guard erboven blijft ongewijzigd.)

- [ ] **Step 3: CSS.**

```css
.follow-btn { margin-left: auto; font-size: 11px; border: 1px solid var(--line); border-radius: 7px; padding: 3px 10px; background: var(--card); color: var(--mut); cursor: pointer; }
.follow-btn.on { border-color: oklch(0.5 0.11 155); color: oklch(0.5 0.11 155); font-weight: 600; }
.observation { margin-top: 18px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.observation h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--mut); }
.observation pre { margin: 0; white-space: pre-wrap; font-size: 12.5px; }
```

- [ ] **Step 4: Verify (Playwright, wegwerp-data).** Open rij + lockfile met eigen pid (live): open `#/session/<id>`, klap een reasoning-stap open, append 2 complete regels aan de JSONL → binnen ~3 s verschijnen 2 stappen onderaan zónder rerender (markeer vooraf een DOM-node via `page.evaluate` met een property en check dat die er nog is), de opengeklapte stap blijft open, follow scrollt naar de nieuwste → `livetail-1440.png`. Verwijder de lock en zet `ended_at` → binnen ~3 s klapt de kop om naar de afgerond-weergave. Fake observatiebestand → Observation-blok zichtbaar → `observation-1440.png`. Regressie: kaartdetail-poll en board-pulse werken nog (spot-check).

- [ ] **Step 5: Commit** — `feat(web): live tail — append-only sessiedetail met follow en Observation-blok`

---

### Task 4: Observer — runSession-override + `agentboard observe` + README

**Files:**
- Modify: `src/core/runner.ts`, `src/cli/index.ts`, `README.md`

**Interfaces:**
- Consumes: `observationPath` (Task 1), bestaande `runSession`/lock/capture.
- Produces: `runSession(dryRun, trigger, promptOverride?)`; `observeSession(nr, visionPath?)`; CLI `agentboard observe <nr> [--vision <path>] [--json]`.

- [ ] **Step 1: prompt-override in runSession.** Signatuur: `export function runSession(dryRun = false, trigger = 'manual', promptOverride?: string)`. In de body: `const cards = promptOverride ? [] : gateWork();` en `const due = promptOverride ? { routines: [] as RoutineInfo[], errors: [] as string[] } : dueRoutines();` (check het echte errors-elementtype in routines.ts en gebruik dat); de gate-empty-return krijgt `if (!promptOverride && cards.length === 0 && due.routines.length === 0)`; de spawn gebruikt `promptOverride ?? buildPrompt(due.routines)`. Verder niets — lock, capture, scan, notify en finally blijven exact staan.

- [ ] **Step 2: observeSession.** In `src/core/runner.ts` (importeer `observationPath` uit `./sessions.js`), na `runSession`:

```ts
// Observer (vision besluit J): re-read a finished session and judge it
// against the rulebook. The prompt does the work — report to a fixed path,
// an ops card only on a real violation. Runs through runSession, so the
// single-flight lock and session capture apply to the observer itself.
export function observeSession(
  nr: number,
  visionPath?: string
): ReturnType<typeof runSession> & { report: string } {
  const db = openDb();
  try {
    const row = db.prepare('SELECT ended_at, "trigger" FROM session WHERE id = ?').get(nr) as
      | { ended_at: string | null; trigger: string }
      | undefined;
    if (!row) throw new Error(`Session not found: ${nr}`);
    if (row.ended_at === null) throw new Error(`Session #${nr} is still running — observe finished sessions only`);
    if (row.trigger === 'observe') throw new Error(`Session #${nr} is itself an observation — nothing to observe`);
  } finally {
    db.close();
  }
  if (visionPath && !fs.existsSync(visionPath)) throw new Error(`Vision document not found: ${visionPath}`);
  const report = observationPath(nr);
  const prompt =
    `You are the agentboard observer. Review finished session #${nr}.\n\n` +
    `1. Read the redacted transcript: run \`agentboard sessions show ${nr}\`. Never read the raw JSONL.\n` +
    `2. Read the agent rulebook at ${agentMdPath()}.\n` +
    (visionPath ? `3. Read the vision document at ${visionPath} — the standard the rulebook serves.\n` : '') +
    `\nJudge the session against those rules: claiming, status moves, hand-backs, secret hygiene, routine dedup, scope.\n` +
    `Write a short markdown report to ${report}: first line \`verdict: pass\` or \`verdict: violation\`, then findings and concrete improvements.\n` +
    `Only if a rule was violated: also create one ops card describing it, owner human, on the board of the card involved ` +
    `(check \`agentboard card new --help\` for syntax). No violation, no card.\n` +
    `The report file is your only required output.`;
  return { ...runSession(false, 'observe', prompt), report };
}
```

- [ ] **Step 3: CLI.** In `src/cli/index.ts` (importeer `observeSession`), na het `runner`-commando:

```ts
program
  .command('observe <nr>')
  .description('review a finished session against AGENT.md (and the vision doc if provided): report + ops card on violation')
  .option('--vision <path>', 'vision document to judge against (default: $AGENTBOARD_VISION)')
  .option('--json', 'JSON output')
  .action(
    run((opts, nr: string) => {
      const result = observeSession(Number(nr), opts.vision ?? process.env.AGENTBOARD_VISION);
      const text = result.started
        ? `Observation done (${result.reason}), report: ${result.report}`
        : `No observation: ${result.reason}`;
      output(opts, text, result);
    })
  );
```

- [ ] **Step 4: README.** Drie chirurgische toevoegingen: (1) onder Sessions een subsectie "Observer" — wat `observe <nr>` doet, de weigeringen (running/observe), `--vision`/`AGENTBOARD_VISION`, waar het rapport landt, en dat de observatie zelf een gelogde sessie met trigger `observe` is; (2) in de web-UI-sectie één regel over de Agent log-pagina en de live tail; (3) bij Backup de noot dat sessies (JSONL + observaties) bewust buiten de backup vallen — werklogs, geen brondata; `sessions prune` is het opruimkanaal.

- [ ] **Step 5: Verify.** Wegwerp-dir; fake `AGENTBOARD_SESSION_CMD` (zelfde-shell-export) die zijn prompt naar een bestand schrijft. (1) Eerst een gewone fake sessie draaien (runner) zodat er een afgeronde sessie is; (2) `agentboard observe <nr>` → started, nieuwe sessierij met trigger `observe`, en het prompt-bestand bevat het rapportpad + `sessions show <nr>` + AGENT.md-pad, en géén visieregel; (3) met `--vision <bestaand pad>` → wel de visieregel; met `--vision /nope` → nette fout; (4) observe op de observe-sessie → geweigerd; observe op een open rij (ended_at NULL via node-script) → geweigerd; (5) lock aanwezig → `No observation: session already running`. `npm run build` schoon.

- [ ] **Step 6: Commit** — `feat: agentboard observe — sessiereview via runner-machinerie, rapport + ops card bij schending`

---

### Task 5: verify-agentlog.sh + regressieketen

**Files:**
- Create: `docs/superpowers/plans/verify-agentlog.sh`

**Interfaces:**
- Consumes: alles hierboven.

- [ ] **Step 1: probe in huisstijl** (lees eerst `verify-sessions.sh` en `verify-realtime.sh` voor de patronen: `set -euo pipefail`, fail/id_of-helpers, mktemp-datadir, trap die serve killt, node `--input-type=module` voor db-manipulatie, fake sessie-cmd altijd zelfde-shell). Legs, elk een assert: (1) steps-endpoint incrementeel — offset/n lopen door over twee appends; (2) partial line blijft staan bij open rij, telt mee na sluiten; (3) `live`-annotatie: open rij zonder lock false, mét eigen lock true; (4) `observed` + observation-redactie (secret in fake rapport → `[secret:…]`); (5) JSON-escape-redactie in stappen; (6) observe: weigert running + observe-sessie, draait met fake cmd, rij met trigger `observe`; (7) prune verwijdert het observatiebestand mee. Eindigt met `OK: agentlog verified (steps-incremental, live/observed, observe, redaction, prune)`.
- [ ] **Step 2: keten.** `npm run build && docs/superpowers/plans/verify-agentlog.sh && verify-realtime.sh && verify-sessions.sh && verify-trigger.sh && verify-routines.sh && verify-blockers.sh` (volle paden) → zes OK-regels.
- [ ] **Step 3: Commit** — `test: end-to-end probe voor agent log, live tail en observer`
