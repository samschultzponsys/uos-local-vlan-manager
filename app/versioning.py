"""
Version, changelog and update check.

Versions are always MAJOR.MINOR with a single-digit minor: 1.0, 1.1 ... 1.9,
then 2.0. The newest "## x.y" heading in CHANGELOG.md is the running version;
the GitHub Action reads the same heading to tag the image and create the
matching GitHub release (vX.Y).

The update check asks GitHub for the newest release of this repo (every 6
hours). Turn it off in Settings -> Updates, or hard-disable it with
VLANMGR_UPDATE_CHECK=false.
"""

import os
import re
import threading
import time

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("VLANMGR_UPDATE_REPO", "samschultzponsys/uos-local-vlan-manager").strip()
UPDATE_ALLOWED = os.environ.get("VLANMGR_UPDATE_CHECK", "true").strip().lower() not in ("0", "false", "no", "off")
UPDATE_TTL = 6 * 3600

_HEAD = re.compile(r"^##\s+\[?v?(\d+\.\d+)\]?(.*)$")
_VER = re.compile(r"^v?(\d+)\.(\d+)$")


def parse_changelog(text):
    entries, cur = [], None
    for line in text.splitlines():
        m = _HEAD.match(line.strip())
        if m:
            cur = {"version": m.group(1), "date": m.group(2).strip(" -–—()[]"), "body": []}
            entries.append(cur)
        elif cur is not None:
            cur["body"].append(line.rstrip())
    for e in entries:
        e["body"] = "\n".join(e["body"]).strip()
    return entries


def load_changelog():
    for d in (APP_DIR, os.path.dirname(APP_DIR)):
        path = os.path.join(d, "CHANGELOG.md")
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                return parse_changelog(fh.read())
    return []


def version_key(v):
    m = _VER.match(str(v or "").strip())
    return (int(m.group(1)), int(m.group(2))) if m else (-1, -1)


def next_version(v):
    """1.0 -> 1.1 ... 1.9 -> 2.0"""
    major, minor = version_key(v)
    minor += 1
    if minor > 9:
        major, minor = major + 1, 0
    return f"{major}.{minor}"


CHANGELOG = load_changelog()
VERSION = CHANGELOG[0]["version"] if CHANGELOG else "0.0"

_state = {"latest": None, "url": None, "notes": None, "checked_at": 0, "error": None}
_lock = threading.Lock()


def fetch_latest():
    r = requests.get(f"https://api.github.com/repos/{REPO}/releases/latest", timeout=10,
                     headers={"Accept": "application/vnd.github+json",
                              "User-Agent": f"vlan-manager/{VERSION}"})
    if r.status_code == 404:
        return None, None, None
    r.raise_for_status()
    data = r.json()
    tag = str(data.get("tag_name") or "").lstrip("v")
    if not _VER.match(tag):
        return None, None, None
    return tag, data.get("html_url"), data.get("body") or ""


def check(enabled=True):
    if not (UPDATE_ALLOWED and enabled):
        return status(enabled)
    try:
        latest, url, notes = fetch_latest()
        err = None
    except Exception as e:
        latest, url, notes, err = None, None, None, str(e)
    with _lock:
        if latest or not err:
            _state.update(latest=latest, url=url, notes=notes)
        _state.update(checked_at=int(time.time()), error=err)
    if err:
        print(f"[update-check] {err}", flush=True)
    return status(enabled)


def status(enabled=True):
    on = UPDATE_ALLOWED and enabled
    latest = _state["latest"] if on else None
    return {
        "enabled": on, "allowed": UPDATE_ALLOWED, "repo": REPO,
        "latest": latest, "url": _state["url"] if on else None,
        "update_available": bool(latest and version_key(latest) > version_key(VERSION)),
        "checked_at": _state["checked_at"] if on else 0,
        "error": _state["error"] if on else None,
    }


def due():
    return time.time() - _state["checked_at"] > UPDATE_TTL
