// The feedback board: bug reports and ideas, their status, votes and comments.
import { useState, useEffect, useRef } from "./vendor/preact-htm.module.js";
import { html, api, Icon, Modal, Segmented, Toggle, Field, toast, Spinner, Avatar, ago, when, ask, askText, pickImage, imageFromFile, useInterval } from "./ui.js";

export const STATUS = {
  open: { label: "Open", icon: "inbox" },
  planned: { label: "Planned", icon: "target" },
  progress: { label: "In progress", icon: "clock" },
  done: { label: "Done", icon: "check" },
  wontfix: { label: "Won't do", icon: "x" },
};
const KIND = { bug: { label: "Bug", icon: "bug" }, idea: { label: "Idea", icon: "bulb" }, request: { label: "Request", icon: "send" } };
// a request's statuses read differently
const REQ_STATUS = { open: "Waiting for approval", done: "Approved", wontfix: "Declined" };
const statusLabel = (it, k = it.status) => (it.kind === "request" && REQ_STATUS[k]) || STATUS[k].label;
const REQUEST_CAPS = [["requests.ports", "Port VLAN changes"], ["requests.poe", "PoE power-cycles"], ["requests.restart", "Device restarts"]];
const COLUMNS = ["open", "planned", "progress", "done"];
const SHOT_MAX = 1600;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

function useNarrow(px = 900) {
  const q = `(max-width: ${px - 1}px)`;
  const [narrow, setNarrow] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** "Chrome 129 on Windows" from the user agent */
function browserName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  const m = ua.match(/(Edg|OPR|Firefox|SamsungBrowser|Chrome|CriOS|FxiOS)\/(\d+)/) || (/Safari/.test(ua) && ua.match(/Version\/(\d+)/));
  const names = { Edg: "Edge", OPR: "Opera", CriOS: "Chrome", FxiOS: "Firefox", SamsungBrowser: "Samsung Internet" };
  const b = m ? (m.length > 2 ? `${names[m[1]] || m[1]} ${m[2]}` : `Safari ${m[1]}`) : "Browser";
  return os ? `${b} on ${os}` : b;
}

/** what's sent along with a report, so whoever fixes it knows where it happened */
export function reportContext(info = {}) {
  const dpr = window.devicePixelRatio || 1;
  return {
    version: info.version || "", page: info.page || "", env: info.env || "", view: info.view || "",
    browser: browserName(),
    screen: `${screen.width}×${screen.height}${dpr !== 1 ? ` @${Math.round(dpr * 100) / 100}x` : ""}, window ${innerWidth}×${innerHeight}`,
    theme: document.documentElement.dataset.theme || "",
  };
}
const CONTEXT_LABEL = { version: "Version", page: "Page", env: "Environment", view: "Port view", browser: "Browser", screen: "Screen", theme: "Theme" };

