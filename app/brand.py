"""
Branding: the app's name, the header logo and the favicon.

Each mark is one of
    default   the built-in port-grid logo
    icon      a built-in line icon on a two-color gradient (a preset palette or custom colors)
    image     an uploaded picture (PNG, JPEG or WebP, resized in the browser)

The favicon follows the logo unless it's set separately. Everything here is public (the sign-in
page and the browser tab need it before anyone signs in), so nothing secret goes in it.
"""

import base64
import hashlib
import json
import os
import re

import db

MAX_IMAGE = 600 * 1024
IMAGE_SIGS = {"png": b"\x89PNG\r\n\x1a\n", "jpg": b"\xff\xd8\xff", "webp": b"RIFF"}
IMAGE_MIME = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}

# two-color gradients (top-left -> bottom-right) and the glyph color on them
PALETTES = {
    "ocean": ("#60a5fa", "#6366f1", "#ffffff"), "sunset": ("#f97316", "#ec4899", "#ffffff"),
    "forest": ("#22c55e", "#0d9488", "#ffffff"), "grape": ("#a855f7", "#6366f1", "#ffffff"),
    "ember": ("#ef4444", "#f59e0b", "#ffffff"), "gold": ("#fde047", "#d97706", "#1f1300"),
    "slate": ("#64748b", "#1e293b", "#ffffff"), "mono": ("#f3f4f6", "#9ca3af", "#111827"),
}
# the same line icons the app uses (24 x 24, stroked)
ICONS = {
    "ports": None,   # the built-in port grid, drawn below
    "server": "M2 5h20v6H2zM2 13h20v6H2zM6 8h.01M6 16h.01",
    "router": "M2 14h20v6H2zM6 17h.01M10 17h.01M12 14V9M8.5 6.5a5 5 0 0 1 7 0M6 4a8.5 8.5 0 0 1 12 0",
    "wifi": "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01",
    "globe": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
    "shield": "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    "grid": "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
    "bolt": "M13 2 4 14h7l-1 8 9-12h-7z",
    "link": "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
    "layers": "m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5",
    "tag": "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01",
    "trunk": "M4 7h16M4 12h16M4 17h16",
    "key": "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4",
    "sparkle": "M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z",
    "camera": "M23 7l-7 5 7 5zM1 5h15v14H1z",
    "plug": "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
    "uplink": "M12 20V6M6 12l6-6 6 6M5 3h14",
    "sliders": "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
MARK_DEFAULT = {"kind": "default", "icon": "server", "palette": "ocean", "c1": "#60a5fa", "c2": "#6366f1", "fg": "#ffffff",
                "image": 0}
DEFAULT = {"tagline": "Switch port VLANs for UniFi", "logo": dict(MARK_DEFAULT), "favicon_same": True,
           "favicon": dict(MARK_DEFAULT)}


def config():
    stored = db.get_json("brand", {})
    out = json.loads(json.dumps(DEFAULT))
    out["tagline"] = stored.get("tagline", out["tagline"])
    out["favicon_same"] = stored.get("favicon_same", True)
    for k in ("logo", "favicon"):
        out[k].update({x: v for x, v in (stored.get(k) or {}).items() if x in MARK_DEFAULT})
    return out


def public():
    """What browsers get: the name and how to draw each mark (no file paths)."""
    c = config()
    fav = c["logo"] if c["favicon_same"] else c["favicon"]
    return {"app_name": db.get_setting("app_name") or "VLAN Manager", "tagline": c["tagline"],
            "logo": _mark_public(c["logo"], "logo"), "favicon": _mark_public(fav, "logo" if c["favicon_same"] else "favicon"),
            "favicon_same": c["favicon_same"], "version": _version(c)}


def _mark_public(m, which):
    out = {"kind": m["kind"], "icon": m["icon"], "colors": colors(m), "path": ICONS.get(m["icon"])}
    if m["kind"] == "image" and m.get("image"):
        out["src"] = f"/brand/{which}?v={m['image']}"
    return out


def _version(c):
    return hashlib.sha1(json.dumps(c, sort_keys=True).encode()).hexdigest()[:10]


def colors(m):
    if m.get("palette") == "custom":
        return [m.get("c1") or "#60a5fa", m.get("c2") or "#6366f1", m.get("fg") or "#ffffff"]
    return list(PALETTES.get(m.get("palette"), PALETTES["ocean"]))


def save(data):
    """Validate and store branding sent by an admin. Raises ValueError."""
    c = config()
    if "tagline" in data:
        c["tagline"] = str(data["tagline"] or "").strip()[:80]
    if "favicon_same" in data:
        c["favicon_same"] = bool(data["favicon_same"])
    for k in ("logo", "favicon"):
        m = data.get(k)
        if not isinstance(m, dict):
            continue
        cur = c[k]
        if "kind" in m:
            if m["kind"] not in ("default", "icon", "image"):
                raise ValueError("Logo must be the default, an icon or an image")
            cur["kind"] = m["kind"]
        if "icon" in m:
            if m["icon"] not in ICONS:
                raise ValueError("Unknown icon")
            cur["icon"] = m["icon"]
        if "palette" in m:
            if m["palette"] not in PALETTES and m["palette"] != "custom":
                raise ValueError("Unknown palette")
            cur["palette"] = m["palette"]
        for x in ("c1", "c2", "fg"):
            if x in m:
                if not HEX.match(str(m[x] or "")):
                    raise ValueError("Colors look like #3b82f6")
                cur[x] = m[x]
        if cur["kind"] == "image" and not image_path(k):
            raise ValueError("Upload a picture first")
    db.set_json("brand", c)
    return c


# --- pictures -----------------------------------------------------------------

def brand_dir():
    return os.path.join(db.DATA_DIR, "brand")


def image_path(which):
    for ext in IMAGE_SIGS:
        p = os.path.join(brand_dir(), f"{which}.{ext}")
        if os.path.isfile(p):
            return p
    return None


def image_ext(which):
    p = image_path(which)
    return p.rsplit(".", 1)[1] if p else None


def save_image(which, data_url):
    if which not in ("logo", "favicon"):
        raise ValueError("Logo or favicon?")
    m = re.match(r"^data:image/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$", data_url or "")
    if not m:
        raise ValueError("Send the picture as an image")
    raw = base64.b64decode(m.group(1), validate=False)
    if len(raw) > MAX_IMAGE:
        raise ValueError("That picture is too big")
    ext = next((e for e, sig in IMAGE_SIGS.items() if raw.startswith(sig)), None)
    if ext == "webp" and raw[8:12] != b"WEBP":
        ext = None
    if not ext:   # no SVG: served from this site, it could carry script
        raise ValueError("Use a PNG, JPEG or WebP picture")
    os.makedirs(brand_dir(), exist_ok=True)
    for e in IMAGE_SIGS:
        p = os.path.join(brand_dir(), f"{which}.{e}")
        if os.path.isfile(p):
            os.remove(p)
    with open(os.path.join(brand_dir(), f"{which}.{ext}"), "wb") as fh:
        fh.write(raw)
    c = config()   # the picture is used once the admin saves with kind "image"
    c[which]["image"] = db.now()
    db.set_json("brand", c)
    return c


# --- drawing ---------------------------------------------------------------------

PORT_GRID = ('<rect x="6" y="11" width="4.5" height="4.5" rx="1" fill="#fff"/><rect x="11.8" y="11" width="4.5" height="4.5" rx="1" fill="#fff" opacity=".85"/>'
             '<rect x="17.6" y="11" width="4.5" height="4.5" rx="1" fill="#22c55e"/><rect x="23.4" y="11" width="2.6" height="4.5" rx="1" fill="#fff" opacity=".6"/>'
             '<rect x="6" y="17.5" width="4.5" height="4.5" rx="1" fill="#f59e0b"/><rect x="11.8" y="17.5" width="4.5" height="4.5" rx="1" fill="#fff" opacity=".85"/>'
             '<rect x="17.6" y="17.5" width="4.5" height="4.5" rx="1" fill="#fff"/><rect x="23.4" y="17.5" width="2.6" height="4.5" rx="1" fill="#fff" opacity=".6"/>')


def svg(m):
    """The mark as SVG (default or icon kinds)."""
    c1, c2, fg = colors(m) if m.get("kind") == "icon" else PALETTES["ocean"]
    icon = m.get("icon") if m.get("kind") == "icon" else "ports"
    glyph = PORT_GRID if icon == "ports" else (
        f'<g transform="translate(5 5) scale(.9167)" fill="none" stroke="{fg}" stroke-width="2.2" '
        f'stroke-linecap="round" stroke-linejoin="round"><path d="{ICONS[icon]}"/></g>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs>'
            f'<rect x="1" y="1" width="30" height="30" rx="8" fill="url(#g)"/>{glyph}</svg>')
