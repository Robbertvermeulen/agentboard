// Login: one button, no username — the authenticator offers its passkeys.
import { api } from '../api.js';
import { icons } from '../icons.js';
// Vendored UMD build (web/index.html loads it before app.js): no import, a global.
const { startAuthentication } = window.SimpleWebAuthnBrowser;

export function renderLogin(view, { next }) {
  view.innerHTML = `<div class="auth-view">
    <div class="side-logo"><span class="mark">A</span><span class="name">Agentboard</span></div>
    <p class="dialog-sub">Sign in with the passkey registered on this device.</p>
    <button type="button" class="btn-dark" id="login-btn">${icons.lock(14, '#fff')}Sign in with passkey</button>
    <p id="login-error" class="field-error" hidden></p>
    <p class="mut-sm">No passkey here yet? Run <code>agentboard auth enrol --name &lt;device&gt;</code> and open the link on this device.</p>
  </div>`;
  const btn = view.querySelector('#login-btn');
  const err = view.querySelector('#login-error');
  btn.onclick = async () => {
    btn.disabled = true;
    err.hidden = true;
    try {
      const { options } = await api.auth.loginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.auth.loginVerify(response);
      location.hash = next && next !== '#/' ? next : '#/';
      location.reload();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
}
