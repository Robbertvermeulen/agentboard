// Hash router + shell (sidebar, mobile tab bar). Views render into #view.
import { api } from './api.js';
import { icons } from './icons.js';
import { esc } from './util.js';
import { closeOverlay, openOverlay } from './components.js';
import { renderAllBoards, boardDot } from './views/allboards.js';
import { renderBoard, needYouCount, openCount } from './views/board.js';
import { renderCard, stopCardPolling, pokeCardRefresh, retryCardRefresh } from './views/card.js';
import { renderSession, stopSessionPolling, pokeSessionRefresh } from './views/session.js';
import { renderSessions } from './views/sessions.js';
import { renderCtx } from './views/ctx.js';
import { renderArchive } from './views/archive.js';
import { openRoutinesModal } from './views/routines.js';
import { renderLogin } from './views/login.js';
import { renderEnrol } from './views/enrol.js';

const view = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');

let boards = [];
let authState = { auth: false, user: null };

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  if ((m = hash.match(/^\/board\/([^/]+)\/archived$/))) return { name: 'archive', boardId: decodeURIComponent(m[1]) };
  if ((m = hash.match(/^\/board\/([^/]+)$/))) return { name: 'board', boardId: decodeURIComponent(m[1]) };
  if ((m = hash.match(/^\/session\/(\d+)$/))) return { name: 'session', id: Number(m[1]) };
  if (hash === '/sessions') return { name: 'sessions' };
  if ((m = hash.match(/^\/card\/([^/]+)$/))) return { name: 'card', cardId: decodeURIComponent(m[1]) };
  if (hash === '/ctx') return { name: 'ctx', path: null };
  if ((m = hash.match(/^\/ctx\/(.+)$/))) return { name: 'ctx', path: decodeURIComponent(m[1]) };
  if ((m = hash.match(/^\/enrol\/([^/]+)$/))) return { name: 'enrol', token: m[1] };
  return { name: 'all' };
}

async function signOut() {
  try {
    await api.auth.logout();
  } catch {
    /* already gone */
  }
  location.hash = '#/';
  location.reload();
}

function renderSidebar(route, views) {
  const onBoards = route.name === 'all' || route.name === 'board' || route.name === 'archive' || route.name === 'card';
  const totalNeed = views ? views.reduce((n, v) => n + needYouCount(v.columns), 0) : null;
  sidebar.innerHTML = `
    <div class="side-logo"><span class="mark">A</span><span class="name">Agentboard</span></div>
    <a class="side-item ${onBoards && route.name !== 'archive' ? 'active' : ''}" href="#/">
      ${icons.board(16, onBoards ? 'var(--dark)' : 'var(--mut)')}
      <span>Board</span>
      ${totalNeed ? `<span class="count">${totalNeed}</span>` : ''}
    </a>
    <a class="side-item ${route.name === 'ctx' ? 'active' : ''}" href="#/ctx">
      ${icons.fileText(16, 'var(--mut)')}<span>Context</span>
    </a>
    <button type="button" class="side-item" id="side-routines">
      ${icons.history(16, 'var(--mut)')}<span>Routines</span>
    </button>
    <a class="side-item ${route.name === 'sessions' ? 'active' : ''}" href="#/sessions">
      ${icons.bot(16, route.name === 'sessions' ? 'var(--dark)' : 'var(--mut)')}<span>Agent log</span>
    </a>
    <a class="side-item ${route.name === 'archive' ? 'active' : ''}" href="#/board/${esc(route.boardId ?? boards[0]?.id ?? '')}/archived">
      ${icons.archive(16, 'var(--mut)')}<span>Archive</span>
    </a>
    <div class="side-sep"></div>
    <div class="side-heading">Boards</div>
    ${boards
      .map(
        (b, i) => `<a class="side-board ${route.boardId === b.id ? 'active' : ''}" href="#/board/${esc(b.id)}">
          <span class="dot" style="background:${boardDot(i)}"></span>
          <span>${esc(b.name)}</span>
          ${views ? `<span class="n">${openCount(views[i].columns)}</span>` : ''}
        </a>`
      )
      .join('')}
    ${authState.auth ? `<div class="side-sep"></div><button type="button" class="side-item" id="side-signout">${icons.user(16, 'var(--mut)')}<span>Sign out</span></button>` : ''}
  `;
  const rt = sidebar.querySelector('#side-routines');
  if (rt) rt.onclick = () => openRoutinesModal({ boards, boardId: route.boardId ?? null });
  const so = sidebar.querySelector('#side-signout');
  if (so) so.onclick = signOut;
}

function renderTabbar(route) {
  const onBoard = route.name === 'all' || route.name === 'board' || route.name === 'archive' || route.name === 'card';
  tabbar.innerHTML = `
    <a class="tab-item ${onBoard ? 'active' : ''}" href="#/">${icons.board(22, onBoard ? 'var(--dark)' : 'var(--mut-2)')}<span>Board</span></a>
    <a class="tab-item ${route.name === 'ctx' ? 'active' : ''}" href="#/ctx">${icons.fileText(22, route.name === 'ctx' ? 'var(--dark)' : 'var(--mut-2)')}<span>Context</span></a>
    <a class="tab-item ${route.name === 'sessions' || route.name === 'session' ? 'active' : ''}" href="#/sessions">${icons.bot(22, route.name === 'sessions' || route.name === 'session' ? 'var(--dark)' : 'var(--mut-2)')}<span>Agent log</span></a>
    <button type="button" class="tab-item" id="tab-more">${icons.chevronDown(22, 'var(--mut-2)')}<span>More</span><span class="tab-badge" id="more-badge" hidden></span></button>
  `;
  tabbar.querySelector('#tab-more').onclick = () => openMoreSheet(route);
  // Badge: a paused routine must not fail silently behind the More tab.
  api.routines()
    .then(({ routines }) => {
      const paused = routines.filter((r) => r.enabled === false).length;
      const badge = tabbar.querySelector('#more-badge');
      if (badge && paused > 0) {
        badge.textContent = paused;
        badge.hidden = false;
      }
    })
    .catch(() => {});
}