export function FeedbackPage({ me, info, onSeen, openFirst, onOpened }) {
  const [who, setWho] = useState(false);
  const [data, setData] = useState(null);
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("top");
  const [wontfix, setWontfix] = useState(false);
  const [col, setCol] = useState("open");
  const [openId, setOpenId] = useState(openFirst || null);
  useEffect(() => { if (openFirst && onOpened) onOpened(); }, []);
  const [newOpen, setNewOpen] = useState(false);
  const narrow = useNarrow();
  const load = () => api("/api/feedback").then(setData).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  useInterval(() => { if (!openId && !newOpen && document.visibilityState === "visible") load(); }, 30000);
  if (!data) return html`<div class="empty"><${Spinner} /></div>`;

  const can = data.can;
  const needle = q.trim().toLowerCase();
  const items = data.items.filter((it) => (kind === "all" || it.kind === kind)
    && (!needle || `${it.title} ${it.body} ${it.author.name} #${it.id}`.toLowerCase().includes(needle)));
  const order = {
    top: (a, b) => b.votes - a.votes || b.updated_at - a.updated_at,
    new: (a, b) => b.created_at - a.created_at,
    updated: (a, b) => b.updated_at - a.updated_at,
  }[sort];
  const cols = [...COLUMNS, ...(wontfix ? ["wontfix"] : [])];
  const byStatus = Object.fromEntries(cols.map((s) => [s, items.filter((it) => it.status === s).sort(
    s === "done" || s === "wontfix" ? (a, b) => b.closed_at - a.closed_at : order)]));
  const unseen = data.items.filter((it) => it.unseen).length;
  const waiting = data.items.filter((it) => it.can_approve).length;
  const hasRequests = data.items.some((it) => it.kind === "request");
  const canWho = (me.caps || []).includes("users.roles");
  const vote = async (it) => {
    if (!can.submit) return;
    try {
      const r = await api(`/api/feedback/${it.id}/vote`, { method: "POST", body: { on: !it.voted } });
      setData({ ...data, items: data.items.map((x) => (x.id === it.id ? { ...x, votes: r.votes, voted: r.voted } : x)) });
    } catch (e) { toast(e.message, "err"); }
  };
  const shownCols = narrow ? [col] : cols;

  return html`<section class="fb">
    <div class="fb-head">
      <div class="fb-title"><h2>Feedback</h2>
        <span class="muted small">${plural(data.items.filter((i) => !["done", "wontfix"].includes(i.status)).length, "open item")}${unseen ? html` · <b class="fb-new-count">${unseen} with news for you</b>` : ""}${waiting ? html` · <b class="fb-new-count">${plural(waiting, "request")} waiting for you</b>` : ""}</span></div>
      <div class="row">
        ${canWho && html`<button class="btn ghost" onClick=${() => setWho(true)}><${Icon} name="send" size=${15} />Who can request</button>`}
        ${can.submit && html`<button class="btn primary" onClick=${() => setNewOpen(true)}><${Icon} name="plus" />Report a bug or idea</button>`}</div>
    </div>
    <div class="fb-tools">
      <${Segmented} value=${kind} onChange=${setKind} options=${[{ value: "all", label: "All" }, { value: "bug", label: "Bugs" }, { value: "idea", label: "Ideas" },
        ...(hasRequests ? [{ value: "request", label: "Requests" }] : [])]} />
      <label class="fb-search"><${Icon} name="search" size=${15} /><input type="search" placeholder="Search" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
      <label class="fb-sort"><span class="muted small">Sort</span><select value=${sort} onChange=${(e) => setSort(e.target.value)}>
        <option value="top">Most votes</option><option value="new">Newest</option><option value="updated">Recently updated</option></select></label>
      <${Toggle} checked=${wontfix} onChange=${(v) => { setWontfix(v); if (!v && col === "wontfix") setCol("open"); }} label="Show won't do" />
    </div>
    ${narrow && html`<div class="fb-colpick"><${Segmented} value=${col} onChange=${setCol}
      options=${cols.map((s) => ({ value: s, label: `${STATUS[s].label} ${byStatus[s].length}` }))} /></div>`}
    ${who && html`<${WhoCanRequest} me=${me} onClose=${() => setWho(false)} />`}
    <div class=${"fb-board" + (narrow ? " one" : "")} style=${narrow ? "" : `grid-template-columns: repeat(${cols.length}, minmax(0, 1fr))`}>
      ${shownCols.map((s) => html`<div class=${`fb-col st-${s}`} key=${s}>
        ${!narrow && html`<div class="fb-col-head"><${Icon} name=${STATUS[s].icon} size=${15} /><b>${STATUS[s].label}</b><span class="badge">${byStatus[s].length}</span></div>`}
        ${byStatus[s].length === 0 && html`<div class="fb-none muted small">${s === "open" && can.submit && !needle ? "Nothing open. Found a bug or have an idea? Report it." : "Nothing here."}</div>`}
        ${byStatus[s].map((it) => html`<${Card} key=${it.id} it=${it} canVote=${can.submit && it.kind !== "request"} onVote=${() => vote(it)} onOpen=${() => setOpenId(it.id)} />`)}
      </div>`)}
    </div>
    ${openId && html`<${ItemModal} id=${openId} can=${can} onClose=${() => { setOpenId(null); load(); onSeen && onSeen(); }} />`}
    ${newOpen && html`<${NewModal} info=${info} onClose=${() => setNewOpen(false)}
      onCreated=${(id) => { setNewOpen(false); load(); setOpenId(id); toast("Thanks! It's on the board."); }} />`}
  </section>`;
}

