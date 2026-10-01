import { render, useState, useEffect, useMemo, useCallback, useErrorBoundary } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Segmented, Toggle, Toasts, toast, Spinner, useInterval, Logo, markdown,
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

// --- display preferences (per person) ---------------------------------------------

// each part of a network bubble: "always" | "hover" | "off"
export const LEGEND_DEFAULTS = { vlan: "always", ports: "always", clients: "hover", ip: "hover", ip_format: "subnet",
  layout: "wrap", sort: "vlan", hide_unused: false, open: true };
export const PORTS_DEFAULTS = { phone: "tiles", desktop: "faceplate", hide_down: false, tag_marks: true };

const TAG_TEXT = { auto: "All VLANs tagged", block_all: "Untagged only", custom: "Some VLANs tagged" };
const ROLE = {
  uplink: { icon: "uplink", label: "Uplink", long: "Uplink" },
  device: { icon: "link", label: "UniFi device", long: "Link to a UniFi device" },
  wan: { icon: "globe", label: "WAN", long: "WAN (internet)" },
  lag: { icon: "merge", label: "LAG", long: "Link aggregation" },
  mirror: { icon: "mirror", label: "Mirror", long: "Port mirroring" },
};

function ipv4(s) { const p = String(s).split(".").map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? p : null; }
/** "192.168.20.1/24" as the subnet (192.168.20.0/24), the gateway (192.168.20.1) or both (192.168.20.1/24) */
export function ipText(subnet, fmt) {
  if (!subnet) return "";
  const [addr, bits] = subnet.split("/");
  if (fmt === "gateway") return addr;
  if (fmt === "both" || !bits) return subnet;
  const p = ipv4(addr);
  if (!p) return subnet;
  const n = Number(bits);
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  const v = (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0) & mask;
  return `${[v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".")}/${n}`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

// --- port tile + faceplate ------------------------------------------------------

function netOf(networks, id) { return networks.find((n) => n.id === id); }

function carries(port, netId) {
  if (port.native_network_id === netId) return true;
  if (port.tagged_mode === "auto") return true;
  if (port.tagged_mode === "custom") return !port.excluded_network_ids.includes(netId);
  return false;
}

const nativeOnly = (device) => !!(device && device.caps && device.caps.tagged_vlans === false);

function roleLine(port) {
  const r = ROLE[port.role];
  if (!r) return null;
  return `${r.long}${port.peer ? ` · ${port.peer}` : ""}`;
}

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

function Flags({ port, device, pv, size = 10 }) {
  const tagMark = pv.tag_marks && !port.role && !nativeOnly(device) && port.native_network_id !== null;
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

function PortTile({ port, device, networks, colors, highlight, selected, onPick, pv, mini }) {
  const n = netOf(networks, port.native_network_id);
  const color = port.wan ? "#475569" : colors[port.native_network_id] || "#64748b";
  const dim = highlight && !carries(port, highlight);
  const cls = ["port", port.up ? "up" : "down", port.enabled ? "" : "off", dim ? "dim" : "", selected ? "sel" : "",
    port.sfp ? "sfp" : "", mini ? "mini" : "", port.wan ? "wan" : ""].join(" ");
  return html`<button class=${cls} style=${`--c:${color};--fg:${readable(color)}`}
    onClick=${() => { hideTip(); onPick(device.id, port.idx); }}
    onMouseEnter=${canHover ? (e) => showTip(e, html`<${PortTip} port=${port} device=${device} networks=${networks} />`) : undefined}
    onMouseLeave=${canHover ? hideTip : undefined}
    aria-label=${`Port ${port.idx}, ${n ? n.name : ""}`}>
    <span class="p-num">${port.idx}</span>
    ${!mini && port.poe_capable && html`<span class=${"p-poe " + (port.poe_active ? "active" : port.poe_enabled ? "on" : "offpoe")}>
      <${Icon} name="bolt" size=${11} fill=${port.poe_active} /></span>`}
    ${!mini && html`<span class="p-vlan">${tileLabel(port, n)}</span>`}
    ${mini ? (port.lock || port.role) && html`<span class="p-flags">${port.lock ? html`<span class="flag-lock"><${Icon} name="lock" size=${9} /></span>`
      : html`<span class=${"flag-role " + port.role}><${Icon} name=${ROLE[port.role].icon} size=${9} /></span>`}</span>`
      : html`<${Flags} port=${port} device=${device} pv=${pv} />`}
    <span class="p-led"></span>
  </button>`;
}

function PortRow({ port, device, networks, colors, highlight, selected, onPick, pv }) {
  const n = netOf(networks, port.native_network_id);
  const color = port.wan ? "#475569" : colors[port.native_network_id] || "#64748b";
  const dim = highlight && !carries(port, highlight);
  const c = port.clients[0];
  const who = port.peer || (c ? c.name || c.hostname || c.mac : port.lldp ? port.lldp.name : "");
  return html`<button class=${"prow" + (port.up ? " up" : "") + (dim ? " dim" : "") + (selected ? " sel" : "")} style=${`--c:${color};--fg:${readable(color)}`}
    onClick=${() => onPick(device.id, port.idx)}>
    <span class="prow-num">${port.idx}</span>
    <span class="prow-main"><b>${port.wan ? "WAN" : n ? n.name : port.native_network_id === null ? (port.media_label || "Port") : "?"}</b>
      <span class="muted">${n && !port.wan ? `VLAN ${n.vlan}` : ""}${port.name !== `Port ${port.idx}` ? `${n && !port.wan ? " · " : ""}${port.name}` : ""}</span></span>
    <span class="prow-who">${who && html`<${Icon} name=${port.peer ? ROLE[port.role] ? ROLE[port.role].icon : "link" : "plug"} size=${12} />${who}${port.client_count > 1 ? ` +${port.client_count - 1}` : ""}`}</span>
    <span class="prow-state">
      ${port.poe_capable && html`<span class=${"p-poe " + (port.poe_active ? "active" : port.poe_enabled ? "on" : "offpoe")}><${Icon} name="bolt" size=${12} fill=${port.poe_active} /></span>`}
      <span class=${"prow-speed" + (port.up ? " on" : "")}>${port.up ? speedLabel(port.speed) : "—"}</span>
      <${Flags} port=${port} device=${device} pv=${pv} size=${12} /></span>
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

function Faceplate({ device, pv, ...rest }) {
  const mobile = useMobile();
  const view = mobile ? pv.phone : pv.desktop;
  const sel = (p) => rest.sel && rest.sel.d === device.id && rest.sel.i === p.idx;
  const tile = (p, mini) => html`<${PortTile} key=${p.idx} port=${p} device=${device} selected=${sel(p)} pv=${pv} mini=${mini} ...${rest} />`;
  const shown = (view === "compact" || view === "list") && pv.hide_down ? device.ports.filter((p) => p.up) : device.ports;
  const hidden = device.ports.length - shown.length;
  const more = hidden > 0 && html`<div class="muted small hidden-note">${plural(hidden, "port")} without link hidden</div>`;
  if (view === "list") {
    return html`<div class="plist">${shown.map((p) => html`<${PortRow} key=${p.idx} port=${p} device=${device} selected=${sel(p)} pv=${pv} ...${rest} />`)}</div>${more}`;
  }
  if (view === "compact") {
    return html`<div class=${"chassis compact mini " + (device.kind || "")}><div class="pgrid mini">${shown.map((p) => tile(p, true))}</div></div>${more}`;
  }
  if (mobile) {
    // phones: every port in order, big tap targets, no sideways scrolling
    return html`<div class=${"chassis compact " + (device.kind || "")}>
      <div class="pgrid">${device.ports.map((p) => tile(p))}</div></div>`;
  }
  const rj = device.ports.filter((p) => !p.sfp);
  const sfp = device.ports.filter((p) => p.sfp);
  const twoRow = rj.length > 10;
  const groups = twoRow ? chunk(rj, rj.length > 16 ? 12 : 8) : [rj];
  const grp = (ports, two) => html`<div class=${"pgroup" + (two ? " two" : "")}
    style=${`--cols:${two ? Math.ceil(ports.length / 2) : ports.length}`}>
    ${ports.map((p) => tile(p))}</div>`;
  return html`<div class=${"chassis " + (device.kind || "")}>
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

function DeviceCard({ device, collapsed, onCollapse, pv, ...rest }) {
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
    ${!collapsed && html`<div class="device-body"><${Faceplate} device=${device} pv=${pv} ...${rest} /></div>`}
  </section>`;
}

// --- VLAN legend ---------------------------------------------------------------

function useNetStats(networks, devices) {
  return useMemo(() => {
    const c = {};
    for (const d of devices) for (const p of d.ports) if (!p.wan) c[p.native_network_id] = (c[p.native_network_id] || 0) + 1;
    return c;
  }, [devices, networks]);
}

/** One network bubble. `lg` decides which parts show always, on hover (or when tapped) or never. */
export function NetChip({ n, color, lg, ports, on, faded, onClick, example }) {
  const show = (part, val) => val !== null && val !== undefined && val !== "" && (lg[part] === "always" || (lg[part] === "hover" && on));
  const ip = n.subnet ? ipText(n.subnet, lg.ip_format) : n.purpose === "vlan-only" ? "no subnet" : "";
  const tip = () => html`<div class="tip-title">${n.name}</div>
    <div class="tip-row"><${Icon} name="tag" size=${13} />VLAN ${n.vlan}</div>
    <div class="tip-row"><${Icon} name="grid" size=${13} />${plural(ports || 0, "port")} on it (native)</div>
    ${n.clients !== null && n.clients !== undefined && html`<div class="tip-row"><${Icon} name="plug" size=${13} />${plural(n.clients, "client")} connected</div>`}
    ${ip && html`<div class="tip-row"><${Icon} name="globe" size=${13} />${ip}</div>`}`;
  const parts = html`<span class="sw"></span><span class="chip-name">${n.name}</span>
    ${show("vlan", n.vlan) && html`<span class="chip-vlan" data-part="vlan">${n.vlan}</span>`}
    ${show("ports", ports) && html`<span class="chip-meta" data-part="ports" title="Ports on this network"><${Icon} name="grid" size=${11} />${ports}</span>`}
    ${show("clients", n.clients) && html`<span class="chip-meta" data-part="clients" title="Connected clients"><${Icon} name="plug" size=${11} />${n.clients}</span>`}
    ${show("ip", ip) && html`<span class="chip-ip" data-part="ip">${ip}</span>`}`;
  if (example) return html`<span class="chip on example" style=${`--c:${color}`}>${parts}</span>`;
  return html`<button class=${"chip" + (on ? " on" : "") + (faded ? " faded" : "")} style=${`--c:${color}`} onClick=${onClick}
    onMouseEnter=${canHover ? (e) => showTip(e, tip()) : undefined} onMouseLeave=${canHover ? hideTip : undefined}
    title=${canHover ? undefined : "Highlight ports carrying this network"}>${parts}</button>`;
}

function Legend({ networks, colors, devices, highlight, setHighlight, lg, setLg, onColors, onDisplay }) {
  const counts = useNetStats(networks, devices);
  let list = lg.hide_unused ? networks.filter((n) => counts[n.id] || n.id === highlight) : [...networks];
  if (lg.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (lg.sort === "ports") list.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
  const hl = networks.find((n) => n.id === highlight);
  return html`<div class=${"legend-box" + (lg.open ? "" : " closed")}>
    <div class="legend-head">
      <button class="legend-toggle" onClick=${() => setLg({ open: !lg.open })} aria-expanded=${lg.open}>
        <span class="chev" style=${lg.open ? "" : "transform:rotate(-90deg)"}><${Icon} name="chevron" size=${14} /></span>
        <b>Networks</b><span class="muted small">${networks.length}</span>
        ${!lg.open && hl && html`<span class="chip on mini-chip" style=${`--c:${colors[hl.id]}`}><span class="sw"></span>${hl.name}</span>`}</button>
      <span class="grow"></span>
      ${highlight && html`<button class="link-btn small" onClick=${() => setHighlight(null)}>Clear highlight</button>`}
      <button class="icon-btn sm" onClick=${onColors} title="My VLAN colors"><${Icon} name="palette" size=${15} /></button>
      <button class="icon-btn sm" onClick=${onDisplay} title="Display options"><${Icon} name="sliders" size=${15} /></button>
    </div>
    ${lg.open && html`<div class=${"legend " + lg.layout}>
      ${list.map((n) => html`<${NetChip} key=${n.id} n=${n} color=${colors[n.id]} lg=${lg} ports=${counts[n.id] || 0}
        on=${highlight === n.id} faded=${highlight && highlight !== n.id}
        onClick=${() => setHighlight(highlight === n.id ? null : n.id)} />`)}
    </div>`}
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

// --- display options (per person) -------------------------------------------------

const SHOW_OPTS = [{ value: "off", label: "Off" }, { value: "always", label: "Always" }, { value: "hover", label: canHover ? "On hover" : "On tap" }];

function DisplayModal({ lg, setLg, pv, setPv, sample, sampleColor, sampleCount, onClose }) {
  const row = (label, hint, key) => html`<div class="opt-row"><div><b>${label}</b><div class="muted small">${hint}</div></div>
    <${Segmented} value=${lg[key]} options=${SHOW_OPTS} onChange=${(v) => setLg({ [key]: v })} /></div>`;
  return html`<${Modal} title="Display options" icon="sliders" onClose=${onClose} wide
    footer=${html`<button class="btn ghost" onClick=${() => { setLg({ ...LEGEND_DEFAULTS }); setPv({ ...PORTS_DEFAULTS }); }}>Reset to defaults</button>
      <button class="btn primary" onClick=${onClose}>Done</button>`}>
    <p class="muted small">Just for you, on every device you sign in from. Changes show right away.</p>
    <h4 class="section">Network bubbles</h4>
    ${sample && html`<div class="opt-preview"><${NetChip} n=${sample} color=${sampleColor} lg=${lg} ports=${sampleCount} example />
      <span class="muted small">${canHover ? "“On hover” parts show when you point at a bubble, and in its tooltip." : "“On tap” parts show when you tap a bubble to highlight it."}</span></div>`}
    ${row("VLAN number", "The network's VLAN ID.", "vlan")}
    ${row("Ports on the network", "How many ports have it as their native VLAN, on the devices shown.", "ports")}
    ${row("Connected clients", "Wired and wireless clients on the network right now.", "clients")}
    ${row("IP subnet", "The network's address range.", "ip")}
    <div class="opt-row"><div><b>IP shown as</b></div>
      <${Segmented} value=${lg.ip_format} onChange=${(v) => setLg({ ip_format: v })}
        options=${[{ value: "subnet", label: "Subnet" }, { value: "gateway", label: "Gateway IP" }, { value: "both", label: "Gateway/mask" }]} /></div>
    <div class="opt-row"><div><b>Layout</b></div>
      <${Segmented} value=${lg.layout} onChange=${(v) => setLg({ layout: v })}
        options=${[{ value: "wrap", label: "Wrap" }, { value: "scroll", label: "One row" }, { value: "grid", label: "Grid" }]} /></div>
    <div class="opt-row"><div><b>Order</b></div>
      <${Segmented} value=${lg.sort} onChange=${(v) => setLg({ sort: v })}
        options=${[{ value: "vlan", label: "VLAN" }, { value: "name", label: "Name" }, { value: "ports", label: "Most ports" }]} /></div>
    <${Toggle} checked=${lg.hide_unused} onChange=${(v) => setLg({ hide_unused: v })} label="Hide networks with no ports" />

    <h4 class="section">Ports</h4>
    <div class="opt-row"><div><b>On phones</b><div class="muted small">Portrait. Turn the phone sideways for the larger-screen view.</div></div>
      <${Segmented} value=${pv.phone} onChange=${(v) => setPv({ phone: v })}
        options=${[{ value: "tiles", label: "Tiles" }, { value: "compact", label: "Compact" }, { value: "list", label: "List" }]} /></div>
    <div class="opt-row"><div><b>On larger screens</b></div>
      <${Segmented} value=${pv.desktop} onChange=${(v) => setPv({ desktop: v })}
        options=${[{ value: "faceplate", label: "Faceplate" }, { value: "compact", label: "Compact" }, { value: "list", label: "List" }]} /></div>
    <${Toggle} checked=${pv.hide_down} onChange=${(v) => setPv({ hide_down: v })} label="Hide ports without link" hint="In the Compact and List views." />
    <${Toggle} checked=${pv.tag_marks} onChange=${(v) => setPv({ tag_marks: v })} label="Mark ports that carry tagged VLANs"
      hint="Ordinary ports set to Allow All or Custom. Uplinks and links to UniFi devices always show their own mark." />

  </${Modal}>`;
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
  const lg = { ...LEGEND_DEFAULTS, ...(prefs.legend || {}) };
  const pv = { ...PORTS_DEFAULTS, ...(prefs.ports_view || {}) };
  const setLg = (patch) => savePrefs({ legend: { ...lg, ...patch } });
  const setPv = (patch) => savePrefs({ ports_view: { ...pv, ...patch } });
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
  // the example network bubble in the key and in Display options
  const sample = networks.find((n) => n.subnet && !n.is_default) || networks[0];
  const sampleCount = sample ? shown.reduce((a, d) => a + d.ports.filter((p) => p.native_network_id === sample.id).length, 0) : 0;
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
      ${!st.readonly && html`<${Legend} networks=${networks} colors=${colors} devices=${shown} highlight=${highlight} setHighlight=${setHighlight}
        lg=${lg} setLg=${setLg} onColors=${() => setModal("colors")} onDisplay=${() => setModal("display")} />`}
      ${!chosen && devices.length > 1 && html`<div class="notice"><${Icon} name="info" /><div>Showing ${env.access.all_devices ? "all switches" : "your devices"}. <button class="link-btn" onClick=${() => setModal("picker")}>Choose which to show</button></div></div>`}
      ${shown.length === 0 ? html`<div class="empty"><div class="empty-icon"><${Icon} name="grid" size=${40} /></div>
          <h2>${devices.length ? "No devices selected" : "No devices"}</h2>
          <p class="muted">${devices.length ? "Pick the switches you want to see." : env.access.all_devices ? "This environment has no devices with ports yet." : "None of your devices are on the controller right now."}</p>
          ${devices.length > 0 && html`<button class="btn primary" onClick=${() => setModal("picker")}>Choose devices</button>`}</div>`
        : html`<div class="devices">${shown.map((d) => html`<${DeviceCard} key=${d.id} device=${d} networks=${networks} colors=${colors} pv=${pv}
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
        ${sample && !st.readonly && html`<span class="key-bubble"><${NetChip} n=${sample} color=${colors[sample.id]} ports=${sampleCount} example
          lg=${{ ...lg, vlan: "always", ports: "always", clients: sample.clients == null ? "off" : "always", ip: "always" }} />
          <span>Network bubble: color, name, <b>VLAN ID</b>, <b>ports</b> on it, <b>connected clients</b> and <b>IP</b>.${" "}
          <button class="link-btn" onClick=${() => setModal("display")}>Choose what shows</button></span></span>`}
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
            <button onClick=${() => { setMenu(false); setModal("display"); }}><${Icon} name="sliders" />Display options</button>
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
    ${modal === "display" && html`<${DisplayModal} lg=${lg} setLg=${setLg} pv=${pv} setPv=${setPv} sample=${sample}
      sampleColor=${sample ? colors[sample.id] : ""} sampleCount=${sampleCount} onClose=${() => setModal(null)} />`}
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
