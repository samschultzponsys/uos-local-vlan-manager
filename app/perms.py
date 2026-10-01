"""
Roles and abilities.

Every person has one role. A role is a named set of abilities with a level;
the level decides who is "above" whom. Per person, an admin can also allow or
deny single abilities on top of their role.

    Super admin (1000)  every ability, always, including any added later - not editable. Only super
                        admins can make or change super admins, and the last one can't be removed.
    Admin (level 100)   every ability except the owner-level ones (system.manage) - not editable
    Supervisor (50)     default: change ports, see environment settings, see activity
                        (PoE control and device management start admin-only)
    Viewer (10)         default: nothing beyond seeing their devices
    custom roles        any level from 11 to 99, any abilities

Abilities that let someone hand themselves more power (environments and API
keys, sign-in settings, editing roles) are admin-only and can't be granted.

People-management abilities only ever apply to people whose role is *below*
your own, and you can only pass on access and abilities you have yourself.
"""

import json
import re

from flask import g

import db

ADMIN = "admin"
ADMIN_LEVEL = 100
SUPER = "superadmin"
SUPER_LEVEL = 1000
FULL = (SUPER, ADMIN)   # built-in roles whose abilities are fixed, not stored

# (key, group, label, hint)
CAPS = [
    ("ports.change", "Ports", "Change port VLANs", "On the devices they can see, using the networks they're given."),
    ("ports.protected", "Ports", "Change protected ports",
     "Uplinks, links to other UniFi devices, LAG and mirror ports (after a warning)."),
    ("ports.lock", "Ports", "Lock and unlock ports",
     "Also change locked ports and re-apply locked settings."),
    ("ports.poe", "Ports", "Power-cycle PoE and turn PoE on / off",
     "Restart a camera, phone or access point by cycling its port's power."),
    ("devices.manage", "Devices", "Manage devices",
     "Rename devices and ports, blink the locate light, turn the LED on / off, restart and update firmware."),
    ("apps.network", "UniFi apps", "Network devices", "Gateways, switches and access points."),
    ("apps.protect", "UniFi apps", "Protect devices", "Cameras, doorbells, sensors... and the port each is on."),
    ("apps.access", "UniFi apps", "Access devices", "Door hubs, readers and intercoms."),
    ("apps.other", "UniFi apps", "Other UniFi devices", "Talk, Connect, LED and anything else."),
    ("env.info", "Environments", "See environment settings", "Connection, site and notes. Never the API key."),
    ("activity.view", "Environments", "See the activity log", "Changes made in their environments."),
    ("feedback.view", "Feedback", "See the feedback board", "Every bug report and idea, with its status."),
    ("feedback.submit", "Feedback", "Report bugs and suggest ideas", "Also vote and comment."),
    ("feedback.manage", "Feedback", "Manage feedback",
     "Set the status (planned, done...), edit and delete anyone's reports and comments."),
    ("requests.ports", "Requests", "Request port VLAN changes",
     "For ports they can't change themselves. Someone who can change it approves it on the Feedback board."),
    ("requests.poe", "Requests", "Request a PoE power-cycle", "To restart a camera, phone or access point."),
    ("requests.restart", "Requests", "Request a device restart", "Gateways, switches and access points."),
    ("users.view", "People", "See the people below them", "Opens the Users page, showing only lower roles."),
    ("users.create", "People", "Add people", "New people get the lowest role."),
    ("users.edit", "People", "Edit people below them",
     "Name, picture, password, enable / disable and sign out."),
    ("users.access", "People", "Give access to people below them",
     "Environments, networks and devices - only from their own access."),
    ("users.roles", "People", "Change roles and abilities of people below them",
     "Only roles below their own, and only abilities they have themselves."),
    ("users.delete", "People", "Delete people below them", ""),
    ("users.view_as", "People", "View as people below them", "See the app exactly as that person does."),
]
CAP_KEYS = [c[0] for c in CAPS]
# never grantable: whoever has these could give themselves everything else
ADMIN_CAPS = ["envs.manage", "settings.manage", "roles.manage"]
# owner-level, super admins only: integration tokens (GitHub, notifications) and how long activity is kept
SUPER_CAPS = ["system.manage"]
ALL_CAPS = CAP_KEYS + ADMIN_CAPS + SUPER_CAPS


def full_caps(role_key):
    """Abilities of the fixed roles: a super admin has every ability that exists, now or later."""
    if role_key == SUPER:
        return set(ALL_CAPS)
    return set(ALL_CAPS) - set(SUPER_CAPS)

DEFAULT_ROLES = [
    (SUPER, "Super admin", SUPER_LEVEL, ALL_CAPS),
    (ADMIN, "Admin", ADMIN_LEVEL, ALL_CAPS),
    ("supervisor", "Supervisor", 50, ["ports.change", "env.info", "activity.view", "apps.network",
                                      "feedback.view", "feedback.submit"]),
    ("viewer", "Viewer", 10, ["apps.network", "feedback.view", "feedback.submit"]),
]
APPS = ("network", "protect", "access")


