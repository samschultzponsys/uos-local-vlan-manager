"""
UniFi Network client: read switches, ports, networks and clients, and set a
port's native VLAN + tagged VLAN management.

Connection modes
    local   the console itself (UDM / UCG / UDR / UX / Cloud Key / UniFi OS
            Server, or a UniFi-hosted console via its own URL):
            https://<host>/proxy/network/api/s/<site>/...
    cloud   through UniFi's cloud connector, for a console you can't reach
            directly: https://api.ui.com/v1/connector/consoles/<id>/network/...
            (a Site Manager key; <id> from api.ui.com/v1/hosts; UniFi OS >= 5.0.3).
            UniFi documents only the official Integration API through the
            connector, and that API can't change port VLANs - diagnose_cloud()
            checks whether the switch-port API gets through.

Local mode uses the console's API key (Network app -> Settings -> Control Plane ->
Integrations); cloud mode uses a Site Manager key (unifi.ui.com -> API). Both are
sent as X-API-KEY.

Port VLAN settings live in the device's `port_overrides` list. On current
Network versions (8.x+) a port has:
    native_networkconf_id     the native (untagged) network
    tagged_vlan_mgmt          "auto" (Allow All) | "block_all" | "custom"
    excluded_networkconf_ids  with "custom": the networks NOT tagged
    portconf_id               a port profile; when set, the profile wins
Older versions used `forward` ("all" | "native" | "customize") with
`tagged_networkconf_ids`; those are written too when a device still uses them.
A PUT to rest/device replaces the whole port_overrides list, so it's always
read, changed for the one port, and written back - then read again to verify.
"""

import copy
import os
import re
import threading
import time

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CLOUD_BASE = os.environ.get("VLANMGR_CLOUD_BASE", "https://api.ui.com").rstrip("/")   # override for development only
# networks you'd put on a switch port (not WAN / VPN)
PORT_PURPOSES = ("corporate", "guest", "vlan-only")
MODES = ("auto", "block_all", "custom")
MODE_LABEL = {"auto": "Allow All", "block_all": "Block All", "custom": "Custom"}
LEGACY_FORWARD = {"auto": "all", "block_all": "native", "custom": "customize"}
FORWARD_MODE = {"all": "auto", "native": "block_all", "customize": "custom"}
DEVICE_TYPES = {"usw": "Switch", "udm": "Gateway", "ugw": "Gateway", "uxg": "Gateway",
                "uap": "Access Point", "ubb": "Building Bridge", "uck": "Cloud Key"}


class UniFiError(Exception):
    pass


def _host_url(host):
    host = (host or "").strip().rstrip("/")
    if host and not host.startswith(("http://", "https://")):
        host = "https://" + host
    return host


def _int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


