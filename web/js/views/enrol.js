// Enrol: the one-time link from `agentboard auth enrol` lands here. The
// token lives in the hash, so it never reaches server logs.
import { api } from '../api.js';
import { icons } from '../icons.js';
import { esc } from '../util.js';
// Vendored UMD build (web/index.html loads it before app.js): no import, a global.
const { startRegistration } = window.SimpleWebAuthnBrowser;

export async function renderEnrol(view, { token }) {
  view.innerHTML = `<div class="auth-view">
    <div class="side-logo"><span class="mark">A</span><span class="name">Agentboard</span></div>
    <p class="dialog-sub">Register a passkey for this device. Face ID, Touch ID or your PIN will confirm it.</p>
    <div class="field">
      <label class="field-label" for="enrol-name">Device name</label>
      <input id="enrol-name" type="text" autocomplete="off" value="">
    </div>
    <button type="button" class="btn-dark" id="enrol-btn">${icons.lock(14, '#fff')}Register this device</button>
    <p id="enrol-error" class="field-error" hidden></p>
  </div>`;
  const btn = view.querySelector('#enrol-btn');
  const err = view.querySelector('#enrol-error');
  const name = view.querySelector('#enrol-name');
  const showError = (m) => {
    err.textContent = m;
    err.hidden = false;
    btn.disabled = false;
  };
  btn.onclick = async () => {
    btn.disabled = true;
    err.hidden = true;
    try {
      const { options, name: label } = await api.auth.registerOptions(token);
      if (!name.value.trim()) name.value = label;
      const response = await startRegistration({ optionsJSON: options });
      await api.auth.registerVerify(token, response, name.value.trim() || label);
      location.hash = '#/';
      location.reload();
    } catch (e) {
      showError(e.message);
    }
  };
  // Prefill the label without spending the token: options are cheap and the
  // challenge cookie is replaced when the button is pressed.
  try {
    const { name: label } = await api.auth.registerOptions(token);
    name.value = label;
  } catch (e) {
    showError(esc(e.message));
    btn.disabled = true;
  }
}
