"""
Achievements: badges people earn by using the app.

Almost all of them are worked out from what the app already keeps - the activity log, feedback,
a person's display settings and the days they've used the app - so existing people get credit for
what they did before this existed. `evaluate` is cheap and runs with /api/me; anything newly earned
is stored with the time it was noticed and reported once, so the browser can celebrate it.

Each achievement: key, name, what to do, icon, tier (bronze / silver / gold / platinum), group, and
optionally the ability someone needs to be able to earn it (others don't see it unless they have it).
"""

import json
from datetime import datetime

import auth
import db
import perms

GROUPS = ["Getting started", "Make it yours", "Ports", "Devices", "Feedback", "People & admin", "Regulars", "Secrets"]

# key, name, how, icon, tier, group, needs (ability), goal (for counted ones)
CATALOG = [
    ("hello", "Hello, world", "Sign in for the first time.", "login", "bronze", "Getting started", None, None),
    ("setup", "Made it yours", "Finish setting up your view.", "sparkle", "bronze", "Getting started", None, None),
    ("tour", "Tour guide", "Take the guided tour to the end.", "target", "bronze", "Getting started", None, None),
    ("own_password", "Own key", "Choose your own password.", "key", "bronze", "Getting started", None, None),
    ("avatar", "Say cheese", "Add a profile picture.", "user", "bronze", "Getting started", None, None),
    ("sso", "One login to rule them all", "Sign in with single sign-on.", "shield", "silver", "Getting started", None, None),
    ("token", "Pocket pass", "Make a sign-in link for a phone or tablet.", "link", "silver", "Getting started", None, None),

    ("daylight", "Daylight", "Switch to the light theme.", "sun", "bronze", "Make it yours", None, None),
    ("painter", "Painter", "Give a network your own color.", "palette", "bronze", "Make it yours", None, None),
    ("designer", "Interior designer", "Change what network bubbles show in Display options.", "sliders", "bronze", "Make it yours", None, None),
    ("zoom", "Zoom zoom", "Set your own scale for a screen.", "eye", "bronze", "Make it yours", None, None),
    ("curator", "Curator", "Choose exactly which devices you see.", "grid", "bronze", "Make it yours", None, None),
    ("mood", "Mood lighting", "Change how ports glow.", "bulb", "bronze", "Make it yours", None, None),
    ("home_base", "Home base", "Pick a different start page.", "server", "bronze", "Make it yours", None, None),
    ("matchmaker", "Matchmaker", "Match VLAN colors across environments.", "merge", "silver", "Make it yours", None, None),

    ("first_patch", "First patch", "Change a port's VLAN.", "plug", "bronze", "Ports", "ports.change", 1),
    ("patch_panel", "Patch panel", "Change 10 ports.", "plug", "silver", "Ports", "ports.change", 10),
    ("cable_wrangler", "Cable wrangler", "Change 50 ports.", "plug", "gold", "Ports", "ports.change", 50),
    ("architect", "Network architect", "Change 250 ports.", "layers", "platinum", "Ports", "ports.change", 250),
    ("many_hands", "Many hands", "Change several ports at once.", "check", "bronze", "Ports", "ports.change", None),
    ("migration", "The great migration", "Change 10 or more ports in one go.", "uplink", "gold", "Ports", "ports.change", None),
    ("trunk", "Trunk call", "Set a port to tag every network (Allow All).", "trunk", "silver", "Ports", "ports.change", None),
    ("hand_picked", "Hand-picked", "Choose exactly which networks a port tags (Custom).", "trunksome", "silver", "Ports", "ports.change", None),
    ("brave", "Fearless", "Change a protected port.", "shield", "gold", "Ports", "ports.protected", None),
    ("ctrl_z", "Ctrl+Z", "Undo a port change from Activity.", "refresh", "silver", "Ports", "ports.change", None),
    ("locksmith", "Locksmith", "Lock a port.", "lock", "silver", "Ports", "ports.lock", None),
    ("name_tag", "Name tag", "Name a port.", "pencil", "bronze", "Ports", "devices.manage", None),

    ("off_on", "Have you tried turning it off and on?", "Power-cycle a PoE port.", "power", "bronze", "Devices", "ports.poe", None),
    ("poe_master", "Power broker", "Power-cycle 10 PoE ports.", "bolt", "gold", "Devices", "ports.poe", 10),
    ("reboot", "Reboot", "Restart a device.", "power", "silver", "Devices", "devices.manage", None),
    ("marco_polo", "Marco Polo", "Blink a device's locate light.", "target", "bronze", "Devices", "devices.manage", None),
    ("rename_device", "Christening", "Rename a device.", "pencil", "bronze", "Devices", "devices.manage", None),
    ("firmware", "Fresh firmware", "Start a firmware update.", "upgrade", "silver", "Devices", "devices.manage", None),

    ("squeaky_wheel", "Squeaky wheel", "Post something on the feedback board.", "comment", "bronze", "Feedback", "feedback.submit", None),
    ("bug_hunter", "Bug hunter", "Report 5 bugs.", "bug", "silver", "Feedback", "feedback.submit", 5),
    ("ideas", "Ideas person", "Suggest an idea.", "bulb", "bronze", "Feedback", "feedback.submit", None),
    ("shipped", "Shipped!", "Have one of your ideas marked done.", "sparkle", "gold", "Feedback", "feedback.submit", None),
    ("exterminator", "Exterminator", "Have one of your bug reports fixed.", "check", "gold", "Feedback", "feedback.submit", None),
    ("crowd_favorite", "Crowd favorite", "Get 5 votes on something you posted.", "vote", "gold", "Feedback", "feedback.submit", 5),
    ("democracy", "Democracy", "Vote for 10 things other people posted.", "vote", "silver", "Feedback", "feedback.submit", 10),
    ("conversationalist", "Conversationalist", "Write 10 comments.", "comment", "silver", "Feedback", "feedback.submit", 10),
    ("please", "Please and thank you", "Send a change request.", "send", "bronze", "Feedback", None, None),
    ("approved", "Approved", "Have a change request approved.", "check", "silver", "Feedback", None, None),
    ("gatekeeper", "Gatekeeper", "Approve 5 change requests.", "shield", "gold", "Feedback", "ports.change", 5),
    ("triage", "Triage nurse", "Set the status of 10 feedback items.", "inbox", "gold", "Feedback", "feedback.manage", 10),

    ("explorer", "Explorer", "Add an environment.", "globe", "silver", "People & admin", "envs.manage", None),
    ("team_builder", "Team builder", "Add 5 people.", "users", "silver", "People & admin", "users.create", 5),
    ("role_model", "Role model", "Create or change a role.", "shield", "silver", "People & admin", "roles.manage", None),
    ("in_their_shoes", "In their shoes", "View the app as someone else.", "eye", "silver", "People & admin", "users.view_as", None),
    ("better_together", "Better together", "Merge two accounts.", "merge", "gold", "People & admin", "system.manage", None),
    ("brand_new", "Brand new", "Change the app's name or logo.", "palette", "silver", "People & admin", "settings.manage", None),
    ("connected", "Connected", "Set up GitHub or notifications.", "link", "gold", "People & admin", "system.manage", None),
    ("spring_cleaning", "Spring cleaning", "Choose how long activity is kept.", "clock", "bronze", "People & admin", "system.manage", None),

    ("regular", "Regular", "Use the app on 7 different days.", "clock", "bronze", "Regulars", None, 7),
    ("fixture", "Part of the furniture", "Use the app on 30 different days.", "clock", "silver", "Regulars", None, 30),
    ("veteran", "Veteran", "Use the app on 100 different days.", "clock", "gold", "Regulars", None, 100),
    ("founding", "Founding member", "Be one of the first 10 people here.", "sparkle", "gold", "Regulars", None, None),
    ("collector", "Collector", "Earn 20 achievements.", "layers", "gold", "Regulars", None, 20),
    ("completionist", "Completionist", "Earn 40 achievements.", "sparkle", "platinum", "Regulars", None, 40),
]
# secret ones: "???" until earned. Times use the server's clock, so set TZ in compose to your timezone.
SECRETS = [
    ("indecisive", "Indecisive", "Changed the same port 3 times within 10 minutes.", "refresh", "bronze", "ports.change"),
    ("boomerang", "Boomerang", "Changed a port and put it back exactly as it was within 5 minutes.", "uplink", "silver", "ports.change"),
    ("undo_undo", "Undo the undo", "Undid an undo.", "refresh", "silver", "ports.change"),
    ("again_and_again", "Have you tried turning it off and on again... and again?", "Power-cycled the same port 3 times in 10 minutes.", "power", "silver", "ports.poe"),
    ("blink_twice", "Blink twice if you need help", "Blinked the same device's locate light 5 times in a day.", "target", "silver", "devices.manage"),
    ("lights_out", "Lights out", "Turned a device's status light off.", "moon", "bronze", "devices.manage"),
    ("friday_deploy", "Friday deploy", "Changed a port on a Friday after 4 pm.", "alert", "gold", "ports.change"),
    ("night_shift", "Night shift", "Changed a port between 1 and 5 am.", "moon", "gold", "ports.change"),
    ("weekend_warrior", "Weekend warrior", "Changed a port on a Saturday or Sunday.", "sun", "silver", "ports.change"),
    ("vlan1", "VLAN 1 is not a strategy", "Put a port back on the Default network.", "layers", "bronze", "ports.change"),
    ("answer42", "The answer to everything", "Changed port 42, or put a port on VLAN 42.", "sparkle", "gold", "ports.change"),
    ("too_many_cooks", "Too many cooks", "Third person to change the same port on the same day.", "users", "silver", "ports.change"),
    ("rubber_stamp", "Rubber stamp", "Approved a change request within a minute of it arriving.", "check", "silver", "ports.change"),
    ("always_dns", "It's always DNS", "Reported a bug with DNS in the title.", "globe", "bronze", "feedback.submit"),
    ("cobbler", "The cobbler's children", "Reported a bug about the feedback board itself.", "bug", "silver", "feedback.submit"),
    ("patient_zero", "Patient zero", "Reported the very first bug that got fixed.", "bug", "gold", "feedback.submit"),
    ("rainbow_road", "Rainbow road", "Gave 7 different networks your own colors.", "palette", "silver", None),
    ("ghost_whisperer", "Ghost whisperer", "Viewed the app as someone who had never signed in.", "eye", "silver", "users.view_as"),
    ("welcome_back", "Welcome back", "Came back after 30 days or more away.", "login", "silver", None),
    ("konami", "Up, up, down, down...", "Entered the Konami code.", "sparkle", "gold", None),
    ("disco", "Disco", "Flipped between day and night 10 times in a minute.", "sun", "silver", None),
    ("hypnotized", "Hypnotized", "Kept the glowing ports open for 8 hours straight.", "eye", "gold", None),
    ("speedrun", "Speedrun", "Finished the setup in under 20 seconds.", "clock", "gold", None),
    ("tourist", "Tourist", "Took the guided tour 3 times.", "target", "bronze", None),
    ("secret_agent", "Secret agent", "Found every other secret achievement.", "key", "platinum", None),
]
SECRET_KEYS = {x[0] for x in SECRETS}
CATALOG += [(k, n, h, i, t, "Secrets", needs, None) for k, n, h, i, t, needs in SECRETS]
# things only the browser sees, reported to /api/achievements/event (counted per person)
EVENTS = {"konami": 1, "disco": 1, "hypnotized": 1, "speedrun": 1, "tour": 3}
BY_KEY = {a[0]: a for a in CATALOG}
TIERS = ("bronze", "silver", "gold", "platinum")


