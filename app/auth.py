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

import base64
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

import brand
import db
import perms

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
    # how the client ID/secret are sent to the token endpoint
    "token_auth_method": "client_secret_basic",
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
TOKEN_AUTH_METHODS = ("client_secret_basic", "client_secret_post", "none")
BUTTON_ICONS = ("none", "key", "shield", "lock", "login", "authentik", "custom")

PUBLIC_PATHS = {"/login", "/healthz", "/favicon.svg", "/api/auth/config", "/api/auth/login",
                "/auth/oidc/login", "/auth/oidc/callback", "/api/version",
                "/manifest.webmanifest"}
PUBLIC_PREFIXES = ("/static/", "/brand/")

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


def _loads(v):
    try:
        return json.loads(v) if v else []
    except ValueError:
        return []


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
    method = o.get("token_auth_method") if o.get("token_auth_method") in TOKEN_AUTH_METHODS else "client_secret_basic"
    sig = (discovery_url(o), o["client_id"], o["client_secret"], o["scopes"], method)
    with _lock:
        if sig == _oauth_sig and _oauth is not None:
            return _oauth
        from authlib.integrations.flask_client import OAuth
        if _oauth is None:
            _oauth = OAuth(_app)
        _oauth.register("idp", overwrite=True, server_metadata_url=sig[0],
                        client_id=o["client_id"],
                        client_secret=(o["client_secret"] or None) if method != "none" else None,
                        client_kwargs={"scope": o["scopes"] or "openid profile email",
                                       "code_challenge_method": "S256",
                                       "token_endpoint_auth_method": method})
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

def avatar_url(row):
    v = row["avatar_version"] if "avatar_version" in row.keys() else 0
    return f"/avatar/{row['id']}?v={v}" if v else None


def public_user(row):
    return {
        "id": row["id"], "username": row["username"], "display_name": row["display_name"],
        "avatar": avatar_url(row), "avatar_locked": bool(row["avatar_locked"]),
        "email": row["email"], "role": row["role"], "disabled": bool(row["disabled"]),
        "seeded": bool(row["seeded"]), "sso": bool(row["oidc_sub"]),
        "has_password": bool(row["password_hash"]), "created_at": row["created_at"],
        "last_login": row["last_login"], "pending": bool(row["pending"]),
    }


def clear_pending(user_id):
    """An admin has set this person up (access, role or abilities): they're no longer waiting."""
    d = db.get()
    d.execute("UPDATE users SET pending=0 WHERE id=? AND pending=1", (user_id,))
    d.commit()


def get_user(user_id):
    return db.get().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def find_user(username):
    return db.get().execute("SELECT * FROM users WHERE username=? COLLATE NOCASE",
                            (username,)).fetchone()


def admin_count(exclude_id=None):
    return db.get().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0 AND id!=?",
                            (exclude_id or -1,)).fetchone()[0]


def free_username(wanted):
    """A username that's free, made from `wanted` (an email's part before @ is enough)."""
    base = re.sub(r"[^A-Za-z0-9._@-]", "", str(wanted or ""))[:56] or "user"
    username, n = base, 1
    while find_user(username):
        n += 1
        username = f"{base}{n}"
    return username


def create_user(username, password="", role="viewer", display_name="", email="",
                oidc_sub=None, seeded=False, pending=False):
    if not USERNAME_RE.match(username or ""):
        raise ValueError("Username: 1-64 letters, digits, . _ @ -")
    if find_user(username):
        raise ValueError("That username is taken")
    if role not in perms.roles():
        raise ValueError("Unknown role")
    if password and len(password) < MIN_PASSWORD:
        raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
    d = db.get()
    cur = d.execute(
        "INSERT INTO users (username, display_name, email, role, password_hash, oidc_sub, seeded, pending, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (username, display_name or "", email or "", role,
         generate_password_hash(password) if password else "", oidc_sub, 1 if seeded else 0, 1 if pending else 0, db.now()))
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
# Profile pictures: resized to a small square in the browser, checked here, stored in
# /data/avatars/<user id>.<ext>. Only PNG, JPEG and WebP (by their file signature).
# ----------------------------------------------------------------------------

