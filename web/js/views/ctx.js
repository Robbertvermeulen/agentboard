// Read-only context viewer: file tree left, frontmatter fields + markdown right.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, renderMarkdown } from '../util.js';

// Tree UI state survives re-renders of this view (typing a filter or toggling
// a folder shouldn't reset when navigating to a different file), but not a
// full page reload — same pattern as lastSeen/lastBoard in board.js.
let filterText = '';
const collapseOverride = new Map(); // dir path -> forced collapsed state

// name -> {type:'file', path} | {type:'dir', path, children: Map}
function buildTree(paths) {
  const root = new Map();
  for (const f of paths) {
    const parts = f.split('/');
    let level = root;
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const full = prefix ? `${prefix}/${name}` : name;
      if (i === parts.length - 1) {
        level.set(name, { type: 'file', path: full });
      } else {
        if (!level.has(name)) level.set(name, { type: 'dir', path: full, children: new Map() });
        level = level.get(name).children;
      }
      prefix = full;
    }
  }
  return root;
}

function countFiles(children) {
  let n = 0;
  for (const node of children.values()) n += node.type === 'file' ? 1 : countFiles(node.children);
  return n;
}

function isCollapsed(dirPath, activePath) {
  if (filterText.trim()) return false; // a filter match should never stay hidden behind a collapsed folder
  if (collapseOverride.has(dirPath)) return collapseOverride.get(dirPath);
  return !(activePath && (activePath === dirPath || activePath.startsWith(`${dirPath}/`)));
}

function renderLevel(children, depth, activePath, lines) {
  for (const node of [...children.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = node.path.split('/').at(-1);
    if (node.type === 'dir') {
      const collapsed = isCollapsed(node.path, activePath);
      lines.push(
        `<button type="button" class="ctx-dir${collapsed ? ' collapsed' : ''}" data-toggle="${esc(node.path)}" style="padding-left:${8 + depth * 18}px">${icons.chevronDown(13, 'var(--mut)')}<span class="name">${esc(name)}/</span><span class="n">${countFiles(node.children)}</span></button>`
      );
      if (!collapsed) renderLevel(node.children, depth + 1, activePath, lines);
    } else {
      lines.push(
        `<a class="ctx-file${node.path === activePath ? ' active' : ''}" style="padding-left:${26 + Math.max(depth - 1, 0) * 18}px" href="#/ctx/${esc(node.path)}">${esc(name)}</a>`
      );
    }
  }
}

function treeHtml(files, activePath) {
  const q = filterText.trim().toLowerCase();
  const visible = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
  if (!visible.length) return '<p class="ctx-empty">No files match.</p>';
  const lines = [];
  renderLevel(buildTree(visible), 0, activePath, lines);
  return lines.join('');
}

function breadcrumbHtml(path) {
  const parts = path.split('/');
  const segs = parts.map((p, i) => {
    if (i === parts.length - 1) return `<span class="cur">${esc(p)}</span>`;
    const segPath = parts.slice(0, i + 1).join('/');
    return `<button type="button" class="seg" data-jump="${esc(segPath)}">${esc(p)}</button><span class="sep">/</span>`;
  });
  return `<div class="path">${segs.join('')}</div>`;
}

function frontmatterCard(fm) {
  const keys = Object.keys(fm ?? {});
  if (!keys.length) return '';
  const value = (k, v) => {
    if (k === 'secret_ref') {
      const list = Array.isArray(v) ? v : [v];
      return list.map((s) => `<span class="secret-ref">${icons.lock()}${esc(s)}</span>`).join('');
    }
    if (Array.isArray(v)) return esc(v.join(', '));
    return esc(String(v));
  };
  return `<div class="fm-card">${keys
    .map((k) => `<span class="k">${esc(k)}</span><span class="v${k === 'kind' ? ' kind' : ''}">${value(k, fm[k])}</span>`)
    .join('')}</div>`;
}

export async function renderCtx(root, { path }) {
  const [{ files }, file] = await Promise.all([api.ctxTree(), path ? api.ctxFile(path) : Promise.resolve(null)]);

  const wireTreeBody = () => {
    root.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => {
        collapseOverride.set(b.dataset.toggle, !b.classList.contains('collapsed'));
        redrawTree();
      };
    });
  };

  const redrawTree = () => {
    const body = root.querySelector('#ctx-tree-body');
    if (body) body.innerHTML = treeHtml(files, path);
    wireTreeBody();
  };

  root.innerHTML = `
    <div class="m-head"><div class="row"><span class="title">Context</span></div></div>
    <div class="ctx">
      <div class="ctx-tree">
        <div class="heading">Context · git</div>
        ${
          files.length
            ? `<div class="ctx-search">
                 ${icons.search(13, 'var(--mut-2)')}
                 <input type="text" id="ctx-filter" autocomplete="off" placeholder="Filter by file name…" value="${esc(filterText)}">
                 <button type="button" class="clear" id="ctx-filter-clear" ${filterText ? '' : 'hidden'}>${icons.x(13)}</button>
               </div>
               <div id="ctx-tree-body">${treeHtml(files, path)}</div>`
            : '<p class="ctx-placeholder">No context files yet.</p>'
        }
      </div>
      <div class="ctx-main">
        ${
          file
            ? `<div class="ctx-head">${breadcrumbHtml(file.path)}<span class="ro">read-only</span></div>
               <div class="ctx-content">
                 ${frontmatterCard(file.frontmatter)}
                 <div class="ctx-md">${renderMarkdown(file.content)}</div>
               </div>`
            : `<div class="ctx-placeholder">Select a file to read it.</div>`
        }
      </div>
    </div>
  `;

  wireTreeBody();
  const filterInput = root.querySelector('#ctx-filter');
  const clearBtn = root.querySelector('#ctx-filter-clear');
  if (filterInput) {
    filterInput.oninput = () => {
      filterText = filterInput.value;
      clearBtn.hidden = !filterText;
      redrawTree();
    };
  }
  if (clearBtn) {
    clearBtn.onclick = () => {
      filterText = '';
      filterInput.value = '';
      clearBtn.hidden = true;
      redrawTree();
      filterInput.focus();
    };
  }
  root.querySelectorAll('[data-jump]').forEach((b) => {
    b.onclick = () => {
      collapseOverride.set(b.dataset.jump, false);
      redrawTree();
      root.querySelector(`[data-toggle="${CSS.escape(b.dataset.jump)}"]`)?.scrollIntoView({ block: 'center' });
    };
  });
}
