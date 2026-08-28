// Routines modal (design 2e): read-only list per board; pausing is the only
// change made here — everything else goes through an ops card.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime } from '../util.js';
import { openOverlay, closeOverlay } from '../components.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Light humanization for common patterns; anything else shows the raw cron.
export function humanizeCron(expr) {
  const p = String(expr).trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = p;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return expr;
  const hm = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*') return `daily ${hm}`;
  if (dom === '*' && mon === '*' && /^\d+$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${hm}`;
  if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `monthly ${dom} ${hm}`;
  return expr;
}

export async function openRoutinesModal({ boards, boardId }) {
  let data;
  try {
    data = await api.routines(boardId ?? undefined);
  } catch (err) {
    data = { routines: [], errors: [{ path: '-', error: err.message }] };
  }
  const groups = new Map();
  for (const r of data.routines) {
    if (!groups.has(r.board)) groups.set(r.board, []);
    groups.get(r.board).push(r);
  }
  const boardName = (id) => boards.find((b) => b.id === id)?.name ?? id;

  const row = (r) => `<div class="rt-row${r.enabled ? '' : ' paused'}" data-path="${esc(r.path)}" data-enabled="${r.enabled}">
    <div class="rt-main">
      <span class="rt-name">${esc(r.name)}</span>
      <span class="rt-sched" title="${esc(r.schedule)}">${esc(humanizeCron(r.schedule))}</span>
    </div>
    <div class="rt-meta">
      ${
        r.last_card
          ? `last run <a href="#/card/${esc(r.last_card.id)}">${esc(r.last_card.id)}</a> · ${esc(relTime(r.last_run_at))} (${esc(r.last_card.status)})`
          : `last run ${esc(relTime(r.last_run_at))}`
      }
      — next ${r.next_run ? (r.next_run <= new Date().toISOString() ? '<span class="rt-overdue">overdue</span>' : esc(relTime(r.next_run))) : '-'}
      ${r.enabled ? '' : '<span class="rt-paused-tag">paused</span>'}
    </div>
    <button type="button" class="rt-toggle${r.enabled ? ' on' : ''}" aria-label="${r.enabled ? 'Pause' : 'Resume'} ${esc(r.name)}"><span class="knob"></span></button>
  </div>`;

  const el = openOverlay(`<div class="dialog routines-dialog" role="dialog" aria-label="Routines">
    <div class="create-head"><span class="create-title">Routines</span></div>
    ${
      data.routines.length === 0 && data.errors.length === 0
        ? '<p class="mut-sm">No routines yet — a routine is born from an ops card.</p>'
        : [...groups]
            .map(([id, rs]) => `<div class="rt-group"><span class="rt-board">${esc(boardName(id))}</span>${rs.map(row).join('')}</div>`)
            .join('')
    }
    ${data.errors.map((e) => `<p class="field-error">! ${esc(e.path)}: ${esc(e.error)}</p>`).join('')}
    <p class="rt-footer">Read-only. Pausing is the only change you make here — creating, editing or deleting a routine goes through an ops card.</p>
  </div>`);

  el.querySelectorAll('.rt-toggle').forEach((b) => {
    b.onclick = async () => {
      const rowEl = b.closest('.rt-row');
      try {
        await api.toggleRoutine(rowEl.dataset.path, rowEl.dataset.enabled !== 'true');
        closeOverlay();
        openRoutinesModal({ boards, boardId });
      } catch (err) {
        rowEl.insertAdjacentHTML('beforeend', `<p class="field-error">${esc(err.message)}</p>`);
      }
    };
  });
  el.querySelectorAll('.rt-row a').forEach((a) => (a.onclick = () => closeOverlay()));
}
