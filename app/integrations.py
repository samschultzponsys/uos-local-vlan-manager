"""
Integrations (admins, Settings -> Integrations): GitHub and notifications.

GitHub
    One token (a fine-grained personal access token) for both:
    - the update check, so it also works once the repository is private
    - issue sync: bugs and ideas from the feedback board become issues; comments and status
      changes go both ways (Done / Won't do close the issue, closing it on GitHub marks it done).
      Change requests are never sent.

Notifications
    Any mix of email (SMTP), Microsoft Teams, Slack, Discord, Telegram and a plain JSON webhook,
    each with the events it wants: new bug / idea, new change request, status changes, comments.

Secrets (token, SMTP password, webhook URLs, the Telegram bot token) are stored in the DB like
the UniFi API keys and are never sent back to the browser.
"""

import html
import json
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage

import requests

import auth
import db
import feedback

GH_API = "https://api.github.com"
EVENTS = ("new", "request", "status", "comment")
EVENT_LABEL = {"new": "New bugs and ideas", "request": "New change requests", "status": "Status changes and approvals",
               "comment": "New comments"}
CHANNELS = ("email", "teams", "slack", "discord", "telegram", "webhook")
SECRET = {"github": ["token"], "email": ["password"], "teams": ["url"], "slack": ["url"], "discord": ["url"],
          "telegram": ["bot_token"], "webhook": ["url"]}
STATUS_LABEL = {"open": "Open", "planned": "Planned", "progress": "In progress", "done": "Done", "wontfix": "Won't do"}
REQ_STATUS = {"open": "Waiting for approval", "done": "Approved", "wontfix": "Declined"}
SYNC_EVERY = 600

DEFAULT = {
    "github": {"token": "", "update_repo": "", "sync": False, "repo": "", "kinds": ["bug", "idea"],
               "label": "feedback", "show_author": True, "show_context": False, "last_sync": 0},
    "email": {"enabled": False, "host": "", "port": 587, "security": "starttls", "username": "", "password": "",
              "sender": "", "to": "", "people": True, "events": ["new", "request", "status"]},
    "teams": {"enabled": False, "url": "", "events": ["new", "request", "status"]},
    "slack": {"enabled": False, "url": "", "events": ["new", "request", "status"]},
    "discord": {"enabled": False, "url": "", "events": ["new", "request", "status"]},
    "telegram": {"enabled": False, "bot_token": "", "chat_id": "", "events": ["new", "request", "status"]},
    "webhook": {"enabled": False, "url": "", "events": list(EVENTS)},
}


def config():
    stored = db.get_json("integrations", {})
    out = json.loads(json.dumps(DEFAULT))
    for k, v in stored.items():
        if k in out and isinstance(v, dict):
            out[k].update({x: y for x, y in v.items() if x in out[k]})
    return out


def public_config():
    """For the settings page: secrets become has_<name>."""
    c = config()
    for section, keys in SECRET.items():
        for k in keys:
            c[section][f"has_{k}"] = bool(c[section][k])
            c[section][k] = ""
    return c


def save(data):
    """Merge what the admin sent. An empty secret keeps the stored one; clear_<name> removes it."""
    c = config()
    for section, vals in (data or {}).items():
        if section not in c or not isinstance(vals, dict):
            continue
        cur = c[section]
        for k, v in vals.items():
            if k.startswith("clear_") and k[6:] in SECRET.get(section, []) and v:
                cur[k[6:]] = ""
            elif k in SECRET.get(section, []):
                if v:
                    cur[k] = str(v).strip()
            elif k in cur and k != "last_sync":
                cur[k] = _clean(section, k, v)
    db.set_json("integrations", c)
    return c


