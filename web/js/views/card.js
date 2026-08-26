// Card detail: body, chips, artifacts, timeline, composer, properties panel.
import { api } from '../api.js';
import { icons, statusIcon } from '../icons.js';
import { esc, relTime, absTime, fmtBytes, filesFromDrop, renderMarkdown, CARD_ID_RE } from '../util.js';
import {
  idChip,
  statusPill,
  labelChips,
  externalRefs,
  cardRefs,
  cardRefChip,
  moveWithReason,
  openStatusMenu,
  crumb,
} from '../components.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

// One poll loop at most, only while a card detail is open; the router
// stops it on every route change.
let pollTimer = null;
export function stopCardPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function eventLine(e) {
  const soft = (t) => `<span class="soft">${t}</span>`;
  const when = `<span class="soft" title="${esc(absTime(e.created_at))}">· ${esc(relTime(e.created_at))}</span>`;
  let icon;
  let text;
  if (e.kind === 'status_changed') {
    icon = statusIcon(e.payload.to ?? 'ready', 14);
    text = `<span class="kind">status_changed</span> by ${esc(e.actor)}: ${esc(e.payload.from)} → ${esc(e.payload.to)} ${soft(`(${esc(e.payload.reason ?? '')})`)}`;
  } else if (e.kind === 'context_written') {
    icon = icons.fileText(14, 'var(--green-icon)');
    const diffLink = e.payload.commit ? ` <a href="#" class="diff-toggle" data-commit="${esc(e.payload.commit)}">view diff</a>` : '';
    text = `<span class="kind">context_written</span> by ${esc(e.actor)}: ${esc(e.payload.path)} ${soft(`(${esc(e.payload.message ?? '')})`)}${diffLink}`;
  } else if (e.kind === 'upload_added') {
    icon = icons.uploadArrow(14);
    text = `<span class="kind">upload_added</span> by ${esc(e.actor)}: ${esc(e.payload.name)} ${soft(`(${fmtBytes(e.payload.bytes ?? 0)})`)}`;
  } else if (e.kind === 'secret_stored') {
    icon = icons.lock(14, 'var(--green-icon)');
    text = `<span class="kind">secret_stored</span> by ${esc(e.actor)}: ${esc(String(e.payload.name ?? '').toLowerCase())} ${soft('— value write-only')}`;
  } else if (e.kind === 'blocker_added') {
    icon = icons.block(14);
    const b = String(e.payload.blocker ?? '');
    text = `<span class="kind">blocker_added</span> by ${esc(e.actor)}: blocked by <a href="#/card/${esc(b)}">${esc(b)}</a>`;
  } else {
    const note = String(e.payload.note ?? JSON.stringify(e.payload));
    const m = note.match(/^(.*?)(WAITING:.*)$/s);
    const body = m ? `${esc(m[1])}<span class="waiting">${esc(m[2])}</span>` : esc(note);
    icon = e.kind === 'error' ? icons.alert(14) : m ? icons.clock(14) : icons.arrowDown(14);
    text = `<span class="kind">${esc(e.kind)}</span> by ${esc(e.actor)}: ${body}`;
  }
  return `<div class="event-row">${icon}<p>${text} ${when}</p></div>`;
}

// Patch text → escaped lines with simple +green/-red colouring.
function diffHtml(diff) {
  return diff
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    })
    .join('\n');
}

function commentCard(c) {
  const agent = c.author === 'agent';
  // Only the author edits; the UI user is the human, so agent comments get no pencil.
  return `<div class="comment-card${agent ? ' agent' : ''}" data-cid="${c.id}">
    <div class="cc-head">
      <span class="cc-avatar${agent ? ' agent' : ''}">${agent ? icons.bot(12) : icons.user(12)}</span>
      <span class="cc-name">${agent ? 'agent' : 'you'}</span>
      <span class="cc-when" title="${esc(absTime(c.created_at))}">${esc(relTime(c.created_at))}</span>
      ${c.updated_at ? `<span class="cc-edited" title="${esc(absTime(c.updated_at))}">(edited)</span>` : ''}
      ${agent ? '' : `<button type="button" class="cc-edit" title="Edit comment">${icons.pencil(12)}</button>`}
    </div>
    <p class="cc-body">${esc(c.body)}</p>
  </div>`;
}

