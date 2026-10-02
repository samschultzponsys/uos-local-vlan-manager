// Achievements: badges people earn by using the app (see app/achievements.py).
import { useState, useEffect } from "./vendor/preact-htm.module.js";
import { html, api, Icon, Spinner, toast, when } from "./ui.js";

export const TIER_LABEL = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum" };

/** a round medallion: tier color, the achievement's icon; grey with a lock until earned */
export function Badge({ a, size = 44, locked = false }) {
  return html`<span class=${`badge-medal tier-${a.tier}${locked ? " locked" : ""}`} style=${`--bs:${size}px`}
    title=${`${a.name}${a.how ? ` — ${a.how}` : ""}${locked ? "" : ` (${TIER_LABEL[a.tier]})`}`}>
    <${Icon} name=${a.icon} size=${Math.round(size * 0.46)} />
    ${locked && html`<span class="badge-lock"><${Icon} name="lock" size=${Math.max(9, Math.round(size * 0.24))} /></span>`}
  </span>`;
}

/** a few earned badges in a row (Users list) */
export function BadgeStrip({ s }) {
  if (!s || !s.count) return null;
  return html`<span class="badge-strip" title=${`${s.count} achievement${s.count === 1 ? "" : "s"}`}>
    ${s.top.map((a) => html`<${Badge} key=${a.key} a=${a} size=${20} />`)}
    ${s.count > s.top.length && html`<span class="muted small">+${s.count - s.top.length}</span>`}</span>`;
}

/** everything someone can earn, by group: earned ones with the date, the rest with progress */
export function AchievementsList({ uid, self }) {
  const [d, setD] = useState(null);
  const [show, setShow] = useState("all");
  useEffect(() => { api(`/api/achievements${uid && !self ? `/${uid}` : ""}`).then(setD).catch((e) => toast(e.message, "err")); }, [uid]);
  if (!d) return html`<${Spinner} />`;
  if (!d.enabled) return html`<p class="muted small">Achievements are turned off (Settings → Ports).</p>`;
  const list = d.achievements.filter((a) => show === "all" || (show === "earned" ? a.earned_at : !a.earned_at));
  return html`<div class="ach">
    <div class="ach-head">
      <div class="ach-score"><b>${d.earned}</b><span class="muted"> of ${d.total} earned</span></div>
      <div class="ach-bar"><span style=${`width:${d.total ? (d.earned / d.total) * 100 : 0}%`}></span></div>
      <div class="ach-filter">${[["all", "All"], ["earned", "Earned"], ["todo", "To do"]].map(([k, l]) => html`<button key=${k}
        class=${"chip" + (show === k ? " on" : "")} onClick=${() => setShow(k)}>${l}</button>`)}</div>
    </div>
    ${d.groups.map((g) => {
      const items = list.filter((a) => a.group === g);
      if (!items.length) return null;
      return html`<section class="ach-group" key=${g}><h4 class="section">${g}</h4>
        <div class="ach-grid">${items.map((a) => html`<div class=${"ach-card" + (a.earned_at ? " got" : "")} key=${a.key}>
          <${Badge} a=${a} locked=${!a.earned_at} />
          <div class="ach-text"><b>${a.name}</b><span class="muted small">${a.how}</span>
            ${a.earned_at ? html`<span class="ach-when small">${TIER_LABEL[a.tier]} · ${when(a.earned_at).split(",")[0]}</span>`
              : a.goal && a.goal > 1 ? html`<span class="ach-prog"><span class="ach-bar sm"><span style=${`width:${(a.have / a.goal) * 100}%`}></span></span>
                <span class="muted small">${a.have} / ${a.goal}</span></span>` : null}</div></div>`)}</div></section>`;
    })}
  </div>`;
}

/** "Achievement unlocked" cards, one at a time, at the bottom of the screen */
/** tell the server about something only the browser sees (a secret code...); celebrates anything earned */
export function sendEvent(event) {
  api("/api/achievements/event", { method: "POST", body: { event } }).then((r) => announce(r.new)).catch(() => {});
}

// unlocks can arrive before the card host is on screen: they wait here
let waiting = [];
let pushUnlock = null;
const toCards = (items, catchUp) => (catchUp ? [{ catchUp: items.length, a: items[0] }] : items.map((a) => ({ a })));
export function announce(items, catchUp) {
  if (!items || !items.length) return;
  // a big pile from before achievements existed is one card, not a flood
  if (pushUnlock) pushUnlock(toCards(items, catchUp)); else waiting = [...waiting, ...toCards(items, catchUp)];
}
export function UnlockHost({ onOpen }) {
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    pushUnlock = (cards) => setQueue((q) => [...q, ...cards]);
    if (waiting.length) { setQueue((q) => [...q, ...waiting]); waiting = []; }
    return () => { pushUnlock = null; };
  }, []);
  const cur = queue[0];
  useEffect(() => {
    if (!cur) return undefined;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), cur.catchUp ? 9000 : 6500);
    return () => clearTimeout(t);
  }, [cur]);
  if (!cur) return null;
  return html`<div class=${"unlock-card tier-" + cur.a.tier} role="status" key=${cur.a.key + (cur.catchUp || "")}>
    <${Badge} a=${cur.a} size=${52} />
    <div class="unlock-text"><div class="unlock-kicker">${cur.catchUp ? "Achievements unlocked" : "Achievement unlocked"}</div>
      ${cur.catchUp ? html`<b>${cur.catchUp} for what you've already done</b>` : html`<b>${cur.a.name}</b><span class="muted small">${cur.a.how}</span>`}
      <button class="link-btn small" onClick=${() => { setQueue([]); onOpen && onOpen(); }}>See all</button></div>
    <button class="icon-btn sm" onClick=${() => setQueue((q) => q.slice(1))} aria-label="Close"><${Icon} name="x" size=${14} /></button>
  </div>`;
}
