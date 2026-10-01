"""
Roles and abilities.

Every person has one role. A role is a named set of abilities with a level;
the level decides who is "above" whom. Per person, an admin can also allow or
deny single abilities on top of their role.

    Admin (level 100)   every ability, always - not editable
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
    ("env.info", "Environments", "See environment settings", "Connection, site and notes. Never the API key."),
    ("activity.view", "Environments", "See the activity log", "Changes made in their environments."),
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
ALL_CAPS = CAP_KEYS + ADMIN_CAPS

DEFAULT_ROLES = [
    (ADMIN, "Admin", ADMIN_LEVEL, ALL_CAPS),
    ("supervisor", "Supervisor", 50, ["ports.change", "env.info", "activity.view"]),
    ("viewer", "Viewer", 10, []),
]


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


def roles():
    """{key: role} for this request (cached)."""
    cached = getattr(g, "_roles", None) if _in_request() else None
    if cached is not None:
        return cached
    out = {}
    for r in db.get().execute("SELECT * FROM roles ORDER BY level DESC, name"):
        caps = ALL_CAPS if r["key"] == ADMIN else [c for c in _loads(r["caps"]) if c in CAP_KEYS]
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
    if role_key == ADMIN:
        return set(ALL_CAPS)
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
        caps = role_caps(user["role"]) if user["role"] != ADMIN else set(ALL_CAPS)
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


def above(user, target_role):
    """May `user` manage someone with `target_role`? Admins manage everyone."""
    if is_admin(user):
        return True
    return level(target_role) < level(user["role"])


def assignable_roles(user):
    """Roles `user` may give to people."""
    if is_admin(user):
        return list(roles())
    return [k for k in roles() if level(k) < level(user["role"])]


def slug(text):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:32]
    return s or "role"


def public_caps():
    return [{"key": k, "group": grp, "label": lbl, "hint": hint} for k, grp, lbl, hint in CAPS]
