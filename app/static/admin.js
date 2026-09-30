import { useState, useEffect } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Toggle, Segmented, Field, Copy, toast, Spinner, SsoButton, ask,
  vlanColors, ROLE_LABEL, MODE_LABEL, ago, when, rank,
} from "./ui.js";

const ROLES = ["viewer", "supervisor", "admin"];

// ============================================================================
// Settings
// ============================================================================

export function SettingsModal({ networks, onClose, onSaved }) {
  const [tab, setTab] = useState("unifi");
  const tabs = [["unifi", "UniFi", "server"], ["auth", "Sign-in", "shield"], ["behavior", "Ports", "grid"],
    ["colors", "VLAN colors", "palette"], ["updates", "Updates", "sparkle"]];
  return html`<${Modal} title="Settings" icon="settings" onClose=${onClose} wide>
    <nav class="tabs">${tabs.map(([k, l, i]) => html`<button class=${tab === k ? "on" : ""} onClick=${() => setTab(k)}><${Icon} name=${i} size=${15} />${l}</button>`)}</nav>
    <div class="tab-body">
      ${tab === "unifi" && html`<${UnifiTab} onSaved=${onSaved} />`}
      ${tab === "auth" && html`<${AuthTab} />`}
      ${tab === "behavior" && html`<${BehaviorTab} onSaved=${onSaved} />`}
      ${tab === "colors" && html`<${SiteColorsTab} networks=${networks} onSaved=${onSaved} />`}
      ${tab === "updates" && html`<${UpdatesTab} />`}
    </div></${Modal}>`;
}

function useSettings() {
  const [s, setS] = useState(null);
  useEffect(() => { api("/api/settings").then(setS).catch((e) => toast(e.message, "err")); }, []);
  return [s, setS];
}

