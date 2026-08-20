// Shared UI vocabulary: chips, card tiles, status menu, reason + create dialogs.
import { api } from './api.js';
import { icons, statusIcon, STATUS_META, ALL_STATUSES } from './icons.js';
import { esc, absTime, ageShort, CARD_ID_RE, isMobile } from './util.js';

export function idChip(card, { size = 'md' } = {}) {
  const cls = size === 'sm' ? 'id-chip sm' : 'id-chip';
  if (card.type === 'ops') {
    return `<span class="${cls} ops">${icons.sliders(size === 'sm' ? 10 : 11)}${esc(card.id)}</span>`;
  }
  return `<span class="${cls}">${esc(card.id)}</span>`;
}

export const agentChip = () => `<span class="agent-chip">${icons.bot()}@agent</span>`;

export function ageChip(card) {
  if (card.status !== 'needs_input' && card.status !== 'review') return '';
  const cls = card.status === 'needs_input' ? 'age-chip amber' : 'age-chip green';
  return `<span class="${cls}" title="in ${esc(card.status)} since ${esc(absTime(card.status_since))}">${ageShort(card.status_since)}</span>`;
}

export const labelChips = (labels) => (labels ?? []).map((l) => `<span class="label-chip">${esc(l)}</span>`).join('');

// Status pill: filled for the active states, quiet for inbox/ready/done.
export function statusPill(status, { chevron = false, id = '' } = {}) {
  const meta = STATUS_META[status];
  const filled = meta.chip !== 'neutral';
  const icon = statusIcon(status, 12, filled ? '#fff' : undefined);
  return `<span ${id ? `id="${id}"` : ''} class="status-pill ${meta.chip}${chevron ? ' clickable' : ''}">${icon}${esc(status)}${
    chevron ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${filled ? '#fff' : 'currentColor'}" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>` : ''
  }</span>`;
}

// The "waiting: …" line (needs_input) or the plain reason line (review).
export function reasonLine(card) {
  if (!card.status_reason) return '';
  if (card.status === 'needs_input') {
    return `<p class="waiting-line">${icons.clock()}waiting: ${esc(card.status_reason)}</p>`;
  }
  if (card.status === 'review') {
    return `<p class="review-line">${esc(card.status_reason)}</p>`;
  }
  return '';
}

// refs: [{label, url?, note?}] — a url makes it external, a card id in the
// label makes it a linked-card chip (e.g. "unblocks task_5b34").
export const externalRefs = (card) => (card.refs ?? []).filter((r) => r && r.url);
export const cardRefs = (card) => (card.refs ?? []).filter((r) => r && !r.url && CARD_ID_RE.test(r.label ?? ''));

export function cardRefChip(ref) {
  const target = (ref.label ?? '').match(CARD_ID_RE)?.[0];
  return `<a class="cardref-chip" href="#/card/${esc(target)}">${icons.link(10, 'var(--brand-stroke)')}${esc(ref.label)}</a>`;
}

// One card tile on a board column. compact = the all-boards mini variant.
export function cardTile(card, { compact = false } = {}) {
  const amber = card.status === 'needs_input' ? 'amber-border' : '';
  const cls = ['card-tile', card.type === 'ops' ? 'ops-border' : amber, compact ? 'compact' : '', card.status === 'done' ? 'done-tile' : '']
    .filter(Boolean)
    .join(' ');
  const linked = cardRefs(card)[0];
  return `<a class="${cls}" href="#/card/${esc(card.id)}" data-id="${esc(card.id)}">
    <div class="tile-top">
      <span class="tile-id">${idChip(card, { size: compact ? 'sm' : 'md' })}${ageChip(card)}</span>
      ${card.owner === 'agent' && !compact ? agentChip() : ''}
      ${card.owner === 'agent' && compact ? '<span class="agent-mini">@agent</span>' : ''}
    </div>
    <p class="tile-title">${esc(card.title)}</p>
    ${reasonLine(card)}
    ${
      !compact && (card.labels?.length || linked)
        ? `<div class="tile-foot">${labelChips(card.labels)}${linked ? `<span class="tile-link">${icons.link()}${esc(linked.label.match(CARD_ID_RE)[0])}</span>` : ''}</div>`
        : ''
    }
  </a>`;
}

/* ---------- overlay plumbing ---------- */

const overlayEl = () => document.getElementById('overlay');

export function openOverlay(html, { sheet = false } = {}) {
  const el = overlayEl();
  el.innerHTML = html;
  el.hidden = false;
  el.className = sheet ? 'sheet-mode' : '';
  el.onclick = (e) => {
    if (e.target === el) closeOverlay();
  };
  document.onkeydown = (e) => {
    if (e.key === 'Escape') closeOverlay();
  };
  return el;
}

export function closeOverlay() {
  const el = overlayEl();
  el.hidden = true;
  el.innerHTML = '';
  el.onclick = null;
  document.onkeydown = null;
}

/* ---------- reason dialog: every status change asks why ---------- */

export function askReason({ title, toStatus }) {
  return new Promise((resolve) => {
    const approve = toStatus === 'done';
    const el = openOverlay(`<div class="dialog reason-dialog" role="dialog" aria-label="${esc(title)}">
      <span class="dialog-title">${esc(title)}</span>
      <p class="dialog-sub">A short reason, written to the timeline as an event.</p>
      <input id="reason-input" type="text" autocomplete="off" placeholder="Why?">
      <div class="reason-suggest">
        <button type="button" data-fill="Looks right">Looks right</button>
        <button type="button" data-fill="Checked myself">Checked myself</button>
      </div>
      <p id="reason-error" class="field-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" id="reason-cancel" class="btn-ghost">Cancel</button>
        <button type="button" id="reason-ok" class="${approve ? 'btn-green' : 'btn-dark'}" disabled>${approve ? 'Approve' : 'Move'}</button>
      </div>
    </div>`);
    const input = el.querySelector('#reason-input');
    const ok = el.querySelector('#reason-ok');
    const done = (value) => {
      closeOverlay();
      resolve(value);
    };
    input.oninput = () => (ok.disabled = !input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && input.value.trim()) done(input.value.trim());
      if (e.key === 'Escape') done(null);
    };
    el.querySelectorAll('[data-fill]').forEach((b) => {
      b.onclick = () => {
        input.value = b.dataset.fill;
        ok.disabled = false;
        input.focus();
      };
    });
    el.querySelector('#reason-cancel').onclick = () => done(null);
    ok.onclick = () => done(input.value.trim());
    input.focus();
  });
}

export function showReasonError(message) {
  const err = document.querySelector('#reason-error');
  if (err) {
    err.textContent = message;
    err.hidden = false;
  }
}

// Ask for a reason, move the card, rerender. Errors show inline in the dialog.
export async function moveWithReason(card, toStatus, onDone) {
  const title = toStatus === 'done' && card.status === 'review' ? 'Approve → Done' : `Move to ${toStatus}`;
  const reason = await askReason({ title, toStatus });
  if (reason == null) return;
  try {
    await api.move(card.id, toStatus, reason);
    onDone();
  } catch (err) {
    alertError(err.message);
  }
}

function alertError(message) {
  const el = openOverlay(`<div class="dialog"><span class="dialog-title">That did not work</span>
    <p class="dialog-sub">${esc(message)}</p>
    <div class="dialog-actions"><button type="button" class="btn-dark" id="err-ok">OK</button></div></div>`);
  el.querySelector('#err-ok').onclick = closeOverlay;
}

/* ---------- status menu: dropdown on desktop, bottom sheet on mobile ---------- */

function statusMenuItems(current) {
  return ALL_STATUSES.map((s) => {
    const active = s === current;
    return `<button type="button" class="status-item${active ? ' active' : ''}" data-status="${s}">
      ${statusIcon(s, isMobile() ? 16 : 13)}
      <span class="${s === 'archived' ? 'mut' : ''}">${s}</span>
      ${active ? `<span class="item-check">${icons.check(isMobile() ? 18 : 13, 'var(--dark)')}</span>` : ''}
    </button>`;
  }).join('');
}

export function openStatusMenu(card, onDone, anchor) {
  const pick = async (status) => {
    closeOverlay();
    if (status === card.status) return;
    await moveWithReason(card, status, onDone);
  };
  if (isMobile()) {
    const el = openOverlay(
      `<div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-head"><span>Move to</span><span class="mut-sm">a reason is asked next</span></div>
        ${statusMenuItems(card.status).replace('class="status-item', 'class="status-item sheet-item')}
      </div>`,
      { sheet: true }
    );
    el.querySelectorAll('.status-item').forEach((b) => (b.onclick = () => pick(b.dataset.status)));
  } else {
    const el = openOverlay(`<div class="dialog status-menu">
      ${statusMenuItems(card.status)}
      <p class="menu-hint">Any status is reachable — the next step asks for a reason.</p>
    </div>`);
    // Anchored under the status pill, no dim — like the design's open menu.
    if (anchor) {
      el.classList.add('anchored');
      const menu = el.querySelector('.status-menu');
      const rect = anchor.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.left = `${Math.min(rect.left, window.innerWidth - 216)}px`;
      menu.style.top = rect.bottom + 270 < window.innerHeight ? `${rect.bottom + 6}px` : `${Math.max(rect.top - 270, 8)}px`;
    }
    el.querySelectorAll('.status-item').forEach((b) => (b.onclick = () => pick(b.dataset.status)));
  }
}

/* ---------- create card dialog ---------- */

export function openCreateDialog({ boards, boardId }, onCreated) {
  const fromAll = !boardId;
  const single = boards.length === 1;
  const preset = boardId ?? (single ? boards[0].id : '');
  const el = openOverlay(`<div class="dialog create-dialog" role="dialog" aria-label="New card">
    <div class="create-head"><span class="create-title">New card</span><span class="mut-sm">lands in inbox</span></div>
    <div class="create-body">
      <div class="field">
        <span class="field-label">Type</span>
        <div class="type-toggle">
          <button type="button" class="type-btn active" data-type="task">${icons.fileText(13, 'currentColor')}task</button>
          <button type="button" class="type-btn" data-type="ops">${icons.sliders(13, 'var(--brand-stroke)')}ops</button>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Title</span>
        <input id="nc-title" type="text" placeholder="What needs to happen?" autocomplete="off">
        <span id="nc-title-error" class="field-error" hidden>${icons.alert()}<span></span></span>
      </div>
      <div class="field">
        <span class="field-label">Board ${fromAll && !single ? '<span class="req-note">· required from All boards</span>' : ''}</span>
        <select id="nc-board" ${!fromAll || single ? 'disabled' : ''}>
          ${fromAll && !single ? '<option value="">Pick a board</option>' : ''}
          ${boards.map((b) => `<option value="${esc(b.id)}" ${b.id === preset ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select>
        ${!fromAll || single ? '<span class="field-hint">On a single board it is prefilled and read-only.</span>' : ''}
      </div>
      <div class="field">
        <span class="field-label">Body <span class="field-hint-inline">· optional, markdown</span></span>
        <textarea id="nc-body" rows="3" placeholder="Context the agent needs before starting…"></textarea>
      </div>
      <div class="field">
        <span class="field-label">Labels <span class="field-hint-inline">· optional</span></span>
        <div class="labels-input" id="nc-labels"><input id="nc-label-entry" type="text" placeholder="add label…" autocomplete="off"></div>
      </div>
      <div class="create-actions">
        <button type="button" id="nc-create" class="btn-dark" disabled>Create card</button>
        <button type="button" id="nc-cancel" class="btn-ghost">Cancel</button>
        <span class="create-note">status: inbox · owner: human</span>
      </div>
    </div>
  </div>`);

  let type = 'task';
  const labels = [];
  const title = el.querySelector('#nc-title');
  const board = el.querySelector('#nc-board');
  const create = el.querySelector('#nc-create');
  const titleError = el.querySelector('#nc-title-error');
  const labelEntry = el.querySelector('#nc-label-entry');

  // Board is validated here (the select is ours); the empty-title error
  // comes from the API so its exact message is what the user sees.
  const validate = () => (create.disabled = !board.value);
  validate();
  const renderLabels = () => {
    el.querySelectorAll('.labels-input .label-chip').forEach((n) => n.remove());
    labels.forEach((l, i) => {
      const chip = document.createElement('span');
      chip.className = 'label-chip removable';
      chip.innerHTML = `${esc(l)}<button type="button" data-i="${i}">${icons.x()}</button>`;
      chip.querySelector('button').onclick = () => {
        labels.splice(i, 1);
        renderLabels();
      };
      labelEntry.before(chip);
    });
  };

  el.querySelectorAll('.type-btn').forEach((b) => {
    b.onclick = () => {
      type = b.dataset.type;
      el.querySelectorAll('.type-btn').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
  title.oninput = () => {
    titleError.hidden = true;
    title.classList.remove('invalid');
    validate();
  };
  board.onchange = validate;
  labelEntry.onkeydown = (e) => {
    if ((e.key === 'Enter' || e.key === ',') && labelEntry.value.trim()) {
      e.preventDefault();
      labels.push(labelEntry.value.trim().replace(/,+$/, ''));
      labelEntry.value = '';
      renderLabels();
    } else if (e.key === 'Backspace' && !labelEntry.value && labels.length) {
      labels.pop();
      renderLabels();
    }
  };
  el.querySelector('#nc-cancel').onclick = closeOverlay;
  create.onclick = async () => {
    try {
      const card = await api.createCard(board.value, {
        type,
        title: title.value,
        body: el.querySelector('#nc-body').value.trim() || undefined,
        labels: labels.length ? labels : undefined,
      });
      closeOverlay();
      onCreated(card);
    } catch (err) {
      title.classList.add('invalid');
      titleError.querySelector('span:last-child').textContent = err.message;
      titleError.hidden = false;
    }
  };
  title.focus();
}

/* ---------- shared breadcrumb ---------- */

export function crumb(parts) {
  return `<div class="crumb-bar">${parts
    .map((p) => {
      const inner = p.href ? `<a href="${esc(p.href)}">${esc(p.text)}</a>` : `<span class="${p.strong ? 'crumb-strong' : ''}${p.mono ? ' mono' : ''}">${esc(p.text)}</span>`;
      return inner;
    })
    .join(icons.chevronRight())}</div>`;
}
