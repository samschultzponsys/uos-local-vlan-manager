import { useState, useEffect } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Toggle, Segmented, Field, Copy, toast, Spinner, SsoButton, ask, Avatar, pickImage,
  vlanColors, ROLE_LABEL, MODE_LABEL, ago, when, rank,
} from "./ui.js";


const APP_NAMES = { network: "Network", protect: "Protect", access: "Access", other: "other UniFi" };
const APP_ICONS = { network: "server", protect: "camera", access: "door", other: "grid" };
const appKey = (app) => { const a = (app || "network").toLowerCase(); return APP_NAMES[a] && a !== "other" ? a : "other"; };
/** [[app, devices]] with Network devices first */
function groupDevices(devices) {
  const by = {};
  for (const d of devices) (by[d.app || "Network"] = by[d.app || "Network"] || []).push(d);
  return Object.entries(by).sort((x, y) => (x[0] === "Network" ? -1 : y[0] === "Network" ? 1 : x[0].localeCompare(y[0])));
}

const roleName = (roles, key) => ((roles || []).find((r) => r.key === key) || { name: key }).name;

// ============================================================================
// Settings
// ============================================================================

export function SettingsModal({ onClose, onSaved }) {
  const [tab, setTab] = useState("envs");
  const tabs = [["envs", "Environments", "server"], ["auth", "Sign-in", "shield"], ["behavior", "Ports", "grid"],
    ["updates", "Updates", "sparkle"]];
  return html`<${Modal} title="Settings" icon="settings" onClose=${onClose} wide>
    <nav class="tabs">${tabs.map(([k, l, i]) => html`<button class=${tab === k ? "on" : ""} onClick=${() => setTab(k)}><${Icon} name=${i} size=${15} />${l}</button>`)}</nav>
    <div class="tab-body">
      ${tab === "envs" && html`<${EnvironmentsTab} onSaved=${onSaved} />`}
      ${tab === "auth" && html`<${AuthTab} />`}
      ${tab === "behavior" && html`<${BehaviorTab} onSaved=${onSaved} />`}
      ${tab === "updates" && html`<${UpdatesTab} />`}
    </div></${Modal}>`;
}

function useSettings() {
  const [s, setS] = useState(null);
  useEffect(() => { api("/api/settings").then(setS).catch((e) => toast(e.message, "err")); }, []);
  return [s, setS];
}

// --- environments ------------------------------------------------------------

// shown when an admin picks a cloud connection
const CLOUD_NOTE = {
  title: "About UniFi cloud connections",
  wide: true,
  confirm: "Use cloud anyway",
  cancel: "Use Direct",
  body: html`<div class="cloud-note">
    <p>This app is built to run on the same network as your consoles. <b>Direct</b> connections can do everything.</p>
    <p>Through UniFi's cloud, UniFi only allows its official API. In practice that means:</p>
    <div class="cn-grid">
      <div><div class="cn-head good-text"><${Icon} name="check" size=${15} /> Works</div><ul>
        <li>Your switches and whether they're online</li>
        <li>Each port's link and speed</li>
        <li>SFP / RJ45 ports</li>
        <li>PoE on and delivering power</li>
        <li>The list of networks</li></ul></div>
      <div><div class="cn-head err-text"><${Icon} name="x" size=${15} /> Not available</div><ul>
        <li>Seeing a port's VLAN</li>
        <li>Changing VLANs or tagging</li>
        <li>Port locks</li>
        <li>Connected devices per port and PoE watts</li></ul></div>
    </div>
    <p class="muted small">You'll need a Site Manager API key from unifi.ui.com/api, and the console needs UniFi OS 5.0.3 or newer with Remote Access on.
      If UniFi ever allows the full switch API through the cloud for your console, Test connection will say so and everything will work.</p>
  </div>`,
};

const NEW_ENV = { id: null, name: "", mode: "local", host: "", site: "default", console_id: "", verify_ssl: false,
  supervisors_protected: false, notes: "", vlan_colors: {}, api_key_set: false };

function EnvironmentsTab({ onSaved }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => api("/api/admin/envs").then((r) => setList(r.envs)).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  if (edit) return html`<${EnvEditor} env=${edit} onDone=${(changed) => { setEdit(null); load(); if (changed) onSaved(); }} />`;
  if (!list) return html`<${Spinner} />`;
  return html`<div class="form">
    <p class="muted">Each environment is one UniFi console or UniFi OS instance, reached with its own API key. Only admins see or set keys.
      Give people access under <b>Users → Access</b>.</p>
    <div class="env-list">
      ${list.map((e) => html`<button class="env-card" key=${e.id} onClick=${() => setEdit(e)}>
        <span class="env-icon"><${Icon} name="server" size=${18} /></span>
        <div class="env-main"><b>${e.name}</b>
          <span class="muted small">${e.mode === "cloud" ? `UniFi cloud · ${e.console_id || "no console"}` : e.host || "no address"} · site ${e.site}</span></div>
        ${!e.api_key_set && html`<span class="badge warn">no API key</span>`}
        <span class="badge">${e.users} user${e.users === 1 ? "" : "s"}</span>
        <${Icon} name="chevron" size=${16} cls="rot" /></button>`)}
      ${list.length === 0 && html`<div class="empty-sm">No environments yet.</div>`}
    </div>
    <div class="form-actions"><button class="btn primary" onClick=${() => setEdit(NEW_ENV)}><${Icon} name="plus" />Add environment</button></div>
  </div>`;
}

