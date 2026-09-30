#!/usr/bin/env python3
"""
VLAN Manager for UniFi - pick switches, click a port, set its native VLAN.

Flask + SQLite, single container. See README.md.
"""

import hashlib
import json
import os
import re
import secrets
import threading
import time

from flask import Flask, g, jsonify, redirect, request, send_from_directory

import auth
import db
import envs
import perms
import unifi
import versioning
from versioning import VERSION, CHANGELOG

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
BUILD_RE = re.compile(r"^\d+\.\d+-[0-9a-f]{8}$")


def _build_id():
    """Version + a hash of the UI files. Pages load their scripts and styles from
    /static/<build>/..., so a new release (or any UI change) always gets fresh
    URLs - browsers, installed home-screen apps and caching proxies can't keep
    serving old files."""
    h = hashlib.sha1()
    for root, _, files in sorted(os.walk(STATIC_DIR)):
        for f in sorted(files):
            with open(os.path.join(root, f), "rb") as fh:
                h.update(f.encode() + fh.read())
    return f"{VERSION}-{h.hexdigest()[:8]}"


BUILD = _build_id()

app = Flask(__name__, static_folder=None)
app.config.update(SESSION_COOKIE_NAME="vlanmgr_flow", SESSION_COOKIE_HTTPONLY=True,
                  SESSION_COOKIE_SAMESITE="Lax", MAX_CONTENT_LENGTH=1024 * 1024)
app.secret_key = secrets.token_hex(32)
auth.init_app(app)


@app.teardown_appcontext
def _close_db(exc):
    db.close()


def _deny(msg, code=400, **extra):
    return jsonify({"ok": False, "error": msg, **extra}), code


# ----------------------------------------------------------------------------
# Pages
# ----------------------------------------------------------------------------

@app.after_request
def _headers(resp):
    p = request.path
    if p in ("/", "/login") or p.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp


def _page(name):
    with open(os.path.join(STATIC_DIR, name), encoding="utf-8") as fh:
        html = fh.read()
    html = html.replace('"/static/', f'"/static/{BUILD}/').replace("__BUILD__", BUILD)
    return app.response_class(html, mimetype="text/html")


@app.route("/")
def index():
    return _page("index.html")


@app.route("/login")
def login_page():
    u = auth.current()
    if u and u["method"] != "none":
        return redirect(auth._safe_next(request.args.get("next")))
    return _page("login.html")


