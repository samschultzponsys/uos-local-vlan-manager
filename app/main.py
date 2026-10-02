#!/usr/bin/env python3
"""
VLAN Manager for UniFi - pick switches, click a port, set its native VLAN.

Flask + SQLite, single container. See README.md.
"""

import copy
import hashlib
import json
import os
import re
import secrets
import threading
import time

from flask import Flask, g, jsonify, redirect, request, send_from_directory

import achievements
import auth
import brand
import db
import envs
import feedback
import integrations
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
feedback.register(app)
achievements.register(app)
feedback.listeners.append(integrations.on_feedback)
versioning.SOURCE = integrations.update_source


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
    # the admin-chosen name, tab icon and logo are in the page itself, so nothing flashes the stock ones
    b = brand.public()
    name = _esc(b["app_name"])
    html = html.replace("VLAN Manager", name)
    html = html.replace('href="/favicon.svg" type="image/svg+xml"', f'href="{_esc(_favicon_href(b))}"')
    if b["logo"].get("src"):
        html = html.replace(f'"/static/{BUILD}/apple-touch-icon.png"', f'"{_esc(b["logo"]["src"])}"')
    html = html.replace("<!--brand-->", "<script>window.__brand = " + json.dumps(b).replace("<", "\\u003c") + ";</script>")
    return app.response_class(html, mimetype="text/html")


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def _favicon_href(b):
    f = b["favicon"]
    return f.get("src") or f"/favicon.svg?v={b['version']}"


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
    b = brand.public()
    name = b["app_name"]
    if b["logo"]["kind"] == "default":
        icons = [
            {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/static/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ]
    elif b["logo"].get("src"):
        icons = [{"src": b["logo"]["src"], "sizes": "256x256", "type": brand.IMAGE_MIME[brand.image_ext("logo")]}]
    else:
        icons = [{"src": f"/brand/logo.svg?v={b['version']}", "sizes": "any", "type": "image/svg+xml"}]
    body = {
        "name": name, "short_name": name[:12], "start_url": "/", "scope": "/", "id": "/",
        "display": "standalone", "orientation": "any",
        "background_color": "#0a0c11", "theme_color": "#0a0c11", "icons": icons,
    }
    resp = app.response_class(json.dumps(body), mimetype="application/manifest+json")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def _svg_response(mark):
    resp = app.response_class(brand.svg(mark), mimetype="image/svg+xml")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'"
    return resp


@app.route("/favicon.svg")
def favicon():
    c = brand.config()
    m = c["logo"] if c["favicon_same"] else c["favicon"]
    if m["kind"] == "default":
        return send_from_directory(STATIC_DIR, "favicon.svg")
    if m["kind"] == "image":   # browsers asking for the old address still get the picture
        return redirect(brand.public()["favicon"].get("src") or "/static/favicon.svg")
    return _svg_response(m)


@app.route("/brand/<which>.svg")
def brand_svg(which):
    if which not in ("logo", "favicon"):
        return _deny("Not found", 404)
    return _svg_response(brand.config()[which])


@app.route("/brand/<which>")
def brand_image(which):
    """An uploaded logo or favicon (public: the sign-in page shows it)."""
    if which not in ("logo", "favicon") or not brand.image_path(which):
        return _deny("Not found", 404)
    p = brand.image_path(which)
    resp = send_from_directory(os.path.dirname(p), os.path.basename(p), mimetype=brand.IMAGE_MIME[brand.image_ext(which)])
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable" if request.args.get("v") else "no-cache"
    resp.headers["Content-Security-Policy"] = "default-src 'none'"
    return resp


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
            with app.app_context():
                db.prune_audit(int(db.get_setting("audit_retention_days") or 0))
        except Exception as e:   # never let the loop die
            print(f"[update-check] {e}", flush=True)
        time.sleep(600)


# ----------------------------------------------------------------------------
# Environments the signed-in user can open
# ----------------------------------------------------------------------------

def public_settings():
    return {
        "app_name": db.get_setting("app_name"),
        "brand": brand.public(),
        "achievements": achievements.enabled(),
        "default_tagged_mode": db.get_setting("default_tagged_mode"),
        "poll_seconds": int(db.get_setting("poll_seconds") or 10),
        "protect_uplinks": db.setting_bool("protect_uplinks"),
    }


def _sees(user, acc, mac, app="network"):
    """May `user` see this device: their role allows its UniFi app, and their access covers it."""
    return perms.has(user, perms.app_cap(app)) and envs.device_allowed(acc, mac, app)


def _app_map(env_id):
    """{mac: UniFi app} for an environment's devices, from the cached snapshot."""
    env = envs.get(env_id)
    try:
        data, _ = envs.snapshot(env_id).get(envs.client(env), db.setting_bool("protect_uplinks"))
    except (unifi.UniFiError, TypeError):
        return {}
    out = {d["mac"]: "network" for d in data["devices"]}
    out.update({a["mac"]: a["app"].lower() for a in data.get("app_devices") or []})
    return out


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
    _shape(out, env, acc, data)
    return jsonify(out)


def _shape(out, env, acc, data):
    """An environment's snapshot as this person may see it."""
    out.update(data)
    out["networks"] = [{**n, "allowed": envs.vlan_allowed(acc, n["id"]),
                        # client counts are site-wide: only for people who see every device
                        "clients": n.get("clients") if acc["all_devices"] else None} for n in data["networks"]]
    me = auth.current()
    out["devices"] = unifi.apply_model_caps([d for d in data["devices"] if _sees(me, acc, d["mac"])],
                                            db.get_json("model_caps", {}))
    out["app_devices"] = [a for a in data.get("app_devices") or [] if _sees(me, acc, a["mac"], a["app"])]
    if not data.get("readonly"):
        envs.annotate_locks(env["id"], out["devices"])
    return out


@app.route("/api/overview")
@auth.require()
def api_overview():
    """Every environment this person can open, devices and ports, for the read-only All devices page.
    Environments are fetched from UniFi in parallel."""
    from concurrent.futures import ThreadPoolExecutor
    me = auth.current()
    pairs = envs.accessible(me)
    protect = db.setting_bool("protect_uplinks")
    force = request.args.get("refresh") == "1"
    clients = [(e, acc, envs.client(e)) for e, acc in pairs]

    def fetch(item):
        e, _, c = item
        if not c.configured():
            return None, "not_configured"
        try:
            return envs.snapshot(e["id"]).get(c, protect, force=force)[0], None
        except unifi.UniFiError as ex:
            return None, str(ex)

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(clients)))) as pool:
        results = list(pool.map(fetch, clients))
    out = []
    for (e, acc, _), (data, error) in zip(clients, results):
        item = {"env": envs.public(e), "access": acc, "networks": [], "devices": [], "app_devices": [], "error": error}
        if data is not None:
            _shape(item, e, acc, data)
        out.append(item)
    return jsonify({"envs": out, "fetched_at": int(time.time())})


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


