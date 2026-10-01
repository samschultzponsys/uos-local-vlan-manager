// Shared bits: API helper, icons, small components, markdown, colors.
import { html, useState, useEffect, useRef, useMemo } from "./vendor/preact-htm.module.js";

export { html };

// --- API -------------------------------------------------------------------

export async function api(path, { method = "GET", body } = {}) {
  const opts = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (method !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body || {});
  }
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (r.status === 401 && !path.startsWith("/api/auth/")) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    throw new Error("Signed out");
  }
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// --- icons (24x24 stroke) --------------------------------------------------

const P = {
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  chevron: "m6 9 6 6 6-6",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  key: "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  login: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
  server: "M2 5h20v6H2zM2 13h20v6H2zM6 8h.01M6 16h.01",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  copy: "M9 9h13v13H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  layers: "m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  palette: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1 3.7A2 2 0 0 1 12 22zM7.5 10.5h.01M10.5 7.5h.01M15.5 7.5h.01M17.5 11.5h.01",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  trunk: "M4 7h16M4 12h16M4 17h16",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  sparkle: "M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  uplink: "M12 20V6M6 12l6-6 6 6M5 3h14",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  camera: "M23 7l-7 5 7 5zM1 5h15v14H1z",
  door: "M5 21V3h11l3 3v15M3 21h18M13 12h.01",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  trunksome: "M4 7h16M4 12h10M4 17h5",
  merge: "M6 3v6a6 6 0 0 0 6 6h6M6 21v-6M15 12l3 3-3 3",
  mirror: "M12 3v18M8 7l-5 5 5 5M16 7l5 5-5 5",
  power: "M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  wifi: "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01",
  router: "M2 14h20v6H2zM6 17h.01M10 17h.01M12 14V9M8.5 6.5a5 5 0 0 1 7 0M6 4a8.5 8.5 0 0 1 12 0",
  pencil: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  bulb: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z",
  upgrade: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16 12l-4-4-4 4M12 16V8",
  dots: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4z",
  rows: "M3 5h18M3 12h18M3 19h18",
};

export function Icon({ name, size = 16, fill = false, cls = "" }) {
  if (name === "authentik") {
    return html`<svg class=${"icon " + cls} width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 5.5 12 1l9 4.5v4.2c0 6.2-3.9 11-9 13.3-5.1-2.3-9-7.1-9-13.3z" opacity=".25"/>
      <path fill="currentColor" d="M7 15.5V9l2.5-1.3v6.4zM10.8 17V7l2.4-1.3v10zM14.6 15V8.6L17 7.3v6.4z"/></svg>`;
  }
  return html`<svg class=${"icon " + cls} width=${size} height=${size} viewBox="0 0 24 24" fill=${fill ? "currentColor" : "none"}
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name] || P.info} /></svg>`;
}

// --- helpers ---------------------------------------------------------------

export const ROLE_LABEL = { admin: "Admin", supervisor: "Supervisor", viewer: "Viewer" };
export const MODE_LABEL = { auto: "Allow All", block_all: "Block All", custom: "Custom" };
export const rank = (r) => ({ viewer: 0, supervisor: 1, admin: 2 }[r] ?? -1);

