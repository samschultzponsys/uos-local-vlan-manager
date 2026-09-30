import { render, useState, useEffect, useMemo, useCallback } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Segmented, Toasts, toast, Spinner, useInterval, Logo, markdown,
  vlanColors, readable, speedLabel, bytes, ago, rank, ROLE_LABEL, MODE_LABEL, lsGet, lsSet, ask, AskHost,
} from "./ui.js";
import { SettingsModal, UsersModal, AccountModal, AuditModal } from "./admin.js";

// --- tooltip ------------------------------------------------------------------

let setTipGlobal = () => {};
function TipHost() {
  const [tip, setTip] = useState(null);
  setTipGlobal = setTip;
  if (!tip) return null;
  const { rect, content } = tip;
  const below = rect.top < 220;
  const style = `left:${Math.min(Math.max(rect.left + rect.width / 2, 150), innerWidth - 150)}px;` +
    (below ? `top:${rect.bottom + 10}px` : `top:${rect.top - 10}px;transform:translate(-50%,-100%)`);
  return html`<div class=${"tip" + (below ? " below" : "")} style=${style}>${content}</div>`;
}
const showTip = (e, content) => setTipGlobal({ rect: e.currentTarget.getBoundingClientRect(), content });
const hideTip = () => setTipGlobal(null);

// --- port tile + faceplate ------------------------------------------------------

function netOf(networks, id) { return networks.find((n) => n.id === id); }

function carries(port, netId) {
  if (port.native_network_id === netId) return true;
  if (port.tagged_mode === "auto") return true;
  if (port.tagged_mode === "custom") return !port.excluded_network_ids.includes(netId);
  return false;
}

function PortTip({ port, networks }) {
  const n = netOf(networks, port.native_network_id);
  const c = port.clients[0];
  return html`<div class="tip-title">Port ${port.idx}${port.name !== `Port ${port.idx}` ? ` · ${port.name}` : ""}</div>
    <div class="tip-row"><span class=${"led " + (port.up ? "on" : "")}></span>${port.up ? `Up · ${speedLabel(port.speed)}${port.full_duplex ? " FD" : ""}` : port.enabled ? "Disconnected" : "Disabled"}</div>
    <div class="tip-row"><${Icon} name="tag" size=${13} />${n ? `${n.name} (${n.vlan})` : "Unknown network"} · ${MODE_LABEL[port.tagged_mode]}</div>
    ${port.poe_capable && html`<div class="tip-row"><${Icon} name="bolt" size=${13} />${port.poe_active ? `PoE delivering ${port.poe_power} W` : port.poe_enabled ? "PoE on · idle" : "PoE off"}</div>`}
    ${c && html`<div class="tip-row"><${Icon} name="plug" size=${13} />${c.name || c.hostname || c.mac}${port.client_count > 1 ? ` +${port.client_count - 1}` : ""}</div>`}
    ${port.device_link && html`<div class="tip-row"><${Icon} name="link" size=${13} />${port.device_link}</div>`}
    ${port.profile_name && html`<div class="tip-row"><${Icon} name="layers" size=${13} />Profile: ${port.profile_name}</div>`}
    ${port.protected && html`<div class="tip-row warn"><${Icon} name="lock" size=${13} />${port.protect_reasons.join(" · ")}</div>`}`;
}

function PortTile({ port, device, networks, colors, highlight, selected, onPick }) {
  const n = netOf(networks, port.native_network_id);
  const color = colors[port.native_network_id] || "#64748b";
  const dim = highlight && !carries(port, highlight);
  const cls = ["port", port.up ? "up" : "down", port.enabled ? "" : "off", dim ? "dim" : "", selected ? "sel" : "",
    port.sfp ? "sfp" : ""].join(" ");
  return html`<button class=${cls} style=${`--c:${color};--fg:${readable(color)}`}
    onClick=${() => { hideTip(); onPick(device.id, port.idx); }}
    onMouseEnter=${canHover ? (e) => showTip(e, html`<${PortTip} port=${port} networks=${networks} />`) : undefined}
    onMouseLeave=${canHover ? hideTip : undefined}
    aria-label=${`Port ${port.idx}, ${n ? n.name : ""}`}>
    <span class="p-num">${port.idx}</span>
    ${port.poe_capable && html`<span class=${"p-poe " + (port.poe_active ? "active" : port.poe_enabled ? "on" : "offpoe")}>
      <${Icon} name="bolt" size=${11} fill=${port.poe_active} /></span>`}
    <span class="p-vlan">${n ? n.vlan : "?"}</span>
    <span class="p-flags">
      ${port.tagged_mode !== "block_all" && html`<span title="Tagged VLANs allowed"><${Icon} name="trunk" size=${10} /></span>`}
      ${port.profile_name && html`<span title="Port profile"><${Icon} name="layers" size=${10} /></span>`}
      ${port.protected && html`<span title="Protected"><${Icon} name="lock" size=${10} /></span>`}
    </span>
    <span class="p-led"></span>
  </button>`;
}

