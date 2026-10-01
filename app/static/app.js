import { render, useState, useEffect, useMemo, useCallback, useErrorBoundary } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Segmented, Toasts, toast, Spinner, useInterval, Logo, markdown,
  vlanColors, readable, speedLabel, bytes, ago, rank, ROLE_LABEL, MODE_LABEL, lsGet, lsSet, ask, AskHost, Avatar,
} from "./ui.js";
import { SettingsModal, UsersModal, AccountModal, AuditModal, EnvInfoModal } from "./admin.js";

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

const TAG_TEXT = { auto: "All VLANs tagged", block_all: "Untagged only", custom: "Some VLANs tagged" };
// what a port is for: decides its mark, and why it's protected
const ROLE = {
  uplink: { icon: "uplink", long: "Uplink" },
  device: { icon: "link", long: "Link to a UniFi device" },
  wan: { icon: "globe", long: "WAN (internet)" },
  lag: { icon: "merge", long: "Link aggregation" },
  mirror: { icon: "mirror", long: "Port mirroring" },
};
const nativeOnly = (device) => !!(device && device.caps && device.caps.tagged_vlans === false);
const roleLine = (port) => (ROLE[port.role] ? `${ROLE[port.role].long}${port.peer ? ` · ${port.peer}` : ""}` : null);

function PortTip({ port, device, networks }) {
  const n = netOf(networks, port.native_network_id);
  const c = port.clients[0];
  const tag = nativeOnly(device) ? "tagging not supported" : TAG_TEXT[port.tagged_mode];
  return html`<div class="tip-title">Port ${port.idx}${port.name !== `Port ${port.idx}` ? ` · ${port.name}` : ""}</div>
    <div class="tip-row"><span class=${"led " + (port.up ? "on" : "")}></span>${port.up ? `Up · ${speedLabel(port.speed)}${port.full_duplex ? " FD" : ""}` : port.enabled ? "No link" : "Disabled"}</div>
    ${port.role && html`<div class="tip-row"><${Icon} name=${ROLE[port.role].icon} size=${13} />${roleLine(port)}</div>`}
    ${!port.wan && html`<div class="tip-row"><${Icon} name="tag" size=${13} />${port.native_network_id === null ? "VLAN not available through UniFi's cloud" : `${n ? `${n.name} (${n.vlan})` : "Unknown network"} · ${tag}`}</div>`}
    ${port.poe_capable && html`<div class="tip-row"><${Icon} name="bolt" size=${13} />${port.poe_active ? (port.poe_power == null ? "PoE delivering" : `PoE delivering ${port.poe_power} W`) : port.poe_enabled ? "PoE on · idle" : "PoE off"}</div>`}
    ${c && html`<div class="tip-row"><${Icon} name="plug" size=${13} />${c.name || c.hostname || c.mac}${port.client_count > 1 ? ` +${port.client_count - 1}` : ""}</div>`}
    ${port.profile_name && html`<div class="tip-row"><${Icon} name="layers" size=${13} />Profile: ${port.profile_name}</div>`}
    ${port.lock && html`<div class="tip-row warn"><${Icon} name="lock" size=${13} />Locked by an admin${port.lock.note ? `: ${port.lock.note}` : ""}</div>`}
    ${port.lock && port.lock.drift && html`<div class="tip-row warn"><${Icon} name="alert" size=${13} />Changed in UniFi since it was locked</div>`}
    ${port.protected && html`<div class="tip-row warn"><${Icon} name="shield" size=${13} />Protected: changing it could cut something off</div>`}`;
}

function Flags({ port, device, size = 10 }) {
  // ordinary ports show whether they carry tagged VLANs; uplinks and device links show their role instead
  const tagMark = !port.role && !nativeOnly(device) && port.native_network_id !== null;
  return html`<span class="p-flags">
    ${port.role && html`<span class=${"flag-role " + port.role} title=${roleLine(port)}><${Icon} name=${ROLE[port.role].icon} size=${size} /></span>`}
    ${!port.role && port.protected && html`<span title="Protected"><${Icon} name="shield" size=${size} /></span>`}
    ${tagMark && port.tagged_mode === "auto" && html`<span title="All VLANs tagged"><${Icon} name="trunk" size=${size} /></span>`}
    ${tagMark && port.tagged_mode === "custom" && html`<span title="Some VLANs tagged"><${Icon} name="trunksome" size=${size} /></span>`}
    ${port.profile_name && html`<span title="Port profile"><${Icon} name="layers" size=${size} /></span>`}
    ${port.lock && html`<span class=${"flag-lock" + (port.lock.drift ? " drift" : "")} title=${port.lock.drift ? "Locked - but changed in UniFi" : "Locked by an admin"}><${Icon} name=${port.lock.drift ? "alert" : "lock"} size=${size} /></span>`}
  </span>`;
}

function tileLabel(port, n) {
  if (port.wan) return "WAN";
  if (n) return n.vlan;
  return port.native_network_id === null ? (port.sfp ? "SFP" : "") : "?";
}

