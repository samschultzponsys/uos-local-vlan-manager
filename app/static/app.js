import { render, useState, useEffect, useMemo, useCallback, useRef, useErrorBoundary } from "./vendor/preact-htm.module.js";
import {
  html, api, Icon, Modal, Segmented, Toggle, Toasts, toast, Spinner, useInterval, Logo, setBrand, markdown,
  vlanColors, colorsFor, colorKey, readable, glyphHalo, speedLabel, linkLabel, bytes, ago, rank, ROLE_LABEL, MODE_LABEL, lsGet, lsSet, ask, askText, AskHost, Avatar,
} from "./ui.js";
import { SettingsModal, UsersModal, AccountModal, AuditModal, EnvInfoModal } from "./admin.js";
import { SetupWizard, wizardNeeded } from "./wizard.js";
import { FeedbackPage } from "./feedback.js";
import { Tour, tourSteps, tourCaps } from "./tour.js";

// --- tooltip ------------------------------------------------------------------

let setTipGlobal = () => {};
function TipHost() {
  const [tip, setTip] = useState(null);
  setTipGlobal = setTip;
  if (!tip) return null;
  const { rect, content } = tip;
  const z = pageZoom();
  const below = rect.top < 220;
  const style = `left:${Math.min(Math.max(rect.left + rect.width / 2, 150), innerWidth - 150) / z}px;` +
    (below ? `top:${(rect.bottom + 10) / z}px` : `top:${(rect.top - 10) / z}px;transform:translate(-50%,-100%)`);
  return html`<div class=${"tip" + (below ? " below" : "")} style=${style}>${content}</div>`;
}
const showTip = (e, content) => setTipGlobal({ rect: e.currentTarget.getBoundingClientRect(), content });
const hideTip = () => setTipGlobal(null);

// --- page scale, remembered per screen resolution ------------------------------------

/** This screen's physical resolution, landscape (so a phone turned sideways is the same screen).
 *  A folding phone's cover and inner screens differ, so each keeps its own scale. */
export function screenKey() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(screen.width * dpr), h = Math.round(screen.height * dpr);
  return `${Math.max(w, h)}x${Math.min(w, h)}`;
}
export const pageZoom = () => Number(document.documentElement.style.zoom) || 1;
export function applyZoom(scales) {
  const z = (scales || {})[screenKey()];
  document.documentElement.style.zoom = z && z !== 1 ? String(z) : "";
}

// --- display preferences (per person) ---------------------------------------------

// each part of a network bubble: "always" | "hover" | "off"
export const LEGEND_DEFAULTS = { vlan: "always", ports: "always", clients: "hover", ip: "hover", ip_format: "subnet",
  layout: "wrap", sort: "vlan", hide_unused: false, open: true, key_open: true };
export const PORTS_DEFAULTS = { phone: "tiles", desktop: "faceplate", hide_down: false, tag_marks: true, group: true,
  apps: true, fx: "pulse", size: "auto", overview: false, start: "all", kinds: {}, app_kinds: {}, tips: true };

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

const APP_ICON = { Protect: "camera", Access: "door", Talk: "phone" };
const KIND = {
  gateway: { icon: "router", label: "Gateways" }, switch: { icon: "server", label: "Switches" },
  ap: { icon: "wifi", label: "Access points" }, other: { icon: "grid", label: "Other devices" },
};
const KIND_ORDER = ["gateway", "switch", "ap", "other"];

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
    <div class="tip-row"><span class=${"led " + (port.up ? "on" : "")}></span>${port.up ? `Up · ${linkLabel(port)}` : port.enabled ? "No link" : "Disabled"}</div>
    ${port.role && html`<div class="tip-row"><${Icon} name=${ROLE[port.role].icon} size=${13} />${roleLine(port)}</div>`}
    ${!port.wan && html`<div class="tip-row"><${Icon} name="tag" size=${13} />${port.native_network_id === null ? "VLAN not available through UniFi's cloud" : `${n ? `${n.name} (${n.vlan})` : "Unknown network"} · ${tag}`}</div>`}
    ${port.poe_capable && html`<div class="tip-row"><${Icon} name="bolt" size=${13} />${port.poe_active ? (port.poe_power == null ? "PoE delivering" : `PoE delivering ${port.poe_power} W`) : port.poe_enabled ? "PoE on · idle" : "PoE off"}</div>`}
    ${c && html`<div class="tip-row"><${Icon} name=${APP_ICON[c.app] || "plug"} size=${13} />${c.name || c.hostname || c.mac}${c.app ? ` · ${c.model || c.app}` : ""}${port.client_count > 1 ? ` +${port.client_count - 1}` : ""}</div>`}
    ${port.profile_name && html`<div class="tip-row"><${Icon} name="layers" size=${13} />Profile: ${port.profile_name}</div>`}
    ${port.lock && html`<div class="tip-row warn"><${Icon} name="lock" size=${13} />Locked by an admin${port.lock.note ? `: ${port.lock.note}` : ""}</div>`}
    ${port.lock && port.lock.drift && html`<div class="tip-row warn"><${Icon} name="alert" size=${13} />Changed in UniFi since it was locked</div>`}
    ${port.protected && html`<div class="tip-row warn"><${Icon} name="shield" size=${13} />Protected: changing it could cut something off</div>`}`;
}

function Flags({ port, device, pv, size = 10 }) {
  const tagMark = pv.tag_marks && !port.role && !nativeOnly(device) && port.native_network_id !== null;
  return html`<span class="p-flags">
    ${port.role && html`<span class=${"flag-role r-" + port.role} title=${roleLine(port)}><${Icon} name=${ROLE[port.role].icon} size=${size} /></span>`}
    ${!port.role && port.protected && html`<span title="Protected"><${Icon} name="shield" size=${size} /></span>`}
    ${tagMark && port.tagged_mode === "auto" && html`<span title="All VLANs tagged"><${Icon} name="trunk" size=${size} /></span>`}
    ${tagMark && port.tagged_mode === "custom" && html`<span title="Some VLANs tagged"><${Icon} name="trunksome" size=${size} /></span>`}
    ${port.profile_name && html`<span title="Port profile"><${Icon} name="layers" size=${size} /></span>`}
    ${(port.apps || []).map((a) => html`<span class="flag-app" title=${`UniFi ${a} device`}><${Icon} name=${APP_ICON[a] || "grid"} size=${size} /></span>`)}
    ${port.lock && html`<span class=${"flag-lock" + (port.lock.drift ? " drift" : "")} title=${port.lock.drift ? "Locked - but changed in UniFi" : "Locked by an admin"}><${Icon} name=${port.lock.drift ? "alert" : "lock"} size=${size} /></span>`}
  </span>`;
}

function tileLabel(port, n) {
  if (port.wan) return "WAN";
  if (n) return n.vlan;
  return port.native_network_id === null ? (port.sfp ? "SFP" : "") : "?";
}

function PortTile({ port, device, networks, colors, highlight, selected, marked, onPick, pv, mini }) {
  const n = netOf(networks, port.native_network_id);
  const color = port.wan ? "#3b3426" : colors[port.native_network_id] || "#64748b";
  const dim = highlight && !carries(port, highlight);
  const cls = ["port", port.up ? "up" : "down", port.enabled ? "" : "off", dim ? "dim" : "", selected ? "sel" : "",
    port.sfp ? "sfp" : "", mini ? "mini" : "", port.wan ? "wan" : "", marked ? "marked" : ""].join(" ");
  const fg = port.wan ? "#fbbf24" : readable(color);
  return html`<button class=${cls} style=${`--c:${color};--fg:${fg};--halo:${glyphHalo(fg)};--i:${port.idx}`}
    onClick=${(e) => { hideTip(); onPick(device.id, port.idx, e); }} onMouseDown=${(e) => { if (e.shiftKey) e.preventDefault(); }}
    onMouseEnter=${canHover ? (e) => showTip(e, html`<${PortTip} port=${port} device=${device} networks=${networks} />`) : undefined}
    onMouseLeave=${canHover ? hideTip : undefined}
    aria-label=${`Port ${port.idx}, ${n ? n.name : ""}`}>
    <span class="p-num">${port.idx}</span>
    ${!mini && port.poe_capable && html`<span class=${"p-poe " + (port.poe_active ? "active" : port.poe_enabled ? "on" : "offpoe")}>
      <${Icon} name="bolt" size=${11} fill=${port.poe_active} /></span>`}
    ${port.wan && html`<span class="p-wan"><${Icon} name="globe" size=${mini ? 16 : 20} /></span>`}
    ${!mini && html`<span class="p-vlan">${tileLabel(port, n)}</span>`}
    ${mini ? (port.lock || (port.role && !port.wan)) && html`<span class="p-flags">${port.lock ? html`<span class="flag-lock"><${Icon} name="lock" size=${9} /></span>`
      : html`<span class=${"flag-role r-" + port.role}><${Icon} name=${ROLE[port.role].icon} size=${9} /></span>`}</span>`
      : html`<${Flags} port=${port} device=${device} pv=${pv} />`}
    <span class="p-led"></span>
  </button>`;
}

function PortRow({ port, device, networks, colors, highlight, selected, marked, onPick, pv }) {
  const n = netOf(networks, port.native_network_id);
  const color = port.wan ? "#3b3426" : colors[port.native_network_id] || "#64748b";
  const dim = highlight && !carries(port, highlight);
  const c = port.clients[0];
  const fg = port.wan ? "#fbbf24" : readable(color);
  const who = port.peer || (c ? c.name || c.hostname || c.mac : port.lldp ? port.lldp.name : "");
  return html`<button class=${"prow" + (port.up ? " up" : "") + (dim ? " dim" : "") + (selected ? " sel" : "") + (port.wan ? " wan" : "") + (marked ? " marked" : "")}
    style=${`--c:${color};--fg:${fg};--halo:${glyphHalo(fg)}`}
    onClick=${(e) => onPick(device.id, port.idx, e)} onMouseDown=${(e) => { if (e.shiftKey) e.preventDefault(); }}>
    <span class="prow-num">${port.wan ? html`<${Icon} name="globe" size=${16} />` : port.idx}</span>
    <span class="prow-main"><b>${port.wan ? "WAN" : n ? n.name : port.native_network_id === null ? (port.media_label || "Port") : "?"}</b>
      <span class="muted">${n && !port.wan ? `VLAN ${n.vlan}` : ""}${port.name !== `Port ${port.idx}` ? `${n && !port.wan ? " · " : ""}${port.name}` : ""}</span></span>
    <span class="prow-who">${who && html`<${Icon} name=${port.peer ? ROLE[port.role] ? ROLE[port.role].icon : "link" : APP_ICON[c && c.app] || "plug"} size=${12} />${who}${port.client_count > 1 ? ` +${port.client_count - 1}` : ""}`}</span>
    <span class="prow-state">
      ${port.poe_capable && html`<span class=${"p-poe " + (port.poe_active ? "active" : port.poe_enabled ? "on" : "offpoe")}><${Icon} name="bolt" size=${12} fill=${port.poe_active} /></span>`}
      <span class=${"prow-speed" + (port.up ? " on" : "")}>${port.up ? linkLabel(port) : "—"}</span>
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