def _set_port(env_id, device_id, idx, body, action="port.set", via=None, extra=None):
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
        if dev is None or not _sees(auth.current(), acc, dev.get("mac")):
            return _deny("That device is no longer on the controller", 404)
        norm = unifi.normalize(raw_devs, c.raw_networks(), c.raw_portconfs(), [], db.setting_bool("protect_uplinks"))
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    nets = norm["networks"]
    net_ids = [n["id"] for n in nets]
    unifi.apply_model_caps(norm["devices"], db.get_json("model_caps", {}))
    ndev = next((d for d in norm["devices"] if d["id"] == device_id), None)
    port = next((p for p in (ndev or {}).get("ports", []) if p["idx"] == idx), None)
    if port is None:
        return _deny("No such port", 404)
    if port["wan"]:
        return _deny("This is a WAN port - set it up in UniFi's Internet settings", 403)
    if native not in net_ids:
        return _deny("Pick a network from the list")
    if not envs.vlan_allowed(acc, native):
        return _deny("You can't put ports on that network", 403)
    # a switch that can't filter tagged VLANs (e.g. USW Flex Mini): only the native network changes
    native_only = not ndev["caps"]["tagged_vlans"]
    if native_only:
        mode, excluded = port["tagged_mode"], list(port["excluded_network_ids"])
    elif not acc["all_vlans"]:
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
        if (seen[0] != now_[0]) if native_only else (seen != now_):
            return _deny("Changed elsewhere", 409, confirm="changed",
                         current={"native": _net_label(nets, port["native_network_id"]),
                                  "tagged": unifi.MODE_LABEL[port["tagged_mode"]]})

    overrides, before, after = unifi.build_override(dev, idx, native, mode, excluded, net_ids, True, native_only)
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
    if native_only:
        detail["after"].update({"tagged": f"not supported by {ndev['model_name']}", "excluded": []})
    if via:
        detail["via"] = via
    if port["protected"]:
        detail["protected"] = True
    detail.update(extra or {})
    # the exact settings before, so the change can be undone
    detail["undo"] = {"native_network_id": port["native_network_id"], "tagged_mode": port["tagged_mode"],
                      "excluded_network_ids": list(port["excluded_network_ids"])}
    learned = None
    try:
        try:
            c.put_port_overrides(device_id, overrides)
        except unifi.UniFiError as e:
            if native_only or unifi.UNSUPPORTED_TAGGING not in str(e):
                raise
            # UniFi says this switch can't do tagged VLAN management: remember that for the model
            # and set just the native VLAN, which is all the switch can do anyway
            caps = db.get_json("model_caps", {})
            caps[ndev["model"]] = {"tagged_vlans": False, "learned": True}
            db.set_json("model_caps", caps)
            auth.audit("settings.model_caps", ndev["model"], {"tagged_vlans": False, "why": str(e)}, env_id=env_id)
            native_only = True
            mode, excluded = port["tagged_mode"], list(port["excluded_network_ids"])
            overrides, before, after = unifi.build_override(dev, idx, native, mode, excluded, net_ids, True, True)
            detail["after"].update({"tagged": f"not supported by {ndev['model_name']}", "excluded": []})
            learned = (f"{ndev['model_name']} doesn't support tagged VLAN management, so only the native VLAN was set. "
                       f"The app remembers this for every {ndev['model_name']}.")
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
            if unifi.verify_override(c.raw_device(dev.get("mac")), idx, native, mode, native_only):
                verified = True
                break
    except unifi.UniFiError:
        pass
    envs.invalidate(env_id)
    detail["verified"] = verified
    detail["applied"] = {"native_network_id": native, "tagged_mode": mode,
                         "excluded_network_ids": after.get("excluded_networkconf_ids", []) if mode == "custom" else []}
    auth.audit(action, target, detail, ok=True, env_id=env_id)
    return jsonify({"ok": True, "verified": verified, "native_only": native_only,
                    "warning": learned or (None if verified else
                                           "UniFi accepted the change but didn't report it back yet. Refresh in a moment to check.")})


# ----------------------------------------------------------------------------
# Change many ports at once (across switches in one environment)
# ----------------------------------------------------------------------------