class UniFi:
    def __init__(self, mode="local", host="", api_key="", site="default", console_id="",
                 verify_ssl=False, timeout=15):
        self.mode = mode if mode in ("local", "cloud") else "local"
        self.host = _host_url(host)
        self.api_key = (api_key or "").strip()
        self.site = (site or "default").strip() or "default"
        self.console_id = (console_id or "").strip()
        self.verify = bool(verify_ssl)
        self.timeout = timeout
        self.http = requests.Session()
        self.http.verify = self.verify

    # --- plumbing -----------------------------------------------------------

    def configured(self):
        if not self.api_key:
            return False
        return bool(self.console_id) if self.mode == "cloud" else bool(self.host)

    def base(self):
        if self.mode == "cloud":
            # the connector maps .../consoles/<id>/<path> to the console's /proxy/<path>
            return f"{CLOUD_BASE}/v1/connector/consoles/{self.console_id}/network"
        # a classic self-hosted Network application (port 8443) has no /proxy/network
        if self.host.endswith(":8443"):
            return self.host
        return f"{self.host}/proxy/network"

    def _req(self, method, path, body=None):
        if not self.configured():
            raise UniFiError("UniFi isn't set up yet - an admin can add it in Settings -> UniFi")
        url = self.base() + path
        headers = {"X-API-KEY": self.api_key, "Accept": "application/json"}
        try:
            r = self.http.request(method, url, headers=headers, json=body, timeout=self.timeout)
        except requests.exceptions.SSLError:
            raise UniFiError("TLS certificate check failed - turn off 'Verify TLS' for a self-signed console")
        except requests.RequestException as e:
            raise UniFiError(f"Can't reach UniFi: {e.__class__.__name__}")
        if r.status_code in (401, 403):
            if self.mode == "cloud":
                raise UniFiError("The UniFi cloud connector refused the request (HTTP %d). Press Test connection in "
                                 "Settings → Environments to see which step fails." % r.status_code)
            raise UniFiError("UniFi rejected the API key (HTTP %d) - check the key and that it "
                             "belongs to an admin with Network access" % r.status_code)
        if r.status_code == 404:
            if self.mode == "cloud":
                raise UniFiError("The UniFi cloud connector returned 404 - check the console (use Find consoles) "
                                 "and the site. If the console is reachable from this server, Direct is more reliable.")
            raise UniFiError(f"UniFi returned 404 for {path} - check the host and site")
        if r.status_code >= 400:
            msg = ""
            try:
                msg = (r.json().get("meta") or {}).get("msg") or ""
            except ValueError:
                pass
            raise UniFiError(f"UniFi returned HTTP {r.status_code}{': ' + msg if msg else ''}")
        try:
            data = r.json()
        except ValueError:
            raise UniFiError("UniFi sent a non-JSON reply - is the host a UniFi console?")
        meta = data.get("meta") if isinstance(data, dict) else None
        if meta and meta.get("rc") not in (None, "ok"):
            raise UniFiError(f"UniFi error: {meta.get('msg') or meta.get('rc')}")
        return data.get("data", data) if isinstance(data, dict) else data

    def _site(self, path):
        return f"/api/s/{self.site}{path}"

    # --- reads --------------------------------------------------------------

    def sites(self):
        rows = self._req("GET", "/api/self/sites")
        return [{"name": s.get("name"), "desc": s.get("desc") or s.get("name")} for s in rows or []]

    def cloud_consoles(self):
        """Consoles on the account (cloud mode helper)."""
        try:
            r = self.http.get(f"{CLOUD_BASE}/v1/hosts", timeout=self.timeout,
                              headers={"X-API-KEY": self.api_key, "Accept": "application/json"})
        except requests.RequestException as e:
            raise UniFiError(f"Can't reach api.ui.com: {e.__class__.__name__}")
        if r.status_code in (401, 403):
            raise UniFiError("api.ui.com rejected the API key - use a key from unifi.ui.com -> API")
        if r.status_code >= 400:
            raise UniFiError(f"api.ui.com returned HTTP {r.status_code}")
        out = []
        for h in r.json().get("data") or []:
            rs = h.get("reportedState") or {}
            ud = h.get("userData") or {}
            hw = h.get("hardwareId") or rs.get("hardwareId") or ""
            out.append({"id": h.get("id"), "name": rs.get("name") or rs.get("hostname") or ud.get("fullName") or h.get("id"),
                        "version": rs.get("version") or rs.get("firmwareVersion") or "",
                        "blocked": bool(h.get("isBlocked")), "role": ud.get("role") or "",
                        "network_role": ",".join((ud.get("permissions") or {}).get("network.management") or []),
                        "ip": h.get("ipAddress") or "", "type": h.get("type") or "",
                        "hardware_id": hw, "online": (rs.get("state") or "connected") == "connected"})
        return out

    def diagnose_cloud(self, site):
        """Check a cloud connection one step at a time, so a failure says exactly where:
        1. the Site Manager key (api.ui.com/v1/hosts)
        2. the console on that account (id, blocked, firmware >= 5.0.3, your role)
        3. the cloud connector reaching the console's official Network API
        4. the connector reaching the console's switch-port API (needed to change VLANs)"""
        steps = []

        def step(name, ok, detail):
            steps.append({"name": name, "ok": ok, "detail": detail})
            return ok

        try:
            hosts = self.cloud_consoles()
        except UniFiError as e:
            step("Site Manager API key", False, f"{e} Create one at unifi.ui.com → API (Site Manager), "
                                                "signed in as the console's owner or a super admin.")
            return steps
        step("Site Manager API key", True, f"Accepted - {len(hosts)} console{'s' if len(hosts) != 1 else ''} on this account.")
        host = next((h for h in hosts if h["id"] == self.console_id), None)
        if host is None:
            step("Console", False, "This console isn't on the key's account. Use Find my consoles, and make sure the key "
                                   "was made by the console's owner or a super admin.")
            return steps
        if host["blocked"]:
            step("Console", False, f"{host['name']} is blocked from cloud access (UniFi OS → Settings → Remote Access).")
            return steps
        role = host["role"] or "unknown"
        step("Console", True, f"{host['name']}{' · UniFi OS ' + host['version'] if host['version'] else ''} · your role: {role}"
                              f"{' · Network: ' + host['network_role'] if host['network_role'] else ''}")

        def get(path):
            try:
                r = self.http.get(self.base() + path, timeout=self.timeout,
                                  headers={"X-API-KEY": self.api_key, "Accept": "application/json"})
            except requests.RequestException as e:
                return None, e.__class__.__name__
            return r, None

        r, err = get("/integration/v1/info")
        if r is None or r.status_code >= 400:
            code = f"HTTP {r.status_code}" if r is not None else err
            step("Cloud connector", False, f"The connector couldn't reach the console's Network app ({code}). It needs "
                                           "UniFi OS 5.0.3 or newer, the console online with Remote Access on, and the "
                                           "key's account to be an owner or super admin of it.")
            return steps
        try:
            ver = (r.json() or {}).get("applicationVersion") or ""
        except ValueError:
            ver = ""
        step("Cloud connector", True, f"Reached the Network app{' ' + ver if ver else ''}.")
        r, err = get(f"/api/s/{self.site}/stat/device")
        if r is None or r.status_code >= 400:
            code = f"HTTP {r.status_code}" if r is not None else err
            steps.append({"name": "Switch ports", "ok": False, "warn": True,
                          "detail": f"UniFi's cloud refused the switch-port API ({code}), so this environment will be "
                                    "view only: link, speed and PoE status, but port VLANs can't be seen or changed. "
                                    "Use a Direct connection for full control."})
            return steps
        step("Switch ports", True, "The switch-port API works through the cloud - VLAN changes will work.")
        return steps

    def resolve_console_id(self, value):
        """Accept a console ID, or a unifi.ui.com page URL / console UUID copied from the
        address bar, and return the ID the cloud connector wants (the host id from /v1/hosts)."""
        value = (value or "").strip()
        m = re.search(r"/consoles/([^/?#]+)", value)
        if m:
            value = m.group(1)
        if not value or not self.api_key:
            return value
        try:
            hosts = self.cloud_consoles()
        except UniFiError:
            return value
        low = value.lower()
        for h in hosts:
            ids = {str(h.get("id") or "").lower(), str(h.get("hardware_id") or "").lower()}
            if low in ids or any(low and low in i for i in ids if i):
                return h["id"]
        return value

    def raw_devices(self):
        return self._req("GET", self._site("/stat/device")) or []

    def raw_device(self, mac):
        rows = self._req("GET", self._site(f"/stat/device/{mac}")) or []
        if not rows:
            raise UniFiError("That device is no longer on the controller")
        return rows[0]

    def raw_networks(self):
        return self._req("GET", self._site("/rest/networkconf")) or []

    def raw_portconfs(self):
        try:
            return self._req("GET", self._site("/rest/portconf")) or []
        except UniFiError:
            return []

    def raw_clients(self):
        try:
            return self._req("GET", self._site("/stat/sta")) or []
        except UniFiError:
            return []

    # --- write --------------------------------------------------------------

    def put_port_overrides(self, device_id, overrides):
        return self._req("PUT", self._site(f"/rest/device/{device_id}"), {"port_overrides": overrides})