function Card({ it, canVote, onVote, onOpen }) {
  return html`<div class=${"fb-card" + (it.unseen ? " unseen" : "")} role="button" tabindex="0" onClick=${onOpen}
    onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
    <div class="fb-card-top">
      <span class=${`fb-kind k-${it.kind}`}><${Icon} name=${KIND[it.kind] ? KIND[it.kind].icon : "info"} size=${13} />${KIND[it.kind] ? KIND[it.kind].label : it.kind}</span>
      <span class="muted small">#${it.id}</span>
      ${it.unseen && html`<span class="fb-news">New activity</span>`}
      ${it.can_approve && html`<span class="fb-news">Needs you</span>`}
      <span class="grow"></span>
      ${it.kind === "request" ? html`<span class=${`fb-status sm st-${it.status}`}>${statusLabel(it)}</span>`
        : html`<button class=${"fb-vote" + (it.voted ? " on" : "")} disabled=${!canVote} title=${it.voted ? "Take back your vote" : "I want this too"}
        onClick=${(e) => { e.stopPropagation(); onVote(); }}><${Icon} name="vote" size=${14} /><b>${it.votes}</b></button>`}
    </div>
    <div class="fb-card-title">${it.title}</div>
    ${it.body && html`<div class="fb-card-body">${it.body}</div>`}
    <div class="fb-card-foot">
      <${Avatar} user=${{ display_name: it.author.name, avatar: it.author.avatar }} size=${20} />
      <span class="muted small fb-by">${it.mine ? "You" : it.author.name} · ${ago(it.created_at)}</span>
      <span class="grow"></span>
      ${it.image && html`<span class="muted small" title="Has a screenshot"><${Icon} name="image" size=${14} /></span>`}
      ${it.comments > 0 && html`<span class="muted small fb-ncom"><${Icon} name="comment" size=${14} />${it.comments}</span>`}
    </div>
  </div>`;
}

/** attach a screenshot: pick a file, or paste one (Ctrl / ⌘ V) anywhere in the dialog */
function Screenshot({ value, onChange }) {
  const fromPick = async () => {
    try { const img = await pickImage(SHOT_MAX, { fit: true }); if (img) onChange(img); } catch (e) { toast(e.message, "err"); }
  };
  return html`<div class="fb-shot">
    ${value ? html`<div class="fb-shot-prev"><img src=${value} alt="Screenshot" />
        <button class="btn sm" onClick=${() => onChange(null)}><${Icon} name="trash" size=${14} />Remove</button></div>`
      : html`<button class="btn" onClick=${fromPick}><${Icon} name="image" size=${15} />Attach a screenshot</button>
        ${matchMedia("(hover: hover)").matches && html`<span class="muted small">or paste one here (${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"} V)</span>`}`}
  </div>`;
}

function usePasteImage(onImage) {
  useEffect(() => {
    const on = (e) => {
      const f = [...((e.clipboardData && e.clipboardData.files) || [])].find((x) => x.type.startsWith("image/"));
      if (!f) return;
      e.preventDefault();
      imageFromFile(f, SHOT_MAX, { fit: true }).then(onImage, (err) => toast(err.message, "err"));
    };
    addEventListener("paste", on);
    return () => removeEventListener("paste", on);
  }, []);
}

