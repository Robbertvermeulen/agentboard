// Single board: six columns on desktop, attention-first sections on mobile.
import { api, localActivity } from '../api.js';
import { icons, statusIcon, STATUS_META, STATUSES } from '../icons.js';
import { esc, relTime } from '../util.js';
import { cardTile, statusPill, openCreateDialog, crumb, isWaitingExternal } from '../components.js';

export const tabs = (boards, activeId) => `<div class="tabs">
  <a href="#/" class="${activeId == null ? 'active' : ''}">All boards</a>
  ${boards.map((b) => `<a href="#/board/${esc(b.id)}" class="${b.id === activeId ? 'active' : ''}">${esc(b.name)}</a>`).join('')}
</div>`;

export const needYouCount = (columns) =>
  (columns.needs_input?.filter((c) => !isWaitingExternal(c)).length ?? 0) + (columns.review?.length ?? 0);
export const openCount = (columns) => STATUSES.filter((s) => s !== 'done').reduce((n, s) => n + (columns[s]?.length ?? 0), 0);

const DAY = 24 * 60 * 60 * 1000;

let lastSeen = new Map(); // card id -> status, van de vorige render
let lastBoard = null;

function column(status, cards, { boardId, archivedCount, showAllDone, sessionStatus }) {
  const meta = STATUS_META[status];
  const head = `<div class="col-head">
    <div class="left">${statusPill(status)}<span class="col-count">${cards.length}</span></div>
    ${
      // No create-into-doing shortcut (vision besluit I): the status menu's
      // confirmed move is the one deliberate escape hatch into doing.
      status === 'doing' ? '' : `<button type="button" class="col-plus" data-new-in="${status}">${icons.plus()}</button>`
    }
  </div>`;
  if (status !== 'done') {
    const tile = (c) =>
      status === 'doing' && c.owner === 'agent'
        ? cardTile(c, { presence: sessionStatus.running ? 'live' : 'dormant' })
        : cardTile(c);
    return `<div class="column ${meta.chip !== 'neutral' ? status : ''} ${status}">${head}
      <div class="col-cards">${cards.map(tile).join('')}</div>
    </div>`;
  }
  const recent = cards.filter((c) => Date.now() - new Date(c.updated_at).getTime() < 7 * DAY);
  const shown = showAllDone ? cards : recent;
  return `<div class="column done">${head}
    ${!showAllDone ? '<div class="col-caption">last 7 days</div>' : ''}
    <div class="col-cards done-cards">${shown.map((c) => cardTile(c)).join('')}</div>
    ${!showAllDone && cards.length > shown.length ? `<button type="button" class="show-all-done" data-show-done>${icons.chevronDown(13)}Show all ${cards.length} done</button>` : ''}
    <a class="archived-link" href="#/board/${esc(boardId)}/archived">${icons.archive(13, 'var(--brand-stroke)')}Archived · ${archivedCount}</a>
  </div>`;
}

export async function renderBoard(root, { boards, boardId }) {
  const [{ board, columns }, { cards: archived }, sessionStatus] = await Promise.all([
    api.board(boardId),
    api.archived(boardId),
    api.sessionStatus().catch(() => ({ running: false })),
  ]);
  const needYou = needYouCount(columns);
  const total = openCount(columns) + (columns.done?.length ?? 0);
  let showAllDone = false;

  const lastMoved = Object.values(columns)
    .flat()
    .map((c) => c.updated_at)
    .sort()
    .at(-1);

  const draw = () => {
    root.innerHTML = `
      ${crumb([{ text: 'Agentboard' }, { text: board.name, strong: true }])}
      <div class="toolbar">
        ${tabs(boards, boardId)}
        ${
          needYou > 0
            ? `<span class="needsme-chip"><span class="dot"></span>Needs me · ${needYou}</span>`
            : total > 0
              ? `<span class="allclear-chip">${icons.allClear(16)}Nothing waiting on you</span>`
              : ''
        }
        <button type="button" class="btn-new" data-new>${icons.plus(14, '#fff')}New card</button>
      </div>
      <div class="m-head">
        <div class="row">
          <span class="title">${esc(board.name)}</span>
          ${needYou > 0 ? `<span class="m-need"><span class="dot"></span>${needYou} need you</span>` : ''}
        </div>
        <div class="m-chips">
          ${['needs_input', 'review', 'doing', 'inbox', 'ready']
            .filter((s) => columns[s]?.length)
            .map((s) => `<span class="m-chip ${STATUS_META[s].chip !== 'neutral' ? s : ''}">${esc(s)} ${columns[s].length}</span>`)
            .join('')}
          <button type="button" class="m-new" data-new>${icons.plus(13, '#fff')}New</button>
        </div>
      </div>
      ${
        total === 0 && archived.length === 0
          ? `<div class="board-empty">${icons.allClear()}<span class="big">Nothing here yet</span><span class="sub">Create the first card — it lands in inbox.</span></div>`
          : total === 0
            ? `<div class="board-empty">${icons.allClear()}<span class="big">Nothing waiting on you</span><span class="sub">Every card is done or archived.</span><a class="archived-link" href="#/board/${esc(boardId)}/archived">${icons.archive(13, 'var(--brand-stroke)')}Archived · ${archived.length}</a></div>`
            : `<div class="columns">${STATUSES.map((s) => column(s, columns[s] ?? [], { boardId, archivedCount: archived.length, showAllDone, sessionStatus })).join('')}</div>`
      }
    `;
    if (total > 0 && lastMoved && needYou === 0) {
      const chip = root.querySelector('.allclear-chip');
      if (chip) chip.insertAdjacentHTML('beforeend', `<span class="mut-sm">· last change ${esc(relTime(lastMoved))}</span>`);
    }
    root.querySelectorAll('[data-new]').forEach((b) => {
      b.onclick = () => openCreateDialog({ boards, boardId }, (card) => (location.hash = `#/card/${card.id}`));
    });
    root.querySelectorAll('[data-new-in]').forEach((b) => {
      b.onclick = () =>
        openCreateDialog({ boards, boardId, targetStatus: b.dataset.newIn }, (card) => (location.hash = `#/card/${card.id}`));
    });
    const showDone = root.querySelector('[data-show-done]');
    if (showDone)
      showDone.onclick = () => {
        showAllDone = true;
        draw();
      };
    if (lastBoard !== boardId) {
      lastSeen = new Map();
      lastBoard = boardId;
    }
    const seenNow = new Map();
    for (const cards of Object.values(columns)) for (const c of cards) seenNow.set(c.id, c.status);
    const ownRecent = Date.now() - localActivity.lastMoveAt < 4000;
    if (lastSeen.size && !ownRecent) {
      root.querySelectorAll('.card-tile[data-id]').forEach((el) => {
        const prev = lastSeen.get(el.dataset.id);
        if (prev !== seenNow.get(el.dataset.id)) el.classList.add('tile-flash');
      });
    }
    lastSeen = seenNow;
  };
  draw();
}
