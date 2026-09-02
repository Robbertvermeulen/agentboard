// Agent log (design 2f left): 7-day summary tiles + the session list.
// Every number is derived from the session index — nothing is claimed.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, relTime, absTime } from '../util.js';
import { crumb } from '../components.js';

const TRIGGER_LABELS = { cron: 'cron', serve: 'after your action', manual: 'manual', observe: 'observer' };
export const triggerLabel = (t) => TRIGGER_LABELS[t] ?? t;

export const sessionOutcome = (s) => {
  if (s.ended_at === null) return s.live ? { cls: 'live', text: 'running' } : { cls: 'crash', text: 'ended early (crash)' };
  if (s.exit_status === 0) return { cls: 'ok', text: 'completed' };
  return { cls: 'crash', text: `ended early (${s.exit_status ?? 'crash'})` };
};

const durText = (s) =>
  s.ended_at === null
    ? ''
    : `${Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 1000))}s`;

const tile = (n, label) => `<div class="al-tile"><span class="n">${n}</span><span class="lbl">${label}</span></div>`;

export async function renderSessions(root) {
  // Blind re-renders on every realtime tick (no per-view hook here — the
  // whole list is cheap to recompute) would otherwise reset scroll on every
  // poll; read the old wrapper's position before it's replaced and restore
  // it on the new one below. No module state needed — root is the same
  // #view element across renders.
  const prevScroll = root.querySelector('.page-scroll')?.scrollTop ?? 0;
  const { sessions } = await api.sessions();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const week = sessions.filter((s) => s.started_at >= weekAgo);
  const completed = week.filter((s) => s.ended_at !== null && s.exit_status === 0).length;
  const handed = week.reduce((n, s) => n + s.handed_back.length, 0);
  const early = week.length - completed - week.filter((s) => s.live).length;
  // touched stays literal: the observer only read about those cards.
  const cards = new Set(week.filter((s) => s.trigger !== 'observe').flatMap((s) => s.cards)).size;
  root.innerHTML = `
    ${crumb([{ text: 'Agentboard', href: '#/' }, { text: 'Agent log', strong: true }])}
    <div class="page-scroll">
    <div class="al-head"><h2>Agent log</h2><span class="mut-sm">last 7 days</span></div>
    <p class="al-summary">Ran <strong>${week.length}</strong> session${week.length === 1 ? '' : 's'} and touched <strong>${cards}</strong> card${cards === 1 ? '' : 's'} this week. ${completed} completed, ${handed} handed back, ${early} ended early.</p>
    <div class="al-tiles">${tile(week.length, 'sessions')}${tile(completed, 'completed')}${tile(handed, 'handed back')}${tile(early, 'ended early')}</div>
    <div class="al-list">
      ${sessions
        .map((s) => {
          const o = sessionOutcome(s);
          // A row is one big click target (stretched-link: an absolutely
          // positioned cover <a>, since nesting the card links inside a
          // row-level <a> would be invalid HTML) — card ids are real links
          // rendered above that cover link so they stay independently
          // clickable.
          return `<div class="al-row">
            <a class="al-row-link" href="#/session/${s.id}" aria-label="session #${s.id}"></a>
            <span class="al-id">#${s.id}</span>
            <span class="rt-sched">${esc(triggerLabel(s.trigger))}</span>
            ${s.live ? '<span class="al-live"><span class="live-dot"></span>live</span>' : `<span class="mut-sm">${esc(durText(s))}</span>`}
            <span class="al-cards">${s.cards.length ? s.cards.map((c) => `<a class="cardref-chip" href="#/card/${esc(c)}">${esc(c)}</a>`).join(' ') : '—'}</span>
            ${s.handed_back.length ? `<span class="al-handed">${s.handed_back.length} handed back</span>` : ''}
            <span class="al-outcome ${o.cls}">${esc(o.text)}</span>
            ${s.observed ? `<span class="al-eye" title="observed">${icons.check(12, 'var(--mut)')}</span>` : ''}
            <span class="mut-sm" title="${esc(absTime(s.started_at))}">${esc(relTime(s.started_at))}</span>
          </div>`;
        })
        .join('') || '<p class="mut-sm">No sessions yet.</p>'}
    </div>
    </div>`;
  const scroller = root.querySelector('.page-scroll');
  if (scroller) scroller.scrollTop = prevScroll;
}