const mq = typeof matchMedia === "function" ? matchMedia("(max-width: 760px)") : null;
const canHover = typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
function useMobile() {
  const [m, setM] = useState(!!(mq && mq.matches));
  useEffect(() => {
    if (!mq) return undefined;
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return m;
}

function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }

function Faceplate({ device, ...rest }) {
  const mobile = useMobile();
  const tile = (p) => html`<${PortTile} key=${p.idx} port=${p} device=${device} selected=${rest.sel && rest.sel.d === device.id && rest.sel.i === p.idx} ...${rest} />`;
  if (mobile) {
    // phones: every port in order, big tap targets, no sideways scrolling
    return html`<div class=${"chassis compact " + (device.type || "")}>
      <div class="pgrid">${device.ports.map(tile)}</div></div>`;
  }
  const rj = device.ports.filter((p) => !p.sfp);
  const sfp = device.ports.filter((p) => p.sfp);
  const twoRow = rj.length > 10;
  const groups = twoRow ? chunk(rj, rj.length > 16 ? 12 : 8) : [rj];
  const grp = (ports, two) => html`<div class=${"pgroup" + (two ? " two" : "")}
    style=${`--cols:${two ? Math.ceil(ports.length / 2) : ports.length}`}>
    ${ports.map(tile)}</div>`;
  return html`<div class=${"chassis " + (device.type || "")}>
    <div class="chassis-label">
      <span class=${"chassis-led " + (device.online ? "on" : "")}></span>
      <div class="chassis-name">${device.name}</div>
      <div class="chassis-model">${device.model_name || device.model}</div>
    </div>
    <div class="faceplate">
      ${groups.map((g) => grp(g, twoRow))}
      ${sfp.length > 0 && html`<div class="sfp-sep"></div>${grp(sfp, twoRow && sfp.length > 1)}`}
    </div>
    <div class="chassis-screws"><span></span><span></span></div>
  </div>`;
}

function DeviceCard({ device, collapsed, onCollapse, ...rest }) {
  const up = device.ports.filter((p) => p.up).length;
  const poe = device.ports.reduce((a, p) => a + (p.poe_power || 0), 0);
  return html`<section class=${"device" + (device.online ? "" : " offline")}>
    <header class="device-head" onClick=${onCollapse}>
      <span class=${"status-dot " + (device.online ? "on" : "")} title=${device.online ? "Online" : "Offline"}></span>
      <div class="device-title">
        <h3>${device.name}</h3>
        <div class="device-sub">${device.model_name}${device.ip && html` · ${device.ip}`}${device.version && html` · v${device.version}`}</div>
      </div>
      <div class="device-stats">
        <span class="stat"><${Icon} name="link" size=${13} />${up}/${device.ports.length}</span>
        ${poe > 0 && html`<span class="stat poe"><${Icon} name="bolt" size=${13} fill />${poe.toFixed(1)} W</span>`}
        <span class="chev" style=${collapsed ? "transform:rotate(-90deg)" : ""}><${Icon} name="chevron" /></span>
      </div>
    </header>
    ${!collapsed && html`<div class="device-body"><${Faceplate} device=${device} ...${rest} /></div>`}
  </section>`;
}

// --- VLAN legend ---------------------------------------------------------------

function Legend({ networks, colors, devices, highlight, setHighlight, onColors }) {
  const counts = useMemo(() => {
    const c = {};
    for (const d of devices) for (const p of d.ports) c[p.native_network_id] = (c[p.native_network_id] || 0) + 1;
    return c;
  }, [devices]);
  return html`<div class="legend">
    ${networks.map((n) => html`<button key=${n.id} class=${"chip" + (highlight === n.id ? " on" : "") + (highlight && highlight !== n.id ? " faded" : "")}
      style=${`--c:${colors[n.id]}`} onClick=${() => setHighlight(highlight === n.id ? null : n.id)}
      title="Highlight ports carrying this network">
      <span class="sw"></span><span class="chip-name">${n.name}</span><span class="chip-vlan">${n.vlan}</span>
      ${counts[n.id] ? html`<span class="chip-count">${counts[n.id]}</span>` : null}
    </button>`)}
    <button class="chip ghost" onClick=${onColors} title="Choose VLAN colors"><${Icon} name="palette" size=${14} />Colors</button>
  </div>`;
}

function ColorsModal({ networks, colors, mine, onSave, onClose }) {
  const [val, setVal] = useState({ ...mine });
  return html`<${Modal} title="My VLAN colors" icon="palette" onClose=${onClose}
    footer=${html`<button class="btn ghost" onClick=${() => setVal({})}>Reset all</button>
      <button class="btn primary" onClick=${() => onSave(val)}>Save</button>`}>
    <p class="muted">Pick a color per network. Ports take the color of their native VLAN. These colors are yours; an admin sets the defaults for everyone.</p>
    <div class="color-list">
      ${networks.map((n) => html`<label class="color-row" key=${n.id}>
        <input type="color" value=${val[n.id] || colors[n.id]} onInput=${(e) => setVal({ ...val, [n.id]: e.target.value })} />
        <span class="color-name">${n.name}</span><span class="chip-vlan">VLAN ${n.vlan}</span>
        ${val[n.id] && html`<button class="link-btn" onClick=${(e) => { e.preventDefault(); const v = { ...val }; delete v[n.id]; setVal(v); }}>default</button>`}
      </label>`)}
    </div></${Modal}>`;
}

// --- port drawer ----------------------------------------------------------------

function PortDrawer({ device, port, networks, colors, me, settings, onClose, onApplied }) {
  const canEdit = rank(me.role) >= 1 && (!port.protected || me.role === "admin");
  const [native, setNative] = useState(port.native_network_id);
  const [mode, setMode] = useState(settings.default_tagged_mode || "block_all");
  const [excluded, setExcluded] = useState(port.tagged_mode === "custom" ? port.excluded_network_ids : []);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNative(port.native_network_id);
    setMode(settings.default_tagged_mode || "block_all");
    setExcluded(port.tagged_mode === "custom" ? port.excluded_network_ids : []);
  }, [device.id, port.idx]);

  const cur = netOf(networks, port.native_network_id);
  const next = netOf(networks, native);
  const sameEx = [...excluded].sort().join() === [...port.excluded_network_ids].sort().join();
  const dirty = native !== port.native_network_id || mode !== port.tagged_mode || (mode === "custom" && !sameEx);

  async function apply(extra = {}) {
    setBusy(true);
    try {
      const r = await api(`/api/devices/${device.id}/ports/${port.idx}`, { method: "PUT",
        body: { native_network_id: native, tagged_mode: mode, excluded_network_ids: mode === "custom" ? excluded : [], ...extra } });
      toast(`Port ${port.idx} → ${next.name} (${next.vlan}), ${MODE_LABEL[mode]}`);
      if (r.warning) toast(r.warning, "warn");
      onApplied();
    } catch (e) {
      if (e.status === 409 && e.data.confirm === "protected") {
        const ok = await ask({ title: "Change a protected port?", danger: true, confirm: "Change it anyway",
          body: html`<p>This port is protected:</p><ul>${e.data.reasons.map((r) => html`<li>${r}</li>`)}</ul>
            <p>Changing it can cut off the switch or the devices behind it.</p>` });
        if (ok) return apply({ ...extra, confirm_protected: true });
      } else if (e.status === 409 && e.data.confirm === "profile") {
        const ok = await ask({ title: "Detach port profile?", confirm: "Detach and apply",
          body: html`<p>This port uses the port profile <b>${e.data.profile}</b>. Setting its VLAN here detaches the profile from this port.</p>` });
        if (ok) return apply({ ...extra, detach_profile: true });
      } else toast(e.message, "err");
    } finally { setBusy(false); }
    return null;
  }

  const c0 = port.clients;
  return html`<aside class="drawer" role="dialog" aria-label=${`Port ${port.idx} settings`}>
    <header class="drawer-head">
      <div><div class="drawer-kicker">${device.name}</div><h2>Port ${port.idx}${port.name !== `Port ${port.idx}` && html` <span class="muted">· ${port.name}</span>`}</h2></div>
      <button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
    </header>
    <div class="drawer-body">
      <div class="status-grid">
        <div class="sg"><span class="sg-l">Link</span><span class=${"sg-v " + (port.up ? "good" : "")}><span class=${"led " + (port.up ? "on" : "")}></span>
          ${port.up ? `${speedLabel(port.speed)}${port.full_duplex ? " · Full duplex" : ""}` : port.enabled ? "Down" : "Disabled"}</span></div>
        <div class="sg"><span class="sg-l">PoE</span><span class=${"sg-v " + (port.poe_active ? "poe" : "")}>
          ${!port.poe_capable ? "Not supported" : port.poe_active ? html`<${Icon} name="bolt" size=${14} fill />${port.poe_power} W` : port.poe_enabled ? `On · idle (${port.poe_mode})` : "Off"}</span></div>
        <div class="sg"><span class="sg-l">Native VLAN</span><span class="sg-v"><span class="dot" style=${`background:${colors[port.native_network_id]}`}></span>${cur ? `${cur.name} (${cur.vlan})` : "?"}</span></div>
        <div class="sg"><span class="sg-l">Tagged</span><span class="sg-v">${MODE_LABEL[port.tagged_mode]}</span></div>
        ${port.media && html`<div class="sg"><span class="sg-l">Media</span><span class="sg-v">${port.media}</span></div>`}
        ${port.up && html`<div class="sg"><span class="sg-l">Traffic</span><span class="sg-v">↓ ${bytes(port.rx_bytes)} · ↑ ${bytes(port.tx_bytes)}</span></div>`}
      </div>
      ${(c0.length > 0 || port.device_link || port.lldp) && html`<div class="panel">
        <div class="panel-title">Connected</div>
        ${port.device_link && html`<div class="client"><${Icon} name="server" size=${14} /><b>${port.device_link}</b><span class="muted">UniFi device</span></div>`}
        ${c0.map((c) => html`<div class="client"><${Icon} name="plug" size=${14} /><b>${c.name || c.hostname || c.mac}</b>
          <span class="muted mono">${c.mac}${c.ip ? ` · ${c.ip}` : ""}</span></div>`)}
        ${port.client_count > c0.length && html`<div class="muted">+${port.client_count - c0.length} more</div>`}
        ${port.lldp && !port.device_link && html`<div class="client"><${Icon} name="link" size=${14} /><b>${port.lldp.name || port.lldp.chassis_id}</b><span class="muted">LLDP ${port.lldp.port}</span></div>`}
      </div>`}

      ${port.protected && html`<div class="notice warn"><${Icon} name="lock" /><div><b>Protected port.</b> ${port.protect_reasons.join(" · ")}.
        ${me.role === "admin" ? " You can change it as an admin, after confirming." : " Only an admin can change it."}</div></div>`}
      ${port.profile_name && html`<div class="notice"><${Icon} name="layers" /><div>Uses port profile <b>${port.profile_name}</b>. Applying a VLAN here detaches it.</div></div>`}

      <div class="panel">
        <div class="panel-title">Core settings ${!canEdit && html`<span class="badge">View only</span>`}</div>
        <label class="field"><span class="field-label">Native VLAN / Network</span>
          <div class="select-wrap"><span class="dot" style=${`background:${colors[native]}`}></span>
            <select value=${native} disabled=${!canEdit} onChange=${(e) => setNative(e.target.value)}>
              ${networks.map((n) => html`<option value=${n.id}>${n.name} (${n.vlan})</option>`)}
            </select><${Icon} name="chevron" cls="select-chev" /></div></label>
        <div class="field"><span class="field-label">Tagged VLAN Management</span>
          <${Segmented} value=${mode} disabled=${!canEdit} onChange=${setMode}
            options=${[{ value: "auto", label: "Allow All" }, { value: "block_all", label: "Block All" }, { value: "custom", label: "Custom" }]} />
          <small class="hint">${mode === "block_all" ? "Access port: only the native VLAN, nothing tagged." : mode === "auto" ? "Trunk: every network is tagged on this port." : "Trunk: only the networks ticked below are tagged."}</small>
        </div>
        ${mode === "custom" && html`<div class="tag-list">
          ${networks.filter((n) => n.id !== native).map((n) => html`<label class="tag-row" key=${n.id}>
            <input type="checkbox" disabled=${!canEdit} checked=${!excluded.includes(n.id)}
              onChange=${(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== n.id) : [...excluded, n.id])} />
            <span class="dot" style=${`background:${colors[n.id]}`}></span>${n.name}<span class="chip-vlan">${n.vlan}</span></label>`)}
        </div>`}
      </div>

      ${canEdit && dirty && html`<div class="diff">
        ${native !== port.native_network_id && html`<div><span class="muted">Native</span> ${cur ? cur.name : "?"} <span class="arrow">→</span> <b>${next.name} (${next.vlan})</b></div>`}
        ${(mode !== port.tagged_mode || (mode === "custom" && !sameEx)) && html`<div><span class="muted">Tagged</span> ${MODE_LABEL[port.tagged_mode]} <span class="arrow">→</span> <b>${MODE_LABEL[mode]}</b></div>`}
      </div>`}
    </div>
    ${canEdit && html`<footer class="drawer-foot">
      <button class="btn ghost" disabled=${busy || !dirty} onClick=${() => { setNative(port.native_network_id); setMode(port.tagged_mode); setExcluded(port.excluded_network_ids); }}>Reset</button>
      <button class="btn primary" disabled=${busy || !dirty} onClick=${() => apply()}>${busy ? html`<${Spinner} /> Applying…` : "Apply changes"}</button>
    </footer>`}
  </aside>`;
}

