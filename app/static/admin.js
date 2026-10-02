import { useState, useEffect } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Toggle, Segmented, Field, Copy, toast, Spinner, SsoButton, ask, Avatar, pickImage,
  Logo, setBrand, vlanColors, ROLE_LABEL, MODE_LABEL, ago, when, rank, bytes,
} from "./ui.js";


/** Super admin and Admin: built in, every environment, abilities fixed */
const isFull = (role) => role === "admin" || role === "superadmin";

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

export function SettingsModal({ onClose, onSaved, addEnv, me }) {
  const [tab, setTab] = useState("envs");
  const owner = ((me && me.caps) || []).includes("system.manage");
  const tabs = [["envs", "Environments", "server"], ["auth", "Sign-in", "shield"], ["behavior", "Ports", "grid"],
    ["brand", "Branding", "palette"], ...(owner ? [["integrations", "Integrations", "link"]] : []), ["updates", "Updates", "sparkle"]];
  return html`<${Modal} title="Settings" icon="settings" onClose=${onClose} wide>
    <nav class="tabs">${tabs.map(([k, l, i]) => html`<button class=${tab === k ? "on" : ""} onClick=${() => setTab(k)}><${Icon} name=${i} size=${15} />${l}</button>`)}</nav>
    <div class="tab-body">
      ${tab === "envs" && html`<${EnvironmentsTab} onSaved=${onSaved} startNew=${addEnv} />`}
      ${tab === "auth" && html`<${AuthTab} />`}
      ${tab === "behavior" && html`<${BehaviorTab} onSaved=${onSaved} />`}
      ${tab === "brand" && html`<${BrandingTab} onSaved=${onSaved} />`}
      ${tab === "integrations" && html`<${IntegrationsTab} />`}
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

function EnvironmentsTab({ onSaved, startNew }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(startNew ? NEW_ENV : null);
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
    <${Field} label="A first SSO sign-in joins the existing account with the same email"
      hint="Only when your provider says the email is verified. After that, they can sign in either way: with SSO or with their password.">
      <${Segmented} value=${a.oidc.link_by_email || "any"} onChange=${(v) => setO("link_by_email", v)}
        options=${[{ value: "any", label: "Any account" }, { value: "marked", label: "Only ones marked for SSO" }]} /></${Field}>
    <${Toggle} checked=${a.oidc.auto_create} onChange=${(v) => setO("auto_create", v)} label="Let new people sign in with SSO" hint="On: someone you haven't added gets an account that waits for you (they see “your admin hasn't set you up yet”) until you give them access, a role or abilities. Off: only people added under Users can sign in. Either way, people you added are matched by username or by email (when your provider says the email is verified)." />
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
    <${Field} label="Tagged VLAN management when changing a port" hint="Pre-selected in the port panel. Anyone who can change ports can still pick another option.">
      <${Segmented} value=${s.default_tagged_mode} onChange=${(v) => set("default_tagged_mode", v)}
        options=${["auto", "block_all", "custom"].map((m) => ({ value: m, label: MODE_LABEL[m] }))} /></${Field}>
    <${Toggle} checked=${s.protect_uplinks} onChange=${(v) => set("protect_uplinks", v)} label="Protect uplinks"
      hint="Uplinks, links to other UniFi devices, LAG and mirror ports can only be changed by an admin, after a warning." />
    <${Field} label="Refresh every (seconds)"><input type="number" min="5" max="600" value=${s.poll_seconds} onInput=${(e) => set("poll_seconds", e.target.value)} /></${Field}>
    <div class="form-actions"><button class="btn primary" onClick=${async () => {
      try { await api("/api/settings", { method: "PUT", body: { default_tagged_mode: s.default_tagged_mode, protect_uplinks: s.protect_uplinks, poll_seconds: s.poll_seconds } }); toast("Saved"); onSaved(); } catch (e) { toast(e.message, "err"); }
    }}>Save</button></div></div>`;
}

// --- branding ------------------------------------------------------------------

const MARK_KINDS = [{ value: "default", label: "Stock" }, { value: "icon", label: "Icon" }, { value: "image", label: "Picture" }];
const PALETTE_NAMES = { ocean: "Ocean", sunset: "Sunset", forest: "Forest", grape: "Grape", ember: "Ember", gold: "Gold", slate: "Slate", mono: "Mono" };

/** a mark as the Logo component draws it (the same shape the server sends) */
function drawable(m, which, b) {
  const colors = m.palette === "custom" ? [m.c1, m.c2, m.fg] : b.palettes[m.palette] || b.palettes.ocean;
  return { kind: m.kind, icon: m.icon, path: b.icons[m.icon], colors, src: m.image ? `/brand/${which}?v=${m.image}` : null };
}

function BrandingTab({ onSaved }) {
  const [b, setB] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api("/api/settings/brand").then(setB).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  if (!b) return html`<${Spinner} />`;
  const set = (k, v) => setB({ ...b, [k]: v });
  const logo = drawable(b.logo, "logo", b);
  const fav = b.favicon_same ? logo : drawable(b.favicon, "favicon", b);
  const name = b.app_name.trim() || "VLAN Manager";
  const upload = async (which) => {
    let image;
    try { image = await pickImage(which === "logo" ? 256 : 128, { transparent: true }); } catch (e) { return toast(e.message, "err"); }
    if (!image) return;
    try {
      await api(`/api/settings/brand/image/${which}`, { method: "PUT", body: { image } });
      const fresh = await api("/api/settings/brand");
      setB({ ...b, [which]: { ...b[which], kind: "image", image: fresh[which].image } });   // keep unsaved edits
      toast("Picture uploaded - Save to use it");
    } catch (e) { toast(e.message, "err"); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const mark = (m) => ({ kind: m.kind, icon: m.icon, palette: m.palette, c1: m.c1, c2: m.c2, fg: m.fg });
      const r = await api("/api/settings/brand", { method: "PUT", body: {
        app_name: b.app_name, tagline: b.tagline, favicon_same: b.favicon_same, logo: mark(b.logo), favicon: mark(b.favicon) } });
      setBrand(r.brand);
      toast("Saved");
      onSaved();
    } catch (e) { toast(e.message, "err"); }
    setBusy(false);
  };
  return html`<div class="form brand-form">
    <div class="brand-preview" aria-label="Preview">
      <div class="bp-tab"><span class="bp-fav"><${Logo} size=${16} mark=${fav} /></span><span class="bp-title">${name}</span><${Icon} name="x" size=${12} /></div>
      <div class="bp-bar"><${Logo} size=${28} mark=${logo} /><b>${name}</b></div>
      <div class="bp-login"><${Logo} size=${40} mark=${logo} /><b>${name}</b>${b.tagline && html`<small>${b.tagline}</small>`}</div>
    </div>
    <${Field} label="App name" hint="Shown in the top bar, the browser tab, the sign-in page, the setup wizard and the installed app.">
      <input value=${b.app_name} maxlength="40" onInput=${(e) => set("app_name", e.target.value)} /></${Field}>
    <${Field} label="Sign-in tagline" hint="The line under the name on the sign-in page. Leave empty for none.">
      <input value=${b.tagline} maxlength="80" onInput=${(e) => set("tagline", e.target.value)} /></${Field}>
    <${MarkEditor} title="Logo" hint="The top bar, the sign-in page and the installed app's icon." which="logo" b=${b}
      mark=${b.logo} onChange=${(m) => set("logo", m)} onUpload=${() => upload("logo")} />
    <${Toggle} checked=${b.favicon_same} onChange=${(v) => set("favicon_same", v)} label="Browser tab icon matches the logo"
      hint="Turn off to give the tab its own icon - a simpler one often reads better at 16 pixels." />
    ${!b.favicon_same && html`<${MarkEditor} title="Browser tab icon" which="favicon" b=${b}
      mark=${b.favicon} onChange=${(m) => set("favicon", m)} onUpload=${() => upload("favicon")} />`}
    <div class="form-actions">
      <button class="btn" onClick=${() => setB({ ...b, app_name: "VLAN Manager", tagline: "Switch port VLANs for UniFi", favicon_same: true,
        logo: { ...b.logo, kind: "default" }, favicon: { ...b.favicon, kind: "default" } })}>Back to stock</button>
      <button class="btn primary" disabled=${busy} onClick=${save}>Save</button></div>
  </div>`;
}