/** 10M, 100M, 1G, 2.5G, 10G, 25G... short enough to always fit. */
export function speedLabel(mbps) {
  if (!mbps) return "";
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`;
}
/** A link as "1G FD" / "100M HD" (no duplex when UniFi doesn't say). */
export function linkLabel(port) {
  if (!port.up) return "";
  const d = port.full_duplex === true ? " FD" : port.full_duplex === false ? " HD" : "";
  return speedLabel(port.speed) + d;
}

export function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "—");

export const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444", "#84cc16",
  "#06b6d4", "#f97316", "#a855f7", "#10b981", "#eab308", "#6366f1", "#f43f5e", "#0ea5e9"];

// network id -> color: auto palette < site defaults < this user's choices
/** How a network is recognised in other environments when someone matches colors across them. */
export const colorKey = (n, mode) => (mode === "vlan" ? `vlan:${n.vlan}` : mode === "name" ? `name:${String(n.name).trim().toLowerCase()}` : null);
const hashOf = (str) => { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

/** Colors for these networks: automatic, then the environment's defaults, then the person's own.
 *  With `sync` ("vlan" or "name") the automatic color comes from the VLAN number / name, so the same
 *  network gets the same color in every environment. */
export function vlanColors(networks, site = {}, mine = {}, sync = null) {
  const out = {};
  let i = 0;
  for (const n of networks) {
    const k = colorKey(n, sync);
    out[n.id] = n.is_default ? "#64748b" : k ? PALETTE[hashOf(k) % PALETTE.length] : PALETTE[i++ % PALETTE.length];
    if (site[n.id]) out[n.id] = site[n.id];
    if (mine[n.id]) out[n.id] = mine[n.id];
  }
  return out;
}

/** A person's own colors for these networks: per network, or shared across environments by VLAN / name. */
export function myColors(networks, prefs) {
  const mode = prefs.color_sync && prefs.color_sync !== "off" ? prefs.color_sync : null;
  const shared = prefs.shared_colors || {};
  const mine = prefs.vlan_colors || {};
  const out = {};
  for (const n of networks) {
    const k = colorKey(n, mode);
    if (k && shared[k]) out[n.id] = shared[k];
    else if (mine[n.id]) out[n.id] = mine[n.id];
  }
  return out;
}
export const colorsFor = (networks, envColors, prefs) =>
  vlanColors(networks, envColors || {}, myColors(networks, prefs), prefs.color_sync && prefs.color_sync !== "off" ? prefs.color_sync : null);

/** Black or white text for a background color, whichever contrasts more (WCAG luminance).
 *  Port tiles are drawn a little lighter at the top, so the color is lifted 10% toward white first. */
export function readable(hex, lift = 0.1) {
  const h = String(hex || "#64748b").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const lin = (v) => { const c = (v + (255 - v) * lift) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(full.substr(i, 2), 16) || 0));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#0b0d12" : "#ffffff";
}
/** A soft halo behind glyphs drawn in readable(hex), so small icons stay legible on any color. */
export const glyphHalo = (fg) => (fg === "#ffffff" ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.55)");

export function lsGet(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
export function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

// --- tiny markdown (changelog) ---------------------------------------------

function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
/** The small Markdown the changelog uses: headings, nested bullets (wrapped lines included), bold, italic,
 *  code and links. A bullet's wrapped lines are joined before formatting, so **bold** may span them. */
export function markdown(src) {
  const out = [];
  let list = 0;
  let item = null;   // raw text of the bullet being read
  let para = null;   // raw text of an indented paragraph inside a list
  const flush = () => {
    if (item !== null) out.push(`<li>${inline(item)}</li>`);
    if (para !== null) out.push(`<p class="cont">${inline(para)}</p>`);
    item = para = null;
  };
  for (const raw of (src || "").split("\n")) {
    const m = raw.match(/^(\s*)[-*] (.*)$/);
    if (m) {
      flush();
      const depth = Math.floor(m[1].length / 2) + 1;
      while (list < depth) { out.push("<ul>"); list++; }
      while (list > depth) { out.push("</ul>"); list--; }
      item = m[2];
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      if (item !== null) { item += " " + raw.trim(); continue; }
      // a paragraph after a blank line belongs to the list level its indent says
      const depth = Math.max(1, Math.floor(raw.match(/^\s*/)[0].length / 2));
      if (para === null) while (list > depth) { out.push("</ul>"); list--; }
      para = (para === null ? "" : para + " ") + raw.trim();
      continue;
    }
    if (!raw.trim() && list) { flush(); continue; }   // a blank line inside a list ends the bullet, not the list
    flush();
    while (list) { out.push("</ul>"); list--; }
    const h = raw.match(/^(#{3,4}) (.*)$/);
    if (h) out.push(`<h4>${inline(h[2])}</h4>`);
    else if (raw.trim()) out.push(`<p>${inline(raw.trim())}</p>`);
  }
  flush();
  while (list) { out.push("</ul>"); list--; }
  return out.join("");
}

// --- components -------------------------------------------------------------

export function Modal({ title, icon, onClose, children, wide, footer }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose && onClose()}>
    <div class=${"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true">
      <header class="modal-head">
        <div class="modal-title">${icon && html`<span class=${"modal-icon " + icon}><${Icon} name=${icon} size=${18} /></span>`}${title}</div>
        ${onClose && html`<button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>`}
      </header>
      <div class="modal-body">${children}</div>
      ${footer && html`<footer class="modal-foot">${footer}</footer>`}
    </div></div>`;
}