function UnifiTab({ onSaved }) {
  const [s, setS] = useSettings();
  const [key, setKey] = useState("");
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [consoles, setConsoles] = useState(null);
  if (!s) return html`<${Spinner} />`;
  const set = (k, v) => setS({ ...s, [k]: v });
  const body = () => ({ unifi_mode: s.unifi_mode, unifi_host: s.unifi_host, unifi_site: s.unifi_site,
    unifi_console_id: s.unifi_console_id, unifi_verify_ssl: s.unifi_verify_ssl, unifi_api_key: key || undefined });
  const cloud = s.unifi_mode === "cloud";
  return html`<div class="form">
    <${Field} label="Connection">
      <${Segmented} value=${s.unifi_mode} onChange=${(v) => set("unifi_mode", v)}
        options=${[{ value: "local", label: "Console on my network" }, { value: "cloud", label: "Through UniFi cloud" }]} /></${Field}>
    ${!cloud ? html`<${Field} label="Console address" hint="Your UDM / UCG / Cloud Key / UniFi OS Server, e.g. https://192.168.1.1. A UniFi-hosted console works with its own URL too.">
        <input value=${s.unifi_host} placeholder="https://192.168.1.1" onInput=${(e) => set("unifi_host", e.target.value)} /></${Field}>`
      : html`<${Field} label="Console ID" hint="Uses api.ui.com/v1/connector (experimental). The API key must come from unifi.ui.com → API.">
        <div class="row"><input value=${s.unifi_console_id} placeholder="console id" onInput=${(e) => set("unifi_console_id", e.target.value)} />
          <button class="btn ghost" onClick=${async () => {
            const r = await api("/api/settings/unifi/consoles", { method: "POST", body: body() });
            if (r.ok) setConsoles(r.consoles); else toast(r.error, "err");
          }}>Find consoles</button></div>
        ${consoles && html`<div class="choices">${consoles.map((c) => html`<button class="chip" onClick=${() => { set("unifi_console_id", c.id); setConsoles(null); }}>${c.name}<span class="muted">${c.type}</span></button>`)}
          ${consoles.length === 0 && html`<span class="muted">No consoles on this key.</span>`}</div>`}</${Field}>`}
    <${Field} label="API key" hint=${cloud ? "unifi.ui.com → API → Create API key" : "Network app → Settings → Control Plane → Integrations → Create API key"}>
      <div class="row"><input type="password" autocomplete="new-password" value=${key} placeholder=${s.unifi_api_key_set ? "✓ saved — leave blank to keep" : "paste the key"}
        onInput=${(e) => setKey(e.target.value)} />
        ${s.unifi_api_key_set && html`<button class="btn ghost" onClick=${async () => { await api("/api/settings", { method: "PUT", body: { clear_unifi_api_key: true } }); set("unifi_api_key_set", false); }}>Clear</button>`}</div></${Field}>
    <${Field} label="Site" hint="Internal site name — usually 'default'. Test the connection to pick from a list.">
      <input value=${s.unifi_site} onInput=${(e) => set("unifi_site", e.target.value)} />
      ${test && test.sites && test.sites.length > 1 && html`<div class="choices">${test.sites.map((x) => html`<button class=${"chip" + (x.name === s.unifi_site ? " on" : "")} onClick=${() => set("unifi_site", x.name)}>${x.desc}<span class="muted">${x.name}</span></button>`)}</div>`}
    </${Field}>
    ${!cloud && html`<${Toggle} checked=${s.unifi_verify_ssl} onChange=${(v) => set("unifi_verify_ssl", v)} label="Verify TLS certificate" hint="Leave off for the console's self-signed certificate." />`}
    ${test && html`<div class=${"notice " + (test.ok ? "good" : "err")}><${Icon} name=${test.ok ? "check" : "alert"} /><div>
      ${test.ok ? html`Connected — <b>${test.devices}</b> devices with ports and <b>${test.networks}</b> networks on site <b>${s.unifi_site}</b>.` : test.error}</div></div>`}
    <div class="form-actions">
      <button class="btn ghost" disabled=${busy} onClick=${async () => { setBusy(true); try { setTest(await api("/api/settings/unifi/test", { method: "POST", body: body() })); } catch (e) { toast(e.message, "err"); } setBusy(false); }}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}Test connection</button>
      <button class="btn primary" onClick=${async () => {
        try { await api("/api/settings", { method: "PUT", body: body() }); setKey(""); setS({ ...s, unifi_api_key_set: s.unifi_api_key_set || !!key }); toast("UniFi settings saved"); onSaved(); } catch (e) { toast(e.message, "err"); }
      }}>Save</button>
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
          `acting as ${ROLE_LABEL[a.anonymous_role]}.\n\nOnly do this on an isolated network you fully trust.\n\nType I UNDERSTAND to turn it on:`);
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
    <${Toggle} checked=${a.token_enabled} onChange=${(v) => set("token_enabled", v)} label="API tokens" hint="Personal tokens for scripts (Bearer header) or a kiosk link." />

    <h4 class="section">Single sign-on (OIDC)</h4>
    <div class="grid2">
      <${Field} label="Issuer URL" hint="Authentik: https://auth.example.com/application/o/<slug>/"><input value=${a.oidc.issuer} onInput=${(e) => setO("issuer", e.target.value)} /></${Field}>
      <${Field} label="Client ID"><input value=${a.oidc.client_id} onInput=${(e) => setO("client_id", e.target.value)} /></${Field}>
      <${Field} label="Client secret"><input type="password" autocomplete="new-password" value=${secret} placeholder=${a.oidc.client_secret_set ? "✓ saved — leave blank to keep" : ""} onInput=${(e) => setSecret(e.target.value)} /></${Field}>
      <${Field} label="Scopes"><input value=${a.oidc.scopes} onInput=${(e) => setO("scopes", e.target.value)} /></${Field}>
      <${Field} label="Redirect URI (register at your provider)" hint="Override only if the detected one is wrong.">
        <div class="row"><input value=${a.oidc.redirect_uri} placeholder=${a.redirect_uri} onInput=${(e) => setO("redirect_uri", e.target.value)} /><${Copy} text=${a.oidc.redirect_uri || a.redirect_uri} /></div></${Field}>
      <${Field} label="Groups claim"><input value=${a.oidc.groups_claim} onInput=${(e) => setO("groups_claim", e.target.value)} /></${Field}>
      <${Field} label="Allowed groups" hint="Comma-separated. Empty = anyone your provider lets through."><input value=${a.oidc.allowed_groups} onInput=${(e) => setO("allowed_groups", e.target.value)} /></${Field}>
      <${Field} label="Admin groups" hint="Optional. When admin or supervisor groups are set, roles follow the provider on every sign-in."><input value=${a.oidc.admin_groups} onInput=${(e) => setO("admin_groups", e.target.value)} /></${Field}>
      <${Field} label="Supervisor groups"><input value=${a.oidc.supervisor_groups} onInput=${(e) => setO("supervisor_groups", e.target.value)} /></${Field}>
    </div>
    <${Toggle} checked=${a.oidc.auto_create} onChange=${(v) => setO("auto_create", v)} label="Create users on first SSO sign-in" hint="New users start as Viewer. Off: an admin adds them first (username or email must match)." />
    <${Toggle} checked=${a.oidc_auto_login} onChange=${(v) => set("oidc_auto_login", v)} label="Sign in automatically with SSO"
      hint="Visiting the app goes straight to your provider. /login always shows the login page as a fallback." />
    <div class="row">
      <button class="btn ghost" onClick=${async () => setTestRes(await api("/api/settings/auth/test-oidc", { method: "POST", body: a.oidc }).catch((e) => ({ ok: false, error: e.message })))}>Test provider</button>
      ${testRes && html`<span class=${testRes.ok ? "good-text" : "err-text"}>${testRes.ok ? `✓ ${testRes.issuer}` : testRes.error}</span>`}
    </div>

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
          ${ROLES.map((r) => html`<option value=${r}>Anonymous visitors are ${ROLE_LABEL[r]}</option>`)}</select>
      </div>
      ${locked("no_auth") && html`<small class="hint">Set by VLANMGR_NO_AUTH.</small>`}
    </div>
    <div class="form-actions sticky"><button class="btn primary" onClick=${() => save()}>Save sign-in settings</button></div>
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

function SiteColorsTab({ networks, onSaved }) {
  const [s, setS] = useSettings();
  if (!s) return html`<${Spinner} />`;
  const auto = vlanColors(networks, {}, {});
  const val = s.vlan_colors || {};
  const setC = (id, v) => setS({ ...s, vlan_colors: { ...val, [id]: v } });
  return html`<div class="form">
    <p class="muted">Default port colors for everyone. Each user can still pick their own under their name → My VLAN colors.</p>
    <div class="color-list">${networks.map((n) => html`<label class="color-row" key=${n.id}>
      <input type="color" value=${val[n.id] || auto[n.id]} onInput=${(e) => setC(n.id, e.target.value)} />
      <span class="color-name">${n.name}</span><span class="chip-vlan">VLAN ${n.vlan}</span>
      ${val[n.id] && html`<button class="link-btn" onClick=${(e) => { e.preventDefault(); const v = { ...val }; delete v[n.id]; setS({ ...s, vlan_colors: v }); }}>auto</button>`}
    </label>`)}</div>
    <div class="form-actions"><button class="btn primary" onClick=${async () => {
      try { await api("/api/settings", { method: "PUT", body: { vlan_colors: val } }); toast("Colors saved"); onSaved(); } catch (e) { toast(e.message, "err"); }
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
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: "", display_name: "", email: "", password: "", role: "viewer" });
  const load = () => api("/api/users").then(setData).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);

  async function update(u, body, msg) {
    try { await api(`/api/users/${u.id}`, { method: "PUT", body }); toast(msg || "Saved"); load(); } catch (e) { toast(e.message, "err"); }
  }

  return html`<${Modal} title="Users" icon="users" onClose=${onClose} wide
    footer=${html`<span class="muted grow">New users start as Viewer. SSO users are created on their first sign-in.</span>
      <button class="btn primary" onClick=${() => setAdding(!adding)}><${Icon} name="plus" />Add user</button>`}>
    ${adding && html`<div class="panel add-user">
      <div class="grid3">
        <${Field} label="Username"><input value=${form.username} onInput=${(e) => setForm({ ...form, username: e.target.value })} /></${Field}>
        <${Field} label="Display name"><input value=${form.display_name} onInput=${(e) => setForm({ ...form, display_name: e.target.value })} /></${Field}>
        <${Field} label="Email"><input value=${form.email} onInput=${(e) => setForm({ ...form, email: e.target.value })} /></${Field}>
        <${Field} label="Password" hint="Leave blank for an SSO-only user."><input type="password" autocomplete="new-password" value=${form.password} onInput=${(e) => setForm({ ...form, password: e.target.value })} /></${Field}>
        <${Field} label="Role"><select value=${form.role} onChange=${(e) => setForm({ ...form, role: e.target.value })}>${ROLES.map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}</select></${Field}>
        <div class="field end"><button class="btn primary" onClick=${async () => {
          try { await api("/api/users", { method: "POST", body: form }); toast(`Added ${form.username}`); setForm({ username: "", display_name: "", email: "", password: "", role: "viewer" }); setAdding(false); load(); } catch (e) { toast(e.message, "err"); }
        }}>Create</button></div>
      </div></div>`}
    ${!data ? html`<${Spinner} />` : html`<div class="table-wrap"><table class="table">
      <thead><tr><th>User</th><th>Role</th><th>Sign-in</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
      <tbody>${data.users.map((u) => html`<tr key=${u.id} class=${u.disabled ? "disabled" : ""}>
        <td><div class="u-cell"><span class="avatar sm">${(u.display_name || u.username)[0].toUpperCase()}</span>
          <div><b>${u.display_name || u.username}</b>${u.seeded && html` <span class="badge">first admin</span>`}<div class="muted small">${u.username}${u.email ? ` · ${u.email}` : ""}</div></div></div></td>
        <td><select class="sm" value=${u.role} onChange=${(e) => update(u, { role: e.target.value }, `${u.username} is now ${ROLE_LABEL[e.target.value]}`)}>
          ${ROLES.map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}</select></td>
        <td>${u.sso && html`<span class="badge">SSO</span>`} ${u.has_password && html`<span class="badge">Password</span>`}</td>
        <td class="muted small">${ago(u.last_login)}${u.sessions ? html`<div>${u.sessions} active session${u.sessions > 1 ? "s" : ""}</div>` : null}</td>
        <td>${u.id !== me.id ? html`<${Toggle} checked=${!u.disabled} onChange=${(on) => update(u, { disabled: !on }, on ? "Enabled" : "Disabled")} label=${u.disabled ? "Disabled" : "Active"} />` : html`<span class="muted small">you</span>`}</td>
        <td class="actions">
          <button class="icon-btn sm" title="Set password" onClick=${() => { const pw = prompt(`New password for ${u.username} (8+ characters):`); if (pw) update(u, { password: pw }, "Password set"); }}><${Icon} name="key" size=${15} /></button>
          ${u.sessions > 0 && html`<button class="icon-btn sm" title="Sign out everywhere" onClick=${() => update(u, { sign_out: true }, "Signed out")}><${Icon} name="logout" size=${15} /></button>`}
          ${u.id !== me.id && html`<button class="icon-btn sm danger" title="Delete" onClick=${async () => {
            if (await ask({ title: `Delete ${u.username}?`, body: "Their sessions and API tokens are removed too.", danger: true, confirm: "Delete" })) {
              try { await api(`/api/users/${u.id}`, { method: "DELETE" }); toast("Deleted"); load(); } catch (e) { toast(e.message, "err"); }
            }
          }}><${Icon} name="trash" size=${15} /></button>`}
        </td></tr>`)}</tbody></table></div>`}
  </${Modal}>`;
}

