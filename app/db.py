"""
SQLite storage for VLAN Manager.

Everything lives in one file (default /data/vlanmgr.db). Migrations are
additive only - new tables, new columns, new settings - so an older DB keeps
working with a newer image. Before a new version starts against an existing
DB, a consistent copy is written to /data/backups/.
"""

import json
import os
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime

DB_PATH = os.environ.get("VLANMGR_DB", "/data/vlanmgr.db")
DATA_DIR = os.path.dirname(os.path.abspath(DB_PATH))
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
AVATAR_DIR = os.path.join(DATA_DIR, "avatars")
BACKUPS_KEPT = 10

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'viewer',
    password_hash TEXT NOT NULL DEFAULT '',
    oidc_sub      TEXT UNIQUE,
    disabled      INTEGER NOT NULL DEFAULT 0,
    seeded        INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login    INTEGER NOT NULL DEFAULT 0,
    prefs         TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    ip          TEXT NOT NULL DEFAULT '',
    user_agent  TEXT NOT NULL DEFAULT '',
    role_cap    TEXT NOT NULL DEFAULT '',
    token_id    INTEGER
);
CREATE TABLE IF NOT EXISTS api_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL DEFAULT 0,
    last_used   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    username    TEXT NOT NULL,
    role        TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '{}',
    ok          INTEGER NOT NULL DEFAULT 1,
    ip          TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS environments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'local',
    host          TEXT NOT NULL DEFAULT '',
    api_key       TEXT NOT NULL DEFAULT '',
    site          TEXT NOT NULL DEFAULT 'default',
    console_id    TEXT NOT NULL DEFAULT '',
    verify_ssl    INTEGER NOT NULL DEFAULT 0,
    supervisors_protected INTEGER NOT NULL DEFAULT 0,
    vlan_colors   TEXT NOT NULL DEFAULT '{}',
    notes         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);
