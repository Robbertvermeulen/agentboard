// Shared UI vocabulary: chips, card tiles, status menu, reason + create dialogs.
import { api } from './api.js';
import { icons, statusIcon, STATUS_META, ALL_STATUSES } from './icons.js';
import { esc, absTime, ageShort, fmtBytes, filesFromDrop, CARD_ID_RE, isMobile } from './util.js';

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
  const old = !isWaitingExternal(card) && Date.now() - new Date(card.status_since).getTime() > 3 * 24 * 60 * 60 * 1000;
  const cls = `age-chip ${card.status === 'needs_input' ? 'amber' : 'green'}${old ? ' old' : ''}`;
  return `<span class="${cls}" title="in ${esc(card.status)} since ${esc(absTime(card.status_since))}">${ageShort(card.status_since)}</span>`;
}

export const labelChips = (labels) => (labels ?? []).map((l) => `<span class="label-chip">${esc(l)}</span>`).join('');

// Vision besluit H: a needs_input card with a live wait-check is waiting on
// something external — not the user's turn.
export const isWaitingExternal = (card) =>
  card.status === 'needs_input' && !!card.wait_check && card.wait_check > new Date().toISOString();

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
export function cardTile(card, { compact = false, presence } = {}) {
  const amber = card.status === 'needs_input' ? 'amber-border' : '';
  const cls = ['card-tile', card.type === 'ops' ? 'ops-border' : amber, compact ? 'compact' : '', card.status === 'done' ? 'done-tile' : '']
    .filter(Boolean)
    .join(' ');
  const linked = cardRefs(card)[0];
  const openBlockers = (card.blockers ?? []).filter((b) => b.status !== 'done' && b.status !== 'archived').length;
  return `<a class="${cls}" href="#/card/${esc(card.id)}" data-id="${esc(card.id)}">
    <div class="tile-top">
      <span class="tile-id">${idChip(card, { size: compact ? 'sm' : 'md' })}${ageChip(card)}${
        openBlockers ? `<span class="blocked-chip" title="${openBlockers} open blocker${openBlockers === 1 ? '' : 's'}">${icons.block(10)}${openBlockers}</span>` : ''
      }${card.open_requests ? `<span class="req-chip" title="${card.open_requests} open secret request${card.open_requests === 1 ? '' : 's'}">${icons.lock(10)}${card.open_requests} request${card.open_requests === 1 ? '' : 's'}</span>` : ''}${card.routine ? `<span class="routine-chip" title="${esc(card.routine)}">${icons.history(10)}routine</span>` : ''}${
        isWaitingExternal(card) ? `<span class="wait-chip" title="waiting on external — not in 'needs me'${card.wait_check ? ` · check ${esc(card.wait_check)}` : ''}">${icons.clock(10, 'var(--mut)')}waiting</span>` : ''
      }</span>
      ${card.owner === 'agent' && !compact ? agentChip() : ''}
      ${card.owner === 'agent' && compact ? '<span class="agent-mini">@agent</span>' : ''}
    </div>
    <p class="tile-title">${esc(card.title)}</p>
    ${reasonLine(card)}
    ${presence === 'live' ? '<p class="presence live"><span class="live-dot"></span>live session</p>' : ''}
    ${presence === 'dormant' ? '<p class="presence">no live session — resumes at the next run</p>' : ''}
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

export function askReason({ title, toStatus, warning }) {
  return new Promise((resolve) => {
    const approve = toStatus === 'done';
    const el = openOverlay(`<div class="dialog reason-dialog" role="dialog" aria-label="${esc(title)}">
      <span class="dialog-title">${esc(title)}</span>
      <p class="dialog-sub">A short reason, written to the timeline as an event.</p>
      ${warning ? `<p class="dialog-warning">${icons.block(12)}${esc(warning)}</p>` : ''}
      <input id="reason-input" type="text" autocomplete="off" placeholder="Why?">
      <div class="reason-suggest">
        <button type="button" data-fill="Looks right">Looks right</button>
        <button type="button" data-fill="Checked myself">Checked myself</button>
      </div>
      <p id="reason-error" class="field-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" id="reason-cancel" class="btn-ghost">Cancel</button>
        <button type="button" id="reason-ok" class="${approve ? 'btn-green' : 'btn-dark'}" disabled>${approve ? (warning ? 'Approve anyway' : 'Approve') : 'Move'}</button>
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
  const openBlockers = (card.blockers ?? []).filter((b) => b.status !== 'done' && b.status !== 'archived');
  const warning =
    toStatus === 'done' && openBlockers.length
      ? `Still open: ${openBlockers.map((b) => b.id).join(', ')}`
      : '';
  const title = warning
    ? `Approve with ${openBlockers.length} open blocker${openBlockers.length === 1 ? '' : 's'}?`
    : toStatus === 'done' && card.status === 'review'
      ? 'Approve → Done'
      : `Move to ${toStatus}`;
  const reason = await askReason({ title, toStatus, warning });
  if (reason == null) return;
  try {
    await api.move(card.id, toStatus, reason);
    onDone();
  } catch (err) {
    alertError(err.message);
  }
}

