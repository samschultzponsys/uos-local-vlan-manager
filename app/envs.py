"""
Environments: one UniFi Network connection each (a console, or a per-technician
UniFi OS container), with its own API key. Only admins add, change or remove
them, and only admins decide who may use which environment.

Access (the user_env table) is per user and per environment:
    all_vlans / vlans      which networks the user may put on a port
    all_devices / devices  which devices the user sees (by MAC, so a switch
                           that's forgotten and re-adopted keeps its access)

Admins always have every environment, every network and every device.
Supervisors change ports in their environments and can read the environment's
settings (never the API key). Viewers only see their devices.
In no-auth mode the anonymous visitor gets every environment.
"""

import json

import db
import unifi

_snapshots = {}   # env id -> unifi.Snapshot


def _loads(v, default):
    try:
        return json.loads(v) if v else default
    except ValueError:
        return default


def all_envs():
    return db.get().execute("SELECT * FROM environments ORDER BY name COLLATE NOCASE").fetchall()


def get(env_id):
    return db.get().execute("SELECT * FROM environments WHERE id=?", (env_id,)).fetchone()


def client(row, overrides=None):
    s = dict(row) if row is not None else {"mode": "local", "host": "", "api_key": "", "site": "default",
                                           "console_id": "", "verify_ssl": 0}
    s.update({k: v for k, v in (overrides or {}).items() if v is not None})
    return unifi.UniFi(mode=s["mode"], host=s["host"], api_key=s["api_key"], site=s["site"],
                       console_id=s["console_id"], verify_ssl=bool(int(s["verify_ssl"] or 0)))


def snapshot(env_id):
    snap = _snapshots.get(env_id)
    if snap is None:
        snap = _snapshots[env_id] = unifi.Snapshot(ttl=5)
    return snap


def invalidate(env_id):
    snap = _snapshots.get(env_id)
    if snap is not None:
        snap.invalidate()


def public(row, secrets_visible=False):
    """An environment as the UI sees it. The API key is never sent."""
    out = {"id": row["id"], "name": row["name"], "mode": row["mode"], "site": row["site"],
           "host": row["host"], "console_id": row["console_id"], "verify_ssl": bool(row["verify_ssl"]),
           "supervisors_protected": bool(row["supervisors_protected"]), "notes": row["notes"],
           "vlan_colors": _loads(row["vlan_colors"], {})}
    if secrets_visible:
        out["api_key_set"] = bool(row["api_key"])
    return out


# ----------------------------------------------------------------------------
# Access
# ----------------------------------------------------------------------------

FULL = {"all_vlans": True, "vlans": [], "all_devices": True, "devices": []}


def _full_access(user):
    return user["role"] == "admin" or user["method"] == "none"


def access(user, env_id):
    """What `user` may do in environment `env_id`: a dict, or None for no access."""
    if not user or get(env_id) is None:
        return None
    if _full_access(user):
        return dict(FULL)
    row = db.get().execute("SELECT * FROM user_env WHERE user_id=? AND env_id=?",
                           (user["id"], env_id)).fetchone()
    if row is None:
        return None
    return {"all_vlans": bool(row["all_vlans"]), "vlans": _loads(row["vlans"], []),
            "all_devices": bool(row["all_devices"]), "devices": [m.lower() for m in _loads(row["devices"], [])]}


def accessible(user):
    """[(env row, access)] the user can open."""
    if not user:
        return []
    if _full_access(user):
        return [(e, dict(FULL)) for e in all_envs()]
    rows = db.get().execute(
        "SELECT e.*, ue.all_vlans AS a_all_vlans, ue.vlans AS a_vlans, ue.all_devices AS a_all_devices, "
        "ue.devices AS a_devices FROM environments e JOIN user_env ue ON ue.env_id = e.id "
        "WHERE ue.user_id=? ORDER BY e.name COLLATE NOCASE", (user["id"],)).fetchall()
    return [(r, {"all_vlans": bool(r["a_all_vlans"]), "vlans": _loads(r["a_vlans"], []),
                 "all_devices": bool(r["a_all_devices"]),
                 "devices": [m.lower() for m in _loads(r["a_devices"], [])]}) for r in rows]