// ============================================================================
// My account
// ============================================================================

export function AccountModal({ me, onClose }) {
  const [pw, setPw] = useState({ current: "", password: "", confirm: "" });
  const [tokens, setTokens] = useState(null);
  const [tf, setTf] = useState({ name: "", role: me.role, days: 0, value: "" });
  const [created, setCreated] = useState(null);
  const loadTokens = () => api("/api/me/tokens").then(setTokens).catch(() => setTokens({ enabled: false, tokens: [] }));
  useEffect(() => { loadTokens(); }, []);
  return html`<${Modal} title="My account" icon="user" onClose=${onClose} wide>
    <div class="account-head"><span class="avatar lg">${(me.display_name || me.username)[0].toUpperCase()}</span>
      <div><h3>${me.display_name || me.username}</h3><div class="muted">${me.username}${me.email ? ` · ${me.email}` : ""} · <span class=${"role-badge " + me.role}>${ROLE_LABEL[me.role]}</span></div></div></div>

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

    <h4 class="section">API tokens</h4>
    ${tokens && !tokens.enabled ? html`<p class="muted">API tokens are turned off by an admin.</p>` : html`
      <p class="muted">Use <span class="mono">Authorization: Bearer &lt;token&gt;</span> in scripts, or open the link once on a kiosk. A token never has more rights than you.</p>
      ${created && html`<div class="notice good"><${Icon} name="key" /><div><b>Copy it now — it's shown only once.</b>
        <div class="row mono token"><span>${created.token}</span><${Copy} text=${created.token} /></div>
        <div class="row small"><span class="muted mono token"><span>${created.link}</span></span><${Copy} text=${created.link} /></div>
        <div class="muted small">Open the link once on a phone or kiosk: it signs that browser in as you (${ROLE_LABEL[tf.role]} or lower) and stays signed in.</div></div></div>`}
      <div class="grid3">
        <${Field} label="Name"><input value=${tf.name} placeholder="backup script" onInput=${(e) => setTf({ ...tf, name: e.target.value })} /></${Field}>
        <${Field} label="Role"><select value=${tf.role} onChange=${(e) => setTf({ ...tf, role: e.target.value })}>${ROLES.filter((r) => rank(r) <= rank(me.role)).map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}</select></${Field}>
        <${Field} label="Expires after (days, 0 = never)"><input type="number" min="0" value=${tf.days} onInput=${(e) => setTf({ ...tf, days: e.target.value })} /></${Field}>
      </div>
      <${Field} label="Token (optional)" hint="Leave blank for a random one. Your own value makes a link you can type: at least 16 characters — letters, digits, . _ ~ -">
        <input value=${tf.value} autocomplete="off" spellcheck="false" placeholder="random" onInput=${(e) => setTf({ ...tf, value: e.target.value })} /></${Field}>
      ${tf.value && html`<div class="muted small mono">${location.origin}/?token=${tf.value}</div>`}
      <div class="form-actions"><button class="btn ghost" onClick=${async () => {
        try { setCreated(await api("/api/me/tokens", { method: "POST", body: tf })); setTf({ ...tf, name: "", value: "" }); loadTokens(); } catch (e) { toast(e.message, "err"); }
      }}><${Icon} name="plus" />Create token</button></div>
      ${tokens && tokens.tokens.length > 0 && html`<table class="table"><thead><tr><th>Name</th><th>Role</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
        <tbody>${tokens.tokens.map((t) => html`<tr key=${t.id}><td><b>${t.name}</b></td><td>${ROLE_LABEL[t.role]}</td><td class="small">${ago(t.created_at)}</td>
          <td class="small">${ago(t.last_used)}</td><td class="small">${t.expires_at ? when(t.expires_at) : "never"}</td>
          <td class="actions"><button class="icon-btn sm danger" title="Revoke" onClick=${async () => { await api(`/api/me/tokens/${t.id}`, { method: "DELETE" }); toast("Revoked"); loadTokens(); }}><${Icon} name="trash" size=${15} /></button></td></tr>`)}</tbody></table>`}`}
  </${Modal}>`;
}