# ----------------------------------------------------------------------------
# Read-only view through UniFi's official Integration API (what the cloud
# connector allows). No per-port VLANs, no port changes - just devices, link,
# speed, connector and PoE state.
# ----------------------------------------------------------------------------

READONLY_REASON = ("Viewed through UniFi's cloud, which only allows UniFi's official API: link, speed and PoE "
                   "are shown, but port VLANs can't be seen or changed. Use a Direct connection for full control.")
FEATURE_TYPE = {"switching": "usw", "gateway": "udm", "accessPoint": "uap"}


def _integration_get(client, path):
    try:
        r = client.http.get(client.base() + "/integration/v1" + path, timeout=client.timeout,
                            headers={"X-API-KEY": client.api_key, "Accept": "application/json"})
    except requests.RequestException as e:
        raise UniFiError(f"Can't reach UniFi: {e.__class__.__name__}")
    if r.status_code >= 400:
        raise UniFiError(f"UniFi's official API returned HTTP {r.status_code} for {path}")
    try:
        return r.json()
    except ValueError:
        raise UniFiError("UniFi sent a non-JSON reply")


def _integration_list(client, path):
    out, offset = [], 0
    for _ in range(20):
        sep = "&" if "?" in path else "?"
        page = _integration_get(client, f"{path}{sep}offset={offset}&limit=200")
        data = page.get("data") or []
        out += data
        offset += len(data)
        if not data or offset >= int(page.get("totalCount") or 0):
            break
    return out