@app.route("/api/envs/<int:env_id>/ports/bulk", methods=["PUT"])
@auth.require("ports.change")
def api_bulk_ports(env_id):
    """Set the same native VLAN (and tagging) on many ports. Ports that can't be changed are skipped with
    a reason; protected / locked / profile ports need the same confirmations as one at a time, asked once.
    One write per switch."""
    me = auth.current()
    env, acc, err = _env_or_404(env_id)
    if err:
        return err
    if _readonly(env):
        return _deny(READONLY_MSG, 409)
    body = request.get_json(silent=True) or {}
    picks = body.get("ports") or []
    if not isinstance(picks, list) or not picks:
        return _deny("Pick some ports")
    if len(picks) > 500:
        return _deny("That's too many ports at once")
    native = body.get("native_network_id")
    mode = body.get("tagged_mode") or db.get_setting("default_tagged_mode")
    excluded_in = body.get("excluded_network_ids") or []
    if mode not in unifi.MODES or not isinstance(excluded_in, list):
        return _deny("Pick Allow All, Block All or Custom")
    c = envs.client(env)
    try:
        raw_devs = c.raw_devices()
        norm = unifi.normalize(raw_devs, c.raw_networks(), c.raw_portconfs(), [], db.setting_bool("protect_uplinks"))
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    nets = norm["networks"]
    net_ids = [n["id"] for n in nets]
    if native not in net_ids:
        return _deny("Pick a network from the list")
    if not envs.vlan_allowed(acc, native):
        return _deny("You can't put ports on that network", 403)
    if not acc["all_vlans"] and mode == "auto":
        return _deny("Allow All would tag networks you can't use - pick Block All or Custom", 403)
    unifi.apply_model_caps(norm["devices"], db.get_json("model_caps", {}))
    ndevs = {d["id"]: d for d in norm["devices"]}
    raws = {d.get("_id"): d for d in raw_devs}
    locks = envs.locks(env_id)
    may_protected = perms.has(me, "ports.protected") or bool(env["supervisors_protected"])
    may_lock = perms.has(me, "ports.lock")
    todo, skipped = [], []
    needs = {"protected": [], "locked": [], "profile": []}
    seen = set()
    for pick in picks:
        did, idx = str((pick or {}).get("device_id") or ""), int((pick or {}).get("idx") or 0)
        if (did, idx) in seen:
            continue
        seen.add((did, idx))
        nd = ndevs.get(did)
        label = f"{nd['name']} port {idx}" if nd else f"port {idx}"
        if nd is None or not _sees(me, acc, nd["mac"]):
            skipped.append({"port": label, "reason": "no longer on the controller"})
            continue
        port = next((p for p in nd["ports"] if p["idx"] == idx), None)
        if port is None:
            skipped.append({"port": label, "reason": "no such port"})
            continue
        if port["wan"]:
            skipped.append({"port": label, "reason": "WAN port"})
            continue
        lock = locks.get((nd["mac"], idx))
        if lock and not may_lock:
            skipped.append({"port": label, "reason": "locked by an admin"})
            continue
        if port["protected"] and not may_protected:
            skipped.append({"port": label, "reason": "protected (" + "; ".join(port["protect_reasons"]) + ")"})
            continue
        if lock:
            needs["locked"].append(label)
        if port["protected"]:
            needs["protected"].append(label)
        if port["profile_id"]:
            needs["profile"].append(label)
        todo.append((nd, port, lock, label))
    if not todo:
        return _deny("None of those ports can be changed", 403, skipped=skipped)
    missing = {k: v for k, v in needs.items() if v and not body.get({"protected": "confirm_protected", "locked": "confirm_locked",
                                                                      "profile": "detach_profile"}[k])}
    if missing:
        return _deny("Some ports need a confirmation", 409, confirm="bulk", needs=missing, skipped=skipped, count=len(todo))

    by_dev = {}
    for nd, port, lock, label in todo:
        by_dev.setdefault(nd["id"], []).append((nd, port, lock, label))
    changed, failed, notes = [], [], []
    learned = db.get_json("model_caps", {})
    for did, items in by_dev.items():
        nd = items[0][0]
        native_only = not nd["caps"]["tagged_vlans"]

        def build(native_only):
            dev = copy.deepcopy(raws[did])
            afters = []
            for _, port, _, _ in items:
                if native_only:
                    m, ex = port["tagged_mode"], list(port["excluded_network_ids"])
                else:
                    m = mode
                    ex = list(excluded_in)
                    if not acc["all_vlans"] and m == "custom":   # networks they can't use are never tagged
                        ex = list(set(ex) | {i for i in net_ids if not envs.vlan_allowed(acc, i)})
                overrides, _, after = unifi.build_override(dev, port["idx"], native, m, ex, net_ids, True, native_only)
                dev["port_overrides"] = overrides
                afters.append((m, after))
            return dev["port_overrides"], afters

        overrides, afters = build(native_only)
        try:
            try:
                c.put_port_overrides(did, overrides)
            except unifi.UniFiError as e:
                if native_only or unifi.UNSUPPORTED_TAGGING not in str(e):
                    raise
                learned[nd["model"]] = {"tagged_vlans": False, "learned": True}
                db.set_json("model_caps", learned)
                native_only = True
                notes.append(f"{nd['model_name']} doesn't support tagged VLAN management, so only the native VLAN was set "
                             f"on {nd['name']}. The app remembers this for every {nd['model_name']}.")
                overrides, afters = build(True)
                c.put_port_overrides(did, overrides)
        except unifi.UniFiError as e:
            failed.append({"device": nd["name"], "error": str(e)})
            for _, port, _, label in items:
                auth.audit("port.set", f"{env['name']} / {nd['name']} / port {port['idx']}",
                           {"env": env["name"], "device": nd["name"], "port": port["idx"], "bulk": True, "error": str(e)},
                           ok=False, env_id=env_id)
            continue
        for (_, port, lock, label), (m, after) in zip(items, afters):
            if lock:
                envs.set_lock(env_id, nd["mac"], port["idx"], native, m, after.get("excluded_networkconf_ids", []),
                              lock["note"], me["username"])
            auth.audit("port.set", f"{env['name']} / {nd['name']} / port {port['idx']}", {
                "env": env["name"], "device": nd["name"], "device_id": did, "port": port["idx"], "port_name": port["name"],
                "bulk": True,
                "before": {"native": _net_label(nets, port["native_network_id"]), "tagged": unifi.MODE_LABEL[port["tagged_mode"]],
                           "profile": port["profile_name"]},
                "after": {"native": _net_label(nets, native),
                          "tagged": f"not supported by {nd['model_name']}" if native_only else unifi.MODE_LABEL[m]},
                **({"protected": True} if port["protected"] else {}),
                "undo": {"native_network_id": port["native_network_id"], "tagged_mode": port["tagged_mode"],
                         "excluded_network_ids": list(port["excluded_network_ids"])},
                "applied": {"native_network_id": native, "tagged_mode": m,
                            "excluded_network_ids": after.get("excluded_networkconf_ids", []) if m == "custom" else []},
                **({"lock": "kept, updated to the new settings"} if lock else {})}, env_id=env_id)
            changed.append(label)
    envs.invalidate(env_id)
    return jsonify({"ok": not failed, "changed": changed, "skipped": skipped, "failed": failed, "notes": notes})


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
# Managing devices: rename, locate, LED, restart, firmware, PoE, port names
# ----------------------------------------------------------------------------

