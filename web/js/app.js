// Hash router + shell (sidebar, mobile tab bar). Views render into #view.
import { api } from './api.js';
import { icons } from './icons.js';
import { esc } from './util.js';
import { closeOverlay } from './components.js';
import { renderAllBoards, boardDot } from './views/allboards.js';
import { renderBoard, needYouCount, openCount } from './views/board.js';
import { renderCard, stopCardPolling, pokeCardRefresh, retryCardRefresh } from './views/card.js';
import { renderSession } from './views/session.js';
import { renderCtx } from './views/ctx.js';
import { renderArchive } from './views/archive.js';
import { openRoutinesModal } from './views/routines.js';

const view = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');

let boards = [];

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  if ((m = hash.match(/^\/board\/([^/]+)\/archived$/))) return { name: 'archive', boardId: decodeURIComponent(m[1]) };
  if ((m = hash.match(/^\/board\/([^/]+)$/))) return { name: 'board', boardId: decodeURIComponent(m[1]) };
  if ((m = hash.match(/^\/session\/(\d+)$/))) return { name: 'session', id: Number(m[1]) };
  if ((m = hash.match(/^\/card\/([^/]+)$/))) return { name: 'card', cardId: decodeURIComponent(m[1]) };
  if (hash === '/ctx') return { name: 'ctx', path: null };
  if ((m = hash.match(/^\/ctx\/(.+)$/))) return { name: 'ctx', path: decodeURIComponent(m[1]) };
  return { name: 'all' };
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
  `;
  const rt = sidebar.querySelector('#side-routines');
  if (rt) rt.onclick = () => openRoutinesModal({ boards, boardId: route.boardId ?? null });
}

function renderTabbar(route) {
  const onBoard = route.name !== 'ctx';
  tabbar.innerHTML = `
    <a class="tab-item ${onBoard ? 'active' : ''}" href="#/">${icons.board(22, onBoard ? 'var(--dark)' : 'var(--mut-2)')}<span>Board</span></a>
    <a class="tab-item ${route.name === 'ctx' ? 'active' : ''}" href="#/ctx">${icons.fileText(22, route.name === 'ctx' ? 'var(--dark)' : 'var(--mut-2)')}<span>Context</span></a>
  `;
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
  const r = parseRoute();
  renderTabbar(r);
  try {
    if (!boards.length) boards = (await api.boards()).boards;
    renderSidebar(r);
    view.innerHTML = '';
    if (r.name === 'all') await renderAllBoards(view, { boards });
    else if (r.name === 'board') await renderBoard(view, { boards, boardId: r.boardId });
    else if (r.name === 'archive') await renderArchive(view, { boards, boardId: r.boardId });
    else if (r.name === 'card') await renderCard(view, { boards, cardId: r.cardId });
    else if (r.name === 'session') await renderSession(view, { id: r.id });
    else if (r.name === 'ctx') await renderCtx(view, { path: r.path });
    // Sidebar counts arrive after the view; cheap against the local API.
    const views = await Promise.all(boards.map((b) => api.board(b.id)));
    renderSidebar(r, views);
  } catch (err) {
    renderError(err);
  }
}

window.addEventListener('hashchange', route);
route();

// --- realtime (vision besluit K): one cheap poll drives every view ---
let cursor = null;
let ticking = false;
async function tick() {
  if (document.hidden || ticking) return;
  ticking = true;
  try {
    const res = await api.changes(cursor ?? undefined);
    const changed = cursor !== null && res.changed;
    const name = parseRoute().name;
    if (!changed) {
      cursor = res.cursor;
      if (name === 'card') retryCardRefresh(); // nudge a pending refresh a dirty-guard held back (no fetch)
      return;
    }
    const overlay = document.getElementById('overlay');
    if (overlay && !overlay.hidden) return; // keep the old cursor: the next tick re-sees the change after the dialog closes
    cursor = res.cursor;
    if (name === 'card') await pokeCardRefresh();
    else if (name === 'session') {
      /* policy, not overlay-suppression: the session view stays static until
         live tail (4b) — cursor still advances above, just no rerender here */
    } else await route(); // cheap full re-render; overlay is closed, so no loss
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