def integration_snapshot(client):
    """Normalized view (same shape as normalize()) from the Integration API, read-only."""
    sites = _integration_list(client, "/sites")
    site = next((s for s in sites if client.site in (s.get("internalReference"), s.get("name"), s.get("id"))),
                sites[0] if sites else None)
    if site is None:
        raise UniFiError("No sites on this console")
    sid = site["id"]
    nets = []
    for n in _integration_list(client, f"/sites/{sid}/networks"):
        nets.append({"id": n.get("id"), "name": n.get("name") or "?", "vlan": _int(n.get("vlanId"), 1),
                     "purpose": (n.get("management") or "").lower(), "subnet": "", "is_default": bool(n.get("default")),
                     "enabled": n.get("enabled", True) is not False})
    nets.sort(key=lambda x: (x["vlan"], x["name"].lower()))
    devices = []
    for d in _integration_list(client, f"/sites/{sid}/devices"):
        if "ports" not in (d.get("interfaces") or []):
            continue
        try:
            det = _integration_get(client, f"/sites/{sid}/devices/{d['id']}")
        except UniFiError:
            continue
        ports = []
        for p in sorted((det.get("interfaces") or {}).get("ports") or [], key=lambda x: _int(x.get("idx"))):
            idx = _int(p.get("idx"))
            poe = p.get("poe") or None
            conn = p.get("connector") or ""
            ports.append({
                "idx": idx, "name": f"Port {idx}", "up": p.get("state") == "UP", "enabled": True,
                "speed": _int(p.get("speedMbps")), "full_duplex": False, "media": conn,
                "sfp": conn not in ("", "RJ45"), "is_uplink": False,
                "poe_capable": poe is not None, "poe_enabled": bool(poe and poe.get("enabled")),
                "poe_active": bool(poe and poe.get("state") == "UP"), "poe_power": None,
                "poe_mode": (poe or {}).get("standard") or "", "op_mode": "switch",
                "native_network_id": None, "tagged_mode": None, "excluded_network_ids": [],
                "profile_id": None, "profile_name": None, "clients": [], "client_count": 0,
                "device_link": None, "lldp": None, "rx_bytes": None, "tx_bytes": None,
                "protected": False, "protect_reasons": [], "max_speed": _int(p.get("maxSpeedMbps")),
            })
        feats = d.get("features") or []
        dtype = next((FEATURE_TYPE[f] for f in ("switching", "gateway", "accessPoint") if f in feats), "")
        devices.append({
            "id": d.get("id"), "mac": (d.get("macAddress") or "").lower(), "name": d.get("name") or d.get("model") or "?",
            "model": d.get("model") or "", "model_name": d.get("model") or "", "type": dtype,
            "type_label": DEVICE_TYPES.get(dtype, "Device"), "ip": d.get("ipAddress") or "",
            "version": d.get("firmwareVersion") or "", "online": d.get("state") == "ONLINE",
            "state": 1 if d.get("state") == "ONLINE" else 0, "uptime": 0, "legacy": False,
            "port_count": len(ports), "ports": ports,
        })
    devices.sort(key=lambda x: (x["type"] != "usw", x["name"].lower()))
    default = next((n["id"] for n in nets if n["is_default"]), None)
    return {"networks": nets, "default_network_id": default, "devices": devices,
            "readonly": True, "readonly_reason": READONLY_REASON}


