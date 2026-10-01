// First-run setup: what to show, how ports look on each screen, network bubbles, colors, start page.
// Every step can keep the defaults; it can be run again from the menu (Set up my view).
import { useState, useEffect } from "./vendor/preact-htm.module.js";
import { html, api, Icon, Modal, Segmented, Toggle, Spinner, colorsFor, colorKey, vlanColors } from "./ui.js";

export const SETUP_VERSION = "2.7";

const MONITORS = [
  ["1366x768", "1366 × 768", "small laptop"], ["1920x1080", "1920 × 1080", "Full HD"], ["2560x1440", "2560 × 1440", "QHD"],
  ["3440x1440", "3440 × 1440", "ultrawide"], ["3840x2160", "3840 × 2160", "4K"], ["5120x1440", "5120 × 1440", "super ultrawide"],
];
const PHONES = [
  { value: "phone", label: "Phone" }, { value: "large", label: "Large phone" }, { value: "fold", label: "Folding phone" },
];
const KIND_LABEL = { gateway: "Gateways", switch: "Switches", ap: "Access points", other: "Other network devices" };
const APP_LABEL = { protect: "Protect devices (cameras, doorbells…)", access: "Access devices (door hubs, readers…)", other: "Other UniFi apps (Talk, Connect…)" };

/** A pretend 16-port switch on the person's own networks, for the layout examples. */
function sampleDevice(networks) {
  const ids = networks.map((n) => n.id);
  const pick = (i) => ids.length ? ids[i % ids.length] : null;
  const ports = Array.from({ length: 16 }, (_, k) => {
    const idx = k + 1;
    const up = ![3, 7, 11, 12, 15].includes(idx);
    return {
      idx, name: `Port ${idx}`, up, enabled: idx !== 12, speed: up ? (idx % 5 ? 1000 : 100) : 0, full_duplex: up, media: "GE",
      media_label: "RJ45 · 1 GbE", sfp: false, wan: false, role: idx === 16 ? "uplink" : null, peer: idx === 16 ? "Core switch" : null,
      apps: [], poe_capable: true, poe_enabled: true, poe_active: up && idx % 3 === 0, poe_power: up && idx % 3 === 0 ? 4.5 : 0,
      poe_mode: "auto", op_mode: "switch", native_network_id: pick(idx % 4 === 0 ? 1 : idx % 5 === 0 ? 2 : idx % 7 === 0 ? 3 : 0),
      tagged_mode: idx === 16 ? "auto" : idx === 9 ? "custom" : "block_all", excluded_network_ids: [], profile_id: null,
      profile_name: null, clients: [], client_count: 0, device_link: null, lldp: null, protected: idx === 16,
      protect_reasons: idx === 16 ? ["Uplink port"] : [], lock: null,
    };
  });
  return { id: "sample", mac: "sample", name: "Example switch", model_name: "USW Lite 16 PoE", model: "USL16LP", kind: "switch",
    type: "usw", online: true, caps: { tagged_vlans: true }, ports, port_count: 16 };
}

function screenClass(SCREENS, w) { return SCREENS.find((x) => w <= x.max).key; }