function openMoreSheet(route) {
  const boardId = route.boardId ?? boards[0]?.id ?? '';
  const el = openOverlay(
    `<div class="sheet more-sheet">
      <div class="sheet-handle"></div>
      <button type="button" class="more-row" id="more-routines">${icons.history(18)}<span class="t">Routines</span><span class="meta" id="more-routines-meta"></span></button>
      <a class="more-row" href="#/board/${esc(boardId)}/archived">${icons.archive(18)}<span class="t">Archive</span><span class="meta">searchable</span></a>
      <div class="sheet-head"><span>Switch board</span></div>
      ${boards.map((b) => `<a class="more-row board" href="#/board/${esc(b.id)}"><span class="dot" style="background:${boardDot(boards.indexOf(b))}"></span><span class="t">${esc(b.name)}</span>${route.boardId === b.id ? `<span class="meta">current</span>` : ''}</a>`).join('')}
      ${authState.auth ? `<div class="sheet-head"><span>Account</span></div><button type="button" class="more-row" id="more-signout">${icons.user(18)}<span class="t">Sign out</span></button>` : ''}
    </div>`,
    { sheet: true }
  );
  el.querySelector('#more-routines').onclick = () => {
    closeOverlay();
    openRoutinesModal({ boards, boardId: route.boardId ?? null });
  };
  api.routines()
    .then(({ routines }) => {
      const paused = routines.filter((r) => r.enabled === false).length;
      const meta = el.querySelector('#more-routines-meta');
      if (meta) meta.textContent = `${routines.length}${paused ? ` · ${paused} paused` : ''}`;
    })
    .catch(() => {});
  const so = el.querySelector('#more-signout');
  if (so) so.onclick = signOut;
}

function renderError(err) {
  view.innerHTML = `<div class="view-error">
    ${icons.alert(28, 'var(--mut-2)')}
    <span class="big">That did not work</span>
    <span class="msg">${esc(err.message)}</span>
    <a href="#/">Back to the board</a>
  </div>`;
}

async function route() {
  closeOverlay();
  stopCardPolling();
  stopSessionPolling();
  const r = parseRoute();
  if (r.name === 'enrol') {
    // Enrol has no session yet: no sidebar, no board fetches.
    sidebar.innerHTML = '';
    tabbar.innerHTML = '';
    view.innerHTML = '';
    await renderEnrol(view, { token: r.token });
    return;
  }
  renderTabbar(r);
  try {
    boards = (await api.boards()).boards;
    renderSidebar(r);
    // The sessions overview preserves its own scroll position across the
    // blind rerenders route() does on every changed tick — it needs the OLD
    // .page-scroll still in the DOM to read scrollTop from before it
    // overwrites it, so it alone is exempted from the blank-first below.
    if (r.name !== 'sessions') view.innerHTML = '';
    if (r.name === 'all') await renderAllBoards(view, { boards });
    else if (r.name === 'board') await renderBoard(view, { boards, boardId: r.boardId });
    else if (r.name === 'archive') await renderArchive(view, { boards, boardId: r.boardId });
    else if (r.name === 'card') await renderCard(view, { boards, cardId: r.cardId });
    else if (r.name === 'session') await renderSession(view, { id: r.id });
    else if (r.name === 'sessions') await renderSessions(view);
    else if (r.name === 'ctx') await renderCtx(view, { path: r.path });
    // Sidebar counts arrive after the view; cheap against the local API.
    const views = await Promise.all(boards.map((b) => api.board(b.id)));
    renderSidebar(r, views);
  } catch (err) {
    if (err.status === 401) {
      sidebar.innerHTML = '';
      tabbar.innerHTML = '';
      renderLogin(view, { next: location.hash });
      return;
    }
    renderError(err);
  }
}

window.addEventListener('hashchange', route);
api.auth
  .state()
  .then((s) => {
    authState = s;
  })
  .catch(() => {})
  .finally(route);

// --- realtime (vision besluit K): one cheap poll drives every view ---
let cursor = null;
let ticking = false;
async function tick() {
  if (document.hidden || ticking) return;
  if (parseRoute().name === 'enrol' || document.getElementById('login-btn')) return; // login/enrol view: nothing to sync
  ticking = true;
  try {
    const res = await api.changes(cursor ?? undefined);
    const changed = cursor !== null && res.changed;
    const name = parseRoute().name;
    if (!changed) {
      cursor = res.cursor;
      if (name === 'card') await retryCardRefresh(); // nudge a pending refresh a dirty-guard held back (no extra fetch; awaited so the busy flag covers it)
      else if (name === 'session') await pokeSessionRefresh(); // live tail pulls its increment even on quiet ticks — new steps advance no cursor component
      return;
    }
    const overlay = document.getElementById('overlay');
    if (overlay && !overlay.hidden) return; // keep the old cursor: the next tick re-sees the change after the dialog closes
    cursor = res.cursor;
    if (name === 'card') await pokeCardRefresh();
    else if (name === 'session') await pokeSessionRefresh(); // live tail: append-only, no rerender (4b)
    else await route(); // cheap full re-render; overlay is closed, so no loss
  } catch {
    /* server hiccup — next tick retries */
  } finally {
    ticking = false;
  }
}
setInterval(tick, 2500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});