def enabled():
    return db.get_setting("achievements", "1") != "0"


def _counts(conn, username):
    """{action: count} of this person's own successful actions (not ones done while viewing as them)."""
    rows = conn.execute("SELECT action, COUNT(*) FROM audit WHERE username=? AND ok=1 GROUP BY action", (username,))
    return {r[0]: r[1] for r in rows}


def progress(user_row):
    """{key: (have, goal)} for everything, from what the app already knows about this person."""
    conn = db.get()
    uid, name = user_row["id"], user_row["username"]
    c = _counts(conn, name)
    prefs = json.loads(user_row["prefs"] or "{}")
    pv, lg = prefs.get("ports_view") or {}, prefs.get("legend") or {}

    def details(action, where=""):
        return [json.loads(r[0] or "{}") for r in conn.execute(
            f"SELECT detail FROM audit WHERE username=? AND ok=1 AND action=? {where}", (name, action))]

    port_sets = c.get("port.set", 0)
    sets = details("port.set") if port_sets else []
    bulk_runs = {}
    for r in conn.execute("SELECT ts, COUNT(*) FROM audit WHERE username=? AND ok=1 AND action='port.set' "
                          "AND detail LIKE '%\"bulk\": true%' GROUP BY ts", (name,)):
        bulk_runs[r[0]] = r[1]
    port_settings = details("port.settings") if c.get("port.settings") else []
    dev_updates = details("device.updated") if c.get("device.updated") else []

    mine = conn.execute("SELECT kind, status, id FROM feedback WHERE user_id=?", (uid,)).fetchall()
    votes_on_mine = conn.execute("SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM feedback_votes v JOIN feedback f ON f.id=v.item_id "
                                 "WHERE f.user_id=? GROUP BY v.item_id)", (uid,)).fetchone()[0] or 0
    votes_given = conn.execute("SELECT COUNT(*) FROM feedback_votes v JOIN feedback f ON f.id=v.item_id "
                               "WHERE v.user_id=? AND (f.user_id IS NULL OR f.user_id!=?)", (uid, uid)).fetchone()[0]
    comments = conn.execute("SELECT COUNT(*) FROM feedback_comments WHERE user_id=? AND event=''", (uid,)).fetchone()[0]
    statuses = conn.execute("SELECT COUNT(*) FROM feedback_comments f JOIN feedback i ON i.id=f.item_id "
                            "WHERE f.user_id=? AND f.event!='' AND i.kind!='request'", (uid,)).fetchone()[0]
    days = conn.execute("SELECT COUNT(*) FROM user_days WHERE user_id=?", (uid,)).fetchone()[0]
    rank = conn.execute("SELECT COUNT(*) FROM users WHERE id<=?", (uid,)).fetchone()[0]
    tokens = conn.execute("SELECT COUNT(*) FROM api_tokens WHERE user_id=?", (uid,)).fetchone()[0]

    one = lambda ok: (1 if ok else 0, 1)   # noqa: E731
    p = {
        "hello": one(user_row["last_login"]),
        "setup": one(prefs.get("setup_done")),
        "tour": one(prefs.get("tour_done")),
        "own_password": one(c.get("user.password_changed")),
        "avatar": one(user_row["avatar_version"]),
        "sso": one(user_row["oidc_sub"]),
        "token": one(tokens or c.get("token.created")),
        "daylight": one(prefs.get("theme") == "light"),
        "painter": one(prefs.get("vlan_colors") or prefs.get("shared_colors")),
        "designer": one(any(lg.get(k) not in (None, d) for k, d in
                            (("vlan", "always"), ("ports", "always"), ("clients", "hover"), ("ip", "hover"), ("layout", "wrap"),
                             ("ip_format", "subnet"), ("sort", "vlan"), ("hide_unused", False)))),
        "zoom": one(prefs.get("scales")),
        "curator": one(prefs.get("devices")),
        "mood": one(pv.get("fx") not in (None, "pulse")),
        "home_base": one(pv.get("start") in ("feedback",) or (pv.get("overview") and pv.get("start") == "env")),
        "matchmaker": one(prefs.get("color_sync") in ("vlan", "name")),
        "first_patch": (min(port_sets, 1), 1), "patch_panel": (min(port_sets, 10), 10),
        "cable_wrangler": (min(port_sets, 50), 50), "architect": (min(port_sets, 250), 250),
        "many_hands": one(bulk_runs),
        "migration": one(any(n >= 10 for n in bulk_runs.values())),
        "trunk": one(any((d.get("after") or {}).get("tagged") == "Allow All" for d in sets)),
        "hand_picked": one(any((d.get("after") or {}).get("tagged") == "Custom" for d in sets)),
        "brave": one(any(d.get("protected") for d in sets)),
        "ctrl_z": one(c.get("port.undo")),
        "locksmith": one(c.get("port.locked")),
        "name_tag": one(any("name" in (d.get("after") or {}) for d in port_settings)),
        "off_on": one(c.get("port.power_cycle")),
        "poe_master": (min(c.get("port.power_cycle", 0), 10), 10),
        "reboot": one(c.get("device.restart")),
        "marco_polo": one(c.get("device.locate")),
        "rename_device": one(any("name" in (d.get("after") or {}) for d in dev_updates)),
        "firmware": one(c.get("device.upgrade")),
        "squeaky_wheel": one(any(m["kind"] != "request" for m in mine)),
        "bug_hunter": (min(sum(1 for m in mine if m["kind"] == "bug"), 5), 5),
        "ideas": one(any(m["kind"] == "idea" for m in mine)),
        "shipped": one(any(m["kind"] == "idea" and m["status"] == "done" for m in mine)),
        "exterminator": one(any(m["kind"] == "bug" and m["status"] == "done" for m in mine)),
        "crowd_favorite": (min(votes_on_mine, 5), 5),
        "democracy": (min(votes_given, 10), 10),
        "conversationalist": (min(comments, 10), 10),
        "please": one(any(m["kind"] == "request" for m in mine)),
        "approved": one(any(m["kind"] == "request" and m["status"] == "done" for m in mine)),
        "gatekeeper": (min(c.get("request.approved", 0), 5), 5),
        "triage": (min(statuses, 10), 10),
        "explorer": one(c.get("env.created")),
        "team_builder": (min(c.get("user.created", 0), 5), 5),
        "role_model": one(c.get("role.created") or c.get("role.updated")),
        "in_their_shoes": one(c.get("user.impersonate")),
        "better_together": one(c.get("user.merged")),
        "brand_new": one(c.get("settings.brand")),
        "connected": one(c.get("settings.integrations")),
        "spring_cleaning": one(c.get("settings.audit_retention")),
        "regular": (min(days, 7), 7), "fixture": (min(days, 30), 30), "veteran": (min(days, 100), 100),
        "founding": one(rank <= 10),
    }
    p.update(_secrets(conn, user_row, name, c, sets, prefs, mine))
    return p