READONLY_DEV_MSG = "This environment is view only: UniFi's cloud doesn't allow changes."
DEVICE_ACTIONS = {
    "locate": ("set-locate", "device.locate", "Locate light on"),
    "unlocate": ("unset-locate", "device.locate_off", "Locate light off"),
    "restart": ("restart", "device.restart", "Restarting"),
    "upgrade": ("upgrade", "device.upgrade", "Firmware update started"),
}


class _Ctx:
    pass


def _device_ctx(env_id, device_id, idx=None):
    """Everything a device / port action needs, fresh from UniFi: (ctx, None) or (None, error response)."""
    env, acc, err = _env_or_404(env_id)
    if err:
        return None, err
    if _readonly(env):
        return None, _deny(READONLY_DEV_MSG, 409)
    c = envs.client(env)
    try:
        raw_devs = c.raw_devices()
        dev = next((d for d in raw_devs if d.get("_id") == device_id), None)
        if dev is None or not _sees(auth.current(), acc, dev.get("mac")):
            return None, _deny("That device is no longer on the controller", 404)
        norm = unifi.normalize(raw_devs, c.raw_networks(), c.raw_portconfs(), [], db.setting_bool("protect_uplinks"))
    except unifi.UniFiError as e:
        return None, _deny(str(e), 502)
    x = _Ctx()
    x.env, x.acc, x.c, x.dev = env, acc, c, dev
    x.ndev = next(d for d in norm["devices"] if d["id"] == device_id)
    x.port = None
    x.target = f"{env['name']} / {x.ndev['name']}"
    if idx is not None:
        x.port = next((p for p in x.ndev["ports"] if p["idx"] == idx), None)
        if x.port is None:
            return None, _deny("No such port", 404)
        x.target += f" / port {idx}"
    return x, None


def _power_guard(x, body):
    """PoE changes on a locked or protected port need the matching ability (and a confirmation)."""
    me = auth.current()
    lock = envs.locks(x.env["id"]).get((x.ndev["mac"], x.port["idx"]))
    if lock and not perms.has(me, "ports.lock"):
        return _deny("An admin locked this port" + (f": {lock['note']}" if lock["note"] else ""), 403)
    if x.port["protected"]:
        if not (perms.has(me, "ports.protected") or bool(x.env["supervisors_protected"])):
            return _deny("This port is protected (" + "; ".join(x.port["protect_reasons"]) +
                         "). You don't have permission to change protected ports.", 403)
        if not body.get("confirm_protected"):
            return _deny("Protected port", 409, confirm="protected", reasons=x.port["protect_reasons"])
    return None


@app.route("/api/envs/<int:env_id>/devices/<device_id>", methods=["PUT"])
@auth.require("devices.manage")
def api_device_update(env_id, device_id):
    x, err = _device_ctx(env_id, device_id)
    if err:
        return err
    body = request.get_json(silent=True) or {}
    fields = {}
    if "name" in body:
        name = str(body["name"] or "").strip()[:64]
        if not name:
            return _deny("Give the device a name")
        fields["name"] = name
    if "led_override" in body:
        if body["led_override"] not in ("default", "on", "off"):
            return _deny("LED must be default, on or off")
        fields["led_override"] = body["led_override"]
    if not fields:
        return _deny("Nothing to change")
    try:
        x.c.put_device(device_id, fields)
    except unifi.UniFiError as e:
        auth.audit("device.updated", x.target, {**fields, "error": str(e)}, ok=False, env_id=env_id)
        return _deny(str(e), 502)
    detail = {"env": x.env["name"], "device": x.ndev["name"]}
    if "name" in fields:
        detail["before"], detail["after"] = {"name": x.ndev["name"]}, {"name": fields["name"]}
    if "led_override" in fields:
        detail["led"] = fields["led_override"]
    auth.audit("device.updated", x.target, detail, env_id=env_id)
    envs.invalidate(env_id)
    return jsonify({"ok": True})


@app.route("/api/envs/<int:env_id>/devices/<device_id>/action", methods=["POST"])
@auth.require("devices.manage")
def api_device_action(env_id, device_id):
    return _device_action(env_id, device_id, (request.get_json(silent=True) or {}).get("action"))


def _device_action(env_id, device_id, action, via=None):
    if action not in DEVICE_ACTIONS:
        return _deny("Unknown action")
    x, err = _device_ctx(env_id, device_id)
    if err:
        return err
    if action == "upgrade" and not x.ndev["upgradable"]:
        return _deny("UniFi has no firmware update for this device right now")
    cmd, audit_action, msg = DEVICE_ACTIONS[action]
    detail = {"env": x.env["name"], "device": x.ndev["name"], **({"via": via} if via else {})}
    if action == "upgrade":
        detail["firmware"] = f"{x.ndev['version']} → {x.ndev['upgrade_to'] or 'latest'}"
    try:
        x.c.devmgr(cmd, x.ndev["mac"])
    except unifi.UniFiError as e:
        auth.audit(audit_action, x.target, {**detail, "error": str(e)}, ok=False, env_id=env_id)
        return _deny(str(e), 502)
    auth.audit(audit_action, x.target, detail, env_id=env_id)
    envs.invalidate(env_id)
    return jsonify({"ok": True, "message": msg})


@app.route("/api/envs/<int:env_id>/devices/<device_id>/ports/<int:idx>/settings", methods=["PUT"])
@auth.require()
def api_port_settings(env_id, device_id, idx):
    """A port's name (devices.manage) and PoE on / off (ports.poe)."""
    me = auth.current()
    body = request.get_json(silent=True) or {}
    if "name" in body and not perms.has(me, "devices.manage"):
        return _deny("You can't rename ports", 403)
    if "poe_mode" in body and not perms.has(me, "ports.poe"):
        return _deny("You can't change PoE", 403)
    x, err = _device_ctx(env_id, device_id, idx)
    if err:
        return err
    fields, detail = {}, {"env": x.env["name"], "device": x.ndev["name"], "port": idx}
    if "name" in body:
        name = str(body["name"] or "").strip()[:40]
        fields["name"] = name or None
        detail["before"], detail["after"] = {"name": x.port["name"]}, {"name": name or f"Port {idx}"}
    if "poe_mode" in body:
        if body["poe_mode"] not in unifi.POE_MODES:
            return _deny("PoE must be on (auto) or off")
        if not x.port["poe_capable"]:
            return _deny("This port has no PoE")
        guard = _power_guard(x, body)
        if guard:
            return guard
        fields["poe_mode"] = body["poe_mode"]
        detail["poe"] = f"{x.port['poe_mode']} → {body['poe_mode']}"
    if not fields:
        return _deny("Nothing to change")
    overrides, _, _ = unifi.build_port_patch(x.dev, x.port, fields)
    try:
        x.c.put_port_overrides(device_id, overrides)
    except unifi.UniFiError as e:
        auth.audit("port.settings", x.target, {**detail, "error": str(e)}, ok=False, env_id=env_id)
        return _deny(str(e), 502)
    auth.audit("port.settings", x.target, detail, env_id=env_id)
    envs.invalidate(env_id)
    return jsonify({"ok": True})