-- which environments a user may use, and what inside them
CREATE TABLE IF NOT EXISTS user_env (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    env_id       INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    all_vlans    INTEGER NOT NULL DEFAULT 1,
    vlans        TEXT NOT NULL DEFAULT '[]',     -- network ids
    all_devices  INTEGER NOT NULL DEFAULT 1,
    devices      TEXT NOT NULL DEFAULT '[]',     -- device MACs (survive re-adoption)
    PRIMARY KEY (user_id, env_id)
);
-- ports an admin locked: only admins may change them. The locked settings are kept so a
-- change made elsewhere (the UniFi UI) shows up as drift and can be re-applied.
CREATE TABLE IF NOT EXISTS port_locks (
    env_id        INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    device_mac    TEXT NOT NULL,
    port_idx      INTEGER NOT NULL,
    native_network_id TEXT NOT NULL,
    tagged_mode   TEXT NOT NULL,
    excluded      TEXT NOT NULL DEFAULT '[]',
    note          TEXT NOT NULL DEFAULT '',
    locked_by     TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (env_id, device_mac, port_idx)
);
-- roles: a named set of abilities with a level (who is above whom); see perms.py
CREATE TABLE IF NOT EXISTS roles (
    key      TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    level    INTEGER NOT NULL,
    caps     TEXT NOT NULL DEFAULT '[]',
    builtin  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
"""

SETTING_DEFAULTS = {
    # behaviour (UniFi connections live in the environments table)
    "protect_uplinks": "1",           # uplinks / device links / LAGs need an admin
    "default_tagged_mode": "block_all",
    "poll_seconds": "10",
    # appearance
    "app_name": "VLAN Manager",
    # updates
    "update_check": "1",
}


def now():
    return int(time.time())


def connect():
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def get():
    """Per-request connection (closed by close())."""
    db = getattr(_local, "db", None)
    if db is None:
        db = _local.db = connect()
    return db


def close():
    db = getattr(_local, "db", None)
    if db is not None:
        db.close()
        _local.db = None


def get_setting(key, default=None, db=None):
    db = db or get()
    row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return SETTING_DEFAULTS.get(key, default) if default is None else default
    return row["value"]


def set_setting(key, value, db=None):
    db = db or get()
    db.execute("INSERT INTO settings (key, value) VALUES (?,?) "
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
    db.commit()


def get_json(key, default):
    try:
        v = json.loads(get_setting(key, "") or "null")
    except ValueError:
        return default
    return default if v is None else v


def set_json(key, value):
    set_setting(key, json.dumps(value))


def setting_bool(key):
    return str(get_setting(key, "")).strip().lower() in ("1", "true", "yes", "on")


def backup(reason):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUP_DIR, f"vlanmgr-{reason}-{stamp}.db")
    with closing(connect()) as src, closing(sqlite3.connect(dest)) as dst:
        src.backup(dst)
    olds = sorted((f for f in os.listdir(BACKUP_DIR) if f.startswith("vlanmgr-") and f.endswith(".db")),
                  key=lambda f: os.path.getmtime(os.path.join(BACKUP_DIR, f)))
    for f in olds[:-BACKUPS_KEPT]:
        try:
            os.remove(os.path.join(BACKUP_DIR, f))
        except OSError:
            pass
    return dest


# additive column migrations: (table, column, definition)
COLUMNS = [
    ("sessions", "role_cap", "TEXT NOT NULL DEFAULT ''"),
    ("sessions", "token_id", "INTEGER"),
    ("audit", "env_id", "INTEGER"),
    ("users", "avatar_version", "INTEGER NOT NULL DEFAULT 0"),   # 0 = no picture
    ("users", "avatar_locked", "INTEGER NOT NULL DEFAULT 0"),    # an admin chose it; user can't change it
    ("sessions", "acting_as", "INTEGER"),                          # admin "view as" another user
    ("users", "caps_grant", "TEXT NOT NULL DEFAULT '[]'"),         # abilities on top of their role
    ("users", "caps_deny", "TEXT NOT NULL DEFAULT '[]'"),          # abilities taken away from their role
    ("users", "pending", "INTEGER NOT NULL DEFAULT 0"),            # signed in with SSO, waiting for an admin to set them up
]


def _add_columns(db):
    for table, col, ddl in COLUMNS:
        have = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
        if col not in have:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def _migrate_single_console(db):
    """1.0 had one UniFi connection in settings: turn it into the first environment."""
    if db.execute("SELECT COUNT(*) FROM environments").fetchone()[0]:
        return
    s = {r["key"]: r["value"] for r in db.execute(
        "SELECT key, value FROM settings WHERE key LIKE 'unifi_%' OR key='vlan_colors'")}
    if not (s.get("unifi_api_key") and (s.get("unifi_host") or s.get("unifi_console_id"))):
        return
    db.execute("INSERT INTO environments (name, mode, host, api_key, site, console_id, verify_ssl, vlan_colors, created_at) "
               "VALUES (?,?,?,?,?,?,?,?,?)",
               ("Default", s.get("unifi_mode") or "local", s.get("unifi_host") or "", s["unifi_api_key"],
                s.get("unifi_site") or "default", s.get("unifi_console_id") or "",
                1 if s.get("unifi_verify_ssl") in ("1", "true") else 0, s.get("vlan_colors") or "{}", now()))
    db.execute("DELETE FROM settings WHERE key LIKE 'unifi_%' OR key='vlan_colors'")
    print("[db] moved the UniFi connection into the environment 'Default'", flush=True)


def init(version):
    """Back up the DB when the version changes, then create / migrate the schema."""
    os.makedirs(DATA_DIR, exist_ok=True)
    old = None
    if os.path.isfile(DB_PATH) and os.path.getsize(DB_PATH) > 0:
        with closing(connect()) as db:
            try:
                row = db.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
                old = row["value"] if row else None
            except sqlite3.Error:
                pass
        if old and old != version:
            dest = backup(f"v{old}")
            print(f"[db] upgrading from {old} to {version}; backup written to {dest}", flush=True)
    with closing(connect()) as db:
        db.executescript(SCHEMA)
        _add_columns(db)
        for k, v in SETTING_DEFAULTS.items():
            db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)", (k, v))
        _migrate_single_console(db)
        import perms
        perms.seed(db)
        perms.migrate(db)
        db.execute("INSERT INTO settings (key, value) VALUES ('schema_version', ?) "
                   "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (version,))
        db.commit()


def audit(username, role, action, target="", detail=None, ok=True, ip="", env_id=None):
    db = get()
    db.execute("INSERT INTO audit (ts, username, role, action, target, detail, ok, ip, env_id) "
               "VALUES (?,?,?,?,?,?,?,?,?)",
               (now(), username or "", role or "", action, target, json.dumps(detail or {}),
                1 if ok else 0, ip or "", env_id))
    db.commit()
