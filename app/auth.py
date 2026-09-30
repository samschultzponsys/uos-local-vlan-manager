"""
Sign-in, users, roles and sessions.

Roles (highest first):
    admin       everything: users, settings, UniFi connection, protected ports
    supervisor  change port VLANs, read the audit log
    viewer      read-only

The first user (`admin`, created on first start with a random password printed
in the container log) is the only one that starts as admin. Every other user -
added by hand or created by an SSO sign-in - starts as viewer.

Methods (Settings -> Authentication; any combination):
    local   username + password
    oidc    OpenID Connect (Authentik, Authelia, Keycloak, ...). With auto
            sign-in on, visiting the app goes straight to the provider;
            /login always shows the login page, so it's the failover.
    token   personal API tokens: `Authorization: Bearer <token>` for scripts,
            or `?token=<token>` once in a browser (becomes a normal session)
    no-auth anyone who can reach the app acts as the "anonymous role". Admins
            can still sign in at /login. Shown with a red banner everywhere.

Sessions are server-side (so role changes and sign-outs apply at once) and
last `session_days` (default 30) from the last visit. For SSO this is the
app's own session: the identity provider is only asked at sign-in.

Environment overrides / recovery:
    VLANMGR_NO_AUTH=true|false       force no-auth on or off
    VLANMGR_FORCE_LOCAL_LOGIN=true   always allow password sign-in (locked out of SSO)
    VLANMGR_RESET_ADMIN=true         new random password for the first admin
                                     (printed in the log); remove after one start
    VLANMGR_PUBLIC_URL               external URL (for the OIDC redirect URI)
    VLANMGR_TRUSTED_PROXIES          CIDRs whose X-Forwarded-* headers are trusted
    VLANMGR_COOKIE_SECURE=true       HTTPS-only session cookie
"""

import copy
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
import time
from functools import wraps
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

import requests
from flask import g, jsonify, redirect, request
from werkzeug.security import check_password_hash, generate_password_hash

import db

ROLES = ("viewer", "supervisor", "admin")
RANK = {r: i for i, r in enumerate(ROLES)}
COOKIE = "vlanmgr_session"
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")
MIN_PASSWORD = 8
PRIVATE = "127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7"
TOKEN_PREFIX = "vm_"

DEFAULT_OIDC = {
    "issuer": "", "discovery_url": "", "client_id": "", "client_secret": "",
    "scopes": "openid profile email", "redirect_uri": "",
    "groups_claim": "groups", "allowed_groups": "",
    "auto_create": True,
}
DEFAULT_BUTTON = {
    "text": "Sign in with SSO", "bg": "#fd4b2d", "fg": "#ffffff",
    "icon": "key", "icon_url": "",
}
DEFAULT_AUTH = {
    "local_enabled": True,
    "oidc_enabled": False,
    "oidc_auto_login": False,
    "token_enabled": True,
    "no_auth": False,
    "anonymous_role": "admin",
    "session_days": 30,
    "cookie_secure": False,
    "trusted_proxies": PRIVATE,
    "public_url": "",
    "oidc": DEFAULT_OIDC,
    "oidc_button": DEFAULT_BUTTON,
}
BUTTON_ICONS = ("none", "key", "shield", "lock", "login", "authentik", "custom")

PUBLIC_PATHS = {"/login", "/healthz", "/favicon.svg", "/api/auth/config", "/api/auth/login",
                "/auth/oidc/login", "/auth/oidc/callback", "/api/version",
                "/manifest.webmanifest"}
PUBLIC_PREFIXES = ("/static/",)

_oauth = None
_oauth_sig = None
_app = None
_lock = threading.RLock()
_fail_lock = threading.Lock()
_failures = {}
FAIL_LIMIT, FAIL_WINDOW = 10, 15 * 60


def _env(name):
    return os.environ.get(name, "").strip()


def _truthy(v):
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _log(msg):
    print(f"[auth] {msg}", flush=True)


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def new_password():
    alphabet = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ2345679"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


def role_at_least(role, need):
    return RANK.get(role, -1) >= RANK[need]


# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

def stored_config():
    raw = db.get_json("auth", {})
    cfg = copy.deepcopy(DEFAULT_AUTH)
    cfg.update({k: v for k, v in raw.items() if k in DEFAULT_AUTH})
    cfg["oidc"] = {**DEFAULT_OIDC, **(raw.get("oidc") or {})}
    cfg["oidc_button"] = {**DEFAULT_BUTTON, **(raw.get("oidc_button") or {})}
    return cfg


def config():
    """Stored config with environment overrides applied. `locked` lists the
    fields the environment controls."""
    cfg = stored_config()
    locked = []
    if _env("VLANMGR_NO_AUTH"):
        cfg["no_auth"] = _truthy(_env("VLANMGR_NO_AUTH"))
        locked.append("no_auth")
    if _truthy(_env("VLANMGR_FORCE_LOCAL_LOGIN")):
        cfg["local_enabled"] = True
        locked.append("local_enabled")
    if _env("VLANMGR_PUBLIC_URL"):
        cfg["public_url"] = _env("VLANMGR_PUBLIC_URL")
        locked.append("public_url")
    if _env("VLANMGR_TRUSTED_PROXIES"):
        cfg["trusted_proxies"] = _env("VLANMGR_TRUSTED_PROXIES")
        locked.append("trusted_proxies")
    if _env("VLANMGR_COOKIE_SECURE"):
        cfg["cookie_secure"] = _truthy(_env("VLANMGR_COOKIE_SECURE"))
        locked.append("cookie_secure")
    cfg["public_url"] = (cfg["public_url"] or "").rstrip("/")
    cfg["locked"] = locked
    return cfg


