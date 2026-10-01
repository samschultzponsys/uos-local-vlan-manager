// A short guided tour of the real screen: each stop highlights one thing and says what it does,
// only for what this person can see and do. Runs once after setup; "Take the tour" in the menu replays it.
import { useState, useEffect, useLayoutEffect } from "./vendor/preact-htm.module.js";
import { html, Icon } from "./ui.js";

const hover = () => matchMedia("(hover: hover)").matches;
const zoom = () => Number(document.documentElement.style.zoom) || 1;

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** The stops for this person. `c` = { can(cap), multiEnv, hasPorts, hasDevices, appName, canRequest } */
export function tourSteps(c) {
  const click = hover() ? "Click" : "Tap";
  const s = [
    { title: `Welcome to ${c.appName}`, body: "A quick look around, made for what you can do here. Use the arrows or Next; Esc ends it any time." },
    c.multiEnv && { target: '[data-tour="env"]', title: "Environments",
      body: "Each environment is one UniFi site. Switch between the ones you have access to here." },
    { target: ".legend-box", title: "Networks",
      body: `Every network has a color. ${click} one to light up every port that carries it. The slider button sets what the bubbles show.` },
    c.hasPorts && { target: '.device [aria-label^="Port "]', title: "Ports",
      body: c.can("ports.change")
        ? `${click} a port to see its link, PoE and what's plugged in, and to change its VLAN and tagging.`
        : c.can("requests.ports")
          ? `${click} a port to see its link, PoE and what's plugged in. You can't change ports yourself, but you can request a change from there.`
          : `${click} a port to see its link, PoE, network and what's plugged in.` },
    c.hasPorts && c.can("ports.change") && { target: '[data-tour="select"]', title: "Many ports at once",
      body: hover() ? "Ctrl / ⌘ click ports to pick several, even on different switches, and Shift click for a range. Or use Select ports."
        : "Tap Select ports, then tap several ports to change them together." },
    c.hasDevices && { target: '.device button[title="Device details"]', title: "Device details",
      body: "Model, firmware, uptime, uplink and clients." + (c.can("devices.manage") ? " You can also rename it, blink its light, restart it or update its firmware." : "") },
    c.hasDevices && { target: '[data-tour="devices"]', title: "Choose devices", body: "Pick exactly which devices you see, and in what order." },
    c.can("feedback.view") && { target: '[data-tour="feedback"]', title: "Feedback",
      body: "Report a bug or suggest an idea, vote for others' and see where they're at."
        + (c.canRequest ? " Change requests you send show up here too, until someone approves them." : "")
        + (c.can("ports.change") || c.can("devices.manage") ? " Requests waiting for you are counted on the tab." : "") },
    c.can("activity.view") && { target: '[data-tour="activity"]', fallback: '[data-tour="menu"]', title: "Activity",
      body: "Who changed what and when, by day or by person." + (c.can("ports.change") ? " Port changes can be undone from there." : "") },
    c.can("users.view") && { target: '[data-tour="users"]', fallback: '[data-tour="menu"]', title: "People",
      body: "Add people, give them environments, roles and abilities" + (c.can("users.view_as") ? ", and view the app as them" : "") + "." },
    (c.can("settings.manage") || c.can("envs.manage")) && { target: '[data-tour="settings"]', fallback: '[data-tour="menu"]', title: "Settings",
      body: "Environments and API keys" + (c.can("settings.manage") ? ", sign-in and SSO, branding, notifications and GitHub, updates" : "") + "." },
    { target: '[data-tour="theme"]', title: "Day or night", body: "Switch the theme any time." },
    { target: '[data-tour="menu"]', title: "Your menu",
      body: "Your account and password, VLAN colors, Display options (layouts and scale per screen), Set up my view, and this tour again." },
    { title: "That's it", body: "Tips pop up at the bottom now and then. Have fun." },
  ];
  return s.filter(Boolean);
}

export function Tour({ steps, onDone }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const [, tick] = useState(0);
  const step = steps[i];
  const last = i === steps.length - 1;
  const find = (st) => {
    for (const sel of [st.target, st.fallback].filter(Boolean)) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    return null;
  };
  // move over stops whose thing isn't on screen right now (in the direction we were going)
  const go = (to, dir = 1) => {
    let n = to;
    while (n > 0 && n < steps.length - 1 && steps[n].target && !find(steps[n])) n += dir;
    setI(Math.max(0, Math.min(steps.length - 1, n)));
  };
  useLayoutEffect(() => {
    const el = step.target ? find(step) : null;
    if (!el) { setBox(null); return undefined; }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const measure = () => {
      const r = el.getBoundingClientRect(), z = zoom();
      setBox({ x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z });
    };
    measure();
    const t = setTimeout(measure, 350);
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => { clearTimeout(t); removeEventListener("resize", measure); removeEventListener("scroll", measure, true); };
  }, [i]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onDone(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); last ? onDone() : go(i + 1, 1); }
      else if (e.key === "ArrowLeft" && i > 0) go(i - 1, -1);
    };
    addEventListener("keydown", k, true);
    const r = () => tick((n) => n + 1);
    addEventListener("resize", r);
    return () => { removeEventListener("keydown", k, true); removeEventListener("resize", r); };
  }, [i]);

  const pad = 6;
  const vw = innerWidth / zoom(), vh = innerHeight / zoom();
  const narrow = vw < 600;
  const cardW = Math.min(360, vw - 32);
  let card;
  if (!box || narrow) {
    card = narrow && box ? `left:16px;right:16px;${box.y + box.h / 2 > vh / 2 ? "top:16px" : "bottom:16px"}`
      : `left:${(vw - cardW) / 2}px;top:${Math.max(16, vh / 2 - 110)}px;width:${cardW}px`;
  } else {
    const below = box.y + box.h + pad + 14;
    const top = below + 190 < vh ? below : Math.max(16, box.y - pad - 14 - 190);
    const left = Math.min(Math.max(16, box.x + box.w / 2 - cardW / 2), vw - cardW - 16);
    card = `left:${left}px;top:${top}px;width:${cardW}px`;
  }
  const shown = steps.filter((s, n) => n === 0 || n === steps.length - 1 || !s.target || find(s)).length;
  const pos = steps.slice(0, i + 1).filter((s, n) => n === 0 || !s.target || find(s)).length;
  return html`<div class="tour" role="dialog" aria-modal="true" aria-label="Guided tour">
    <div class="tour-shade" onClick=${(e) => e.stopPropagation()}></div>
    ${box ? html`<div class="tour-spot" style=${`left:${box.x - pad}px;top:${box.y - pad}px;width:${box.w + pad * 2}px;height:${box.h + pad * 2}px`}></div>`
      : html`<div class="tour-dim"></div>`}
    <div class="tour-card" style=${card}>
      <div class="tour-step muted small">${pos} of ${shown}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <div class="tour-actions">
        ${!last && html`<button class="link-btn small" onClick=${onDone}>End tour</button>`}
        <span class="grow"></span>
        ${i > 0 && html`<button class="btn sm ghost" onClick=${() => go(i - 1, -1)}><${Icon} name="chevron" size=${14} cls="rot90" />Back</button>`}
        <button class="btn sm primary" autofocus onClick=${() => (last ? onDone() : go(i + 1, 1))}>${last ? "Done" : i === 0 ? "Show me" : "Next"}</button>
      </div>
    </div>
  </div>`;
}