@app.route("/api/envs/<int:env_id>/devices/<device_id>/ports/<int:idx>/power-cycle", methods=["POST"])
@auth.require("ports.poe")
def api_port_power_cycle(env_id, device_id, idx):
    return _power_cycle(env_id, device_id, idx, request.get_json(silent=True) or {})


def _power_cycle(env_id, device_id, idx, body, via=None):
    x, err = _device_ctx(env_id, device_id, idx)
    if err:
        return err
    if not x.port["poe_capable"] or not x.port["poe_enabled"]:
        return _deny("PoE is off on this port - nothing to power-cycle")
    guard = _power_guard(x, body)
    if guard:
        return guard
    detail = {"env": x.env["name"], "device": x.ndev["name"], "port": idx, **({"via": via} if via else {})}
    try:
        x.c.devmgr("power-cycle", x.ndev["mac"], port_idx=idx)
    except unifi.UniFiError as e:
        auth.audit("port.power_cycle", x.target, {**detail, "error": str(e)}, ok=False, env_id=env_id)
        return _deny(str(e), 502)
    auth.audit("port.power_cycle", x.target, detail, env_id=env_id)
    envs.invalidate(env_id)
    return jsonify({"ok": True})



# ----------------------------------------------------------------------------
# Change requests: ask for a change you can't make yourself (approved on the Feedback board)
# ----------------------------------------------------------------------------

@app.route("/api/envs/<int:env_id>/requests", methods=["POST"])
@auth.require()
def api_request_create(env_id):
    me = auth.current()
    body = request.get_json(silent=True) or {}
    rtype = body.get("type")
    if rtype not in feedback.REQUEST_TYPES:
        return _deny("Unknown request")
    if not perms.has(me, feedback.REQUEST_TYPES[rtype][0]):
        return _deny("You can't ask for that", 403)
    env, acc, err = _env_or_404(env_id)
    if err:
        return err
    if _readonly(env):
        return _deny(READONLY_MSG, 409)
    try:
        data, _ = envs.snapshot(env_id).get(envs.client(env), db.setting_bool("protect_uplinks"), force=True)
    except unifi.UniFiError as e:
        return _deny(str(e), 502)
    devs = unifi.apply_model_caps([d for d in data["devices"] if d["id"] == body.get("device_id")], db.get_json("model_caps", {}))
    dev = devs[0] if devs else None
    if dev is None or not _sees(me, acc, dev["mac"]):
        return _deny("That device is no longer on the controller", 404)
    reason = str(body.get("reason") or "").strip()[:2000]
    req = {"type": rtype, "env_id": env_id, "env": env["name"], "device_id": dev["id"], "mac": dev["mac"], "device": dev["name"]}
    nets = data["networks"]
    if rtype in ("port", "poe"):
        idx = body.get("port_idx")
        port = next((p for p in dev["ports"] if p["idx"] == idx), None)
        if port is None:
            return _deny("No such port", 404)
        if port["wan"]:
            return _deny("This is a WAN port - set it up in UniFi's Internet settings", 403)
        req.update({"port": idx, "port_name": port["name"]})
    if rtype == "port":
        ch = body.get("change") or {}
        native = ch.get("native_network_id")
        mode = ch.get("tagged_mode") or port["tagged_mode"]
        excluded = ch.get("excluded_network_ids") or []
        if native not in [n["id"] for n in nets]:
            return _deny("Pick a network from the list")
        if not envs.vlan_allowed(acc, native):
            return _deny("You can't put ports on that network", 403)
        if mode not in unifi.MODES or not isinstance(excluded, list):
            return _deny("Pick Allow All, Block All or Custom")
        native_only = not dev["caps"]["tagged_vlans"]
        if native_only:
            mode, excluded = port["tagged_mode"], list(port["excluded_network_ids"])
        elif not acc["all_vlans"]:
            if mode == "auto":
                return _deny("Allow All would tag networks you can't use - pick Block All or Custom", 403)
            if mode == "custom":
                excluded = list(set(excluded) | {n["id"] for n in nets if not envs.vlan_allowed(acc, n["id"])})
        if mode != "custom":
            excluded = []
        if native == port["native_network_id"] and (native_only or (mode == port["tagged_mode"] and (
                mode != "custom" or sorted(excluded) == sorted(port["excluded_network_ids"])))):
            return _deny("That's how the port is set already")
        req["change"] = {"native_network_id": native, "tagged_mode": mode, "excluded_network_ids": excluded}
        frm = f"{_net_label(nets, port['native_network_id'])}" + ("" if native_only else f", {unifi.MODE_LABEL[port['tagged_mode']]}")
        to = f"{_net_label(nets, native)}" + ("" if native_only else f", {unifi.MODE_LABEL[mode]}")
        req.update({"from": frm, "to": to, "protected": port["protected"], "locked": (dev["mac"], idx) in envs.locks(env_id)})
        title = f"Port {idx} on {dev['name']}: {_net_label(nets, port['native_network_id'])} → {_net_label(nets, native)}"
    elif rtype == "poe":
        if not port["poe_capable"] or not port["poe_enabled"]:
            return _deny("PoE is off on this port - nothing to power-cycle")
        who = ", ".join(c.get("name") or c.get("hostname") or c.get("mac") for c in port["clients"][:2])
        req["what"] = who
        title = f"Power-cycle port {idx} on {dev['name']}" + (f" ({who})" if who else "")
    else:
        title = f"Restart {dev['name']}"
    # one open request per thing is enough
    for r in db.get().execute("SELECT id, request FROM feedback WHERE kind='request' AND status='open' AND user_id=?",
                              (me.get("id") or -1,)):
        o = json.loads(r["request"] or "{}")
        if all(o.get(k) == req.get(k) for k in ("type", "env_id", "device_id", "port")):
            return _deny(f"You already asked for this - it's request #{r['id']}, waiting for approval", 409)
    item_id = feedback.create(me, "request", title[:140], reason, request_data=req, env_id=env_id)
    auth.audit("request.new", f"#{item_id}", {"title": title, "env": env["name"]}, env_id=env_id)
    feedback._emit("request", item_id, me)
    return jsonify({"ok": True, "id": item_id})