def _local(ts):
    return datetime.fromtimestamp(ts)


def _within(times, n, secs):
    """Are there n of these times within `secs` of each other?"""
    times = sorted(times)
    return any(times[i + n - 1] - times[i] <= secs for i in range(len(times) - n + 1))


def _secrets(conn, row, name, c, sets, prefs, mine):
    uid = row["id"]
    one = lambda ok: (1 if ok else 0, 1)   # noqa: E731
    rows = conn.execute("SELECT id, ts, target, detail FROM audit WHERE username=? AND ok=1 AND action='port.set' ORDER BY ts",
                        (name,)).fetchall() if c.get("port.set") else []
    by_port = {}
    for r in rows:
        by_port.setdefault(r["target"], []).append((r["ts"], json.loads(r["detail"] or "{}")))
    boomerang = False
    for changes in by_port.values():
        for (t1, d1), (t2, d2) in zip(changes, changes[1:]):
            b1, a2 = d1.get("before") or {}, d2.get("after") or {}
            if t2 - t1 <= 300 and b1.get("native") and (b1.get("native"), b1.get("tagged")) == (a2.get("native"), a2.get("tagged")):
                boomerang = True
    stamps = [_local(r["ts"]) for r in rows]
    afters = [(json.loads(r["detail"] or "{}").get("after") or {}) for r in rows]

    undo_undo = False
    if c.get("port.undo"):
        for r in conn.execute("SELECT detail FROM audit WHERE username=? AND ok=1 AND action='port.undo'", (name,)):
            of = json.loads(r["detail"] or "{}").get("undo_of")
            if of and conn.execute("SELECT 1 FROM audit WHERE id=? AND action='port.undo'", (of,)).fetchone():
                undo_undo = True

    def grouped(action):
        g = {}
        for r in conn.execute("SELECT ts, target FROM audit WHERE username=? AND ok=1 AND action=?", (name, action)):
            g.setdefault(r["target"], []).append(r["ts"])
        return g

    cycles = grouped("port.power_cycle") if c.get("port.power_cycle") else {}
    blinks = grouped("device.locate") if c.get("device.locate") else {}
    blink_days = any(max([sum(1 for t in ts if _local(t).date() == d) for d in {_local(t).date() for t in ts}] or [0]) >= 5
                     for ts in blinks.values())
    lights_out = c.get("device.updated") and any(json.loads(r[0] or "{}").get("led") == "off" for r in conn.execute(
        "SELECT detail FROM audit WHERE username=? AND ok=1 AND action='device.updated'", (name,)))

    cooks = False
    for target in by_port:
        mine_days = {_local(t).date() for t, _ in by_port[target]}
        others = conn.execute("SELECT username, ts FROM audit WHERE action='port.set' AND ok=1 AND target=? ORDER BY ts", (target,)).fetchall()
        for day in mine_days:
            order = []
            for o in others:
                if _local(o["ts"]).date() == day and o["username"].split(" (as ")[0] not in order:
                    order.append(o["username"].split(" (as ")[0])
            if name in order[2:]:
                cooks = True

    stamp = False
    if c.get("request.approved"):
        for r in conn.execute("SELECT ts, target FROM audit WHERE username=? AND ok=1 AND action='request.approved'", (name,)):
            item = conn.execute("SELECT created_at FROM feedback WHERE id=?", (int(str(r["target"]).lstrip("#") or 0),)).fetchone()
            if item and r["ts"] - item["created_at"] <= 60:
                stamp = True

    titles = conn.execute("SELECT kind, title, body FROM feedback WHERE user_id=?", (uid,)).fetchall()
    first_fixed = conn.execute("SELECT user_id FROM feedback WHERE kind='bug' AND status='done' AND closed_at>0 "
                               "ORDER BY closed_at, id LIMIT 1").fetchone()

    ghost = False
    if c.get("user.impersonate"):
        for r in conn.execute("SELECT ts, target FROM audit WHERE username=? AND ok=1 AND action='user.impersonate'", (name,)):
            t = conn.execute("SELECT id, last_login FROM users WHERE username=?", (r["target"],)).fetchone()
            if t and (not t["last_login"] or not conn.execute(
                    "SELECT 1 FROM user_days WHERE user_id=? AND day<=date(?, 'unixepoch', 'localtime')", (t["id"], r["ts"])).fetchone()):
                ghost = ghost or not t["last_login"] or t["last_login"] > r["ts"]

    days = [datetime.strptime(r[0], "%Y-%m-%d").date() for r in conn.execute(
        "SELECT day FROM user_days WHERE user_id=? ORDER BY day", (uid,))]
    events = {r[0]: r[1] for r in conn.execute("SELECT event, n FROM user_events WHERE user_id=?", (uid,))}
    colors = len(prefs.get("vlan_colors") or {}) + len(prefs.get("shared_colors") or {})

    return {
        "indecisive": one(any(_within([t for t, _ in ch], 3, 600) for ch in by_port.values())),
        "boomerang": one(boomerang),
        "undo_undo": one(undo_undo),
        "again_and_again": one(any(_within(ts, 3, 600) for ts in cycles.values())),
        "blink_twice": one(blink_days),
        "lights_out": one(lights_out),
        "friday_deploy": one(any(d.weekday() == 4 and d.hour >= 16 for d in stamps)),
        "night_shift": one(any(1 <= d.hour < 5 for d in stamps)),
        "weekend_warrior": one(any(d.weekday() >= 5 for d in stamps)),
        "vlan1": one(any(str(a.get("native", "")).endswith("(1)") for a in afters)),
        "answer42": one(any(t.endswith("/ port 42") for t in by_port) or any(str(a.get("native", "")).endswith("(42)") for a in afters)),
        "too_many_cooks": one(cooks),
        "rubber_stamp": one(stamp),
        "always_dns": one(any(t["kind"] == "bug" and "dns" in (t["title"] or "").lower() for t in titles)),
        "cobbler": one(any(t["kind"] == "bug" and "feedback" in f"{t['title']} {t['body']}".lower() for t in titles)),
        "patient_zero": one(first_fixed and first_fixed["user_id"] == uid),
        "rainbow_road": (min(colors, 7), 7),
        "ghost_whisperer": one(ghost),
        "welcome_back": one(any((b - a).days >= 30 for a, b in zip(days, days[1:]))),
        "konami": one(events.get("konami")), "disco": one(events.get("disco")),
        "hypnotized": one(events.get("hypnotized")), "speedrun": one(events.get("speedrun")),
        "tourist": (min(events.get("tour", 0), 3), 3),
    }


