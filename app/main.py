#!/usr/bin/env python3
"""
VLAN Manager for UniFi - pick switches, click a port, set its native VLAN.

Flask + SQLite, single container. See README.md.
"""

import json
import os
import re
import secrets
import threading
import time

from flask import Flask, g, jsonify, redirect, request, send_from_directory

import auth
import db
import unifi
import versioning
from versioning import VERSION, CHANGELOG

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

app = Flask(__name__, static_folder=None)
app.config.update(SESSION_COOKIE_NAME="vlanmgr_flow", SESSION_COOKIE_HTTPONLY=True,
                  SESSION_COOKIE_SAMESITE="Lax", MAX_CONTENT_LENGTH=1024 * 1024)
app.secret_key = secrets.token_hex(32)
auth.init_app(app)
snapshot = unifi.Snapshot(ttl=5)


@app.teardown_appcontext
def _close_db(exc):
    db.close()


def _deny(msg, code=400, **extra):
    return jsonify({"ok": False, "error": msg, **extra}), code


def client_from(values=None):
    s = {k: db.get_setting(k) for k in ("unifi_mode", "unifi_host", "unifi_api_key", "unifi_site",
                                         "unifi_console_id", "unifi_verify_ssl")}
    s.update({k: v for k, v in (values or {}).items() if v is not None})
    return unifi.UniFi(mode=s["unifi_mode"], host=s["unifi_host"], api_key=s["unifi_api_key"],
                       site=s["unifi_site"], console_id=s["unifi_console_id"],
                       verify_ssl=str(s["unifi_verify_ssl"]) in ("1", "true", "True"))


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


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/login")
def login_page():
    u = auth.current()
    if u and u["method"] != "none":
        return redirect(auth._safe_next(request.args.get("next")))
    return send_from_directory(STATIC_DIR, "login.html")


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
    return jsonify({"version": VERSION, "changelog": CHANGELOG,
                    "update": versioning.status(db.setting_bool("update_check"))})


@app.route("/api/version/check", methods=["POST"])
@auth.require("admin")
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
# State
# ----------------------------------------------------------------------------

def public_settings():
    return {
        "app_name": db.get_setting("app_name"),
        "default_tagged_mode": db.get_setting("default_tagged_mode"),
        "poll_seconds": int(db.get_setting("poll_seconds") or 15),
        "protect_uplinks": db.setting_bool("protect_uplinks"),
        "vlan_colors": db.get_json("vlan_colors", {}),
        "unifi_configured": client_from().configured(),
        "unifi_mode": db.get_setting("unifi_mode"),
        "unifi_site": db.get_setting("unifi_site"),
    }


@app.route("/api/state")
@auth.require("viewer")
def api_state():
    out = {"settings": public_settings(), "networks": [], "devices": [], "error": None}
    c = client_from()
    if not c.configured():
        out["error"] = "not_configured"
        return jsonify(out)
    try:
        data, _ = snapshot.get(c, db.setting_bool("protect_uplinks"), force=request.args.get("refresh") == "1")
        out.update(data)
    except unifi.UniFiError as e:
        out["error"] = str(e)
    return jsonify(out)


# ----------------------------------------------------------------------------
# Change a port
# ----------------------------------------------------------------------------

def _net_label(nets, nid):
    n = next((x for x in nets if x["id"] == nid), None)
    return f"{n['name']} ({n['vlan']})" if n else (nid or "?")