def oidc_ready(cfg=None):
    cfg = cfg or config()
    o = cfg["oidc"]
    return bool((o["issuer"] or o["discovery_url"]) and o["client_id"])


def discovery_url(o):
    return o["discovery_url"] or (f"{o['issuer'].rstrip('/')}/.well-known/openid-configuration"
                                  if o["issuer"] else "")


def _ensure_oauth(cfg):
    global _oauth, _oauth_sig
    o = cfg["oidc"]
    sig = (discovery_url(o), o["client_id"], o["client_secret"], o["scopes"])
    with _lock:
        if sig == _oauth_sig and _oauth is not None:
            return _oauth
        from authlib.integrations.flask_client import OAuth
        if _oauth is None:
            _oauth = OAuth(_app)
        _oauth.register("idp", overwrite=True, server_metadata_url=sig[0],
                        client_id=o["client_id"], client_secret=o["client_secret"] or None,
                        client_kwargs={"scope": o["scopes"] or "openid profile email",
                                       "code_challenge_method": "S256"})
        _oauth_sig = sig
        return _oauth


# ----------------------------------------------------------------------------
# Client IP (for the audit log and rate limiting)
# ----------------------------------------------------------------------------

def _ip(value):
    v = (value or "").strip()
    if v.startswith("[") and "]" in v:
        v = v[1:v.index("]")]
    elif v.count(":") == 1:
        v = v.split(":")[0]
    try:
        a = ipaddress.ip_address(v)
    except ValueError:
        return None
    return a.ipv4_mapped if a.version == 6 and a.ipv4_mapped else a


def _nets(raw):
    out = []
    for tok in str(raw or "").replace(";", ",").replace("\n", ",").split(","):
        try:
            out.append(ipaddress.ip_network(tok.strip(), strict=False))
        except ValueError:
            pass
    return out


def _in(addr, nets):
    return addr is not None and any(addr.version == n.version and addr in n for n in nets)


def client_ip():
    """X-Forwarded-For is honored only from a trusted proxy, read right to left."""
    trusted = _nets(config()["trusted_proxies"])
    peer = _ip(request.remote_addr)
    if not _in(peer, trusted):
        return str(peer or "")
    addr = peer
    for h in reversed([h for h in request.headers.get("X-Forwarded-For", "").split(",") if h.strip()]):
        a = _ip(h)
        if a is None:
            break
        addr = a
        if not _in(a, trusted):
            break
    return str(addr or "")


def external_base():
    cfg = config()
    if cfg["public_url"]:
        return cfg["public_url"]
    if _in(_ip(request.remote_addr), _nets(cfg["trusted_proxies"])) and request.headers.get("X-Forwarded-Host"):
        proto = request.headers.get("X-Forwarded-Proto", request.scheme).split(",")[0].strip()
        host = request.headers.get("X-Forwarded-Host").split(",")[0].strip()
        return f"{proto}://{host}"
    return request.host_url.rstrip("/")


def redirect_uri():
    return config()["oidc"]["redirect_uri"] or f"{external_base()}/auth/oidc/callback"


def _rate_limited(ip):
    now = time.time()
    with _fail_lock:
        hits = [t for t in _failures.get(ip, []) if now - t < FAIL_WINDOW]
        _failures[ip] = hits
        return len(hits) >= FAIL_LIMIT


def _record_failure(ip):
    now = time.time()
    with _fail_lock:
        if len(_failures) > 10000:
            for k in [k for k, v in _failures.items() if not v or now - v[-1] > FAIL_WINDOW]:
                del _failures[k]
        _failures.setdefault(ip, []).append(now)


# ----------------------------------------------------------------------------
# Users
# ----------------------------------------------------------------------------

def public_user(row):
    return {
        "id": row["id"], "username": row["username"], "display_name": row["display_name"],
        "email": row["email"], "role": row["role"], "disabled": bool(row["disabled"]),
        "seeded": bool(row["seeded"]), "sso": bool(row["oidc_sub"]),
        "has_password": bool(row["password_hash"]), "created_at": row["created_at"],
        "last_login": row["last_login"],
    }


def get_user(user_id):
    return db.get().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def find_user(username):
    return db.get().execute("SELECT * FROM users WHERE username=? COLLATE NOCASE",
                            (username,)).fetchone()


def admin_count(exclude_id=None):
    return db.get().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0 AND id!=?",
                            (exclude_id or -1,)).fetchone()[0]