def earned(uid):
    return {r["key"]: r["earned_at"] for r in db.get().execute(
        "SELECT key, earned_at FROM user_achievements WHERE user_id=?", (uid,))}


def evaluate(user_row):
    """Store anything newly earned; returns the keys earned just now."""
    conn = db.get()
    have = earned(user_row["id"])
    prog = progress(user_row)
    new = [k for k, (n, goal) in prog.items() if n >= goal and k not in have]
    total = len(have) + len(new)
    for k, goal in (("collector", 20), ("completionist", 40)):
        if total >= goal and k not in have and k not in new:
            new.append(k)
    got = set(have) | set(new)
    if "secret_agent" not in got and all(k in got for k in SECRET_KEYS - {"secret_agent"}):
        new.append("secret_agent")
    t = db.now()
    for k in new:
        conn.execute("INSERT OR IGNORE INTO user_achievements (user_id, key, earned_at) VALUES (?,?,?)", (user_row["id"], k, t))
    if new:
        conn.commit()
    return new


def visible_to(caps, a, got):
    """Shown if they could earn it with their abilities, or already have it."""
    return got or not a[6] or a[6] in caps


def listing(user_row, caps):
    """The catalogue as one person sees it: earned (when) or progress, in groups."""
    have = earned(user_row["id"])
    prog = progress(user_row)
    total = len(have)
    prog["collector"] = (min(total, 20), 20)
    prog["completionist"] = (min(total, 40), 40)
    out = []
    for a in CATALOG:
        key, name, how, icon, tier, group, needs, goal = a
        got = have.get(key)
        if not visible_to(caps, a, got):
            continue
        n, g = prog.get(key, (0, 1))
        if key in SECRET_KEYS and not got:   # what it is stays a surprise
            out.append({"key": key, "name": "???", "how": "Secret achievement", "icon": "key", "tier": "silver",
                        "group": group, "earned_at": None, "have": 0, "goal": None, "secret": True})
            continue
        out.append({"key": key, "name": name, "how": how, "icon": icon, "tier": tier, "group": group,
                    "earned_at": got, "have": n, "goal": g if (goal or g > 1) else None, "secret": key in SECRET_KEYS})
    return {"achievements": out, "earned": sum(1 for x in out if x["earned_at"]), "total": len(out), "groups": GROUPS}