function EnvEditor({ env, onDone }) {
  const [s, setS] = useState({ ...env });
  const [key, setKey] = useState("");
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [consoles, setConsoles] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const set = (k, v) => setS({ ...s, [k]: v });
  const cloud = s.mode === "cloud";
  const body = () => ({ env_id: s.id || undefined, name: s.name, mode: s.mode, host: s.host, site: s.site,
    console_id: s.console_id, verify_ssl: s.verify_ssl, supervisors_protected: s.supervisors_protected,
    notes: s.notes, vlan_colors: s.vlan_colors || {}, api_key: key || undefined });
  useEffect(() => { if (s.id) api(`/api/admin/envs/${s.id}/catalog`).then(setCatalog).catch(() => {}); }, []);

  async function save() {
    try {
      const b = body();
      delete b.env_id;
      if (s.id) await api(`/api/admin/envs/${s.id}`, { method: "PUT", body: b });
      else await api("/api/admin/envs", { method: "POST", body: b });
      toast(`${s.name} saved`);
      onDone(true);
    } catch (e) { toast(e.message, "err"); }
  }
  const keyField = html`<${Field} label=${cloud ? "Account API key (unifi.ui.com/api)" : "API key"} hint=${cloud ? "Site Manager → API → Create API key" : "In that console: Network → Settings → Control Plane → Integrations → Create API key"}>
      <div class="row"><input type="password" autocomplete="new-password" value=${key} placeholder=${s.api_key_set ? "✓ saved — leave blank to keep" : "paste the key"}
        onInput=${(e) => setKey(e.target.value)} />
        ${s.id && s.api_key_set && html`<button class="btn ghost" onClick=${async () => {
          if (!await ask({ title: "Remove the API key?", body: "Nobody can use this environment until a new key is added.", danger: true, confirm: "Remove" })) return;
          await api(`/api/admin/envs/${s.id}`, { method: "PUT", body: { clear_api_key: true } }); set("api_key_set", false);
        }}>Remove</button>`}</div></${Field}>`;
  const auto = catalog ? vlanColors(catalog.networks, {}, {}) : {};
  const colors = s.vlan_colors || {};
  return html`<div class="form">
    <button class="link-btn back" onClick=${() => onDone(false)}><${Icon} name="chevron" size=${14} cls="back-chev" />All environments</button>
    <div class="grid2">
      <${Field} label="Name" hint="What users see, e.g. “Jake's staging rack”."><input value=${s.name} onInput=${(e) => set("name", e.target.value)} /></${Field}>
      <${Field} label="Connection"><${Segmented} value=${s.mode} onChange=${async (v) => {
        if (v === "cloud" && s.mode !== "cloud" && !await ask(CLOUD_NOTE)) return;
        set("mode", v);
      }}
        options=${[{ value: "local", label: "Direct" }, { value: "cloud", label: "UniFi cloud" }]} /></${Field}>
    </div>
    ${!cloud ? html`<${Field} label="Console address" hint="UDM / UCG / Cloud Key / UniFi OS Server or a UniFi OS container, e.g. https://10.1.2.3 or https://10.1.2.3:11443">
        <input value=${s.host} placeholder="https://192.168.1.1" onInput=${(e) => set("host", e.target.value)} /></${Field}>`
      : html`<div class="steps">
        <div class="step"><span class="step-n">1</span><div><b>Create an account API key</b> at${" "}<a href="https://unifi.ui.com/api" target="_blank" rel="noopener">unifi.ui.com/api</a> (Site Manager → API → Create API key) and paste it below.
          <div class="muted small">Not the key under a console's Network → Integrations — that one is for the Direct connection.</div></div></div>
        <div class="step"><span class="step-n">2</span><div><b>Pick the console</b>: press <i>Find my consoles</i>, or paste the address of any
          unifi.ui.com page of that console (e.g. <span class="mono">unifi.ui.com/consoles/3be5…/network/…</span>) into Console.</div></div>
      </div>
      ${keyField}
      <${Field} label="Console" hint="The ID is filled in for you when you pick from the list or paste a unifi.ui.com address.">
        <div class="row"><input value=${s.console_id} placeholder="pick from the list, or paste a unifi.ui.com address"
          onInput=${(e) => { const v = e.target.value; const m = v.match(/\/consoles\/([^/?#]+)/); set("console_id", m ? m[1] : v.trim()); }} />
          <button class="btn ghost" onClick=${async () => {
            if (!key && !s.api_key_set) return toast("Paste the account API key first", "err");
            const r = await api("/api/admin/envs/consoles", { method: "POST", body: body() });
            if (r.ok) setConsoles(r.consoles); else toast(r.error, "err");
          }}><${Icon} name="search" size=${14} />Find my consoles</button></div>
        ${consoles && html`<div class="choices">${consoles.map((c) => html`<button class=${"chip" + (c.id === s.console_id ? " on" : "")} onClick=${() => { set("console_id", c.id); setConsoles(null); if (!s.name) set("name", c.name); }}>
            <span class=${"status-dot " + (c.online ? "on" : "")}></span>${c.name}<span class="muted">${c.type}</span></button>`)}
          ${consoles.length === 0 && html`<span class="muted">No consoles on this key.</span>`}</div>`}</${Field}>
      <p class="muted small">Through the cloud, ports are <b>view only</b> — UniFi's cloud doesn't let apps change port VLANs. To change ports, use <b>Direct</b> (the console's own address, e.g. over a VPN).</p>`}
    ${!cloud && keyField}
    <${Field} label="Site" hint="UniFi's internal site name, usually 'default'. Test the connection to pick from a list.">
      <input value=${s.site} onInput=${(e) => set("site", e.target.value)} />
      ${test && test.sites && test.sites.length > 1 && html`<div class="choices">${test.sites.map((x) => html`<button class=${"chip" + (x.name === s.site ? " on" : "")} onClick=${() => set("site", x.name)}>${x.desc}<span class="muted">${x.name}</span></button>`)}</div>`}
    </${Field}>
    ${!cloud && html`<${Toggle} checked=${s.verify_ssl} onChange=${(v) => set("verify_ssl", v)} label="Verify TLS certificate" hint="Leave off for a self-signed certificate." />`}
    <${Toggle} checked=${s.supervisors_protected} onChange=${(v) => set("supervisors_protected", v)} label="Supervisors may change protected ports"
      hint="Uplinks, links to other UniFi devices, LAG and mirror ports. Off: only admins, after a warning." />
    <${Field} label="Notes (visible to this environment's supervisors)"><input value=${s.notes} onInput=${(e) => set("notes", e.target.value)} /></${Field}>
    ${test && html`<div class=${"notice " + (test.ok ? (test.readonly ? "warn" : "good") : "err")}><${Icon} name=${test.ok ? "check" : "alert"} /><div>
      ${test.ok && test.readonly ? html`Connected, <b>view only</b> — <b>${test.devices}</b> devices and <b>${test.networks}</b> networks.` : test.ok ? html`Connected — <b>${test.devices}</b> devices and <b>${test.networks}</b> networks on site <b>${s.site}</b>.` : test.steps ? "A check above failed — its note says what to do." : test.error}</div></div>`}
    ${test && test.steps && html`<div class="steps-check">${test.steps.map((st) => html`<div class=${"check-row " + (st.ok ? "ok" : st.warn ? "warn" : "bad")}>
      <${Icon} name=${st.ok ? "check" : st.warn ? "alert" : "x"} size=${15} /><div><b>${st.name}</b><div class="muted small">${st.detail}</div></div></div>`)}</div>`}
    ${test && test.ok && test.console_id && test.console_id !== s.console_id && html`<div class="muted small">Console ID resolved to <span class="mono">${test.console_id}</span> — it's saved that way.</div>`}

    ${catalog && catalog.networks.length > 0 && html`<h4 class="section">Default VLAN colors</h4>
      <p class="muted small">For everyone using this environment. Each user can still pick their own.</p>
      <div class="color-list">${catalog.networks.map((n) => html`<label class="color-row" key=${n.id}>
        <input type="color" value=${colors[n.id] || auto[n.id]} onInput=${(e) => set("vlan_colors", { ...colors, [n.id]: e.target.value })} />
        <span class="color-name">${n.name}</span><span class="chip-vlan">VLAN ${n.vlan}</span>
        ${colors[n.id] && html`<button class="link-btn" onClick=${(e) => { e.preventDefault(); const v = { ...colors }; delete v[n.id]; set("vlan_colors", v); }}>auto</button>`}
      </label>`)}</div>`}

    <div class="form-actions sticky">
      ${s.id && html`<button class="btn ghost danger-text" onClick=${async () => {
        if (!await ask({ title: `Delete ${s.name}?`, body: "Everyone loses access to it. The UniFi console itself isn't touched.", danger: true, confirm: "Delete" })) return;
        await api(`/api/admin/envs/${s.id}`, { method: "DELETE" }); toast("Deleted"); onDone(true);
      }}><${Icon} name="trash" />Delete</button>`}
      ${s.id && html`<a class="btn ghost" href=${`/api/admin/envs/${s.id}/diagnostics`} download
        title="What UniFi reports for this environment's devices, with passwords and keys removed - handy when a model shows up wrong"><${Icon} name="download" />Diagnostics</a>`}
      <span class="grow"></span>
      <button class="btn ghost" disabled=${busy} onClick=${async () => { setBusy(true); try { setTest(await api("/api/admin/envs/test", { method: "POST", body: body() })); } catch (e) { toast(e.message, "err"); } setBusy(false); }}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}Test connection</button>
      <button class="btn primary" onClick=${save}>Save</button>
    </div></div>`;
}

function AuthTab() {
  const [a, setA] = useState(null);
  const [secret, setSecret] = useState("");
  const [testRes, setTestRes] = useState(null);
  useEffect(() => { api("/api/settings/auth").then(setA).catch((e) => toast(e.message, "err")); }, []);
  if (!a) return html`<${Spinner} />`;
  const set = (k, v) => setA({ ...a, [k]: v });
  const setO = (k, v) => setA({ ...a, oidc: { ...a.oidc, [k]: v } });
  const setB = (k, v) => setA({ ...a, oidc_button: { ...a.oidc_button, [k]: v } });
  const locked = (k) => a.locked.includes(k);

  async function save(extra = {}) {
    const body = { ...a, oidc: { ...a.oidc, client_secret: secret || undefined }, ...extra };
    delete body.locked; delete body.icons; delete body.redirect_uri; delete body.oidc_ready; delete body.signed_in_with;
    try {
      await api("/api/settings/auth", { method: "PUT", body });
      setSecret("");
      toast("Sign-in settings saved");
      setA(await api("/api/settings/auth"));
    } catch (e) {
      if (e.status === 409 && e.data.confirm_no_auth) {
        const typed = prompt("No-auth mode lets ANYONE who can reach this app use it without signing in, " +
          `acting as ${roleName(a.roles, a.anonymous_role)}.\n\nOnly do this on an isolated network you fully trust.\n\nType I UNDERSTAND to turn it on:`);
        if (typed) return save({ ...extra, confirm_no_auth: typed });
      } else if (e.status === 409 && e.data.confirm) {
        if (await ask({ title: "Are you sure?", body: e.data.confirm, danger: true, confirm: "Save anyway" })) return save({ ...extra, confirm: true });
      } else toast(e.message, "err");
    }
    return null;
  }

  return html`<div class="form">
    <h4 class="section">Ways to sign in</h4>
    <${Toggle} checked=${a.local_enabled} disabled=${locked("local_enabled")} onChange=${(v) => set("local_enabled", v)}
      label="Username + password" hint="Local users managed under Users." />
    <${Toggle} checked=${a.oidc_enabled} onChange=${(v) => set("oidc_enabled", v)} label="Single sign-on (OIDC)" hint="Authentik, Authelia, Keycloak, Pocket ID…" />
    <${Toggle} checked=${a.token_enabled} onChange=${(v) => set("token_enabled", v)} label="Sign-in links (tokens)" hint="Each user can make personal links that sign a phone or tablet in without a password (My account → Sign-in links)." />

    <h4 class="section">Single sign-on (OIDC)</h4>
    <${RedirectBox} a=${a} onUseOrigin=${() => set("public_url", location.origin)} />
    <div class="grid2">
      <${Field} label="Issuer URL" hint="Authentik: https://auth.example.com/application/o/<slug>/"><input value=${a.oidc.issuer} onInput=${(e) => setO("issuer", e.target.value)} /></${Field}>
      <${Field} label="Client ID"><input value=${a.oidc.client_id} onInput=${(e) => setO("client_id", e.target.value)} /></${Field}>
      <${Field} label="Client secret"><input type="password" autocomplete="new-password" value=${secret} placeholder=${a.oidc.client_secret_set ? "✓ saved — leave blank to keep" : ""} onInput=${(e) => setSecret(e.target.value)} /></${Field}>
      <${Field} label="Scopes"><input value=${a.oidc.scopes} onInput=${(e) => setO("scopes", e.target.value)} /></${Field}>
      <${Field} label="Redirect URI override (advanced)" hint="Leave empty to use the one shown above.">
        <input value=${a.oidc.redirect_uri} placeholder="detected automatically" onInput=${(e) => setO("redirect_uri", e.target.value)} /></${Field}>
      <${Field} label="Client authentication" hint="How the ID and secret are sent. Test provider picks the one that works.">
        <select value=${a.oidc.token_auth_method || "client_secret_basic"} onChange=${(e) => setO("token_auth_method", e.target.value)}>
          <option value="client_secret_basic">HTTP Basic (default)</option>
          <option value="client_secret_post">Form POST</option>
          <option value="none">None (public client, PKCE only)</option>
        </select></${Field}>
      <${Field} label="Groups claim"><input value=${a.oidc.groups_claim} onInput=${(e) => setO("groups_claim", e.target.value)} /></${Field}>
      <${Field} label="Allowed groups" hint="Comma-separated. Empty = anyone your provider lets through."><input value=${a.oidc.allowed_groups} onInput=${(e) => setO("allowed_groups", e.target.value)} /></${Field}>
    </div>
    <${Toggle} checked=${a.oidc.auto_create} onChange=${(v) => setO("auto_create", v)} label="Create users on first SSO sign-in" hint="SSO only signs people in. New users start as Viewer with no environments until an admin gives them access. Off: an admin adds them first (username or email must match)." />
    <${Toggle} checked=${a.oidc_auto_login} onChange=${(v) => set("oidc_auto_login", v)} label="Sign in automatically with SSO"
      hint="Visiting the app goes straight to your provider. /login always shows the login page as a fallback." />
    <div class="row">
      <button class="btn ghost" onClick=${async () => {
        const r = await api("/api/settings/auth/test-oidc", { method: "POST", body: { ...a.oidc, client_secret: secret || undefined } }).catch((e) => ({ ok: false, error: e.message }));
        setTestRes(r);
        if (r.credentials && r.credentials.ok && r.credentials.suggest !== a.oidc.token_auth_method) setO("token_auth_method", r.credentials.suggest);
      }}><${Icon} name="refresh" size=${14} />Test provider</button>
    </div>
    ${testRes && html`<div class="test-results">
      <div class=${testRes.ok ? "good-text" : "err-text"}>${testRes.ok ? `✓ Found the provider: ${testRes.issuer}` : `✗ ${testRes.error}`}</div>
      ${testRes.credentials && html`<div class=${testRes.credentials.ok ? "good-text" : "err-text"}>${testRes.credentials.ok ? "✓" : "✗"} ${testRes.credentials.message}</div>`}
      ${testRes.ok && !testRes.credentials && html`<div class="muted">Enter the client ID (and secret) to check them too.</div>`}
      ${testRes.credentials && testRes.credentials.ok && testRes.credentials.suggest !== (a.oidc.token_auth_method || "client_secret_basic") && html`<div class="muted">Client authentication was switched to what works — save to keep it.</div>`}
    </div>`}

    <h4 class="section">SSO button</h4>
    <div class="button-editor">
      <div class="grid2">
        <${Field} label="Text"><input value=${a.oidc_button.text} onInput=${(e) => setB("text", e.target.value)} /></${Field}>
        <${Field} label="Icon"><select value=${a.oidc_button.icon} onChange=${(e) => setB("icon", e.target.value)}>
          ${a.icons.map((i) => html`<option value=${i}>${i === "custom" ? "Custom image URL" : i[0].toUpperCase() + i.slice(1)}</option>`)}</select></${Field}>
        <${Field} label="Background"><div class="row"><input type="color" value=${a.oidc_button.bg} onInput=${(e) => setB("bg", e.target.value)} /><input value=${a.oidc_button.bg} onInput=${(e) => setB("bg", e.target.value)} /></div></${Field}>
        <${Field} label="Text color"><div class="row"><input type="color" value=${a.oidc_button.fg} onInput=${(e) => setB("fg", e.target.value)} /><input value=${a.oidc_button.fg} onInput=${(e) => setB("fg", e.target.value)} /></div></${Field}>
        ${a.oidc_button.icon === "custom" && html`<${Field} label="Icon image URL"><input value=${a.oidc_button.icon_url} placeholder="https://auth.example.com/static/dist/assets/icons/icon.svg" onInput=${(e) => setB("icon_url", e.target.value)} /></${Field}>`}
      </div>
      <div class="button-preview"><span class="muted small">Preview</span><${SsoButton} button=${a.oidc_button} onClick=${(e) => e.preventDefault()} /></div>
    </div>

    <h4 class="section">Sessions & network</h4>
    <div class="grid2">
      <${Field} label="Stay signed in for (days)" hint="Counted from the last visit. For SSO this is the app's own session."><input type="number" min="1" max="365" value=${a.session_days} onInput=${(e) => set("session_days", e.target.value)} /></${Field}>
      <${Field} label="Public URL" locked=${locked("public_url")} hint="Only if a reverse proxy doesn't send X-Forwarded-Host."><input value=${a.public_url} disabled=${locked("public_url")} placeholder="https://vlans.example.com" onInput=${(e) => set("public_url", e.target.value)} /></${Field}>
      <${Field} label="Trusted proxies" locked=${locked("trusted_proxies")}><input value=${a.trusted_proxies} disabled=${locked("trusted_proxies")} onInput=${(e) => set("trusted_proxies", e.target.value)} /></${Field}>
    </div>
    <${Toggle} checked=${a.cookie_secure} disabled=${locked("cookie_secure")} onChange=${(v) => set("cookie_secure", v)} label="HTTPS-only cookie" hint="Turn on when you always use HTTPS." />

    <div class="danger-zone">
      <h4><${Icon} name="alert" />Danger zone: no-auth mode</h4>
      <p>Anyone who can open this page uses the app <b>without signing in</b>, with the role below. Admins can still sign in at /login.
        Only for a lab or a completely isolated management network.</p>
      <div class="row">
        <${Toggle} checked=${a.no_auth} disabled=${locked("no_auth")} onChange=${(v) => set("no_auth", v)} label="No authentication" />
        <select value=${a.anonymous_role} onChange=${(e) => set("anonymous_role", e.target.value)}>
          ${a.roles.map((r) => html`<option value=${r.key}>Anonymous visitors are ${r.name}</option>`)}</select>
      </div>
      ${locked("no_auth") && html`<small class="hint">Set by VLANMGR_NO_AUTH.</small>`}
    </div>
    <div class="form-actions sticky"><button class="btn primary" onClick=${() => save()}>Save sign-in settings</button></div>
  </div>`;
}

// the URIs to paste into the provider - shown before anything else is filled in, since the
// provider needs the redirect URI before it hands out the client ID and secret
function RedirectBox({ a, onUseOrigin }) {
  const override = (a.oidc.redirect_uri || "").trim();
  const base = (a.public_url || a.detected_base || location.origin).replace(/\/+$/, "");
  const redirect = override || `${base}/auth/oidc/callback`;
  let origin = "";
  try { origin = new URL(redirect).origin; } catch (e) { /* invalid override */ }
  const mismatch = !override && origin && origin !== location.origin;
  return html`<div class="uri-box">
    <div class="uri-item"><span class="field-label">Redirect URI — paste this at your provider</span>
      <div class="uri-row"><code>${redirect}</code><${Copy} text=${redirect} /></div></div>
    <div class="uri-item"><span class="field-label">Launch URL (optional, for the provider's app list)</span>
      <div class="uri-row"><code>${base}/</code><${Copy} text=${`${base}/`} /></div></div>
    ${mismatch && html`<div class="notice warn"><${Icon} name="alert" /><div>
      Your browser is at <b>${location.origin}</b>, but the app sees itself as <b>${origin}</b>. That usually means a reverse
      proxy isn't passing <span class="mono">X-Forwarded-Host</span> / <span class="mono">-Proto</span>.
      <div><button class="link-btn" onClick=${onUseOrigin}>Use ${location.origin} as the public URL</button> (then save)</div></div></div>`}
    <small class="hint">Worked out from the address you're using now${a.public_url ? " (Public URL below)" : ""}. Open these settings through the same URL people use to sign in.</small>
  </div>`;
}

function BehaviorTab({ onSaved }) {
  const [s, setS] = useSettings();
  if (!s) return html`<${Spinner} />`;
  const set = (k, v) => setS({ ...s, [k]: v });
  return html`<div class="form">
    <${Field} label="App name"><input value=${s.app_name} maxlength="40" onInput=${(e) => set("app_name", e.target.value)} /></${Field}>
    <${Field} label="Tagged VLAN management when changing a port" hint="Pre-selected in the port panel. Anyone who can change ports can still pick another option.">
      <${Segmented} value=${s.default_tagged_mode} onChange=${(v) => set("default_tagged_mode", v)}
        options=${["auto", "block_all", "custom"].map((m) => ({ value: m, label: MODE_LABEL[m] }))} /></${Field}>
    <${Toggle} checked=${s.protect_uplinks} onChange=${(v) => set("protect_uplinks", v)} label="Protect uplinks"
      hint="Uplinks, links to other UniFi devices, LAG and mirror ports can only be changed by an admin, after a warning." />
    <${Field} label="Refresh every (seconds)"><input type="number" min="5" max="600" value=${s.poll_seconds} onInput=${(e) => set("poll_seconds", e.target.value)} /></${Field}>
    <div class="form-actions"><button class="btn primary" onClick=${async () => {
      try { await api("/api/settings", { method: "PUT", body: { app_name: s.app_name, default_tagged_mode: s.default_tagged_mode, protect_uplinks: s.protect_uplinks, poll_seconds: s.poll_seconds } }); toast("Saved"); onSaved(); } catch (e) { toast(e.message, "err"); }
    }}>Save</button></div></div>`;
}

function UpdatesTab() {
  const [s, setS] = useSettings();
  const [v, setV] = useState(null);
  useEffect(() => { api("/api/version").then(setV); }, []);
  if (!s || !v) return html`<${Spinner} />`;
  const u = v.update;
  return html`<div class="form">
    <${Toggle} checked=${s.update_check} disabled=${!s.update_allowed} onChange=${async (on) => {
      await api("/api/settings", { method: "PUT", body: { update_check: on } }); setS({ ...s, update_check: on });
    }} label="Check GitHub for new versions" hint=${s.update_allowed ? `Every 6 hours, from ${u.repo} releases.` : "Disabled by VLANMGR_UPDATE_CHECK=false."} />
    <div class="kv"><span>Installed</span><b>${v.version}</b></div>
    <div class="kv"><span>Latest release</span><b>${u.latest || "—"}</b></div>
    <div class="kv"><span>Last check</span><span>${u.checked_at ? ago(u.checked_at) : "not yet"}${u.error ? ` · ${u.error}` : ""}</span></div>
    ${u.update_available && html`<div class="notice good"><${Icon} name="sparkle" /><div>Version ${u.latest} is available. Update with
      <div class="mono small">docker compose pull && docker compose up -d</div></div></div>`}
    <div class="form-actions"><button class="btn ghost" disabled=${!u.enabled} onClick=${async () => {
      const r = await api("/api/version/check", { method: "POST" }); setV({ ...v, update: r.update });
      toast(r.update.update_available ? `Version ${r.update.latest} is available` : r.update.error ? r.update.error : "You're up to date", r.update.error ? "err" : "ok");
    }}>Check now</button></div></div>`;
}

// ============================================================================
// Users
// ============================================================================

export function UsersModal({ me, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("people");
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState(null);   // { kind: "access" | "edit", user }
  const [form, setForm] = useState({ username: "", display_name: "", email: "", password: "", role: "" });
  const load = () => api("/api/users").then(setData).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  const can = (c) => data && data.my_caps.includes(c);

  async function update(u, body, msg) {
    try { await api(`/api/users/${u.id}`, { method: "PUT", body }); toast(msg || "Saved"); load(); return true; } catch (e) { toast(e.message, "err"); return false; }
  }
  const back = () => { setView(null); load(); };

  if (view && view.kind === "access") {
    return html`<${Modal} title=${`Access · ${view.user.display_name || view.user.username}`} icon="shield" onClose=${onClose} wide>
      <${AccessEditor} user=${view.user} roles=${data.roles} onDone=${back} /></${Modal}>`;
  }
  if (view && view.kind === "edit") {
    return html`<${Modal} title=${`Edit · ${view.user.username}`} icon="user" onClose=${onClose} wide>
      <${UserEditor} user=${view.user} data=${data} me=${me} onSave=${async (b) => { if (await update(view.user, b, "Saved")) back(); }} onCancel=${back} /></${Modal}>`;
  }
  const rolesByLevel = data ? data.roles.slice().sort((x, y) => y.level - x.level) : [];
  return html`<${Modal} title="Users" icon="users" onClose=${onClose} wide
    footer=${tab === "people" && data && html`<span class="muted grow">New people start with the lowest role and no environments. SSO users appear here after their first sign-in.</span>
      ${can("users.create") && html`<button class="btn primary" onClick=${() => setAdding(!adding)}><${Icon} name="plus" />Add user</button>`}`}>
    ${data && data.admin && html`<nav class="tabs"><button class=${tab === "people" ? "on" : ""} onClick=${() => setTab("people")}><${Icon} name="users" size=${15} />People</button>
      <button class=${tab === "roles" ? "on" : ""} onClick=${() => setTab("roles")}><${Icon} name="shield" size=${15} />Roles & abilities</button></nav>`}
    ${!data ? html`<${Spinner} />` : tab === "roles" ? html`<${RolesEditor} onChanged=${load} />` : html`
    ${adding && html`<div class="panel add-user">
      <div class="grid3">
        <${Field} label="Username"><input value=${form.username} onInput=${(e) => setForm({ ...form, username: e.target.value })} /></${Field}>
        <${Field} label="Display name"><input value=${form.display_name} onInput=${(e) => setForm({ ...form, display_name: e.target.value })} /></${Field}>
        <${Field} label="Email"><input value=${form.email} onInput=${(e) => setForm({ ...form, email: e.target.value })} /></${Field}>
        <${Field} label="Password" hint="Leave blank for an SSO-only user."><input type="password" autocomplete="new-password" value=${form.password} onInput=${(e) => setForm({ ...form, password: e.target.value })} /></${Field}>
        ${(data.admin || can("users.roles")) && html`<${Field} label="Role"><select value=${form.role || rolesByLevel[rolesByLevel.length - 1].key} onChange=${(e) => setForm({ ...form, role: e.target.value })}>
          ${rolesByLevel.filter((r) => data.assignable_roles.includes(r.key)).map((r) => html`<option value=${r.key}>${r.name}</option>`)}</select></${Field}>`}
        <div class="field end"><button class="btn primary" onClick=${async () => {
          try {
            const r = await api("/api/users", { method: "POST", body: form });
            toast(`Added ${form.username}`); setForm({ username: "", display_name: "", email: "", password: "", role: "" }); setAdding(false);
            if (r.user.role !== "admin" && can("users.access")) setView({ kind: "access", user: r.user }); else load();
          } catch (e) { toast(e.message, "err"); }
        }}>Create</button></div>
      </div></div>`}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>User</th><th>Role</th><th>Access</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
      <tbody>${data.users.map((u) => {
        const self = u.id === me.id;
        const extra = u.caps_grant.length + u.caps_deny.length;
        return html`<tr key=${u.id} class=${u.disabled ? "disabled" : ""}>
        <td><div class="u-cell"><${Avatar} user=${u} size=${32} />${u.avatar_locked ? html`<span class="av-lock" title="Picture locked"><${Icon} name="lock" size=${10} /></span>` : null}
          <div><b>${u.display_name || u.username}</b>${u.seeded && html` <span class="badge">first admin</span>`}
            <div class="muted small">${u.username}${u.email ? ` · ${u.email}` : ""}${u.sso ? " · SSO" : ""}</div></div></div></td>
        <td>${!self && (data.admin || can("users.roles")) && (data.admin || data.assignable_roles.includes(u.role))
            ? html`<select class="sm" value=${u.role} onChange=${(e) => update(u, { role: e.target.value }, `${u.username} is now ${roleName(data.roles, e.target.value)}`)}>
                ${rolesByLevel.filter((r) => data.assignable_roles.includes(r.key) || r.key === u.role).map((r) => html`<option value=${r.key}>${r.name}</option>`)}</select>`
            : html`<span class=${"role-badge " + u.role}>${u.role_name}</span>`}
          ${extra > 0 && html`<div class="muted small" title="Abilities changed for this person">${u.caps_grant.length ? `+${u.caps_grant.length}` : ""}${u.caps_grant.length && u.caps_deny.length ? " " : ""}${u.caps_deny.length ? `−${u.caps_deny.length}` : ""} abilities</div>`}</td>
        <td>${u.role === "admin" ? html`<span class="badge good">All environments</span>`
          : can("users.access") && !self ? html`<button class=${"btn sm " + (u.envs ? "ghost" : "primary")} onClick=${() => setView({ kind: "access", user: u })}>
              <${Icon} name="shield" size=${14} />${u.envs ? `${u.envs} environment${u.envs > 1 ? "s" : ""}` : "Give access"}</button>`
          : html`<span class="muted small">${u.envs} environment${u.envs === 1 ? "" : "s"}</span>`}</td>
        <td class="muted small">${ago(u.last_login)}${u.sessions ? html`<div>${u.sessions} active session${u.sessions > 1 ? "s" : ""}</div>` : null}</td>
        <td>${!self && can("users.edit") ? html`<${Toggle} checked=${!u.disabled} onChange=${(on) => update(u, { disabled: !on }, on ? "Enabled" : "Disabled")} label=${u.disabled ? "Disabled" : "Active"} />` : html`<span class="muted small">${self ? "you" : u.disabled ? "disabled" : "active"}</span>`}</td>
        <td class="actions">
          ${!self && u.role !== "admin" && !u.disabled && !me.impersonator && can("users.view_as") && html`<button class="icon-btn sm" title=${`View as ${u.username}`} onClick=${async () => {
            try { await api(`/api/users/${u.id}/impersonate`, { method: "POST" }); location.href = "/"; } catch (e) { toast(e.message, "err"); }
          }}><${Icon} name="eye" size=${15} /></button>`}
          ${(data.admin || (!self && (can("users.edit") || can("users.roles")))) && html`<button class="icon-btn sm" title="Edit, abilities" onClick=${() => setView({ kind: "edit", user: u })}><${Icon} name="user" size=${15} /></button>`}
          ${!self && can("users.edit") && html`<button class="icon-btn sm" title="Set password" onClick=${() => { const pw = prompt(`New password for ${u.username} (8+ characters):`); if (pw) update(u, { password: pw }, "Password set"); }}><${Icon} name="key" size=${15} /></button>`}
          ${u.sessions > 0 && !self && can("users.edit") && html`<button class="icon-btn sm" title="Sign out everywhere" onClick=${() => update(u, { sign_out: true }, "Signed out")}><${Icon} name="logout" size=${15} /></button>`}
          ${!self && can("users.delete") && html`<button class="icon-btn sm danger" title="Delete" onClick=${async () => {
            if (await ask({ title: `Delete ${u.username}?`, body: "Their sessions, sign-in links and access are removed too.", danger: true, confirm: "Delete" })) {
              try { await api(`/api/users/${u.id}`, { method: "DELETE" }); toast("Deleted"); load(); } catch (e) { toast(e.message, "err"); }
            }
          }}><${Icon} name="trash" size=${15} /></button>`}
        </td></tr>`;
      })}</tbody></table></div>`}
  </${Modal}>`;
}

// what a role or a person may do, grouped
function capGroups(caps) {
  const out = [];
  for (const c of caps) {
    let g = out.find((x) => x.group === c.group);
    if (!g) out.push(g = { group: c.group, caps: [] });
    g.caps.push(c);
  }
  return out;
}

function RolesEditor({ onChanged }) {
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  const [adding, setAdding] = useState(null);
  const load = () => api("/api/roles").then((r) => { setData(r); setEdits({}); }).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  if (!data) return html`<${Spinner} />`;
  const groups = capGroups(data.caps);
  const val = (r) => ({ ...r, ...(edits[r.key] || {}) });
  const put = (key, patch) => setEdits({ ...edits, [key]: { ...(edits[key] || {}), ...patch } });
  const roles = data.roles.slice().sort((a, b) => b.level - a.level);
  async function save(r) {
    try { await api(`/api/roles/${r.key}`, { method: "PUT", body: edits[r.key] }); toast(`${val(r).name} saved`); load(); onChanged(); } catch (e) { toast(e.message, "err"); }
  }
  return html`<div class="form">
    <p class="muted">A role is a set of abilities. Its <b>level</b> decides who is above whom: abilities to manage people only ever
      work on people with a lower level. You can also allow or deny single abilities per person (Users → edit).
      Changing environments, API keys, sign-in settings and roles is always admin-only.</p>
    <div class="role-list">
    ${roles.map((r0) => {
      const r = val(r0);
      const admin = r.key === "admin";
      const dirty = !!edits[r.key];
      return html`<div class=${"role-card" + (admin ? " admin" : "")} key=${r.key}>
        <div class="role-head">
          ${admin ? html`<b class="role-title">${r.name}</b>` : html`<input class="role-name" value=${r.name} onInput=${(e) => put(r.key, { name: e.target.value })} />`}
          <label class="role-level" title=${r.builtin ? "Built-in roles keep their level" : "11 – 99"}>Level
            <input type="number" min="11" max="99" value=${r.level} disabled=${r.builtin} onInput=${(e) => put(r.key, { level: e.target.value })} /></label>
          <span class="badge">${r0.users} ${r0.users === 1 ? "person" : "people"}</span>
          <span class="grow"></span>
          ${!r.builtin && html`<button class="btn sm ghost danger-text" onClick=${async () => {
            const others = roles.filter((x) => x.key !== r.key && x.key !== "admin");
            const move = prompt(`Delete ${r.name}? Its people move to another role. Type one of: ${others.map((x) => x.name).join(", ")}`, others[others.length - 1].name);
            if (!move) return;
            const target = others.find((x) => x.name.toLowerCase() === move.trim().toLowerCase());
            if (!target) return toast("No such role", "err");
            try { await api(`/api/roles/${r.key}`, { method: "DELETE", body: { move_to: target.key } }); toast("Role deleted"); load(); onChanged(); } catch (e) { toast(e.message, "err"); }
            return null;
          }}>Delete</button>`}
          ${!admin && html`<button class="btn sm primary" disabled=${!dirty} onClick=${() => save(r0)}>Save</button>`}
        </div>
        ${admin ? html`<p class="muted small">Every ability, always — including environments and API keys, sign-in settings and roles.</p>`
          : html`<div class="cap-grid">${groups.map((g) => html`<div class="cap-group"><div class="field-label">${g.group}</div>
            ${g.caps.map((c) => html`<label class="cap-row" title=${c.hint}><input type="checkbox" checked=${r.caps.includes(c.key)}
              onChange=${(e) => put(r.key, { caps: e.target.checked ? [...r.caps, c.key] : r.caps.filter((x) => x !== c.key) })} />
              <span>${c.label}${c.hint && html`<small>${c.hint}</small>`}</span></label>`)}</div>`)}</div>`}
      </div>`;
    })}
    </div>
    ${adding ? html`<div class="panel"><div class="grid3">
        <${Field} label="New role name"><input value=${adding.name} placeholder="Lead tech" onInput=${(e) => setAdding({ ...adding, name: e.target.value })} /></${Field}>
        <${Field} label="Level (11 – 99)" hint="Supervisor is 50, Viewer is 10."><input type="number" min="11" max="99" value=${adding.level} onInput=${(e) => setAdding({ ...adding, level: e.target.value })} /></${Field}>
        <${Field} label="Start from"><select value=${adding.from} onChange=${(e) => setAdding({ ...adding, from: e.target.value })}>
          ${roles.filter((x) => x.key !== "admin").map((x) => html`<option value=${x.key}>${x.name}</option>`)}</select></${Field}>
      </div>
      <div class="form-actions"><button class="btn ghost" onClick=${() => setAdding(null)}>Cancel</button><button class="btn primary" onClick=${async () => {
        const from = roles.find((x) => x.key === adding.from);
        try { await api("/api/roles", { method: "POST", body: { name: adding.name, level: adding.level, caps: from ? from.caps : [] } }); toast("Role added"); setAdding(null); load(); onChanged(); } catch (e) { toast(e.message, "err"); }
      }}>Add role</button></div></div>`
      : html`<div class="form-actions"><button class="btn primary" onClick=${() => setAdding({ name: "", level: 30, from: "supervisor" })}><${Icon} name="plus" />Add a role</button></div>`}
  </div>`;
}

function UserEditor({ user, data, me, onSave, onCancel }) {
  const [f, setF] = useState({ username: user.username, display_name: user.display_name || "", email: user.email || "" });
  const [grant, setGrant] = useState(user.caps_grant || []);
  const [deny, setDeny] = useState(user.caps_deny || []);
  const mayEdit = data.admin || data.my_caps.includes("users.edit");
  const mayRoles = (data.admin || data.my_caps.includes("users.roles")) && user.role !== "admin" && user.id !== me.id;
  const roleCaps = ((data.roles.find((r) => r.key === user.role) || {}).caps) || [];
  const stateOf = (k) => (grant.includes(k) ? "allow" : deny.includes(k) ? "deny" : "role");
  const setState = (k, st) => {
    setGrant(st === "allow" ? [...grant.filter((x) => x !== k), k] : grant.filter((x) => x !== k));
    setDeny(st === "deny" ? [...deny.filter((x) => x !== k), k] : deny.filter((x) => x !== k));
  };
  const [u, setU] = useState(user);
  async function avatar(method, body, msg) {
    try { const r = await api(`/api/users/${u.id}/avatar`, { method, body }); setU(r.user); if (msg) toast(msg); } catch (e) { toast(e.message, "err"); }
  }
  return html`<div class="form">
    ${mayEdit && html`<div class="avatar-edit">
      <${Avatar} user=${u} size=${72} />
      <div class="avatar-actions">
        <div class="row">
          <button class="btn sm" onClick=${async () => { const img = await pickImage().catch((e) => toast(e.message, "err")); if (img) avatar("PUT", { image: img }, "Picture set"); }}><${Icon} name="user" size=${14} />Choose picture</button>
          ${u.avatar && html`<button class="btn sm ghost" onClick=${() => avatar("DELETE", {}, "Picture removed")}>Remove</button>`}
        </div>
        <${Toggle} checked=${u.avatar_locked} onChange=${(on) => avatar("PUT", { locked: on }, on ? "Picture locked" : "Picture unlocked")}
          label="Lock picture" hint="They can't change or remove it." />
      </div>
    </div>`}
    <${Field} label="Username" hint=${user.sso ? "SSO users are matched by their provider ID, so renaming is safe." : "Used to sign in with a password."}>
      <input value=${f.username} autocomplete="off" onInput=${(e) => setF({ ...f, username: e.target.value })} /></${Field}>
    <${Field} label="Display name"><input value=${f.display_name} onInput=${(e) => setF({ ...f, display_name: e.target.value })} /></${Field}>
    <${Field} label="Email"><input value=${f.email} onInput=${(e) => setF({ ...f, email: e.target.value })} /></${Field}>
    ${mayRoles && html`<h4 class="section">Abilities</h4>
      <p class="muted small">From their role (<b>${user.role_name}</b>) unless you allow or deny one here.${data.admin ? "" : " You can only hand out abilities you have yourself."}</p>
      <div class="cap-grid">${capGroups(data.caps).map((g) => html`<div class="cap-group"><div class="field-label">${g.group}</div>
        ${g.caps.map((c) => {
          const st = stateOf(c.key);
          const fromRole = roleCaps.includes(c.key);
          const on = st === "allow" || (st === "role" && fromRole);
          const mine = data.admin || data.my_caps.includes(c.key);
          return html`<div class=${"cap-line" + (on ? " on" : "")} title=${c.hint}>
            <span class="cap-label"><span class=${"cap-dot" + (on ? " on" : "")}></span>${c.label}</span>
            <${Segmented} value=${st} onChange=${(v) => setState(c.key, v)} options=${[
              { value: "role", label: fromRole ? "Role ✓" : "Role —" },
              { value: "allow", label: "Allow", disabled: !mine },
              { value: "deny", label: "Deny" }]} />
          </div>`;
        })}</div>`)}</div>`}
    <div class="form-actions"><button class="btn ghost" onClick=${onCancel}>Cancel</button><button class="btn primary" onClick=${() => {
      const body = mayEdit ? { ...f } : {};
      if (mayRoles) Object.assign(body, { caps_grant: grant, caps_deny: deny });
      onSave(body);
    }}>Save</button></div>
  </div>`;
}

// which environments a user may use, and which networks / devices inside them
function AccessEditor({ user, roles, onDone }) {
  const [envList, setEnvList] = useState(null);
  const [acc, setAcc] = useState({});        // env id -> access entry
  const [catalogs, setCatalogs] = useState({});
  useEffect(() => {
    Promise.all([api("/api/envs"), api(`/api/users/${user.id}/access`)]).then(([e, a]) => {
      setEnvList(e.envs);
      const m = {};
      for (const x of a.envs) m[x.env_id] = x;
      setAcc(m);
    }).catch((err) => toast(err.message, "err"));
  }, []);
  // networks + devices of each environment the user has, fetched once when first needed
  useEffect(() => {
    for (const id of Object.keys(acc)) {
      if (catalogs[id] !== undefined) continue;
      setCatalogs((c) => ({ ...c, [id]: null }));
      api(`/api/admin/envs/${id}/catalog`).then((r) => setCatalogs((c) => ({ ...c, [id]: r })))
        .catch((e) => setCatalogs((c) => ({ ...c, [id]: { error: e.message, networks: [], devices: [] } })));
    }
  }, [Object.keys(acc).join()]);
  const catalog = (id) => catalogs[id];
  const put = (id, patch) => setAcc({ ...acc, [id]: { ...acc[id], ...patch } });
  const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  if (!envList) return html`<${Spinner} />`;
  return html`<div class="form">
    ${user.role === "admin" && html`<div class="notice"><${Icon} name="info" /><div>Admins always have every environment. This only matters if you change their role.</div></div>`}
    <p class="muted">${user.display_name || user.username} (${roleName(roles, user.role)}) sees the devices you pick${(user.caps || []).includes("ports.change") ? ", and changes ports using the networks you pick" : ""}.
      ${" "}Networks and devices come live from each console.</p>
    ${envList.length === 0 && html`<div class="empty-sm">Add an environment under Settings → Environments first.</div>`}
    <div class="access-list">
    ${envList.map((env) => {
      const a = acc[env.id];
      const cat = a ? catalog(env.id) : null;
      return html`<div class=${"access-env" + (a ? " on" : "")} key=${env.id}>
        <div class="access-head">
          <${Toggle} checked=${!!a} onChange=${(on) => { const m = { ...acc }; if (on) m[env.id] = { env_id: env.id, all_vlans: true, vlans: [], all_devices: true, devices: [] }; else delete m[env.id]; setAcc(m); }}
            label=${env.name} hint=${env.mode === "cloud" ? "UniFi cloud" : env.host} />
        </div>
        ${a && html`<div class="access-body">
          <div class="access-col">
            <div class="field-label">Networks they can use</div>
            <${Segmented} value=${a.all_vlans ? "all" : "some"} onChange=${(v) => put(env.id, { all_vlans: v === "all" })}
              options=${[{ value: "all", label: "All" }, { value: "some", label: "Only these" }]} />
            ${!a.all_vlans && (!cat ? html`<${Spinner} />` : cat.error ? html`<span class="err-text small">${cat.error}</span>` : html`<div class="tag-list">
              ${cat.networks.map((n) => html`<label class="tag-row" key=${n.id}><input type="checkbox" checked=${a.vlans.includes(n.id)}
                onChange=${() => put(env.id, { vlans: toggleIn(a.vlans, n.id) })} />${n.name}<span class="chip-vlan">${n.vlan}</span></label>`)}</div>`)}
          </div>
          <div class="access-col">
            <div class="field-label">Devices they can see</div>
            <${Segmented} value=${a.all_devices ? "all" : "some"} onChange=${(v) => put(env.id, { all_devices: v === "all" })}
              options=${[{ value: "all", label: "All" }, { value: "some", label: "Only these" }]} />
            ${!a.all_devices && (!cat ? html`<${Spinner} />` : cat.error ? html`<span class="err-text small">${cat.error}</span>` : html`<div class="tag-list">
              ${(cat.apps || []).length > 0 && html`<div class="tag-sub">Every device of an app (now and later)</div>`}
              ${(cat.apps || []).map((ap) => html`<label class="tag-row" key=${"app:" + ap}><input type="checkbox" checked=${a.devices.includes("app:" + ap)}
                onChange=${() => put(env.id, { devices: toggleIn(a.devices, "app:" + ap) })} /><${Icon} name=${APP_ICONS[ap]} size=${14} />
                <b>All ${APP_NAMES[ap]} devices</b></label>`)}
              ${groupDevices(cat.devices).map(([app, list]) => html`<div class="tag-sub">${app === "Network" ? "Network devices" : `UniFi ${app}`}</div>
                ${list.map((d) => {
                  const blanket = a.devices.includes("app:" + appKey(d.app));
                  return html`<label class="tag-row" key=${d.mac}><input type="checkbox" checked=${blanket || a.devices.includes(d.mac)} disabled=${blanket}
                    onChange=${() => put(env.id, { devices: toggleIn(a.devices, d.mac) })} /><span class=${"status-dot " + (d.online ? "on" : "")}></span>
                    ${d.name}<span class="muted small">${d.model_name}</span></label>`;
                })}`)}</div>`)}
            ${!(user.caps || []).some((c) => c.startsWith("apps.")) && html`<small class="hint">Their role doesn't show any UniFi app's devices — see Roles &amp; abilities.</small>`}
          </div>
        </div>`}
      </div>`;
    })}
    </div>
    <div class="form-actions sticky"><button class="btn ghost" onClick=${onDone}>Cancel</button>
      <button class="btn primary" onClick=${async () => {
        try { await api(`/api/users/${user.id}/access`, { method: "PUT", body: { envs: Object.values(acc) } }); toast("Access saved"); onDone(); } catch (e) { toast(e.message, "err"); }
      }}>Save access</button></div>
  </div>`;
}

// read-only view of an environment for its supervisors (and admins)
export function EnvInfoModal({ env, networks, devices, onClose }) {
  const [cfg, setCfg] = useState(null);
  useEffect(() => { api(`/api/envs/${env.id}/config`).then(setCfg).catch((e) => toast(e.message, "err")); }, []);
  const a = env.access;
  return html`<${Modal} title=${env.name} icon="server" onClose=${onClose}>
    ${!cfg ? html`<${Spinner} />` : html`<div class="form">
      <div class="kv"><span>Connection</span><b>${cfg.mode === "cloud" ? "UniFi cloud" : "Direct"}</b></div>
      ${cfg.mode === "cloud" ? html`<div class="kv"><span>Console ID</span><span class="mono">${cfg.console_id}</span></div>`
        : html`<div class="kv"><span>Console</span><span class="mono">${cfg.host}</span></div>`}
      <div class="kv"><span>Site</span><span class="mono">${cfg.site}</span></div>
      <div class="kv"><span>API key</span><span>${cfg.api_key_set ? "set by an admin" : "missing"}</span></div>
      <div class="kv"><span>Protected ports</span><span>${cfg.supervisors_protected ? "supervisors may change them" : "admins only"}</span></div>
      ${cfg.notes && html`<div class="notice"><${Icon} name="info" /><div>${cfg.notes}</div></div>`}
      <h4 class="section">Your access</h4>
      <div class="kv"><span>Networks</span><span>${a.all_vlans ? "all" : networks.filter((n) => n.allowed).map((n) => `${n.name} (${n.vlan})`).join(", ") || "none"}</span></div>
      <div class="kv"><span>Devices</span><span>${a.all_devices ? "all" : devices.map((d) => d.name).join(", ") || "none online"}</span></div>
      <p class="muted small">Only an admin can change the connection or your access.</p>
    </div>`}</${Modal}>`;
}

// ============================================================================
// My account
// ============================================================================

export function AccountModal({ me, onClose }) {
  const [pw, setPw] = useState({ current: "", password: "", confirm: "" });
  const [tokens, setTokens] = useState(null);
  const [pic, setPic] = useState(me.avatar);
  const loadTokens = () => api("/api/me/tokens").then(setTokens).catch(() => setTokens({ enabled: false, tokens: [] }));
  useEffect(() => { loadTokens(); }, []);
  return html`<${Modal} title="My account" icon="user" onClose=${onClose} wide>
    <div class="account-head"><${Avatar} user=${{ ...me, avatar: pic }} size=${64} />
      <div><h3>${me.display_name || me.username}</h3><div class="muted">${me.username}${me.email ? ` · ${me.email}` : ""} · <span class=${"role-badge " + me.role}>${me.role_name}</span></div>
        ${me.id ? (me.avatar_locked ? html`<div class="muted small"><${Icon} name="lock" size=${12} /> An admin set your picture.</div>`
          : html`<div class="row avatar-row">
              <button class="btn sm" onClick=${async () => {
                try { const img = await pickImage(); if (!img) return; const r = await api("/api/me/avatar", { method: "PUT", body: { image: img } }); setPic(r.avatar); toast("Picture updated"); } catch (e) { toast(e.message, "err"); }
              }}><${Icon} name="user" size=${14} />${pic ? "Change picture" : "Add a picture"}</button>
              ${pic && html`<button class="btn sm ghost" onClick=${async () => { await api("/api/me/avatar", { method: "DELETE" }); setPic(null); toast("Picture removed"); }}>Remove</button>`}
            </div>`) : null}
      </div></div>

    <${ProfileForm} me=${me} />
    ${me.method !== "token" && html`<h4 class="section">${me.has_password ? "Change password" : "Set a password"}</h4>
    <div class="grid3">
      ${me.has_password && html`<${Field} label="Current password"><input type="password" autocomplete="current-password" value=${pw.current} onInput=${(e) => setPw({ ...pw, current: e.target.value })} /></${Field}>`}
      <${Field} label="New password"><input type="password" autocomplete="new-password" value=${pw.password} onInput=${(e) => setPw({ ...pw, password: e.target.value })} /></${Field}>
      <${Field} label="Repeat"><input type="password" autocomplete="new-password" value=${pw.confirm} onInput=${(e) => setPw({ ...pw, confirm: e.target.value })} /></${Field}>
    </div>
    <div class="form-actions"><button class="btn primary" onClick=${async () => {
      if (pw.password !== pw.confirm) return toast("The passwords don't match", "err");
      try { await api("/api/me/password", { method: "PUT", body: pw }); toast("Password changed"); setPw({ current: "", password: "", confirm: "" }); } catch (e) { toast(e.message, "err"); }
      return null;
    }}>Save password</button></div>`}

    <h4 class="section">Sign-in links</h4>
    ${tokens && !tokens.enabled ? html`<p class="muted">Sign-in links are turned off by an admin.</p>` : html`<${SignInLinks} me=${me} tokens=${tokens} reload=${loadTokens} />`}
  </${Modal}>`;
}

const TOKEN_RE = /^[A-Za-z0-9._~-]{16,128}$/;

// personal sign-in links (API tokens): open once on a phone or tablet and it stays signed in
function SignInLinks({ me, tokens, reload }) {
  const [tf, setTf] = useState({ name: "", role: me.role, days: 0, value: "" });
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const code = tf.value.trim();
  const bad = code && !TOKEN_RE.test(code);
  const link = `${location.origin}/?token=`;
  return html`
    <div class="explain">
      <p><b>A sign-in link signs a device in as you, without a password.</b> Open it once on your phone or a wall tablet
        and that device stays signed in. It never has more access than you do.</p>
      <p class="muted small">Anyone who has the link can get in, so treat it like a password. You can revoke it below at any time.</p>
    </div>

    ${created && html`<div class="link-created">
      <div class="lc-title"><${Icon} name="check" /> Your sign-in link is ready</div>
      <div class="uri-row big"><code>${created.link}</code><${Copy} text=${created.link} /></div>
      <div class="muted small">Copy it now: the full link is only shown this once. Open it on the device you want signed in.</div>
    </div>`}

    <div class="link-builder">
      <div class="grid2">
        <${Field} label="Name" hint="So you recognise it later, e.g. “My phone” or “Desk 4 tablet”.">
          <input value=${tf.name} placeholder="My phone" onInput=${(e) => setTf({ ...tf, name: e.target.value })} /></${Field}>
        <${Field} label="Code (optional)" hint="The secret part of the link. Leave empty for a random one, or type your own: 16+ letters, digits, . _ ~ -">
          <input value=${tf.value} autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="random"
            onInput=${(e) => setTf({ ...tf, value: e.target.value })} /></${Field}>
      </div>
      <div class="field"><span class="field-label">Your link will be</span>
        <div class="uri-row big"><code>${link}<b class=${code ? "" : "placeholder"}>${code || "(random code, shown when you create it)"}</b></code></div>
        ${bad && html`<small class="err-text">${code.length < 16 ? `${16 - code.length} more character${16 - code.length === 1 ? "" : "s"} needed.` : "Only letters, digits and . _ ~ - are allowed."}</small>`}
      </div>
      <details class="more"><summary>More options</summary>
        <div class="grid2">
          <${Field} label="Access" hint="The link can have less access than you, never more.">
            <select value=${tf.role} onChange=${(e) => setTf({ ...tf, role: e.target.value })}>${(me.token_roles || []).map((r) => html`<option value=${r.key}>${r.name}</option>`)}</select></${Field}>
          <${Field} label="Stops working after (days)" hint="0 = never."><input type="number" min="0" value=${tf.days} onInput=${(e) => setTf({ ...tf, days: e.target.value })} /></${Field}>
        </div>
        <p class="muted small">For scripts: send the code in an <span class="mono">Authorization: Bearer ${"<code>"}</span> header instead of opening the link.</p>
      </details>
      <div class="form-actions"><button class="btn primary" disabled=${busy || bad || !tf.name.trim()} onClick=${async () => {
        setBusy(true);
        try { setCreated(await api("/api/me/tokens", { method: "POST", body: tf })); setTf({ ...tf, name: "", value: "" }); reload(); } catch (e) { toast(e.message, "err"); }
        setBusy(false);
      }}><${Icon} name="link" size=${15} />Create sign-in link</button></div>
    </div>

    ${tokens && tokens.tokens.length > 0 && html`<h4 class="section">Your links</h4>
      <table class="table"><thead><tr><th>Name</th><th>Access</th><th>Created</th><th>Last used</th><th>Stops working</th><th></th></tr></thead>
      <tbody>${tokens.tokens.map((t) => html`<tr key=${t.id}><td><b>${t.name}</b></td><td>${roleName(me.token_roles, t.role)}</td><td class="small">${ago(t.created_at)}</td>
        <td class="small">${ago(t.last_used)}</td><td class="small">${t.expires_at ? when(t.expires_at) : "never"}</td>
        <td class="actions"><button class="btn sm ghost danger-text" onClick=${async () => {
          if (!await ask({ title: `Revoke “${t.name}”?`, body: "Devices signed in with this link are signed out.", danger: true, confirm: "Revoke" })) return;
          await api(`/api/me/tokens/${t.id}`, { method: "DELETE" }); toast("Revoked"); reload();
        }}>Revoke</button></td></tr>`)}</tbody></table>`}`;
}

function ProfileForm({ me }) {
  const [f, setF] = useState({ display_name: me.display_name || "", username: me.username });
  const isAdmin = (me.caps || []).includes("settings.manage");
  return html`<h4 class="section">Profile</h4>
    <div class="grid3">
      <${Field} label="Display name"><input value=${f.display_name} onInput=${(e) => setF({ ...f, display_name: e.target.value })} /></${Field}>
      <${Field} label="Username" hint=${isAdmin ? "" : "Only an admin can change it."}><input value=${f.username} disabled=${!isAdmin} autocomplete="off"
        onInput=${(e) => setF({ ...f, username: e.target.value })} /></${Field}>
      <div class="field end"><button class="btn ghost" onClick=${async () => {
        const body = { display_name: f.display_name };
        if (isAdmin) body.username = f.username;
        try { await api("/api/me/profile", { method: "PUT", body }); toast("Profile saved"); } catch (e) { toast(e.message, "err"); }
      }}>Save profile</button></div>
    </div>`;
}

// ============================================================================
// Activity (audit log)
// ============================================================================

const ACTION_LABEL = {
  "port.set": "Port changed", "login.failed": "Failed sign-in", "login.sso_denied": "SSO sign-in refused",
  "user.created": "User added", "user.updated": "User changed", "user.deleted": "User deleted",
  "user.password_changed": "Password changed", "token.created": "Token created", "token.revoked": "Token revoked",
  "settings.app": "Settings changed", "settings.auth": "Sign-in settings changed",
  "user.access": "Access changed", "env.created": "Environment added", "env.updated": "Environment changed",
  "env.deleted": "Environment deleted", "port.locked": "Port locked", "port.unlocked": "Port unlocked",
  "port.lock_reapplied": "Locked settings re-applied", "role.created": "Role added", "role.updated": "Role changed",
  "role.deleted": "Role deleted", "user.avatar": "Picture changed", "user.impersonate": "Started viewing as",
  "user.impersonate_stop": "Stopped viewing as",
};

export function AuditModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { api("/api/audit").then((r) => setRows(r.entries)).catch((e) => toast(e.message, "err")); }, []);
  const list = (rows || []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  return html`<${Modal} title="Activity" icon="list" onClose=${onClose} wide>
    <div class="search"><${Icon} name="search" /><input placeholder="Filter by user, device, VLAN…" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    ${!rows ? html`<${Spinner} />` : list.length === 0 ? html`<div class="empty-sm">Nothing yet.</div>` : html`<div class="timeline">
      ${list.map((r) => {
        const d = r.detail || {};
        return html`<div class=${"tl" + (r.ok ? "" : " fail")} key=${r.id}>
          <div class="tl-dot"></div>
          <div class="tl-main">
            <div class="tl-head"><b>${ACTION_LABEL[r.action] || r.action}</b>${r.target && html`<span class="muted"> · ${r.target}</span>`}
              ${(r.action === "port.set" || r.action === "port.lock_reapplied") && r.ok && (d.verified ? html`<span class="badge good">verified</span>` : html`<span class="badge warn">unverified</span>`)}
              ${!r.ok && html`<span class="badge err">failed</span>`}</div>
            ${d.before && d.after && html`<div class="tl-diff">
              <span>${d.before.native} · ${d.before.tagged}</span><span class="arrow">→</span><b>${d.after.native} · ${d.after.tagged}</b>
              ${d.after.excluded && d.after.excluded.length > 0 && html`<span class="muted small"> (not tagged: ${d.after.excluded.join(", ")})</span>`}</div>`}
            ${d.note && html`<div class="muted small">“${d.note}”</div>`}
            ${d.error && html`<div class="err-text small">${d.error}</div>`}
            <div class="muted small">${r.username || "?"}${r.role ? ` (${r.role})` : ""} · ${when(r.ts)}${r.ip ? ` · ${r.ip}` : ""}</div>
          </div></div>`;
      })}</div>`}
  </${Modal}>`;
}