def create_user(username, password="", role="viewer", display_name="", email="",
                oidc_sub=None, seeded=False):
    if not USERNAME_RE.match(username or ""):
        raise ValueError("Username: 1-64 letters, digits, . _ @ -")
    if find_user(username):
        raise ValueError("That username is taken")
    if role not in ROLES:
        raise ValueError("Unknown role")
    if password and len(password) < MIN_PASSWORD:
        raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
    d = db.get()
    cur = d.execute(
        "INSERT INTO users (username, display_name, email, role, password_hash, oidc_sub, seeded, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (username, display_name or "", email or "", role,
         generate_password_hash(password) if password else "", oidc_sub, 1 if seeded else 0, db.now()))
    d.commit()
    return get_user(cur.lastrowid)


def set_password(user_id, password):
    if len(password or "") < MIN_PASSWORD:
        raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
    d = db.get()
    d.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(password), user_id))
    d.commit()
    u = get_user(user_id)
    if u and u["seeded"]:
        db.set_setting("initial_admin_password", "")


def _banner(username, password):
    lines = ["VLAN MANAGER  -  ADMIN SIGN-IN", "", f"  username :  {username}",
             f"  password :  {password}", "",
             "Change it in the app (your name, top right -> My account).",
             "This box is printed on every start until you do."]
    width = max(len(x) for x in lines) + 6
    out = ["", "  ╔" + "═" * width + "╗"]
    for i, text in enumerate(lines):
        out.append("  ║" + text.center(width) + "║" if i == 0 else "  ║   " + text.ljust(width - 3) + "║")
        if i == 0:
            out.append("  ╠" + "═" * width + "╣")
    out += ["  ╚" + "═" * width + "╝", ""]
    print("\n".join(out), flush=True)


def bootstrap(app):
    """Seed the first admin on first start, handle VLANMGR_RESET_ADMIN, and
    print the admin banner while the generated password is still in use."""
    global _app
    _app = app
    d = db.get()
    seeded = d.execute("SELECT * FROM users WHERE seeded=1 ORDER BY id LIMIT 1").fetchone()
    if seeded is None and d.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        pw = new_password()
        seeded = create_user("admin", pw, "admin", "Administrator", seeded=True)
        db.set_setting("initial_admin_password", pw)
        _log("created the first admin user 'admin'")
    if seeded is not None and _truthy(_env("VLANMGR_RESET_ADMIN")):
        pw = new_password()
        d.execute("UPDATE users SET password_hash=?, role='admin', disabled=0 WHERE id=?",
                  (generate_password_hash(pw), seeded["id"]))
        d.execute("DELETE FROM sessions WHERE user_id=?", (seeded["id"],))
        d.commit()
        db.set_setting("initial_admin_password", pw)
        _log("VLANMGR_RESET_ADMIN: new admin password set. REMOVE the variable now.")
        seeded = get_user(seeded["id"])
    pw = db.get_setting("initial_admin_password", "")
    if pw and seeded is not None and seeded["password_hash"] and check_password_hash(seeded["password_hash"], pw):
        _banner(seeded["username"], pw)
    elif pw:
        db.set_setting("initial_admin_password", "")
    cfg = config()
    if cfg["no_auth"]:
        _log(f"WARNING: NO-AUTH MODE IS ON - anyone who can reach this app acts as "
             f"'{cfg['anonymous_role']}'.")


# ----------------------------------------------------------------------------
# Sessions + tokens
# ----------------------------------------------------------------------------

def create_session(user_id, method, role_cap="", token_id=None):
    cfg = config()
    token = secrets.token_urlsafe(32)
    now = db.now()
    d = db.get()
    d.execute("INSERT INTO sessions (token_hash, user_id, method, created_at, expires_at, last_seen, ip, user_agent, "
              "role_cap, token_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
              (sha(token), user_id, method, now, now + int(cfg["session_days"]) * 86400, now,
               client_ip(), request.headers.get("User-Agent", "")[:200], role_cap or "", token_id))
    d.execute("UPDATE users SET last_login=? WHERE id=?", (now, user_id))
    d.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    d.commit()
    g.new_session = token
    return token


def _session_user():
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    d = db.get()
    row = d.execute("SELECT s.*, u.username, u.role, u.display_name, u.disabled "
                    "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=?",
                    (sha(token),)).fetchone()
    now = db.now()
    if row is None or row["expires_at"] < now or row["disabled"]:
        return None
    # sliding expiry: every day of use pushes it out to session_days again
    if now - row["last_seen"] > 3600:
        days = int(config()["session_days"])
        d.execute("UPDATE sessions SET last_seen=?, expires_at=? WHERE token_hash=?",
                  (now, now + days * 86400, row["token_hash"]))
        d.commit()
        g.refresh_cookie = token
    role = row["role"]
    if row["role_cap"]:   # a session opened with a token link keeps that token's limit
        role = min(role, row["role_cap"], key=lambda r: RANK.get(r, -1))
    return {"id": row["user_id"], "username": row["username"], "display_name": row["display_name"],
            "role": role, "method": row["method"]}


