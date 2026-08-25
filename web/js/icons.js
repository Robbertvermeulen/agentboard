// Inline SVG snippets, copied from the approved design so shapes match 1:1.

const stroke = (size, color, paths, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const icons = {
  bot: (size = 11, color = 'var(--brand-stroke)') =>
    stroke(size, color, '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M8 16h.01"/><path d="M16 16h.01"/>'),
  sliders: (size = 11, color = 'var(--brand-stroke)') =>
    stroke(size, color, '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="20" r="2"/>'),
  link: (size = 11, color = 'var(--mut-2)') =>
    stroke(size, color, '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  external: (size = 11, color = 'var(--brand-stroke)') =>
    stroke(size, color, '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  file: (size = 12, color = 'var(--mut)') =>
    stroke(size, color, '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 2v6h6"/>'),
  fileText: (size = 13, color = 'var(--mut)') =>
    stroke(size, color, '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>'),
  image: (size = 14, color = 'var(--mut)') =>
    stroke(size, color, '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L3 21"/>'),
  archive: (size = 14, color = 'var(--mut)') =>
    stroke(size, color, '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
  clock: (size = 12, color = 'var(--amber-icon)') =>
    stroke(size, color, '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  lock: (size = 10, color = 'var(--mut)') =>
    stroke(size, color, '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  plus: (size = 14, color = 'var(--mut-2)') => stroke(size, color, '<path d="M5 12h14"/><path d="M12 5v14"/>'),
  pencil: (size = 12, color = 'var(--mut-2)') =>
    stroke(size, color, '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
  x: (size = 10, color = 'var(--mut)') => stroke(size, color, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: (size = 14, color = '#fff') => stroke(size, color, '<path d="M20 6 9 17l-5-5"/>'),
  chevronDown: (size = 14, color = 'var(--mut-2)') => stroke(size, color, '<path d="m6 9 6 6 6-6"/>'),
  chevronRight: (size = 14, color = 'var(--mut-2)') => stroke(size, color, '<path d="m9 18 6-6-6-6"/>'),
  chevronLeft: (size = 22, color = 'var(--dark)') => stroke(size, color, '<path d="m15 18-6-6 6-6"/>'),
  arrowDown: (size = 14, color = 'var(--mut-2)') => stroke(size, color, '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  arrowRight: (size = 14, color = 'var(--amber-icon)') => stroke(size, color, '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  alert: (size = 12, color = 'var(--red-text)') =>
    stroke(size, color, '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  block: (size = 12, color = 'currentColor') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m6.3 6.3 11.4 11.4"/></svg>`,
  allClear: (size = 34, color = 'var(--mut-2)') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/></svg>`,
  user: (size = 12, color = '#fff') =>
    stroke(size, color, '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  uploadArrow: (size = 14, color = 'var(--brand-stroke)') => stroke(size, color, '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  trayUp: (size = 20, color = 'var(--brand-stroke)') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V6"/><path d="m8 10 4-4 4 4"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/></svg>`,
  folderDown: (size = 14, color = 'var(--brand-stroke)') =>
    stroke(size, color, '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6"/><path d="m9 13 3 3 3-3"/>'),
  board: (size = 16, color = 'var(--dark)') =>
    stroke(size, color, '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
};

// Status glyphs share one 14x14 circle grammar (dashed, empty, half,
// slashed, three-quarter, filled+check) plus the archive box.
export function statusIcon(status, size = 12, color) {
  const c = color ?? STATUS_META[status].icon;
  const svg = (inner) => `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none">${inner}</svg>`;
  switch (status) {
    case 'inbox':
      return svg(`<circle cx="7" cy="7" r="6" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="1.1 1.7"/>`);
    case 'ready':
      return svg(`<circle cx="7" cy="7" r="6" fill="none" stroke="${c}" stroke-width="1.5"/>`);
    case 'doing':
      return svg(`<circle cx="7" cy="7" r="6" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M7,7 L7,3.5 A3.5,3.5 0 0,1 7,10.5 Z" fill="${c}"/>`);
    case 'needs_input':
      return svg(`<circle cx="7" cy="7" r="6" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M4.5 4.5 L9.5 9.5" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`);
    case 'review':
      return svg(`<circle cx="7" cy="7" r="6" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M7,7 L7,3.5 A3.5,3.5 0 1,1 3.5,7 Z" fill="${c}"/>`);
    case 'done':
      return svg(`<circle cx="7" cy="7" r="6" fill="${c}"/><path d="M10.951 4.249c.332.332.332.87 0 1.202l-5 5a.85.85 0 0 1-1.202 0l-2-2a.85.85 0 0 1 1.202-1.202L5.35 8.648l4.399-4.399a.85.85 0 0 1 1.202 0Z" fill="#fff"/>`);
    case 'archived':
      return icons.archive(size + 1, c);
  }
}

// Per-status colors and column styling hooks used across views.
export const STATUS_META = {
  inbox: { icon: 'var(--mut-2)', chip: 'neutral' },
  ready: { icon: 'var(--mut-2)', chip: 'neutral' },
  doing: { icon: 'var(--brand)', chip: 'doing' },
  needs_input: { icon: 'var(--amber-strong)', chip: 'needs_input' },
  review: { icon: 'var(--green)', chip: 'review' },
  done: { icon: 'var(--mut-2)', chip: 'neutral' },
  archived: { icon: 'var(--mut-2)', chip: 'neutral' },
};

export const STATUSES = ['inbox', 'ready', 'doing', 'needs_input', 'review', 'done'];
export const ALL_STATUSES = [...STATUSES, 'archived'];