function NewModal({ info, onClose, onCreated }) {
  const [kind, setKind] = useState("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [shot, setShot] = useState(null);
  const [withCtx, setWithCtx] = useState(true);
  const [busy, setBusy] = useState(false);
  const ctx = reportContext(info);
  usePasteImage(setShot);
  const send = async () => {
    if (!title.trim()) return toast("Give it a short title", "err");
    setBusy(true);
    try {
      const r = await api("/api/feedback", { method: "POST", body: { kind, title, body, image: shot, context: withCtx ? ctx : {} } });
      onCreated(r.id);
    } catch (e) { toast(e.message, "err"); setBusy(false); }
  };
  return html`<${Modal} title="Report a bug or idea" icon="comment" onClose=${onClose}
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy || !title.trim()} onClick=${send}>Post it</button>`}>
    <div class="form">
      <div class="fb-kinds">${Object.entries(KIND).map(([k, v]) => html`<button class=${"fb-kind-pick" + (kind === k ? " on" : "")} onClick=${() => setKind(k)}>
        <${Icon} name=${v.icon} size=${20} /><b>${k === "bug" ? "Something's wrong" : "An idea"}</b>
        <span class="muted small">${k === "bug" ? "A bug: it broke, or doesn't do what it should." : "A feature or a change you'd like."}</span></button>`)}</div>
      <${Field} label="Title"><input value=${title} maxlength="140" autofocus
        placeholder=${kind === "bug" ? "e.g. Port 12 shows the wrong VLAN after a change" : "e.g. Show the PoE budget per switch"}
        onInput=${(e) => setTitle(e.target.value)} /></${Field}>
      <${Field} label="Details" hint=${kind === "bug" ? "What did you do, what happened, and what did you expect?" : "What would it help you do?"}>
        <textarea class="fb-text" rows="5" value=${body} maxlength="8000" onInput=${(e) => setBody(e.target.value)}></textarea></${Field}>
      <${Screenshot} value=${shot} onChange=${setShot} />
      <${Toggle} checked=${withCtx} onChange=${setWithCtx} label="Include technical details"
        hint=${`Only whoever handles it and you can see these: ${Object.entries(ctx).filter(([, v]) => v).map(([k, v]) => `${CONTEXT_LABEL[k]} ${v}`).join(" · ")}`} />
      <p class="muted small">Everyone who can see the board can read this and vote on it.</p>
    </div></${Modal}>`;
}

function ItemModal({ id, can, onClose }) {
  const [it, setIt] = useState(null);
  const [comment, setComment] = useState("");
  const [edit, setEdit] = useState(null);
  const [status, setStatus] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  const load = () => api(`/api/feedback/${id}`).then((x) => { setIt(x); setStatus(x.status); })
    .catch((e) => { toast(e.message, "err"); onClose(); });
  useEffect(() => { load(); }, [id]);
  if (!it) return html`<${Modal} title="Feedback" icon="comment" onClose=${onClose}><${Spinner} /></${Modal}>`;

  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message, "err"); }
    setBusy(false);
  };
  const post = () => run(async () => {
    await api(`/api/feedback/${id}/comments`, { method: "POST", body: { body: comment } });
    setComment("");
    setTimeout(() => end.current && end.current.scrollIntoView({ block: "nearest" }), 50);
  });
  const setSt = () => run(async () => { await api(`/api/feedback/${id}`, { method: "PUT", body: { status, note } }); setNote(""); },
    `Marked ${STATUS[status].label.toLowerCase()}`);
  const saveEdit = () => run(async () => { await api(`/api/feedback/${id}`, { method: "PUT", body: edit }); setEdit(null); }, "Saved");
  const del = async () => {
    if (!(await ask({ title: "Delete this report?", body: `"${it.title}" and its comments are removed for everyone.`, confirm: "Delete", danger: true }))) return;
    try { await api(`/api/feedback/${id}`, { method: "DELETE" }); toast("Deleted"); onClose(); } catch (e) { toast(e.message, "err"); }
  };
  const vote = () => run(() => api(`/api/feedback/${id}/vote`, { method: "POST", body: { on: !it.voted } }));
  const isReq = it.kind === "request";
  const req = it.request || {};
  const approve = async (extra = {}) => {
    setBusy(true);
    try {
      const r = await api(`/api/feedback/${id}/approve`, { method: "POST", body: { ...extra } });
      toast("Approved and done");
      if (r.warning) toast(r.warning, "warn");
      await load();
    } catch (e) {
      const c = e.status === 409 && e.data && e.data.confirm;
      const again = c === "protected" ? await ask({ title: "Change a protected port?", danger: true, confirm: "Change it anyway",
          body: html`<p>This port is protected:</p><ul>${e.data.reasons.map((x) => html`<li>${x}</li>`)}</ul><p>Changing it can cut off the switch or what's behind it.</p>` })
        : c === "profile" ? await ask({ title: "Detach port profile?", confirm: "Detach and apply",
          body: html`<p>This port uses the port profile <b>${e.data.profile}</b>. Approving detaches the profile from this port.</p>` })
        : c === "locked" ? await ask({ title: "Change a locked port?", confirm: "Change and keep locked",
          body: html`<p>This port is locked${e.data.note ? html` (<b>${e.data.note}</b>)` : ""}. It stays locked, to the new settings.</p>` })
        : (toast(e.message, "err"), false);
      setBusy(false);
      if (again) return approve({ ...extra, [{ protected: "confirm_protected", profile: "detach_profile", locked: "confirm_locked" }[c]]: true });
    }
    setBusy(false);
    return null;
  };
  const decline = async () => {
    const note = await askText({ title: "Decline this request?", confirm: "Decline", placeholder: "Why? (optional, the requester sees it)",
      body: html`<p>${it.title}</p>` });
    if (note === null) return;
    run(() => api(`/api/feedback/${id}/decline`, { method: "POST", body: { note } }), "Declined");
  };
  const st = { ...(STATUS[it.status] || STATUS.open), label: statusLabel(it) };
  const ctx = it.context && Object.entries(it.context).filter(([k, v]) => v && CONTEXT_LABEL[k]);

  return html`<${Modal} title=${html`<span class="fb-modal-title">#${it.id} · ${KIND[it.kind] ? KIND[it.kind].label : it.kind}</span>`} icon=${KIND[it.kind] ? KIND[it.kind].icon : "comment"} onClose=${onClose} wide>
    <div class="fb-item">
      <div class="fb-item-head">
        <span class=${`fb-status st-${it.status}`}><${Icon} name=${st.icon} size=${14} />${st.label}</span>
        ${!isReq && html`<button class=${"fb-vote big" + (it.voted ? " on" : "")} disabled=${!can.submit || busy} onClick=${vote}
          title=${it.voted ? "Take back your vote" : "I want this too"}><${Icon} name="vote" size=${16} /><b>${it.votes}</b>
          <span>${it.voted ? "You want this" : "Me too"}</span></button>`}
        ${it.github_url && html`<a class="btn sm ghost" href=${it.github_url} target="_blank" rel="noopener"><${Icon} name="external" size=${14} />GitHub</a>`}
        ${!it.github_url && can.github && can.manage && !isReq && html`<button class="btn sm ghost" disabled=${busy}
          onClick=${() => run(() => api(`/api/feedback/${id}/github`, { method: "POST" }), "Sent to GitHub")}><${Icon} name="upload" size=${14} />Send to GitHub</button>`}
        <span class="grow"></span>
        ${it.can_edit && !edit && html`<button class="btn sm ghost" onClick=${() => setEdit({ title: it.title, body: it.body, kind: it.kind })}><${Icon} name="pencil" size=${14} />Edit</button>`}
        ${it.can_delete && html`<button class="btn sm ghost danger-text" onClick=${del}><${Icon} name="trash" size=${14} />${isReq && it.mine ? "Withdraw" : "Delete"}</button>`}
      </div>
      ${edit ? html`<div class="form">
          <${Segmented} value=${edit.kind} onChange=${(v) => setEdit({ ...edit, kind: v })} options=${[{ value: "bug", label: "Bug" }, { value: "idea", label: "Idea" }]} />
          <${Field} label="Title"><input value=${edit.title} maxlength="140" onInput=${(e) => setEdit({ ...edit, title: e.target.value })} /></${Field}>
          <${Field} label="Details"><textarea class="fb-text" rows="5" value=${edit.body} onInput=${(e) => setEdit({ ...edit, body: e.target.value })}></textarea></${Field}>
          <div class="form-actions"><button class="btn" onClick=${() => setEdit(null)}>Cancel</button>
            <button class="btn primary" disabled=${busy} onClick=${saveEdit}>Save</button></div></div>`
        : html`<h3 class="fb-item-title">${it.title}</h3>
          <div class="fb-meta muted small"><${Avatar} user=${{ display_name: it.author.name, avatar: it.author.avatar }} size=${22} />
            <span><b>${it.mine ? "You" : it.author.name}</b> · ${when(it.created_at)}</span></div>
          ${isReq && html`<div class="fb-req">
            <div class="fb-ctx-grid">
              <span class="muted">Environment</span><span>${req.env}</span>
              <span class="muted">Device</span><span>${req.device}</span>
              ${req.port != null && html`<span class="muted">Port</span><span>${req.port}${req.port_name && req.port_name !== `Port ${req.port}` ? ` · ${req.port_name}` : ""}</span>`}
              ${req.type === "port" && html`<span class="muted">Change</span><span>${req.from} <span class="arrow">→</span> <b>${req.to}</b></span>`}
              ${req.type === "poe" && html`<span class="muted">Do</span><span>Power-cycle PoE${req.what ? ` (${req.what})` : ""}</span>`}
              ${req.type === "restart" && html`<span class="muted">Do</span><span>Restart the device</span>`}
            </div>
            ${(req.protected || req.locked) && html`<p class="warn-text small"><${Icon} name="shield" size=${13} /> This port is ${req.protected ? "protected" : "locked"}: approving asks you to confirm.</p>`}
            ${it.can_approve && html`<div class="fb-req-actions">
              <button class="btn primary" disabled=${busy} onClick=${() => approve()}><${Icon} name="check" size=${15} />Approve and do it</button>
              <button class="btn" disabled=${busy} onClick=${decline}><${Icon} name="x" size=${15} />Decline</button>
              <span class="muted small">Approving makes the change as you, and it's logged that way.</span></div>`}
            ${it.mine && it.status === "open" && html`<p class="muted small">Waiting for someone who can make this change.</p>`}
          </div>`}
          ${it.body ? html`<div class="fb-body">${isReq ? html`<span class="muted">Why: </span>` : ""}${it.body}</div>` : !isReq && html`<p class="muted small">No details.</p>`}`}
      ${it.image && html`<a class="fb-shot-full" href=${it.image} target="_blank" rel="noopener"><img src=${it.image} alt="Screenshot" /></a>`}
      ${ctx && ctx.length > 0 && html`<details class="fb-ctx"><summary>Technical details</summary>
        <div class="fb-ctx-grid">${ctx.map(([k, v]) => html`<span class="muted">${CONTEXT_LABEL[k]}</span><span>${v}</span>`)}</div></details>`}
      ${it.voters.length > 0 && html`<p class="muted small">Wanted by ${it.voters.join(", ")}.</p>`}

      ${can.manage && !isReq && html`<div class="fb-manage">
        <b>Status</b>
        <div class="fb-status-pick">${Object.entries(STATUS).map(([k, v]) => html`<button class=${`fb-status st-${k}` + (status === k ? " on" : "")}
          onClick=${() => setStatus(k)}><${Icon} name=${v.icon} size=${14} />${v.label}</button>`)}</div>
        ${status !== it.status && html`<div class="fb-status-go">
          <input placeholder="Add a note for the people following this (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} />
          <button class="btn primary" disabled=${busy} onClick=${setSt}>Mark ${STATUS[status].label.toLowerCase()}</button></div>`}
      </div>`}

      <h4 class="section">Activity</h4>
      <div class="fb-thread">
        ${it.comments_list.length === 0 && html`<p class="muted small">No comments yet.</p>`}
        ${it.comments_list.map((c) => c.event ? html`<div class="fb-event" key=${c.id}>
            <${Icon} name=${(STATUS[c.event.split(":")[1]] || {}).icon || "info"} size=${14} />
            <span><b>${c.author.name}</b> ${isReq ? html`<b>${{ done: "approved", wontfix: "declined" }[c.event.split(":")[1]] || c.event}</b> this` : html`marked this <b>${(STATUS[c.event.split(":")[1]] || {}).label || c.event}</b>`} · ${ago(c.created_at)}</span>
            ${c.body && html`<div class="fb-event-note">${c.body}</div>`}</div>`
          : html`<div class="fb-comment" key=${c.id}><${Avatar} user=${{ display_name: c.author.name, avatar: c.author.avatar }} size=${28} />
            <div class="fb-comment-main"><div class="fb-comment-head"><b>${c.author.name}</b><span class="muted small">${ago(c.created_at)}</span>
              ${c.can_delete && html`<button class="link-btn small" onClick=${() => run(() => api(`/api/feedback/${id}/comments/${c.id}`, { method: "DELETE" }))}>Delete</button>`}</div>
              <div class="fb-comment-body">${c.body}</div></div></div>`)}
        <div ref=${end}></div>
      </div>
      ${can.submit && html`<div class="fb-reply">
        <textarea rows="2" placeholder="Add a comment" value=${comment} onInput=${(e) => setComment(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && comment.trim()) post(); }}></textarea>
        <button class="btn primary" disabled=${busy || !comment.trim()} onClick=${post}>Comment</button></div>`}
    </div></${Modal}>`;
}

/** People below you, and which changes each may ask for (their abilities, without opening each person). */
function WhoCanRequest({ me, onClose }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => api("/api/users").then(setD).catch((e) => { toast(e.message, "err"); onClose(); });
  useEffect(() => { load(); }, []);
  const people = d ? d.users.filter((u) => u.id !== me.id && u.role !== "admin" && !u.disabled) : [];
  const roleCaps = (u) => ((d.roles.find((r) => r.key === u.role) || {}).caps || []);
  const toggle = async (u, cap, on) => {
    const grant = new Set(u.caps_grant), deny = new Set(u.caps_deny), inRole = roleCaps(u).includes(cap);
    if (on) { deny.delete(cap); if (!inRole) grant.add(cap); } else { grant.delete(cap); if (inRole) deny.add(cap); }
    setBusy(`${u.id}${cap}`);
    try {
      await api(`/api/users/${u.id}`, { method: "PUT", body: { caps_grant: [...grant], caps_deny: [...deny] } });
      await load();
    } catch (e) { toast(e.message, "err"); }
    setBusy(null);
  };
  return html`<${Modal} title="Who can request" icon="send" onClose=${onClose} wide>
    <p class="muted">Changes people can't make themselves, but may ask for. Someone who can make the change approves it on this board.
      These are abilities, so you'll also find them under each person's abilities and in roles.</p>
    ${!d ? html`<${Spinner} />` : people.length === 0 ? html`<p class="muted">Nobody below you yet.</p>` : html`
      <div class="who-grid" style=${`grid-template-columns: minmax(140px, 1fr) repeat(${REQUEST_CAPS.length}, auto)`}>
        <span></span>${REQUEST_CAPS.map(([, l]) => html`<b class="who-col small">${l}</b>`)}
        ${people.map((u) => html`
          <span class="who-name"><${Avatar} user=${u} size=${24} /><span><b>${u.display_name || u.username}</b><span class="muted small"> · ${u.role_name}</span></span></span>
          ${REQUEST_CAPS.map(([cap]) => html`<label class="who-cell"><input type="checkbox" checked=${u.caps.includes(cap)} disabled=${busy === `${u.id}${cap}`}
            onChange=${(e) => toggle(u, cap, e.target.checked)} /></label>`)}`)}
      </div>`}
  </${Modal}>`;
}
