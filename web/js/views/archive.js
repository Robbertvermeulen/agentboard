// Archived cards of one board: id, title, reason, date. Nothing is deleted.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, shortDate, absTime } from '../util.js';
import { crumb } from '../components.js';

export async function renderArchive(root, { boards, boardId }) {
  const { cards } = await api.archived(boardId);
  const board = boards.find((b) => b.id === boardId);
  root.innerHTML = `
    ${crumb([
      { text: board?.name ?? boardId, href: `#/board/${esc(boardId)}` },
      { text: 'Archived', strong: true },
    ])}
    <div class="m-head"><div class="row">
      <span class="title">Archived</span>
      <a href="#/board/${esc(boardId)}" class="mut-sm">← ${esc(board?.name ?? boardId)}</a>
    </div></div>
    <div class="archive-wrap">
      <div class="archive-box">
        <div class="archive-head">
          ${icons.archive()}
          <span class="t">Archived</span>
          <span class="n">${cards.length} card${cards.length === 1 ? '' : 's'} · nothing is ever deleted</span>
          <a href="#/board/${esc(boardId)}">from Board → done → Archived</a>
        </div>
        ${
          cards.length
            ? cards
                .map(
                  (c) => `<a class="archive-row" href="#/card/${esc(c.id)}">
                    <span class="id${c.type === 'ops' ? ' ops' : ''}">${esc(c.id)}</span>
                    <span class="t">${esc(c.title)}</span>
                    <span class="r">${esc(c.status_reason ?? '')}</span>
                    <span class="d" title="${esc(absTime(c.status_since))}">${esc(shortDate(c.status_since))}</span>
                  </a>`
                )
                .join('')
            : '<p class="archive-empty">Nothing archived yet.</p>'
        }
      </div>
    </div>
  `;
}