# ----------------------------------------------------------------------------
# Normalizing
# ----------------------------------------------------------------------------

def normalize_networks(raw):
    nets = []
    for n in raw:
        purpose = n.get("purpose") or ""
        if purpose not in PORT_PURPOSES:
            continue
        vlan = _int(n.get("vlan"), 0) if n.get("vlan_enabled", True) and n.get("vlan") not in (None, "") else 0
        default = n.get("attr_hidden_id") == "LAN" or (purpose == "corporate" and not vlan and n.get("attr_no_delete"))
        nets.append({"id": n.get("_id"), "name": n.get("name") or "?", "vlan": vlan or 1,
                     "purpose": purpose, "subnet": n.get("ip_subnet") or "", "is_default": bool(default),
                     "enabled": n.get("enabled", True) is not False})
    nets.sort(key=lambda x: (x["vlan"], x["name"].lower()))
    return nets


def _default_network_id(nets):
    for n in nets:
        if n["is_default"]:
            return n["id"]
    for n in nets:
        if n["vlan"] == 1:
            return n["id"]
    return nets[0]["id"] if nets else None


def uses_legacy_forward(dev):
    """Old controllers configure tagging with `forward` + tagged_networkconf_ids."""
    rows = list(dev.get("port_overrides") or []) + list(dev.get("port_table") or [])
    if any("tagged_vlan_mgmt" in r for r in rows):
        return False
    return any("forward" in r for r in rows)


def _effective(pt, ov, profiles, nets, default_net):
    """Native network, tagged mode and exclusions a port actually has."""
    all_ids = [n["id"] for n in nets]
    profile_id = ov.get("portconf_id") if "portconf_id" in ov else pt.get("portconf_id")
    profile = profiles.get(profile_id) if profile_id else None
    builtin = bool(profile and (profile.get("attr_hidden_id") or profile.get("attr_no_delete")))
    if profile and not builtin:
        src = profile
    else:
        src = {**(profile or {}), **pt, **ov}
    native = src.get("native_networkconf_id") or default_net
    mode = src.get("tagged_vlan_mgmt")
    excluded = list(src.get("excluded_networkconf_ids") or [])
    fwd = src.get("forward")
    if mode not in MODES:
        mode = FORWARD_MODE.get(fwd, "auto")
        if mode == "custom" and not excluded:
            tagged = set(src.get("tagged_networkconf_ids") or [])
            excluded = [i for i in all_ids if i not in tagged and i != native]
    disabled = fwd == "disabled" or src.get("enable") is False or pt.get("enable") is False
    return {
        "native_network_id": native, "tagged_mode": mode, "excluded_network_ids": excluded,
        "profile_id": profile_id if profile and not builtin else None,
        "profile_name": (profile or {}).get("name") if profile and not builtin else None,
        "disabled": bool(disabled),
    }