def _token_user(value):
    if not value or not config()["token_enabled"]:
        return None
    d = db.get()
    row = d.execute("SELECT t.*, u.username, u.role AS user_role, u.display_name, u.disabled "
                    "FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=?",
                    (sha(value),)).fetchone()
    now = db.now()
    if row is None or row["disabled"] or (row["expires_at"] and row["expires_at"] < now):
        return None
    if now - row["last_used"] > 60:
        d.execute("UPDATE api_tokens SET last_used=? WHERE id=?", (now, row["id"]))
        d.commit()
    # a token never grants more than its owner currently has
    role = min(row["role"], row["user_role"], key=lambda r: RANK.get(r, -1))
    return {"id": row["user_id"], "username": row["username"], "display_name": row["display_name"],
            "role": role, "method": "token", "token_id": row["id"]}


CUSTOM_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{16,128}$")


def create_token(user_id, name, role, days, value=None):
    """A random token, or one the user chose (for a memorable ?token= link)."""
    token = value or TOKEN_PREFIX + secrets.token_urlsafe(30)
    d = db.get()
    if d.execute("SELECT 1 FROM api_tokens WHERE token_hash=?", (sha(token),)).fetchone():
        raise ValueError("That token is already in use - pick another")
    d.execute("INSERT INTO api_tokens (user_id, name, token_hash, role, created_at, expires_at) "
              "VALUES (?,?,?,?,?,?)",
              (user_id, name, sha(token), role, db.now(), db.now() + days * 86400 if days else 0))
    d.commit()
    return token


def _strip_token_url():
    parts = urlsplit(request.full_path if request.query_string else request.path)
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "token"]
    return urlunsplit(("", "", parts.path, urlencode(q), ""))


def _safe_next(nxt):
    nxt = nxt or "/"
    if not nxt.startswith("/") or nxt.startswith("//") or "\\" in nxt:
        return "/"
    return nxt


def _deny(msg, code=403):
    return jsonify({"ok": False, "error": msg}), code


def current():
    return getattr(g, "user", None)


