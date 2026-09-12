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

// "just now", "12 min ago", "3h ago", "2d ago", then a date. A future iso
// (e.g. a routine's next run) mirrors the same units as "in 5m"/"in 3h"/"in 4d".
export function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) {
    const min = Math.floor(-ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `in ${min}m`;
    const h = Math.floor(min / 60);
    if (h < 24) return `in ${h}h`;
    const d = Math.floor(h / 24);
    if (d < 14) return `in ${d}d`;
    return shortDate(iso);
  }
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

// Dropped folders become their files, flattened to plain names.
export async function filesFromDrop(dt) {
  const out = [];
  const walk = (entry) =>
    new Promise((resolve) => {
      if (entry.isFile) entry.file((f) => (out.push(f), resolve()), resolve);
      else if (entry.isDirectory)
        entry.createReader().readEntries(async (entries) => {
          for (const e of entries) await walk(e);
          resolve();
        }, resolve);
      else resolve();
    });
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  for (const e of entries) await walk(e);
  return out;
}

// Trailing sentence punctuation isn't part of the url; a trailing ')' only
// counts as punctuation if it isn't balancing a '(' earlier in the url
// (so "https://en.wikipedia.org/wiki/Foo_(bar)" stays whole).
function splitTrailingPunctuation(url) {
  let trail = '';
  while (url.length) {
    const last = url.slice(-1);
    const closesUrlParen = last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0);
    if (!'.,;:!?\'"'.includes(last) && !closesUrlParen) break;
    trail = last + trail;
    url = url.slice(0, -1);
  }
  return [url, trail];
}

export function inline(md) {
  const withMarks = esc(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let inLink = 0;
  return withMarks.replace(/(<[^>]+>)|(https?:\/\/[^\s<]+)/g, (m, tag, url) => {
    if (tag) {
      if (/^<a[ >]/i.test(tag)) inLink++;
      else if (/^<\/a>/i.test(tag)) inLink = Math.max(0, inLink - 1);
      return tag;
    }
    if (inLink) return url;
    const [href, trail] = splitTrailingPunctuation(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener">${href}</a>${trail}` : url;
  });
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