def _exec_port(req, body, via):
    flags = {k: body[k] for k in ("confirm_locked", "confirm_protected", "detach_profile") if body.get(k)}
    return _set_port(req["env_id"], req["device_id"], req["port"], {**req["change"], **flags}, via=via)


feedback.executors.update({
    "port": _exec_port,
    "poe": lambda req, body, via: _power_cycle(req["env_id"], req["device_id"], req["port"],
                                               {"confirm_protected": bool(body.get("confirm_protected"))}, via=via),
    "restart": lambda req, body, via: _device_action(req["env_id"], req["device_id"], "restart", via=via),
})


@app.route("/api/admin/model-caps", methods=["PUT"])
@auth.require("settings.manage")
def api_model_caps():
    """Tell the app whether a switch model can filter tagged VLANs (null = back to the built-in list)."""
    body = request.get_json(silent=True) or {}
    model = str(body.get("model") or "").strip()[:40]
    if not model:
        return _deny("Which model?")
    val = body.get("tagged_vlans")
    if val is not None and not isinstance(val, bool):
        return _deny("tagged_vlans must be true, false or null")
    caps = db.get_json("model_caps", {})
    if val is None:
        caps.pop(model, None)
    else:
        caps[model] = {"tagged_vlans": val}
    db.set_json("model_caps", caps)
    auth.audit("settings.model_caps", model, {"tagged_vlans": "built-in" if val is None else val})
    return jsonify({"ok": True, "model_caps": caps})


@app.route("/api/admin/model-caps")
@auth.require("settings.manage")
def api_model_caps_get():
    return jsonify({"model_caps": db.get_json("model_caps", {}), "builtin_native_only": sorted(unifi.NATIVE_ONLY_MODELS),
                    "model_names": unifi.MODEL_NAMES})


@app.route("/api/admin/envs/<int:env_id>/diagnostics")
@auth.require("envs.manage")
def api_env_diagnostics(env_id):
    """What UniFi reports for this environment's devices, secrets removed - for troubleshooting a model."""
    env = envs.get(env_id)
    if env is None:
        return _deny("No such environment", 404)
    c = envs.client(env)
    out = {"app_version": versioning.VERSION, "env": {"name": env["name"], "mode": env["mode"],
                                                                "site": env["site"]}}
    for key, fn in (("devices", c.raw_devices), ("app_devices", c.raw_app_devices), ("networks", c.raw_networks),
                    ("port_profiles", c.raw_portconfs)):
        try:
            out[key] = unifi.redact(fn())
        except unifi.UniFiError as e:
            out[key] = {"error": str(e)}
    resp = jsonify(out)
    name = "".join(ch if ch.isalnum() else "-" for ch in env["name"]).strip("-") or "environment"
    resp.headers["Content-Disposition"] = f'attachment; filename="vlanmgr-{name}-diagnostics.json"'
    return resp


# ----------------------------------------------------------------------------
# Audit log
# ----------------------------------------------------------------------------

# what each "kind" filter in the activity log covers
AUDIT_KINDS = {
    "ports": ["port.%"], "devices": ["device.%"], "people": ["user.%", "token.%", "login.%", "role.%"],
    "settings": ["settings.%", "env.%", "github.%"], "feedback": ["feedback.%", "request.%"],
}


def _audit_scope(me):
    """(where, args) limiting the log to what this person may see."""
    if perms.has(me, "settings.manage"):
        return [], []
    # everyone but admins: port changes in their own environments
    ids = [e["id"] for e, _ in envs.accessible(me)] or [-1]
    return ["a.action LIKE 'port.%' AND a.env_id IN (" + ",".join("?" * len(ids)) + ")"], ids


@app.route("/api/audit")
@auth.require("activity.view")
def api_audit():
    """The activity log, newest first (or oldest first with order=asc), filtered by person, dates,
    kind and text; `before` / `after` (an id) page through it."""
    me = auth.current()
    a = request.args
    limit = max(1, min(500, int(a.get("limit") or 200)))
    asc = a.get("order") == "asc"
    where, args = _audit_scope(me)
    scope_where, scope_args = list(where), list(args)
    if a.get("before"):
        where.append("a.id < ?")
        args.append(int(a["before"]))
    if a.get("after"):
        where.append("a.id > ?")
        args.append(int(a["after"]))
    if a.get("user"):
        u = a["user"]
        # someone viewing as another person is logged as "admin (as vera)": both names find it
        where.append("(a.username = ? OR a.username LIKE ? OR a.username LIKE ?)")
        args += [u, f"{u} (as %)", f"% (as {u})"]
    for key, op in (("since", ">="), ("until", "<")):
        if a.get(key):
            where.append(f"a.ts {op} ?")
            args.append(int(a[key]))
    if a.get("kind") in AUDIT_KINDS:
        pats = AUDIT_KINDS[a["kind"]]
        where.append("(" + " OR ".join("a.action LIKE ?" for _ in pats) + ")")
        args += pats
    if a.get("q"):
        where.append("(a.username LIKE ? OR a.target LIKE ? OR a.detail LIKE ? OR a.action LIKE ? OR e.name LIKE ?)")
        args += [f"%{a['q']}%"] * 5
    q = ("SELECT a.*, e.name AS env_name FROM audit a LEFT JOIN environments e ON e.id = a.env_id"
         + (" WHERE " + " AND ".join(where) if where else "") + f" ORDER BY a.id {'ASC' if asc else 'DESC'} LIMIT ?")
    conn = db.get()
    rows = conn.execute(q, args + [limit + 1]).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    # which changes were undone, and by which entry
    undone = {}
    for r in conn.execute("SELECT id, detail FROM audit WHERE action='port.undo' AND ok=1 ORDER BY id DESC LIMIT 2000"):
        of = json.loads(r["detail"] or "{}").get("undo_of")
        if of:
            undone.setdefault(of, r["id"])
    out = {"entries": [{**dict(r), "detail": json.loads(r["detail"] or "{}"), "ok": bool(r["ok"]),
                        "undone_by": undone.get(r["id"])} for r in rows], "has_more": more}
    if a.get("meta"):
        sw = " WHERE " + " AND ".join(scope_where) if scope_where else ""
        names = {r[0] for r in conn.execute(f"SELECT DISTINCT a.username FROM audit a{sw}", scope_args)}
        # "admin (as vera)" counts for both people
        people = set()
        for n in names:
            m = re.match(r"^(.*) \(as (.*)\)$", n or "")
            people |= {m.group(1), m.group(2)} if m else {n}
        out["people"] = sorted(p for p in people if p and p != "?")
        out["oldest"] = conn.execute(f"SELECT MIN(a.ts) FROM audit a{sw}", scope_args).fetchone()[0]
        out["retention_days"] = int(db.get_setting("audit_retention_days") or 0)
        out["can_retention"] = perms.has(me, "system.manage")
        if out["can_retention"]:
            out["log_count"], out["log_size"] = db.audit_size()   # ("entries" is the list itself)
            out["db_size"] = db.db_size()
    return jsonify(out)