// --- device picker ---------------------------------------------------------------

function PickerModal({ devices, selected, onSave, onClose }) {
  const [sel, setSel] = useState(selected);
  const [q, setQ] = useState("");
  const list = devices.filter((d) => !q || `${d.name} ${d.model_name} ${d.ip} ${d.mac}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const move = (id, dir) => {
    const i = sel.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= sel.length) return;
    const s = [...sel]; [s[i], s[j]] = [s[j], s[i]]; setSel(s);
  };
  return html`<${Modal} title="Choose devices to show" icon="grid" onClose=${onClose} wide
    footer=${html`<span class="muted grow">${sel.length} selected</span>
      <button class="btn ghost" onClick=${() => setSel(devices.filter((d) => d.type === "usw").map((d) => d.id))}>All switches</button>
      <button class="btn ghost" onClick=${() => setSel([])}>None</button>
      <button class="btn primary" onClick=${() => onSave(sel)}>Show selected</button>`}>
    <div class="search"><${Icon} name="search" /><input placeholder="Search name, model, IP or MAC" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    <div class="pick-list">
      ${list.map((d) => {
        const on = sel.includes(d.id);
        return html`<div class=${"pick" + (on ? " on" : "")} key=${d.id} onClick=${() => toggle(d.id)}>
          <span class=${"check" + (on ? " on" : "")}>${on && html`<${Icon} name="check" size=${14} />`}</span>
          <span class=${"status-dot " + (d.online ? "on" : "")}></span>
          <div class="pick-main"><b>${d.name}</b><span class="muted">${d.model_name} · ${d.type_label} · ${d.ip || d.mac}</span></div>
          <span class="badge">${d.port_count} ports</span>
          ${on && html`<span class="order" onClick=${(e) => e.stopPropagation()}>
            <button class="icon-btn sm" title="Move up" onClick=${() => move(d.id, -1)}><${Icon} name="chevron" size=${14} cls="up" /></button>
            <button class="icon-btn sm" title="Move down" onClick=${() => move(d.id, 1)}><${Icon} name="chevron" size=${14} /></button></span>`}
        </div>`;
      })}
      ${list.length === 0 && html`<div class="empty-sm">No devices match.</div>`}
    </div></${Modal}>`;
}

// --- changelog ---------------------------------------------------------------------

function ChangelogModal({ version, onClose, isAdmin, onCheck }) {
  const u = version.update || {};
  return html`<${Modal} title="What's new" icon="sparkle" onClose=${onClose} wide>
    ${u.update_available && html`<div class="notice good"><${Icon} name="sparkle" /><div>
      <b>Version ${u.latest} is available</b> (you're on ${version.version}).
      ${u.url && html` <a href=${u.url} target="_blank" rel="noopener">Release notes <${Icon} name="external" size=${12} /></a>`}
      <div class="mono small">docker compose pull && docker compose up -d</div></div></div>`}
    <div class="changelog">
      ${(version.changelog || []).map((e) => html`<article class="cl-entry" key=${e.version}>
        <header><span class=${"cl-ver" + (e.version === version.version ? " current" : "")}>${e.version}</span>
          <span class="muted">${e.date}</span>${e.version === version.version && html`<span class="badge">installed</span>`}</header>
        <div class="md" dangerouslySetInnerHTML=${{ __html: markdown(e.body) }}></div></article>`)}
    </div>
    <div class="cl-foot muted">
      ${u.enabled ? html`Checked ${ago(u.checked_at)}${u.error ? ` · last check failed: ${u.error}` : ""}` : "Update check is off"}
      ${isAdmin && u.enabled && html` · <button class="link-btn" onClick=${onCheck}>Check now</button>`}
    </div></${Modal}>`;
}

// --- app -------------------------------------------------------------------------

function App() {
  const [me, setMe] = useState(null);
  const [st, setSt] = useState(null);
  const [version, setVersion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);
  const [sel, setSel] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [collapsed, setCollapsed] = useState(lsGet("vlanmgr.collapsed", {}));
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState(lsGet("vlanmgr.theme", "dark"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    lsSet("vlanmgr.theme", theme);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = theme === "light" ? "#eef1f6" : "#0a0c11";
  }, [theme]);
  useEffect(() => {
    const place = () => {
      const t = document.querySelector(".topbar");
      if (t) document.documentElement.style.setProperty("--top", `${Math.max(0, t.getBoundingClientRect().bottom)}px`);
    };
    place();
    addEventListener("scroll", place, { passive: true });
    addEventListener("resize", place);
    return () => { removeEventListener("scroll", place); removeEventListener("resize", place); };
  });

  const loadMe = useCallback(async () => {
    const m = await api("/api/me");
    if (m.method === "none") m.prefs = lsGet("vlanmgr.prefs", {});
    setMe(m);
  }, []);
  const load = useCallback(async (refresh) => {
    setLoading(true);
    try { setSt(await api("/api/state" + (refresh ? "?refresh=1" : ""))); } catch (e) { /* toast on explicit refresh */ if (refresh) toast(e.message, "err"); }
    setLoading(false);
  }, []);
  const loadVersion = useCallback(async () => {
    const v = await api("/api/version");
    setVersion(v);
    return v;
  }, []);

  useEffect(() => {
    loadMe(); load();
    loadVersion().then((v) => {
      if (lsGet("vlanmgr.seenVersion") !== v.version) { setModal("changelog"); lsSet("vlanmgr.seenVersion", v.version); }
    });
  }, []);
  useInterval(() => { if (!document.hidden && !modal) load(); }, ((st && st.settings.poll_seconds) || 15) * 1000);
  useInterval(() => { if (!document.hidden) loadVersion(); }, 30 * 60 * 1000);

  async function savePrefs(patch) {
    const prefs = { ...(me.prefs || {}), ...patch };
    setMe({ ...me, prefs });
    if (me.method === "none") lsSet("vlanmgr.prefs", prefs);
    else await api("/api/me/prefs", { method: "PUT", body: patch }).catch((e) => toast(e.message, "err"));
  }

  if (!me || !st) {
    return html`<div class="boot"><${Logo} size=${48} /><${Spinner} /></div>`;
  }

  const settings = st.settings;
  const prefs = me.prefs || {};
  const colors = vlanColors(st.networks, settings.vlan_colors, prefs.vlan_colors || {});
  const chosen = Array.isArray(prefs.devices) ? prefs.devices : null;
  const shown = chosen
    ? chosen.map((id) => st.devices.find((d) => d.id === id)).filter(Boolean)
    : st.devices.filter((d) => d.type === "usw");
  const selDev = sel && st.devices.find((d) => d.id === sel.d);
  const selPort = selDev && selDev.ports.find((p) => p.idx === sel.i);
  const isAdmin = me.role === "admin";
  const upd = version && version.update && version.update.update_available;
  const pick = (d, i) => setSel(sel && sel.d === d && sel.i === i ? null : { d, i });

  return html`
    ${me.no_auth && html`<div class="danger-banner"><${Icon} name="alert" />
      <span><b>No-auth mode is on.</b> Anyone who can reach this page can ${rank(me.role) >= 1 ? "change switch ports" : "see your network"}${me.role === "admin" ? " and settings" : ""} without signing in.</span>
      ${me.method === "none" && html`<a href="/login?manual=1">Sign in</a>`}</div>`}
    ${me.initial_password && html`<div class="warn-banner"><${Icon} name="key" /><span>You're using the generated admin password.</span>
      <button class="link-btn" onClick=${() => setModal("account")}>Change it now</button></div>`}
    <header class="topbar">
      <div class="brand"><${Logo} /><div><div class="brand-name">${settings.app_name}</div>
        <div class="brand-sub">${settings.unifi_configured ? `UniFi · ${settings.unifi_mode === "cloud" ? "cloud" : "local"} · site ${settings.unifi_site}` : "Not connected"}</div></div></div>
      <div class="top-actions">
        <button class="btn ghost" onClick=${() => load(true)} title=${st.fetched_at ? `Updated ${ago(st.fetched_at)}` : "Refresh"}>
          <${Icon} name="refresh" cls=${loading ? "spin" : ""} /><span class="hide-sm">Refresh</span></button>
        <button class="btn ghost" onClick=${() => setModal("picker")} disabled=${!st.devices.length}><${Icon} name="grid" /><span class="hide-sm">Devices</span></button>
        ${rank(me.role) >= 1 && html`<button class="btn ghost hide-sm" onClick=${() => setModal("audit")}><${Icon} name="list" /><span class="hide-sm">Activity</span></button>`}
        ${isAdmin && html`<button class="btn ghost hide-sm" onClick=${() => setModal("users")}><${Icon} name="users" /><span class="hide-sm">Users</span></button>`}
        ${isAdmin && html`<button class="icon-btn hide-sm" onClick=${() => setModal("settings")} title="Settings"><${Icon} name="settings" /></button>`}
        <div class="menu-wrap">
          <button class="user-btn" onClick=${() => setMenu(!menu)}>
            <span class="avatar">${(me.display_name || me.username).slice(0, 1).toUpperCase()}</span>
            <span class="hide-sm user-name">${me.display_name || me.username}</span>
            <span class=${"role-badge " + me.role}>${ROLE_LABEL[me.role]}</span></button>
          ${menu && html`<div class="menu-scrim" onClick=${() => setMenu(false)}></div>`}
          ${menu && html`<div class="menu" onMouseLeave=${canHover ? () => setMenu(false) : undefined}>
            <div class="menu-head"><b>${me.display_name || me.username}</b><span class="muted">${me.username} · ${me.method === "oidc" ? "SSO" : me.method === "token" ? "token" : me.method === "none" ? "not signed in" : "password"}</span></div>
            ${rank(me.role) >= 1 && html`<button class="show-sm" onClick=${() => { setMenu(false); setModal("audit"); }}><${Icon} name="list" />Activity</button>`}
            ${isAdmin && html`<button class="show-sm" onClick=${() => { setMenu(false); setModal("users"); }}><${Icon} name="users" />Users</button>`}
            ${isAdmin && html`<button class="show-sm" onClick=${() => { setMenu(false); setModal("settings"); }}><${Icon} name="settings" />Settings</button>`}
            ${me.id ? html`<button onClick=${() => { setMenu(false); setModal("account"); }}><${Icon} name="user" />My account</button>` : null}
            <button onClick=${() => { setMenu(false); setModal("colors"); }}><${Icon} name="palette" />My VLAN colors</button>
            <button onClick=${() => setTheme(theme === "dark" ? "light" : "dark")}><${Icon} name=${theme === "dark" ? "sun" : "moon"} />${theme === "dark" ? "Light" : "Dark"} theme</button>
            ${me.method !== "none" ? html`<button onClick=${async () => { const r = await api("/api/auth/logout", { method: "POST" }); location.href = r.redirect; }}><${Icon} name="logout" />Sign out</button>`
              : html`<a href="/login?manual=1"><${Icon} name="login" />Sign in</a>`}
          </div>`}
        </div>
      </div>
    </header>

    <main class=${"main" + (selPort ? " with-drawer" : "")}>
      ${st.error === "not_configured" ? html`<div class="empty">
          <div class="empty-icon"><${Icon} name="server" size=${40} /></div>
          <h2>Connect your UniFi console</h2>
          <p class="muted">${isAdmin ? "Add the console address and an API key to get started." : "An admin needs to connect a UniFi console first."}</p>
          ${isAdmin && html`<button class="btn primary" onClick=${() => setModal("settings")}><${Icon} name="settings" />Open settings</button>`}
        </div>`
      : st.error ? html`<div class="notice err big"><${Icon} name="alert" /><div><b>Can't load from UniFi.</b> ${st.error}
          <div><button class="link-btn" onClick=${() => load(true)}>Try again</button>${isAdmin && html` · <button class="link-btn" onClick=${() => setModal("settings")}>Settings</button>`}</div></div></div>`
      : html`
        <${Legend} networks=${st.networks} colors=${colors} devices=${shown} highlight=${highlight} setHighlight=${setHighlight} onColors=${() => setModal("colors")} />
        ${!chosen && st.devices.length > 0 && html`<div class="notice"><${Icon} name="info" /><div>Showing all switches. <button class="link-btn" onClick=${() => setModal("picker")}>Choose which devices to show</button></div></div>`}
        ${shown.length === 0 ? html`<div class="empty"><div class="empty-icon"><${Icon} name="grid" size=${40} /></div><h2>No devices selected</h2>
            <p class="muted">Pick the switches you want to see.</p><button class="btn primary" onClick=${() => setModal("picker")}>Choose devices</button></div>`
          : html`<div class="devices">${shown.map((d) => html`<${DeviceCard} key=${d.id} device=${d} networks=${st.networks} colors=${colors}
              highlight=${highlight} sel=${sel} onPick=${pick} collapsed=${!!collapsed[d.id]}
              onCollapse=${() => { const c = { ...collapsed, [d.id]: !collapsed[d.id] }; setCollapsed(c); lsSet("vlanmgr.collapsed", c); }} />`)}</div>`}
        <div class="key">
          <span><span class="k-tile up"></span>Link up</span><span><span class="k-tile"></span>No link</span>
          <span><span class="k-poe active"><${Icon} name="bolt" size=${11} fill /></span>PoE delivering</span>
          <span><span class="k-poe"><${Icon} name="bolt" size=${11} /></span>PoE on, idle</span>
          <span><${Icon} name="trunk" size=${12} />Tagged VLANs allowed</span>
          <span><${Icon} name="layers" size=${12} />Port profile</span><span><${Icon} name="lock" size=${12} />Protected</span>
        </div>`}
    </main>

    ${selPort && html`<${PortDrawer} device=${selDev} port=${selPort} networks=${st.networks} colors=${colors} me=${me}
      settings=${settings} onClose=${() => setSel(null)} onApplied=${() => load(true)} />`}

    <button class=${"version" + (upd ? " has-update" : "")} onClick=${() => setModal("changelog")} title=${upd ? `Version ${version.update.latest} is available` : "Changelog"}>
      v${version ? version.version : "…"}${upd && html`<span class="pulse"></span>`}</button>

    ${modal === "changelog" && version && html`<${ChangelogModal} version=${version} isAdmin=${isAdmin} onClose=${() => setModal(null)}
      onCheck=${async () => { const r = await api("/api/version/check", { method: "POST" }); setVersion({ ...version, update: r.update }); toast(r.update.update_available ? `Version ${r.update.latest} is available` : "You're up to date"); }} />`}
    ${modal === "picker" && html`<${PickerModal} devices=${st.devices} selected=${chosen || shown.map((d) => d.id)} onClose=${() => setModal(null)}
      onSave=${(ids) => { savePrefs({ devices: ids }); setModal(null); }} />`}
    ${modal === "colors" && html`<${ColorsModal} networks=${st.networks} colors=${vlanColors(st.networks, settings.vlan_colors, {})} mine=${prefs.vlan_colors || {}}
      onClose=${() => setModal(null)} onSave=${(v) => { savePrefs({ vlan_colors: v }); setModal(null); toast("Colors saved"); }} />`}
    ${modal === "settings" && html`<${SettingsModal} networks=${st.networks} onClose=${() => setModal(null)} onSaved=${() => load(true)} />`}
    ${modal === "users" && html`<${UsersModal} me=${me} onClose=${() => setModal(null)} />`}
    ${modal === "account" && html`<${AccountModal} me=${me} onClose=${() => { setModal(null); loadMe(); }} />`}
    ${modal === "audit" && html`<${AuditModal} onClose=${() => setModal(null)} />`}
    <${TipHost} /><${AskHost} /><${Toasts} />`;
}

render(html`<${App} />`, document.getElementById("app"));