@app.route("/api/devices/<device_id>/ports/<int:idx>", methods=["PUT"])
@auth.require("supervisor")
def api_set_port(device_id, idx):
    me = auth.current()
    body = request.get_json(silent=True) or {}
    native = body.get("native_network_id")
    mode = body.get("tagged_mode") or db.get_setting("default_tagged_mode")
    excluded = body.get("excluded_network_ids") or []
    if mode not in unifi.MODES:
        return _deny("Pick Allow All, Block All or Custom")
    if not isinstance(excluded, list):
        return _deny("excluded_network_ids must be a list")
    c = client_from()
    try:
        raw_devs = c.raw_devices()
        dev = next((d for d in raw_devs if d.get("_id") == device_id), None)
        if dev is None:
            return _deny("That device is no longer on the controller", 404)
        raw_nets = c.raw_networks()
        raw_profiles = c.raw_portconfs()
        norm = unifi.normalize(raw_devs, raw_nets, raw_profiles, [], db.setting_bool("protect_uplinks"))
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    nets = norm["networks"]
    ndev = next((d for d in norm["devices"] if d["id"] == device_id), None)
    port = next((p for p in (ndev or {}).get("ports", []) if p["idx"] == idx), None)
    if port is None:
        return _deny("No such port", 404)
    net_ids = [n["id"] for n in nets]
    if native not in net_ids:
        return _deny("Pick a network from the list")
    if port["protected"]:
        if not auth.role_at_least(me["role"], "admin"):
            return _deny("This port is protected (" + "; ".join(port["protect_reasons"]) +
                         "). Only an admin can change it.", 403)
        if not body.get("confirm_protected"):
            return _deny("Protected port", 409, confirm="protected", reasons=port["protect_reasons"])
    if port["profile_id"] and not body.get("detach_profile"):
        return _deny("Port profile attached", 409, confirm="profile", profile=port["profile_name"])

    overrides, before, after = unifi.build_override(dev, idx, native, mode, excluded, net_ids, True)
    target = f"{ndev['name']} / port {idx}"
    detail = {
        "device": ndev["name"], "device_id": device_id, "port": idx, "port_name": port["name"],
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
        auth.audit("port.set", target, {**detail, "error": str(e)}, ok=False)
        return _deny(str(e), 502)
    verified = False
    try:
        for _ in range(3):
            time.sleep(0.6)
            if unifi.verify_override(c.raw_device(dev.get("mac")), idx, native, mode):
                verified = True
                break
    except unifi.UniFiError:
        pass
    snapshot.invalidate()
    detail["verified"] = verified
    auth.audit("port.set", target, detail, ok=True)
    return jsonify({"ok": True, "verified": verified,
                    "warning": None if verified else
                    "UniFi accepted the change but didn't report it back yet. Refresh in a moment to check."})


# ----------------------------------------------------------------------------
# Audit log
# ----------------------------------------------------------------------------

@app.route("/api/audit")
@auth.require("supervisor")
def api_audit():
    limit = max(1, min(500, int(request.args.get("limit") or 200)))
    before = int(request.args.get("before") or 0)
    q = "SELECT * FROM audit"
    args = []
    if before:
        q += " WHERE id < ?"
        args.append(before)
    if not auth.role_at_least(auth.current()["role"], "admin"):
        q += (" AND" if before else " WHERE") + " action LIKE 'port.%'"
    q += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    rows = db.get().execute(q, args).fetchall()
    return jsonify({"entries": [{**dict(r), "detail": json.loads(r["detail"] or "{}"), "ok": bool(r["ok"])}
                                for r in rows]})


# ----------------------------------------------------------------------------
# Settings (admin)
# ----------------------------------------------------------------------------

@app.route("/api/settings")
@auth.require("admin")
def api_settings():
    out = public_settings()
    for k in ("unifi_mode", "unifi_host", "unifi_site", "unifi_console_id"):
        out[k] = db.get_setting(k)
    out["unifi_verify_ssl"] = db.setting_bool("unifi_verify_ssl")
    out["unifi_api_key_set"] = bool(db.get_setting("unifi_api_key"))
    out["update_check"] = db.setting_bool("update_check")
    out["update_allowed"] = versioning.UPDATE_ALLOWED
    return jsonify(out)


def _unifi_candidate(data):
    vals = {}
    for k in ("unifi_mode", "unifi_host", "unifi_site", "unifi_console_id"):
        if k in data:
            vals[k] = str(data[k] or "").strip()
    if "unifi_verify_ssl" in data:
        vals["unifi_verify_ssl"] = "1" if data["unifi_verify_ssl"] else "0"
    if data.get("unifi_api_key"):
        vals["unifi_api_key"] = str(data["unifi_api_key"]).strip()
    if vals.get("unifi_mode") and vals["unifi_mode"] not in ("local", "cloud"):
        raise ValueError("Mode must be local or cloud")
    return vals


@app.route("/api/settings", methods=["PUT"])
@auth.require("admin")
def api_settings_put():
    data = request.get_json(silent=True) or {}
    try:
        vals = _unifi_candidate(data)
    except ValueError as e:
        return _deny(str(e))
    if data.get("clear_unifi_api_key"):
        vals["unifi_api_key"] = ""
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
    if "vlan_colors" in data:
        colors = data["vlan_colors"] or {}
        if not isinstance(colors, dict) or not all(isinstance(v, str) and HEX.match(v) for v in colors.values()):
            return _deny("Colors must be #rrggbb")
        vals["vlan_colors"] = json.dumps(colors)
    for k, v in vals.items():
        db.set_setting(k, v)
    snapshot.invalidate()
    auth.audit("settings.app", "", {k: ("•••" if k == "unifi_api_key" else v) for k, v in vals.items()})
    return jsonify({"ok": True})


@app.route("/api/settings/unifi/test", methods=["POST"])
@auth.require("admin")
def api_unifi_test():
    data = request.get_json(silent=True) or {}
    try:
        c = client_from(_unifi_candidate(data))
    except ValueError as e:
        return _deny(str(e))
    try:
        sites = c.sites()
    except unifi.UniFiError as e:
        return jsonify({"ok": False, "error": str(e)})
    try:
        data = unifi.normalize(c.raw_devices(), c.raw_networks(), [], [], True)
    except unifi.UniFiError as e:
        return jsonify({"ok": False, "sites": sites, "error": f"Connected, but site '{c.site}': {e}"})
    return jsonify({"ok": True, "sites": sites, "devices": len(data["devices"]),
                    "networks": len(data["networks"])})


@app.route("/api/settings/unifi/consoles", methods=["POST"])
@auth.require("admin")
def api_unifi_consoles():
    data = request.get_json(silent=True) or {}
    try:
        c = client_from(_unifi_candidate(data))
        return jsonify({"ok": True, "consoles": c.cloud_consoles()})
    except (ValueError, unifi.UniFiError) as e:
        return jsonify({"ok": False, "error": str(e)})


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