def _clean(section, k, v):
    if k in ("enabled", "sync", "show_author", "show_context", "people"):
        return bool(v)
    if k == "events":
        return [e for e in (v or []) if e in EVENTS]
    if k == "kinds":
        return [x for x in (v or []) if x in ("bug", "idea")]
    if k == "port":
        try:
            return max(1, min(65535, int(v)))
        except (TypeError, ValueError):
            raise ValueError("The SMTP port is a number, like 587")
    if k == "security":
        if v not in ("starttls", "ssl", "none"):
            raise ValueError("SMTP security: STARTTLS, SSL or none")
        return v
    if k in ("update_repo", "repo"):
        v = str(v or "").strip().strip("/")
        if v and (v.count("/") != 1 or " " in v):
            raise ValueError("A repository looks like owner/name")
        return v
    return str(v or "").strip()[:500]


# --- GitHub ------------------------------------------------------------------------------

def gh_token():
    return config()["github"]["token"]


def _gh(method, path, token=None, **kw):
    token = token if token is not None else gh_token()
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vlan-manager"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.request(method, GH_API + path, headers=headers, timeout=15, **kw)
    if r.status_code >= 400:
        try:
            msg = r.json().get("message") or r.text
        except ValueError:
            msg = r.text
        raise RuntimeError(f"GitHub {r.status_code}: {msg[:200]}")
    return r.json() if r.content else {}


def gh_test(repo, token=None):
    """What the token can do with a repository: {repo, private, push, issues}."""
    d = _gh("GET", f"/repos/{repo}", token=token)
    p = d.get("permissions") or {}
    return {"repo": d.get("full_name"), "private": bool(d.get("private")), "push": bool(p.get("push")),
            "issues": bool(d.get("has_issues")), "triage": bool(p.get("triage") or p.get("push"))}


def _issue_body(item, base, gh):
    lines = []
    if item.get("body"):
        lines += [item["body"], ""]
    if gh["show_author"]:
        lines.append(f"Reported by **{item.get('author') or 'someone'}** in the app.")
    if gh["show_context"]:
        ctx = json.loads(item.get("context") or "{}")
        if ctx:
            lines += ["", "<details><summary>Technical details</summary>", ""]
            lines += [f"- {k}: {v}" for k, v in ctx.items()]
            lines += ["", "</details>"]
    if item.get("image"):
        lines.append("A screenshot is attached to the item in the app.")
    if base:
        lines += ["", f"[Open in the app]({base}/?fb={item['id']})"]
    lines += ["", f"<!-- vlan-manager feedback #{item['id']} -->"]
    return "\n".join(lines)


def gh_push_item(item, base=""):
    """Create the issue for an item (once). Returns the issue URL, or None when sync is off."""
    gh = config()["github"]
    if not (gh["sync"] and gh["token"] and gh["repo"]) or item.get("kind") not in gh["kinds"]:
        return None
    if item.get("github_issue"):
        return item.get("github_url")
    labels = [{"bug": "bug", "idea": "enhancement"}[item["kind"]]] + ([gh["label"]] if gh["label"] else [])
    d = _gh("POST", f"/repos/{gh['repo']}/issues", json={"title": item["title"], "body": _issue_body(item, base, gh),
                                                         "labels": labels})
    conn = db.get()
    conn.execute("UPDATE feedback SET github_issue=?, github_url=? WHERE id=?", (d["number"], d["html_url"], item["id"]))
    conn.commit()
    if item.get("status") in ("done", "wontfix"):
        gh_push_status(dict(item, github_issue=d["number"]), "")
    return d["html_url"]


def gh_push_status(item, note):
    gh = config()["github"]
    if not (gh["sync"] and gh["token"] and gh["repo"] and item.get("github_issue")):
        return
    n = item["github_issue"]
    st = item["status"]
    if st in ("done", "wontfix"):
        _gh("PATCH", f"/repos/{gh['repo']}/issues/{n}",
            json={"state": "closed", "state_reason": "completed" if st == "done" else "not_planned"})
    else:
        _gh("PATCH", f"/repos/{gh['repo']}/issues/{n}", json={"state": "open"})
    text = f"Status in the app: **{STATUS_LABEL.get(st, st)}**" + (f"\n\n{note}" if note else "")
    c = _gh("POST", f"/repos/{gh['repo']}/issues/{n}/comments", json={"body": text})
    _remember_comment(c.get("id"))