function MarkEditor({ title, hint, which, b, mark, onChange, onUpload }) {
  const m = mark;
  const set = (patch) => onChange({ ...m, ...patch });
  const preview = drawable(m, which, b);
  return html`<fieldset class="mark-ed">
    <legend>${title}</legend>
    ${hint && html`<small class="hint">${hint}</small>`}
    <div class="mark-head">
      <div class="mark-big"><${Logo} size=${56} mark=${preview} /></div>
      <${Segmented} value=${m.kind} onChange=${(v) => set({ kind: v })} options=${MARK_KINDS} />
    </div>
    ${m.kind === "icon" && html`
      <span class="field-label">Icon</span>
      <div class="icon-pick">${Object.keys(b.icons).map((k) => html`<button class=${`ip ${m.icon === k ? "on" : ""}`} title=${k}
        aria-label=${k} onClick=${() => set({ icon: k })}><${Logo} size=${30} mark=${{ ...preview, icon: k, path: b.icons[k] }} /></button>`)}</div>
      <span class="field-label">Colors</span>
      <div class="pal-pick">${Object.entries(b.palettes).map(([k, c]) => html`<button class=${`pal ${m.palette === k ? "on" : ""}`}
        onClick=${() => set({ palette: k })} title=${PALETTE_NAMES[k] || k}>
        <span class="pal-sw" style=${`background:linear-gradient(135deg,${c[0]},${c[1]});color:${c[2]}`}>A</span><span>${PALETTE_NAMES[k] || k}</span></button>`)}
        <button class=${`pal ${m.palette === "custom" ? "on" : ""}`} onClick=${() => set({ palette: "custom" })}>
          <span class="pal-sw custom"><${Icon} name="palette" size=${14} /></span><span>Custom</span></button></div>
      ${m.palette === "custom" && html`<div class="pal-custom">
        ${[["c1", "Top"], ["c2", "Bottom"], ["fg", "Icon"]].map(([k, l]) => html`<label><input type="color" value=${m[k]}
          onInput=${(e) => set({ [k]: e.target.value })} /><span>${l}</span><code>${m[k]}</code></label>`)}</div>`}`}
    ${m.kind === "image" && html`<div class="mark-upload">
      <button class="btn" onClick=${onUpload}><${Icon} name="upload" size=${15} />${m.image ? "Change picture" : "Upload a picture"}</button>
      <small class="hint">PNG, JPEG or WebP. It's made square (see-through parts stay see-through)${which === "favicon" ? "; small, bold pictures read best in a tab" : ""}.</small>
    </div>`}
  </fieldset>`;
}

// --- integrations: GitHub and notifications ----------------------------------------------------

const CHANNEL_INFO = {
  email: { label: "Email (SMTP)", icon: "comment", hint: "Any SMTP server: Microsoft 365, Gmail (app password), your own relay." },
  teams: { label: "Microsoft Teams", icon: "users", hint: "In Teams: channel → ⋯ → Workflows → \"Post to a channel when a webhook request is received\", then paste its URL." },
  slack: { label: "Slack", icon: "comment", hint: "A Slack app with Incoming Webhooks turned on; paste the webhook URL for the channel." },
  discord: { label: "Discord", icon: "comment", hint: "Channel settings → Integrations → Webhooks → New webhook → Copy webhook URL." },
  telegram: { label: "Telegram", icon: "send", hint: "Make a bot with @BotFather for its token. The chat ID is the group or user it posts to (a group's starts with -)." },
  webhook: { label: "Webhook (JSON)", icon: "link", hint: "Posts {event, title, text, url, item} as JSON, for anything else (n8n, Home Assistant, Power Automate…)." },
};

/** a secret field: shows that one is saved without showing it; typing replaces it */
function Secret({ label, has, value, onChange, onClear, placeholder, hint }) {
  return html`<${Field} label=${label} hint=${hint}>
    <div class="row"><input type="password" autocomplete="off" value=${value} placeholder=${has ? "✓ saved — type to replace" : placeholder || ""}
      onInput=${(e) => onChange(e.target.value)} />
      ${has && html`<button class="btn sm ghost" onClick=${onClear}>Clear</button>`}</div></${Field}>`;
}