@app.route("/api/admin/storage")
@auth.require("system.manage")
def api_storage():
    """How much the data folder uses and on what, and how full the disk under it is."""
    import shutil
    d = db.DATA_DIR
    parts = []
    tables = db.table_sizes()
    db_total = db.db_size()
    if tables:
        free_pages = max(0, db_total - sum(tables.values()))
        labels = {"activity": "Activity log", "feedback": "Feedback and requests",
                  "people": "People, sign-ins and roles", "other": "Settings and environments"}
        for k in ("activity", "feedback", "people", "other"):
            parts.append({"key": f"db.{k}", "label": labels[k], "bytes": tables[k], "group": "Database"})
        if free_pages > 4096:
            parts.append({"key": "db.free", "label": "Free space inside the database", "bytes": free_pages, "group": "Database"})
    else:
        parts.append({"key": "db", "label": "Database", "bytes": db_total, "group": "Database"})
    for key, folder, label in (("files.feedback", "feedback", "Feedback screenshots"), ("files.avatars", "avatars", "Profile pictures"),
                               ("files.brand", "brand", "Logo and tab icon"), ("files.backups", "backups", "Upgrade backups")):
        n, size = db.folder_size(os.path.join(d, folder))
        parts.append({"key": key, "label": label, "bytes": size, "files": n, "group": "Files"})
    backups = sorted((f for f in os.listdir(db.BACKUP_DIR)) if os.path.isdir(db.BACKUP_DIR) else [])
    try:
        du = shutil.disk_usage(d)
        disk = {"total": du.total, "used": du.used, "free": du.free}
    except OSError:
        disk = None
    return jsonify({"parts": parts, "total": sum(p["bytes"] for p in parts), "database": db_total,
                    "backups_kept": db.BACKUPS_KEPT, "backups": len([b for b in backups if b.endswith(".db")]),
                    "disk": disk, "data_dir": d})


@app.route("/api/audit/retention", methods=["PUT"])
@auth.require("system.manage")
def api_audit_retention():
    try:
        days = max(0, min(3650, int((request.get_json(silent=True) or {}).get("days") or 0)))
    except (TypeError, ValueError):
        return _deny("Days is a number (0 keeps everything)")
    db.set_setting("audit_retention_days", str(days))
    removed = db.prune_audit(days)
    if removed:   # give the space back to the disk now (the daily pruning just reuses it)
        try:
            db.get().execute("VACUUM")
        except Exception as e:   # busy: the space is reused anyway
            print(f"[audit] vacuum skipped: {e}", flush=True)
    auth.audit("settings.audit_retention", "", {"days": days or "forever", "removed": removed})
    count, size = db.audit_size()
    return jsonify({"ok": True, "removed": removed, "log_count": count, "log_size": size, "db_size": db.db_size()})


@app.route("/api/audit/<int:aid>/undo", methods=["POST"])
@auth.require("ports.change")
def api_audit_undo(aid):
    """Put a port back the way it was before a logged change, with the same checks as any change."""
    r = db.get().execute("SELECT * FROM audit WHERE id=?", (aid,)).fetchone()
    me = auth.current()
    if not r:
        return _deny("That entry is gone", 404)
    where, args = _audit_scope(me)
    if where and not db.get().execute("SELECT 1 FROM audit a WHERE a.id=? AND " + " AND ".join(where), [aid] + args).fetchone():
        return _deny("That entry is gone", 404)
    d = json.loads(r["detail"] or "{}")
    if r["action"] not in ("port.set", "port.undo") or not r["ok"]:
        return _deny("Only port changes that went through can be undone")
    if not (d.get("undo") and d.get("device_id") and r["env_id"]):
        return _deny("This change was made before undo existed, so its exact previous settings weren't kept")
    for x in db.get().execute("SELECT detail FROM audit WHERE action='port.undo' AND ok=1 AND detail LIKE ?", (f'%"undo_of": {aid}%',)):
        if json.loads(x["detail"] or "{}").get("undo_of") == aid:
            return _deny("This change was already undone")
    body = request.get_json(silent=True) or {}
    applied = d.get("applied")
    if applied and not body.get("confirm_changed"):
        env, acc, err = _env_or_404(r["env_id"])
        if err:
            return err
        try:
            data, _ = envs.snapshot(env["id"]).get(envs.client(env), db.setting_bool("protect_uplinks"), force=True)
        except unifi.UniFiError as e:
            return _deny(str(e), 502)
        dev = next((x for x in data["devices"] if x["id"] == d["device_id"]), None)
        port = dev and next((p for p in dev["ports"] if p["idx"] == d["port"]), None)
        if port:
            def key(c):
                return (c["native_network_id"], c["tagged_mode"],
                        sorted(c["excluded_network_ids"]) if c["tagged_mode"] == "custom" else [])
            if key(port) != key(applied):
                return _deny("Changed since", 409, confirm="changed",
                             current={"native": _net_label(data["networks"], port["native_network_id"]),
                                      "tagged": unifi.MODE_LABEL[port["tagged_mode"]]})
    flags = {k: body[k] for k in ("confirm_locked", "confirm_protected", "detach_profile") if body.get(k)}
    return _set_port(r["env_id"], d["device_id"], d["port"], {**d["undo"], **flags}, action="port.undo",
                     via=f"undo of a change by {r['username']}", extra={"undo_of": aid})


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