def gh_push_comment(item, author, body, comment_id):
    gh = config()["github"]
    if not (gh["sync"] and gh["token"] and gh["repo"] and item.get("github_issue")):
        return
    who = f"**{author}** wrote in the app:\n\n" if gh["show_author"] else ""
    c = _gh("POST", f"/repos/{gh['repo']}/issues/{item['github_issue']}/comments", json={"body": who + body})
    if comment_id:
        conn = db.get()
        conn.execute("UPDATE feedback_comments SET github_id=? WHERE id=?", (c.get("id"), comment_id))
        conn.commit()
    _remember_comment(c.get("id"))


def _remember_comment(cid):
    """Comments the app posted itself, so the next pull doesn't import them back."""
    if not cid:
        return
    ours = db.get_json("github_own_comments", [])
    db.set_json("github_own_comments", (ours + [cid])[-500:])


def gh_pull():
    """Bring GitHub's side in: closed / reopened issues and new comments. Returns what changed."""
    c = config()
    gh = c["github"]
    if not (gh["sync"] and gh["token"] and gh["repo"]):
        return {"status": 0, "comments": 0}
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(max(0, (gh["last_sync"] or time.time()) - 120)))
    started = int(time.time())
    conn = db.get()
    by_issue = {r["github_issue"]: r for r in conn.execute("SELECT * FROM feedback WHERE github_issue > 0")}
    changed = {"status": 0, "comments": 0}
    issues = _gh("GET", f"/repos/{gh['repo']}/issues", params={"state": "all", "since": since, "per_page": 100})
    for i in issues:
        r = by_issue.get(i.get("number"))
        if not r or i.get("pull_request"):
            continue
        closed = i.get("state") == "closed"
        if closed and r["status"] not in ("done", "wontfix"):
            st = "wontfix" if i.get("state_reason") == "not_planned" else "done"
            feedback.github_status(r["id"], st, f"Closed on GitHub by {(i.get('closed_by') or {}).get('login', 'someone')}")
            changed["status"] += 1
        elif not closed and r["status"] in ("done", "wontfix"):
            feedback.github_status(r["id"], "open", "Reopened on GitHub")
            changed["status"] += 1
    ours = set(db.get_json("github_own_comments", []))
    known = {x[0] for x in conn.execute("SELECT github_id FROM feedback_comments WHERE github_id IS NOT NULL")}
    comments = _gh("GET", f"/repos/{gh['repo']}/issues/comments", params={"since": since, "per_page": 100})
    for cm in comments:
        if cm["id"] in ours or cm["id"] in known:
            continue
        num = int(str(cm.get("issue_url", "")).rsplit("/", 1)[-1] or 0)
        r = by_issue.get(num)
        if not r:
            continue
        login = (cm.get("user") or {}).get("login", "someone")
        feedback.github_comment(r["id"], f"{login} (GitHub)", cm.get("body") or "", cm["id"])
        changed["comments"] += 1
    c = config()
    c["github"]["last_sync"] = started
    db.set_json("integrations", c)
    return changed


def _sync_loop():
    time.sleep(45)
    while True:
        try:
            if config()["github"]["sync"]:
                gh_pull()
        except Exception as e:   # never let the loop die
            print(f"[github-sync] {e}", flush=True)
        finally:
            db.close()
        time.sleep(SYNC_EVERY)


def start_sync():
    threading.Thread(target=_sync_loop, daemon=True, name="github-sync").start()


# --- notifications --------------------------------------------------------------------------

