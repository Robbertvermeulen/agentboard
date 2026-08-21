// Card detail: body, chips, artifacts, timeline, composer, properties panel.
import { api } from '../api.js';
import { icons, statusIcon } from '../icons.js';
import { esc, relTime, absTime, fmtBytes, renderMarkdown, CARD_ID_RE } from '../util.js';
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
    text = `<span class="kind">context_written</span> by ${esc(e.actor)}: ${esc(e.payload.path)} ${soft(`(${esc(e.payload.message ?? '')})`)}`;
  } else {
    const note = String(e.payload.note ?? JSON.stringify(e.payload));
    const m = note.match(/^(.*?)(WAITING:.*)$/s);
    const body = m ? `${esc(m[1])}<span class="waiting">${esc(m[2])}</span>` : esc(note);
    icon = e.kind === 'error' ? icons.alert(14) : m ? icons.clock(14) : icons.arrowDown(14);
    text = `<span class="kind">${esc(e.kind)}</span> by ${esc(e.actor)}: ${body}`;
  }
  return `<div class="event-row">${icon}<p>${text} ${when}</p></div>`;
}

function commentCard(c) {
  const agent = c.author === 'agent';
  return `<div class="comment-card${agent ? ' agent' : ''}">
    <div class="cc-head">
      <span class="cc-avatar${agent ? ' agent' : ''}">${agent ? icons.bot(12) : icons.user(12)}</span>
      <span class="cc-name">${agent ? 'agent' : 'you'}</span>
      <span class="cc-when" title="${esc(absTime(c.created_at))}">${esc(relTime(c.created_at))}</span>
    </div>
    <p class="cc-body">${esc(c.body)}</p>
  </div>`;
}

function relStatusNote(card) {
  if (card.status === 'review') return `<p class="rs review">in review — ready for your approval</p>`;
  if (card.status === 'needs_input') return `<p class="rs needs_input">in needs_input — waiting on you</p>`;
  return `<p class="rs">in ${esc(card.status)}</p>`;
}

export async function renderCard(root, { boards, cardId }) {
  const rerender = () => renderCard(root, { boards, cardId });
  const [{ card, comments, events }, { artifacts }] = await Promise.all([api.card(cardId), api.artifacts(cardId)]);
  const board = boards.find((b) => b.id === card.board_id);

  // Linked cards from refs, grouped by how the label reads.
  const groups = { 'blocked by': [], unblocks: [], linked: [] };
  const linked = cardRefs(card);
  await Promise.all(
    linked.map(async (ref) => {
      const target = ref.label.match(CARD_ID_RE)[0];
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

  const timeline = [
    ...comments.map((c) => ({ at: c.created_at, kind: 'comment', html: commentCard(c) })),
    ...events.map((e) => ({ at: e.created_at, kind: 'event', html: eventLine(e) })),
  ].sort((a, b) => a.at.localeCompare(b.at));

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
            card.context_refs?.length || linked.length
              ? `<div class="chip-row">
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
          ${
            artifacts.length
              ? `<div class="artifacts">
                  <div class="art-head">${icons.archive()}<span class="t">Artifacts</span><span class="p">artifacts/${esc(card.id)}/</span><span class="n">${artifacts.length} file${artifacts.length === 1 ? '' : 's'}</span></div>
                  ${artifacts
                    .map(
                      (a) => `<div class="art-row">
                        ${IMAGE_EXT.test(a.name) ? icons.image() : icons.fileText(14)}
                        <a href="${api.artifactUrl(card.id, a.name)}" target="_blank" rel="noopener">${esc(a.name)}</a>
                        <span class="size">${fmtBytes(a.bytes)}</span>
                        <span class="when" title="${esc(absTime(a.mtime))}">${esc(relTime(a.mtime))}</span>
                      </div>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          <div class="detail-sep"></div>
          <div class="tl-head"><span class="t">Timeline</span>
            <div class="tl-filters">
              <button type="button" class="tl-filter active" data-filter="all">All</button>
              <button type="button" class="tl-filter" data-filter="comment">Comments</button>
              <button type="button" class="tl-filter" data-filter="event">Events</button>
            </div>
          </div>
          <div class="timeline" id="timeline-list">${timeline.map((t) => t.html).join('') || '<p class="mut-sm">Nothing yet.</p>'}</div>
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
}