@app.route("/api/settings/integrations")
@auth.require("system.manage")
def api_integrations():
    return jsonify({**integrations.public_config(), "events": integrations.EVENT_LABEL,
                    "default_update_repo": versioning.REPO})


@app.route("/api/settings/integrations", methods=["PUT"])
@auth.require("system.manage")
def api_integrations_put():
    data = request.get_json(silent=True) or {}
    try:
        integrations.save(data)
    except ValueError as e:
        return _deny(str(e))
    # what changed, never the secrets themselves
    auth.audit("settings.integrations", "", {k: sorted(x for x in v if x not in integrations.SECRET.get(k, []))
                                             for k, v in data.items() if isinstance(v, dict)})
    return jsonify({"ok": True, **integrations.public_config()})


@app.route("/api/settings/integrations/test", methods=["POST"])
@auth.require("system.manage")
def api_integrations_test():
    data = request.get_json(silent=True) or {}
    ch = data.get("channel")
    vals = data.get("settings") or {}
    try:
        if ch == "github":
            repo = (vals.get("repo") or vals.get("update_repo") or versioning.REPO).strip().strip("/")
            return jsonify({"ok": True, **integrations.gh_test(repo, (vals.get("token") or "").strip() or integrations.gh_token() or "")})
        if ch not in integrations.CHANNELS:
            return _deny("Unknown channel")
        integrations.send_test(ch, vals)
    except ValueError as e:
        return _deny(str(e))
    except Exception as e:
        return _deny(str(e), 502)
    return jsonify({"ok": True})


@app.route("/api/settings/integrations/github/sync", methods=["POST"])
@auth.require("system.manage")
def api_github_sync():
    """Pull GitHub's side now; with {"push": true} also send bugs / ideas that aren't on GitHub yet."""
    gh = integrations.config()["github"]
    if not (gh["sync"] and gh["token"] and gh["repo"]):
        return _deny("Turn on issue sync with a token and a repository first (and save)")
    sent, failed = 0, None
    try:
        if (request.get_json(silent=True) or {}).get("push"):
            rows = db.get().execute("SELECT * FROM feedback WHERE github_issue=0 AND kind IN (%s) ORDER BY id"
                                    % ",".join("?" * len(gh["kinds"])), gh["kinds"]).fetchall() if gh["kinds"] else []
            for r in rows:
                integrations.gh_push_item(dict(r), auth.external_base())
                sent += 1
        pulled = integrations.gh_pull()
    except Exception as e:
        failed = str(e)
        pulled = {"status": 0, "comments": 0}
    auth.audit("github.sync", gh["repo"], {"sent": sent, **pulled, **({"error": failed} if failed else {})}, ok=not failed)
    if failed:
        return _deny(failed, 502)
    return jsonify({"ok": True, "sent": sent, **pulled})


@app.route("/api/settings/brand")
@auth.require("settings.manage")
def api_brand():
    return jsonify({**brand.config(), "app_name": db.get_setting("app_name") or "VLAN Manager",
                    "icons": brand.ICONS, "palettes": brand.PALETTES, "public": brand.public()})


@app.route("/api/settings/brand", methods=["PUT"])
@auth.require("settings.manage")
def api_brand_put():
    data = request.get_json(silent=True) or {}
    try:
        if "app_name" in data:
            db.set_setting("app_name", (str(data["app_name"] or "").strip() or "VLAN Manager")[:40])
        brand.save(data)
    except ValueError as e:
        return _deny(str(e))
    auth.audit("settings.brand", "", {k: data[k] for k in ("app_name", "tagline") if k in data})
    return jsonify({"ok": True, "brand": brand.public()})


@app.route("/api/settings/brand/image/<which>", methods=["PUT"])
@auth.require("settings.manage")
def api_brand_image(which):
    data = request.get_json(silent=True) or {}
    try:
        brand.save_image(which, data.get("image"))
    except ValueError as e:
        return _deny(str(e))
    auth.audit("settings.brand", "", {"image": which})
    return jsonify({"ok": True, "brand": brand.public()})


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
    keys = ("id", "mac", "name", "model_name", "type_label", "port_count", "online")
    devices = [{**{k: d[k] for k in keys}, "app": "Network"} for d in data["devices"] if _sees(me, mine, d["mac"])]
    devices += [{"id": a["mac"], "mac": a["mac"], "name": a["name"], "model_name": a["model"], "type_label": a["app"],
                 "port_count": 0, "online": a["online"], "app": a["app"]}
                for a in data.get("app_devices") or [] if _sees(me, mine, a["mac"], a["app"])]
    # "every device of an app" choices this person can hand out
    apps = [t for t in ("network", "protect", "access", "other")
            if perms.has(me, f"apps.{t}") and (mine["all_devices"] or f"app:{t}" in mine["devices"])]
    return jsonify({"ok": True, "networks": [n for n in data["networks"] if envs.vlan_allowed(mine, n["id"])],
                    "devices": devices, "apps": apps})


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
                entries = envs.limit_grant(me, uid, entries, _app_map)
            except ValueError as e:
                return _deny(str(e), 403)
        envs.set_user_access(uid, entries)
        auth.clear_pending(uid)
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
    integrations.start_sync()
    from waitress import serve
    port = int(os.environ.get("PORT", "20090"))
    serve(app, host="0.0.0.0", port=port, threads=int(os.environ.get("VLANMGR_THREADS", "8")),
          ident="vlan-manager")