def _message(event, item, actor, base):
    """(title, text, url) for an event."""
    kind = {"bug": "Bug", "idea": "Idea", "request": "Change request"}.get(item.get("kind"), "Feedback")
    num = f"#{item.get('id')}"
    who = actor or "someone"
    status = (REQ_STATUS if item.get("kind") == "request" else STATUS_LABEL).get(item.get("status"), item.get("status"))
    if event in ("new", "request"):
        title = f"{kind} {num}: {item.get('title')}"
        text = f"{who} posted a {kind.lower()}." + (f"\n\n{item.get('body')}" if item.get("body") else "")
    elif event == "status":
        title = f"{kind} {num} is now {status}: {item.get('title')}"
        text = f"{who} changed it to {status}." + (f"\n\n{item.get('note')}" if item.get("note") else "")
    elif event == "comment":
        title = f"New comment on {kind.lower()} {num}: {item.get('title')}"
        text = f"{who}: {item.get('comment') or ''}"
    else:
        title, text = f"{kind} {num}: {item.get('title')}", ""
    url = f"{base}/?fb={item.get('id')}" if base else ""
    return title, text[:1500], url


def _post(url, payload):
    r = requests.post(url, json=payload, timeout=10)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")


def send_teams(cfg, title, text, url):
    card = {"type": "AdaptiveCard", "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "version": "1.4",
            "body": [{"type": "TextBlock", "text": title, "weight": "Bolder", "size": "Medium", "wrap": True},
                     {"type": "TextBlock", "text": text, "wrap": True}],
            "actions": [{"type": "Action.OpenUrl", "title": "Open", "url": url}] if url else []}
    _post(cfg["url"], {"type": "message", "attachments": [
        {"contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": None, "content": card}]})


def send_slack(cfg, title, text, url):
    head = f"*<{url}|{title}>*" if url else f"*{title}*"
    _post(cfg["url"], {"text": f"{title}\n{text}", "blocks": [
        {"type": "section", "text": {"type": "mrkdwn", "text": f"{head}\n{text}"}}]})


def send_discord(cfg, title, text, url):
    _post(cfg["url"], {"embeds": [{"title": title[:256], "description": text[:4000], "url": url or None, "color": 0x4F8CFF}]})


def send_telegram(cfg, title, text, url):
    body = f"<b>{html.escape(title)}</b>\n{html.escape(text)}" + (f'\n<a href="{html.escape(url)}">Open</a>' if url else "")
    r = requests.post(f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage", timeout=10,
                      json={"chat_id": cfg["chat_id"], "text": body, "parse_mode": "HTML", "disable_web_page_preview": True})
    if r.status_code >= 400:
        raise RuntimeError(f"Telegram {r.status_code}: {r.text[:200]}")


def send_webhook(cfg, title, text, url, event=None, item=None):
    _post(cfg["url"], {"event": event, "title": title, "text": text, "url": url,
                       "item": {k: (item or {}).get(k) for k in ("id", "kind", "title", "status", "author")}})


def send_email(cfg, title, text, url, to=None):
    rcpt = [a.strip() for a in (to if to is not None else cfg["to"]).replace(";", ",").split(",") if a.strip()]
    if not rcpt:
        return
    msg = EmailMessage()
    msg["Subject"] = title
    msg["From"] = cfg["sender"] or cfg["username"]
    msg["To"] = ", ".join(rcpt)
    msg.set_content(text + (f"\n\nOpen: {url}" if url else ""))
    msg.add_alternative(
        f"<h3 style='margin:0 0 8px'>{html.escape(title)}</h3><p style='white-space:pre-wrap'>{html.escape(text)}</p>"
        + (f"<p><a href='{html.escape(url)}'>Open in the app</a></p>" if url else ""), subtype="html")
    if cfg["security"] == "ssl":
        s = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15, context=ssl.create_default_context())
    else:
        s = smtplib.SMTP(cfg["host"], cfg["port"], timeout=15)
        if cfg["security"] == "starttls":
            s.starttls(context=ssl.create_default_context())
    try:
        if cfg["username"]:
            s.login(cfg["username"], cfg["password"])
        s.send_message(msg)
    finally:
        s.quit()


SENDERS = {"teams": send_teams, "slack": send_slack, "discord": send_discord, "telegram": send_telegram}


