// Small shared helpers: escaping, time formatting, a markdown mini-renderer.

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const SHORT_DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const TZ_FMT = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' });

// "20 Aug 2026 · 08:05 CEST" — used in title tooltips.
export function absTime(iso) {
  const d = new Date(iso);
  const tz = TZ_FMT.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${DATE_FMT.format(d)} · ${TIME_FMT.format(d)} ${tz}`.trim();
}

export function shortDate(iso) {
  return SHORT_DATE_FMT.format(new Date(iso));
}

// "just now", "12 min ago", "3h ago", "2d ago", then a date.
export function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return shortDate(iso);
}

// Compact age for the chips on needs_input/review cards: "45m", "3h", "2d".
export function ageShort(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function inline(md) {
  return esc(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Minimal markdown: headings, lists, code fences, paragraphs, inline marks.
export function renderMarkdown(md) {
  const out = [];
  const lines = String(md ?? '').split('\n');
  let para = [];
  let list = null;
  let fence = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const line of lines) {
    if (fence !== null) {
      if (line.startsWith('```')) {
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      fence = [];
    } else if (/^#{1,4} /.test(line)) {
      flush();
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level + 2}>${inline(line.slice(level + 1))}</h${level + 2}>`);
    } else if (/^[-*] /.test(line)) {
      if (para.length) flush();
      (list ??= []).push(line.slice(2));
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line);
    }
  }
  if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  flush();
  return out.join('');
}

export const CARD_ID_RE = /\b(task|ops)_[0-9a-f]+\b/;

export function isMobile() {
  return window.matchMedia('(max-width: 720px)').matches;
}