function IntegrationsTab() {
  const [c, setC] = useState(null);
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState(null);
  const [ghInfo, setGhInfo] = useState(null);
  const load = () => api("/api/settings/integrations").then((x) => { setC(x); setGhInfo(null); }).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  if (!c) return html`<${Spinner} />`;
  const set = (sec, patch) => setC({ ...c, [sec]: { ...c[sec], ...patch } });
  const gh = c.github;
  const payload = () => {
    const out = {};
    for (const sec of ["github", ...Object.keys(CHANNEL_INFO)]) {
      const v = { ...c[sec] };
      for (const k of Object.keys(v)) if (k.startsWith("has_") || k === "last_sync") delete v[k];
      out[sec] = v;
    }
    return out;
  };
  const save = async () => {
    setBusy("save");
    try { const r = await api("/api/settings/integrations", { method: "PUT", body: payload() }); setC({ ...c, ...r }); toast("Saved"); }
    catch (e) { toast(e.message, "err"); }
    setBusy(null);
  };
  const clear = async (sec, key) => {
    try { const r = await api("/api/settings/integrations", { method: "PUT", body: { [sec]: { [`clear_${key}`]: true } } }); setC({ ...c, ...r }); toast("Removed"); }
    catch (e) { toast(e.message, "err"); }
  };
  const test = async (ch) => {
    setBusy(`test-${ch}`);
    try {
      const r = await api("/api/settings/integrations/test", { method: "POST", body: { channel: ch, settings: c[ch] } });
      if (ch === "github") { setGhInfo(r); toast(`Connected to ${r.repo}`); } else toast("Test sent - check that it arrived");
    } catch (e) { toast(e.message, "err"); if (ch === "github") setGhInfo({ error: e.message }); }
    setBusy(null);
  };
  const sync = async (push) => {
    setBusy(push ? "push" : "sync");
    try {
      const r = await api("/api/settings/integrations/github/sync", { method: "POST", body: { push } });
      toast(`${push ? `Sent ${r.sent} · ` : ""}${r.status} status change${r.status === 1 ? "" : "s"}, ${r.comments} comment${r.comments === 1 ? "" : "s"} from GitHub`);
    } catch (e) { toast(e.message, "err"); }
    setBusy(null);
  };
  const events = (sec) => html`<div class="int-events"><span class="field-label">Send</span>
    ${Object.entries(c.events).map(([k, l]) => html`<label class="tag-row" key=${k}><input type="checkbox" checked=${c[sec].events.includes(k)}
      onChange=${(e) => set(sec, { events: e.target.checked ? [...c[sec].events, k] : c[sec].events.filter((x) => x !== k) })} />${l}</label>`)}</div>`;

  return html`<div class="form int-form">
    <section class="int-card">
      <div class="int-head"><${Icon} name="link" size=${18} /><b>GitHub</b>
        ${gh.has_token ? html`<span class="badge good-badge">Token saved</span>` : html`<span class="badge">No token</span>`}</div>
      <p class="muted small">One token for the update check (needed once the repository is private) and for syncing feedback to issues.
        Use a <b>fine-grained personal access token</b> limited to the repositories you need, with <i>Contents: read</i> (releases) and${" "}
        <i>Issues: read and write</i>.</p>
      <${Secret} label="Token" has=${gh.has_token} value=${gh.token} placeholder="github_pat_…" onChange=${(v) => set("github", { token: v })}
        onClear=${() => clear("github", "token")} />
      <${Field} label="Check for updates from" hint=${`Leave empty for ${c.default_update_repo}.`}>
        <input value=${gh.update_repo} placeholder=${c.default_update_repo} onInput=${(e) => set("github", { update_repo: e.target.value })} /></${Field}>
      <${Toggle} checked=${gh.sync} onChange=${(v) => set("github", { sync: v })} label="Sync feedback with GitHub issues"
        hint="New bugs and ideas become issues; comments and status go both ways. Closing an issue marks it done here. Change requests are never sent." />
      ${gh.sync && html`<div class="int-sub">
        <${Field} label="Issues repository" hint="owner/name"><input value=${gh.repo} placeholder="you/your-repo" onInput=${(e) => set("github", { repo: e.target.value })} /></${Field}>
        <div class="int-events"><span class="field-label">Send</span>
          ${[["bug", "Bugs (label: bug)"], ["idea", "Ideas (label: enhancement)"]].map(([k, l]) => html`<label class="tag-row" key=${k}><input type="checkbox" checked=${gh.kinds.includes(k)}
            onChange=${(e) => set("github", { kinds: e.target.checked ? [...gh.kinds, k] : gh.kinds.filter((x) => x !== k) })} />${l}</label>`)}</div>
        <${Field} label="Extra label" hint="Added to every synced issue, to find them on GitHub. Leave empty for none.">
          <input value=${gh.label} onInput=${(e) => set("github", { label: e.target.value })} /></${Field}>
        <${Toggle} checked=${gh.show_author} onChange=${(v) => set("github", { show_author: v })} label="Include who reported it" hint="Their display name, in the issue and on synced comments." />
        <${Toggle} checked=${gh.show_context} onChange=${(v) => set("github", { show_context: v })} label="Include technical details"
          hint="Version, page, environment name, browser and screen." />
        ${ghInfo && !ghInfo.error && !ghInfo.private && html`<div class="notice warn"><${Icon} name="eye" /><div><b>${ghInfo.repo} is public.</b>
          Anyone can read the issues, including environment and device names in reports.</div></div>`}
        <div class="row">
          <button class="btn" disabled=${!!busy} onClick=${() => sync(false)}><${Icon} name="refresh" size=${14} />Sync now</button>
          <button class="btn" disabled=${!!busy} onClick=${() => sync(true)} title="Bugs and ideas posted before sync was on"><${Icon} name="upload" size=${14} />Send existing items</button>
          <span class="muted small">Every 10 minutes by itself${gh.last_sync ? ` · last ${ago(gh.last_sync)}` : ""}. Save first.</span></div>
      </div>`}
      <div class="row"><button class="btn" disabled=${!!busy} onClick=${() => test("github")}>${busy === "test-github" ? html`<${Spinner} />` : html`<${Icon} name="check" size=${14} />`}Test token</button>
        ${ghInfo && (ghInfo.error ? html`<span class="err-text small">${ghInfo.error}</span>`
          : html`<span class="muted small"><b>${ghInfo.repo}</b> · ${ghInfo.private ? "private" : "public"} · issues ${ghInfo.issues ? "on" : "off"}${ghInfo.triage ? "" : " · token can't write"}</span>`)}</div>
    </section>

    <h4 class="section">Notifications</h4>
    <p class="muted small">Turn on any mix. Each one picks its own events. Messages link to the item.</p>
    ${Object.entries(CHANNEL_INFO).map(([k, info]) => {
      const ch = c[k];
      const shown = open[k] ?? ch.enabled;
      return html`<section class=${"int-card" + (ch.enabled ? " on" : "")} key=${k}>
        <div class="int-head"><${Icon} name=${info.icon} size=${18} /><b>${info.label}</b>
          <span class="grow"></span>
          <${Toggle} checked=${ch.enabled} onChange=${(v) => { set(k, { enabled: v }); setOpen({ ...open, [k]: v || open[k] }); }} label="" />
          <button class="icon-btn sm" onClick=${() => setOpen({ ...open, [k]: !shown })} aria-label="Settings"><span class="chev" style=${shown ? "" : "transform:rotate(-90deg)"}><${Icon} name="chevron" /></span></button></div>
        ${shown && html`<div class="int-sub">
          <p class="muted small">${info.hint}</p>
          ${k === "email" && html`
            <div class="int-grid">
              <${Field} label="SMTP server"><input value=${ch.host} placeholder="smtp.office365.com" onInput=${(e) => set(k, { host: e.target.value })} /></${Field}>
              <${Field} label="Port"><input type="number" value=${ch.port} onInput=${(e) => set(k, { port: e.target.value })} /></${Field}>
            </div>
            <${Field} label="Security"><${Segmented} value=${ch.security} onChange=${(v) => set(k, { security: v, port: v === "ssl" ? 465 : v === "starttls" ? 587 : 25 })}
              options=${[{ value: "starttls", label: "STARTTLS" }, { value: "ssl", label: "SSL / TLS" }, { value: "none", label: "None" }]} /></${Field}>
            <div class="int-grid">
              <${Field} label="Username"><input value=${ch.username} autocomplete="off" onInput=${(e) => set(k, { username: e.target.value })} /></${Field}>
              <${Secret} label="Password" has=${ch.has_password} value=${ch.password} onChange=${(v) => set(k, { password: v })} onClear=${() => clear(k, "password")} />
            </div>
            <${Field} label="From" hint="Leave empty to use the username."><input value=${ch.sender} placeholder="VLAN Manager <it@example.com>" onInput=${(e) => set(k, { sender: e.target.value })} /></${Field}>
            <${Field} label="Send to" hint="Comma separated, e.g. the IT team."><input value=${ch.to} placeholder="it@example.com" onInput=${(e) => set(k, { to: e.target.value })} /></${Field}>
            <${Toggle} checked=${ch.people} onChange=${(v) => set(k, { people: v })} label="Also email the people involved"
              hint="Whoever reported, voted on or commented on an item hears about its status changes and comments (if they have an email)." />`}
          ${["teams", "slack", "discord", "webhook"].includes(k) && html`<${Secret} label="Webhook URL" has=${ch.has_url} value=${ch.url} placeholder="https://…"
            onChange=${(v) => set(k, { url: v })} onClear=${() => clear(k, "url")} />`}
          ${k === "telegram" && html`<div class="int-grid">
            <${Secret} label="Bot token" has=${ch.has_bot_token} value=${ch.bot_token} placeholder="123456:ABC…" onChange=${(v) => set(k, { bot_token: v })} onClear=${() => clear(k, "bot_token")} />
            <${Field} label="Chat ID"><input value=${ch.chat_id} placeholder="-1001234567890" onInput=${(e) => set(k, { chat_id: e.target.value })} /></${Field}></div>`}
          ${events(k)}
          <div class="row"><button class="btn sm" disabled=${!!busy} onClick=${() => test(k)}>${busy === `test-${k}` ? html`<${Spinner} />` : html`<${Icon} name="send" size=${14} />`}Send a test</button>
            <span class="muted small">Uses what's on screen; saved secrets fill in the rest.</span></div>
        </div>`}
      </section>`;
    })}
    <div class="form-actions"><button class="btn primary" disabled=${!!busy} onClick=${save}>Save</button></div>
  </div>`;
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
  const blank = { username: "", display_name: "", email: "", password: "", role: "", sso: false, with_pw: false, must_change: true };
  const [form, setForm] = useState(blank);
  const [pwFor, setPwFor] = useState(null);
  const [mergeFrom, setMergeFrom] = useState(null);
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
    footer=${tab === "people" && data && html`<span class="muted grow">New people start with the lowest role and no environments. Add someone here with their email
      and they're ready on their first SSO sign-in; anyone else who signs in with SSO waits until you set them up.</span>
      ${can("users.create") && html`<button class="btn primary" onClick=${() => setAdding(!adding)}><${Icon} name="plus" />Add user</button>`}`}>
    ${data && data.super && html`<nav class="tabs"><button class=${tab === "people" ? "on" : ""} onClick=${() => setTab("people")}><${Icon} name="users" size=${15} />People</button>
      <button class=${tab === "roles" ? "on" : ""} onClick=${() => setTab("roles")}><${Icon} name="shield" size=${15} />Roles & abilities</button></nav>`}
    ${!data ? html`<${Spinner} />` : tab === "roles" ? html`<${RolesEditor} onChanged=${load} />` : html`
    ${adding && html`<div class="panel add-user">
      <${Toggle} checked=${!!form.sso} onChange=${(v) => setForm({ ...form, sso: v })} label="Will sign in with SSO"
        hint="Their first SSO sign-in finds this account by their (verified) email and they're ready to go." />
      ${form.sso && html`<${Toggle} checked=${form.with_pw} onChange=${(v) => setForm({ ...form, with_pw: v, password: v ? form.password : "" })}
        label="Can also sign in with a password" hint="For when SSO is down, or on a device without it." />`}
      <div class="grid3">
        ${(!form.sso || form.with_pw) && html`<${Field} label="Username" hint=${form.sso ? "Leave empty to use the part of their email before @." : ""}>
          <input value=${form.username} autocomplete="off" onInput=${(e) => setForm({ ...form, username: e.target.value })} /></${Field}>`}
        <${Field} label="Display name"><input value=${form.display_name} onInput=${(e) => setForm({ ...form, display_name: e.target.value })} /></${Field}>
        <${Field} label=${form.sso ? "Email (required)" : "Email"}><input type="email" value=${form.email} onInput=${(e) => setForm({ ...form, email: e.target.value })} /></${Field}>
        ${(!form.sso || form.with_pw) && html`<${Field} label=${form.sso ? "Password" : "Password"} hint="A temporary one to give them, 8+ characters.">
          <input type="password" autocomplete="new-password" value=${form.password} onInput=${(e) => setForm({ ...form, password: e.target.value })} /></${Field}>`}
        ${(data.admin || can("users.roles")) && html`<${Field} label="Role"><select value=${form.role || rolesByLevel[rolesByLevel.length - 1].key} onChange=${(e) => setForm({ ...form, role: e.target.value })}>
          ${rolesByLevel.filter((r) => data.assignable_roles.includes(r.key)).map((r) => html`<option value=${r.key}>${r.name}</option>`)}</select></${Field}>`}
        ${form.password && html`<div class="field span3"><${Toggle} checked=${form.must_change} onChange=${(v) => setForm({ ...form, must_change: v })}
          label="They choose their own password at first sign-in" hint="Before they see anything else. Recommended: you know the one you set." /></div>`}
        <div class="field end"><button class="btn primary" onClick=${async () => {
          try {
            const { with_pw, ...body } = form;
            const r = await api("/api/users", { method: "POST", body });
            toast(`Added ${form.display_name || r.user.username}`); setForm(blank); setAdding(false);
            if (r.user.role !== "superadmin" && can("users.access")) setView({ kind: "access", user: r.user }); else load();
          } catch (e) { toast(e.message, "err"); }
        }}>Create</button></div>
      </div></div>`}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>User</th><th>Role</th><th>Access</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
      <tbody>${data.users.map((u) => {
        const self = u.id === me.id;
        const locked = u.manageable === false;   // a super admin, seen by an admin
        const extra = u.caps_grant.length + u.caps_deny.length;
        return html`<tr key=${u.id} class=${u.disabled ? "disabled" : ""}>
        <td><div class="u-cell"><${Avatar} user=${u} size=${32} />${u.avatar_locked ? html`<span class="av-lock" title="Picture locked"><${Icon} name="lock" size=${10} /></span>` : null}
          <div><b>${u.display_name || u.username}</b>${u.seeded && html` <span class="badge">first admin</span>`}
            ${u.pending && html` <span class="badge warn" title="Signed in with SSO; sees a 'your admin hasn't set you up yet' page until you give them access, a role or abilities">waiting for setup</span>`}
            ${u.must_change_password && html` <span class="badge" title="An admin set their password; they choose their own at next sign-in">new password due</span>`}
            <div class="muted small">${u.username}${u.email ? ` · ${u.email}` : ""}${u.sso ? (u.has_password ? " · SSO + password" : " · SSO") : u.sso_allowed ? (u.has_password ? " · password, SSO ready" : " · SSO ready") : ""}</div></div></div></td>
        <td>${!self && !locked && (data.admin || can("users.roles")) && (data.admin || data.assignable_roles.includes(u.role))
            ? html`<select class="sm" value=${u.role} onChange=${(e) => update(u, { role: e.target.value }, `${u.username} is now ${roleName(data.roles, e.target.value)}`)}>
                ${rolesByLevel.filter((r) => data.assignable_roles.includes(r.key) || r.key === u.role).map((r) => html`<option value=${r.key}>${r.name}</option>`)}</select>`
            : html`<span class=${"role-badge " + u.role}>${u.role_name}</span>`}
          ${extra > 0 && html`<div class="muted small" title="Abilities changed for this person">${u.caps_grant.length ? `+${u.caps_grant.length}` : ""}${u.caps_grant.length && u.caps_deny.length ? " " : ""}${u.caps_deny.length ? `−${u.caps_deny.length}` : ""} abilities</div>`}</td>
        <td>${u.role === "superadmin" || u.caps.includes("envs.manage") ? html`<span class="badge good">All environments</span>`
          : can("users.access") && !self ? html`<button class=${"btn sm " + (u.envs ? "ghost" : "primary")} onClick=${() => setView({ kind: "access", user: u })}>
              <${Icon} name="shield" size=${14} />${u.envs ? `${u.envs} environment${u.envs > 1 ? "s" : ""}` : "Give access"}</button>`
          : html`<span class="muted small">${u.envs} environment${u.envs === 1 ? "" : "s"}</span>`}</td>
        <td class="muted small">${ago(u.last_login)}${u.sessions ? html`<div>${u.sessions} active session${u.sessions > 1 ? "s" : ""}</div>` : null}</td>
        <td>${!self && !locked && can("users.edit") ? html`<${Toggle} checked=${!u.disabled} onChange=${(on) => update(u, { disabled: !on }, on ? "Enabled" : "Disabled")} label=${u.disabled ? "Disabled" : "Active"} />` : html`<span class="muted small">${self ? "you" : u.disabled ? "disabled" : "active"}</span>`}</td>
        <td class="actions">${locked ? html`<span class="muted small" title="Only super admins manage super admins">super admin</span>` : html`
          ${!self && !isFull(u.role) && !u.disabled && !me.impersonator && can("users.view_as") && html`<button class="icon-btn sm" title=${`View as ${u.username}`} onClick=${async () => {
            try { await api(`/api/users/${u.id}/impersonate`, { method: "POST" }); location.href = "/"; } catch (e) { toast(e.message, "err"); }
          }}><${Icon} name="eye" size=${15} /></button>`}
          ${(data.admin || (!self && (can("users.edit") || can("users.roles")))) && html`<button class="icon-btn sm" title="Edit, abilities" onClick=${() => setView({ kind: "edit", user: u })}><${Icon} name="user" size=${15} /></button>`}
          ${!self && can("users.edit") && html`<button class="icon-btn sm" title="Set password" onClick=${() => setPwFor(u)}><${Icon} name="key" size=${15} /></button>`}
          ${!self && data.super && html`<button class="icon-btn sm" title="Merge into another account" onClick=${() => setMergeFrom(u)}><${Icon} name="merge" size=${15} /></button>`}
          ${u.sessions > 0 && !self && can("users.edit") && html`<button class="icon-btn sm" title="Sign out everywhere" onClick=${() => update(u, { sign_out: true }, "Signed out")}><${Icon} name="logout" size=${15} /></button>`}
          ${!self && can("users.delete") && html`<button class="icon-btn sm danger" title="Delete" onClick=${async () => {
            if (await ask({ title: `Delete ${u.username}?`, body: "Their sessions, sign-in links and access are removed too.", danger: true, confirm: "Delete" })) {
              try { await api(`/api/users/${u.id}`, { method: "DELETE" }); toast("Deleted"); load(); } catch (e) { toast(e.message, "err"); }
            }
          }}><${Icon} name="trash" size=${15} /></button>`}`}
        </td></tr>`;
      })}</tbody></table></div>`}
    ${mergeFrom && html`<${MergeModal} from=${mergeFrom} users=${data.users} me=${me} onClose=${() => setMergeFrom(null)}
      onDone=${() => { setMergeFrom(null); load(); }} />`}
    ${pwFor && html`<${SetPasswordModal} user=${pwFor} onClose=${() => setPwFor(null)}
      onSave=${async (body) => { if (await update(pwFor, body, body.must_change ? "Password set - they'll choose their own at next sign-in" : "Password set")) setPwFor(null); }} />`}
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
      work on people with a lower level. Admin, Supervisor and Viewer start with sensible defaults: tune them here, and allow or
      deny single abilities per person (Users → edit). Super admin always has everything.</p>
    <div class="role-list">
    ${roles.map((r0) => {
      const r = val(r0);
      const admin = r.key === "superadmin";   // the one fixed role
      const dirty = !!edits[r.key];
      return html`<div class=${"role-card" + (admin ? " admin" : "")} key=${r.key}>
        <div class="role-head">
          ${admin ? html`<b class="role-title">${r.name}</b>` : html`<input class="role-name" value=${r.name} onInput=${(e) => put(r.key, { name: e.target.value })} />`}
          ${admin ? html`<span class="role-level">Level <b>${r.level}</b></span>` : html`<label class="role-level" title=${r.builtin ? "Built-in roles keep their level" : "11 – 99"}>Level
            <input type="number" min="11" max="99" value=${r.level} disabled=${r.builtin} onInput=${(e) => put(r.key, { level: e.target.value })} /></label>`}
          <span class="badge">${r0.users} ${r0.users === 1 ? "person" : "people"}</span>
          <span class="grow"></span>
          ${!r.builtin && html`<button class="btn sm ghost danger-text" onClick=${async () => {
            const others = roles.filter((x) => x.key !== r.key && x.key !== "superadmin");
            const move = prompt(`Delete ${r.name}? Its people move to another role. Type one of: ${others.map((x) => x.name).join(", ")}`, others[others.length - 1].name);
            if (!move) return;
            const target = others.find((x) => x.name.toLowerCase() === move.trim().toLowerCase());
            if (!target) return toast("No such role", "err");
            try { await api(`/api/roles/${r.key}`, { method: "DELETE", body: { move_to: target.key } }); toast("Role deleted"); load(); onChanged(); } catch (e) { toast(e.message, "err"); }
            return null;
          }}>Delete</button>`}
          ${r0.default && html`<button class="btn sm ghost" title="Back to the abilities it came with"
            disabled=${!dirty && [...r0.caps].sort().join() === [...r0.default].sort().join()}
            onClick=${async () => { try { await api(`/api/roles/${r.key}`, { method: "PUT", body: { reset: true } }); toast(`${r.name}: back to defaults`); load(); onChanged(); } catch (e) { toast(e.message, "err"); } }}>Defaults</button>`}
          ${!admin && html`<button class="btn sm primary" disabled=${!dirty} onClick=${() => save(r0)}>Save</button>`}
        </div>
        ${admin ? html`<p class="muted small">Everything, always, including anything added in future versions. Only super admins edit roles,
            manage super admins, merge accounts and set up integrations and how long activity is kept.</p>`
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
          ${roles.filter((x) => x.key !== "superadmin").map((x) => html`<option value=${x.key}>${x.name}</option>`)}</select></${Field}>
      </div>
      <div class="form-actions"><button class="btn ghost" onClick=${() => setAdding(null)}>Cancel</button><button class="btn primary" onClick=${async () => {
        const from = roles.find((x) => x.key === adding.from);
        try { await api("/api/roles", { method: "POST", body: { name: adding.name, level: adding.level, caps: from ? from.caps : [] } }); toast("Role added"); setAdding(null); load(); onChanged(); } catch (e) { toast(e.message, "err"); }
      }}>Add role</button></div></div>`
      : html`<div class="form-actions"><button class="btn primary" onClick=${() => setAdding({ name: "", level: 30, from: "supervisor" })}><${Icon} name="plus" />Add a role</button></div>`}
  </div>`;
}

/** Super admins: fold one account into another, e.g. someone's local and SSO accounts. */
function MergeModal({ from, users, me, onClose, onDone }) {
  const others = users.filter((u) => u.id !== from.id);
  const [into, setInto] = useState((others.find((u) => u.id === me.id) || others[0] || {}).id);
  const [busy, setBusy] = useState(false);
  const target = others.find((u) => u.id === Number(into));
  const name = (u) => u.display_name || u.username;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/users/${target.id}/merge`, { method: "POST", body: { from: from.id } });
      toast(`${name(from)} merged into ${name(r.user)}`); onDone();
    } catch (e) { toast(e.message, "err"); setBusy(false); }
  };
  return html`<${Modal} title=${`Merge ${name(from)}`} icon="merge" onClose=${onClose}
    footer=${html`<button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn danger" disabled=${busy || !target} onClick=${go}>Merge and delete ${from.username}</button>`}>
    <div class="form">
      <p>For one person with two accounts, like a local login and an SSO login. Everything moves into the account you keep:</p>
      <ul class="small">
        <li>its <b>SSO link</b>${from.sso ? " (this account has one)" : ""} and its <b>password</b> if the kept account has none</li>
        <li>the <b>higher role</b> of the two, their environments, sign-in links and per-person abilities</li>
        <li>their feedback, votes and comments; their email and name if the kept account has none</li>
      </ul>
      <${Field} label="Keep this account">
        <select value=${into} onChange=${(e) => setInto(Number(e.target.value))}>
          ${others.map((u) => html`<option value=${u.id}>${name(u)} (${u.username}${u.sso ? ", SSO" : ""}${u.has_password ? ", password" : ""}) · ${u.role_name}</option>`)}</select></${Field}>
      <p class="muted small"><b>${from.username}</b> is deleted afterwards. The activity log keeps its entries under the old name.</p>
    </div></${Modal}>`;
}

/** An admin sets someone's password: temporary by default (they choose their own at next sign-in). */
function SetPasswordModal({ user, onClose, onSave }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [must, setMust] = useState(true);
  const gen = () => {
    const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const r = crypto.getRandomValues(new Uint32Array(14));
    setPw(Array.from(r, (x) => a[x % a.length]).join("")); setShow(true);
  };
  return html`<${Modal} title=${`Password · ${user.display_name || user.username}`} icon="key" onClose=${onClose}
    footer=${html`<button class="btn ghost" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${pw.length < 8} onClick=${() => onSave({ password: pw, must_change: must })}>Set password</button>`}>
    <div class="form">
      <${Field} label="New password" hint="8+ characters. Generate makes a random one you can copy.">
        <div class="row"><input type=${show ? "text" : "password"} autocomplete="new-password" value=${pw} onInput=${(e) => setPw(e.target.value)} />
          <button class="btn sm ghost" onClick=${() => setShow(!show)}>${show ? "Hide" : "Show"}</button>
          <button class="btn sm" onClick=${gen}>Generate</button>${show && pw && html`<${Copy} text=${pw} />`}</div></${Field}>
      <${Toggle} checked=${must} onChange=${setMust} label="They choose their own password at next sign-in"
        hint="Before they see anything else, including What's new and the setup. Their open sessions end now." />
      ${user.sso && html`<p class="muted small">They also sign in with SSO; this adds password sign-in for them.</p>`}
    </div></${Modal}>`;
}

function UserEditor({ user, data, me, onSave, onCancel }) {
  const [f, setF] = useState({ username: user.username, display_name: user.display_name || "", email: user.email || "",
    sso_allowed: !!user.sso_allowed });
  const [grant, setGrant] = useState(user.caps_grant || []);
  const [deny, setDeny] = useState(user.caps_deny || []);
  const mayEdit = data.admin || data.my_caps.includes("users.edit");
  const mayRoles = (data.admin || data.my_caps.includes("users.roles")) && user.role !== "superadmin" && user.id !== me.id;
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
    ${mayEdit && (user.sso ? html`<p class="muted small"><${Icon} name="shield" size=${13} /> Signs in with SSO${user.has_password ? " and with a password" : ""}.</p>`
      : html`<${Toggle} checked=${f.sso_allowed} onChange=${(v) => setF({ ...f, sso_allowed: v })} label="Can sign in with SSO"
          hint=${f.email ? `Their first SSO sign-in with the verified email ${f.email} links to this account. Password sign-in keeps working.` : "Add their email: a first SSO sign-in with that verified email links to this account."} />`)}
    ${mayRoles && html`<h4 class="section">Abilities</h4>
      <p class="muted small">From their role (<b>${user.role_name}</b>) unless you allow or deny one here.${data.admin ? "" : " You can only hand out abilities you have yourself."}</p>
      <div class="cap-grid">${capGroups(data.caps).map((g) => html`<div class="cap-group"><div class="field-label">${g.group}</div>
        ${g.caps.map((c) => {
          const st = stateOf(c.key);
          const fromRole = roleCaps.includes(c.key);
          const on = st === "allow" || (st === "role" && fromRole);
          // the administration abilities are a super admin's to give; anything else, if you have it
          const mine = data.admin_caps.includes(c.key) ? data.super : data.admin || data.my_caps.includes(c.key);
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
    ${(user.role === "superadmin" || (user.caps || []).includes("envs.manage")) && html`<div class="notice"><${Icon} name="info" /><div>${user.role === "superadmin" ? "Super admins" : "People who manage environments"} always have every environment. This only matters if you change their role.</div></div>`}
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
  "settings.app": "Settings changed", "settings.auth": "Sign-in settings changed", "user.merged": "Accounts merged",
  "user.password_removed": "Password removed",
  "user.access": "Access changed", "env.created": "Environment added", "env.updated": "Environment changed",
  "env.deleted": "Environment deleted", "port.locked": "Port locked", "port.unlocked": "Port unlocked",
  "port.lock_reapplied": "Locked settings re-applied", "role.created": "Role added", "role.updated": "Role changed",
  "role.deleted": "Role deleted", "user.avatar": "Picture changed", "user.impersonate": "Started viewing as",
  "user.impersonate_stop": "Stopped viewing as", "port.undo": "Change undone", "port.power_cycle": "PoE power-cycled",
  "device.restart": "Device restarted", "device.locate": "Locate light on", "device.locate_off": "Locate light off", "device.upgrade": "Firmware update", "device.updated": "Device changed", "settings.brand": "Branding changed",
  "settings.integrations": "Integrations changed", "settings.audit_retention": "Activity retention changed",
  "github.sync": "GitHub synced", "feedback.new": "Feedback posted", "feedback.edit": "Feedback changed",
  "feedback.delete": "Feedback deleted", "request.new": "Change requested", "request.approved": "Request approved",
  "request.declined": "Request declined",
};

const AUDIT_KINDS = [["", "Everything"], ["ports", "Port changes"], ["devices", "Devices"], ["people", "People & sign-in"],
  ["settings", "Settings"], ["feedback", "Feedback & requests"]];
const RANGES = [["", "Any time"], ["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["custom", "Pick dates"]];
const RETENTION = [[0, "Forever"], [30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"], [730, "2 years"]];

const dayStart = (ts) => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d; };
function dayLabel(d) {
  const today = dayStart(Date.now() / 1000);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
/** "admin (as vera)" -> "admin" for grouping by person */
const actor = (r) => (r.username || "?").replace(/ \(as .*\)$/, "");

const STORE_COLORS = { "db.activity": "#60a5fa", "db.feedback": "#a78bfa", "db.people": "#34d399", "db.other": "#94a3b8",
  "db.free": "#475569", db: "#60a5fa", "files.feedback": "#f472b6", "files.avatars": "#fbbf24", "files.brand": "#fb923c",
  "files.backups": "#2dd4bf" };

/** Super admins: what the app's data folder holds, and how full the disk under it is. Loads when opened. */
function StoragePanel() {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(null);
  useEffect(() => { if (open && !s) api("/api/admin/storage").then(setS).catch((e) => toast(e.message, "err")); }, [open]);
  const pct = (n, of) => (of ? Math.max(n ? 0.6 : 0, (n / of) * 100) : 0);
  return html`<details class="storage" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
    <summary><${Icon} name="layers" size=${15} /><b>Storage</b>${s && html`<span class="muted small"> · the app uses ${bytes(s.total)}${s.disk ? ` · ${bytes(s.disk.free)} free on the disk` : ""}</span>`}</summary>
    ${open && !s && html`<${Spinner} />`}
    ${s && html`<div class="storage-body">
      <div class="store-bar" role="img" aria-label="What the app's data uses">
        ${s.parts.filter((p) => p.bytes).map((p) => html`<span title=${`${p.label}: ${bytes(p.bytes)}`} style=${`width:${pct(p.bytes, s.total)}%;background:${STORE_COLORS[p.key] || "#64748b"}`}></span>`)}</div>
      <div class="store-groups">${["Database", "Files"].map((g) => html`<div class="store-group" key=${g}>
        <div class="field-label">${g}${g === "Database" ? html`<span class="muted"> · ${bytes(s.database)} file</span>` : ""}</div>
        ${s.parts.filter((p) => p.group === g).map((p) => html`<div class="store-row" key=${p.key}>
          <span class="store-dot" style=${`background:${STORE_COLORS[p.key] || "#64748b"}`}></span>
          <span class="store-label">${p.label}${p.files != null && p.files > 0 ? html`<span class="muted small"> · ${p.files} file${p.files === 1 ? "" : "s"}</span>` : ""}</span>
          <b class="store-size">${bytes(p.bytes)}</b></div>`)}</div>`)}</div>
      ${s.disk && html`<div class="store-disk">
        <div class="field-label">Disk${s.data_dir ? html`<span class="muted"> · ${s.data_dir}</span>` : ""}</div>
        <div class="store-bar disk"><span style=${`width:${pct(s.disk.used - s.total, s.disk.total)}%;background:#64748b`} title="Everything else on the disk"></span>
          <span style=${`width:${pct(s.total, s.disk.total)}%;background:var(--accent)`} title="This app"></span></div>
        <div class="muted small">${bytes(s.disk.used)} of ${bytes(s.disk.total)} used (this app ${bytes(s.total)}) · <b>${bytes(s.disk.free)} free</b></div></div>`}
      <p class="muted small">Upgrade backups: the newest ${s.backups_kept} are kept (${s.backups} now). Activity follows the retention above;
        deleted feedback takes its screenshot with it.</p>
    </div>`}
  </details>`;
}

export function AuditModal({ onClose, me }) {
  const can = (c) => ((me && me.caps) || []).includes(c);
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ q: "", user: "", kind: "", range: "", from: "", to: "", order: "desc", group: "day" });
  const [closed, setClosed] = useState({});
  const [busy, setBusy] = useState(null);
  const params = (extra = {}) => {
    const p = new URLSearchParams();
    if (f.q.trim()) p.set("q", f.q.trim());
    if (f.user) p.set("user", f.user);
    if (f.kind) p.set("kind", f.kind);
    if (f.order === "asc") p.set("order", "asc");
    const now = Date.now() / 1000;
    if (f.range === "today") p.set("since", Math.floor(dayStart(now) / 1000));
    if (f.range === "7" || f.range === "30") p.set("since", Math.floor(dayStart(now) / 1000) - (Number(f.range) - 1) * 86400);
    if (f.range === "custom") {
      if (f.from) p.set("since", Math.floor(new Date(`${f.from}T00:00`) / 1000));
      if (f.to) p.set("until", Math.floor(new Date(`${f.to}T00:00`) / 1000) + 86400);
    }
    Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    return p.toString();
  };
  const load = async (append) => {
    try {
      const last = append && rows && rows[rows.length - 1];
      const r = await api(`/api/audit?${params({ limit: 200, ...(last ? { [f.order === "asc" ? "after" : "before"]: last.id } : {}), ...(meta ? {} : { meta: 1 }) })}`);
      setRows(append ? [...rows, ...r.entries] : r.entries);
      setMore(r.has_more);
      if (r.people) setMeta(r);
    } catch (e) { toast(e.message, "err"); }
  };
  // filters apply as you type / pick (text waits a moment)
  useEffect(() => { const t = setTimeout(() => load(false), f.q ? 300 : 0); return () => clearTimeout(t); }, [JSON.stringify(f)]);
  const set = (patch) => setF({ ...f, ...patch });

  const undo = async (r, extra = {}) => {
    if (!Object.keys(extra).length && !(await ask({ title: "Undo this change?", confirm: "Undo it",
      body: html`<p><b>${r.target}</b> goes back to <b>${r.detail.before.native} · ${r.detail.before.tagged}</b>.</p>
        <p class="muted small">It's done as you, with the usual checks, and logged as an undo.</p>` }))) return;
    setBusy(r.id);
    try {
      const x = await api(`/api/audit/${r.id}/undo`, { method: "POST", body: extra });
      toast("Undone");
      if (x.warning) toast(x.warning, "warn");
      await load(false);
    } catch (e) {
      const c = e.status === 409 && e.data && e.data.confirm;
      const again = c === "changed" ? await ask({ title: "Port changed since", danger: true, confirm: "Undo anyway",
          body: html`<p>The port was changed after this entry. It's now <b>${e.data.current.native}</b>, ${e.data.current.tagged}.</p><p>Put it back to how it was before this change anyway?</p>` })
        : c === "protected" ? await ask({ title: "Change a protected port?", danger: true, confirm: "Change it anyway",
          body: html`<p>This port is protected:</p><ul>${e.data.reasons.map((x) => html`<li>${x}</li>`)}</ul>` })
        : c === "profile" ? await ask({ title: "Detach port profile?", confirm: "Detach and undo",
          body: html`<p>The port now uses the port profile <b>${e.data.profile}</b>. Undoing detaches it.</p>` })
        : c === "locked" ? await ask({ title: "Change a locked port?", confirm: "Change and keep locked", body: html`<p>It stays locked, to the restored settings.</p>` })
        : (toast(e.message, "err"), false);
      setBusy(null);
      if (again) return undo(r, { ...extra, [{ changed: "confirm_changed", protected: "confirm_protected", profile: "detach_profile", locked: "confirm_locked" }[c]]: true });
    }
    setBusy(null);
    return null;
  };
  const setRetention = async (days) => {
    const opt = RETENTION.find(([d]) => d === days);
    if (days && meta.oldest && meta.oldest < Date.now() / 1000 - days * 86400
      && !(await ask({ title: `Keep ${opt[1]} of activity?`, danger: true, confirm: "Delete older entries",
        body: html`<p>Entries older than ${opt[1].toLowerCase()} are deleted now, and from then on every day. This can't be undone.</p>` }))) return;
    try {
      const r = await api("/api/audit/retention", { method: "PUT", body: { days } });
      toast(days ? `Keeping ${opt[1]}${r.removed ? ` · ${r.removed} older entries deleted` : ""}` : "Keeping everything");
      setMeta({ ...meta, retention_days: days, log_count: r.log_count, log_size: r.log_size, db_size: r.db_size }); load(false);
    } catch (e) { toast(e.message, "err"); }
  };

  // groups: by day or by person, in the chosen order
  const groups = [];
  for (const r of rows || []) {
    const key = f.group === "person" ? actor(r) : dayStart(r.ts).getTime();
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, label: f.group === "person" ? key : dayLabel(dayStart(r.ts)), rows: [] });
    g.rows.push(r);
  }
  if (f.group === "person") groups.sort((a, b) => a.label.localeCompare(b.label));
  const allClosed = groups.length > 0 && groups.every((g) => closed[`${f.group}:${g.key}`]);
  const toggleAll = () => setClosed(allClosed ? {} : Object.fromEntries(groups.map((g) => [`${f.group}:${g.key}`, true])));

  const entry = (r) => {
    const d = r.detail || {};
    const undoable = can("ports.change") && r.ok && (r.action === "port.set" || r.action === "port.undo") && d.undo && d.device_id && !r.undone_by;
    return html`<div class=${"tl" + (r.ok ? "" : " fail")} key=${r.id}>
      <div class="tl-dot"></div>
      <div class="tl-main">
        <div class="tl-head"><b>${ACTION_LABEL[r.action] || r.action}</b>${r.target && html`<span class="muted"> · ${r.target}</span>`}
          ${(r.action === "port.set" || r.action === "port.undo" || r.action === "port.lock_reapplied") && r.ok && (d.verified ? html`<span class="badge good">verified</span>` : d.verified === false ? html`<span class="badge warn">unverified</span>` : null)}
          ${r.undone_by && html`<span class="badge">undone</span>`}
          ${!r.ok && html`<span class="badge err">failed</span>`}</div>
        ${d.before && d.after && html`<div class="tl-diff">
          <span>${d.before.native} · ${d.before.tagged}</span><span class="arrow">→</span><b>${d.after.native} · ${d.after.tagged}</b>
          ${d.after.excluded && d.after.excluded.length > 0 && html`<span class="muted small"> (not tagged: ${d.after.excluded.join(", ")})</span>`}</div>`}
        ${d.via && html`<div class="muted small">${d.via}</div>`}
        ${d.note && html`<div class="muted small">“${d.note}”</div>`}
        ${d.error && html`<div class="err-text small">${d.error}</div>`}
        <div class="tl-foot"><span class="muted small">${f.group === "person" ? html`${dayLabel(dayStart(r.ts))}, ${new Date(r.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : html`${r.username || "?"}${r.role ? ` (${r.role})` : ""} · ${new Date(r.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}${r.ip ? ` · ${r.ip}` : ""}</span>
          ${undoable && html`<button class="btn sm ghost" disabled=${busy === r.id} onClick=${() => undo(r)}><${Icon} name="refresh" size=${13} />Undo</button>`}</div>
      </div></div>`;
  };

  return html`<${Modal} title="Activity" icon="list" onClose=${onClose} wide>
    <div class="audit-tools">
      <div class="search"><${Icon} name="search" /><input placeholder="Search device, port, network, environment…" value=${f.q} onInput=${(e) => set({ q: e.target.value })} /></div>
      <div class="audit-filters">
        <label class="audit-sel"><${Icon} name="user" size=${14} /><select value=${f.user} onChange=${(e) => set({ user: e.target.value })} aria-label="Person">
          <option value="">Everyone</option>${(meta ? meta.people : []).map((p) => html`<option value=${p}>${p}</option>`)}</select></label>
        <label class="audit-sel"><${Icon} name="list" size=${14} /><select value=${f.kind} onChange=${(e) => set({ kind: e.target.value })} aria-label="What">
          ${AUDIT_KINDS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
        <label class="audit-sel"><${Icon} name="clock" size=${14} /><select value=${f.range} onChange=${(e) => set({ range: e.target.value })} aria-label="When">
          ${RANGES.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
        ${f.range === "custom" && html`<span class="audit-dates"><input type="date" value=${f.from} onInput=${(e) => set({ from: e.target.value })} aria-label="From" />
          <span class="muted">to</span><input type="date" value=${f.to} onInput=${(e) => set({ to: e.target.value })} aria-label="To" /></span>`}
      </div>
      <div class="audit-filters">
        <span class="muted small">Group by</span><${Segmented} value=${f.group} onChange=${(v) => set({ group: v })}
          options=${[{ value: "day", label: "Day" }, { value: "person", label: "Person" }]} />
        <${Segmented} value=${f.order} onChange=${(v) => set({ order: v })} options=${[{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }]} />
        <span class="grow"></span>
        ${groups.length > 1 && html`<button class="link-btn small" onClick=${toggleAll}>${allClosed ? "Expand all" : "Collapse all"}</button>`}
      </div>
    </div>
    ${!rows ? html`<${Spinner} />` : rows.length === 0 ? html`<div class="empty-sm">Nothing ${f.q || f.user || f.kind || f.range ? "matches" : "yet"}.</div>` : html`
      ${groups.map((g) => {
        const k = `${f.group}:${g.key}`;
        return html`<section class="audit-group" key=${k}>
          <button class="group-head" onClick=${() => setClosed({ ...closed, [k]: !closed[k] })} aria-expanded=${!closed[k]}>
            <${Icon} name=${f.group === "person" ? "user" : "clock"} size=${15} /><b>${g.label}</b><span class="badge">${g.rows.length}${more && g === groups[groups.length - 1] ? "+" : ""}</span>
            <span class="grow"></span><span class="chev" style=${closed[k] ? "transform:rotate(-90deg)" : ""}><${Icon} name="chevron" /></span></button>
          ${!closed[k] && html`<div class="timeline">${g.rows.map(entry)}</div>`}
        </section>`;
      })}
      ${more && html`<div class="audit-more"><button class="btn" onClick=${() => load(true)}>Load more</button></div>`}`}
    ${meta && meta.can_retention && html`<div class="audit-keep">
      <${Icon} name="clock" size=${15} /><span><b>Keep activity for</b>${meta.oldest ? html`<span class="muted small"> · oldest entry ${when(meta.oldest)}</span>` : ""}
        ${meta.log_size != null && html`<div class="muted small audit-size" title="The whole database (people, settings, environments and activity) is ${bytes(meta.db_size)} on disk">
          Now ${meta.log_count.toLocaleString()} ${meta.log_count === 1 ? "entry" : "entries"}, about <b>${bytes(meta.log_size)}</b> · database ${bytes(meta.db_size)}</div>`}</span>
      <span class="grow"></span>
      <select value=${meta.retention_days} onChange=${(e) => setRetention(Number(e.target.value))} aria-label="Keep activity for">
        ${RETENTION.some(([d]) => d === meta.retention_days) ? null : html`<option value=${meta.retention_days}>${meta.retention_days} days</option>`}
        ${RETENTION.map(([d, l]) => html`<option value=${d}>${l}</option>`)}</select></div>`}
    ${meta && meta.can_retention && html`<${StoragePanel} key=${meta.log_count} />`}
  </${Modal}>`;
}