// Design 3b: doing stays reachable, but only through a confirmation that
// says what will really happen. Fixed reason, no free-text — the dialog is
// the reason. The liveness line only states what the system can derive.
async function confirmDoingMove(card, onDone) {
  let liveLine = '';
  try {
    const s = await api.sessionStatus();
    liveLine = s.running ? 'A session is running right now.' : 'No live session right now — the scheduler picks it up at its own next run.';
  } catch {
    /* status unavailable: no claim */
  }
  const el = openOverlay(`<div class="dialog doing-confirm" role="dialog" aria-label="Move to doing">
    <span class="exception-tag">${icons.bot(11)}exception path</span>
    <span class="dialog-title">Move this card into doing?</span>
    <p class="dialog-sub">doing is the agent's column. Put a card there yourself and the agent will start where the card is, not where you are.</p>
    <p class="dialog-sub">If you want it worked on soon, <strong>ready</strong> is the normal route — the agent claims it and moves it to doing itself.</p>
    ${liveLine ? `<p class="dialog-sub mut-sm">${esc(liveLine)}</p>` : ''}
    <div class="dialog-actions">
      <button type="button" id="doing-cancel" class="btn-ghost">Cancel</button>
      <button type="button" id="doing-ok" class="btn-dark">Move to doing anyway</button>
    </div>
  </div>`);
  el.querySelector('#doing-cancel').onclick = closeOverlay;
  el.querySelector('#doing-ok').onclick = async () => {
    closeOverlay();
    try {
      await api.move(card.id, 'doing', 'moved to doing by user (confirmed)');
      onDone();
    } catch (err) {
      alertError(err.message);
    }
  };
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
    const exception = s === 'doing' && !active;
    return `<button type="button" class="status-item${active ? ' active' : ''}${exception ? ' exception' : ''}" data-status="${s}">
      ${statusIcon(s, isMobile() ? 16 : 13)}
      <span class="${s === 'archived' ? 'mut' : ''}">${s}</span>
      ${exception ? '<span class="agent-tag">agent</span>' : ''}
      ${active ? `<span class="item-check">${icons.check(isMobile() ? 18 : 13, 'var(--dark)')}</span>` : ''}
    </button>`;
  }).join('');
}

