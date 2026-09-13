// All boards, stacked. Desktop: mini columns styled exactly like the
// single-board view, tinted even when empty.
// Mobile: the same collapsed-stage columns as the single-board view, one
// accordion per board (opening a column in one board doesn't close another
// board's open column).
import { api } from '../api.js';
import { icons, STATUS_META, STATUSES } from '../icons.js';
import { esc } from '../util.js';
import { cardTile, statusPill, openCreateDialog, openBoardDialog, openNewMenu, crumb } from '../components.js';
import { tabs, wireTabs, needYouCount, openCount, column } from './board.js';

export const boardDot = (i) => (i === 0 ? 'var(--brand)' : 'var(--mut-2)');

// Same column heads and tints as the single-board view (user decision,
// overrides artboard 1g); the stacked structure and quiet strips stay.
// Max 3 cards per mini column; the "+N more" link opens the board itself.
function miniColumn(status, cards, boardId) {
  const meta = STATUS_META[status];
  const tint = status === 'done' ? 'done' : meta.chip !== 'neutral' ? status : '';
  const head = `<div class="col-head"><div class="left">${statusPill(status)}<span class="col-count">${cards.length}</span></div></div>`;
  const rest = cards.length - 3;
  const body =
    cards.length === 0
      ? `<div class="ab-empty">—</div>`
      : `${cards.slice(0, 3).map((c) => cardTile(c, { compact: true })).join('')}
    ${rest > 0 ? `<a class="ab-more" href="#/board/${esc(boardId)}">+${rest} more</a>` : ''}`;
  return `<div class="ab-col ${tint}">${head}${body}</div>`;
}

export async function renderAllBoards(root, { boards }) {
  const [views, archivedCounts, sessionStatus] = await Promise.all([
    Promise.all(boards.map((b) => api.board(b.id))),
    Promise.all(boards.map((b) => api.archived(b.id).then((r) => r.cards.length))),
    api.sessionStatus().catch(() => ({ running: false })),
  ]);
  const totalNeed = views.reduce((n, v) => n + needYouCount(v.columns), 0);
  const totalOpen = views.reduce((n, v) => n + openCount(v.columns), 0);
  const boardsWithNeed = views.filter((v) => needYouCount(v.columns) > 0).length;

  root.innerHTML = `
    ${crumb([{ text: 'Agentboard' }, { text: 'All boards', strong: true }])}
    <div class="toolbar">
      ${tabs(boards, null)}
      ${totalNeed > 0 ? `<span class="needsme-chip"><span class="dot"></span>${totalNeed} need you across ${boardsWithNeed} board${boardsWithNeed === 1 ? '' : 's'}</span>` : `<span class="allclear-chip">${icons.allClear(16)}Nothing waiting on you</span>`}
      <button type="button" class="btn-new" data-new-menu>${icons.plus(14, '#fff')}New${icons.chevronDown(14, '#fff')}</button>
    </div>
    <div class="m-head">
      <div class="row"><span class="title">All boards</span><button type="button" class="m-new" data-new-menu>${icons.plus(13, '#fff')}New${icons.chevronDown(13, '#fff')}</button></div>
      <p class="m-sub">${totalNeed} card${totalNeed === 1 ? '' : 's'} need you · ${totalOpen} open</p>
    </div>
    <div class="ab-scroll">
      ${views
        .map(({ board, columns }, i) => {
          const need = needYouCount(columns);
          const open = openCount(columns);
          const colOpts = { boardId: board.id, archivedCount: archivedCounts[i], showAllDone: true, sessionStatus };
          return `<div class="ab-board" data-board-id="${esc(board.id)}">
            <div class="ab-head">
              <span class="dot" style="background:${boardDot(i)}"></span>
              <a class="bname" href="#/board/${esc(board.id)}">${esc(board.name)}</a>
              <span class="slug">${esc(board.id)}</span>
              <span class="open">${open} open</span>
              ${need > 0 ? `<span class="needyou">${need} need${need === 1 ? 's' : ''} you</span>` : ''}
            </div>
            <div class="ab-cols">${STATUSES.map((s) => miniColumn(s, columns[s] ?? [], board.id)).join('')}</div>
            <div class="ab-columns">${STATUSES.map((s) => column(s, columns[s] ?? [], colOpts)).join('')}</div>
          </div>`;
        })
        .join('')}
    </div>
  `;
  wireTabs(root);
  const goToCard = (card) => (location.hash = `#/card/${card.id}`);
  const goToBoard = (board) => (location.hash = `#/board/${board.id}`);
  // Mobile accordion, same behaviour as the single-board view, but scoped to
  // each board's own section — opening a column in one board leaves another
  // board's open column alone.
  root.querySelectorAll('[data-toggle-status]').forEach((h) => {
    h.onclick = (e) => {
      if (e.target.closest('.col-plus')) return;
      const col = h.closest('.column');
      const section = h.closest('.ab-columns');
      const wasOpen = col.classList.contains('open');
      section.querySelectorAll('.column.open').forEach((c) => c.classList.remove('open'));
      if (!wasOpen) col.classList.add('open');
    };
  });
  root.querySelectorAll('[data-new-in]').forEach((b) => {
    const boardId = b.closest('.ab-board').dataset.boardId;
    b.onclick = () => openCreateDialog({ boards, boardId, targetStatus: b.dataset.newIn }, goToCard);
  });
  root.querySelectorAll('[data-new-menu]').forEach((b) => {
    b.onclick = () =>
      openNewMenu(
        {
          onCard: () => openCreateDialog({ boards, boardId: null }, goToCard),
          onBoard: () => openBoardDialog(goToBoard),
        },
        b
      );
  });
}