function PortTile({ port, device, networks, colors, highlight, selected, onPick }) {
  const n = netOf(networks, port.native_network_id);
  const color = port.wan ? "#475569" : colors[port.native_network_id] || "#64748b";
  const dim = highlight && !carries(port, highlight);
  const cls = ["port", port.up ? "up" : "down", port.enabled ? "" : "off", dim ? "dim" : "", selected ? "sel" : "",
    port.sfp ? "sfp" : "", port.wan ? "wan" : ""].join(" ");
  return html`<button class=${cls} style=${`--c:${color};--fg:${readable(color)}`}
    onClick=${() => { hideTip(); onPick(device.id, port.idx); }}
    onMouseEnter=${canHover ? (e) => showTip(e, html`<${PortTip} port=${port} device=${device} networks=${networks} />`) : undefined}
    onMouseLeave=${canHover ? hideTip : undefined}
    aria-label=${`Port ${port.idx}, ${n ? n.name : ""}`}>
    <span class="p-num">${port.idx}</span>
    ${port.poe_capable && html`<span class=${"p-poe " + (port.poe_active ? "active" : port.poe_enabled ? "on" : "offpoe")}>
      <${Icon} name="bolt" size=${11} fill=${port.poe_active} /></span>`}
    <span class="p-vlan">${tileLabel(port, n)}</span>
    <${Flags} port=${port} device=${device} />
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

const cfgOf = (p) => ({ native_network_id: p.native_network_id, tagged_mode: p.tagged_mode, excluded_network_ids: p.excluded_network_ids });
const sig = (p) => `${p.native_network_id}|${p.tagged_mode}|${[...p.excluded_network_ids].sort().join()}`;

function PortDrawer({ env, access, device, port, networks, colors, me, settings, onClose, onApplied, readonly }) {
  const restricted = !access.all_vlans;
  const can = (c) => (me.caps || []).includes(c);
  const mayProtected = can("ports.protected") || env.supervisors_protected;
  const isAdmin = can("ports.lock");   // lock controls
  const lock = port.lock;
  const fixedTags = nativeOnly(device);   // e.g. USW Flex Mini: only the native VLAN can be set
  const canEdit = !readonly && !port.wan && can("ports.change") && (!port.protected || mayProtected) && (!lock || isAdmin);
  const [lockNote, setLockNote] = useState("");
  const [lockBusy, setLockBusy] = useState(false);
  const portUrl = `/api/envs/${env.id}/devices/${device.id}/ports/${port.idx}`;
  async function lockAction(method, path, body, msg) {
    setLockBusy(true);
    try {
      const r = await api(portUrl + path, { method, body });
      toast(msg);
      if (r && r.warning) toast(r.warning, "warn");
      setLockNote("");
      onApplied();
    } catch (e) { toast(e.message, "err"); }
    setLockBusy(false);
  }
  const defMode = fixedTags ? port.tagged_mode
    : restricted && settings.default_tagged_mode === "auto" ? "block_all" : (settings.default_tagged_mode || "block_all");
  const allowed = networks.filter((n) => n.allowed);
  const [native, setNative] = useState(port.native_network_id);
  const [mode, setMode] = useState(defMode);
  const [excluded, setExcluded] = useState(port.tagged_mode === "custom" ? port.excluded_network_ids : []);
  const [base, setBase] = useState(cfgOf(port));     // what the user saw when they started
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setNative(port.native_network_id); setMode(defMode);
    setExcluded(port.tagged_mode === "custom" ? port.excluded_network_ids : []);
    setBase(cfgOf(port)); setTouched(false);
  };
  useEffect(reset, [device.id, port.idx]);
  // someone changed this port in UniFi while the panel is open: follow along until the user edits
  useEffect(() => { if (!touched) reset(); }, [sig(port)]);
  const changedElsewhere = touched && sig(port) !== sig({ ...base });
  const edit = (fn) => (v) => { setTouched(true); fn(v); };

  const cur = netOf(networks, port.native_network_id);
  const next = netOf(networks, native);
  const sameEx = [...excluded].sort().join() === [...port.excluded_network_ids].sort().join();
  const dirty = native !== port.native_network_id || (!fixedTags && (mode !== port.tagged_mode || (mode === "custom" && !sameEx)));

  async function apply(extra = {}) {
    setBusy(true);
    try {
      const r = await api(`/api/envs/${env.id}/devices/${device.id}/ports/${port.idx}`, { method: "PUT",
        body: { native_network_id: native, tagged_mode: mode, excluded_network_ids: mode === "custom" ? excluded : [],
          expected: base, ...extra } });
      toast(`Port ${port.idx} → ${next.name} (${next.vlan})${fixedTags ? "" : `, ${MODE_LABEL[mode]}`}`);
      if (r.warning) toast(r.warning, "warn");
      setTouched(false);
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
      } else if (e.status === 409 && e.data.confirm === "locked") {
        const ok = await ask({ title: "Change a locked port?", confirm: "Change and keep locked",
          body: html`<p>You locked this port${e.data.note ? html` (<b>${e.data.note}</b>)` : ""}. It stays locked, to the new settings.</p>` });
        if (ok) return apply({ ...extra, confirm_locked: true });
      } else if (e.status === 409 && e.data.confirm === "changed") {
        const ok = await ask({ title: "Port changed in UniFi", danger: true, confirm: "Apply mine anyway",
          body: html`<p>Someone changed this port in UniFi after you opened it. It's now <b>${e.data.current.native}</b>, ${e.data.current.tagged}.</p>
            <p>Apply your change over it?</p>` });
        if (ok) return apply({ ...extra, confirm_changed: true });
        onApplied();
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
          ${!port.poe_capable ? "Not supported" : port.poe_active ? html`<${Icon} name="bolt" size=${14} fill />${port.poe_power == null ? "Delivering" : `${port.poe_power} W`}` : port.poe_enabled ? `On · idle (${port.poe_mode})` : "Off"}</span></div>
        ${port.wan ? null : readonly ? html`<div class="sg"><span class="sg-l">Max speed</span><span class="sg-v">${speedLabel(port.max_speed) || "—"}</span></div>` : html`
        <div class="sg"><span class="sg-l">Native VLAN</span><span class="sg-v"><span class="dot" style=${`background:${colors[port.native_network_id]}`}></span>${cur ? `${cur.name} (${cur.vlan})` : "?"}</span></div>
        <div class="sg"><span class="sg-l">Tagged</span><span class="sg-v">${fixedTags ? "Not supported" : TAG_TEXT[port.tagged_mode]}</span></div>`}
        ${port.media && html`<div class="sg"><span class="sg-l">Port type</span><span class="sg-v">${port.media_label || port.media}${port.sfp_found === false ? " · empty" : ""}</span></div>`}
        ${port.up && port.rx_bytes != null && html`<div class="sg"><span class="sg-l">Traffic</span><span class="sg-v">↓ ${bytes(port.rx_bytes)} · ↑ ${bytes(port.tx_bytes)}</span></div>`}
      </div>
      ${(c0.length > 0 || port.device_link || port.lldp) && html`<div class="panel">
        <div class="panel-title">Connected</div>
        ${port.device_link && html`<div class="client"><${Icon} name="server" size=${14} /><b>${port.device_link}</b><span class="muted">UniFi device</span></div>`}
        ${c0.map((c) => html`<div class="client"><${Icon} name="plug" size=${14} /><b>${c.name || c.hostname || c.mac}</b>
          <span class="muted mono">${c.mac}${c.ip ? ` · ${c.ip}` : ""}</span></div>`)}
        ${port.client_count > c0.length && html`<div class="muted">+${port.client_count - c0.length} more</div>`}
        ${port.lldp && !port.device_link && html`<div class="client"><${Icon} name="link" size=${14} /><b>${port.lldp.name || port.lldp.chassis_id}</b><span class="muted">LLDP ${port.lldp.port}</span></div>`}
      </div>`}

      ${readonly && html`<div class="notice warn"><${Icon} name="eye" /><div><b>View only.</b> This environment is connected through
        UniFi's cloud, which doesn't show or change port VLANs. An admin can switch it to a Direct connection for full control.</div></div>`}
      ${changedElsewhere && html`<div class="notice warn"><${Icon} name="refresh" /><div><b>Changed in UniFi.</b> This port is now
        ${cur ? `${cur.name} (${cur.vlan})` : "?"}, ${MODE_LABEL[port.tagged_mode]}.
        <button class="link-btn" onClick=${reset}>Start over from that</button></div></div>`}
      ${lock && html`<div class=${"notice lock" + (lock.drift ? " warn" : "")}><${Icon} name="lock" /><div>
        <b>Locked by an admin</b>${lock.note && html` — ${lock.note}`}.
        ${(() => { const n = netOf(networks, lock.native_network_id); return html` Locked to <b>${n ? `${n.name} (${n.vlan})` : "?"}</b>, ${MODE_LABEL[lock.tagged_mode]}.`; })()}
        ${lock.drift && html`<div class="warn-text"><b>It was changed in UniFi</b> and no longer matches the lock.</div>`}
        ${!isAdmin && html`<div class="muted small">Only someone who can lock ports can change it.</div>`}
        ${isAdmin && html`<div class="lock-actions">
          ${lock.drift && html`<button class="btn sm primary" disabled=${lockBusy} onClick=${() => lockAction("POST", "/lock/reapply", {}, "Locked settings re-applied")}><${Icon} name="refresh" size=${14} />Re-apply locked settings</button>`}
          <button class="btn sm" disabled=${lockBusy} onClick=${() => lockAction("DELETE", "/lock", {}, `Port ${port.idx} unlocked`)}>Unlock</button>
        </div>`}</div></div>`}
      ${port.wan ? html`<div class="notice"><${Icon} name="globe" /><div><b>WAN port.</b> It connects to the internet, so its settings live in
        UniFi's Internet settings, not here.</div></div>`
        : port.protected && html`<div class="notice warn"><${Icon} name="shield" /><div><b>Protected port</b> — ${port.protect_reasons.join(" · ")}.
        Changing it could cut off ${port.peer ? html`<b>${port.peer}</b> and what's behind it` : "the switch or what's behind it"}, so the app guards it.
        ${mayProtected ? " You can change it after confirming." : " You don't have permission to change protected ports."}</div></div>`}
      ${port.profile_name && html`<div class="notice"><${Icon} name="layers" /><div>Uses port profile <b>${port.profile_name}</b>. Applying a VLAN here detaches it.</div></div>`}
      ${canEdit && allowed.length === 0 && html`<div class="notice warn"><${Icon} name="info" /><div>You haven't been given any networks in this environment. Ask an admin.</div></div>`}

      ${!readonly && !port.wan && html`<div class="panel">
        <div class="panel-title">Core settings ${!canEdit && html`<span class="badge">View only</span>`}</div>
        <label class="field"><span class="field-label">Native VLAN / Network</span>
          <div class="select-wrap"><span class="dot" style=${`background:${colors[native]}`}></span>
            <select value=${native} disabled=${!canEdit} onChange=${(e) => edit(setNative)(e.target.value)}>
              ${networks.filter((n) => n.allowed || n.id === native || n.id === port.native_network_id).map((n) =>
                html`<option value=${n.id} disabled=${!n.allowed}>${n.name} (${n.vlan})${n.allowed ? "" : " — not yours"}</option>`)}
            </select><${Icon} name="chevron" cls="select-chev" /></div></label>
        ${fixedTags ? html`<div class="field"><span class="field-label">Tagged VLAN Management</span>
          <div class="notice"><${Icon} name="info" /><div><b>${device.model_name}</b> can't filter tagged VLANs per port, so only the native VLAN
            is set here. Tagging settings would be ignored by the switch.
            ${can("settings.manage") && html`<div><button class="link-btn small" onClick=${() => setModelCaps(device, true, onApplied)}>
              This model can filter tagged VLANs</button></div>`}</div></div></div>`
        : html`<div class="field"><span class="field-label">Tagged VLAN Management</span>
          <${Segmented} value=${mode} disabled=${!canEdit} onChange=${edit(setMode)}
            options=${[{ value: "auto", label: "Allow All", disabled: restricted, title: restricted ? "Would tag networks you don't have" : "" },
              { value: "block_all", label: "Block All" }, { value: "custom", label: "Custom" }]} />
          <small class="hint">${mode === "block_all" ? "Access port: only the native VLAN, nothing tagged." : mode === "auto" ? "Trunk: every network is tagged on this port." : "Trunk: only the networks ticked below are tagged."}</small>
          ${can("settings.manage") && device.type === "usw" && html`<small class="hint"><button class="link-btn small" onClick=${() => setModelCaps(device, false, onApplied)}>
            ${device.model_name} ignores tagged VLAN settings?</button></small>`}
        </div>`}
        ${!fixedTags && mode === "custom" && html`<div class="tag-list">
          ${allowed.filter((n) => n.id !== native).map((n) => html`<label class="tag-row" key=${n.id}>
            <input type="checkbox" disabled=${!canEdit} checked=${!excluded.includes(n.id)}
              onChange=${(e) => edit(setExcluded)(e.target.checked ? excluded.filter((x) => x !== n.id) : [...excluded, n.id])} />
            <span class="dot" style=${`background:${colors[n.id]}`}></span>${n.name}<span class="chip-vlan">${n.vlan}</span></label>`)}
          ${allowed.filter((n) => n.id !== native).length === 0 && html`<span class="muted small">No other networks to tag.</span>`}
        </div>`}
      </div>`}

      ${isAdmin && !lock && !readonly && !port.wan && html`<div class="panel lock-panel">
        <div class="panel-title"><span><${Icon} name="lock" size=${15} /> Lock this port</span></div>
        <p class="muted small">Only admins can change a locked port. Good for upstream trunks and dedicated ports. It's locked to the settings UniFi has right now.</p>
        <div class="row"><input placeholder="Why? e.g. Upstream trunk from core port 17" value=${lockNote} maxlength="300" onInput=${(e) => setLockNote(e.target.value)} />
          <button class="btn ghost" disabled=${lockBusy || dirty} title=${dirty ? "Apply or reset your changes first" : ""}
            onClick=${() => lockAction("PUT", "/lock", { note: lockNote }, `Port ${port.idx} locked`)}><${Icon} name="lock" size=${14} />Lock</button></div>
        ${dirty && html`<small class="hint">Apply or reset your changes first.</small>`}
      </div>`}
      ${canEdit && dirty && next && html`<div class="diff">
        ${native !== port.native_network_id && html`<div><span class="muted">Native</span> ${cur ? cur.name : "?"} <span class="arrow">→</span> <b>${next.name} (${next.vlan})</b></div>`}
        ${!fixedTags && (mode !== port.tagged_mode || (mode === "custom" && !sameEx)) && html`<div><span class="muted">Tagged</span> ${MODE_LABEL[port.tagged_mode]} <span class="arrow">→</span> <b>${MODE_LABEL[mode]}</b></div>`}
      </div>`}
    </div>
    ${canEdit && html`<footer class="drawer-foot">
      <button class="btn ghost" disabled=${busy || !dirty} onClick=${reset}>Reset</button>
      <button class="btn primary" disabled=${busy || !dirty || !(next && next.allowed)} onClick=${() => apply()}>${busy ? html`<${Spinner} /> Applying…` : "Apply changes"}</button>
    </footer>`}
  </aside>`;
}

/** Admins: tell the app whether a switch model can filter tagged VLANs (applies to every switch of that model). */
async function setModelCaps(device, tagged, onDone) {
  const builtin = device.caps.tagged_vlans_builtin;
  const ok = await ask({ title: tagged ? `${device.model_name} can filter tagged VLANs?` : `${device.model_name} ignores tagged VLANs?`,
    confirm: tagged ? "Yes, show tagging" : "Yes, native VLAN only",
    body: tagged ? html`<p>Tagged VLAN Management will be offered again on every <b>${device.model_name}</b> (${device.model}).</p>`
      : html`<p>On every <b>${device.model_name}</b> (${device.model}), only the native VLAN will be set and tagging is hidden,
        because the switch would ignore it.</p>` });
  if (!ok) return;
  try {
    await api("/api/admin/model-caps", { method: "PUT", body: { model: device.model, tagged_vlans: tagged === builtin ? null : tagged } });
    toast("Saved for every " + device.model_name);
    onDone();
  } catch (e) { toast(e.message, "err"); }
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
      <button class="btn ghost" onClick=${() => setSel(devices.filter((d) => d.type === "usw").map((d) => d.mac))}>All switches</button>
      <button class="btn ghost" onClick=${() => setSel([])}>None</button>
      <button class="btn primary" onClick=${() => onSave(sel)}>Show selected</button>`}>
    <div class="search"><${Icon} name="search" /><input placeholder="Search name, model, IP or MAC" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    <div class="pick-list">
      ${list.map((d) => {
        const on = sel.includes(d.mac);
        return html`<div class=${"pick" + (on ? " on" : "")} key=${d.mac} onClick=${() => toggle(d.mac)}>
          <span class=${"check" + (on ? " on" : "")}>${on && html`<${Icon} name="check" size=${14} />`}</span>
          <span class=${"status-dot " + (d.online ? "on" : "")}></span>
          <div class="pick-main"><b>${d.name}</b><span class="muted">${d.model_name} · ${d.type_label} · ${d.ip || d.mac}</span></div>
          <span class="badge">${d.port_count} ports</span>
          ${on && html`<span class="order" onClick=${(e) => e.stopPropagation()}>
            <button class="icon-btn sm" title="Move up" onClick=${() => move(d.mac, -1)}><${Icon} name="chevron" size=${14} cls="up" /></button>
            <button class="icon-btn sm" title="Move down" onClick=${() => move(d.mac, 1)}><${Icon} name="chevron" size=${14} /></button></span>`}
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
  const [envList, setEnvList] = useState(null);
  const [envId, setEnvId] = useState(lsGet("vlanmgr.env", null));
  const [st, setSt] = useState(null);
  const [version, setVersion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);
  const [sel, setSel] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [collapsed, setCollapsed] = useState(lsGet("vlanmgr.collapsed", {}));
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState(lsGet("vlanmgr.theme", "dark"));
  const [bootErr, setBootErr] = useState(null);

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
  const loadEnvs = useCallback(async () => {
    const r = await api("/api/envs");
    setEnvList(r);
    setEnvId((cur) => (r.envs.some((e) => e.id === cur) ? cur : (r.envs[0] ? r.envs[0].id : null)));
    return r;
  }, []);
  const load = useCallback(async (refresh) => {
    if (!envId) return;
    setLoading(true);
    try {
      const s = await api(`/api/envs/${envId}/state` + (refresh ? "?refresh=1" : ""));
      setSt((prev) => (s.env.id === envId ? s : prev));
    } catch (e) {
      if (e.status === 404) loadEnvs();          // access was removed meanwhile
      else if (refresh) toast(e.message, "err");
    }
    setLoading(false);
  }, [envId]);
  const loadVersion = useCallback(async () => {
    const v = await api("/api/version");
    // the server was upgraded while this page (or installed app) stayed open: load the new UI
    if (v.build && BUILD && v.build !== BUILD) {
      let seen = null;
      try { seen = sessionStorage.getItem("vlanmgr.reloadedFor"); sessionStorage.setItem("vlanmgr.reloadedFor", v.build); } catch (e) { /* private mode */ }
      if (seen !== v.build) location.reload();
    }
    setVersion(v);
    return v;
  }, []);

  useEffect(() => {
    Promise.all([loadMe(), loadEnvs()]).catch((e) => { if (e.message !== "Signed out") setBootErr(e.message); });
    loadVersion().then((v) => {
      if (lsGet("vlanmgr.seenVersion") !== v.version) { setModal("changelog"); lsSet("vlanmgr.seenVersion", v.version); }
    });
  }, []);
  useEffect(() => { lsSet("vlanmgr.env", envId); setSel(null); setHighlight(null); setSt(null); load(true); }, [envId]);
  // back to the app (phone unlocked, tab focused): fetch what changed in UniFi meanwhile
  useEffect(() => {
    const back = () => { if (!document.hidden) { load(true); loadEnvs().catch(() => {}); loadVersion().catch(() => {}); } };
    document.addEventListener("visibilitychange", back);
    addEventListener("focus", back);
    return () => { document.removeEventListener("visibilitychange", back); removeEventListener("focus", back); };
  }, [load]);
  const poll = ((envList && envList.settings.poll_seconds) || 10) * 1000;
  useInterval(() => { if (!document.hidden && !modal) load(); }, poll);
  useInterval(() => { if (!document.hidden) loadVersion(); }, 30 * 60 * 1000);

  async function savePrefs(patch) {
    const prefs = { ...(me.prefs || {}), ...patch };
    setMe({ ...me, prefs });
    if (me.method === "none") lsSet("vlanmgr.prefs", prefs);
    else await api("/api/me/prefs", { method: "PUT", body: patch }).catch((e) => toast(e.message, "err"));
  }

  if (bootErr) return html`<${BootError} error=${bootErr} />`;
  if (!me || !envList) {
    return html`<div class="boot"><${Logo} size=${48} /><${Spinner} /></div>`;
  }
  window.__vlanmgrStarted = true;

  const settings = envList.settings;
  const prefs = me.prefs || {};
  const can = (c) => (me.caps || []).includes(c);
  const isAdmin = can("settings.manage");
  const canEnvs = can("envs.manage");
  const env = envList.envs.find((e) => e.id === envId);
  const ready = st && env && st.env.id === env.id;
  const networks = ready ? st.networks : [];
  const devices = ready ? st.devices : [];
  const colors = vlanColors(networks, env ? env.vlan_colors : {}, prefs.vlan_colors || {});
  const picks = prefs.devices && !Array.isArray(prefs.devices) ? prefs.devices : {};
  const chosen = env && Array.isArray(picks[env.id]) ? picks[env.id] : null;
  const shown = chosen
    ? chosen.map((mac) => devices.find((d) => d.mac === mac)).filter(Boolean)
    : devices.filter((d) => d.type === "usw" || (env && !env.access.all_devices));
  const selDev = sel && devices.find((d) => d.id === sel.d);
  const selPort = selDev && selDev.ports.find((p) => p.idx === sel.i);
  const upd = version && version.update && version.update.update_available;
  const pick = (d, i) => setSel(sel && sel.d === d && sel.i === i ? null : { d, i });
  const onEnvsChanged = () => { loadEnvs(); load(true); };

  let body;
  if (envList.envs.length === 0) {
    body = html`<div class="empty"><div class="empty-icon"><${Icon} name="server" size=${40} /></div>
      ${canEnvs ? html`<h2>Add your first environment</h2>
          <p class="muted">An environment is one UniFi console or UniFi OS instance, reached with its own API key.</p>
          <button class="btn primary" onClick=${() => setModal("settings")}><${Icon} name="plus" />Add environment</button>`
        : html`<h2>Nothing here yet</h2><p class="muted">An admin hasn't given you access to any switches yet.</p>`}</div>`;
  } else if (!ready) {
    body = html`<div class="empty"><${Spinner} /></div>`;
  } else if (st.error === "not_configured") {
    body = html`<div class="empty"><div class="empty-icon"><${Icon} name="key" size=${40} /></div>
      <h2>${env.name} isn't connected yet</h2>
      <p class="muted">${canEnvs ? "Add the console address and an API key for this environment." : "An admin still needs to add this environment's API key."}</p>
      ${canEnvs && html`<button class="btn primary" onClick=${() => setModal("settings")}><${Icon} name="settings" />Open settings</button>`}</div>`;
  } else if (st.error) {
    body = html`<div class="notice err big"><${Icon} name="alert" /><div><b>Can't load ${env.name} from UniFi.</b> ${st.error}
      <div><button class="link-btn" onClick=${() => load(true)}>Try again</button>${isAdmin && html` · <button class="link-btn" onClick=${() => setModal("settings")}>Settings</button>`}</div></div></div>`;
  } else {
    body = html`
      ${st.readonly && html`<div class="notice warn"><${Icon} name="eye" /><div><b>View only (UniFi cloud).</b> ${st.readonly_reason}</div></div>`}
      ${!st.readonly && html`<${Legend} networks=${networks} colors=${colors} devices=${shown} highlight=${highlight} setHighlight=${setHighlight} onColors=${() => setModal("colors")} />`}
      ${!chosen && devices.length > 1 && html`<div class="notice"><${Icon} name="info" /><div>Showing ${env.access.all_devices ? "all switches" : "your devices"}. <button class="link-btn" onClick=${() => setModal("picker")}>Choose which to show</button></div></div>`}
      ${shown.length === 0 ? html`<div class="empty"><div class="empty-icon"><${Icon} name="grid" size=${40} /></div>
          <h2>${devices.length ? "No devices selected" : "No devices"}</h2>
          <p class="muted">${devices.length ? "Pick the switches you want to see." : env.access.all_devices ? "This environment has no devices with ports yet." : "None of your devices are on the controller right now."}</p>
          ${devices.length > 0 && html`<button class="btn primary" onClick=${() => setModal("picker")}>Choose devices</button>`}</div>`
        : html`<div class="devices">${shown.map((d) => html`<${DeviceCard} key=${d.id} device=${d} networks=${networks} colors=${colors}
            highlight=${highlight} sel=${sel} onPick=${pick} collapsed=${!!collapsed[d.mac]}
            onCollapse=${() => { const c = { ...collapsed, [d.mac]: !collapsed[d.mac] }; setCollapsed(c); lsSet("vlanmgr.collapsed", c); }} />`)}</div>`}
      <div class="key">
        <span><span class="k-tile up"></span>Link up</span><span><span class="k-tile"></span>No link</span><span><span class="k-off"></span>Disabled</span>
        <span><span class="k-poe active"><${Icon} name="bolt" size=${11} fill /></span>PoE delivering</span>
        <span><span class="k-poe"><${Icon} name="bolt" size=${11} /></span>PoE on, idle</span>
        <span><${Icon} name="trunk" size=${12} />All VLANs tagged</span><span><${Icon} name="trunksome" size=${12} />Some VLANs tagged</span>
        <span><${Icon} name="uplink" size=${12} />Uplink</span><span><${Icon} name="link" size=${12} />UniFi device</span>
        <span><${Icon} name="globe" size=${12} />WAN</span><span><${Icon} name="merge" size=${12} />LAG</span>
        <span><${Icon} name="layers" size=${12} />Port profile</span>
        <span class="key-note"><${Icon} name="shield" size=${12} />Uplinks, UniFi device links, WAN, LAG and mirror ports are <b>protected</b>:
          changing them could cut something off, so it takes extra permission and a confirmation.</span>
        <span class="k-lock"><${Icon} name="lock" size=${12} />Locked by an admin</span>
      </div>`;
  }

  return html`
    ${me.no_auth && html`<div class="danger-banner"><${Icon} name="alert" />
      <span><b>No-auth mode is on.</b> Anyone who can reach this page can ${can("ports.change") ? "change switch ports" : "see your network"}${isAdmin ? " and settings" : ""} without signing in.</span>
      ${me.method === "none" && html`<a href="/login?manual=1">Sign in</a>`}</div>`}
    ${me.impersonator && html`<div class="imp-banner"><${Icon} name="eye" />
      <span>You're viewing as <b>${me.display_name || me.username}</b> (${me.role_name}). Anything you change is logged as ${me.impersonator.username} (as ${me.username}).</span>
      <button class="btn sm" onClick=${async () => { await api("/api/impersonate/stop", { method: "POST" }); location.reload(); }}>Stop viewing as</button></div>`}
    ${me.initial_password && html`<div class="warn-banner"><${Icon} name="key" /><span>You're using the generated admin password.</span>
      <button class="link-btn" onClick=${() => setModal("account")}>Change it now</button></div>`}
    <header class="topbar">
      <div class="brand"><${Logo} /><div><div class="brand-name">${settings.app_name}</div>
        <div class="brand-sub">${env ? `${env.name} · ${env.mode === "cloud" ? "UniFi cloud" : "UniFi"}${ready && st.fetched_at ? ` · updated ${ago(st.fetched_at)}` : ""}` : "No environment"}</div></div></div>
      <div class="top-actions">
        <button class="btn ghost" disabled=${!env} onClick=${() => load(true)} title="Refresh from UniFi">
          <${Icon} name="refresh" cls=${loading ? "spin" : ""} /><span class="hide-sm">Refresh</span></button>
        <button class="btn ghost" onClick=${() => setModal("picker")} disabled=${!devices.length}><${Icon} name="grid" /><span class="hide-sm">Devices</span></button>
        ${can("activity.view") && html`<button class="btn ghost hide-sm" onClick=${() => setModal("audit")}><${Icon} name="list" /><span class="hide-sm">Activity</span></button>`}
        ${can("users.view") && html`<button class="btn ghost hide-sm" onClick=${() => setModal("users")}><${Icon} name="users" /><span class="hide-sm">Users</span></button>`}
        ${(isAdmin || canEnvs) && html`<button class="icon-btn hide-sm" onClick=${() => setModal("settings")} title="Settings"><${Icon} name="settings" /></button>`}
        <button class="icon-btn theme-btn" onClick=${() => setTheme(theme === "dark" ? "light" : "dark")}
          title=${theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle day / night">
          <${Icon} name=${theme === "dark" ? "sun" : "moon"} /></button>
        <div class="menu-wrap">
          <button class="user-btn" onClick=${() => setMenu(!menu)}>
            <${Avatar} user=${me} />
            <span class="hide-sm user-name">${me.display_name || me.username}</span>
            <span class=${"role-badge " + me.role}>${me.role_name}</span></button>
          ${menu && html`<div class="menu-scrim" onClick=${() => setMenu(false)}></div>`}
          ${menu && html`<div class="menu" onMouseLeave=${canHover ? () => setMenu(false) : undefined}>
            <div class="menu-head"><${Avatar} user=${me} size=${40} /><b>${me.display_name || me.username}</b><span class="muted">${me.username} · ${me.method === "oidc" ? "SSO" : me.method === "token" ? "token" : me.method === "none" ? "not signed in" : "password"}</span></div>
            ${can("env.info") && env && html`<button onClick=${() => { setMenu(false); setModal("envinfo"); }}><${Icon} name="server" />About ${env.name}</button>`}
            ${can("activity.view") && html`<button class="show-sm" onClick=${() => { setMenu(false); setModal("audit"); }}><${Icon} name="list" />Activity</button>`}
            ${can("users.view") && html`<button class="show-sm" onClick=${() => { setMenu(false); setModal("users"); }}><${Icon} name="users" />Users</button>`}
            ${(isAdmin || canEnvs) && html`<button class="show-sm" onClick=${() => { setMenu(false); setModal("settings"); }}><${Icon} name="settings" />Settings</button>`}
            ${me.id ? html`<button onClick=${() => { setMenu(false); setModal("account"); }}><${Icon} name="user" />My account</button>` : null}
            ${env && html`<button onClick=${() => { setMenu(false); setModal("colors"); }}><${Icon} name="palette" />My VLAN colors</button>`}
            <button onClick=${() => setTheme(theme === "dark" ? "light" : "dark")}><${Icon} name=${theme === "dark" ? "sun" : "moon"} />${theme === "dark" ? "Light" : "Dark"} theme</button>
            ${me.method !== "none" ? html`<button onClick=${async () => { const r = await api("/api/auth/logout", { method: "POST" }); location.href = r.redirect; }}><${Icon} name="logout" />Sign out</button>`
              : html`<a href="/login?manual=1"><${Icon} name="login" />Sign in</a>`}
          </div>`}
        </div>
      </div>
    </header>

    <main class=${"main" + (selPort ? " with-drawer" : "")}>
      ${env && html`<div class="env-bar">
        ${envList.envs.length > 1 ? html`<label class="env-select"><${Icon} name="server" size=${16} />
          <select value=${envId || ""} onChange=${(e) => setEnvId(Number(e.target.value))} aria-label="Environment">
            ${envList.envs.map((e) => html`<option value=${e.id}>${e.name}</option>`)}</select></label>`
          : html`<span class="env-select single"><${Icon} name="server" size=${16} /><b>${env.name}</b></span>`}
        ${ready && st.fetched_at ? html`<span class="muted small env-updated">Updated ${ago(st.fetched_at)}</span>` : null}
      </div>`}
      ${body}
    </main>

    ${selPort && html`<${PortDrawer} readonly=${!!(st && st.readonly)} env=${env} access=${env.access} device=${selDev} port=${selPort} networks=${networks} colors=${colors} me=${me}
      settings=${settings} onClose=${() => setSel(null)} onApplied=${() => load(true)} />`}

    <button class=${"version" + (upd ? " has-update" : "")} onClick=${() => setModal("changelog")} title=${upd ? `Version ${version.update.latest} is available` : "Changelog"}>
      v${version ? version.version : "…"}${upd && html`<span class="pulse"></span>`}</button>

    ${modal === "changelog" && version && html`<${ChangelogModal} version=${version} isAdmin=${isAdmin} onClose=${() => setModal(null)}
      onCheck=${async () => { const r = await api("/api/version/check", { method: "POST" }); setVersion({ ...version, update: r.update }); toast(r.update.update_available ? `Version ${r.update.latest} is available` : "You're up to date"); }} />`}
    ${modal === "picker" && env && html`<${PickerModal} devices=${devices} selected=${chosen || shown.map((d) => d.mac)} onClose=${() => setModal(null)}
      onSave=${(macs) => { savePrefs({ devices: { ...picks, [env.id]: macs } }); setModal(null); }} />`}
    ${modal === "colors" && html`<${ColorsModal} networks=${networks} colors=${vlanColors(networks, env ? env.vlan_colors : {}, {})} mine=${prefs.vlan_colors || {}}
      onClose=${() => setModal(null)} onSave=${(v) => { savePrefs({ vlan_colors: v }); setModal(null); toast("Colors saved"); }} />`}
    ${modal === "settings" && html`<${SettingsModal} onClose=${() => setModal(null)} onSaved=${onEnvsChanged} />`}
    ${modal === "users" && html`<${UsersModal} me=${me} onClose=${() => { setModal(null); loadMe(); }} />`}
    ${modal === "account" && html`<${AccountModal} me=${me} onClose=${() => { setModal(null); loadMe(); }} />`}
    ${modal === "audit" && html`<${AuditModal} onClose=${() => setModal(null)} />`}
    ${modal === "envinfo" && env && html`<${EnvInfoModal} env=${env} networks=${networks} devices=${devices} onClose=${() => setModal(null)} />`}
    <${TipHost} /><${AskHost} /><${Toasts} />`;
}

const BUILD = (document.querySelector('meta[name="vlanmgr-build"]') || {}).content || "";

function BootError({ error }) {
  window.__vlanmgrStarted = true;
  return html`<div class="boot"><${Logo} size=${48} />
    <div class="boot-error"><h2>Something went wrong</h2><p class="muted">${String(error)}</p>
      <button class="btn primary" onClick=${() => location.reload()}><${Icon} name="refresh" />Reload</button></div></div>`;
}

// a crash anywhere in the UI shows the error instead of a frozen screen
function Root() {
  const [err] = useErrorBoundary((e) => console.error(e));
  if (err) return html`<${BootError} error=${err.message || err} />`;
  return html`<${App} />`;
}

render(html`<${Root} />`, document.getElementById("app"));