def summary(uid):
    """Count and the best few badges, for lists (Users)."""
    rows = db.get().execute("SELECT key, earned_at FROM user_achievements WHERE user_id=?", (uid,)).fetchall()
    keys = [r["key"] for r in rows if r["key"] in BY_KEY]
    best = sorted(keys, key=lambda k: (-TIERS.index(BY_KEY[k][4]), -next(r["earned_at"] for r in rows if r["key"] == k)))[:4]
    return {"count": len(keys), "top": [{"key": k, "name": BY_KEY[k][1], "icon": BY_KEY[k][3], "tier": BY_KEY[k][4]} for k in best]}


def _me_extras(u, out):
    """With /api/me: note today as a day they used the app, and report anything newly earned."""
    if not enabled():
        out["achievements"] = None
        return
    if not u.get("id") or u.get("impersonator") or u.get("method") == "token":
        return
    conn = db.get()
    row = auth.get_user(u["id"])
    if row is None or row["pending"] or row["must_change_pw"]:   # not really in yet: nothing to celebrate
        return
    conn.execute("INSERT OR IGNORE INTO user_days (user_id, day) VALUES (?, date('now', 'localtime'))", (u["id"],))
    conn.commit()
    first = not conn.execute("SELECT 1 FROM user_achievements WHERE user_id=? LIMIT 1", (u["id"],)).fetchone()
    new = evaluate(row)
    out["achievements"] = {
        "count": len(earned(u["id"])),
        # the first time we look, someone may already have a pile from before achievements existed
        "new": [{"key": k, "name": BY_KEY[k][1], "how": BY_KEY[k][2], "icon": BY_KEY[k][3], "tier": BY_KEY[k][4]} for k in new],
        "catch_up": first and len(new) > 3,
    }