@app.route("/manifest.webmanifest")
def manifest():
    """Installable web app: launched from its icon it opens full screen, no browser bars."""
    name = db.get_setting("app_name") or "VLAN Manager"
    body = {
        "name": name, "short_name": name[:12], "start_url": "/", "scope": "/", "id": "/",
        "display": "standalone", "orientation": "any",
        "background_color": "#0a0c11", "theme_color": "#0a0c11",
        "icons": [
            {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/static/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    return app.response_class(json.dumps(body), mimetype="application/manifest+json")


@app.route("/favicon.svg")
def favicon():
    return send_from_directory(STATIC_DIR, "favicon.svg")


@app.route("/static/<path:fname>")
def static_files(fname):
    first, _, rest = fname.partition("/")
    if rest and BUILD_RE.match(first):
        resp = send_from_directory(STATIC_DIR, rest)
        # a versioned URL never changes content: cache it forever
        resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable" if first == BUILD else "no-cache")
        return resp
    resp = send_from_directory(STATIC_DIR, fname)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True, "version": VERSION})


# ----------------------------------------------------------------------------
# Version + updates
# ----------------------------------------------------------------------------

@app.route("/api/version")
def api_version():
    return jsonify({"version": VERSION, "build": BUILD, "changelog": CHANGELOG,
                    "update": versioning.status(db.setting_bool("update_check"))})


@app.route("/api/version/check", methods=["POST"])
@auth.require("settings.manage")
def api_version_check():
    return jsonify({"version": VERSION, "update": versioning.check(db.setting_bool("update_check"))})


def _update_loop():
    time.sleep(20)
    while True:
        try:
            with app.app_context():
                enabled = db.setting_bool("update_check")
            if enabled and versioning.due():
                versioning.check(True)
        except Exception as e:   # never let the loop die
            print(f"[update-check] {e}", flush=True)
        time.sleep(600)


# ----------------------------------------------------------------------------
# Environments the signed-in user can open
# ----------------------------------------------------------------------------

def public_settings():
    return {
        "app_name": db.get_setting("app_name"),
        "default_tagged_mode": db.get_setting("default_tagged_mode"),
        "poll_seconds": int(db.get_setting("poll_seconds") or 10),
        "protect_uplinks": db.setting_bool("protect_uplinks"),
    }


def _env_or_404(env_id):
    acc = envs.access(auth.current(), env_id)
    if acc is None:
        return None, None, _deny("No such environment", 404)
    return envs.get(env_id), acc, None


@app.route("/api/envs")
@auth.require()
def api_envs():
    me = auth.current()
    return jsonify({"settings": public_settings(),
                    "envs": [{**envs.public(e, perms.has(me, "envs.manage")), "access": acc}
                             for e, acc in envs.accessible(me)]})


@app.route("/api/envs/<int:env_id>/state")
@auth.require()
def api_env_state(env_id):
    env, acc, err = _env_or_404(env_id)
    if err:
        return err
    out = {"env": envs.public(env), "access": acc, "settings": public_settings(),
           "networks": [], "devices": [], "error": None}
    c = envs.client(env)
    if not c.configured():
        out["error"] = "not_configured"
        return jsonify(out)
    try:
        data, _ = envs.snapshot(env_id).get(c, db.setting_bool("protect_uplinks"),
                                            force=request.args.get("refresh") == "1")
    except unifi.UniFiError as e:
        out["error"] = str(e)
        return jsonify(out)
    out.update(data)
    out["networks"] = [{**n, "allowed": envs.vlan_allowed(acc, n["id"])} for n in data["networks"]]
    out["devices"] = [d for d in data["devices"] if envs.device_allowed(acc, d["mac"])]
    if not data.get("readonly"):
        envs.annotate_locks(env_id, out["devices"])
    return jsonify(out)


@app.route("/api/envs/<int:env_id>/config")
@auth.require("env.info")
def api_env_config(env_id):
    """Read-only view of an environment's settings for its supervisors (no API key)."""
    env, acc, err = _env_or_404(env_id)
    if err:
        return err
    return jsonify({**envs.public(env, True), "access": acc})


# ----------------------------------------------------------------------------
# Change a port
# ----------------------------------------------------------------------------

def _net_label(nets, nid):
    n = next((x for x in nets if x["id"] == nid), None)
    return f"{n['name']} ({n['vlan']})" if n else (nid or "?")


@app.route("/api/envs/<int:env_id>/devices/<device_id>/ports/<int:idx>", methods=["PUT"])
@auth.require("ports.change")
def api_set_port(env_id, device_id, idx):
    return _set_port(env_id, device_id, idx, request.get_json(silent=True) or {})


READONLY_MSG = ("This environment is view only: UniFi's cloud doesn't allow changing port VLANs. "
                "An admin can switch it to a Direct connection for full control.")


def _readonly(env):
    return env["mode"] == "cloud" and envs.snapshot(env["id"]).readonly


def _set_port(env_id, device_id, idx, body, action="port.set"):
    me = auth.current()
    env, acc, err = _env_or_404(env_id)
    if err:
        return err
    if _readonly(env):
        return _deny(READONLY_MSG, 409)
    native = body.get("native_network_id")
    mode = body.get("tagged_mode") or db.get_setting("default_tagged_mode")
    excluded = body.get("excluded_network_ids") or []
    if mode not in unifi.MODES:
        return _deny("Pick Allow All, Block All or Custom")
    if not isinstance(excluded, list):
        return _deny("excluded_network_ids must be a list")
    c = envs.client(env)
    try:
        # always work from what UniFi has right now, not from a cache
        raw_devs = c.raw_devices()
        dev = next((d for d in raw_devs if d.get("_id") == device_id), None)
        if dev is None or not envs.device_allowed(acc, dev.get("mac")):
            return _deny("That device is no longer on the controller", 404)
        norm = unifi.normalize(raw_devs, c.raw_networks(), c.raw_portconfs(), [], db.setting_bool("protect_uplinks"))
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    nets = norm["networks"]
    net_ids = [n["id"] for n in nets]
    ndev = next((d for d in norm["devices"] if d["id"] == device_id), None)
    port = next((p for p in (ndev or {}).get("ports", []) if p["idx"] == idx), None)
    if port is None:
        return _deny("No such port", 404)
    if native not in net_ids:
        return _deny("Pick a network from the list")
    if not envs.vlan_allowed(acc, native):
        return _deny("You can't put ports on that network", 403)
    if not acc["all_vlans"]:
        if mode == "auto":
            return _deny("Allow All would tag networks you can't use - pick Block All or Custom", 403)
        if mode == "custom":   # networks you can't use are never tagged
            excluded = list(set(excluded) | {i for i in net_ids if not envs.vlan_allowed(acc, i)})
    lock = envs.locks(env_id).get((ndev["mac"], idx))
    if lock:
        if not perms.has(me, "ports.lock"):
            return _deny("An admin locked this port" + (f": {lock['note']}" if lock["note"] else ""), 403)
        if not body.get("confirm_locked"):
            return _deny("Locked port", 409, confirm="locked", note=lock["note"])
    if port["protected"]:
        may = perms.has(me, "ports.protected") or bool(env["supervisors_protected"])
        if not may:
            return _deny("This port is protected (" + "; ".join(port["protect_reasons"]) +
                         "). You don't have permission to change protected ports.", 403)
        if not body.get("confirm_protected"):
            return _deny("Protected port", 409, confirm="protected", reasons=port["protect_reasons"])
    if port["profile_id"] and not body.get("detach_profile"):
        return _deny("Port profile attached", 409, confirm="profile", profile=port["profile_name"])
    exp = body.get("expected")
    if isinstance(exp, dict) and not body.get("confirm_changed"):
        seen = (exp.get("native_network_id"), exp.get("tagged_mode"), sorted(exp.get("excluded_network_ids") or []))
        now_ = (port["native_network_id"], port["tagged_mode"], sorted(port["excluded_network_ids"]))
        if seen != now_:
            return _deny("Changed elsewhere", 409, confirm="changed",
                         current={"native": _net_label(nets, port["native_network_id"]),
                                  "tagged": unifi.MODE_LABEL[port["tagged_mode"]]})

    overrides, before, after = unifi.build_override(dev, idx, native, mode, excluded, net_ids, True)
    target = f"{env['name']} / {ndev['name']} / port {idx}"
    detail = {
        "env": env["name"], "device": ndev["name"], "device_id": device_id, "port": idx, "port_name": port["name"],
        "before": {"native": _net_label(nets, port["native_network_id"]),
                   "tagged": unifi.MODE_LABEL[port["tagged_mode"]],
                   "excluded": [_net_label(nets, i) for i in port["excluded_network_ids"]],
                   "profile": port["profile_name"]},
        "after": {"native": _net_label(nets, native), "tagged": unifi.MODE_LABEL[mode],
                  "excluded": [_net_label(nets, i) for i in after.get("excluded_networkconf_ids", [])]},
    }
    try:
        c.put_port_overrides(device_id, overrides)
    except unifi.UniFiError as e:
        auth.audit(action, target, {**detail, "error": str(e)}, ok=False, env_id=env_id)
        return _deny(str(e), 502)
    if lock:   # an admin changed a locked port: it stays locked, to the new settings
        envs.set_lock(env_id, ndev["mac"], idx, native, mode, after.get("excluded_networkconf_ids", []),
                      lock["note"], me["username"])
        detail["lock"] = "kept, updated to the new settings"
    verified = False
    try:
        for _ in range(3):
            time.sleep(0.6)
            if unifi.verify_override(c.raw_device(dev.get("mac")), idx, native, mode):
                verified = True
                break
    except unifi.UniFiError:
        pass
    envs.invalidate(env_id)
    detail["verified"] = verified
    auth.audit(action, target, detail, ok=True, env_id=env_id)
    return jsonify({"ok": True, "verified": verified,
                    "warning": None if verified else
                    "UniFi accepted the change but didn't report it back yet. Refresh in a moment to check."})


# ----------------------------------------------------------------------------
# Port locks (admin)
# ----------------------------------------------------------------------------

def _fresh_port(env, device_id, idx):
    """(device, port) straight from UniFi, or raise UniFiError / return (None, None)."""
    c = envs.client(env)
    raw_devs = c.raw_devices()
    norm = unifi.normalize(raw_devs, c.raw_networks(), c.raw_portconfs(), [], db.setting_bool("protect_uplinks"))
    dev = next((d for d in norm["devices"] if d["id"] == device_id), None)
    port = next((p for p in (dev or {}).get("ports", []) if p["idx"] == idx), None)
    return dev, port


@app.route("/api/envs/<int:env_id>/devices/<device_id>/ports/<int:idx>/lock", methods=["PUT", "DELETE"])
@auth.require("ports.lock")
def api_port_lock(env_id, device_id, idx):
    env, _, err = _env_or_404(env_id)
    if err:
        return err
    if _readonly(env):
        return _deny(READONLY_MSG, 409)
    try:
        dev, port = _fresh_port(env, device_id, idx)
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    if port is None:
        return _deny("No such port", 404)
    target = f"{env['name']} / {dev['name']} / port {idx}"
    if request.method == "DELETE":
        if not envs.remove_lock(env_id, dev["mac"], idx):
            return _deny("That port isn't locked", 404)
        auth.audit("port.unlocked", target, env_id=env_id)
    else:
        note = str((request.get_json(silent=True) or {}).get("note") or "").strip()
        # locked to the settings UniFi has right now
        envs.set_lock(env_id, dev["mac"], idx, port["native_network_id"], port["tagged_mode"],
                      port["excluded_network_ids"] if port["tagged_mode"] == "custom" else [], note,
                      auth.current()["username"])
        auth.audit("port.locked", target, {"note": note, "tagged": unifi.MODE_LABEL[port["tagged_mode"]]}, env_id=env_id)
    envs.invalidate(env_id)
    return jsonify({"ok": True})


@app.route("/api/envs/<int:env_id>/devices/<device_id>/ports/<int:idx>/lock/reapply", methods=["POST"])
@auth.require("ports.lock")
def api_port_lock_reapply(env_id, device_id, idx):
    """Put a locked port back to its locked settings (after someone changed it in UniFi)."""
    env, _, err = _env_or_404(env_id)
    if err:
        return err
    try:
        dev, port = _fresh_port(env, device_id, idx)
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    lock = envs.locks(env_id).get((dev["mac"], idx)) if dev else None
    if not lock:
        return _deny("That port isn't locked", 404)
    return _set_port(env_id, device_id, idx, {
        "native_network_id": lock["native_network_id"], "tagged_mode": lock["tagged_mode"],
        "excluded_network_ids": lock["excluded_network_ids"], "confirm_locked": True,
        "confirm_protected": True, "detach_profile": True}, action="port.lock_reapplied")


# ----------------------------------------------------------------------------
# Audit log
# ----------------------------------------------------------------------------

@app.route("/api/audit")
@auth.require("activity.view")
def api_audit():
    me = auth.current()
    limit = max(1, min(500, int(request.args.get("limit") or 200)))
    where, args = [], []
    if request.args.get("before"):
        where.append("a.id < ?")
        args.append(int(request.args["before"]))
    if not perms.has(me, "settings.manage"):
        # everyone but admins: port changes in their own environments
        ids = [e["id"] for e, _ in envs.accessible(me)] or [-1]
        where.append("a.action LIKE 'port.%' AND a.env_id IN (" + ",".join("?" * len(ids)) + ")")
        args += ids
    q = ("SELECT a.*, e.name AS env_name FROM audit a LEFT JOIN environments e ON e.id = a.env_id"
         + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY a.id DESC LIMIT ?")
    rows = db.get().execute(q, args + [limit]).fetchall()
    return jsonify({"entries": [{**dict(r), "detail": json.loads(r["detail"] or "{}"), "ok": bool(r["ok"])}
                                for r in rows]})


# ----------------------------------------------------------------------------
# App settings (admin)
# ----------------------------------------------------------------------------

@app.route("/api/settings")
@auth.require("settings.manage")
def api_settings():
    return jsonify({**public_settings(), "update_check": db.setting_bool("update_check"),
                    "update_allowed": versioning.UPDATE_ALLOWED})


@app.route("/api/settings", methods=["PUT"])
@auth.require("settings.manage")
def api_settings_put():
    data = request.get_json(silent=True) or {}
    vals = {}
    if "app_name" in data:
        vals["app_name"] = (str(data["app_name"] or "").strip() or "VLAN Manager")[:40]
    if "default_tagged_mode" in data:
        if data["default_tagged_mode"] not in unifi.MODES:
            return _deny("Unknown tagged mode")
        vals["default_tagged_mode"] = data["default_tagged_mode"]
    if "poll_seconds" in data:
        try:
            vals["poll_seconds"] = str(max(5, min(600, int(data["poll_seconds"]))))
        except (TypeError, ValueError):
            return _deny("Refresh interval must be a number of seconds")
    for k in ("protect_uplinks", "update_check"):
        if k in data:
            vals[k] = "1" if data[k] else "0"
    for k, v in vals.items():
        db.set_setting(k, v)
    for e in envs.all_envs():
        envs.invalidate(e["id"])
    auth.audit("settings.app", "", vals)
    return jsonify({"ok": True})


# ----------------------------------------------------------------------------
# Environments (admin)
# ----------------------------------------------------------------------------

ENV_TEXT = ("name", "mode", "host", "site", "console_id", "notes")


def _env_fields(data, partial):
    """Validated column values from a request body."""
    vals = {}
    for k in ENV_TEXT:
        if k in data:
            vals[k] = str(data[k] or "").strip()[:500]
    if "name" in vals and not vals["name"]:
        raise ValueError("Give the environment a name")
    if not partial and not vals.get("name"):
        raise ValueError("Give the environment a name")
    if vals.get("mode") and vals["mode"] not in ("local", "cloud"):
        raise ValueError("Connection must be local or cloud")
    if "site" in vals:
        vals["site"] = vals["site"] or "default"
    for k in ("verify_ssl", "supervisors_protected"):
        if k in data:
            vals[k] = 1 if data[k] else 0
    if data.get("api_key"):
        vals["api_key"] = str(data["api_key"]).strip()
    if data.get("clear_api_key"):
        vals["api_key"] = ""
    if "vlan_colors" in data:
        colors = data["vlan_colors"] or {}
        if not isinstance(colors, dict) or not all(isinstance(v, str) and HEX.match(v) for v in colors.values()):
            raise ValueError("Colors must be #rrggbb")
        vals["vlan_colors"] = json.dumps(colors)
    return vals


def _resolve_console(vals, env=None):
    """Turn a pasted unifi.ui.com URL / console UUID into the connector's console ID."""
    mode = vals.get("mode") or (env["mode"] if env is not None else "local")
    if mode == "cloud" and vals.get("console_id"):
        key = vals.get("api_key") or (env["api_key"] if env is not None else "")
        vals["console_id"] = unifi.UniFi(mode="cloud", api_key=key).resolve_console_id(vals["console_id"])
    return vals


def _safe(vals):
    return {k: ("•••" if k == "api_key" else v) for k, v in vals.items()}


@app.route("/api/admin/envs")
@auth.require("envs.manage")
def api_admin_envs():
    counts = {r["env_id"]: r["n"] for r in db.get().execute(
        "SELECT env_id, COUNT(*) AS n FROM user_env GROUP BY env_id")}
    return jsonify({"envs": [{**envs.public(e, True), "users": counts.get(e["id"], 0)} for e in envs.all_envs()]})


@app.route("/api/admin/envs", methods=["POST"])
@auth.require("envs.manage")
def api_admin_env_create():
    try:
        vals = _env_fields(request.get_json(silent=True) or {}, partial=False)
    except ValueError as e:
        return _deny(str(e))
    vals.setdefault("mode", "local")
    _resolve_console(vals)
    vals["created_at"] = db.now()
    d = db.get()
    cur = d.execute(f"INSERT INTO environments ({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                    list(vals.values()))
    d.commit()
    auth.audit("env.created", vals["name"], _safe(vals), env_id=cur.lastrowid)
    return jsonify({"ok": True, "env": envs.public(envs.get(cur.lastrowid), True)})


@app.route("/api/admin/envs/<int:env_id>", methods=["PUT", "DELETE"])
@auth.require("envs.manage")
def api_admin_env(env_id):
    env = envs.get(env_id)
    if env is None:
        return _deny("No such environment", 404)
    d = db.get()
    if request.method == "DELETE":
        d.execute("DELETE FROM environments WHERE id=?", (env_id,))
        d.commit()
        envs.invalidate(env_id)
        auth.audit("env.deleted", env["name"], env_id=env_id)
        return jsonify({"ok": True})
    try:
        vals = _env_fields(request.get_json(silent=True) or {}, partial=True)
    except ValueError as e:
        return _deny(str(e))
    _resolve_console(vals, env)
    if vals:
        d.execute(f"UPDATE environments SET {', '.join(k + '=?' for k in vals)} WHERE id=?",
                  list(vals.values()) + [env_id])
        d.commit()
        envs.invalidate(env_id)
        auth.audit("env.updated", env["name"], _safe(vals), env_id=env_id)
    return jsonify({"ok": True, "env": envs.public(envs.get(env_id), True)})


def _candidate_client(data):
    """A client from the form, falling back to the saved environment (for its API key)."""
    env = envs.get(int(data["env_id"])) if data.get("env_id") else None
    vals = _env_fields({**data, "name": data.get("name") or "x"}, partial=True)
    vals.pop("name", None)
    _resolve_console(vals, env)
    return envs.client(env, vals)


@app.route("/api/admin/envs/test", methods=["POST"])
@auth.require("envs.manage")
def api_admin_env_test():
    try:
        c = _candidate_client(request.get_json(silent=True) or {})
    except ValueError as e:
        return _deny(str(e))
    steps = None
    if c.mode == "cloud":
        steps = c.diagnose_cloud(c.site)
        bad = [s for s in steps if not s["ok"] and not s.get("warn")]
        if bad:
            return jsonify({"ok": False, "steps": steps, "console_id": c.console_id, "error": bad[0]["detail"]})
        if any(s.get("warn") for s in steps):   # view only through the official API
            try:
                data = unifi.integration_snapshot(c)
            except unifi.UniFiError as e:
                return jsonify({"ok": False, "steps": steps, "console_id": c.console_id, "error": str(e)})
            return jsonify({"ok": True, "readonly": True, "steps": steps, "console_id": c.console_id,
                            "devices": len(data["devices"]), "networks": len(data["networks"]), "sites": []})
    try:
        sites = c.sites()
    except unifi.UniFiError as e:
        return jsonify({"ok": False, "error": str(e)})
    try:
        data = unifi.normalize(c.raw_devices(), c.raw_networks(), [], [], True)
    except unifi.UniFiError as e:
        return jsonify({"ok": False, "sites": sites, "error": f"Connected, but site '{c.site}': {e}"})
    return jsonify({"ok": True, "sites": sites, "devices": len(data["devices"]), "networks": len(data["networks"]),
                    "console_id": c.console_id if c.mode == "cloud" else None, "steps": steps})


@app.route("/api/admin/envs/consoles", methods=["POST"])
@auth.require("envs.manage")
def api_admin_env_consoles():
    try:
        return jsonify({"ok": True, "consoles": _candidate_client(request.get_json(silent=True) or {}).cloud_consoles()})
    except (ValueError, unifi.UniFiError) as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/admin/envs/<int:env_id>/catalog")
@auth.require()
def api_admin_env_catalog(env_id):
    """Networks and devices of an environment, for the access and color editors - limited
    to what the asking person may hand out themselves."""
    me = auth.current()
    env = envs.get(env_id)
    mine = envs.access(me, env_id)
    if env is None or not (perms.has(me, "envs.manage") or (perms.has(me, "users.access") and mine)):
        return _deny("No such environment", 404)
    try:
        data, _ = envs.snapshot(env_id).get(envs.client(env), db.setting_bool("protect_uplinks"))
    except unifi.UniFiError as e:
        return jsonify({"ok": False, "error": str(e), "networks": [], "devices": []})
    return jsonify({"ok": True,
                    "networks": [n for n in data["networks"] if envs.vlan_allowed(mine, n["id"])],
                    "devices": [{k: d[k] for k in ("id", "mac", "name", "model_name", "type_label", "port_count", "online")}
                                for d in data["devices"] if envs.device_allowed(mine, d["mac"])]})


# ----------------------------------------------------------------------------
# Who may use which environment (admin)
# ----------------------------------------------------------------------------

@app.route("/api/users/<int:uid>/access", methods=["GET", "PUT"])
@auth.require("users.access")
def api_user_access(uid):
    me = auth.current()
    user = auth.get_user(uid)
    if user is None or not auth._may_manage(user):
        return _deny("No such user", 404)
    if request.method == "PUT":
        entries = (request.get_json(silent=True) or {}).get("envs") or []
        if not isinstance(entries, list):
            return _deny("envs must be a list")
        if not perms.has(me, "envs.manage"):
            try:
                entries = envs.limit_grant(me, uid, entries)
            except ValueError as e:
                return _deny(str(e), 403)
        envs.set_user_access(uid, entries)
        names = {e["id"]: e["name"] for e in envs.all_envs()}
        auth.audit("user.access", user["username"], {"envs": [
            {"env": names.get(int(e.get("env_id") or 0), "?"),
             "vlans": "all" if e.get("all_vlans", True) else len(e.get("vlans") or []),
             "devices": "all" if e.get("all_devices", True) else len(e.get("devices") or [])} for e in entries]})
    return jsonify({"role": user["role"], "envs": envs.user_access_list(uid)})


# ----------------------------------------------------------------------------
# Startup
# ----------------------------------------------------------------------------

def startup():
    db.init(VERSION)
    with app.app_context():
        secret = os.environ.get("VLANMGR_SECRET_KEY", "").strip() or db.get_setting("flask_secret", "")
        if not secret:
            secret = secrets.token_hex(32)
            db.set_setting("flask_secret", secret)
        app.secret_key = secret
        auth.bootstrap(app)
    print(f"[app] VLAN Manager {VERSION} starting", flush=True)


if __name__ == "__main__":
    startup()
    threading.Thread(target=_update_loop, daemon=True, name="update-check").start()
    from waitress import serve
    port = int(os.environ.get("PORT", "20090"))
    serve(app, host="0.0.0.0", port=port, threads=int(os.environ.get("VLANMGR_THREADS", "8")),
          ident="vlan-manager")
