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

import auth
import db
import perms

GROUPS = ["Getting started", "Make it yours", "Ports", "Devices", "Feedback", "People & admin", "Regulars"]

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
    return p


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
        out.append({"key": key, "name": name, "how": how, "icon": icon, "tier": tier, "group": group,
                    "earned_at": got, "have": n, "goal": g if (goal or g > 1) else None})
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

    @app.route("/api/settings/achievements", methods=["PUT"])
    @auth.require("settings.manage")
    def api_achievements_toggle():
        on = bool((request.get_json(silent=True) or {}).get("enabled"))
        db.set_setting("achievements", "1" if on else "0")
        auth.audit("settings.app", "", {"achievements": on})
        return jsonify({"ok": True})