def register(app):
    from flask import jsonify, request
    auth.ME_EXTRAS.append(_me_extras)

    @app.route("/api/achievements")
    @app.route("/api/achievements/<int:uid>")
    @auth.require()
    def api_achievements(uid=None):
        me = auth.current()
        if not enabled():
            return jsonify({"enabled": False, "achievements": [], "earned": 0, "total": 0, "groups": GROUPS})
        uid = uid or me.get("id")
        row = auth.get_user(uid) if uid else None
        if row is None:
            return jsonify({"ok": False, "error": "No such person"}), 404
        if uid != me.get("id") and not (perms.has(me, "users.view") and (perms.is_admin(me) or perms.above(me, row["role"]))):
            return jsonify({"ok": False, "error": "No such person"}), 404
        caps = perms.user_caps(row["role"], json.loads(row["caps_grant"] or "[]"), json.loads(row["caps_deny"] or "[]"))
        return jsonify({"enabled": True, **listing(row, caps)})

    @app.route("/api/achievements/people")
    @auth.require("users.view")
    def api_achievements_people():
        """{user id: count and best badges} for the people this person can see under Users."""
        me = auth.current()
        if not enabled():
            return jsonify({})
        rows = db.get().execute("SELECT id, role FROM users").fetchall()
        return jsonify({str(r["id"]): summary(r["id"]) for r in rows
                        if perms.is_admin(me) or r["id"] == me["id"] or perms.above(me, r["role"])})

    @app.route("/api/achievements/event", methods=["POST"])
    @auth.require()
    def api_achievements_event():
        """Things only the browser can see (a secret code, flipping the theme...). Returns anything earned."""
        me = auth.current()
        ev = str((request.get_json(silent=True) or {}).get("event") or "")
        if ev not in EVENTS or not me.get("id") or me.get("impersonator") or not enabled():
            return jsonify({"ok": True, "new": []})
        conn = db.get()
        conn.execute("INSERT INTO user_events (user_id, event, n, last_at) VALUES (?,?,1,?) "
                     "ON CONFLICT(user_id, event) DO UPDATE SET n=n+1, last_at=excluded.last_at", (me["id"], ev, db.now()))
        conn.commit()
        new = evaluate(auth.get_user(me["id"]))
        return jsonify({"ok": True, "new": [{"key": k, "name": BY_KEY[k][1], "how": BY_KEY[k][2], "icon": BY_KEY[k][3],
                                             "tier": BY_KEY[k][4]} for k in new]})

    @app.route("/api/settings/achievements", methods=["PUT"])
    @auth.require("settings.manage")
    def api_achievements_toggle():
        on = bool((request.get_json(silent=True) or {}).get("enabled"))
        db.set_setting("achievements", "1" if on else "0")
        auth.audit("settings.app", "", {"achievements": on})
        return jsonify({"ok": True})
