// All boards, stacked. Desktop: mini columns styled exactly like the
// single-board view, tinted even when empty.
// Mobile: per board only the cards that need you, the rest counted as quiet.
import { api } from '../api.js';
import { icons, STATUS_META, STATUSES } from '../icons.js';
import { esc } from '../util.js';
import { cardTile, statusPill, openCreateDialog, crumb } from '../components.js';
import { tabs, needYouCount, openCount } from './board.js';

export const boardDot = (i) => (i === 0 ? 'var(--brand)' : 'var(--mut-2)');

// Same column heads and tints as the single-board view (user decision,
// overrides artboard 1g); the stacked structure and quiet strips stay.
function miniColumn(status, cards) {
  const meta = STATUS_META[status];
  const tint = status === 'done' ? 'done' : meta.chip !== 'neutral' ? status : '';
  const head = `<div class="col-head"><div class="left">${statusPill(status)}<span class="col-count">${cards.length}</span></div></div>`;
  const body =
    cards.length === 0
      ? `<div class="ab-empty">—</div>`
      : `${cardTile(cards[0], { compact: true })}
    ${cards.length > 1 ? `<div class="ab-more">+${cards.length - 1} more</div>` : ''}`;
  return `<div class="ab-col ${tint}">${head}${body}</div>`;
}

export async function renderAllBoards(root, { boards }) {
  const views = await Promise.all(boards.map((b) => api.board(b.id)));
  const totalNeed = views.reduce((n, v) => n + needYouCount(v.columns), 0);
  const totalOpen = views.reduce((n, v) => n + openCount(v.columns), 0);
  const boardsWithNeed = views.filter((v) => needYouCount(v.columns) > 0).length;

  root.innerHTML = `
    ${crumb([{ text: 'Agentboard' }, { text: 'All boards', strong: true }])}
    <div class="toolbar">
      ${tabs(boards, null)}
      ${totalNeed > 0 ? `<span class="needsme-chip"><span class="dot"></span>${totalNeed} need you across ${boardsWithNeed} board${boardsWithNeed === 1 ? '' : 's'}</span>` : `<span class="allclear-chip">${icons.allClear(16)}Nothing waiting on you</span>`}
      <button type="button" class="btn-new" data-new>${icons.plus(14, '#fff')}New card</button>
    </div>
    <div class="m-head">
      <div class="row"><span class="title">All boards</span><button type="button" class="m-new" data-new>${icons.plus(13, '#fff')}New</button></div>
      <p class="m-sub">${totalNeed} card${totalNeed === 1 ? '' : 's'} need you · ${totalOpen} open</p>
    </div>
    <div class="ab-scroll">
      ${views
        .map(({ board, columns }, i) => {
          const need = needYouCount(columns);
          const open = openCount(columns);
          const needCards = [...(columns.needs_input ?? []), ...(columns.review ?? [])];
          return `<div class="ab-board">
            <div class="ab-head">
              <span class="dot" style="background:${boardDot(i)}"></span>
              <a class="bname" href="#/board/${esc(board.id)}">${esc(board.name)}</a>
              <span class="slug">${esc(board.id)}</span>
              <span class="open">${open} open</span>
              ${need > 0 ? `<span class="needyou">${need} need${need === 1 ? 's' : ''} you</span>` : ''}
            </div>
            <div class="ab-cols">${STATUSES.map((s) => miniColumn(s, columns[s] ?? [])).join('')}</div>
            <div class="m-sections">
              ${needCards.map((c) => cardTile(c)).join('')}
              ${open - needCards.length > 0 ? `<div class="m-quiet">${needCards.length ? '' : ''}${open - needCards.length} quiet card${open - needCards.length === 1 ? '' : 's'}</div>` : ''}
            </div>
          </div>`;
        })
        .join('')}
    </div>
  `;
  root.querySelectorAll('[data-new]').forEach((b) => {
    b.onclick = () => openCreateDialog({ boards, boardId: null }, (card) => (location.hash = `#/card/${card.id}`));
  });
}