// ============================================================================
// Activity (audit log)
// ============================================================================

const ACTION_LABEL = {
  "port.set": "Port changed", "login.failed": "Failed sign-in", "login.sso_denied": "SSO sign-in refused",
  "user.created": "User added", "user.updated": "User changed", "user.deleted": "User deleted",
  "user.password_changed": "Password changed", "token.created": "Token created", "token.revoked": "Token revoked",
  "settings.app": "Settings changed", "settings.auth": "Sign-in settings changed",
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
              ${r.action === "port.set" && r.ok && (d.verified ? html`<span class="badge good">verified</span>` : html`<span class="badge warn">unverified</span>`)}
              ${!r.ok && html`<span class="badge err">failed</span>`}</div>
            ${r.action === "port.set" && d.before && html`<div class="tl-diff">
              <span>${d.before.native} · ${d.before.tagged}</span><span class="arrow">→</span><b>${d.after.native} · ${d.after.tagged}</b>
              ${d.after.excluded && d.after.excluded.length > 0 && html`<span class="muted small"> (not tagged: ${d.after.excluded.join(", ")})</span>`}</div>`}
            ${d.error && html`<div class="err-text small">${d.error}</div>`}
            <div class="muted small">${r.username || "?"}${r.role ? ` (${ROLE_LABEL[r.role] || r.role})` : ""} · ${when(r.ts)}${r.ip ? ` · ${r.ip}` : ""}</div>
          </div></div>`;
      })}</div>`}
  </${Modal}>`;
}
