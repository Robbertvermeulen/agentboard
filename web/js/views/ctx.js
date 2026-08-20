// Read-only context viewer: file tree left, frontmatter fields + markdown right.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc, renderMarkdown } from '../util.js';

function treeHtml(files, activePath) {
  const lines = [];
  const seen = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/');
      if (!seen.has(dir)) {
        seen.add(dir);
        lines.push(`<div class="ctx-dir" style="padding-left:${8 + i * 18}px">${icons.chevronDown(13, 'var(--mut)')}${esc(parts[i])}/</div>`);
      }
    }
    const depth = parts.length - 1;
    lines.push(
      `<a class="ctx-file${f === activePath ? ' active' : ''}" style="padding-left:${26 + Math.max(depth - 1, 0) * 18}px" href="#/ctx/${esc(f)}">${esc(parts.at(-1))}</a>`
    );
  }
  return lines.join('');
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
  root.innerHTML = `
    <div class="m-head"><div class="row"><span class="title">Context</span></div></div>
    <div class="ctx">
      <div class="ctx-tree">
        <div class="heading">Context · git</div>
        ${files.length ? treeHtml(files, path) : '<p class="ctx-placeholder">No context files yet.</p>'}
      </div>
      <div class="ctx-main">
        ${
          file
            ? `<div class="ctx-head"><span class="path">${esc(file.path)}</span><span class="ro">read-only</span></div>
               <div class="ctx-content">
                 ${frontmatterCard(file.frontmatter)}
                 <div class="ctx-md">${renderMarkdown(file.content)}</div>
               </div>`
            : `<div class="ctx-placeholder">Select a file to read it.</div>`
        }
      </div>
    </div>
  `;
}