def _ready(name, cfg):
    need = {"email": ("host",), "teams": ("url",), "slack": ("url",), "discord": ("url",),
            "telegram": ("bot_token", "chat_id"), "webhook": ("url",)}[name]
    return all(cfg.get(k) for k in need)


def send_test(name, overrides=None):
    """Send a test message through one channel (with the unsaved settings on the page). Raises on failure."""
    cfg = dict(config()[name])
    for k, v in (overrides or {}).items():
        if k in cfg and (v or k not in SECRET.get(name, [])):
            cfg[k] = _clean(name, k, v) if k not in SECRET.get(name, []) else str(v).strip()
    if not _ready(name, cfg):
        raise ValueError("Fill in the settings first")
    title = f"Test from {db.get_setting('app_name') or 'VLAN Manager'}"
    text = "If you can read this, notifications work."
    if name == "email":
        send_email(cfg, title, text, "")
    elif name == "webhook":
        send_webhook(cfg, title, text, "", "test", {})
    else:
        SENDERS[name](cfg, title, text, "")


def notify(event, item, actor, base, people=()):
    """Send an event to every channel that wants it (in the background). `people` are emails of those involved."""
    c = config()
    app_name = db.get_setting("app_name") or "VLAN Manager"
    title, text, url = _message(event, item, actor, base)
    title = f"[{app_name}] {title}"
    jobs = []
    for name in CHANNELS:
        cfg = c[name]
        if not (cfg.get("enabled") and event in cfg.get("events", []) and _ready(name, cfg)):
            continue
        if name == "email":
            jobs.append((name, lambda cfg=cfg: send_email(cfg, title, text, url)))
        elif name == "webhook":
            jobs.append((name, lambda cfg=cfg: send_webhook(cfg, title, text, url, event, item)))
        else:
            jobs.append((name, lambda cfg=cfg, f=SENDERS[name]: f(cfg, title, text, url)))
    em = c["email"]
    if em.get("enabled") and em.get("people") and _ready("email", em) and event in ("status", "comment"):
        rcpt = ", ".join(p for p in people if p and p.lower() not in em["to"].lower())
        if rcpt:
            jobs.append(("email", lambda: send_email(em, title, text, url, to=rcpt)))
    if jobs:
        threading.Thread(target=_run, args=(jobs,), daemon=True).start()


def _run(jobs):
    for name, fn in jobs:
        try:
            fn()
        except Exception as e:
            print(f"[notify] {name}: {e}", flush=True)


# --- feedback events -> GitHub and notifications ------------------------------------------------

_last_base = ""


def on_feedback(event, item, u):
    """feedback.listeners hook: runs in the request; the network calls go to a background thread."""
    global _last_base
    try:
        base = _last_base = auth.external_base()
    except RuntimeError:   # outside a request (the GitHub sync loop): the address people last used
        base = _last_base
    actor = u.get("display_name") or u.get("username") or "someone"
    people = feedback.follower_emails(item["id"], u.get("id"))
    item = {**item, "note": u.get("note"), "comment": u.get("comment"), "author": item.get("author")}
    from_github = bool(u.get("github"))

    def work():
        try:
            if not from_github and item.get("kind") != "request":
                if event == "new":
                    gh_push_item(item, base)
                elif event == "status":
                    gh_push_status(dict(item, **_fresh(item["id"])), u.get("note") or "")
                elif event == "comment":
                    gh_push_comment(dict(item, **_fresh(item["id"])), actor, u.get("comment") or "", u.get("comment_id"))
        except Exception as e:
            print(f"[github] {event} #{item.get('id')}: {e}", flush=True)
        finally:
            db.close()
    threading.Thread(target=work, daemon=True).start()
    notify("request" if event == "request" else event, item, actor, base, people)


def _fresh(item_id):
    r = db.get().execute("SELECT github_issue, github_url, status FROM feedback WHERE id=?", (item_id,)).fetchone()
    return dict(r) if r else {}


def update_source():
    """(repository, token) for the update check."""
    gh = config()["github"]
    return gh["update_repo"] or None, gh["token"] or None
