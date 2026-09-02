// Session detail (design 2f right): header + flat steps. A running session
// tails live via the global poller — append-only, so open <details> stay
// open and scroll is never yanked. Finished sessions render once, static.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime, absTime } from '../util.js';
import { crumb } from '../components.js';
import { triggerLabel } from './sessions.js';

const STEP_ICON = { text: 'fileText', tool: 'sliders', result: 'arrowDown', raw: 'alert' };

let refreshHook = null;
let cleanup = null; // removes the follow scroll-listeners of the previous render
export function stopSessionPolling() {
  refreshHook = null;
  cleanup?.();
  cleanup = null;
}
export function pokeSessionRefresh() {
  return refreshHook?.();
}

const stepHtml = (s) => {
  const reasoning = s.label.startsWith('reasoning ·');
  const icon = icons[STEP_ICON[s.type]] ? icons[STEP_ICON[s.type]](13) : '';
  if (reasoning)
    return `<details class="step reasoning"><summary>${icon}<em>${esc(s.label)}</em></summary><pre>${esc(s.detail)}</pre></details>`;
  return `<details class="step ${s.type}"><summary>${icon}<span class="step-type">${esc(s.type)}</span> ${esc(s.label)}</summary><pre>${esc(s.detail)}</pre></details>`;
};

export async function renderSession(root, { id }) {
  stopSessionPolling();
  const { session, steps, observation, tail } = await api.session(id);
  const live = session.live === true; // annotated by the API: open row + confirmed lock
  const dur =
    session.ended_at !== null
      ? `${Math.max(1, Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 1000))}s`
      : live
        ? 'running'
        : '—';
  const outcome =
    session.ended_at === null
      ? live
        ? 'running'
        : 'ended early (crash)'
      : session.exit_status === 0
        ? 'completed'
        : `ended early (${session.exit_status ?? 'crash'})`;
  root.innerHTML = `
    ${crumb([{ text: 'Agentboard', href: '#/' }, { text: `session #${session.id}`, strong: true }])}
    <div class="session-head">
      <span class="rt-sched">${esc(triggerLabel(session.trigger))}</span>
      <span class="mut-sm" title="${esc(absTime(session.started_at))}">${esc(relTime(session.started_at))} · ${esc(dur)} · <span id="s-outcome">${esc(outcome)}</span></span>
      ${session.cards.map((c) => `<a class="cardref-chip" href="#/card/${esc(c)}">${esc(c)}</a>`).join('')}
      ${live ? `<span class="al-live" id="s-live"><span class="live-dot"></span><span id="s-beat">live</span></span>
      <button type="button" class="follow-btn on" id="s-follow">follow</button>` : ''}
    </div>
    <div class="session-steps" id="s-steps">
      ${steps.map(stepHtml).join('') || '<p class="mut-sm">Empty transcript.</p>'}
    </div>
    ${observation ? `<div class="observation"><h3>Observation</h3><pre>${esc(observation)}</pre></div>` : ''}`;
  if (!live) return;

  let cursor = { offset: tail.offset, n: tail.n };
  let follow = true;
  let lastStepAt = Date.now();
  const list = root.querySelector('#s-steps');
  const followBtn = root.querySelector('#s-follow');
  followBtn.onclick = () => {
    follow = !follow;
    followBtn.classList.toggle('on', follow);
    if (follow) list.lastElementChild?.scrollIntoView({ block: 'end' });
  };
  // Scrolling up is an implicit "stop following"; the button turns it back on.
  // #view is the real scroll container (design's per-view scroll pattern,
  // same as card.js's .detail-scroll) — an at-bottom check means the
  // programmatic scrollIntoView above never disables follow (it lands at the
  // bottom, so this is a no-op) while a user scrolling up does.
  const scroller = document.getElementById('view');
  const onScroll = () => {
    if (follow && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 40) {
      follow = false;
      followBtn.classList.remove('on');
    }
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  cleanup = () => scroller.removeEventListener('scroll', onScroll);

  refreshHook = async () => {
    const r = await api.sessionSteps(id, cursor.offset, cursor.n);
    cursor = { offset: r.offset, n: r.n };
    if (r.steps.length) {
      if (list.firstElementChild?.tagName === 'P') list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', r.steps.map(stepHtml).join(''));
      lastStepAt = Date.now();
      if (follow) list.lastElementChild?.scrollIntoView({ block: 'end' });
    }
    const beat = root.querySelector('#s-beat');
    if (beat) beat.textContent = `live · last step ${Math.max(0, Math.round((Date.now() - lastStepAt) / 1000))}s ago`;
    if (!r.live) {
      // The session ended: one final static render shows duration, exit and
      // the observation block if one appeared.
      stopSessionPolling();
      await renderSession(root, { id });
    }
  };
}
