import { render, useState, useEffect } from "./vendor/preact-htm.module.js";
import { html, api, Icon, Logo, SsoButton, Spinner } from "./ui.js";

function Login() {
  const q = new URLSearchParams(location.search);
  const next = q.get("next") || "/";
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({ username: "", password: "" });
  const [err, setErr] = useState(q.get("error") || "");
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState("");

  useEffect(() => {
    api("/api/auth/config").then((c) => { window.__vlanmgrStarted = true; setCfg(c); document.title = `Sign in · ${c.app_name}`; });
    api("/api/version").then((v) => setVer(v.version)).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { ...form, next } });
      location.href = r.next || "/";
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  if (!cfg) return html`<div class="boot"><${Logo} size=${48} /><${Spinner} /></div>`;
  const ssoHref = "/auth/oidc/login?next=" + encodeURIComponent(next);
  return html`<div class="login-page"><div class="login-card">
    <div class="login-brand"><${Logo} size=${52} /><h1>${cfg.app_name}</h1><p>Switch port VLANs for UniFi</p></div>
    ${q.get("logged_out") && !err && html`<div class="notice good"><${Icon} name="check" /><div>You're signed out.</div></div>`}
    ${err && html`<div class="notice err"><${Icon} name="alert" /><div>${err}</div></div>`}
    ${cfg.no_auth && html`<div class="notice warn"><${Icon} name="alert" /><div><b>No-auth mode is on</b> — you can <a href="/">go straight in</a>. Sign in here only to use your own account.</div></div>`}
    ${cfg.oidc && html`<${SsoButton} button=${cfg.button} href=${ssoHref} />`}
    ${cfg.oidc && cfg.local && html`<div class="divider">or</div>`}
    ${cfg.local && html`<form onSubmit=${submit}>
      <label class="field"><span class="field-label">Username</span>
        <input autocomplete="username" autofocus=${!cfg.oidc} value=${form.username} onInput=${(e) => setForm({ ...form, username: e.target.value })} /></label>
      <label class="field"><span class="field-label">Password</span>
        <input type="password" autocomplete="current-password" value=${form.password} onInput=${(e) => setForm({ ...form, password: e.target.value })} /></label>
      <button class="btn primary" disabled=${busy || !form.username || !form.password}>${busy ? html`<${Spinner} />` : "Sign in"}</button>
    </form>`}
    ${!cfg.local && !cfg.oidc && html`<div class="notice err"><${Icon} name="alert" /><div>No sign-in method is available. Set
      <span class="mono">VLANMGR_FORCE_LOCAL_LOGIN=true</span> in your compose file and restart to get back in.</div></div>`}
    <div class="login-foot">${ver && `v${ver}`}</div>
  </div></div>`;
}

render(html`<${Login} />`, document.getElementById("app"));
