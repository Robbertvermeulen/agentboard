// Minimal session detail (design 2f right pane): header + flat steps,
// reasoning collapsed by default. The sessions overview/live tail is 4b.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime, absTime } from '../util.js';
import { crumb } from '../components.js';

const STEP_ICON = { text: 'fileText', tool: 'sliders', result: 'arrowDown', raw: 'alert' };

export async function renderSession(root, { id }) {
  const { session, steps } = await api.session(id);
  const dur =
    session.ended_at !== null
      ? `${Math.max(1, Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 1000))}s`
      : 'running';
  const outcome =
    session.ended_at === null ? 'running' : session.exit_status === 0 ? 'completed' : `ended early (${session.exit_status ?? 'crash'})`;
  root.innerHTML = `
    ${crumb([{ text: 'Agentboard', href: '#/' }, { text: `session #${session.id}`, strong: true }])}
    <div class="session-head">
      <span class="rt-sched">${esc(session.trigger)}</span>
      <span class="mut-sm" title="${esc(absTime(session.started_at))}">${esc(relTime(session.started_at))} · ${esc(dur)} · ${esc(outcome)}</span>
      ${session.cards.map((c) => `<a class="cardref-chip" href="#/card/${esc(c)}">${esc(c)}</a>`).join('')}
    </div>
    <div class="session-steps">
      ${steps
        .map((s) => {
          const reasoning = s.label.startsWith('reasoning ·');
          const icon = icons[STEP_ICON[s.type]] ? icons[STEP_ICON[s.type]](13) : '';
          if (reasoning)
            return `<details class="step reasoning"><summary>${icon}<em>${esc(s.label)}</em></summary><pre>${esc(s.detail)}</pre></details>`;
          return `<details class="step ${s.type}"><summary>${icon}<span class="step-type">${esc(s.type)}</span> ${esc(s.label)}</summary><pre>${esc(s.detail)}</pre></details>`;
        })
        .join('') || '<p class="mut-sm">Empty transcript.</p>'}
    </div>`;
}