function fileRow(cardId, f, urlFn) {
  const icon = /\.zip$/i.test(f.name) ? icons.folderDown() : IMAGE_EXT.test(f.name) ? icons.image() : icons.fileText(14);
  return `<div class="art-row">
    ${icon}
    <a href="${urlFn(cardId, f.name)}" target="_blank" rel="noopener">${esc(f.name)}</a>
    <span class="size">${fmtBytes(f.bytes)}</span>
    <span class="when" title="${esc(absTime(f.mtime))}">${esc(relTime(f.mtime))}</span>
  </div>`;
}

function relStatusNote(card) {
  if (card.status === 'review') return `<p class="rs review">in review — ready for your approval</p>`;
  if (card.status === 'needs_input') return `<p class="rs needs_input">in needs_input — waiting on you</p>`;
  return `<p class="rs">in ${esc(card.status)}</p>`;
}

export async function renderCard(root, { boards, cardId }) {
  const rerender = () => renderCard(root, { boards, cardId });
  const [{ card, comments, events, blockers = [], blocks = [] }, { artifacts }, { uploads }] = await Promise.all([
    api.card(cardId),
    api.artifacts(cardId),
    api.uploads(cardId),
  ]);
  card.blockers = blockers;
  const board = boards.find((b) => b.id === card.board_id);

  // Linked cards: structural blocked_by/blocks first, ref-labeled cards as
  // the manual fallback (deduped) — the query is the source of truth.
  const groups = { 'blocked by': [...blockers], unblocks: [...blocks], linked: [] };
  const linked = cardRefs(card);
  const seen = new Set([...blockers, ...blocks].map((t) => t.id));
  await Promise.all(
    linked.map(async (ref) => {
      const target = ref.label.match(CARD_ID_RE)[0];
      if (seen.has(target)) return;
      try {
        const { card: t } = await api.card(target);
        const key = /^blocked/i.test(ref.label) ? 'blocked by' : /^unblocks/i.test(ref.label) ? 'unblocks' : 'linked';
        groups[key].push(t);
      } catch {
        /* dangling ref: skip */
      }
    })
  );

  // Ops card in review: surface what was written to the context layer.
  const written = new Map();
  for (const e of events) if (e.kind === 'context_written') written.set(e.payload.path, e.payload.action ?? 'update');
  const showWritten = card.type === 'ops' && card.status === 'review' && written.size > 0;
  let secretRefs = [];
  if (showWritten) {
    try {
      const file = await api.ctxFile([...written.keys()].at(-1));
      const raw = file.frontmatter?.secret_ref;
      secretRefs = Array.isArray(raw) ? raw : raw ? [raw] : [];
    } catch {
      /* file may be gone */
    }
  }

  // Secrets are write-only; the UI only ever knows names, via the events.
  const storedSecrets = [
    ...new Set(events.filter((e) => e.kind === 'secret_stored').map((e) => String(e.payload.name ?? '').toLowerCase())),
  ];
  const requestedSecrets = (card.body?.match(/^secret_ref:\s*(.+)$/m)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Only when the agent asked (a secret_ref line in the body) — an ops
  // card without a request gets no intake form.
  const showSecretIntake =
    card.type === 'ops' && card.status !== 'done' && card.status !== 'archived' && requestedSecrets.length > 0;
  const canUpload = card.status !== 'done' && card.status !== 'archived';

  const timeline = [
    ...comments.map((c) => ({ at: c.created_at, kind: 'comment', author: c.author, html: commentCard(c) })),
    ...events.map((e) => ({ at: e.created_at, kind: 'event', author: e.actor, html: eventLine(e) })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  // Fact, not activity claim: input lies ready for the agent. Derived from
  // the timeline alone — the human has the last word, or the card is ready.
  const last = timeline.at(-1);
  const queued =
    card.status !== 'done' &&
    card.status !== 'archived' &&
    (card.status === 'ready' || (last?.kind === 'comment' && last.author === 'human'));

  const quick = [];
  if (card.status === 'inbox') quick.push({ label: 'Ready', cls: 'btn-dark', to: 'ready', icon: icons.arrowRight(14, '#fff') });
  if (card.status === 'needs_input') quick.push({ label: 'Send back to doing', cls: 'btn-amber', to: 'doing', icon: icons.arrowRight(14) });
  if (card.status === 'review') {
    quick.push({ label: 'Approve → Done', cls: 'btn-green', to: 'done', icon: icons.check(14) });
    quick.push({ label: 'Request changes', cls: 'btn-ghost', to: 'doing' });
  }
  const canArchive = card.status !== 'archived';

  root.innerHTML = `
    ${crumb([
      { text: board?.name ?? card.board_id, href: `#/board/${esc(card.board_id)}` },
      { text: card.id, mono: true },
      { text: card.title, strong: true },
    ])}
    <div class="m-cardhead">
      <a href="#/board/${esc(card.board_id)}">${icons.chevronLeft()}</a>
      <span class="cid">${esc(card.id)}</span>
      ${statusPill(card.status, { id: 'm-status-pill', chevron: true })}
    </div>
    <div class="detail">
      <div class="detail-main">
        <div class="detail-scroll detail-page-with-bar"><div class="detail-inner">
          ${
            card.type === 'ops'
              ? `<div class="ops-line"><span class="ops-badge">${icons.sliders(12)}ops card</span><span class="mut-sm" style="font-size:12px">the system asking for something it needs</span></div>`
              : ''
          }
          <h1>${esc(card.title)}</h1>
          ${card.body ? `<div class="detail-body">${renderMarkdown(card.body)}</div>` : ''}
          ${
            card.context_refs?.length || linked.length || blockers.length || card.routine
              ? `<div class="chip-row">
                  ${card.routine ? `<span class="routine-chip lg" title="${esc(card.routine)}">${icons.history(11)}routine</span>` : ''}
                  ${blockers
                    .map((b) => {
                      const open = b.status !== 'done' && b.status !== 'archived';
                      return `<a class="blocker-chip${open ? '' : ' resolved'}" href="#/card/${esc(b.id)}">${
                        open ? icons.block(11) : icons.check(11, 'var(--green-icon)')
                      }${esc(b.id)}</a>`;
                    })
                    .join('')}
                  ${(card.context_refs ?? []).map((p) => `<a class="ctx-chip" href="#/ctx/${esc(p)}">${icons.file()}${esc(p)}</a>`).join('')}
                  ${linked.map((r) => cardRefChip(r)).join('')}
                </div>`
              : ''
          }
          ${
            externalRefs(card).length
              ? `<div class="refs-row"><span class="refs-label">Refs</span>
                  ${externalRefs(card)
                    .map((r) => `<a class="ext-chip" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.label ?? r.url)}${icons.external()}</a>`)
                    .join('')}
                  <span class="refs-note">reachable through the context chain</span>
                </div>`
              : ''
          }
          ${
            showWritten
              ? `<div class="written-block">
                  <div class="wb-head">${icons.check(14, 'var(--green-icon)')}<span>Written to the context layer — approve ${written.size === 1 ? 'this file' : 'these files'} to finish the card</span></div>
                  <div class="wb-chips">
                    ${[...written]
                      .map(([p, action]) => `<a class="written-file" href="#/ctx/${esc(p)}">${icons.fileText()}${esc(p)}<span class="new">${action === 'add' ? 'new' : 'updated'}</span></a>`)
                      .join('')}
                    ${secretRefs.length ? `<span class="secret-chip">${icons.lock(12)}secret_ref: ${esc(secretRefs.join(', '))}</span>` : ''}
                  </div>
                </div>`
              : ''
          }
          <div class="files-wrap">
            ${
              canUpload || uploads.length
                ? `<div class="artifacts">
                    <div class="art-headwrap">
                      <div class="art-head">${icons.uploadArrow()}<span class="t">Uploads</span><span class="p">uploads/${esc(card.id)}/</span><span class="n">${uploads.length} file${uploads.length === 1 ? '' : 's'}</span></div>
                      <p class="art-cap">what went in — you → agent</p>
                    </div>
                    ${
                      canUpload
                        ? `<div class="dropzone${card.type === 'ops' ? ' compact' : ''}" id="dropzone">
                            ${icons.trayUp(card.type === 'ops' ? 18 : 20)}
                            <div class="dz-text">
                              <span class="dz-main">Drop files, folders or a .zip${card.type === 'ops' ? '' : ' here'}</span>
                              <span class="dz-sub">${card.type === 'ops' ? `never for secrets${showSecretIntake ? ' — use the form below' : ''}` : 'multiple files and whole folders are kept as one batch'}</span>
                            </div>
                            <button type="button" class="dz-browse" id="dz-browse">Browse…</button>
                            <input type="file" id="dz-input" multiple hidden>
                          </div>`
                        : ''
                    }
                    <div id="staged-wrap"></div>
                    ${uploads.map((f) => fileRow(card.id, f, api.uploadUrl)).join('')}
                  </div>`
                : ''
            }
            ${
              artifacts.length
                ? `<div class="artifacts">
                    <div class="art-headwrap">
                      <div class="art-head">${icons.archive()}<span class="t">Artifacts</span><span class="p">artifacts/${esc(card.id)}/</span><span class="n">${artifacts.length} file${artifacts.length === 1 ? '' : 's'}</span></div>
                      <p class="art-cap">what came out — agent → you · read-only</p>
                    </div>
                    ${artifacts.map((a) => fileRow(card.id, a, api.artifactUrl)).join('')}
                  </div>`
                : ''
            }
          </div>
          <div class="detail-sep"></div>
          <div class="tl-head"><span class="t">Timeline</span>
            <div class="tl-filters">
              <button type="button" class="tl-filter active" data-filter="all">All</button>
              <button type="button" class="tl-filter" data-filter="comment">Comments</button>
              <button type="button" class="tl-filter" data-filter="event">Events</button>
            </div>
          </div>
          ${
            showSecretIntake
              ? `<div class="secret-box">
                  <div class="sb-head">
                    <span class="cc-avatar agent">${icons.bot(12)}</span><span class="t">agent asks for ${requestedSecrets.length} secret${requestedSecrets.length === 1 ? '' : 's'}</span>
                    <span class="sb-req">${icons.clock(11)}action required</span>
                  </div>
                  <div class="sb-chips">
                    ${requestedSecrets
                      .map((n) =>
                        storedSecrets.includes(n)
                          ? `<span class="sb-stored">${esc(n)}<span class="ok">stored</span></span>`
                          : `<button type="button" class="sb-prefill" data-name="${esc(n)}">${esc(n)}</button>`
                      )
                      .join('')}
                    ${storedSecrets
                      .filter((n) => !requestedSecrets.includes(n))
                      .map((n) => `<span class="sb-stored">${esc(n)}<span class="ok">stored</span></span>`)
                      .join('')}
                  </div>
                  <div class="sb-row">
                    <div class="sb-f"><span>name</span><input id="sec-name" class="mono" autocomplete="off" spellcheck="false" placeholder="e.g. ssh_acme_web"></div>
                    <div class="sb-f value"><span>value</span><input id="sec-value" type="password" autocomplete="new-password" placeholder="Paste or type the value"></div>
                    <button type="button" class="sb-keyfile" id="sec-file-btn">${icons.file(12)}<span>or a key file</span></button>
                    <input type="file" id="sec-file" hidden>
                  </div>
                  <div class="sb-actions">
                    <button type="button" id="sec-store" class="btn-dark">${icons.lock(13, '#fff')}Store secret</button>
                    <span id="sec-error" class="field-error" hidden>${icons.alert()}<span></span></span>
                    <span class="sb-note">${icons.lock(11)}write-only · same name overwrites</span>
                  </div>
                </div>`
              : ''
          }
          <div class="timeline" id="timeline-list">${timeline.map((t) => t.html).join('') || '<p class="mut-sm">Nothing yet.</p>'}</div>
          ${
            queued
              ? `<div class="event-row queued-line">${statusIcon('ready', 14, 'var(--mut-2)')}${icons.bot(14, 'var(--mut-2)')}<p>Queued for the agent — picked up at the next agent session.</p></div>`
              : ''
          }
        </div>
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="comment-input" rows="1" placeholder="${card.status === 'needs_input' ? 'Answer the agent…' : 'Add a comment…'}"></textarea>
            <div class="composer-actions">
              <button type="button" id="comment-send" class="btn-dark">Comment</button>
              <div class="spacer">
                ${quick.map((q, i) => `<button type="button" class="${q.cls}" data-move="${q.to}" data-q="${i}">${q.icon ?? ''}${esc(q.label)}</button>`).join('')}
                ${canArchive ? `<button type="button" class="btn-ghost" data-move="archived">${icons.archive()}Archive</button>` : ''}
              </div>
            </div>
          </div>
          <p class="reason-hint">Every status change asks for a short reason — it is written to the timeline as an event.</p>
        </div>
        </div>
      </div>
      <div class="props">
        <span class="p-title">Properties</span>
        <div class="prop-row"><span class="k">Type</span><span class="v">${card.type === 'ops' ? icons.sliders(14) : icons.fileText(14)}${esc(card.type)}</span></div>
        <div class="prop-row"><span class="k">Status</span><span class="v" id="status-pill-wrap">${statusPill(card.status, { chevron: true })}</span></div>
        <div class="prop-row"><span class="k">Owner</span><span class="v">${card.owner === 'agent' ? icons.bot(14) : icons.user(14, 'var(--mut)')}${esc(card.owner)}</span></div>
        <div class="prop-row"><span class="k">Board</span><span class="v">${esc(board?.name ?? card.board_id)}</span></div>
        ${card.labels?.length ? `<div class="prop-row top"><span class="k">Labels</span><span class="v">${labelChips(card.labels)}</span></div>` : ''}
        <div class="prop-row"><span class="k">Updated</span><span class="v plain" title="${esc(absTime(card.updated_at))}">${esc(relTime(card.updated_at))}</span></div>
        ${
          storedSecrets.length
            ? `<div class="sep"></div>
               <span class="rel-heading">SECRETS <span class="secrets-sub">${storedSecrets.length} · local vault</span></span>
               ${storedSecrets.map((n) => `<span class="secret-name-chip">${icons.lock(11, 'var(--green-icon)')}${esc(n)}</span>`).join('')}
               <span class="secrets-sub">names only — no view, no copy, no edit</span>`
            : ''
        }
        ${['blocked by', 'unblocks', 'linked']
          .filter((k) => groups[k].length)
          .map(
            (k) => `<div class="sep"></div><span class="rel-heading">${k.toUpperCase()}</span>
              ${groups[k]
                .map(
                  (t) => `<a class="rel-card" href="#/card/${esc(t.id)}">${idChip(t)}<p class="rt">${esc(t.title)}</p>${relStatusNote(t)}</a>`
                )
                .join('')}`
          )
          .join('')}
      </div>
    </div>
    <div class="m-actionbar">
      ${
        card.status === 'review'
          ? `<button type="button" class="m-primary" data-move="done">${icons.check(18)}Approve → Done</button>`
          : card.status === 'inbox'
            ? `<button type="button" class="m-primary dark" data-move="ready">${icons.arrowRight(16, '#fff')}Ready</button>`
            : card.status === 'needs_input'
              ? `<button type="button" class="m-primary amber" data-move="doing">${icons.arrowRight(16, '#fff')}Send back to doing</button>`
              : `<button type="button" class="m-primary dark" id="m-change-status">Change status</button>`
      }
      <div class="m-secondary">
        <button type="button" id="m-comment">Comment</button>
        ${canArchive ? `<button type="button" data-move="archived">Archive</button>` : ''}
      </div>
    </div>
  `;

  const tlList = root.querySelector('#timeline-list');
  root.querySelectorAll('.tl-filter').forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll('.tl-filter').forEach((x) => x.classList.toggle('active', x === b));
      const items = b.dataset.filter === 'all' ? timeline : timeline.filter((t) => t.kind === b.dataset.filter);
      tlList.innerHTML = items.map((t) => t.html).join('') || '<p class="mut-sm">Nothing here.</p>';
    };
  });
  // --- comment editing: bare edit, no history — the old text is gone ---
  // Delegated on the list, so the handlers survive the filter re-renders.
  tlList.onclick = async (e) => {
    const cardEl = e.target.closest('.comment-card');
    if (!cardEl) return;
    if (e.target.closest('.cc-edit') && !cardEl.querySelector('.cc-editor')) {
      const comment = comments.find((x) => x.id === Number(cardEl.dataset.cid));
      cardEl.querySelector('.cc-body').hidden = true;
      const editor = document.createElement('div');
      editor.className = 'cc-editor';
      editor.innerHTML = `<textarea rows="3"></textarea>
        <div class="cc-editor-actions">
          <button type="button" class="btn-dark cc-save">Save</button>
          <button type="button" class="btn-ghost cc-cancel">Cancel</button>
          <span class="field-error" hidden>${icons.alert()}<span></span></span>
        </div>`;
      editor.querySelector('textarea').value = comment.body;
      cardEl.append(editor);
      editor.querySelector('textarea').focus();
    } else if (e.target.closest('.cc-cancel')) {
      cardEl.querySelector('.cc-editor').remove();
      cardEl.querySelector('.cc-body').hidden = false;
    } else if (e.target.closest('.cc-save')) {
      try {
        await api.editComment(cardEl.dataset.cid, cardEl.querySelector('.cc-editor textarea').value);
        rerender();
      } catch (err) {
        const error = cardEl.querySelector('.field-error');
        error.querySelector('span:last-child').textContent = err.message;
        error.hidden = false;
      }
    }
  };
  // Delegated so the links keep working after a filter re-render.
  tlList.addEventListener('click', async (ev) => {
    const link = ev.target.closest('.diff-toggle');
    if (!link) return;
    ev.preventDefault();
    const row = link.closest('.event-row');
    const open = row.nextElementSibling;
    if (open?.classList.contains('diff-block')) {
      open.remove();
      return;
    }
    let body;
    try {
      body = diffHtml((await api.ctxDiff(link.dataset.commit)).diff);
    } catch (err) {
      body = esc(err.message);
    }
    row.insertAdjacentHTML('afterend', `<pre class="diff-block">${body}</pre>`);
  });
  root.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => moveWithReason(card, b.dataset.move, rerender)));
  const pill = root.querySelector('#status-pill-wrap .status-pill');
  if (pill) pill.onclick = () => openStatusMenu(card, rerender, pill);
  const mPill = root.querySelector('#m-status-pill');
  if (mPill) mPill.onclick = () => openStatusMenu(card, rerender);
  const mChange = root.querySelector('#m-change-status');
  if (mChange) mChange.onclick = () => openStatusMenu(card, rerender);
  const input = root.querySelector('#comment-input');
  root.querySelector('#comment-send').onclick = async () => {
    if (!input.value.trim()) return;
    await api.comment(card.id, input.value.trim());
    await rerender();
    const items = root.querySelectorAll('.comment-card');
    const posted = items[items.length - 1];
    if (posted) {
      posted.scrollIntoView({ behavior: 'smooth', block: 'center' });
      posted.classList.add('flash');
    }
  };
  const mComment = root.querySelector('#m-comment');
  if (mComment)
    mComment.onclick = () => {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus();
    };

  // --- uploads: stage locally, then one batch POST ---
  const staged = [];
  const dropzone = root.querySelector('#dropzone');
  if (dropzone) {
    const dzInput = root.querySelector('#dz-input');
    const stagedWrap = root.querySelector('#staged-wrap');
    const renderStaged = (error) => {
      if (!staged.length) {
        stagedWrap.innerHTML = '';
        return;
      }
      const total = staged.reduce((n, f) => n + f.size, 0);
      stagedWrap.innerHTML = `<div class="staged">
        <div class="staged-head"><span class="t">${staged.length} file${staged.length === 1 ? '' : 's'} staged</span><span class="sz">${fmtBytes(total)}</span></div>
        ${staged.map((f) => `<div class="staged-row"><span class="nm">${esc(f.name)}</span><span class="sz">${fmtBytes(f.size)}</span></div>`).join('')}
        <div class="staged-actions">
          <button type="button" id="upload-batch" class="btn-dark sm">Upload batch</button>
          <span class="hint">uploads are permanent — a wrong file is superseded, never deleted</span>
        </div>
        ${error ? `<p class="field-error staged-error">${esc(error)}</p>` : ''}
      </div>`;
      stagedWrap.querySelector('#upload-batch').onclick = async () => {
        if (staged.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024) {
          renderStaged('Too large: max 50 MB per upload batch');
          return;
        }
        try {
          await api.uploadFiles(card.id, staged);
          staged.length = 0;
          rerender();
        } catch (err) {
          renderStaged(err.message);
        }
      };
    };
    const stage = (files) => {
      staged.push(...files);
      renderStaged();
    };
    root.querySelector('#dz-browse').onclick = () => dzInput.click();
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
  }

  // --- secret intake: write-only, value cleared the moment it is submitted ---
  const secName = root.querySelector('#sec-name');
  const secValue = root.querySelector('#sec-value');
  if (secName) {
    const secFile = root.querySelector('#sec-file');
    const secError = root.querySelector('#sec-error');
    let keyFile = null;
    root.querySelectorAll('.sb-prefill').forEach((b) => {
      b.onclick = () => {
        secName.value = b.dataset.name;
        (keyFile ? secName : secValue).focus();
      };
    });
    root.querySelector('#sec-file-btn').onclick = () => secFile.click();
    secFile.onchange = () => {
      keyFile = secFile.files[0] ?? null;
      secValue.value = '';
      secValue.disabled = !!keyFile;
      secValue.placeholder = keyFile ? `key file: ${keyFile.name}` : 'Paste or type the value';
      secFile.value = '';
    };
    root.querySelector('#sec-store').onclick = async () => {
      const name = secName.value.trim();
      let value;
      let encoding;
      if (keyFile) {
        const bytes = new Uint8Array(await keyFile.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        value = btoa(bin);
        encoding = 'base64';
      } else {
        value = secValue.value;
      }
      // The value leaves the fields before the request even settles.
      secValue.value = '';
      secValue.disabled = false;
      secValue.placeholder = 'Paste or type the value';
      keyFile = null;
      secError.hidden = true;
      try {
        await api.storeSecret(card.id, { name, value, encoding });
        rerender();
      } catch (err) {
        secError.querySelector('span:last-child').textContent = err.message;
        secError.hidden = false;
      }
    };
  }

  // Light liveness: poll the card every 30s, rerender only on a real change
  // (fingerprint), and never while the composer has focus or text — a
  // pending change waits for blur/empty. Composer text survives a rerender.
  const fingerprint = (d) =>
    `${d.card.updated_at}|${d.comments.length}|${d.events.length}|${
      [...d.comments, ...d.events].map((x) => x.created_at).sort().at(-1) ?? ''
    }`;
  const shownFp = fingerprint({ card, comments, events });
  let changePending = false;
  // Half-typed secrets, staged files and an open comment editor block a
  // background rerender too.
  const dirty = () =>
    staged.length > 0 ||
    !!root.querySelector('.cc-editor') ||
    [input, secName, secValue].some((el) => el && (document.activeElement === el || el.value.trim()));
  const tryRefresh = async () => {
    if (!changePending) return;
    if (dirty()) return;
    const saved = input.value;
    const scroller = root.querySelector('.detail-scroll');
    const savedScroll = { pane: scroller?.scrollTop ?? 0, win: window.scrollY };
    await rerender();
    const freshScroller = root.querySelector('.detail-scroll');
    if (freshScroller) freshScroller.scrollTop = savedScroll.pane;
    window.scrollTo(0, savedScroll.win);
    const fresh = root.querySelector('#comment-input');
    if (fresh && saved) fresh.value = saved;
  };
  input.addEventListener('blur', tryRefresh);
  stopCardPolling();
  pollTimer = setInterval(async () => {
    try {
      if (fingerprint(await api.card(cardId)) !== shownFp) changePending = true;
    } catch {
      /* server hiccup — try again next tick */
    }
    tryRefresh();
  }, 30000);
}