export function SetupWizard({ me, prefs, kit, onSave, onClose }) {
  const { NetChip, Faceplate, SCREENS, viewFor, screenKey, LEGEND_DEFAULTS, PORTS_DEFAULTS } = kit;
  const caps = me.caps || [];
  const [data, setData] = useState(null);
  const [step, setStep] = useState(0);
  const [lg, setLgS] = useState({ ...LEGEND_DEFAULTS, ...(prefs.legend || {}) });
  const [pv, setPvS] = useState({ ...PORTS_DEFAULTS, ...(prefs.ports_view || {}) });
  const [scales, setScales] = useState({ ...(prefs.scales || {}) });
  const [sync, setSync] = useState(prefs.color_sync || "off");
  const [mine, setMine] = useState({ ...(prefs.vlan_colors || {}) });
  const [shared, setShared] = useState({ ...(prefs.shared_colors || {}) });
  const setLg = (p) => setLgS({ ...lg, ...p });
  const setPv = (p) => setPvS({ ...pv, ...p });
  useEffect(() => { api("/api/overview").then(setData).catch(() => setData({ envs: [] })); }, []);

  // this screen, and the main monitor / phone the person tells us about
  const here = screenKey();
  const hereClass = screenClass(SCREENS, innerWidth);
  const [monitor, setMonitor] = useState(hereClass === "phone" ? "1920x1080" : here);
  const monW = Number(monitor.split("x")[0]) || 1920;
  const monClass = screenClass(SCREENS, monW);
  const [phone, setPhone] = useState("phone");
  const [foldScreen, setFoldScreen] = useState("cover");
  const phoneClass = phone === "fold" && foldScreen === "inner" ? "tablet" : "phone";
  const views = SCREENS.reduce((a, x) => ({ ...a, [x.key]: viewFor(pv, x.key) }), {});
  const setView = (cls, v) => setPv({ views: { ...views, [cls]: v } });

  if (!data) return html`<${Modal} title="Set up your view" icon="sparkle" onClose=${onClose}><div class="empty-sm"><${Spinner} /></div></${Modal}>`;

  const allNets = data.envs.flatMap((x) => x.networks.map((n) => ({ ...n, env: x.env })));
  const nets = data.envs[0] ? data.envs[0].networks : [];
  const sample = sampleDevice(nets.length ? nets : [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
  const sampleNet = nets.find((n) => n.subnet && !n.is_default) || nets[0];
  const prefsNow = { ...prefs, color_sync: sync, vlan_colors: mine, shared_colors: shared };
  const colors0 = data.envs[0] ? colorsFor(nets, data.envs[0].env.vlan_colors, prefsNow) : {};
  const kinds = [...new Set(data.envs.flatMap((x) => x.devices.map((d) => d.kind || "other")))];
  const appKinds = ["protect", "access", "other"].filter((a) => caps.includes(`apps.${a}`));
  const multiEnv = data.envs.length > 1;

  const finish = () => onSave({ legend: lg, ports_view: pv, scales, color_sync: sync, vlan_colors: mine, shared_colors: shared, setup_done: SETUP_VERSION });
  const skipAll = () => onSave({ setup_done: SETUP_VERSION });

  const viewPicker = (cls, phoneLike) => html`<div class="wz-views">
    ${[[phoneLike ? "tiles" : "faceplate", phoneLike ? "Tiles" : "Faceplate", phoneLike ? "Big tap targets, every port in order" : "Drawn like the hardware"],
      ["compact", "Compact", "Small squares, port number in the network's color"], ["list", "List", "One row per port with its network and what's plugged in"]]
      .map(([v, label, hint]) => html`<button class=${"wz-view" + (views[cls] === v ? " on" : "")} onClick=${() => setView(cls, v)} key=${v}>
        <div class=${"wz-preview" + (phoneLike ? " narrow" : "")}><${Faceplate} device=${sample} pv=${{ ...pv, hide_down: false }} forceView=${v}
          forceMobile=${phoneLike && v === "tiles"} networks=${nets.length ? nets : []} colors=${colors0} highlight=${null} sel=${null} onPick=${() => {}} /></div>
        <b>${label}</b><span class="muted small">${hint}</span></button>`)}</div>`;

  const steps = [
    { key: "welcome", title: "Welcome", body: html`
      <p>Let's make VLAN Manager look the way you like. It takes a minute, every step can keep the defaults, and you can redo it any
        time from the menu (<b>Set up my view</b>).</p>
      <p class="muted small">Your choices are saved to your account, so they follow you to any browser. Port layouts and scale are kept per screen size.</p>` },
    { key: "devices", title: "What to show", body: html`
      <p class="muted">Which devices should show by default? You can always pick exact devices later with <b>Devices</b>.</p>
      <div class="wz-checks">
        ${(caps.includes("apps.network") ? ["gateway", "switch", "ap", "other"] : []).filter((k) => kinds.includes(k) || k !== "other").map((k) => html`
          <label class="tag-row" key=${k}><input type="checkbox" checked=${(pv.kinds || {})[k] !== false}
            onChange=${(e) => setPv({ kinds: { ...(pv.kinds || {}), [k]: e.target.checked } })} />${KIND_LABEL[k]}</label>`)}
        ${appKinds.map((a) => html`<label class="tag-row" key=${a}><input type="checkbox" checked=${(pv.app_kinds || {})[a] !== false}
            onChange=${(e) => setPv({ app_kinds: { ...(pv.app_kinds || {}), [a]: e.target.checked } })} />${APP_LABEL[a]}</label>`)}
      </div>
      ${!caps.includes("apps.network") && appKinds.length === 0 && html`<p class="muted small">Your role doesn't include any device types yet — ask an admin.</p>`}` },
    { key: "monitor", title: "Your main computer screen", body: html`
      <p class="muted">Pick the monitor you use most. Its layout and scale are only used on screens with that resolution.</p>
      <div class="wz-chips">${[...(MONITORS.some(([k]) => k === here) || hereClass === "phone" ? [] : [[here, here.replace("x", " × "), "this screen"]]), ...MONITORS]
        .map(([k, label, hint]) => html`<button key=${k} class=${"chip" + (monitor === k ? " on" : "")} onClick=${() => setMonitor(k)}>${label}<span class="muted">${k === here ? "this screen" : hint}</span></button>`)}</div>
      <div class="field-label wz-label">Ports on that screen</div>
      ${viewPicker(monClass, false)}
      <div class="opt-row"><div><b>Scale on ${monitor.replace("x", " × ")}</b><div class="muted small">Bigger or smaller than stock (100 %).</div></div>
        <div class="row"><input type="range" min="0.7" max="1.6" step="0.05" value=${scales[monitor] || 1}
          onInput=${(e) => { const v = Number(e.target.value); const x = { ...scales }; if (v === 1) delete x[monitor]; else x[monitor] = v; setScales(x); }} />
          <b class="scale-val">${Math.round((scales[monitor] || 1) * 100)}%</b></div></div>` },
    { key: "phone", title: "Your phone", body: html`
      <p class="muted">What do you use on the go?</p>
      <${Segmented} value=${phone} onChange=${setPhone} options=${PHONES} />
      ${phone === "fold" && html`<div class="opt-row"><div><b>Which screen do you use most?</b><div class="muted small">The inner screen gets the tablet layout.</div></div>
        <${Segmented} value=${foldScreen} onChange=${setFoldScreen} options=${[{ value: "cover", label: "Cover" }, { value: "inner", label: "Inner" }]} /></div>`}
      <div class="field-label wz-label">Ports on ${phoneClass === "tablet" ? "the inner screen" : "your phone"}</div>
      ${viewPicker(phoneClass, phoneClass === "phone")}` },
    { key: "bubbles", title: "Network bubbles", body: html`
      ${sampleNet && html`<div class="opt-preview"><${NetChip} n=${sampleNet} color=${colors0[sampleNet.id]} lg=${lg} ports=${4} example />
        <span class="muted small">This is how a network shows above your devices.</span></div>`}
      ${[["vlan", "VLAN number"], ["ports", "Ports on the network"], ["clients", "Connected clients"], ["ip", "IP subnet"]].map(([k, label]) => html`
        <div class="opt-row" key=${k}><b>${label}</b><${Segmented} value=${lg[k]} onChange=${(v) => setLg({ [k]: v })}
          options=${[{ value: "off", label: "Off" }, { value: "always", label: "Always" }, { value: "hover", label: "On hover / tap" }]} /></div>`)}
      <div class="opt-row"><b>IP shown as</b><${Segmented} value=${lg.ip_format} onChange=${(v) => setLg({ ip_format: v })}
        options=${[{ value: "subnet", label: "Subnet" }, { value: "gateway", label: "Gateway IP" }, { value: "both", label: "Gateway/mask" }]} /></div>` },
    { key: "colors", title: "Colors", body: html`
      ${multiEnv && html`<div class="opt-row"><div><b>Match colors across environments?</b>
        <div class="muted small">By VLAN number suits sites that use the same VLAN plan; by name suits sites that name networks the same.</div></div>
        <${Segmented} value=${sync} onChange=${setSync} options=${[{ value: "off", label: "No" }, { value: "vlan", label: "By VLAN" }, { value: "name", label: "By name" }]} /></div>`}
      <div class="color-list">${(sync !== "off" ? dedupe(allNets, sync) : allNets).map((n) => {
        const k = colorKey(n, sync !== "off" ? sync : null);
        const envNets = data.envs.find((x) => x.env.id === n.env.id);
        const c = colorsFor(envNets ? envNets.networks : [n], n.env.vlan_colors, prefsNow)[n.id] || vlanColors([n])[n.id];
        return html`<label class="color-row" key=${k || n.id}>
          <input type="color" value=${c} onInput=${(e) => {
            if (k) setShared({ ...shared, [k]: e.target.value }); else setMine({ ...mine, [n.id]: e.target.value });
          }} />
          <span class="color-name">${n.name}</span><span class="chip-vlan">VLAN ${n.vlan}</span>
          ${multiEnv && sync === "off" && html`<span class="muted small">${n.env.name}</span>`}
          ${multiEnv && sync !== "off" && n.count > 1 && html`<span class="muted small">in ${n.count} environments</span>`}</label>`;
      })}</div>` },
    { key: "finish", title: "Last touches", body: html`
      <div class="opt-row"><div><b>Ports with link</b><div class="muted small">Pulse gently in their network's color, or stay solid.</div></div>
        <${Segmented} value=${pv.fx} onChange=${(v) => setPv({ fx: v })} options=${[{ value: "pulse", label: "Pulse" }, { value: "solid", label: "Solid" }]} /></div>
      <${Toggle} checked=${pv.overview} onChange=${(v) => setPv({ overview: v, start: v ? "all" : pv.start })} label="All devices page"
        hint="Every environment on one view-only page." />
      ${pv.overview && html`<div class="opt-row"><b>Start on</b><${Segmented} value=${pv.start} onChange=${(v) => setPv({ start: v })}
        options=${[{ value: "all", label: "All devices" }, { value: "env", label: "My environment" }]} /></div>`}
      <p class="muted small">Everything here is also under <b>Display options</b> and <b>My VLAN colors</b>.</p>` },
  ];
  const s = steps[step];
  const last = step === steps.length - 1;
  const keepDefaults = () => {
    if (s.key === "devices") setPv({ kinds: {}, app_kinds: {} });
    if (s.key === "monitor") { setView(monClass, PORTS_DEFAULTS.desktop); const x = { ...scales }; delete x[monitor]; setScales(x); }
    if (s.key === "phone") setView(phoneClass, phoneClass === "phone" ? "tiles" : "faceplate");
    if (s.key === "bubbles") setLgS({ ...LEGEND_DEFAULTS });
    if (s.key === "colors") { setSync("off"); }
    if (s.key === "finish") setPv({ fx: "pulse", overview: false });
    if (last) finish(); else setStep(step + 1);
  };
  return html`<${Modal} title="Set up your view" icon="sparkle" onClose=${onClose} wide
    footer=${html`<div class="wz-dots">${steps.map((x, i) => html`<span class=${i === step ? "on" : i < step ? "done" : ""} key=${x.key}></span>`)}</div>
      <span class="grow"></span>
      ${step === 0 ? html`<button class="btn ghost" onClick=${skipAll}>Skip, keep stock</button>`
        : html`<button class="btn ghost" onClick=${() => setStep(step - 1)}>Back</button><button class="btn ghost" onClick=${keepDefaults}>Keep the defaults</button>`}
      <button class="btn primary" onClick=${() => (last ? finish() : setStep(step + 1))}>${step === 0 ? "Let's go" : last ? "Done" : "Next"}</button>`}>
    <div class="wz">
      <div class="wz-step muted small">Step ${step + 1} of ${steps.length}</div>
      <h3 class="wz-title">${s.title}</h3>
      ${s.body}
    </div></${Modal}>`;
}

/** One entry per VLAN number (or name) across environments, remembering how many share it. */
function dedupe(nets, mode) {
  const by = new Map();
  for (const n of nets) {
    const k = colorKey(n, mode);
    if (by.has(k)) by.get(k).count += 1; else by.set(k, { ...n, count: 1 });
  }
  return [...by.values()];
}