export function openStatusMenu(card, onDone, anchor) {
  const pick = async (status) => {
    closeOverlay();
    if (status === card.status) return;
    if (status === 'doing') return confirmDoingMove(card, onDone);
    await moveWithReason(card, status, onDone);
  };
  if (isMobile()) {
    const el = openOverlay(
      `<div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-head"><span>Move to</span><span class="mut-sm">a reason is asked next</span></div>
        ${statusMenuItems(card.status).replaceAll('class="status-item', 'class="status-item sheet-item')}
      </div>`,
      { sheet: true }
    );
    el.querySelectorAll('.status-item').forEach((b) => (b.onclick = () => pick(b.dataset.status)));
  } else {
    const el = openOverlay(`<div class="dialog status-menu">
      ${statusMenuItems(card.status)}
      <p class="doing-note">doing is the agent's column — asks first.</p>
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

export function openCreateDialog({ boards, boardId, targetStatus }, onCreated) {
  const fromAll = !boardId;
  const single = boards.length === 1;
  const preset = boardId ?? (single ? boards[0].id : '');
  // Cards always land in inbox (core rule); a non-inbox target column means
  // the dialog also asks the move reason and the UI moves right after create.
  const needsReason = targetStatus && targetStatus !== 'inbox';
  const el = openOverlay(`<div class="dialog create-dialog" role="dialog" aria-label="New card">
    <div class="create-head"><span class="create-title">New card</span><span class="mut-sm">lands in ${needsReason ? esc(targetStatus) : 'inbox'}</span></div>
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
        <span class="field-label">Uploads <span class="field-hint-inline">· optional, what the agent starts from</span></span>
        <div class="dropzone compact" id="nc-dropzone">
          ${icons.trayUp(18)}
          <div class="dz-text">
            <span class="dz-main">Drop files, folders or a .zip</span>
            <span class="dz-sub">uploaded when the card is created</span>
          </div>
          <button type="button" class="dz-browse" id="nc-dz-browse">Browse…</button>
          <input type="file" id="nc-dz-input" multiple hidden>
        </div>
        <div id="nc-staged"></div>
      </div>
      <div class="field">
        <span class="field-label">Labels <span class="field-hint-inline">· optional</span></span>
        <div class="labels-input" id="nc-labels"><input id="nc-label-entry" type="text" placeholder="add label…" autocomplete="off"></div>
      </div>
      ${
        needsReason
          ? `<div class="field">
              <span class="field-label">Reason <span class="req-note">· required for the move to ${esc(targetStatus)}</span></span>
              <input id="nc-reason" type="text" placeholder="Why does it start in ${esc(targetStatus)}?" autocomplete="off">
              <span id="nc-reason-error" class="field-error" hidden>${icons.alert()}<span></span></span>
            </div>`
          : ''
      }
      <div class="create-actions">
        <button type="button" id="nc-create" class="btn-dark" disabled>Create card</button>
        <button type="button" id="nc-cancel" class="btn-ghost">Cancel</button>
        <span class="create-note">status: inbox${needsReason ? ` → ${esc(targetStatus)}` : ''} · owner: human</span>
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
  const reasonInput = el.querySelector('#nc-reason');

  // Board and move-reason are validated here (both are UI constructs); the
  // empty-title error comes from the API so its exact message is shown.
  const validate = () => (create.disabled = !board.value || (needsReason && !reasonInput.value.trim()));
  validate();
  if (reasonInput) reasonInput.oninput = validate;
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
  // Staged uploads: kept local until the card exists, then one batch POST.
  // Not uploaded yet, so removing a staged file is allowed here.
  const staged = [];
  const dropzone = el.querySelector('#nc-dropzone');
  const dzInput = el.querySelector('#nc-dz-input');
  const stagedWrap = el.querySelector('#nc-staged');
  const renderStaged = (error) => {
    if (!staged.length) {
      stagedWrap.innerHTML = '';
      return;
    }
    const total = staged.reduce((n, f) => n + f.size, 0);
    stagedWrap.innerHTML = `<div class="staged">
      <div class="staged-head"><span class="t">${staged.length} file${staged.length === 1 ? '' : 's'} staged</span><span class="sz">${fmtBytes(total)}</span></div>
      ${staged
        .map(
          (f, i) =>
            `<div class="staged-row"><span class="nm">${esc(f.name)}</span><span class="sz">${fmtBytes(f.size)}</span><button type="button" class="rm" data-i="${i}" aria-label="Remove ${esc(f.name)}">${icons.x(11)}</button></div>`
        )
        .join('')}
      ${error ? `<p class="field-error staged-error">${esc(error)}</p>` : ''}
    </div>`;
    stagedWrap.querySelectorAll('.rm').forEach((b) => {
      b.onclick = () => {
        staged.splice(Number(b.dataset.i), 1);
        renderStaged();
      };
    });
  };
  const stage = (files) => {
    staged.push(...files);
    renderStaged();
  };
  el.querySelector('#nc-dz-browse').onclick = () => dzInput.click();
  dropzone.onclick = (e) => {
    if (e.target === dropzone || e.target.closest('.dz-text')) dzInput.click();
  };
  dzInput.onchange = () => {
    stage([...dzInput.files]);
    dzInput.value = '';
  };
  dropzone.ondragover = (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  };
  dropzone.ondragleave = () => dropzone.classList.remove('over');
  dropzone.ondrop = async (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    stage(await filesFromDrop(e.dataTransfer));
  };

  el.querySelector('#nc-cancel').onclick = closeOverlay;
  create.onclick = async () => {
    if (staged.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024) {
      renderStaged('Too large: max 50 MB per upload batch');
      return;
    }
    let card;
    try {
      card = await api.createCard(board.value, {
        type,
        title: title.value,
        body: el.querySelector('#nc-body').value.trim() || undefined,
        labels: labels.length ? labels : undefined,
      });
    } catch (err) {
      title.classList.add('invalid');
      titleError.querySelector('span:last-child').textContent = err.message;
      titleError.hidden = false;
      return;
    }
    if (needsReason) {
      try {
        card = await api.move(card.id, targetStatus, reasonInput.value.trim());
      } catch (err) {
        const reasonError = el.querySelector('#nc-reason-error');
        reasonError.querySelector('span:last-child').textContent = `Created ${card.id} in inbox, but the move failed: ${err.message}`;
        reasonError.hidden = false;
        return;
      }
    }
    if (staged.length) {
      // Card exists either way — on failure just navigate; the card's own
      // uploads block shows what did or did not arrive.
      try {
        await api.uploadFiles(card.id, staged);
      } catch (err) {
        console.error(`Upload after creating ${card.id} failed:`, err);
      }
    }
    closeOverlay();
    onCreated(card);
  };
  title.focus();
}

/* ---------- create board dialog ---------- */

// Live slug suggestion from the name: lowercase, spaces → dashes, invalid
// chars dropped. Typing in the slug field stops the auto-suggest.
const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

export function openBoardDialog(onCreated) {
  const el = openOverlay(`<div class="dialog create-dialog" role="dialog" aria-label="New board">
    <div class="create-head"><span class="create-title">New board</span></div>
    <div class="create-body">
      <div class="field">
        <span class="field-label">Name</span>
        <input id="nb-name" type="text" placeholder="Client or project name" autocomplete="off">
      </div>
      <div class="field">
        <span class="field-label">Slug <span class="field-hint-inline">· lowercase letters, digits, dashes</span></span>
        <input id="nb-slug" type="text" class="mono" autocomplete="off" spellcheck="false">
        <span id="nb-error" class="field-error" hidden>${icons.alert()}<span></span></span>
      </div>
      <div class="create-actions">
        <button type="button" id="nb-create" class="btn-dark" disabled>Create board</button>
        <button type="button" id="nb-cancel" class="btn-ghost">Cancel</button>
      </div>
    </div>
  </div>`);

  const name = el.querySelector('#nb-name');
  const slug = el.querySelector('#nb-slug');
  const create = el.querySelector('#nb-create');
  const error = el.querySelector('#nb-error');

  let slugTouched = false;
  const clearError = () => {
    error.hidden = true;
    slug.classList.remove('invalid');
    create.disabled = !slug.value.trim();
  };
  name.oninput = () => {
    if (!slugTouched) slug.value = slugify(name.value);
    clearError();
  };
  slug.oninput = () => {
    slugTouched = true;
    clearError();
  };
  el.querySelector('#nb-cancel').onclick = closeOverlay;
  create.onclick = async () => {
    try {
      const board = await api.createBoard(slug.value.trim(), name.value.trim() || undefined);
      closeOverlay();
      onCreated(board);
    } catch (err) {
      slug.classList.add('invalid');
      error.querySelector('span:last-child').textContent = err.message;
      error.hidden = false;
    }
  };
  name.focus();
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