AVATAR_MAX = 600 * 1024
AVATAR_TYPES = {"png": b"\x89PNG\r\n\x1a\n", "jpg": b"\xff\xd8\xff", "webp": b"RIFF"}
AVATAR_MIME = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}


def _avatar_files(uid):
    return [os.path.join(db.AVATAR_DIR, f"{uid}.{ext}") for ext in AVATAR_TYPES]


def avatar_path(uid):
    return next((p for p in _avatar_files(uid) if os.path.isfile(p)), None)


def save_avatar(uid, data_url):
    """Store a picture from a data: URL. Raises ValueError for anything that isn't a small image."""
    m = re.match(r"^data:image/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$", data_url or "")
    if not m:
        raise ValueError("Send the picture as an image")
    try:
        raw = base64.b64decode(m.group(1), validate=False)
    except ValueError:
        raise ValueError("That picture couldn't be read")
    if len(raw) > AVATAR_MAX:
        raise ValueError("That picture is too big")
    ext = next((e for e, sig in AVATAR_TYPES.items() if raw.startswith(sig)), None)
    if ext == "webp" and raw[8:12] != b"WEBP":
        ext = None
    if not ext:
        raise ValueError("Use a PNG, JPEG or WebP picture")
    os.makedirs(db.AVATAR_DIR, exist_ok=True)
    for p in _avatar_files(uid):
        if os.path.isfile(p):
            os.remove(p)
    with open(os.path.join(db.AVATAR_DIR, f"{uid}.{ext}"), "wb") as fh:
        fh.write(raw)
    d = db.get()
    d.execute("UPDATE users SET avatar_version=MAX(avatar_version + 1, ?) WHERE id=?", (db.now(), uid))
    d.commit()


def remove_avatar(uid):
    for p in _avatar_files(uid):
        if os.path.isfile(p):
            os.remove(p)
    d = db.get()
    d.execute("UPDATE users SET avatar_version=0 WHERE id=?", (uid,))
    d.commit()


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
    if row["role_cap"] and row["role_cap"] in perms.roles():   # opened with a token link: keep its limit
        role = perms.lower_of(role, row["role_cap"])
    me = {"id": row["user_id"], "username": row["username"], "display_name": row["display_name"],
          "role": role, "method": row["method"]}
    # viewing the app as someone below you (only while you still may)
    if row["acting_as"] and role == row["role"]:
        t = get_user(row["acting_as"])
        if t is not None and not t["disabled"] and t["role"] != perms.ADMIN \
                and perms.has(me, "users.view_as") and perms.above(me, t["role"]):
            return {"id": t["id"], "username": t["username"], "display_name": t["display_name"],
                    "role": t["role"], "method": row["method"],
                    "impersonator": {"id": me["id"], "username": me["username"], "display_name": me["display_name"]}}
    return me


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
    role = perms.lower_of(row["role"], row["user_role"]) if row["role"] in perms.roles() else perms.lowest_role()
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