// screen sizes, each with its own port view (detected from the window width, live)
export const SCREENS = [
  { key: "phone", label: "Phone", hint: "under 600 px wide", icon: "phone", max: 599 },
  { key: "tablet", label: "Tablet or folding phone", hint: "600 – 1099 px", icon: "grid", max: 1099 },
  { key: "desktop", label: "Laptop or monitor", hint: "1100 – 2199 px", icon: "server", max: 2199 },
  { key: "large", label: "Ultrawide or 4K", hint: "2200 px and wider", icon: "sliders", max: Infinity },
];
const screenOf = (w) => SCREENS.find((x) => w <= x.max).key;
export function useScreen() {
  const [k, setK] = useState(screenOf(typeof innerWidth === "number" ? innerWidth : 1280));
  useEffect(() => {
    const f = () => setK(screenOf(innerWidth));
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return k;
}
/** The port view for a screen size; people from before 2.1 had one setting for phones and one for the rest. */
export function viewFor(pv, screen) {
  const v = (pv.views || {})[screen];
  if (v) return v;
  return screen === "phone" ? pv.phone || "tiles" : pv.desktop || "faceplate";
}

function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }

function Faceplate({ device, pv, forceView, forceMobile, ...rest }) {
  const isMobile = useMobile();
  const screenNow = useScreen();
  const mobile = forceMobile !== undefined ? forceMobile : isMobile;
  const view = forceView || viewFor(pv, screenNow);
  const marked = (p) => !!(rest.multi && rest.multi.has(`${device.id}|${p.idx}`));
  const sel = (p) => (rest.sel && rest.sel.d === device.id && rest.sel.i === p.idx) || marked(p);
  const tile = (p, mini) => html`<${PortTile} key=${p.idx} port=${p} device=${device} selected=${sel(p)} marked=${marked(p)} pv=${pv} mini=${mini} ...${rest} />`;
  const hideDown = !!pv.hide_down;
  const shown = hideDown ? device.ports.filter((p) => p.up) : device.ports;
  const hidden = device.ports.length - shown.length;
  const more = hidden > 0 && html`<div class="muted small hidden-note">${plural(hidden, "port")} without link hidden</div>`;
  if (view === "list") {
    return html`<div class="plist">${shown.map((p) => html`<${PortRow} key=${p.idx} port=${p} device=${device} selected=${sel(p)} marked=${marked(p)} pv=${pv} ...${rest} />`)}</div>${more}`;
  }
  if (view === "compact") {
    return html`<div class=${"chassis compact mini " + (device.kind || "")}><div class="pgrid mini">${shown.map((p) => tile(p, true))}</div></div>${more}`;
  }
  if (mobile) {
    // phones: every port in order, big tap targets, no sideways scrolling
    return html`<div class=${"chassis compact " + (device.kind || "")}>
      <div class="pgrid">${shown.map((p) => tile(p))}</div></div>${more}`;
  }
  // the faceplate keeps the hardware layout: a hidden port leaves an empty socket
  const slot = (p) => (hideDown && !p.up ? html`<span class=${"port ghost" + (p.sfp ? " sfp" : "")} key=${p.idx} aria-hidden="true"></span>` : tile(p));
  const rj = device.ports.filter((p) => !p.sfp);
  const sfp = device.ports.filter((p) => p.sfp);
  const twoRow = rj.length > 10;
  const groups = twoRow ? chunk(rj, rj.length > 16 ? 12 : 8) : [rj];
  const grp = (ports, two) => html`<div class=${"pgroup" + (two ? " two" : "")}
    style=${`--cols:${two ? Math.ceil(ports.length / 2) : ports.length}`}>
    ${ports.map(slot)}</div>`;
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

function DeviceCard({ device, collapsed, onCollapse, onManage, pv, ...rest }) {
  const up = device.ports.filter((p) => p.up).length;
  const poe = device.ports.reduce((a, p) => a + (p.poe_power || 0), 0);
  const k = KIND[device.kind] || KIND.other;
  return html`<section class=${"device " + (device.kind || "") + (device.online ? "" : " offline")}>
    <header class="device-head" onClick=${onCollapse}>
      <span class="kind-icon" title=${device.type_label}><${Icon} name=${k.icon} size=${16} /><span class=${"status-dot " + (device.online ? "on" : "")} title=${device.online ? "Online" : "Offline"}></span></span>
      <div class="device-title">
        <h3>${device.name}${device.upgradable && html`<span class="badge good" title=${`Firmware ${device.upgrade_to} is available`}>update</span>`}
          ${device.locating && html`<span class="badge warn">locating</span>`}</h3>
        <div class="device-sub">${device.model_name}${device.ip && html` · ${device.ip}`}${device.version && html` · v${device.version}`}</div>
      </div>
      <div class="device-stats">
        ${device.ports.length > 0 && html`<span class="stat" title="Ports with link"><${Icon} name="link" size=${13} />${up}/${device.ports.length}</span>`}
        ${poe > 0 && html`<span class="stat poe"><${Icon} name="bolt" size=${13} fill />${poe.toFixed(1)} W</span>`}
        ${onManage && html`<button class="icon-btn sm" title="Device details" onClick=${(e) => { e.stopPropagation(); onManage(device); }}><${Icon} name="sliders" size=${15} /></button>`}
        <span class="chev" style=${collapsed ? "transform:rotate(-90deg)" : ""}><${Icon} name="chevron" /></span>
      </div>
    </header>
    ${!collapsed && device.ports.length > 0 && html`<div class="device-body"><${Faceplate} device=${device} pv=${pv} ...${rest} /></div>`}
    ${!collapsed && device.wifi && html`<div class="device-body"><${WifiPanel} wifi=${device.wifi} /></div>`}
    ${!collapsed && device.ports.length === 0 && !device.wifi && html`<div class="device-body muted small">No wired ports reported${device.clients ? ` · ${plural(device.clients, "client")}` : ""}.</div>`}
  </section>`;
}

// --- access point Wi-Fi --------------------------------------------------------------

const quality = (dbm) => (dbm == null ? "" : dbm >= -60 ? "excellent" : dbm >= -67 ? "good" : dbm >= -75 ? "fair" : "poor");
const BAND_LABEL = { "2.4": "2.4 GHz", 5: "5 GHz", 6: "6 GHz", 60: "60 GHz" };

function SignalRow({ label, c }) {
  if (!c) return null;
  const q = quality(c.signal);
  // -90 dBm (nothing) .. -30 dBm (right next to it)
  const pct = Math.max(4, Math.min(100, ((c.signal + 90) / 60) * 100));
  return html`<div class=${"sig-row " + q}>
    <span class="sig-label">${label}</span>
    <div class="sig-main"><b>${c.name}</b><span class="muted small">${[BAND_LABEL[c.band] || c.band, c.ssid, c.ip].filter(Boolean).join(" · ")}</span></div>
    <div class="sig-meter" title=${`${c.signal} dBm, ${q}`}><span style=${`width:${pct}%`}></span></div>
    <span class="sig-dbm">${c.signal} dBm</span></div>`;
}

function WifiPanel({ wifi, full }) {
  const [all, setAll] = useState(false);
  if (!wifi) return null;
  return html`<div class="wifi">
    <div class="wifi-top">
      <span class="wifi-count"><${Icon} name="wifi" size=${15} /><b>${wifi.clients}</b> ${wifi.clients === 1 ? "client" : "clients"}</span>
      ${Object.entries(wifi.bands).sort().map(([b, n]) => html`<span class="badge">${BAND_LABEL[b] || b} · ${n}</span>`)}
      ${wifi.avg_signal != null && html`<span class=${"badge sig-badge " + quality(wifi.avg_signal)}>average ${wifi.avg_signal} dBm</span>`}
    </div>
    ${wifi.best && html`<${SignalRow} label="Best" c=${wifi.best} />`}
    ${wifi.worst && wifi.worst !== wifi.best && wifi.list.length > 1 && html`<${SignalRow} label="Worst" c=${wifi.worst} />`}
    ${wifi.radios.length > 0 && html`<div class="radios">${wifi.radios.map((r) => html`<div class="radio" key=${r.band}>
      <b>${BAND_LABEL[r.band] || r.band}</b>
      <span>${r.channel ? `ch ${r.channel}` : "—"}${r.width ? ` · ${r.width} MHz` : ""}</span>
      ${r.utilization != null && html`<span class=${"util" + (r.utilization >= 60 ? " high" : r.utilization >= 35 ? " mid" : "")} title="How busy the channel is">${r.utilization}% busy</span>`}
      <span class="muted">${plural(r.clients, "client")}</span></div>`)}</div>`}
    ${(full || all) && wifi.list.length > 2 && html`<div class="wifi-list">${wifi.list.map((c) => html`<${SignalRow} key=${c.mac} label="" c=${c} />`)}</div>`}
    ${!full && wifi.list.length > 2 && html`<button class="link-btn small" onClick=${() => setAll(!all)}>${all ? "Hide clients" : `All ${wifi.list.length} clients by signal`}</button>`}
  </div>`;
}

// --- devices of other UniFi apps (Protect, Access, Talk...) ------------------------

function AppDevices({ apps, devices, me, env, onOpenPort, collapsed, onCollapse, onChanged, readOnly }) {
  const can = (c) => (me.caps || []).includes(c);
  const byApp = {};
  for (const a of apps) (byApp[a.app] = byApp[a.app] || []).push(a);
  return Object.entries(byApp).map(([app, list]) => html`<section class="group" key=${app}>
    <button class="group-head" onClick=${() => onCollapse(app)}>
      <${Icon} name=${APP_ICON[app] || "grid"} size=${16} /><b>UniFi ${app}</b><span class="badge">${list.length}</span>
      <span class="grow"></span><span class="chev" style=${collapsed[app] ? "transform:rotate(-90deg)" : ""}><${Icon} name="chevron" /></span></button>
    ${!collapsed[app] && html`<div class="app-list">${list.map((a) => {
      const sw = devices.find((d) => d.id === a.switch_id);
      const port = sw && sw.ports.find((p) => p.idx === a.sw_port);
      const cycle = port && port.poe_enabled && can("ports.poe") && !(port.lock && !can("ports.lock"));
      return html`<div class="app-row" key=${a.mac}>
        <span class=${"status-dot " + (a.online ? "on" : a.online === false ? "" : "unknown")} title=${a.online ? "Online" : a.online === false ? "Offline" : "Unknown"}></span>
        <div class="app-main"><b>${a.name}</b><span class="muted small">${a.model}${a.ip ? ` · ${a.ip}` : ""}</span></div>
        ${port && onOpenPort ? html`<button class="link-btn small" onClick=${() => onOpenPort(sw.id, port.idx)}>${sw.name} · port ${port.idx}</button>`
          : port ? html`<span class="muted small">${sw.name} · port ${port.idx}</span>`
          : html`<span class="muted small">${a.switch_name ? `${a.switch_name} · port ${a.sw_port}` : "port unknown"}</span>`}
        ${cycle && !readOnly && html`<button class="btn sm ghost" title="Turn PoE off and on to restart it" onClick=${() => powerCycle(env, sw, port, onChanged)}><${Icon} name="power" size=${14} />Restart</button>`}
      </div>`;
    })}</div>`}
  </section>`);
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
export function NetChip({ n, color, lg, ports, on, faded, onClick, example, still }) {
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
  if (example || still) return html`<span class=${"chip example" + (still ? "" : " on")} style=${`--c:${color}`}
    onMouseEnter=${still && canHover ? (e) => showTip(e, tip()) : undefined} onMouseLeave=${still && canHover ? hideTip : undefined}>${parts}</span>`;
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

/** What the marks and colors mean, with an annotated example network bubble. Collapsible. */
function KeyBox({ open, onToggle, sample, sampleColor, sampleCount, lg, onDisplay }) {
  const parts = sample ? [
    ["swatch", html`<span class="kx-sw" style=${`--c:${sampleColor}`}></span>`, "The network's color, used on its ports"],
    ["name", html`<b>${sample.name}</b>`, "Network name"],
    ["vlan", html`<span class="chip-vlan">${sample.vlan}</span>`, "VLAN ID"],
    ["ports", html`<span class="chip-meta"><${Icon} name="grid" size=${11} />${sampleCount}</span>`, "Ports with it as native VLAN"],
    ...(sample.clients == null ? [] : [["clients", html`<span class="chip-meta"><${Icon} name="plug" size=${11} />${sample.clients}</span>`, "Clients connected to it"]]),
    ...(sample.subnet ? [["ip", html`<span class="chip-ip">${ipText(sample.subnet, lg.ip_format)}</span>`, "IP subnet"]] : []),
  ] : [];
  return html`<section class=${"key-box" + (open ? " open" : "")}>
    <button class="key-head" onClick=${onToggle} aria-expanded=${open}>
      <span class="chev" style=${open ? "" : "transform:rotate(-90deg)"}><${Icon} name="chevron" size=${14} /></span>
      <b>Key</b><span class="muted small">What the colors and marks mean</span></button>
    ${open && html`<div class="key-body">
      <div class="key-sec"><div class="key-title">Ports</div><div class="key">
        <span><span class="k-tile up"></span>Link up</span><span><span class="k-tile"></span>No link</span><span><span class="k-off"></span>Disabled</span>
        <span><span class="k-wan"><${Icon} name="globe" size=${12} /></span>WAN</span>
        <span><span class="k-poe active"><${Icon} name="bolt" size=${11} fill /></span>PoE delivering</span>
        <span><span class="k-poe"><${Icon} name="bolt" size=${11} /></span>PoE on, idle</span>
        <span class="k-lock"><${Icon} name="lock" size=${12} />Locked by an admin</span></div></div>
      <div class="key-sec"><div class="key-title">Marks</div><div class="key">
        <span><${Icon} name="trunk" size=${12} />All VLANs tagged</span><span><${Icon} name="trunksome" size=${12} />Some VLANs tagged</span>
        <span><${Icon} name="uplink" size=${12} />Uplink</span><span><${Icon} name="link" size=${12} />UniFi device</span>
        <span><${Icon} name="merge" size=${12} />LAG</span><span><${Icon} name="layers" size=${12} />Port profile</span>
        <span><${Icon} name="camera" size=${12} />Protect device</span><span><${Icon} name="door" size=${12} />Access device</span></div>
        <p class="key-note"><${Icon} name="shield" size=${12} />Uplinks, UniFi device links, WAN, LAG and mirror ports are <b>protected</b>:
          changing them could cut something off, so it takes extra permission and a confirmation.</p></div>
      ${sample && html`<div class="key-sec example"><div class="key-title">Example network bubble</div>
        <div class="kx-chip"><${NetChip} n=${sample} color=${sampleColor} ports=${sampleCount} example
          lg=${{ ...lg, vlan: "always", ports: "always", clients: sample.clients == null ? "off" : "always", ip: "always" }} /></div>
        <ul class="kx-parts">${parts.map(([k, el, label]) => html`<li key=${k}><span class="kx-el">${el}</span><span>${label}</span>
          ${["vlan", "ports", "clients", "ip"].includes(k) && html`<span class=${"kx-mode " + lg[k]}>${lg[k] === "hover" ? (canHover ? "on hover" : "on tap") : lg[k]}</span>`}</li>`)}</ul>
        <button class="btn sm" onClick=${onDisplay}><${Icon} name="sliders" size=${14} />Display options</button></div>`}
    </div>`}
  </section>`;
}

export const SYNC_LABEL = { off: "Each environment separately", vlan: "Same VLAN number, same color", name: "Same network name, same color" };

function ColorsModal({ networks, prefs, envColors, onSave, onClose }) {
  const [mode, setMode] = useState(prefs.color_sync || "off");
  const [mine, setMine] = useState({ ...(prefs.vlan_colors || {}) });
  const [shared, setShared] = useState({ ...(prefs.shared_colors || {}) });
  const p = { ...prefs, color_sync: mode, vlan_colors: mine, shared_colors: shared };
  const auto = vlanColors(networks, envColors || {}, {}, mode !== "off" ? mode : null);
  const colors = colorsFor(networks, envColors, p);
  const own = (n) => { const k = colorKey(n, mode !== "off" ? mode : null); return k ? shared[k] : mine[n.id]; };
  const set = (n, v) => {
    const k = colorKey(n, mode !== "off" ? mode : null);
    if (k) { const x = { ...shared }; if (v) x[k] = v; else delete x[k]; setShared(x); } else { const x = { ...mine }; if (v) x[n.id] = v; else delete x[n.id]; setMine(x); }
  };
  return html`<${Modal} title="My VLAN colors" icon="palette" onClose=${onClose}
    footer=${html`<button class="btn ghost" onClick=${() => { if (mode === "off") setMine({}); else setShared({}); }}>Reset all</button>
      <button class="btn primary" onClick=${() => onSave({ color_sync: mode, vlan_colors: mine, shared_colors: shared })}>Save</button>`}>
    <p class="muted">Pick a color per network. Ports take the color of their native VLAN. These colors are yours; an admin sets the defaults for everyone.</p>
    <div class="opt-row"><div><b>Across environments</b><div class="muted small">${mode === "off" ? "Colors here apply to this environment only."
      : mode === "vlan" ? "A color applies to every network with that VLAN number, in every environment." : "A color applies to every network with that name, in every environment."}</div></div>
      <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: "off", label: "Separate" }, { value: "vlan", label: "By VLAN" }, { value: "name", label: "By name" }]} /></div>
    <div class="color-list">
      ${networks.map((n) => html`<label class="color-row" key=${n.id}>
        <input type="color" value=${colors[n.id]} onInput=${(e) => set(n, e.target.value)} />
        <span class="color-name">${n.name}</span><span class="chip-vlan">VLAN ${n.vlan}</span>
        ${own(n) && html`<button class="link-btn" title=${`Back to ${auto[n.id]}`} onClick=${(e) => { e.preventDefault(); set(n, null); }}>default</button>`}
      </label>`)}
    </div></${Modal}>`;
}

// --- display options (per person) -------------------------------------------------

const SHOW_OPTS = [{ value: "off", label: "Off" }, { value: "always", label: "Always" }, { value: "hover", label: canHover ? "On hover" : "On tap" }];

/** where someone lands after signing in: their environment, the All devices page (when on) or Feedback */
export function startOptions(pv, canFeedback) {
  return [{ value: "env", label: "My environment" }, ...(pv.overview ? [{ value: "all", label: "All devices" }] : []),
    ...(canFeedback ? [{ value: "feedback", label: "Feedback" }] : [])];
}
const startValue = (pv, canFeedback) => (pv.start === "all" && pv.overview) || (pv.start === "feedback" && canFeedback) ? pv.start : "env";

function DisplayModal({ lg, setLg, pv, setPv, sample, sampleColor, sampleCount, onClose, scales, setScale, canFeedback }) {
  const screen = useScreen();
  const here = screenKey();
  const cur = (scales || {})[here] || 1;
  const [draft, setDraft] = useState(cur);
  const others = Object.entries(scales || {}).filter(([k]) => k !== here);
  const row = (label, hint, key) => html`<div class="opt-row"><div><b>${label}</b><div class="muted small">${hint}</div></div>
    <${Segmented} value=${lg[key]} options=${SHOW_OPTS} onChange=${(v) => setLg({ [key]: v })} /></div>`;
  return html`<${Modal} title="Display options" icon="sliders" onClose=${onClose} wide
    footer=${html`<button class="btn ghost" onClick=${() => { setLg({ ...LEGEND_DEFAULTS }); setPv({ ...PORTS_DEFAULTS }); setDraft(1); setScale(here, null); }}>Reset to defaults</button>
      <button class="btn primary" onClick=${onClose}>Done</button>`}>
    <p class="muted small">Just for you, on every device you sign in from. Changes show right away.</p>
    <h4 class="section">Scale</h4>
    <div class="scale-box">
      <div class="scale-head"><div><b>This screen</b> <span class="badge">${here.replace("x", " × ")}</span>
        <div class="muted small">Only screens with this resolution use it. Others stay at their own scale (stock is 100%).</div></div>
        <b class="scale-val">${Math.round(draft * 100)}%</b></div>
      <input type="range" min="0.7" max="1.6" step="0.05" value=${draft}
        onInput=${(e) => { const v = Number(e.target.value); setDraft(v); document.documentElement.style.zoom = v === 1 ? "" : String(v); }}
        onChange=${(e) => setScale(here, Number(e.target.value))} aria-label="Scale for this screen" />
      <div class="scale-ticks"><span>70%</span><span>100%</span><span>130%</span><span>160%</span></div>
      <div class="row">
        <button class="btn sm" disabled=${draft === 1} onClick=${() => { setDraft(1); setScale(here, null); }}>Back to stock (100%)</button>
        ${others.length > 0 && html`<button class="btn sm ghost" onClick=${() => setScale(null, null, true)}>Reset other screens</button>`}
      </div>
      ${others.length > 0 && html`<div class="muted small">Also saved: ${others.map(([k, v]) => `${k.replace("x", " × ")} at ${Math.round(v * 100)}%`).join(", ")}</div>`}
    </div>
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
    <p class="muted small">Each screen size keeps its own view. The app goes by the window's width, so turning a phone
      sideways or opening a folding phone switches to the next size up.</p>
    ${SCREENS.map((x) => html`<div class="opt-row" key=${x.key}><div><b>${x.label}</b>${x.key === screen && html` <span class="badge good">this screen</span>`}
      <div class="muted small">${x.hint}</div></div>
      <${Segmented} value=${viewFor(pv, x.key)} onChange=${(v) => setPv({ views: { ...SCREENS.reduce((a, y) => ({ ...a, [y.key]: viewFor(pv, y.key) }), {}), [x.key]: v } })}
        options=${[{ value: x.key === "phone" ? "tiles" : "faceplate", label: x.key === "phone" ? "Tiles" : "Faceplate" },
          { value: "compact", label: "Compact" }, { value: "list", label: "List" }]} /></div>`)}
    <div class="opt-row"><div><b>Port size</b><div class="muted small">Auto grows the ports on big and 4K screens.</div></div>
      <${Segmented} value=${pv.size || "auto"} onChange=${(v) => setPv({ size: v })}
        options=${[{ value: "auto", label: "Auto" }, { value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }, { value: "xl", label: "XL" }]} /></div>
    <div class="opt-row"><div><b>Ports with link</b><div class="muted small">Glow gently in their network's color: faint, soft or bright, or stay solid.</div></div>
      <${Segmented} value=${pv.fx} onChange=${(v) => setPv({ fx: v })} options=${FX_OPTIONS} /></div>
    <${Toggle} checked=${pv.hide_down} onChange=${(v) => setPv({ hide_down: v })} label="Hide ports without link"
      hint="Tiles, Compact and List leave them out; the Faceplate keeps its layout and shows an empty socket." />
    <${Toggle} checked=${pv.tag_marks} onChange=${(v) => setPv({ tag_marks: v })} label="Mark ports that carry tagged VLANs"
      hint="Ordinary ports set to Allow All or Custom. Uplinks and links to UniFi devices always show their own mark." />

    <h4 class="section">Pages</h4>
    <${Toggle} checked=${pv.overview} onChange=${(v) => setPv({ overview: v, start: v ? "all" : pv.start })} label="Show the All devices page"
      hint="Every environment on one long page, view only." />
    ${startOptions(pv, canFeedback).length > 1 && html`<div class="opt-row"><div><b>Start on</b><div class="muted small">The page you land on after signing in.</div></div>
      <${Segmented} value=${startValue(pv, canFeedback)} onChange=${(v) => setPv({ start: v })} options=${startOptions(pv, canFeedback)} /></div>`}

    <h4 class="section">Devices</h4>
    <${Toggle} checked=${pv.group} onChange=${(v) => setPv({ group: v })} label="Group by type" hint="Gateways, switches, access points." />
    <${Toggle} checked=${pv.tips !== false} onChange=${(v) => setPv({ tips: v })} label="Show tips now and then" hint="A short tip at the bottom every few minutes." />
    <${Toggle} checked=${pv.apps} onChange=${(v) => setPv({ apps: v })} label="Show Protect, Access and other UniFi devices"
      hint="With the port each one is plugged into." />

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
  // can't change it, but may ask for the change
  const canRequest = !canEdit && !readonly && !port.wan && can("requests.ports");
  const formOn = canEdit || canRequest;
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
      toast(`Port ${port.idx} → ${next.name} (${next.vlan})${fixedTags || r.native_only ? "" : `, ${MODE_LABEL[mode]}`}`);
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
          ${port.up ? linkLabel(port) : port.enabled ? "Down" : "Disabled"}</span></div>
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
        ${c0.map((c) => html`<div class="client"><${Icon} name=${APP_ICON[c.app] || "plug"} size=${14} /><b>${c.name || c.hostname || c.mac}</b>
          ${c.app && html`<span class="badge">${c.model || c.app} · ${c.app}</span>`}
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
        <div class="panel-title">Core settings ${canRequest ? html`<span class="badge">Request</span>` : !canEdit && html`<span class="badge">View only</span>`}</div>
        ${canRequest && html`<p class="muted small req-hint"><${Icon} name="send" size=${13} /> You can't change this port yourself${port.protected && can("ports.change") ? " (it's protected)" : lock && can("ports.change") ? " (it's locked)" : ""}.
          Pick what you need and send a request: someone who can will approve it.</p>`}
        <label class="field"><span class="field-label">Native VLAN / Network</span>
          <div class="select-wrap"><span class="dot" style=${`background:${colors[native]}`}></span>
            <select value=${native} disabled=${!formOn} onChange=${(e) => edit(setNative)(e.target.value)}>
              ${networks.filter((n) => n.allowed || n.id === native || n.id === port.native_network_id).map((n) =>
                html`<option value=${n.id} disabled=${!n.allowed}>${n.name} (${n.vlan})${n.allowed ? "" : " — not yours"}</option>`)}
            </select><${Icon} name="chevron" cls="select-chev" /></div></label>
        ${fixedTags ? html`<div class="field"><span class="field-label">Tagged VLAN Management</span>
          <div class="notice"><${Icon} name="info" /><div><b>${device.model_name}</b> can't filter tagged VLANs per port, so only the native VLAN
            is set here. Tagging settings would be ignored by the switch.
            ${can("settings.manage") && html`<div><button class="link-btn small" onClick=${() => setModelCaps(device, true, onApplied)}>
              This model can filter tagged VLANs</button></div>`}</div></div></div>`
        : html`<div class="field"><span class="field-label">Tagged VLAN Management</span>
          <${Segmented} value=${mode} disabled=${!formOn} onChange=${edit(setMode)}
            options=${[{ value: "auto", label: "Allow All", disabled: restricted, title: restricted ? "Would tag networks you don't have" : "" },
              { value: "block_all", label: "Block All" }, { value: "custom", label: "Custom" }]} />
          <small class="hint">${mode === "block_all" ? "Access port: only the native VLAN, nothing tagged." : mode === "auto" ? "Trunk: every network is tagged on this port." : "Trunk: only the networks ticked below are tagged."}</small>
          ${can("settings.manage") && device.type === "usw" && html`<small class="hint"><button class="link-btn small" onClick=${() => setModelCaps(device, false, onApplied)}>
            ${device.model_name} ignores tagged VLAN settings?</button></small>`}
        </div>`}
        ${!fixedTags && mode === "custom" && html`<div class="tag-list">
          ${allowed.filter((n) => n.id !== native).map((n) => html`<label class="tag-row" key=${n.id}>
            <input type="checkbox" disabled=${!formOn} checked=${!excluded.includes(n.id)}
              onChange=${(e) => edit(setExcluded)(e.target.checked ? excluded.filter((x) => x !== n.id) : [...excluded, n.id])} />
            <span class="dot" style=${`background:${colors[n.id]}`}></span>${n.name}<span class="chip-vlan">${n.vlan}</span></label>`)}
          ${allowed.filter((n) => n.id !== native).length === 0 && html`<span class="muted small">No other networks to tag.</span>`}
        </div>`}
      </div>`}

      ${!readonly && !port.wan && html`<${PortTools} env=${env} device=${device} port=${port} me=${me} onApplied=${onApplied} />`}
      ${isAdmin && !lock && !readonly && !port.wan && html`<div class="panel lock-panel">
        <div class="panel-title"><span><${Icon} name="lock" size=${15} /> Lock this port</span></div>
        <p class="muted small">Only admins can change a locked port. Good for upstream trunks and dedicated ports. It's locked to the settings UniFi has right now.</p>
        <div class="row"><input placeholder="Why? e.g. Upstream trunk from core port 17" value=${lockNote} maxlength="300" onInput=${(e) => setLockNote(e.target.value)} />
          <button class="btn ghost" disabled=${lockBusy || dirty} title=${dirty ? "Apply or reset your changes first" : ""}
            onClick=${() => lockAction("PUT", "/lock", { note: lockNote }, `Port ${port.idx} locked`)}><${Icon} name="lock" size=${14} />Lock</button></div>
        ${dirty && html`<small class="hint">Apply or reset your changes first.</small>`}
      </div>`}
      ${formOn && dirty && next && html`<div class="diff">
        ${native !== port.native_network_id && html`<div><span class="muted">Native</span> ${cur ? cur.name : "?"} <span class="arrow">→</span> <b>${next.name} (${next.vlan})</b></div>`}
        ${!fixedTags && (mode !== port.tagged_mode || (mode === "custom" && !sameEx)) && html`<div><span class="muted">Tagged</span> ${MODE_LABEL[port.tagged_mode]} <span class="arrow">→</span> <b>${MODE_LABEL[mode]}</b></div>`}
      </div>`}
    </div>
    ${canEdit && html`<footer class="drawer-foot">
      <button class="btn ghost" disabled=${busy || !dirty} onClick=${reset}>Reset</button>
      <button class="btn primary" disabled=${busy || !dirty || !(next && next.allowed)} onClick=${() => apply()}>${busy ? html`<${Spinner} /> Applying…` : "Apply changes"}</button>
    </footer>`}
    ${canRequest && html`<footer class="drawer-foot">
      <button class="btn ghost" disabled=${busy || !dirty} onClick=${reset}>Reset</button>
      <button class="btn primary" disabled=${busy || !dirty || !(next && next.allowed)} onClick=${async () => {
        setBusy(true);
        const sent = await sendRequest(env, { type: "port", device_id: device.id, port_idx: port.idx,
          change: { native_network_id: native, tagged_mode: mode, excluded_network_ids: mode === "custom" ? excluded : [] } },
          { title: `Request a change to port ${port.idx}`, what: html`<b>${device.name} · port ${port.idx}</b>: ${cur ? cur.name : "?"} → <b>${next.name} (${next.vlan})</b>${fixedTags ? "" : `, ${MODE_LABEL[mode]}`}` });
        setBusy(false);
        if (sent) reset();
      }}><${Icon} name="send" size=${15} />Request this change</button>
    </footer>`}
  </aside>`;
}

/** Ask for a change you can't make yourself; it goes to the Feedback board for someone who can. */
async function sendRequest(env, body, { title, what }) {
  const reason = await askText({ title, icon: "send", confirm: "Send request", placeholder: "Why? (optional) e.g. New printer at the front desk",
    body: html`<p>${what}</p><p class="muted small">Someone who can make this change approves it, and the change is made as them.
      You'll see it on the <b>Feedback</b> tab, and get news there when it's approved or declined.</p>` });
  if (reason === null) return false;
  try {
    await api(`/api/envs/${env.id}/requests`, { method: "POST", body: { ...body, reason } });
    toast("Request sent");
    return true;
  } catch (e) { toast(e.message, "err"); return false; }
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

// --- device details and management -----------------------------------------------

function uptimeText(sec) {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function DeviceModal({ env, device, me, readonly, onClose, onChanged }) {
  const can = (c) => (me.caps || []).includes(c);
  const manage = can("devices.manage") && !readonly;
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(null);
  const base = `/api/envs/${env.id}/devices/${device.id}`;
  async function run(key, fn) {
    setBusy(key);
    try { await fn(); onChanged(); } catch (e) { toast(e.message, "err"); }
    setBusy(null);
  }
  const put = (key, body, msg) => run(key, async () => { await api(base, { method: "PUT", body }); toast(msg); });
  const act = async (action, confirm) => {
    if (confirm && !await ask(confirm)) return;
    run(action, async () => { const r = await api(base + "/action", { method: "POST", body: { action } }); toast(r.message); });
  };
  const k = KIND[device.kind] || KIND.other;
  const kv = (label, value) => value !== null && value !== undefined && value !== "" && html`<div class="kv"><span>${label}</span><b>${value}</b></div>`;
  return html`<${Modal} title=${device.name} icon=${k.icon} onClose=${onClose} wide>
    <div class="dev-info">
      ${kv("Model", html`${device.model_name}${device.model && device.model !== device.model_name ? html` <span class="muted mono small">${device.model}</span>` : ""}`)}
      ${kv("Type", device.type_label)}
      ${kv("Status", device.online ? html`<span class="good-text">Online</span>` : html`<span class="err-text">Offline</span>`)}
      ${kv("IP address", device.ip)}
      ${kv("MAC", html`<span class="mono">${device.mac}</span>`)}
      ${kv("Serial", device.serial && html`<span class="mono">${device.serial}</span>`)}
      ${kv("Firmware", html`${device.version || "—"}${device.upgradable ? html` <span class="badge good">${device.upgrade_to || "update"} available</span>` : ""}`)}
      ${kv("Uptime", uptimeText(device.uptime))}
      ${kv("Clients", device.clients ? String(device.clients) : null)}
      ${kv("CPU / memory", device.cpu != null ? `${Math.round(device.cpu)}% / ${Math.round(device.mem || 0)}%` : null)}
      ${kv("Uplink", device.uplink_to && `${device.uplink_to.name}${device.uplink_to.port ? ` · port ${device.uplink_to.port}` : ""}`)}
      ${device.kind === "switch" && kv("Tagged VLANs", device.caps.tagged_vlans ? "Filtered per port" : "Not filtered per port (native VLAN only)")}
    </div>
    ${device.wifi && html`<h4 class="section">Wi-Fi</h4><${WifiPanel} wifi=${device.wifi} full />`}
    ${device.kind === "switch" && can("settings.manage") && !readonly && html`<p class="muted small">
      ${device.caps.tagged_vlans ? "If this model ignores tagged VLAN settings, " : "If this model can filter tagged VLANs, "}
      <button class="link-btn small" onClick=${() => setModelCaps(device, !device.caps.tagged_vlans, onChanged)}>change it for every ${device.model_name}</button>.</p>`}

    ${manage ? html`<h4 class="section">Manage</h4>
      <div class="field"><span class="field-label">Name</span>
        <div class="row"><input value=${name} maxlength="64" onInput=${(e) => setName(e.target.value)} />
          <button class="btn" disabled=${busy || !name.trim() || name.trim() === device.name}
            onClick=${() => put("name", { name: name.trim() }, "Renamed")}><${Icon} name="pencil" size=${14} />Rename</button></div></div>
      <div class="opt-row"><div><b>Locate</b><div class="muted small">Blinks the device's light so you can find it in the rack.</div></div>
        <button class=${"btn" + (device.locating ? " primary" : "")} disabled=${!!busy} onClick=${() => act(device.locating ? "unlocate" : "locate")}>
          <${Icon} name="target" size=${14} />${device.locating ? "Stop blinking" : "Blink"}</button></div>
      <div class="opt-row"><div><b>Status light</b><div class="muted small">Default follows the site's LED setting.</div></div>
        <${Segmented} value=${device.led_override || "default"} disabled=${!!busy}
          onChange=${(v) => put("led", { led_override: v }, `LED ${v === "default" ? "follows the site" : v}`)}
          options=${[{ value: "default", label: "Default" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} /></div>
      ${device.upgradable && html`<div class="opt-row"><div><b>Firmware ${device.upgrade_to}</b><div class="muted small">Installed: ${device.version}. The device restarts when it's done.</div></div>
        <button class="btn" disabled=${!!busy} onClick=${() => act("upgrade", { title: `Update ${device.name}?`, confirm: "Update firmware",
          body: html`<p>${device.name} downloads firmware <b>${device.upgrade_to}</b> and restarts. Everything connected through it drops for a few minutes.</p>` })}>
          <${Icon} name="upgrade" size=${14} />Update</button></div>`}
      <div class="opt-row"><div><b>Restart</b><div class="muted small">Everything connected through it drops until it's back.</div></div>
        <button class="btn danger-text" disabled=${!!busy} onClick=${() => act("restart", { title: `Restart ${device.name}?`, danger: true, confirm: "Restart",
          body: html`<p><b>${device.name}</b> restarts. Everything connected through it is offline for a minute or two.</p>` })}>
          <${Icon} name="power" size=${14} />Restart</button></div>`
      : !readonly && can("requests.restart") ? html`<div class="opt-row"><div><b>Restart</b><div class="muted small">Ask for a restart. Someone who can will approve it.</div></div>
        <button class="btn" onClick=${() => sendRequest(env, { type: "restart", device_id: device.id },
          { title: `Request a restart of ${device.name}`, what: html`<b>${device.name}</b> restarts. Everything connected through it is offline for a minute or two.` })}>
          <${Icon} name="send" size=${14} />Request a restart</button></div>`
      : !readonly && html`<p class="muted small">Only people with the <i>Manage devices</i> ability can rename, restart or update devices.</p>`}
  </${Modal}>`;
}

async function powerCycle(env, device, port, onDone) {
  const ok = await ask({ title: `Power-cycle port ${port.idx}?`, confirm: "Power-cycle", danger: !!port.protected,
    body: html`<p>PoE on <b>${device.name} port ${port.idx}</b> is turned off for a few seconds and back on, so whatever it powers restarts.</p>
      ${port.protected && html`<p class="warn-text">This port is protected (${port.protect_reasons.join(" · ")}) — this can cut off what's behind it.</p>`}` });
  if (!ok) return;
  try {
    await api(`/api/envs/${env.id}/devices/${device.id}/ports/${port.idx}/power-cycle`, { method: "POST", body: { confirm_protected: true } });
    toast(`Power-cycling ${device.name} port ${port.idx}`);
    if (onDone) onDone();
  } catch (e) { toast(e.message, "err"); }
}

/** Port name (devices.manage) and PoE on / off / power-cycle (ports.poe), in the port panel. */
function PortTools({ env, device, port, me, onApplied }) {
  const can = (c) => (me.caps || []).includes(c);
  const canName = can("devices.manage");
  const lockedOut = port.lock && !can("ports.lock");
  const canPoe = can("ports.poe") && port.poe_capable && !lockedOut;
  const reqPoe = !canPoe && can("requests.poe") && port.poe_capable && port.poe_enabled;
  const deflt = `Port ${port.idx}`;
  const [name, setName] = useState(port.name === deflt ? "" : port.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(port.name === deflt ? "" : port.name), [device.id, port.idx, port.name]);
  if (!canName && !canPoe && !reqPoe) return null;
  async function save(body, msg) {
    setBusy(true);
    try {
      await api(`/api/envs/${env.id}/devices/${device.id}/ports/${port.idx}/settings`, { method: "PUT", body });
      toast(msg); onApplied();
    } catch (e) {
      if (e.status === 409 && e.data.confirm === "protected") {
        const ok = await ask({ title: "Change PoE on a protected port?", danger: true, confirm: "Change it anyway",
          body: html`<p>This port is protected:</p><ul>${e.data.reasons.map((r) => html`<li>${r}</li>`)}</ul><p>Turning PoE off can cut off what's behind it.</p>` });
        if (ok) { setBusy(false); return save({ ...body, confirm_protected: true }, msg); }
      } else toast(e.message, "err");
    }
    setBusy(false);
    return null;
  }
  return html`<div class="panel">
    <div class="panel-title">Port tools</div>
    ${canName && html`<div class="field"><span class="field-label">Port name</span>
      <div class="row"><input value=${name} maxlength="40" placeholder=${deflt} onInput=${(e) => setName(e.target.value)} />
        <button class="btn" disabled=${busy || name.trim() === (port.name === deflt ? "" : port.name)}
          onClick=${() => save({ name: name.trim() }, name.trim() ? `Port ${port.idx} is now “${name.trim()}”` : `Port ${port.idx} name cleared`)}>Save</button></div>
      <small class="hint">Shown here and in UniFi. Leave empty for “${deflt}”.</small></div>`}
    ${canPoe && html`<div class="opt-row"><div><b>PoE</b><div class="muted small">${port.poe_active ? `Delivering${port.poe_power ? ` ${port.poe_power} W` : ""}` : port.poe_enabled ? "On, nothing drawing power" : "Off"}</div></div>
      <div class="row">
        <${Segmented} value=${port.poe_enabled ? "auto" : "off"} disabled=${busy}
          onChange=${(v) => save({ poe_mode: v }, `PoE ${v === "off" ? "off" : "on"} on port ${port.idx}`)}
          options=${[{ value: "auto", label: "On" }, { value: "off", label: "Off" }]} />
        ${port.poe_enabled && html`<button class="btn" disabled=${busy} title="Turn PoE off and on to restart what it powers"
          onClick=${() => powerCycle(env, device, port, onApplied)}><${Icon} name="power" size=${14} />Power-cycle</button>`}
      </div></div>`}
    ${port.poe_capable && lockedOut && can("ports.poe") && html`<small class="hint">This port is locked, so PoE can only be changed by someone who can lock ports.</small>`}
    ${reqPoe && html`<div class="opt-row"><div><b>Power-cycle</b><div class="muted small">Restart what this port powers. Someone who can will approve it.</div></div>
      <button class="btn" onClick=${() => sendRequest(env, { type: "poe", device_id: device.id, port_idx: port.idx },
        { title: "Request a power-cycle", what: html`Turn PoE on <b>${device.name} · port ${port.idx}</b> off and on, so what it powers restarts.` })}>
        <${Icon} name="send" size=${14} />Request</button></div>`}
  </div>`;
}

// --- All devices: every environment on one page, view only --------------------------------

function Overview({ me, pv, lg, prefs, poll, onOpen }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [closed, setClosed] = useState(lsGet("vlanmgr.ovClosed", {}));
  const load = useCallback(async (refresh) => {
    try { setData(await api("/api/overview" + (refresh ? "?refresh=1" : ""))); setErr(null); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(true); }, []);
  useInterval(() => { if (!document.hidden) load(); }, poll);
  if (err && !data) return html`<div class="notice err"><${Icon} name="alert" /><div>${err}</div></div>`;
  if (!data) return html`<div class="empty"><${Spinner} /></div>`;
  const toggle = (k) => { const c = { ...closed, [k]: !closed[k] }; setClosed(c); lsSet("vlanmgr.ovClosed", c); };
  const total = data.envs.reduce((a, x) => a + x.devices.length, 0);
  return html`<div class="overview ov-static">
    <div class="notice slim"><${Icon} name="eye" /><div><b>All devices</b> — ${plural(data.envs.length, "environment")}, ${plural(total, "device")}.
      For information only${canHover ? "; point at a port for its details" : ""}. To change something, switch to <b>Environment</b>.
      <span class="muted">Updated ${ago(data.fetched_at)}.</span></div></div>
    ${data.envs.map((x) => {
      const colors = colorsFor(x.networks, x.env.vlan_colors, prefs);
      const groups = pv.group
        ? KIND_ORDER.map((k) => ({ kind: k, list: x.devices.filter((d) => (d.kind || "other") === k) })).filter((g) => g.list.length)
        : [{ kind: null, list: x.devices }];
      const counts = {};
      for (const d of x.devices) for (const p of d.ports) if (!p.wan) counts[p.native_network_id] = (counts[p.native_network_id] || 0) + 1;
      return html`<section class=${"ov-env" + (closed[x.env.id] ? " closed" : "")} key=${x.env.id}>
        <header class="ov-head">
          <button class="ov-toggle" onClick=${() => toggle(x.env.id)} aria-expanded=${!closed[x.env.id]}>
            <span class="chev" style=${closed[x.env.id] ? "transform:rotate(-90deg)" : ""}><${Icon} name="chevron" /></span>
            <${Icon} name="server" size=${17} /><b>${x.env.name}</b>
            <span class="muted small">${x.env.mode === "cloud" ? "UniFi cloud" : "UniFi"} · ${plural(x.devices.length, "device")}</span></button>
          <span class="grow"></span>
        </header>
        ${!closed[x.env.id] && html`<div class="ov-body">
          ${x.error ? html`<div class="notice err slim"><${Icon} name="alert" /><div>${x.error === "not_configured" ? "Not connected yet." : x.error}</div></div>` : html`
          ${!x.readonly && x.networks.length > 0 && html`<div class="legend wrap ov-legend">${x.networks.map((n) => html`<${NetChip} key=${n.id} n=${n}
            color=${colors[n.id]} lg=${lg} ports=${counts[n.id] || 0} still />`)}</div>`}
          ${groups.map((g) => html`<div class="ov-group" key=${g.kind || "all"}>
            ${g.kind && html`<div class="ov-kind"><${Icon} name=${KIND[g.kind].icon} size=${14} />${KIND[g.kind].label}</div>`}
            <div class="devices">${g.list.map((d) => html`<${DeviceCard} key=${d.id} device=${d} networks=${x.networks} colors=${colors} pv=${pv}
              highlight=${null} sel=${null} onPick=${() => {}} onManage=${null}
              collapsed=${false} onCollapse=${() => {}} />`)}</div></div>`)}
          ${pv.apps && x.app_devices.length > 0 && html`<${AppDevices} apps=${x.app_devices} devices=${x.devices} me=${me} env=${x.env} readOnly
            collapsed=${{}} onCollapse=${() => {}} onOpenPort=${null} />`}`}
        </div>`}
      </section>`;
    })}
  </div>`;
}

// --- tips, now and then ------------------------------------------------------------------

const TIPS = [
  { id: "ctrl", when: (c) => canHover && c.change, text: html`<b>Ctrl</b> / <b>⌘</b> click ports to pick several, even on different switches, and change them together.` },
  { id: "shift", when: (c) => canHover && c.change, text: html`<b>Shift</b> click a port to pick every port from the last one you clicked, by port number.` },
  { id: "select", when: (c) => !canHover && c.change, text: html`Tap <b>Select ports</b>, then tap several ports to change them together, even on different switches.` },
  { id: "esc", when: (c) => canHover && c.change, text: html`<b>Esc</b> lets go of the ports you picked.` },
  { id: "bubble", text: html`${canHover ? "Click" : "Tap"} a network bubble to highlight every port that carries it.` },
  { id: "hover", when: () => canHover, text: html`Point at a port to see its link, PoE, network and what's plugged in.` },
  { id: "display", text: html`<b>Display options</b> (the sliders on Networks) choose what bubbles show and how ports look on each screen size.` },
  { id: "scale", text: html`<b>Display options → Scale</b> makes the app bigger or smaller, for this screen only.` },
  { id: "details", text: html`The sliders button on a device shows its firmware, uptime, uplink and more.` },
  { id: "colors", when: (c) => c.multiEnv, text: html`<b>My VLAN colors</b> can match colors across environments, by VLAN number or by name.` },
  { id: "all", when: (c) => c.multiEnv, text: html`Turn on the <b>All devices</b> page in Display options to see every environment at once.` },
  { id: "hide", text: html`Display options can hide ports without link and networks with no ports, to keep big switches calm.` },
  { id: "ver", text: html`The version next to the title opens <b>What's new</b>.` },
  { id: "wizard", text: html`<b>Set up my view</b>, in your menu, runs the setup again.` },
  { id: "theme", text: html`The sun / moon button switches between day and night.` },
  { id: "feedback", when: (c) => c.feedback, text: html`Found a bug or have an idea? Post it on the <b>Feedback</b> tab, or vote for one that's already there.` },
];

function TipsHost({ ctx, paused, onOff }) {
  const [tip, setTip] = useState(null);
  const list = TIPS.filter((t) => !t.when || t.when(ctx));
  const next = () => {
    if (!list.length) return;
    const i = (lsGet("vlanmgr.tip", -1) + 1) % list.length;
    lsSet("vlanmgr.tip", i);
    setTip(list[i]);
  };
  useEffect(() => {
    let shown = null;
    const show = () => { if (!document.hidden && !paused.current) { next(); clearTimeout(shown); shown = setTimeout(() => setTip(null), 15000); } };
    const first = setTimeout(show, 40000);
    const every = setInterval(show, 7 * 60000);
    return () => { clearTimeout(first); clearInterval(every); clearTimeout(shown); };
  }, []);
  if (!tip) return null;
  return html`<div class="tip-card" role="status">
    <span class="tip-icon"><${Icon} name="bulb" size=${17} /></span>
    <div class="tip-text"><div class="tip-head">Tip</div>${tip.text}
      <div class="tip-actions"><button class="link-btn small" onClick=${next}>Next tip</button> · <button class="link-btn small" onClick=${() => { setTip(null); onOff(); }}>Don't show tips</button></div></div>
    <button class="icon-btn sm" onClick=${() => setTip(null)} aria-label="Close"><${Icon} name="x" size=${14} /></button>
  </div>`;
}

// --- many ports at once --------------------------------------------------------------

function BulkDrawer({ env, access, items, networks, colors, me, settings, onRemove, onClose, onApplied }) {
  const can = (c) => (me.caps || []).includes(c);
  const restricted = !access.all_vlans;
  const allowed = networks.filter((n) => n.allowed);
  const defMode = restricted && settings.default_tagged_mode === "auto" ? "block_all" : (settings.default_tagged_mode || "block_all");
  const [native, setNative] = useState("");
  const [mode, setMode] = useState(defMode);
  const [excluded, setExcluded] = useState([]);
  const [busy, setBusy] = useState(false);
  const byDev = [];
  for (const it of items) {
    let g = byDev.find((x) => x.dev.id === it.dev.id);
    if (!g) { g = { dev: it.dev, ports: [] }; byDev.push(g); }
    g.ports.push(it.port);
  }
  for (const g of byDev) g.ports.sort((a, b) => a.idx - b.idx);
  const count = (f) => items.filter(f).length;
  const nWan = count((x) => x.port.wan);
  const nProt = count((x) => x.port.protected && !x.port.wan);
  const nLock = count((x) => x.port.lock);
  const nProfile = count((x) => x.port.profile_name);
  const nFixed = count((x) => nativeOnly(x.dev));
  const anyTagging = items.some((x) => !nativeOnly(x.dev) && !x.port.wan);
  const next = netOf(networks, native);
  const canEdit = can("ports.change");
  // phones: a slim bar while picking ports (the full sheet would cover them), the sheet on "Change…"
  const mobile = useMobile();
  const [open, setOpen] = useState(false);

  async function apply(extra = {}) {
    setBusy(true);
    try {
      const r = await api(`/api/envs/${env.id}/ports/bulk`, { method: "PUT", body: {
        ports: items.map((x) => ({ device_id: x.dev.id, idx: x.port.idx })), native_network_id: native, tagged_mode: mode,
        excluded_network_ids: mode === "custom" ? excluded : [], ...extra } });
      toast(`${plural(r.changed.length, "port")} → ${next.name} (${next.vlan})`);
      if (r.skipped.length) toast(`Skipped ${r.skipped.map((x) => `${x.port} (${x.reason})`).join(", ")}`, "warn");
      for (const n of r.notes || []) toast(n, "warn");
      for (const f of r.failed || []) toast(`${f.device}: ${f.error}`, "err");
      onApplied();
    } catch (e) {
      if (e.status === 409 && e.data.confirm === "bulk") {
        const nd = e.data.needs;
        const ok = await ask({ title: `Change ${plural(e.data.count, "port")}?`, danger: !!nd.protected, confirm: "Change them",
          body: html`${nd.protected && html`<p><b>Protected</b> (uplinks, UniFi device links, LAG / mirror): changing them can cut off what's behind them.</p>
              <p class="mono small">${nd.protected.join(", ")}</p>`}
            ${nd.locked && html`<p><b>Locked</b> by an admin. They stay locked, to the new settings.</p><p class="mono small">${nd.locked.join(", ")}</p>`}
            ${nd.profile && html`<p><b>Port profile</b> attached: setting the VLAN here detaches it.</p><p class="mono small">${nd.profile.join(", ")}</p>`}
            ${e.data.skipped.length > 0 && html`<p class="muted small">Skipped: ${e.data.skipped.map((x) => `${x.port} (${x.reason})`).join(", ")}</p>`}` });
        if (ok) { setBusy(false); return apply({ ...extra, confirm_protected: true, confirm_locked: true, detach_profile: true }); }
      } else toast(e.message, "err");
    }
    setBusy(false);
    return null;
  }

  if (mobile && !open) {
    return html`<div class="bulk-bar" role="region" aria-label="Selected ports">
      <div><b>${plural(items.length, "port")}</b><span class="muted small">${byDev.length > 1 ? ` on ${byDev.length} devices` : ` on ${byDev[0].dev.name}`}</span></div>
      <button class="btn ghost" onClick=${onClose}>Clear</button>
      <button class="btn primary" onClick=${() => setOpen(true)}>Change…</button>
    </div>`;
  }
  return html`<aside class="drawer bulk" role="dialog" aria-label="Change several ports">
    <header class="drawer-head">
      <div><div class="drawer-kicker">${byDev.length > 1 ? `${byDev.length} devices` : byDev[0].dev.name}</div>
        <h2>${plural(items.length, "port")} selected</h2></div>
      ${mobile && html`<button class="btn sm ghost" onClick=${() => setOpen(false)}>Pick more</button>`}
      <button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
    </header>
    <div class="drawer-body">
      <div class="bulk-list">${byDev.map((g) => html`<div class="bulk-dev" key=${g.dev.id}>
        <div class="bulk-dev-name">${g.dev.name}<span class="muted small"> · ${g.dev.model_name}</span></div>
        <div class="bulk-ports">${g.ports.map((p) => html`<span class="bulk-port" key=${p.idx}
          style=${`--c:${p.wan ? "#3b3426" : colors[p.native_network_id] || "#64748b"}`}>
          <span class="sw"></span>${p.idx}${p.wan ? " WAN" : ""}
          <button class="x" title="Remove" onClick=${() => onRemove(g.dev.id, p.idx)}><${Icon} name="x" size=${11} /></button></span>`)}</div>
      </div>`)}</div>
      <p class="muted small">${canHover ? "Ctrl / ⌘ click to add or remove ports, Shift click for a range (by port number), on any switch. Esc lets go."
        : "Tap more ports to add them, on any switch."}</p>
      ${(nWan || nProt || nLock || nProfile || nFixed) > 0 && html`<div class="notice"><${Icon} name="info" /><div>
        ${nWan > 0 && html`<div>${plural(nWan, "WAN port")} will be skipped.</div>`}
        ${nProt > 0 && html`<div>${plural(nProt, "protected port")} — ${can("ports.protected") || env.supervisors_protected ? "you'll be asked to confirm" : "will be skipped (no permission)"}.</div>`}
        ${nLock > 0 && html`<div>${plural(nLock, "locked port")} — ${can("ports.lock") ? "stay locked, to the new settings" : "will be skipped"}.</div>`}
        ${nProfile > 0 && html`<div>${plural(nProfile, "port")} with a port profile — it gets detached.</div>`}
        ${nFixed > 0 && html`<div>${plural(nFixed, "port")} on switches that can't filter tagged VLANs only get the native VLAN.</div>`}
      </div></div>`}
      ${canEdit ? html`<div class="panel">
        <div class="panel-title">Set on all of them</div>
        <label class="field"><span class="field-label">Native VLAN / Network</span>
          <div class="select-wrap"><span class="dot" style=${`background:${native ? colors[native] : "transparent"}`}></span>
            <select value=${native} onChange=${(e) => setNative(e.target.value)}>
              <option value="" disabled>Pick a network…</option>
              ${allowed.map((n) => html`<option value=${n.id}>${n.name} (${n.vlan})</option>`)}
            </select><${Icon} name="chevron" cls="select-chev" /></div></label>
        ${anyTagging && html`<div class="field"><span class="field-label">Tagged VLAN Management</span>
          <${Segmented} value=${mode} onChange=${setMode}
            options=${[{ value: "auto", label: "Allow All", disabled: restricted, title: restricted ? "Would tag networks you don't have" : "" },
              { value: "block_all", label: "Block All" }, { value: "custom", label: "Custom" }]} />
          <small class="hint">${mode === "block_all" ? "Access ports: only the native VLAN, nothing tagged." : mode === "auto" ? "Trunks: every network is tagged." : "Trunks: only the networks ticked below are tagged."}</small></div>`}
        ${anyTagging && mode === "custom" && html`<div class="tag-list">
          ${allowed.filter((n) => n.id !== native).map((n) => html`<label class="tag-row" key=${n.id}>
            <input type="checkbox" checked=${!excluded.includes(n.id)}
              onChange=${(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== n.id) : [...excluded, n.id])} />
            <span class="dot" style=${`background:${colors[n.id]}`}></span>${n.name}<span class="chip-vlan">${n.vlan}</span></label>`)}</div>`}
      </div>` : html`<div class="notice"><${Icon} name="info" /><div>You can look, but changing ports isn't one of your abilities.</div></div>`}
    </div>
    ${canEdit && html`<footer class="drawer-foot">
      <button class="btn ghost" disabled=${busy} onClick=${onClose}>Clear</button>
      <button class="btn primary" disabled=${busy || !next} onClick=${() => apply()}>${busy ? html`<${Spinner} /> Applying…`
        : next ? `Apply to ${plural(items.length, "port")}` : "Pick a network"}</button>
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
      <button class="btn ghost" onClick=${() => setSel(devices.map((d) => d.mac))}>All</button>
      <button class="btn ghost" onClick=${() => setSel(devices.filter((d) => d.kind === "switch").map((d) => d.mac))}>Switches</button>
      <button class="btn ghost" onClick=${() => setSel([])}>None</button>
      <button class="btn primary" onClick=${() => onSave(sel)}>Show selected</button>`}>
    <div class="search"><${Icon} name="search" /><input placeholder="Search name, model, IP or MAC" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
    <div class="pick-list">
      ${list.map((d, i) => {
        const on = sel.includes(d.mac);
        const head = (i === 0 || list[i - 1].kind !== d.kind) && html`<div class="pick-kind"><${Icon} name=${(KIND[d.kind] || KIND.other).icon} size=${14} />${(KIND[d.kind] || KIND.other).label}</div>`;
        return html`${head}<div class=${"pick" + (on ? " on" : "")} key=${d.mac} onClick=${() => toggle(d.mac)}>
          <span class=${"check" + (on ? " on" : "")}>${on && html`<${Icon} name="check" size=${14} />`}</span>
          <span class=${"status-dot " + (d.online ? "on" : "")}></span>
          <div class="pick-main"><b>${d.name}</b><span class="muted">${d.model_name} · ${d.type_label} · ${d.ip || d.mac}</span></div>
          <span class="badge">${d.port_count ? `${d.port_count} ports` : "no ports"}</span>
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
  const [multi, setMulti] = useState([]);          // ["deviceId|idx"] chosen with ctrl / shift / select mode
  const [anchor, setAnchor] = useState(null);      // last port clicked, for shift ranges
  const [selectMode, setSelectMode] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [collapsed, setCollapsed] = useState(lsGet("vlanmgr.collapsed", {}));
  const [closedGroups, setClosedGroups] = useState(lsGet("vlanmgr.groups", {}));
  const [devModal, setDevModal] = useState(null);   // id of the device whose details are open
  const [view, setView] = useState(null);           // "env", "all" (the All devices page) or "feedback"
  const lastPage = useRef("env");
  const [tour, setTour] = useState(null);   // null, or { since: abilities at the last tour (only what's new) or null (all) }
  const modalRef = useRef(null);
  modalRef.current = modal;
  // open the tour once nothing else is up (What's new, the setup wizard...) - never on top of them
  const manualTour = useRef(false);
  // every lit port breathes in step: pin each glow animation to the same clock (ports drawn later would drift)
  useEffect(syncPulse);
  useInterval(syncPulse, 2000);   // ports other parts of the page draw on their own (All devices, previews)   // "Take the tour" from the menu wins over an automatic one
  const startTour = (t) => setTimeout(() => {
    if (!modalRef.current && (!t.since || !manualTour.current)) setTour(t);
  }, 450);
  // a link from a notification: /?fb=12 opens that feedback item
  const deepFb = useRef(Number(new URLSearchParams(location.search).get("fb")) || null);
  const [pending, setPending] = useState(null);     // a port to open once its environment has loaded
  const [wizardLater, setWizardLater] = useState(false);   // closed the setup wizard: ask again next visit
  const tipsPaused = useRef(false);                         // no tips over dialogs and port panels
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState(lsGet("vlanmgr.theme", "dark"));
  const [bootErr, setBootErr] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    lsSet("vlanmgr.theme", theme);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = theme === "light" ? "#eef1f6" : "#0a0c11";
  }, [theme]);
  // the theme is part of the person's settings, so it follows them to other browsers
  useEffect(() => { const t = me && (me.prefs || {}).theme; if (t === "light" || t === "dark") setTheme(t); }, [me && (me.prefs || {}).theme]);
  const toggleTheme = () => { const t = theme === "dark" ? "light" : "dark"; setTheme(t); if (me && !me.impersonator) savePrefs({ theme: t }); };
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
    return m;
  }, []);
  useEffect(() => { if (me) applyZoom((me.prefs || {}).scales); }, [me && JSON.stringify((me.prefs || {}).scales || {})]);
  const loadEnvs = useCallback(async () => {
    const r = await api("/api/envs");
    if (r.settings) { setBrand(r.settings.brand); document.title = r.settings.app_name || "VLAN Manager"; }
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
    const meP = loadMe();
    Promise.all([meP, loadEnvs()]).catch((e) => { if (e.message !== "Signed out") setBootErr(e.message); });
    // What's new waits until someone who must choose a password has done so
    Promise.all([loadVersion(), meP]).then(([v, m]) => {
      if (m && m.must_change_password) return;
      if (lsGet("vlanmgr.seenVersion") !== v.version) { setModal("changelog"); lsSet("vlanmgr.seenVersion", v.version); }
    }).catch(() => {});
  }, []);
  useEffect(() => { lsSet("vlanmgr.env", envId); setSel(null); setHighlight(null); setSt(null); load(true); }, [envId]);
  // the start page: All devices when that page is on and chosen, otherwise the environment
  useEffect(() => {
    if (!me || view) return;
    const p = { ...PORTS_DEFAULTS, ...((me.prefs || {}).ports_view || {}) };
    const fb = (me.caps || []).includes("feedback.view");
    setView(deepFb.current && fb ? "feedback" : startValue(p, fb));
  }, [me]);
  useEffect(() => {
    if (!me || !envList || modal || tour || manualTour.current || me.pending || me.impersonator || me.must_change_password || me.method === "none") return;
    const p = me.prefs || {};
    // the tour comes last: after What's new and after any setup still to do
    if (!p.setup_done || wizardNeeded(p) || !envList.envs.length || !st || st.error) return;
    if (!p.tour_done) { setView("env"); startTour({ since: null }); return; }
    if (!Array.isArray(p.tour_caps)) { savePrefs({ tour_caps: tourCaps(me.caps) }); return; }   // toured before 3.9
    const gained = tourCaps(me.caps).filter((c) => !p.tour_caps.includes(c));
    const lost = p.tour_caps.filter((c) => !(me.caps || []).includes(c));
    if (gained.length) { setView("env"); startTour({ since: p.tour_caps }); }
    else if (lost.length) savePrefs({ tour_caps: tourCaps(me.caps) });   // less access: nothing to show, just remember
  }, [me, envList, modal, st && st.env && st.env.id]);
  useEffect(() => {
    if (!me || !envList || modal || wizardLater || me.pending || me.impersonator) return;
    const need = wizardNeeded(me.prefs);
    if (need && envList.envs.length > 0) setModal(need === "new" ? "wizard-new" : "wizard");
  }, [me, envList, modal, wizardLater]);
  useEffect(() => {
    if (pending && st && st.env.id === pending.env) { setSel({ d: pending.d, i: pending.i }); setPending(null); }
  }, [st, pending]);
  // back to the app (phone unlocked, tab focused): fetch what changed in UniFi meanwhile
  useEffect(() => {
    const back = () => { if (!document.hidden) { load(true); loadEnvs().catch(() => {}); loadVersion().catch(() => {}); } };
    document.addEventListener("visibilitychange", back);
    addEventListener("focus", back);
    return () => { document.removeEventListener("visibilitychange", back); removeEventListener("focus", back); };
  }, [load]);
  // Escape lets go of selected ports
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape" && !modal) { setMulti([]); setSel(null); setSelectMode(false); } };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [modal]);
  const poll = ((envList && envList.settings.poll_seconds) || 10) * 1000;
  useInterval(() => { if (!document.hidden && !modal && view !== "all") load(); }, poll);
  useInterval(() => { if (!document.hidden) loadVersion(); }, 30 * 60 * 1000);
  // news on feedback and requests waiting for this person
  useInterval(() => { if (!document.hidden && !modal) loadMe().catch(() => {}); }, 60 * 1000);

  async function savePrefs(patch) {
    const prefs = { ...(me.prefs || {}), ...patch };
    setMe({ ...me, prefs });
    if (me.method === "none") lsSet("vlanmgr.prefs", prefs);
    else await api("/api/me/prefs", { method: "PUT", body: patch }).catch((e) => toast(e.message, "err"));
  }

  // an admin set this person's password: they choose their own before anything else shows
  if (me && me.must_change_password && !me.impersonator) return html`<${ChoosePassword} me=${me} />`;
  if (bootErr) return html`<${BootError} error=${bootErr} />`;
  if (me && me.pending) return html`<${Waiting} me=${me} />`;
  if (!me || !envList) {
    return html`<div class="boot"><${Logo} size=${48} /><${Spinner} /></div>`;
  }
  window.__vlanmgrStarted = true;

  const settings = envList.settings;
  const prefs = me.prefs || {};
  const lg = { ...LEGEND_DEFAULTS, ...(prefs.legend || {}) };
  const pv = { ...PORTS_DEFAULTS, ...(prefs.ports_view || {}) };
  const setLg = (patch) => savePrefs({ legend: { ...lg, ...patch } });
  const scales = prefs.scales || {};
  // setScale(key, value) for one screen; setScale(null, null, true) keeps only this screen's
  const setScale = (key, v, onlyHere) => {
    if (onlyHere) { const here = screenKey(); savePrefs({ scales: scales[here] ? { [here]: scales[here] } : {} }); return; }
    const next = { ...scales };
    if (v === null || v === 1) delete next[key]; else next[key] = v;
    savePrefs({ scales: next });
  };
  const setPv = (patch) => savePrefs({ ports_view: { ...pv, ...patch } });
  const canFb = (me.caps || []).includes("feedback.view");
  if (view && view !== "feedback") lastPage.current = view;   // where a bug report says it happened
  const showFb = canFb && view === "feedback";
  const showAll = !showFb && pv.overview && view === "all";
  const showEnv = !showFb && !showAll;
  const openFromOverview = (envTo, d, i) => {
    setView("env");
    if (d) setPending({ env: envTo, d, i });
    if (envTo !== envId) setEnvId(envTo); else if (d) { setSel({ d, i }); setPending(null); }
  };
  const can = (c) => (me.caps || []).includes(c);
  const isAdmin = can("settings.manage");
  const canEnvs = can("envs.manage");
  const env = envList.envs.find((e) => e.id === envId);
  const ready = st && env && st.env.id === env.id;
  const networks = ready ? st.networks : [];
  const devices = ready ? st.devices : [];
  const colors = colorsFor(networks, env ? env.vlan_colors : {}, prefs);
  const picks = prefs.devices && !Array.isArray(prefs.devices) ? prefs.devices : {};
  const chosen = env && Array.isArray(picks[env.id]) ? picks[env.id] : null;
  // until someone picks devices, the device types they chose to show (all by default)
  const shown = chosen ? chosen.map((mac) => devices.find((d) => d.mac === mac)).filter(Boolean)
    : devices.filter((d) => (pv.kinds || {})[d.kind || "other"] !== false);
  const appKey = (a) => (["protect", "access"].includes(String(a).toLowerCase()) ? String(a).toLowerCase() : "other");
  const appDevices = ready ? (st.app_devices || []).filter((a) => (pv.app_kinds || {})[appKey(a.app)] !== false) : [];
  // by type (gateways, switches, access points, other), keeping the person's own order inside each
  const groups = pv.group
    ? KIND_ORDER.map((k) => ({ kind: k, list: shown.filter((d) => (d.kind || "other") === k) })).filter((g) => g.list.length)
    : [{ kind: null, list: shown }];
  const toggleGroup = (k) => { const g = { ...closedGroups, [k]: !closedGroups[k] }; setClosedGroups(g); lsSet("vlanmgr.groups", g); };
  const devOpen = devModal && devices.find((d) => d.id === devModal);
  const selDev = sel && devices.find((d) => d.id === sel.d);
  // the example network bubble in the key and in Display options
  const sample = networks.find((n) => n.subnet && !n.is_default) || networks[0];
  const sampleCount = sample ? shown.reduce((a, d) => a + d.ports.filter((p) => p.native_network_id === sample.id).length, 0) : 0;
  const selPort = selDev && selDev.ports.find((p) => p.idx === sel.i);
  const upd = version && version.update && version.update.update_available;
  const keyOf = (d, i) => `${d}|${i}`;
  // plain click: one port. Ctrl / Cmd click (or Select mode): add / remove. Shift click: every port between
  // the last one clicked and this one on the same device, by port number.
  const pick = (d, i, e) => {
    const k = keyOf(d, i);
    if (e && e.shiftKey && anchor && anchor.d === d) {
      const dev = devices.find((x) => x.id === d);
      const lo = Math.min(anchor.i, i), hi = Math.max(anchor.i, i);
      const range = dev.ports.filter((p) => p.idx >= lo && p.idx <= hi).map((p) => keyOf(d, p.idx));
      const base = multi.length ? multi : sel ? [keyOf(sel.d, sel.i)] : [];
      setMulti([...new Set([...base, ...range])]); setSel(null);
    } else if ((e && (e.ctrlKey || e.metaKey)) || selectMode) {
      const base = multi.length ? multi : sel ? [keyOf(sel.d, sel.i)] : [];
      setMulti(base.includes(k) ? base.filter((x) => x !== k) : [...base, k]); setSel(null);
    } else {
      setMulti([]);
      setSel(sel && sel.d === d && sel.i === i ? null : { d, i });
    }
    setAnchor({ d, i });
  };
  const multiSet = new Set(multi);
  tipsPaused.current = !!(modal || sel || multi.length || showFb || tour);
  const multiPorts = multi.map((k) => { const [d, i] = k.split("|"); const dev = devices.find((x) => x.id === d);
    const port = dev && dev.ports.find((p) => p.idx === Number(i)); return port ? { dev, port } : null; }).filter(Boolean);
  const clearMulti = () => { setMulti([]); setAnchor(null); };
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
      ${!chosen && devices.length > 1 && html`<div class="notice slim"><${Icon} name="info" /><div>Showing ${env.access.all_devices ? "all devices" : "your devices"}. <button class="link-btn" onClick=${() => setModal("picker")}>Choose which to show</button></div></div>`}
      ${shown.length === 0 ? html`<div class="empty"><div class="empty-icon"><${Icon} name="grid" size=${40} /></div>
          <h2>${devices.length ? "No devices selected" : "No devices"}</h2>
          <p class="muted">${devices.length ? "Pick the devices you want to see." : env.access.all_devices ? "This environment has no devices yet." : "None of your devices are on the controller right now."}</p>
          ${devices.length > 0 && html`<button class="btn primary" onClick=${() => setModal("picker")}>Choose devices</button>`}</div>`
        : groups.map((g) => html`<section class="group" key=${g.kind || "all"}>
            ${g.kind && html`<button class="group-head" onClick=${() => toggleGroup(g.kind)} aria-expanded=${!closedGroups[g.kind]}>
              <${Icon} name=${KIND[g.kind].icon} size=${16} /><b>${KIND[g.kind].label}</b><span class="badge">${g.list.length}</span>
              <span class="grow"></span><span class="chev" style=${closedGroups[g.kind] ? "transform:rotate(-90deg)" : ""}><${Icon} name="chevron" /></span></button>`}
            ${!(g.kind && closedGroups[g.kind]) && html`<div class="devices">${g.list.map((d) => html`<${DeviceCard} key=${d.id} device=${d} networks=${networks} colors=${colors} pv=${pv}
              highlight=${highlight} sel=${sel} multi=${multiSet} onPick=${pick} collapsed=${!!collapsed[d.mac]} onManage=${(x) => setDevModal(x.id)}
              onCollapse=${() => { const c = { ...collapsed, [d.mac]: !collapsed[d.mac] }; setCollapsed(c); lsSet("vlanmgr.collapsed", c); }} />`)}</div>`}
          </section>`)}
      ${pv.apps && appDevices.length > 0 && html`<${AppDevices} apps=${appDevices} devices=${devices} me=${me} env=${env}
        collapsed=${Object.fromEntries(Object.entries(closedGroups).filter(([k]) => k.startsWith("app:")).map(([k, v]) => [k.slice(4), v]))}
        onCollapse=${(app) => toggleGroup("app:" + app)} onOpenPort=${(d, i) => setSel({ d, i })} onChanged=${() => load(true)} />`}
      <${KeyBox} open=${lg.key_open} onToggle=${() => setLg({ key_open: !lg.key_open })} sample=${!st.readonly && sample}
        sampleColor=${sample ? colors[sample.id] : ""} sampleCount=${sampleCount} lg=${lg} onDisplay=${() => setModal("display")} />`;
  }

  return html`
    ${me.no_auth && html`<div class="danger-banner"><${Icon} name="alert" />
      <span><b>No-auth mode is on.</b> Anyone who can reach this page can ${can("ports.change") ? "change switch ports" : "see your network"}${isAdmin ? " and settings" : ""} without signing in.</span>
      ${me.method === "none" && html`<a href="/login?manual=1">Sign in</a>`}</div>`}
    ${me.impersonator && html`<div class="imp-banner"><${Icon} name="eye" />
      <span>You're viewing as <b>${me.display_name || me.username}</b> (${me.role_name}). Anything you change is logged as ${me.impersonator.username} (as ${me.username}).</span>
      <button class="btn sm" onClick=${async () => { await api("/api/impersonate/stop", { method: "POST" }); location.reload(); }}>Stop viewing as</button></div>`}
    ${me.waiting > 0 && can("users.access") && html`<div class="info-banner"><${Icon} name="users" />
      <span><b>${plural(me.waiting, "person is", "people are")}</b> waiting for you to set them up (signed in with SSO).</span>
      <button class="link-btn" onClick=${() => setModal("users")}>Open Users</button></div>`}
    ${me.initial_password && html`<div class="warn-banner"><${Icon} name="key" /><span>You're using the generated admin password.</span>
      <button class="link-btn" onClick=${() => setModal("account")}>Change it now</button></div>`}
    <header class="topbar">
      <div class="brand"><${Logo} /><div><div class="brand-name"><span class="bn">${settings.app_name}</span>
        <button class=${"ver-chip" + (upd ? " has-update" : "")} onClick=${() => setModal("changelog")}
          title=${upd ? `Version ${version.update.latest} is available` : "What's new"}>v${version ? version.version : "…"}${upd && html`<span class="pulse"></span>`}</button></div>
        <div class="brand-sub">${env ? `${env.name} · ${env.mode === "cloud" ? "UniFi cloud" : "UniFi"}${ready && st.fetched_at ? ` · updated ${ago(st.fetched_at)}` : ""}` : "No environment"}</div></div></div>
      <div class="top-actions">
        <button class="btn ghost" disabled=${!env} onClick=${() => load(true)} title="Refresh from UniFi">
          <${Icon} name="refresh" cls=${loading ? "spin" : ""} /><span class="hide-sm">Refresh</span></button>
        <button class="btn ghost" data-tour="devices" onClick=${() => setModal("picker")} disabled=${!devices.length}><${Icon} name="grid" /><span class="hide-sm">Devices</span></button>
        ${can("activity.view") && html`<button class="btn ghost hide-sm" data-tour="activity" onClick=${() => setModal("audit")}><${Icon} name="list" /><span class="hide-sm">Activity</span></button>`}
        ${can("users.view") && html`<button class="btn ghost hide-sm" data-tour="users" onClick=${() => setModal("users")}><${Icon} name="users" /><span class="hide-sm">Users</span>
          ${me.waiting > 0 && html`<span class="count-dot">${me.waiting}</span>`}</button>`}
        ${(isAdmin || canEnvs) && html`<button class="icon-btn hide-sm" data-tour="settings" onClick=${() => setModal("settings")} title="Settings"><${Icon} name="settings" /></button>`}
        <button class="icon-btn theme-btn" data-tour="theme" onClick=${toggleTheme}
          title=${theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle day / night">
          <${Icon} name=${theme === "dark" ? "sun" : "moon"} /></button>
        <div class="menu-wrap">
          <button class="user-btn" data-tour="menu" onClick=${() => setMenu(!menu)}>
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
            ${!me.impersonator && html`<button onClick=${() => { setMenu(false); setModal("wizard"); }}><${Icon} name="sparkle" />Set up my view</button>`}
            <button onClick=${async () => {
              // fresh from the server, so the tour follows what they can do right now
              setMenu(false); setSel(null); clearMulti(); setView("env"); manualTour.current = true;
              try { await Promise.all([loadMe(), loadEnvs()]); } catch (e) { /* the tour still runs on what's known */ }
              load(true); startTour({ since: null });
            }}><${Icon} name="target" />Take the tour</button>
            <button onClick=${toggleTheme}><${Icon} name=${theme === "dark" ? "sun" : "moon"} />${theme === "dark" ? "Light" : "Dark"} theme</button>
            ${me.method !== "none" ? html`<button onClick=${async () => { const r = await api("/api/auth/logout", { method: "POST" }); location.href = r.redirect; }}><${Icon} name="logout" />Sign out</button>`
              : html`<a href="/login?manual=1"><${Icon} name="login" />Sign in</a>`}
          </div>`}
        </div>
      </div>
    </header>

    <main class=${"main" + (showEnv && (selPort || multiPorts.length) ? " with-drawer" : "") + (selectMode ? " select-mode" : "") + (pv.fx === "solid" ? "" : ` fx-pulse${pv.fx === "faint" ? " fx-faint" : pv.fx === "bright" ? " fx-bright" : ""}`) + (pv.size && pv.size !== "auto" ? ` ps-${pv.size}` : "")}>
      ${(pv.overview || canFb) && html`<div class="view-tabs" role="tablist">
        ${pv.overview && html`<button role="tab" aria-selected=${showAll} class=${showAll ? "on" : ""} onClick=${() => setView("all")}><${Icon} name="grid" size=${15} />All devices</button>`}
        <button role="tab" aria-selected=${showEnv} class=${showEnv ? "on" : ""} onClick=${() => setView("env")}><${Icon} name="server" size=${15} />Environment</button>
        ${canFb && html`<button role="tab" data-tour="feedback" aria-selected=${showFb} class=${showFb ? "on" : ""} onClick=${() => setView("feedback")}><${Icon} name="comment" size=${15} />Feedback
          ${(me.feedback_unseen || 0) + (me.requests_waiting || 0) > 0 && html`<span class="count-dot"
            title=${[me.requests_waiting ? `${me.requests_waiting} request${me.requests_waiting === 1 ? "" : "s"} waiting for you` : "",
              me.feedback_unseen ? `news on ${me.feedback_unseen} item${me.feedback_unseen === 1 ? "" : "s"} you follow` : ""].filter(Boolean).join(", ")}>
            ${(me.feedback_unseen || 0) + (me.requests_waiting || 0)}</span>`}</button>`}
      </div>`}
      ${showAll && html`<${Overview} me=${me} pv=${pv} lg=${lg} prefs=${prefs} poll=${poll} onOpen=${openFromOverview} />`}
      ${showFb && html`<${FeedbackPage} me=${me} onSeen=${loadMe} openFirst=${deepFb.current}
        onOpened=${() => { if (deepFb.current) { deepFb.current = null; history.replaceState(null, "", location.pathname); } }}
        info=${{ version: version ? version.version : "", page: lastPage.current === "all" ? "All devices" : "Environment",
          env: env ? env.name : "", view: viewFor(pv, screenOf(innerWidth)) }} />`}
      ${showEnv && env && html`<div class="env-bar">
        ${envList.envs.length > 1 ? html`<label class="env-select" data-tour="env"><${Icon} name="server" size=${16} />
          <select value=${envId || ""} aria-label="Environment"
            onChange=${(e) => { if (e.target.value === "__add") { e.target.value = String(envId); setModal("settings-add"); } else setEnvId(Number(e.target.value)); }}>
            ${envList.envs.map((e) => html`<option value=${e.id}>${e.name}</option>`)}
            ${canEnvs && html`<option disabled>──────────</option><option value="__add">+ Add environment…</option>`}</select></label>`
          : canEnvs ? html`<label class="env-select"><${Icon} name="server" size=${16} />
              <select value=${envId || ""} aria-label="Environment"
                onChange=${(e) => { if (e.target.value === "__add") { e.target.value = String(envId); setModal("settings-add"); } }}>
                <option value=${env.id}>${env.name}</option><option disabled>──────────</option><option value="__add">+ Add environment…</option>
              </select></label>`
          : html`<span class="env-select single"><${Icon} name="server" size=${16} /><b>${env.name}</b></span>`}
        ${ready && st.fetched_at ? html`<span class="muted small env-updated">Updated ${ago(st.fetched_at)}</span>` : null}
        ${ready && !st.readonly && can("ports.change") && devices.length > 0 && html`<button data-tour="select" class=${"btn sm select-btn" + (selectMode ? " primary" : " ghost")}
          title=${canHover ? "Or Ctrl / ⌘ click ports to pick several, and Shift click for a range" : "Tap ports to pick several"}
          onClick=${() => { setSelectMode(!selectMode); if (selectMode) clearMulti(); }}>
          <${Icon} name="check" size=${14} />${selectMode ? `Selecting${multi.length ? ` · ${multi.length}` : ""}` : "Select ports"}</button>`}
      </div>`}
      ${showEnv && body}
    </main>

    ${showEnv && multiPorts.length > 0 && html`<${BulkDrawer} env=${env} access=${env.access} items=${multiPorts} networks=${networks} colors=${colors}
      me=${me} settings=${settings} onRemove=${(d, i) => setMulti(multi.filter((x) => x !== keyOf(d, i)))}
      onClose=${() => { clearMulti(); setSelectMode(false); }} onApplied=${() => { clearMulti(); setSelectMode(false); load(true); }} />`}
    ${showEnv && selPort && !multiPorts.length && html`<${PortDrawer} readonly=${!!(st && st.readonly)} env=${env} access=${env.access} device=${selDev} port=${selPort} networks=${networks} colors=${colors} me=${me}
      settings=${settings} onClose=${() => setSel(null)} onApplied=${() => load(true)} />`}


    ${modal === "changelog" && version && html`<${ChangelogModal} version=${version} isAdmin=${isAdmin} onClose=${() => setModal(null)}
      onCheck=${async () => { const r = await api("/api/version/check", { method: "POST" }); setVersion({ ...version, update: r.update }); toast(r.update.update_available ? `Version ${r.update.latest} is available` : "You're up to date"); }} />`}
    ${modal === "picker" && env && html`<${PickerModal} devices=${devices} selected=${chosen || shown.map((d) => d.mac)} onClose=${() => setModal(null)}
      onSave=${(macs) => { savePrefs({ devices: { ...picks, [env.id]: macs } }); setModal(null); }} />`}
    ${devOpen && html`<${DeviceModal} env=${env} device=${devOpen} me=${me} readonly=${!!st.readonly} onClose=${() => setDevModal(null)}
      onChanged=${() => load(true)} />`}
    ${(modal === "wizard" || modal === "wizard-new") && html`<${SetupWizard} me=${me} prefs=${prefs} onlyNew=${modal === "wizard-new"}
      kit=${{ NetChip, Faceplate, SCREENS, viewFor, screenKey, LEGEND_DEFAULTS, PORTS_DEFAULTS, appName: settings.app_name, startOptions, FX_OPTIONS }}
      theme=${theme} setTheme=${setTheme}
      onCancel=${modal === "wizard" && !wizardNeeded(prefs) ? () => setModal(null) : null}
      onSave=${async (patch) => { await savePrefs(patch); setModal(null); setView(startValue({ ...PORTS_DEFAULTS, ...patch.ports_view }, canFb));
        toast("All set. Redo it any time from the menu: Set up my view"); }} />`}
    ${modal === "display" && html`<${DisplayModal} lg=${lg} setLg=${setLg} pv=${pv} setPv=${setPv} sample=${sample} scales=${scales} setScale=${setScale}
      sampleColor=${sample ? colors[sample.id] : ""} sampleCount=${sampleCount} canFeedback=${canFb}
      onClose=${() => { setModal(null); if (lg.key_open) setLg({ key_open: false }); }} />`}
    ${modal === "colors" && html`<${ColorsModal} networks=${networks} prefs=${prefs} envColors=${env ? env.vlan_colors : {}}
      onClose=${() => setModal(null)} onSave=${(patch) => { savePrefs(patch); setModal(null); toast("Colors saved"); }} />`}
    ${(modal === "settings" || modal === "settings-add") && html`<${SettingsModal} me=${me} addEnv=${modal === "settings-add"} onClose=${() => setModal(null)} onSaved=${onEnvsChanged} />`}
    ${modal === "users" && html`<${UsersModal} me=${me} onClose=${() => { setModal(null); loadMe(); }} />`}
    ${modal === "account" && html`<${AccountModal} me=${me} onClose=${() => { setModal(null); loadMe(); }} />`}
    ${modal === "audit" && html`<${AuditModal} me=${me} onClose=${() => { setModal(null); load(true); }} />`}
    ${modal === "envinfo" && env && html`<${EnvInfoModal} env=${env} networks=${networks} devices=${devices} onClose=${() => setModal(null)} />`}
    ${pv.tips !== false && html`<${TipsHost} ctx=${{ change: can("ports.change"), multiEnv: envList.envs.length > 1, feedback: can("feedback.submit") }} paused=${tipsPaused}
      onOff=${() => { setPv({ tips: false }); toast("No more tips. Display options can turn them back on."); }} />`}
    ${tour && !modal && (() => {
      const steps = tourSteps({ can, multiEnv: envList.envs.length > 1, appName: settings.app_name,
        hasDevices: showEnv && shown.length > 0, hasPorts: showEnv && !!(st && !st.readonly) && shown.some((d) => d.ports.length),
        canRequest: ["requests.ports", "requests.poe", "requests.restart"].some(can) }, tour.since);
      const done = () => { setTour(null); manualTour.current = false; if (me.id) savePrefs({ tour_done: TOUR_VERSION, tour_caps: tourCaps(me.caps) }); };
      if (!steps.length) { setTimeout(done, 0); return null; }
      return html`<${Tour} key=${tour.since ? "new" : "all"} steps=${steps} onDone=${done} />`;
    })()}
    <${TipHost} /><${AskHost} /><${Toasts} />`;
}

const BUILD = (document.querySelector('meta[name="vlanmgr-build"]') || {}).content || "";
function syncPulse() {
  if (!document.getAnimations) return;
  for (const a of document.getAnimations()) if (a.animationName === "portPulse" && a.startTime !== 0) a.startTime = 0;
}
// how strongly lit ports glow ("pulse" is the default, Soft)
export const FX_OPTIONS = [{ value: "faint", label: "Faint" }, { value: "pulse", label: "Soft" }, { value: "bright", label: "Bright" }, { value: "solid", label: "Solid" }];
const TOUR_VERSION = "3.7";

/** First sign-in (password or SSO) after an admin chose their password: pick your own. Nothing else until then. */
function ChoosePassword({ me }) {
  const [pw, setPw] = useState({ password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  window.__vlanmgrStarted = true;
  const save = async (body) => {
    setBusy(true);
    try { await api("/api/me/password", { method: "PUT", body }); location.reload(); }
    catch (e) { toast(e.message, "err"); setBusy(false); }
  };
  const submit = (e) => {
    e.preventDefault();
    if (pw.password.length < 8) return toast("At least 8 characters", "err");
    if (pw.password !== pw.confirm) return toast("The passwords don't match", "err");
    save({ password: pw.password });
  };
  const signOut = async () => { const r = await api("/api/auth/logout", { method: "POST" }); location.href = r.redirect; };
  return html`<div class="boot waiting">
    <${Logo} size=${52} />
    <form class="boot-error choose-pw" onSubmit=${submit}>
      <h2>Choose your own password</h2>
      <p class="muted">Hi${me.display_name ? ` ${me.display_name.split(" ")[0]}` : ""}. An admin set a temporary password for you.
        Pick one only you know before you continue.</p>
      <input type="text" name="username" autocomplete="username" value=${me.username} hidden />
      <label class="field"><span class="field-label">New password</span>
        <input type="password" autocomplete="new-password" autofocus value=${pw.password} onInput=${(e) => setPw({ ...pw, password: e.target.value })} /></label>
      <label class="field"><span class="field-label">Repeat it</span>
        <input type="password" autocomplete="new-password" value=${pw.confirm} onInput=${(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
      <small class="hint">At least 8 characters.</small>
      <button class="btn primary" type="submit" disabled=${busy}>Save and continue</button>
      ${me.method === "oidc" && html`<p class="muted small choose-pw-sso">You signed in with SSO, which keeps working. This sets the password for
        signing in without it.</p>`}
      <button class="btn ghost" type="button" onClick=${signOut}><${Icon} name="logout" />Sign out</button>
    </form></div>`;
}

/** Someone who signed in with SSO but hasn't been set up by an admin yet. Continues on its own once they are. */
function Waiting({ me }) {
  useInterval(async () => {
    try { const m = await api("/api/me"); if (!m.pending) location.reload(); } catch (e) { /* signed out */ }
  }, 15000);
  window.__vlanmgrStarted = true;
  return html`<div class="boot waiting">
    ${me.impersonator && html`<div class="imp-banner"><${Icon} name="eye" /><span>You're viewing as <b>${me.display_name || me.username}</b>.</span>
      <button class="btn sm" onClick=${async () => { await api("/api/impersonate/stop", { method: "POST" }); location.reload(); }}>Stop viewing as</button></div>`}
    <${Logo} size=${52} />
    <div class="boot-error">
      <h2>Hi${me.display_name ? ` ${me.display_name.split(" ")[0]}` : ""}, you're signed in</h2>
      <p class="muted">Your admin hasn't set you up yet. Please contact them to get access. This page carries on by itself
        as soon as they have.</p>
      <p class="muted small">Signed in as <b>${me.username}</b>${me.email ? ` (${me.email})` : ""} through single sign-on.</p>
      <button class="btn ghost" onClick=${async () => { const r = await api("/api/auth/logout", { method: "POST" }); location.href = r.redirect; }}>
        <${Icon} name="logout" />Sign out</button>
    </div></div>`;
}

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
