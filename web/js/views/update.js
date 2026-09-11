// Update dialog: one confirmation, then per strategy — fly: wait for the
// machine to come back on the new version; git: tell the user to restart;
// image: show the pull line and no button.
import { api } from '../api.js';
import { esc } from '../util.js';
import { closeOverlay, openOverlay } from '../components.js';

const IMAGE = 'ghcr.io/robbertvermeulen/agentboard';

export function openUpdateDialog(info) {
  const v = info.latest.version;
  const line =
    info.strategy === 'fly'
      ? 'The board restarts on the new version. About a minute.'
      : info.strategy === 'git'
        ? 'Installs the new version; then restart agentboard serve.'
        : `This install updates by pulling the image: docker pull ${IMAGE}:${v}`;
  const el = openOverlay(`<div class="dialog" role="dialog" aria-label="Update">
    <span class="dialog-title">Update to ${esc(v)}?</span>
    <p class="dialog-sub">${esc(line)} <a href="${esc(info.latest.url)}" target="_blank" rel="noopener">Release notes</a></p>
    <p id="update-error" class="field-error" hidden></p>
    <div class="dialog-actions">
      <button type="button" id="update-cancel" class="btn-ghost">${info.strategy === 'image' ? 'Close' : 'Cancel'}</button>
      ${info.strategy === 'image' ? '' : '<button type="button" id="update-ok" class="btn-dark">Update</button>'}
    </div>
  </div>`);
  const sub = el.querySelector('.dialog-sub');
  const err = el.querySelector('#update-error');
  const ok = el.querySelector('#update-ok');
  const cancel = el.querySelector('#update-cancel');
  let timer = null;
  cancel.onclick = () => {
    if (timer) clearInterval(timer);
    closeOverlay();
  };
  const showError = (m) => {
    err.textContent = m;
    err.hidden = false;
    if (ok) ok.disabled = false;
  };
  const awaitRestart = (target) => {
    sub.textContent = 'Updating… the board restarts in a minute.';
    if (ok) ok.remove();
    cancel.textContent = 'Close';
    const started = Date.now();
    timer = setInterval(async () => {
      try {
        const i = await api.version();
        if (i.version === target) {
          clearInterval(timer);
          sub.textContent = `Updated to ${target}.`;
          setTimeout(() => location.reload(), 1200);
          return;
        }
      } catch {
        /* still restarting */
      }
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(timer);
        showError('Still not back after five minutes — check fly logs.');
      }
    }, 3000);
  };
  if (ok) {
    ok.onclick = async () => {
      ok.disabled = true;
      err.hidden = true;
      try {
        const r = await api.update();
        if (r.mode === 'fly') {
          const target = r.image.split(':').pop() || v;
          awaitRestart(target);
        } else if (r.mode === 'git') {
          sub.textContent = `Installed ${v}. Restart agentboard serve to finish.`;
          ok.remove();
          cancel.textContent = 'Close';
        } else sub.textContent = r.command;
      } catch (e) {
        // The machine reboots to apply the update, so the reply often never
        // arrives: a network error, a proxy 502/503 or a timeout all mean it
        // is on its way. Only a definite 4xx is a refusal.
        if (info.strategy === 'fly' && !(e.status >= 400 && e.status < 500)) awaitRestart(v);
        else showError(e.message);
      }
    };
  }
}