def require(cap=None):
    """Route decorator: signed in, and (if given) holding ability `cap` (see perms.py)."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current()
            if not u:
                return _deny("Sign in required", 401)
            if cap and not perms.has(u, cap):
                return _deny("You don't have permission to do that", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


def is_admin(u=None):
    return perms.is_admin(u or current())


def _may_manage(row):
    """Is `row` (a person) someone the current identity may manage?"""
    me = current()
    if not me:
        return False
    if is_admin(me):
        return True
    return row["id"] != me["id"] and perms.above(me, row["role"])


def audit(action, target="", detail=None, ok=True, env_id=None):
    u = current() or {}
    who = u.get("username", "?")
    if u.get("impersonator"):
        who = f"{u['impersonator']['username']} (as {who})"
    db.audit(who, u.get("role", ""), action, target, detail, ok, client_ip(), env_id)


# ----------------------------------------------------------------------------
# OIDC sign-in -> local user
# ----------------------------------------------------------------------------

def check_client(token_endpoint, client_id, secret):
    """Ask the provider whether it accepts this client ID/secret, without signing anyone in:
    exchange a made-up authorization code. Client authentication is checked before the code,
    so `invalid_client` means the credentials are wrong and `invalid_grant` means they're fine."""
    attempts = []
    if secret:
        attempts += [("client_secret_basic", {"auth": (client_id, secret)}, {}),
                     ("client_secret_post", {}, {"client_id": client_id, "client_secret": secret})]
    attempts.append(("none", {}, {"client_id": client_id}))
    results = {}
    for method, kw, extra in attempts:
        try:
            r = requests.post(token_endpoint, timeout=10, data={
                "grant_type": "authorization_code", "code": "vlanmgr-credential-check",
                "redirect_uri": "https://invalid.example/callback", **extra}, **kw)
            err = (r.json() if r.headers.get("content-type", "").startswith("application/json") else {}).get("error")
        except Exception as e:
            results[method] = f"unreachable: {e.__class__.__name__}"
            continue
        results[method] = "rejected" if err == "invalid_client" or r.status_code == 401 else "accepted"
    working = [m for m, v in results.items() if v == "accepted"]
    if "client_secret_basic" in working or "client_secret_post" in working:
        best = "client_secret_basic" if "client_secret_basic" in working else "client_secret_post"
        return {"ok": True, "results": results, "suggest": best,
                "message": f"Client ID and secret accepted ({'HTTP Basic' if best == 'client_secret_basic' else 'form POST'})."}
    if working == ["none"]:
        return {"ok": True, "results": results, "suggest": "none",
                "message": "The provider treats this as a public client (no secret). Set client authentication to None."}
    if not secret:
        return {"ok": False, "results": results, "message": "No client secret saved or entered."}
    return {"ok": False, "results": results,
            "message": "The provider rejected this client ID/secret. Re-copy the Client Secret from the provider "
                       "(Authentik: Applications → Providers → your provider → Edit), paste it here and save. "
                       "Also check the Client ID and that the client type is Confidential."}


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
    # an email the provider says isn't verified can't be used to claim an account an admin added
    email_ok = bool(email) and claims.get("email_verified") is not False
    if row is None:
        # an admin can pre-create an SSO user (no password) with the same username or email
        for key in [claims.get("preferred_username"), email if email_ok else None]:
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
        username = free_username(claims.get("preferred_username") or email or sub)
        # SSO only proves who someone is: role and environments come from an admin here, so new
        # people wait (see a "your admin hasn't set you up yet" page) until an admin gives them access
        row = create_user(username, "", perms.lowest_role(), name, email, oidc_sub=sub, pending=True)
        _log(f"SSO user '{username}' created, waiting for an admin to set them up")
        db.audit(username, row["role"], "user.sso_waiting", username, {"email": email}, ip=client_ip())
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
        if g.user and g.user.get("impersonator") and path.startswith("/api/me/") \
                and request.method in ("POST", "PUT", "PATCH", "DELETE"):
            return _deny("You're viewing as someone else - their own account settings can't be changed", 403)
        if g.user is None and cfg["no_auth"]:
            g.user = {"id": 0, "username": "anonymous", "display_name": "Anonymous",
                      "role": cfg["anonymous_role"] if cfg["anonymous_role"] in perms.roles() else perms.lowest_role(),
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
            "brand": brand.public(),
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
            if "invalid_client" in str(e):
                _log("HINT: the provider rejected this app's client ID/secret. Re-paste the client secret "
                     "in Settings -> Sign-in and press 'Test provider' - it checks the credentials.")
                return fail("Your identity provider rejected this app's client ID or secret. An admin should "
                            "re-paste the client secret in Settings → Sign-in and press Test provider.")
            if "redirect_uri" in str(e) or "invalid_grant" in str(e):
                return fail("SSO sign-in failed: the redirect URI registered at your provider must match the one "
                            "shown in Settings → Sign-in exactly.")
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
               "caps": sorted(perms.caps_for(u)), "role_name": perms.name(u["role"]),
               "role_level": perms.level(u["role"]),
               "token_roles": [{"key": r["key"], "name": r["name"]} for r in perms.roles().values()
                               if r["level"] <= perms.level(u["role"])],
               "impersonator": u.get("impersonator"),
               "no_auth": bool(cfg["no_auth"]),
               "initial_password": False, "prefs": {}, "has_password": False, "email": "",
               "avatar": None, "avatar_locked": False}
        if u["id"]:
            row = get_user(u["id"])
            out["prefs"] = json.loads(row["prefs"] or "{}")
            out["has_password"] = bool(row["password_hash"])
            out["email"] = row["email"]
            out["avatar"] = avatar_url(row)
            out["avatar_locked"] = bool(row["avatar_locked"])
            pw = db.get_setting("initial_admin_password", "")
            out["initial_password"] = bool(row["seeded"] and pw)
            out["pending"] = bool(row["pending"])
        if perms.has(u, "users.access"):   # people waiting for someone to set them up
            out["waiting"] = db.get().execute("SELECT COUNT(*) FROM users WHERE pending=1 AND disabled=0").fetchone()[0]
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
        for k in ("devices", "vlan_colors", "theme", "compact", "hidden_vlans", "legend", "ports_view", "scales",
                  "color_sync", "shared_colors", "setup_done"):
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
            if not is_admin(u):
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

    @app.route("/api/users/<int:uid>/impersonate", methods=["POST"])
    @require("users.view_as")
    def api_impersonate(uid):
        me = current()
        token = request.cookies.get(COOKIE)
        if me.get("impersonator") or me["method"] not in ("local", "oidc") or not token:
            return _deny("Sign in with a password or SSO to view as someone else", 400)
        t = get_user(uid)
        if t is None:
            return _deny("No such user", 404)
        if t["role"] == perms.ADMIN or t["disabled"] or not perms.above(me, t["role"]):
            return _deny("You can only view as an active person below you (never an admin)", 400)
        d = db.get()
        d.execute("UPDATE sessions SET acting_as=? WHERE token_hash=?", (uid, sha(token)))
        d.commit()
        audit("user.impersonate", t["username"])
        return jsonify({"ok": True})

    @app.route("/api/impersonate/stop", methods=["POST"])
    def api_impersonate_stop():
        token = request.cookies.get(COOKIE)
        u = current()
        if not token or not u or not u.get("impersonator"):
            return _deny("You're not viewing as anyone", 400)
        d = db.get()
        d.execute("UPDATE sessions SET acting_as=NULL WHERE token_hash=?", (sha(token),))
        d.commit()
        db.audit(u["impersonator"]["username"], "", "user.impersonate_stop", u["username"], ip=client_ip())
        return jsonify({"ok": True})

    @app.route("/api/me/avatar", methods=["PUT", "DELETE"])
    def api_me_avatar():
        u = current()
        if not u or not u["id"]:
            return _deny("Sign in required", 401)
        row = get_user(u["id"])
        if row["avatar_locked"]:
            return _deny("An admin set your picture", 403)
        if request.method == "DELETE":
            remove_avatar(u["id"])
        else:
            try:
                save_avatar(u["id"], (request.get_json(silent=True) or {}).get("image"))
            except ValueError as e:
                return _deny(str(e), 400)
        return jsonify({"ok": True, "avatar": avatar_url(get_user(u["id"]))})

    @app.route("/avatar/<int:uid>")
    def avatar_file(uid):
        if not current():
            return _deny("Sign in required", 401)
        path = avatar_path(uid)
        if not path:
            return _deny("No picture", 404)
        ext = path.rsplit(".", 1)[1]
        with open(path, "rb") as fh:
            resp = _app.response_class(fh.read(), mimetype=AVATAR_MIME[ext])
        resp.headers["Cache-Control"] = "private, max-age=31536000, immutable"   # URL carries ?v=
        resp.headers["Content-Security-Policy"] = "default-src 'none'"
        return resp

    @app.route("/api/users/<int:uid>/avatar", methods=["PUT", "DELETE"])
    @require("users.edit")
    def api_user_avatar(uid):
        row = get_user(uid)
        if row is None or not _may_manage(row):
            return _deny("No such user", 404)
        data = request.get_json(silent=True) or {}
        if request.method == "DELETE":
            remove_avatar(uid)
        elif data.get("image"):
            try:
                save_avatar(uid, data["image"])
            except ValueError as e:
                return _deny(str(e), 400)
        if "locked" in data:
            d = db.get()
            d.execute("UPDATE users SET avatar_locked=? WHERE id=?", (1 if data["locked"] else 0, uid))
            d.commit()
        audit("user.avatar", row["username"], {"removed": request.method == "DELETE", "locked": data.get("locked")})
        return jsonify({"ok": True, "user": public_user(get_user(uid))})

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
        if role not in perms.roles() or perms.level(role) > perms.level(u["role"]):
            return _deny("A link can't have a higher role than you", 400)
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

    # --- people ------------------------------------------------------------
    # Admins manage everyone. Others need the matching users.* ability and only ever
    # see or change people whose role is below their own (perms.above).

    def _people_row(r, sess, env_n):
        eff = perms.user_caps(r["role"], _loads(r["caps_grant"]), _loads(r["caps_deny"]))
        return {**public_user(r), "sessions": sess.get(r["id"], 0), "envs": env_n.get(r["id"], 0),
                "role_name": perms.name(r["role"]), "caps_grant": _loads(r["caps_grant"]),
                "caps_deny": _loads(r["caps_deny"]), "caps": sorted(eff)}

    @app.route("/api/users")
    @require("users.view")
    def api_users():
        me = current()
        rows = [r for r in db.get().execute("SELECT * FROM users ORDER BY seeded DESC, username").fetchall()
                if is_admin(me) or r["id"] == me["id"] or perms.above(me, r["role"])]
        sess = {r["user_id"]: r["n"] for r in db.get().execute(
            "SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id", (db.now(),))}
        env_n = {r["user_id"]: r["n"] for r in db.get().execute(
            "SELECT user_id, COUNT(*) AS n FROM user_env GROUP BY user_id")}
        rs = perms.roles()
        return jsonify({"users": [_people_row(r, sess, env_n) for r in rows],
                        "roles": [rs[k] for k in rs],
                        "assignable_roles": perms.assignable_roles(me),
                        "caps": perms.public_caps(),
                        "my_caps": sorted(perms.caps_for(me)),
                        "admin": is_admin(me)})

    @app.route("/api/users", methods=["POST"])
    @require("users.create")
    def api_user_create():
        me = current()
        data = request.get_json(silent=True) or {}
        role = data.get("role") or perms.lowest_role()
        if not is_admin(me) and (role not in perms.assignable_roles(me)
                                 or (role != perms.lowest_role() and not perms.has(me, "users.roles"))):
            role = perms.lowest_role()
        email = (data.get("email") or "").strip()
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if data.get("sso"):
            # someone who'll sign in with SSO: their email is what matches them on first sign-in
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
                return _deny("Enter their email: it's how their first SSO sign-in finds this account", 400)
            exists = db.get().execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone()
            if exists:
                return _deny("Someone with that email is already here", 400)
            password = ""
            username = username or free_username(email.split("@")[0])
        try:
            row = create_user(username, password, role, (data.get("display_name") or "").strip(), email)
        except ValueError as e:
            return _deny(str(e), 400)
        audit("user.created", row["username"], {"role": row["role"], "sso_only": not row["password_hash"]})
        return jsonify({"ok": True, "user": public_user(row)})

    @app.route("/api/users/<int:uid>", methods=["PUT", "DELETE"])
    @require()
    def api_user_update(uid):
        me = current()
        row = get_user(uid)
        if row is None or not _may_manage(row):
            return _deny("No such user", 404)
        d = db.get()
        if request.method == "DELETE":
            if not perms.has(me, "users.delete"):
                return _deny("You don't have permission to delete people", 403)
            if uid == me["id"]:
                return _deny("You can't delete yourself", 400)
            if row["role"] == perms.ADMIN and admin_count(uid) == 0:
                return _deny("That's the last admin", 400)
            d.execute("DELETE FROM users WHERE id=?", (uid,))
            d.commit()
            remove_avatar(uid)
            audit("user.deleted", row["username"])
            return jsonify({"ok": True})
        data = request.get_json(silent=True) or {}
        editing = {k for k in ("username", "display_name", "email", "disabled", "password", "sign_out") if k in data}
        if editing and not perms.has(me, "users.edit"):
            return _deny("You don't have permission to edit people", 403)
        if ({"role", "caps_grant", "caps_deny"} & set(data)) and not perms.has(me, "users.roles"):
            return _deny("You don't have permission to change roles or abilities", 403)
        changes = {}
        if "role" in data and data["role"] != row["role"]:
            if data["role"] not in perms.roles():
                return _deny("Unknown role", 400)
            if data["role"] not in perms.assignable_roles(me):
                return _deny("You can only give roles below your own", 403)
            if row["role"] == perms.ADMIN and admin_count(uid) == 0:
                return _deny("That's the last admin - make someone else admin first", 400)
            changes["role"] = data["role"]
        for k in ("caps_grant", "caps_deny"):
            if k in data:
                vals = sorted({c for c in (data[k] or []) if c in perms.CAP_KEYS})
                mine = perms.caps_for(me)
                if not is_admin(me) and any(c not in mine for c in vals):
                    return _deny("You can only hand out abilities you have yourself", 403)
                changes[k] = json.dumps(vals)
        if "disabled" in data and bool(data["disabled"]) != bool(row["disabled"]):
            if uid == me["id"]:
                return _deny("You can't disable yourself", 400)
            if data["disabled"] and row["role"] == perms.ADMIN and admin_count(uid) == 0:
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
        # giving someone a role or abilities, or approving them outright, ends their wait
        if row["pending"] and ({"role", "caps_grant", "caps_deny"} & set(changes) or data.get("approve")):
            changes["pending"] = 0
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

    # --- roles (admin) -------------------------------------------------------

    def _role_body(data, builtin):
        out = {}
        if "name" in data:
            n = str(data["name"] or "").strip()[:40]
            if not n:
                raise ValueError("Give the role a name")
            out["name"] = n
        if "level" in data and not builtin:
            try:
                lv = int(data["level"])
            except (TypeError, ValueError):
                raise ValueError("Level must be a number")
            if not 11 <= lv <= 99:
                raise ValueError("Level must be between 11 and 99")
            out["level"] = lv
        if "caps" in data:
            out["caps"] = json.dumps(sorted({c for c in (data["caps"] or []) if c in perms.CAP_KEYS}))
        return out

    @app.route("/api/roles")
    @require("users.view")
    def api_roles():
        counts = {r["role"]: r["n"] for r in db.get().execute("SELECT role, COUNT(*) AS n FROM users GROUP BY role")}
        rs = perms.roles()
        return jsonify({"roles": [{**rs[k], "users": counts.get(k, 0)} for k in rs], "caps": perms.public_caps(),
                        "admin_caps": perms.ADMIN_CAPS})

    @app.route("/api/roles", methods=["POST"])
    @require("roles.manage")
    def api_role_create():
        data = request.get_json(silent=True) or {}
        try:
            vals = _role_body({"level": 30, **data}, builtin=False)
        except ValueError as e:
            return _deny(str(e), 400)
        if "name" not in vals:
            return _deny("Give the role a name", 400)
        key, n = perms.slug(vals["name"]), 1
        while key in perms.roles():
            n += 1
            key = f"{perms.slug(vals['name'])}-{n}"
        d = db.get()
        d.execute("INSERT INTO roles (key, name, level, caps, builtin) VALUES (?,?,?,?,0)",
                  (key, vals["name"], vals["level"], vals.get("caps", "[]")))
        d.commit()
        perms.forget()
        audit("role.created", vals["name"], {"level": vals["level"], "caps": json.loads(vals.get("caps", "[]"))})
        return jsonify({"ok": True, "role": perms.roles()[key]})

    @app.route("/api/roles/<key>", methods=["PUT", "DELETE"])
    @require("roles.manage")
    def api_role(key):
        role = perms.roles().get(key)
        if role is None:
            return _deny("No such role", 404)
        if key == perms.ADMIN:
            return _deny("The Admin role always has every ability", 400)
        d = db.get()
        if request.method == "DELETE":
            if role["builtin"]:
                return _deny("Supervisor and Viewer can be renamed and changed, not deleted", 400)
            move_to = (request.get_json(silent=True) or {}).get("move_to") or perms.lowest_role()
            if move_to == key or move_to not in perms.roles():
                return _deny("Pick another role for its people", 400)
            d.execute("UPDATE users SET role=? WHERE role=?", (move_to, key))
            d.execute("UPDATE api_tokens SET role=? WHERE role=?", (move_to, key))
            d.execute("DELETE FROM roles WHERE key=?", (key,))
            d.commit()
            perms.forget()
            audit("role.deleted", role["name"], {"people_moved_to": perms.name(move_to)})
            return jsonify({"ok": True})
        try:
            vals = _role_body(request.get_json(silent=True) or {}, builtin=role["builtin"])
        except ValueError as e:
            return _deny(str(e), 400)
        if vals:
            d.execute(f"UPDATE roles SET {', '.join(k + '=?' for k in vals)} WHERE key=?", list(vals.values()) + [key])
            d.commit()
            perms.forget()
            audit("role.updated", role["name"], {k: (json.loads(v) if k == "caps" else v) for k, v in vals.items()})
        return jsonify({"ok": True, "role": perms.roles()[key]})

    # --- auth settings (admin) ----------------------------------------------

    @app.route("/api/settings/auth", methods=["GET"])
    @require("settings.manage")
    def api_auth_settings_get():
        cfg = config()
        o = dict(cfg["oidc"])
        o["client_secret_set"] = bool(o.pop("client_secret"))
        return jsonify({**{k: cfg[k] for k in DEFAULT_AUTH if k not in ("oidc",)}, "oidc": o,
                        "locked": cfg["locked"], "oidc_ready": oidc_ready(cfg),
                        "redirect_uri": redirect_uri(), "detected_base": external_base(), "icons": BUTTON_ICONS,
                        "roles": [{"key": r["key"], "name": r["name"]} for r in perms.roles().values()],
                        "signed_in_with": current()["method"]})

    @app.route("/api/settings/auth", methods=["PUT"])
    @require("settings.manage")
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
            if data["anonymous_role"] not in perms.roles():
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
            elif k == "token_auth_method":
                if o[k] not in TOKEN_AUTH_METHODS:
                    return _deny("Unknown client authentication method", 400)
                cand["oidc"][k] = o[k]
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
    @require("settings.manage")
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
        out = {"ok": True, "issuer": meta["issuer"],
               "methods_supported": meta.get("token_endpoint_auth_methods_supported") or []}
        client_id = (o.get("client_id") or "").strip()
        secret = (o.get("client_secret") or "").strip() or stored_config()["oidc"]["client_secret"]
        if client_id:
            out["credentials"] = check_client(meta["token_endpoint"], client_id, secret)
        return jsonify(out)

    @app.route("/api/sessions", methods=["GET"])
    @require("settings.manage")
    def api_sessions():
        rows = db.get().execute(
            "SELECT s.created_at, s.last_seen, s.expires_at, s.ip, s.user_agent, s.method, u.username "
            "FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at > ? ORDER BY s.last_seen DESC",
            (db.now(),)).fetchall()
        return jsonify({"sessions": [dict(r) for r in rows]})