export function Toggle({ checked, onChange, disabled, label, hint }) {
  return html`<label class=${"toggle" + (disabled ? " disabled" : "")}>
    <input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />
    <span class="track"><span class="thumb"></span></span>
    <span class="toggle-text">${label}${hint && html`<small>${hint}</small>`}</span>
  </label>`;
}

export function Segmented({ value, options, onChange, disabled }) {
  return html`<div class=${"segmented" + (disabled ? " disabled" : "")} role="radiogroup">
    ${options.map((o) => html`<button type="button" role="radio" aria-checked=${value === o.value} title=${o.title || ""}
      class=${value === o.value ? "on" : ""} disabled=${disabled || o.disabled} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

export function Field({ label, hint, children, locked }) {
  return html`<label class="field"><span class="field-label">${label}${locked && html`<span class="badge warn" title="Set by an environment variable">env</span>`}</span>
    ${children}${hint && html`<small class="hint">${hint}</small>`}</label>`;
}

export function Copy({ text }) {
  const [done, setDone] = useState(false);
  return html`<button type="button" class="btn ghost sm" onClick=${async () => {
    try { await navigator.clipboard.writeText(text); } catch (e) {
      const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
      document.execCommand("copy"); t.remove();
    }
    setDone(true); setTimeout(() => setDone(false), 1500);
  }}><${Icon} name=${done ? "check" : "copy"} size=${14} />${done ? "Copied" : "Copy"}</button>`;
}

// toasts
let pushToast = () => {};
export const toast = (msg, kind = "ok") => pushToast({ msg, kind, id: Math.random() });
export function Toasts() {
  const [list, setList] = useState([]);
  pushToast = (t) => {
    setList((l) => [...l, t]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.kind === "err" ? 7000 : 3500);
  };
  return html`<div class="toasts">${list.map((t) => html`<div class=${"toast " + t.kind} key=${t.id}>
    <${Icon} name=${t.kind === "err" ? "alert" : t.kind === "warn" ? "info" : "check"} />${t.msg}</div>`)}</div>`;
}

export function Spinner() { return html`<span class="spinner" aria-label="Loading"></span>`; }

export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// the brand (name, logo, favicon) as the server sent it in the page; settings refreshes it
export function brandInfo() { return window.__brand || { app_name: "VLAN Manager", logo: { kind: "default" }, favicon: { kind: "default" } }; }
export function setBrand(b) {
  if (!b) return;
  window.__brand = b;
  const f = b.favicon || {};
  const href = f.src || `/favicon.svg?v=${b.version || ""}`;
  document.querySelectorAll('link[rel="icon"]').forEach((l) => { if (l.getAttribute("href") !== href) { l.removeAttribute("type"); l.href = href; } });
}

let gradSeq = 0;
// the header logo; `mark` previews an unsaved one
export function Logo({ size = 28, mark }) {
  const m = mark || brandInfo().logo || { kind: "default" };
  const id = useMemo(() => `lg${++gradSeq}`, []);
  if (m.kind === "image" && m.src) {
    return html`<img src=${m.src} width=${size} height=${size} alt="" class="logo logo-img" />`;
  }
  const [c1, c2, fg] = m.kind === "icon" && m.colors ? m.colors : ["#60a5fa", "#6366f1", "#fff"];
  const glyph = m.kind === "icon" && m.path
    ? html`<g transform="translate(5 5) scale(.9167)" fill="none" stroke=${fg} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d=${m.path} /></g>`
    : html`<rect x="6" y="11" width="4.5" height="4.5" rx="1" fill="#fff"/><rect x="11.8" y="11" width="4.5" height="4.5" rx="1" fill="#fff" opacity=".85"/>
    <rect x="17.6" y="11" width="4.5" height="4.5" rx="1" fill="#22c55e"/><rect x="23.4" y="11" width="2.6" height="4.5" rx="1" fill="#fff" opacity=".6"/>
    <rect x="6" y="17.5" width="4.5" height="4.5" rx="1" fill="#f59e0b"/><rect x="11.8" y="17.5" width="4.5" height="4.5" rx="1" fill="#fff" opacity=".85"/>
    <rect x="17.6" y="17.5" width="4.5" height="4.5" rx="1" fill="#fff"/><rect x="23.4" y="17.5" width="2.6" height="4.5" rx="1" fill="#fff" opacity=".6"/>`;
  return html`<svg width=${size} height=${size} viewBox="0 0 32 32" aria-hidden="true" class="logo">
    <defs><linearGradient id=${id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color=${c1}/><stop offset="1" stop-color=${c2}/></linearGradient></defs>
    <rect x="1" y="1" width="30" height="30" rx="8" fill=${`url(#${id})`}/>${glyph}</svg>`;
}

export function SsoButton({ button, href, onClick }) {
  const b = button || {};
  const icon = b.icon === "custom" && b.icon_url
    ? html`<img src=${b.icon_url} alt="" width="20" height="20" />`
    : b.icon && b.icon !== "none" && b.icon !== "custom" ? html`<${Icon} name=${b.icon} size=${20} />` : null;
  return html`<a class="sso-btn" href=${href || "#"} onClick=${onClick}
    style=${`background:${b.bg || "#fd4b2d"};color:${b.fg || "#fff"}`}>${icon}<span>${b.text || "Sign in with SSO"}</span></a>`;
}

// --- confirm dialog (promise based) -----------------------------------------

let openAsk = () => Promise.resolve(false);
export const ask = (opts) => openAsk(opts);
export function AskHost() {
  const [q, setQ] = useState(null);
  openAsk = (opts) => new Promise((resolve) => setQ({ ...opts, resolve }));
  if (!q) return null;
  const done = (v) => { q.resolve(v); setQ(null); };
  return html`<${Modal} title=${q.title} icon=${q.danger ? "alert" : "info"} wide=${!!q.wide} onClose=${() => done(false)}
    footer=${html`<button class="btn ghost" onClick=${() => done(false)}>${q.cancel || "Cancel"}</button>
      <button class=${"btn " + (q.danger ? "danger" : "primary")} onClick=${() => done(true)}>${q.confirm || "Continue"}</button>`}>
    <div class="ask-body">${q.body}</div></${Modal}>`;
}


// --- profile pictures ---------------------------------------------------------

export function Avatar({ user, size = 28, cls = "" }) {
  const name = (user && (user.display_name || user.username)) || "?";
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px`;
  if (user && user.avatar) return html`<img class=${"avatar img " + cls} src=${user.avatar} alt="" style=${style} />`;
  return html`<span class=${"avatar " + cls} style=${style}>${name.slice(0, 1).toUpperCase()}</span>`;
}

// let the user pick a photo, crop it to a centred square and shrink it (phones take huge photos)
// pick a picture and square it; `transparent` keeps see-through areas (PNG) and fits the whole picture in
export function pickImage(size = 256, { transparent = false } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        if (transparent) {
          const k = size / Math.max(w, h);
          ctx.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
        } else {
          const s = Math.min(w, h);
          ctx.fillStyle = "#1a1f2a";
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
        }
        URL.revokeObjectURL(url);
        resolve(transparent ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.88));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a picture this browser can open")); };
      img.src = url;
    };
    input.click();
  });
}