def require(role):
    """Route decorator: the signed-in user needs at least `role`."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current()
            if not u:
                return _deny("Sign in required", 401)
            if not role_at_least(u["role"], role):
                return _deny(f"This needs the {role} role", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


def audit(action, target="", detail=None, ok=True, env_id=None):
    u = current() or {}
    db.audit(u.get("username", "?"), u.get("role", ""), action, target, detail, ok, client_ip(), env_id)


# ----------------------------------------------------------------------------
# OIDC sign-in -> local user
# ----------------------------------------------------------------------------

def _groups_set(raw):
    return {x.strip() for x in str(raw or "").split(",") if x.strip()}


def _oidc_user(claims):
    """Find or create the user for these claims. Returns (row, error)."""
    o = config()["oidc"]
    sub = str(claims.get("sub") or "")
    if not sub:
        return None, "The identity provider didn't send a subject (sub)"
    groups = claims.get(o["groups_claim"] or "groups") or []
    groups = {groups} if isinstance(groups, str) else set(map(str, groups))
    allowed = _groups_set(o["allowed_groups"])
    if allowed and not (groups & allowed):
        return None, "Your account isn't in a group that may use this app"
    email = str(claims.get("email") or "")
    name = str(claims.get("name") or claims.get("preferred_username") or "")
    d = db.get()
    row = d.execute("SELECT * FROM users WHERE oidc_sub=?", (sub,)).fetchone()
    if row is None:
        # an admin can pre-create an SSO user (no password) with the same username or email
        for key in [claims.get("preferred_username"), email]:
            if not key:
                continue
            cand = d.execute("SELECT * FROM users WHERE (username=? COLLATE NOCASE OR (email!='' AND email=? COLLATE NOCASE)) "
                             "AND oidc_sub IS NULL AND password_hash='' AND seeded=0", (key, key)).fetchone()
            if cand:
                d.execute("UPDATE users SET oidc_sub=? WHERE id=?", (sub, cand["id"]))
                d.commit()
                row = get_user(cand["id"])
                break
    if row is None:
        if not o["auto_create"]:
            return None, "Your account hasn't been added to this app yet - ask an admin"
        base = re.sub(r"[^A-Za-z0-9._@-]", "", str(claims.get("preferred_username") or email or sub))[:56] or "user"
        username, n = base, 1
        while find_user(username):
            n += 1
            username = f"{base}{n}"
        # SSO only proves who someone is: role and environments come from an admin here
        row = create_user(username, "", "viewer", name, email, oidc_sub=sub)
        _log(f"SSO user '{username}' created as viewer")
    elif email and email != row["email"]:
        d.execute("UPDATE users SET email=? WHERE id=?", (email, row["id"]))
        d.commit()
        row = get_user(row["id"])
    if row["disabled"]:
        return None, "Your account is disabled"
    return row, None


# ----------------------------------------------------------------------------
# Flask wiring
# ----------------------------------------------------------------------------

def init_app(app):
    global _app
    _app = app

    @app.before_request
    def _gate():
        g.user = None
        cfg = config()
        path = request.path
        hdr = request.headers.get("Authorization", "")

        # CSRF: state-changing API calls must be JSON (a cross-site form can't send that)
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and path.startswith("/api/") \
                and not request.is_json and not hdr:
            return _deny("Requests must be JSON", 415)

        bearer = hdr[7:].strip() if hdr.lower().startswith("bearer ") else ""
        bearer = bearer or request.headers.get("X-API-Token", "").strip()
        if bearer:
            u = _token_user(bearer)
            if not u:
                ip = client_ip()
                _record_failure(ip)
                return _deny("Invalid or expired API token", 401)
            g.user = u
            return
        if request.args.get("token") and cfg["token_enabled"]:
            ip = client_ip()
            if _rate_limited(ip):
                return _deny("Too many attempts - try again later", 429)
            u = _token_user(request.args["token"])
            if u:
                create_session(u["id"], "token", u["role"], u["token_id"])
                g.user = u
                if request.method == "GET" and not path.startswith("/api/"):
                    return redirect(_strip_token_url())
                return
            _record_failure(ip)

        g.user = _session_user()
        if g.user is None and cfg["no_auth"]:
            g.user = {"id": 0, "username": "anonymous", "display_name": "Anonymous",
                      "role": cfg["anonymous_role"] if cfg["anonymous_role"] in ROLES else "viewer",
                      "method": "none"}
        if g.user is not None or path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            return
        if path.startswith("/api/"):
            return _deny("Sign in required", 401)
        nxt = _safe_next(request.full_path.rstrip("?"))
        if cfg["oidc_enabled"] and cfg["oidc_auto_login"] and oidc_ready(cfg):
            return redirect("/auth/oidc/login?" + urlencode({"next": nxt}))
        return redirect("/login?" + urlencode({"next": nxt}))

    @app.after_request
    def _cookie(resp):
        token = getattr(g, "new_session", None) or getattr(g, "refresh_cookie", None)
        if token:
            cfg = config()
            resp.set_cookie(COOKIE, token, max_age=int(cfg["session_days"]) * 86400,
                            httponly=True, samesite="Lax", secure=bool(cfg["cookie_secure"]), path="/")
        if getattr(g, "clear_session", False):
            resp.delete_cookie(COOKIE, path="/")
        return resp

    @app.route("/api/auth/config")
    def api_auth_config():
        cfg = config()
        b = cfg["oidc_button"]
        return jsonify({
            "local": bool(cfg["local_enabled"]),
            "oidc": bool(cfg["oidc_enabled"] and oidc_ready(cfg)),
            "oidc_auto_login": bool(cfg["oidc_auto_login"]),
            "button": {k: b[k] for k in DEFAULT_BUTTON},
            "no_auth": bool(cfg["no_auth"]),
            "app_name": db.get_setting("app_name"),
            "signed_in": current() is not None and current()["method"] != "none",
        })

    @app.route("/api/auth/login", methods=["POST"])
    def api_login():
        cfg = config()
        if not cfg["local_enabled"]:
            return _deny("Password sign-in is turned off")
        ip = client_ip()
        if _rate_limited(ip):
            return _deny("Too many failed attempts - try again in 15 minutes", 429)
        data = request.get_json(silent=True) or {}
        user = find_user((data.get("username") or "").strip())
        pw = data.get("password") or ""
        # always run one hash so unknown users take as long as known ones
        probe = user["password_hash"] if user and user["password_hash"] else generate_password_hash("x")
        ok = check_password_hash(probe, pw) and user is not None and bool(user["password_hash"])
        if not ok or user["disabled"]:
            _record_failure(ip)
            db.audit((data.get("username") or "")[:64], "", "login.failed", ip=ip, ok=False)
            return _deny("Invalid username or password", 401)
        create_session(user["id"], "local")
        return jsonify({"ok": True, "next": _safe_next(data.get("next"))})

    @app.route("/api/auth/logout", methods=["POST"])
    def api_logout():
        token = request.cookies.get(COOKIE)
        if token:
            d = db.get()
            d.execute("DELETE FROM sessions WHERE token_hash=?", (sha(token),))
            d.commit()
        g.clear_session = True
        return jsonify({"ok": True, "redirect": "/login?logged_out=1"})

    @app.route("/auth/oidc/login")
    def oidc_login():
        cfg = config()
        if not (cfg["oidc_enabled"] and oidc_ready(cfg)):
            return redirect("/login?" + urlencode({"error": "SSO sign-in isn't enabled"}))
        nxt = _safe_next(request.args.get("next"))
        try:
            resp = _ensure_oauth(cfg).idp.authorize_redirect(redirect_uri())
        except Exception as e:
            _log(f"OIDC login failed: {e}")
            return redirect("/login?" + urlencode({"error": "Couldn't reach the identity provider"}))
        resp.set_cookie("vlanmgr_next", nxt, max_age=600, httponly=True, samesite="Lax", path="/")
        return resp

    @app.route("/auth/oidc/callback")
    def oidc_callback():
        cfg = config()
        fail = lambda msg: redirect("/login?" + urlencode({"error": msg}))
        if not (cfg["oidc_enabled"] and oidc_ready(cfg)):
            return fail("SSO sign-in isn't enabled")
        if request.args.get("error"):
            return fail(request.args.get("error_description") or request.args["error"])
        try:
            idp = _ensure_oauth(cfg).idp
            token = idp.authorize_access_token()
            claims = dict(token.get("userinfo") or {})
            gc = cfg["oidc"]["groups_claim"] or "groups"
            if gc not in claims:
                try:   # some providers only put groups on the userinfo endpoint
                    claims.update(idp.userinfo(token=token))
                except Exception:
                    pass
        except Exception as e:
            _log(f"OIDC callback failed: {e}")
            return fail("SSO sign-in failed - check the server log")
        row, err = _oidc_user(claims)
        if err:
            db.audit(str(claims.get("preferred_username") or claims.get("sub")), "", "login.sso_denied",
                     detail={"reason": err}, ok=False, ip=client_ip())
            return fail(err)
        create_session(row["id"], "oidc")
        resp = redirect(_safe_next(request.cookies.get("vlanmgr_next")))
        resp.delete_cookie("vlanmgr_next", path="/")
        return resp

    # --- current user ------------------------------------------------------

    @app.route("/api/me")
    def api_me():
        u = current()
        if not u:
            return _deny("Sign in required", 401)
        cfg = config()
        out = {**{k: u[k] for k in ("id", "username", "display_name", "role", "method")},
               "no_auth": bool(cfg["no_auth"]),
               "initial_password": False, "prefs": {}, "has_password": False, "email": ""}
        if u["id"]:
            row = get_user(u["id"])
            out["prefs"] = json.loads(row["prefs"] or "{}")
            out["has_password"] = bool(row["password_hash"])
            out["email"] = row["email"]
            pw = db.get_setting("initial_admin_password", "")
            out["initial_password"] = bool(row["seeded"] and pw)
        return jsonify(out)

    @app.route("/api/me/prefs", methods=["PUT"])
    def api_me_prefs():
        u = current()
        if not u:
            return _deny("Sign in required", 401)
        data = request.get_json(silent=True) or {}
        if not u["id"]:
            return jsonify({"ok": True, "prefs": data})   # anonymous: browser keeps them
        row = get_user(u["id"])
        prefs = json.loads(row["prefs"] or "{}")
        for k in ("devices", "vlan_colors", "theme", "compact", "hidden_vlans"):
            if k in data:
                prefs[k] = data[k]
        d = db.get()
        d.execute("UPDATE users SET prefs=? WHERE id=?", (json.dumps(prefs), u["id"]))
        d.commit()
        return jsonify({"ok": True, "prefs": prefs})

    @app.route("/api/me/profile", methods=["PUT"])
    def api_me_profile():
        u = current()
        if not u or not u["id"]:
            return _deny("Sign in required", 401)
        data = request.get_json(silent=True) or {}
        row = get_user(u["id"])
        changes = {}
        if "display_name" in data:
            changes["display_name"] = str(data["display_name"] or "").strip()[:128]
        if "username" in data and str(data["username"] or "").strip() != row["username"]:
            if not role_at_least(u["role"], "admin"):
                return _deny("Ask an admin to change your username", 403)
            new = str(data["username"] or "").strip()
            if not USERNAME_RE.match(new):
                return _deny("Username: 1-64 letters, digits, . _ @ -", 400)
            other = find_user(new)
            if other and other["id"] != row["id"]:
                return _deny("That username is taken", 400)
            changes["username"] = new
        d = db.get()
        for k, v in changes.items():
            d.execute(f"UPDATE users SET {k}=? WHERE id=?", (v, row["id"]))
        d.commit()
        if changes:
            audit("user.updated", row["username"], changes)
        return jsonify({"ok": True})

    @app.route("/api/me/password", methods=["PUT"])
    def api_me_password():
        u = current()
        if not u or not u["id"]:
            return _deny("Sign in required", 401)
        if u["method"] == "token":
            return _deny("Sign in with a password or SSO to change your password")
        data = request.get_json(silent=True) or {}
        row = get_user(u["id"])
        if row["password_hash"] and not check_password_hash(row["password_hash"], data.get("current") or ""):
            return _deny("Current password is wrong", 400)
        try:
            set_password(u["id"], data.get("password") or "")
        except ValueError as e:
            return _deny(str(e), 400)
        audit("user.password_changed", row["username"])
        return jsonify({"ok": True})

    @app.route("/api/me/tokens", methods=["GET", "POST"])
    def api_me_tokens():
        u = current()
        if not u or not u["id"]:
            return _deny("Sign in required", 401)
        d = db.get()
        if request.method == "GET":
            rows = d.execute("SELECT id, name, role, created_at, expires_at, last_used FROM api_tokens "
                             "WHERE user_id=? ORDER BY id DESC", (u["id"],)).fetchall()
            return jsonify({"enabled": config()["token_enabled"], "tokens": [dict(r) for r in rows]})
        if u["method"] == "token":
            return _deny("A token can't create tokens")
        if not config()["token_enabled"]:
            return _deny("API tokens are turned off (Settings -> Authentication)")
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()[:64]
        role = data.get("role") or u["role"]
        if not name:
            return _deny("Give the token a name", 400)
        if role not in ROLES or not role_at_least(u["role"], role):
            return _deny("A token can't have a higher role than you", 400)
        try:
            days = max(0, min(3650, int(data.get("days") or 0)))
        except (TypeError, ValueError):
            return _deny("Expiry must be a number of days", 400)
        custom = (data.get("value") or "").strip()
        if custom and not CUSTOM_TOKEN_RE.match(custom):
            return _deny("A custom token needs 16-128 characters: letters, digits, . _ ~ -", 400)
        try:
            token = create_token(u["id"], name, role, days, custom or None)
        except ValueError as e:
            return _deny(str(e), 400)
        audit("token.created", name, {"role": role, "days": days, "custom": bool(custom)})
        return jsonify({"ok": True, "token": token, "link": f"{external_base()}/?token={token}"})

    @app.route("/api/me/tokens/<int:tid>", methods=["DELETE"])
    def api_me_token_delete(tid):
        u = current()
        if not u or not u["id"]:
            return _deny("Sign in required", 401)
        d = db.get()
        cur = d.execute("DELETE FROM api_tokens WHERE id=? AND user_id=?", (tid, u["id"]))
        if cur.rowcount:
            d.execute("DELETE FROM sessions WHERE token_id=?", (tid,))
        d.commit()
        if not cur.rowcount:
            return _deny("No such token", 404)
        audit("token.revoked", str(tid))
        return jsonify({"ok": True})

    # --- users (admin) -----------------------------------------------------

    @app.route("/api/users")
    @require("admin")
    def api_users():
        rows = db.get().execute("SELECT * FROM users ORDER BY seeded DESC, username").fetchall()
        sess = {r["user_id"]: r["n"] for r in db.get().execute(
            "SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id", (db.now(),))}
        env_n = {r["user_id"]: r["n"] for r in db.get().execute(
            "SELECT user_id, COUNT(*) AS n FROM user_env GROUP BY user_id")}
        return jsonify({"users": [{**public_user(r), "sessions": sess.get(r["id"], 0), "envs": env_n.get(r["id"], 0)}
                                  for r in rows], "roles": list(ROLES)})

    @app.route("/api/users", methods=["POST"])
    @require("admin")
    def api_user_create():
        data = request.get_json(silent=True) or {}
        try:
            row = create_user((data.get("username") or "").strip(), data.get("password") or "",
                              data.get("role") or "viewer", (data.get("display_name") or "").strip(),
                              (data.get("email") or "").strip())
        except ValueError as e:
            return _deny(str(e), 400)
        audit("user.created", row["username"], {"role": row["role"], "sso_only": not row["password_hash"]})
        return jsonify({"ok": True, "user": public_user(row)})

    @app.route("/api/users/<int:uid>", methods=["PUT", "DELETE"])
    @require("admin")
    def api_user_update(uid):
        row = get_user(uid)
        if row is None:
            return _deny("No such user", 404)
        me = current()
        d = db.get()
        if request.method == "DELETE":
            if uid == me["id"]:
                return _deny("You can't delete yourself", 400)
            if row["role"] == "admin" and admin_count(uid) == 0:
                return _deny("That's the last admin", 400)
            d.execute("DELETE FROM users WHERE id=?", (uid,))
            d.commit()
            audit("user.deleted", row["username"])
            return jsonify({"ok": True})
        data = request.get_json(silent=True) or {}
        changes = {}
        if "role" in data and data["role"] != row["role"]:
            if data["role"] not in ROLES:
                return _deny("Unknown role", 400)
            if row["role"] == "admin" and admin_count(uid) == 0:
                return _deny("That's the last admin - make someone else admin first", 400)
            changes["role"] = data["role"]
        if "disabled" in data and bool(data["disabled"]) != bool(row["disabled"]):
            if uid == me["id"]:
                return _deny("You can't disable yourself", 400)
            if data["disabled"] and row["role"] == "admin" and admin_count(uid) == 0:
                return _deny("That's the last admin", 400)
            changes["disabled"] = 1 if data["disabled"] else 0
        if "username" in data and str(data["username"] or "").strip() != row["username"]:
            new = str(data["username"] or "").strip()
            if not USERNAME_RE.match(new):
                return _deny("Username: 1-64 letters, digits, . _ @ -", 400)
            other = find_user(new)
            if other and other["id"] != uid:
                return _deny("That username is taken", 400)
            changes["username"] = new
        for k in ("display_name", "email"):
            if k in data:
                changes[k] = str(data[k] or "").strip()[:128]
        for k, v in changes.items():
            d.execute(f"UPDATE users SET {k}=? WHERE id=?", (v, uid))
        if changes.get("disabled"):
            d.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        d.commit()
        if data.get("password"):
            try:
                set_password(uid, data["password"])
            except ValueError as e:
                return _deny(str(e), 400)
            changes["password"] = "changed"
        if data.get("sign_out"):
            d.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            d.commit()
            changes["sessions"] = "signed out"
        if changes:
            audit("user.updated", row["username"], changes)
        return jsonify({"ok": True, "user": public_user(get_user(uid))})

    # --- auth settings (admin) ----------------------------------------------

    @app.route("/api/settings/auth", methods=["GET"])
    @require("admin")
    def api_auth_settings_get():
        cfg = config()
        o = dict(cfg["oidc"])
        o["client_secret_set"] = bool(o.pop("client_secret"))
        return jsonify({**{k: cfg[k] for k in DEFAULT_AUTH if k not in ("oidc",)}, "oidc": o,
                        "locked": cfg["locked"], "oidc_ready": oidc_ready(cfg),
                        "redirect_uri": redirect_uri(), "detected_base": external_base(), "icons": BUTTON_ICONS,
                        "signed_in_with": current()["method"]})

    @app.route("/api/settings/auth", methods=["PUT"])
    @require("admin")
    def api_auth_settings_put():
        data = request.get_json(silent=True) or {}
        cur = config()
        cand = stored_config()
        for k in ("local_enabled", "oidc_enabled", "oidc_auto_login", "token_enabled", "no_auth", "cookie_secure"):
            if k in data and k not in cur["locked"]:
                cand[k] = bool(data[k])
        for k in ("trusted_proxies", "public_url"):
            if k in data and k not in cur["locked"]:
                cand[k] = str(data[k] or "").strip()
        if "anonymous_role" in data:
            if data["anonymous_role"] not in ROLES:
                return _deny("Unknown role", 400)
            cand["anonymous_role"] = data["anonymous_role"]
        if "session_days" in data:
            try:
                cand["session_days"] = max(1, min(365, int(data["session_days"])))
            except (TypeError, ValueError):
                return _deny("Session length must be a number of days", 400)
        o = data.get("oidc") or {}
        for k in DEFAULT_OIDC:
            if k not in o:
                continue
            if k == "client_secret":
                if o[k]:
                    cand["oidc"][k] = str(o[k]).strip()
            elif k == "auto_create":
                cand["oidc"][k] = bool(o[k])
            else:
                cand["oidc"][k] = str(o[k] or "").strip()
        if o.get("clear_client_secret"):
            cand["oidc"]["client_secret"] = ""
        b = data.get("oidc_button") or {}
        for k in DEFAULT_BUTTON:
            if k in b:
                v = str(b[k] or "").strip()[:300]
                if k in ("bg", "fg") and not re.fullmatch(r"#[0-9a-fA-F]{3,8}", v):
                    return _deny("Button colors must be hex, e.g. #fd4b2d", 400)
                if k == "icon" and v not in BUTTON_ICONS:
                    return _deny("Unknown icon", 400)
                if k == "icon_url" and v and not re.match(r"^(https?://|/)", v):
                    return _deny("Icon URL must start with http(s):// or /", 400)
                cand["oidc_button"][k] = v or DEFAULT_BUTTON[k]
        # errors that would lock everyone out
        eff_local = cand["local_enabled"] or "local_enabled" in cur["locked"]
        eff_no_auth = cur["no_auth"] if "no_auth" in cur["locked"] else cand["no_auth"]
        if cand["oidc_enabled"] and not oidc_ready(cand):
            return _deny("Fill in the OIDC issuer and client ID before turning SSO on", 400)
        if not eff_local and not cand["oidc_enabled"] and not eff_no_auth:
            return _deny("Turn on at least one way to sign in", 400)
        me = current()
        if me["method"] == "local" and not eff_local and not data.get("confirm"):
            return jsonify({"ok": False, "confirm": "You signed in with a password, which you're turning off. "
                                                    "Make sure SSO works for an admin first."}), 409
        if cand["no_auth"] and not stored_config()["no_auth"] and data.get("confirm_no_auth") != "I UNDERSTAND":
            return jsonify({"ok": False, "confirm_no_auth": True}), 409
        db.set_json("auth", cand)
        safe = {k: v for k, v in data.items() if k not in ("oidc",)}
        safe["oidc"] = {k: v for k, v in o.items() if k != "client_secret"}
        audit("settings.auth", "", safe)
        return jsonify({"ok": True})

    @app.route("/api/settings/auth/test-oidc", methods=["POST"])
    @require("admin")
    def api_oidc_test():
        o = request.get_json(silent=True) or {}
        url = discovery_url({"discovery_url": (o.get("discovery_url") or "").strip(),
                             "issuer": (o.get("issuer") or "").strip()})
        if not url:
            return _deny("Enter the issuer URL first", 400)
        try:
            r = requests.get(url, timeout=10)
            r.raise_for_status()
            meta = r.json()
        except Exception as e:
            return jsonify({"ok": False, "error": f"Couldn't read {url}: {e}"})
        missing = [k for k in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri") if not meta.get(k)]
        if missing:
            return jsonify({"ok": False, "error": f"Discovery document is missing {', '.join(missing)}"})
        return jsonify({"ok": True, "issuer": meta["issuer"]})

    @app.route("/api/sessions", methods=["GET"])
    @require("admin")
    def api_sessions():
        rows = db.get().execute(
            "SELECT s.created_at, s.last_seen, s.expires_at, s.ip, s.user_agent, s.method, u.username "
            "FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at > ? ORDER BY s.last_seen DESC",
            (db.now(),)).fetchall()
        return jsonify({"sessions": [dict(r) for r in rows]})