def normalize(raw_devices, raw_networks, raw_portconfs, raw_clients, protect_uplinks=True):
    nets = normalize_networks(raw_networks)
    default_net = _default_network_id(nets)
    profiles = {p.get("_id"): p for p in raw_portconfs}
    by_mac = {(d.get("mac") or "").lower(): d for d in raw_devices}

    # links between UniFi devices: (switch mac, port) -> the device on the other end
    dev_links = {}
    for d in raw_devices:
        up = d.get("uplink") or {}
        umac, uport = (up.get("uplink_mac") or "").lower(), _int(up.get("uplink_remote_port"), 0)
        if umac and uport:
            dev_links[(umac, uport)] = d.get("name") or d.get("model") or d.get("mac")
        for dl in d.get("downlink_table") or []:
            pmac = (dl.get("mac") or "").lower()
            if dl.get("port_idx") and pmac in by_mac:
                peer = by_mac[pmac]
                dev_links.setdefault(((d.get("mac") or "").lower(), _int(dl["port_idx"])),
                                     peer.get("name") or peer.get("model") or pmac)

    clients = {}
    for c in raw_clients:
        if c.get("is_wired") is False or not c.get("sw_mac") or not c.get("sw_port"):
            continue
        key = ((c.get("sw_mac") or "").lower(), _int(c.get("sw_port")))
        clients.setdefault(key, []).append({
            "mac": c.get("mac") or "", "name": c.get("name") or c.get("hostname") or "",
            "ip": c.get("ip") or "", "hostname": c.get("hostname") or ""})

    devices = []
    for d in raw_devices:
        table = d.get("port_table") or []
        if not table:
            continue
        mac = (d.get("mac") or "").lower()
        overrides = {_int(o.get("port_idx")): o for o in d.get("port_overrides") or []}
        uplink_idx = _int((d.get("uplink") or {}).get("port_idx"), 0)
        ports = []
        for pt in sorted(table, key=lambda p: _int(p.get("port_idx"))):
            idx = _int(pt.get("port_idx"))
            if not idx:
                continue
            ov = overrides.get(idx, {})
            eff = _effective(pt, ov, profiles, nets, default_net)
            media = str(pt.get("media") or "")
            poe_capable = bool(pt.get("port_poe") or _int(pt.get("poe_caps")) > 0)
            poe_mode = ov.get("poe_mode") or pt.get("poe_mode") or ("auto" if poe_capable else "off")
            poe_power = 0.0
            try:
                poe_power = float(pt.get("poe_power") or 0)
            except (TypeError, ValueError):
                pass
            op_mode = ov.get("op_mode") or pt.get("op_mode") or "switch"
            reasons = []
            if pt.get("is_uplink") or idx == uplink_idx:
                reasons.append("Uplink port")
            if (mac, idx) in dev_links:
                reasons.append(f"Connects to UniFi device {dev_links[(mac, idx)]}")
            if pt.get("aggregated_by") or pt.get("lag_member") or op_mode == "aggregate":
                reasons.append("Part of a link aggregation")
            if op_mode == "mirror" or pt.get("mirror_port_idx"):
                reasons.append("Port mirroring")
            if op_mode not in ("switch", "aggregate", "mirror"):
                reasons.append(f"Operation mode is {op_mode}")
            lldp = None
            for l in d.get("lldp_table") or []:
                if _int(l.get("local_port_idx")) == idx:
                    lldp = {"name": l.get("chassis_descr") or l.get("system_name") or "",
                            "chassis_id": l.get("chassis_id") or "", "port": l.get("port_id") or ""}
            ports.append({
                "idx": idx,
                "name": ov.get("name") or pt.get("name") or f"Port {idx}",
                "up": bool(pt.get("up")),
                "enabled": pt.get("enable", True) is not False and not eff["disabled"],
                "speed": _int(pt.get("speed")),
                "full_duplex": bool(pt.get("full_duplex")),
                "media": media,
                "sfp": "SFP" in media.upper() or bool(pt.get("sfp_found")),
                "is_uplink": bool(pt.get("is_uplink") or idx == uplink_idx),
                "poe_capable": poe_capable,
                "poe_enabled": poe_capable and poe_mode != "off",
                "poe_active": bool(pt.get("poe_good")) or poe_power > 0.05,
                "poe_power": round(poe_power, 1),
                "poe_mode": poe_mode,
                "op_mode": op_mode,
                "native_network_id": eff["native_network_id"],
                "tagged_mode": eff["tagged_mode"],
                "excluded_network_ids": eff["excluded_network_ids"],
                "profile_id": eff["profile_id"],
                "profile_name": eff["profile_name"],
                "clients": clients.get((mac, idx), [])[:20],
                "client_count": len(clients.get((mac, idx), [])),
                "device_link": dev_links.get((mac, idx)),
                "lldp": lldp,
                "rx_bytes": _int(pt.get("rx_bytes")), "tx_bytes": _int(pt.get("tx_bytes")),
                "protected": bool(protect_uplinks and reasons),
                "protect_reasons": reasons,
            })
        dtype = d.get("type") or ""
        devices.append({
            "id": d.get("_id"), "mac": mac, "name": d.get("name") or d.get("model") or mac,
            "model": d.get("model") or "", "model_name": d.get("model_name") or d.get("shortname") or d.get("model") or "",
            "type": dtype, "type_label": DEVICE_TYPES.get(dtype, dtype.upper() or "Device"),
            "ip": d.get("ip") or "", "version": d.get("version") or "",
            "online": _int(d.get("state")) == 1, "state": _int(d.get("state")),
            "uptime": _int(d.get("uptime")), "legacy": uses_legacy_forward(d),
            "port_count": len(ports), "ports": ports,
        })
    devices.sort(key=lambda x: (x["type"] != "usw", x["name"].lower()))
    return {"networks": nets, "default_network_id": default_net, "devices": devices}