def app_cap(app):
    """The ability that lets someone see devices of a UniFi app ("Network", "Protect", "Talk"...)."""
    a = (app or "network").lower()
    return f"apps.{a}" if a in APPS else "apps.other"


def _loads(v):
    try:
        return json.loads(v) if v else []
    except ValueError:
        return []


def seed(conn):
    """Create the built-in roles (idempotent)."""
    for key, name, level, caps in DEFAULT_ROLES:
        conn.execute("INSERT OR IGNORE INTO roles (key, name, level, caps, builtin) VALUES (?,?,?,?,1)",
                     (key, name, level, json.dumps(caps)))


# abilities every existing role gets once, when the version that brings them starts
MIGRATIONS = [
    ("migrated_apps_caps", ["apps.network"]),                         # 1.7: devices split by UniFi app
    ("migrated_feedback_caps", ["feedback.view", "feedback.submit"]),   # 3.1: the feedback board, for everyone
]


def migrate(conn):
    for flag, add in MIGRATIONS:
        if conn.execute("SELECT 1 FROM settings WHERE key=?", (flag,)).fetchone():
            continue
        for r in conn.execute("SELECT key, caps FROM roles").fetchall():
            caps = _loads(r["caps"])
            more = [c for c in add if c not in caps]
            if more:
                conn.execute("UPDATE roles SET caps=? WHERE key=?", (json.dumps(caps + more), r["key"]))
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')", (flag,))
    # 3.7: someone has to be super admin - the first admin (or the longest-standing one)
    if not conn.execute("SELECT 1 FROM users WHERE role=?", (SUPER,)).fetchone():
        r = conn.execute("SELECT id FROM users WHERE role=? AND disabled=0 ORDER BY seeded DESC, id LIMIT 1", (ADMIN,)).fetchone()
        if r:
            conn.execute("UPDATE users SET role=? WHERE id=?", (SUPER, r[0]))


def roles():
    """{key: role} for this request (cached)."""
    cached = getattr(g, "_roles", None) if _in_request() else None
    if cached is not None:
        return cached
    out = {}
    for r in db.get().execute("SELECT * FROM roles ORDER BY level DESC, name"):
        caps = sorted(full_caps(r["key"])) if r["key"] in FULL else [c for c in _loads(r["caps"]) if c in CAP_KEYS]
        out[r["key"]] = {"key": r["key"], "name": r["name"], "level": r["level"], "caps": caps,
                         "builtin": bool(r["builtin"])}
    if _in_request():
        g._roles = out
    return out


def forget():
    if _in_request() and hasattr(g, "_roles"):
        del g._roles


def _in_request():
    try:
        g.get("x")
        return True
    except RuntimeError:
        return False


def level(role_key):
    r = roles().get(role_key)
    return r["level"] if r else -1


def name(role_key):
    r = roles().get(role_key)
    return r["name"] if r else role_key


def lowest_role():
    rs = sorted(roles().values(), key=lambda r: r["level"])
    return rs[0]["key"] if rs else "viewer"


def lower_of(a, b):
    return a if level(a) <= level(b) else b


def role_caps(role_key):
    r = roles().get(role_key)
    return set(r["caps"]) if r else set()


def user_caps(role_key, grant=None, deny=None):
    """Abilities of someone with this role and these per-person overrides."""
    if role_key in FULL:
        return full_caps(role_key)
    caps = role_caps(role_key) | {c for c in (grant or []) if c in CAP_KEYS}
    return caps - set(deny or [])


def caps_for(user):
    """Effective abilities of a signed-in identity (session, token or anonymous)."""
    if not user:
        return set()
    cached = user.get("_caps")
    if cached is not None:
        return cached
    if user.get("method") == "none":
        caps = full_caps(user["role"]) if user["role"] in FULL else role_caps(user["role"])
    else:
        row = db.get().execute("SELECT role, caps_grant, caps_deny FROM users WHERE id=?", (user["id"],)).fetchone()
        if row is None:
            caps = set()
        else:
            caps = user_caps(row["role"], _loads(row["caps_grant"]), _loads(row["caps_deny"]))
            # a token (or a session opened with a token link) is capped at its role
            if user["role"] != row["role"]:
                caps &= user_caps(user["role"])
    user["_caps"] = caps
    return caps


def has(user, cap):
    return cap in caps_for(user)


def is_admin(user):
    return bool(user) and has(user, "settings.manage")


def is_super(user):
    return bool(user) and has(user, "system.manage")


def above(user, target_role):
    """May `user` manage someone with `target_role`? Super admins manage everyone, admins everyone but super admins."""
    if is_super(user):
        return True
    if is_admin(user):
        return target_role != SUPER
    return level(target_role) < level(user["role"])


def assignable_roles(user):
    """Roles `user` may give to people."""
    if is_super(user):
        return list(roles())
    if is_admin(user):
        return [k for k in roles() if k != SUPER]
    return [k for k in roles() if level(k) < level(user["role"])]


def slug(text):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:32]
    return s or "role"


def public_caps():
    return [{"key": k, "group": grp, "label": lbl, "hint": hint} for k, grp, lbl, hint in CAPS]