def device_allowed(acc, mac):
    return acc["all_devices"] or (mac or "").lower() in acc["devices"]


def vlan_allowed(acc, network_id):
    return acc["all_vlans"] or network_id in acc["vlans"]


def user_access_list(user_id):
    rows = db.get().execute("SELECT * FROM user_env WHERE user_id=?", (user_id,)).fetchall()
    return [{"env_id": r["env_id"], "all_vlans": bool(r["all_vlans"]), "vlans": _loads(r["vlans"], []),
             "all_devices": bool(r["all_devices"]), "devices": _loads(r["devices"], [])} for r in rows]


def set_user_access(user_id, entries):
    """Replace a user's environments with `entries` (list of access dicts)."""
    d = db.get()
    valid = {e["id"] for e in all_envs()}
    d.execute("DELETE FROM user_env WHERE user_id=?", (user_id,))
    for e in entries:
        eid = int(e.get("env_id") or 0)
        if eid not in valid:
            continue
        vlans = [str(v) for v in e.get("vlans") or [] if v][:500]
        devices = [str(m).lower() for m in e.get("devices") or [] if m][:500]
        d.execute("INSERT INTO user_env (user_id, env_id, all_vlans, vlans, all_devices, devices) VALUES (?,?,?,?,?,?)",
                  (user_id, eid, 1 if e.get("all_vlans", True) else 0, json.dumps(vlans),
                   1 if e.get("all_devices", True) else 0, json.dumps(devices)))
    d.commit()


# ----------------------------------------------------------------------------
# Port locks (admin): a locked port can only be changed by an admin
# ----------------------------------------------------------------------------

def locks(env_id):
    """{(mac, port_idx): lock dict} for an environment."""
    rows = db.get().execute("SELECT * FROM port_locks WHERE env_id=?", (env_id,)).fetchall()
    return {(r["device_mac"], r["port_idx"]): {
        "native_network_id": r["native_network_id"], "tagged_mode": r["tagged_mode"],
        "excluded_network_ids": _loads(r["excluded"], []), "note": r["note"],
        "locked_by": r["locked_by"], "created_at": r["created_at"]} for r in rows}


def lock_drift(lock, port):
    """True when UniFi's current settings differ from what the port was locked to."""
    if port["native_network_id"] != lock["native_network_id"] or port["tagged_mode"] != lock["tagged_mode"]:
        return True
    return lock["tagged_mode"] == "custom" and \
        sorted(port["excluded_network_ids"]) != sorted(lock["excluded_network_ids"])


def annotate_locks(env_id, devices):
    """Attach `lock` (or None) to every port."""
    lk = locks(env_id)
    for d in devices:
        for p in d["ports"]:
            lock = lk.get((d["mac"], p["idx"]))
            p["lock"] = {**lock, "drift": lock_drift(lock, p)} if lock else None
    return devices


def set_lock(env_id, mac, idx, native, mode, excluded, note, by):
    d = db.get()
    d.execute("INSERT INTO port_locks (env_id, device_mac, port_idx, native_network_id, tagged_mode, excluded, note, "
              "locked_by, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(env_id, device_mac, port_idx) DO UPDATE SET "
              "native_network_id=excluded.native_network_id, tagged_mode=excluded.tagged_mode, "
              "excluded=excluded.excluded, note=excluded.note, locked_by=excluded.locked_by, created_at=excluded.created_at",
              (env_id, mac.lower(), idx, native, mode, json.dumps(sorted(excluded or [])), (note or "")[:300], by, db.now()))
    d.commit()


def remove_lock(env_id, mac, idx):
    d = db.get()
    cur = d.execute("DELETE FROM port_locks WHERE env_id=? AND device_mac=? AND port_idx=?", (env_id, mac.lower(), idx))
    d.commit()
    return cur.rowcount > 0