# ----------------------------------------------------------------------------
# Changing a port
# ----------------------------------------------------------------------------

def build_override(dev, port_idx, native_id, mode, excluded_ids, network_ids, detach_profile=True):
    """Return (new port_overrides list, before entry, after entry) for one port."""
    if mode not in MODES:
        raise UniFiError("Tagged VLAN management must be Allow All, Block All or Custom")
    overrides = copy.deepcopy(dev.get("port_overrides") or [])
    entry = next((o for o in overrides if _int(o.get("port_idx")) == port_idx), None)
    if entry is None:
        entry = {"port_idx": port_idx}
        overrides.append(entry)
    before = copy.deepcopy(entry)
    if entry.get("portconf_id") and detach_profile:
        entry.pop("portconf_id", None)
    entry["native_networkconf_id"] = native_id
    entry["tagged_vlan_mgmt"] = mode
    excluded = [i for i in excluded_ids if i in network_ids and i != native_id] if mode == "custom" else []
    entry["excluded_networkconf_ids"] = excluded
    if uses_legacy_forward(dev):
        entry["forward"] = LEGACY_FORWARD[mode]
        if mode == "custom":
            entry["tagged_networkconf_ids"] = [i for i in network_ids if i not in excluded and i != native_id]
        else:
            entry.pop("tagged_networkconf_ids", None)
    overrides.sort(key=lambda o: _int(o.get("port_idx")))
    return overrides, before, copy.deepcopy(entry)


def verify_override(dev, port_idx, native_id, mode):
    entry = next((o for o in dev.get("port_overrides") or [] if _int(o.get("port_idx")) == port_idx), {})
    got_mode = entry.get("tagged_vlan_mgmt") or FORWARD_MODE.get(entry.get("forward"))
    return entry.get("native_networkconf_id") == native_id and got_mode == mode and not entry.get("portconf_id")


# ----------------------------------------------------------------------------
# Cached snapshot
# ----------------------------------------------------------------------------

class Snapshot:
    """Short-lived cache so many open browsers don't hammer the controller."""

    RECHECK = 600   # a read-only cloud environment retries the full API every 10 minutes

    def __init__(self, ttl=5):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._key = None
        self._at = 0
        self._data = None
        self._raw = None
        self.readonly = False
        self._readonly_since = 0

    def invalidate(self):
        with self._lock:
            self._at = 0

    def get(self, client, protect_uplinks, force=False):
        key = (client.mode, client.host, client.api_key, client.site, client.console_id, protect_uplinks)
        with self._lock:
            if not force and self._data is not None and self._key == key and time.time() - self._at < self.ttl:
                return self._data, self._raw
            if self._key != key:
                self.readonly, self._readonly_since = False, 0
            data = raw = None
            if client.mode == "cloud" and self.readonly and time.time() - self._readonly_since < self.RECHECK:
                data = integration_snapshot(client)
            else:
                try:
                    raw = {
                        "devices": client.raw_devices(),
                        "networks": client.raw_networks(),
                        "portconfs": client.raw_portconfs(),
                        "clients": client.raw_clients(),
                    }
                    data = normalize(raw["devices"], raw["networks"], raw["portconfs"], raw["clients"], protect_uplinks)
                    self.readonly = False
                except UniFiError:
                    if client.mode != "cloud":
                        raise
                    # the cloud connector refused the switch-port API: show what the official API allows
                    data = integration_snapshot(client)
                    self.readonly, self._readonly_since = True, time.time()
            data.setdefault("readonly", False)
            data["fetched_at"] = int(time.time())
            self._key, self._at, self._data, self._raw = key, time.time(), data, raw
            return data, raw
