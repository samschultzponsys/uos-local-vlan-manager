"""
A small fake UniFi Network controller for tests and UI development.

    python tests/fake_unifi.py            # serves http://127.0.0.1:18443, API key "test-key"

Implements the handful of classic-API endpoints VLAN Manager uses, with a
gateway, an 8-port PoE switch, a 24-port PoE switch and an access point.
PUT rest/device/<id> stores port_overrides like the real controller does.
"""

import copy
import os
import random
import sys

from flask import Flask, jsonify, request

API_KEY = "test-key"

NETWORKS = [
    {"_id": "net-lan", "name": "Default", "purpose": "corporate", "attr_hidden_id": "LAN",
     "attr_no_delete": True, "ip_subnet": "192.168.1.1/24", "vlan_enabled": False},
    {"_id": "net-rack7", "name": "Rack System 7-.170.x", "purpose": "corporate", "vlan": 700,
     "vlan_enabled": True, "ip_subnet": "10.7.170.1/24"},
    {"_id": "net-cam", "name": "Cameras", "purpose": "corporate", "vlan": 20, "vlan_enabled": True,
     "ip_subnet": "10.0.20.1/24"},
    {"_id": "net-iot", "name": "IoT", "purpose": "corporate", "vlan": 30, "vlan_enabled": True,
     "ip_subnet": "10.0.30.1/24"},
    {"_id": "net-guest", "name": "Guest", "purpose": "guest", "vlan": 40, "vlan_enabled": True,
     "ip_subnet": "10.0.40.1/24"},
    {"_id": "net-voip", "name": "VoIP", "purpose": "vlan-only", "vlan": 50, "vlan_enabled": True},
    {"_id": "net-wan", "name": "Internet 1", "purpose": "wan"},
]
PORTCONFS = [
    {"_id": "pc-all", "name": "All", "attr_hidden_id": "All", "attr_no_delete": True, "forward": "all",
     "native_networkconf_id": "net-lan"},
    {"_id": "pc-cams", "name": "Camera ports", "native_networkconf_id": "net-cam",
     "tagged_vlan_mgmt": "block_all"},
]


def _port(idx, up=False, speed=0, poe=False, poe_power=0.0, media="GE", uplink=False, poe_mode="auto", name=None):
    p = {"port_idx": idx, "name": name or f"Port {idx}", "up": up, "speed": speed if up else 0,
         "full_duplex": up, "media": media, "is_uplink": uplink, "enable": True,
         "rx_bytes": random.randint(0, 10**10) if up else 0, "tx_bytes": random.randint(0, 10**10) if up else 0}
    if poe:
        p.update({"port_poe": True, "poe_caps": 7, "poe_mode": poe_mode,
                  "poe_good": poe_power > 0, "poe_power": str(poe_power)})
    return p


def make_devices():
    random.seed(7)
    gw = {"_id": "dev-gw", "mac": "aa:00:00:00:00:01", "name": "Gateway", "model": "UCGMAX",
          "model_name": "Cloud Gateway Max", "type": "udm", "ip": "192.168.1.1", "state": 1,
          "version": "4.3.6", "uptime": 864000,
          "port_table": [_port(1, True, 1000, name="LAN 1"), _port(2, True, 1000, name="LAN 2"),
                         _port(3), _port(4), _port(5, True, 2500, media="2P5GE", name="WAN", uplink=True)],
          "port_overrides": []}
    sw8 = {"_id": "dev-sw8", "mac": "aa:00:00:00:00:08", "name": "Rack 7 Switch", "model": "USL8LPB",
           "model_name": "USW Lite 8 PoE", "type": "usw", "ip": "192.168.1.20", "state": 1,
           "version": "7.1.26", "uptime": 432000,
           "uplink": {"uplink_mac": "aa:00:00:00:00:01", "uplink_remote_port": 1, "port_idx": 8},
           "port_table": [
               _port(1, True, 100, True, 4.2, name="Wallboard"),
               _port(2, False, poe=True, name="PoE Out + Data"),
               _port(3, False, poe=True, name="PoE Out + Data"),
               _port(4, False, poe=True, poe_mode="off", name="PoE Out + Data"),
               _port(5, False, poe=True, name="PoE Out + Data"),
               _port(6, True, 1000, True, 6.8, name="PoE Out + Data"),
               _port(7, True, 100, True, 3.1, name="PoE Out + Data"),
               _port(8, True, 1000, name="PoE In + Data", uplink=True)],
           "port_overrides": [
               {"port_idx": 1, "native_networkconf_id": "net-rack7", "tagged_vlan_mgmt": "block_all"},
               {"port_idx": 2, "native_networkconf_id": "net-rack7", "tagged_vlan_mgmt": "block_all"},
               {"port_idx": 6, "native_networkconf_id": "net-cam", "tagged_vlan_mgmt": "block_all"},
               {"port_idx": 7, "portconf_id": "pc-cams"}]}
    sw24_ports = []
    for i in range(1, 25):
        up = random.random() < 0.6
        sw24_ports.append(_port(i, up, random.choice([100, 1000, 1000, 1000]), True,
                                round(random.uniform(2, 12), 1) if up and random.random() < 0.6 else 0.0))
    sw24_ports += [_port(25, True, 10000, media="SFP+", uplink=True, name="SFP+ 1"),
                   _port(26, False, media="SFP+", name="SFP+ 2")]
    sw24 = {"_id": "dev-sw24", "mac": "aa:00:00:00:00:24", "name": "Office Core", "model": "US24PRO",
            "model_name": "USW Pro 24 PoE", "type": "usw", "ip": "192.168.1.21", "state": 1,
            "version": "7.1.26", "uptime": 1728000,
            "uplink": {"uplink_mac": "aa:00:00:00:00:01", "uplink_remote_port": 2, "port_idx": 25},
            "port_table": sw24_ports,
            "port_overrides": [{"port_idx": i, "native_networkconf_id": n, "tagged_vlan_mgmt": "block_all"}
                               for i, n in [(3, "net-iot"), (4, "net-iot"), (5, "net-voip"), (6, "net-voip"),
                                            (9, "net-guest"), (10, "net-cam"), (11, "net-cam")]]
                              + [{"port_idx": 12, "native_networkconf_id": "net-lan", "tagged_vlan_mgmt": "custom",
                                  "excluded_networkconf_ids": ["net-guest"]}]}
    ap = {"_id": "dev-ap", "mac": "aa:00:00:00:00:a1", "name": "Lobby AP", "model": "U7PRO",
          "model_name": "U7 Pro", "type": "uap", "ip": "192.168.1.30", "state": 1, "version": "8.0.1",
          "uplink": {"uplink_mac": "aa:00:00:00:00:24", "uplink_remote_port": 1},
          "port_table": [_port(1, True, 2500, media="2P5GE", uplink=True, name="Uplink")]}
    return [gw, sw8, sw24, ap]


CLIENTS = [
    {"mac": "80:d7:33:4e:28:c4", "hostname": "wallboard", "ip": "10.7.170.21", "is_wired": True,
     "sw_mac": "aa:00:00:00:00:08", "sw_port": 1},
    {"mac": "1c:ee:c9:50:a6:d1", "name": "Rack cam 1", "ip": "10.0.20.14", "is_wired": True,
     "sw_mac": "aa:00:00:00:00:08", "sw_port": 6},
    {"mac": "50:af:73:3c:e6:9c", "name": "Rack cam 2", "ip": "10.0.20.15", "is_wired": True,
     "sw_mac": "aa:00:00:00:00:08", "sw_port": 7},
    {"mac": "00:11:22:33:44:55", "hostname": "printer", "ip": "192.168.1.50", "is_wired": True,
     "sw_mac": "aa:00:00:00:00:24", "sw_port": 2},
    {"mac": "66:11:22:33:44:55", "hostname": "phone", "ip": "10.0.40.9", "is_wired": False},
]


def create_app():
    app = Flask(__name__)
    state = {"devices": make_devices()}
    app.config["STATE"] = state

    @app.before_request
    def _auth():
        if request.headers.get("X-API-KEY") != API_KEY:
            return jsonify({"meta": {"rc": "error", "msg": "api.err.LoginRequired"}, "data": []}), 401

    def ok(data):
        return jsonify({"meta": {"rc": "ok"}, "data": data})

    @app.route("/proxy/network/api/self/sites")
    def sites():
        return ok([{"name": "default", "desc": "Default"}, {"name": "x1y2z3", "desc": "Branch"}])

    @app.route("/proxy/network/api/s/<site>/stat/device")
    def devices(site):
        return ok(state["devices"]) if site == "default" else (jsonify({"meta": {"rc": "error", "msg": "api.err.NoSiteContext"}}), 400)

    @app.route("/proxy/network/api/s/<site>/stat/device/<mac>")
    def device(site, mac):
        return ok([d for d in state["devices"] if d["mac"] == mac.lower()])

    @app.route("/proxy/network/api/s/<site>/rest/networkconf")
    def networks(site):
        return ok(NETWORKS)

    @app.route("/proxy/network/api/s/<site>/rest/portconf")
    def portconf(site):
        return ok(PORTCONFS)

    @app.route("/proxy/network/api/s/<site>/stat/sta")
    def clients(site):
        return ok(CLIENTS)

    @app.route("/proxy/network/api/s/<site>/rest/device/<dev_id>", methods=["PUT"])
    def put_device(site, dev_id):
        dev = next((d for d in state["devices"] if d["_id"] == dev_id), None)
        if dev is None:
            return jsonify({"meta": {"rc": "error", "msg": "api.err.IdInvalid"}}), 400
        body = request.get_json()
        if "port_overrides" in body:
            dev["port_overrides"] = copy.deepcopy(body["port_overrides"])
        return ok([dev])

    # --- UniFi cloud stand-in: Site Manager hosts + the connector, which (like the real one)
    # carries the official Integration API but refuses the switch-port API
    @app.route("/v1/hosts")
    def hosts():
        return jsonify({"data": [{"id": "HOST:1", "hardwareId": "3be578f1-fc61-4478-926e-441311aaaf64",
                                  "isBlocked": False, "reportedState": {"name": "UOS-Test", "version": "5.0.6"},
                                  "userData": {"role": "owner", "permissions": {"network.management": ["admin"]}}}]})

    CONNECTOR = "/v1/connector/consoles/<cid>/network"

    @app.route(CONNECTOR + "/api/<path:rest>", methods=["GET", "PUT", "POST"])
    def connector_classic(cid, rest):
        return jsonify({"code": "FORBIDDEN"}), 403

    @app.route(CONNECTOR + "/integration/v1/info")
    def i_info(cid):
        return jsonify({"applicationVersion": "10.0.160"})

    def page(items):
        return jsonify({"data": items, "count": len(items), "offset": 0, "limit": 200, "totalCount": len(items)})

    @app.route(CONNECTOR + "/integration/v1/sites")
    def i_sites(cid):
        return page([{"id": "site-uuid", "internalReference": "default", "name": "Default"}])

    @app.route(CONNECTOR + "/integration/v1/sites/<sid>/networks")
    def i_networks(cid, sid):
        return page([{"id": n["_id"], "name": n["name"], "vlanId": n.get("vlan") or 1, "default": n.get("attr_hidden_id") == "LAN",
                      "enabled": True, "management": "GATEWAY"} for n in NETWORKS if n["purpose"] != "wan"])

    def i_device(d):
        return {"id": d["_id"], "macAddress": d["mac"], "name": d["name"], "model": d["model"], "ipAddress": d["ip"],
                "state": "ONLINE", "firmwareVersion": d["version"], "features": ["switching"] if d["type"] == "usw" else [],
                "interfaces": ["ports"]}

    @app.route(CONNECTOR + "/integration/v1/sites/<sid>/devices")
    def i_devices(cid, sid):
        return page([i_device(d) for d in state["devices"]])

    @app.route(CONNECTOR + "/integration/v1/sites/<sid>/devices/<did>")
    def i_device_details(cid, sid, did):
        d = next(x for x in state["devices"] if x["_id"] == did)
        ports = [{"idx": p["port_idx"], "state": "UP" if p["up"] else "DOWN", "speedMbps": p["speed"],
                  "maxSpeedMbps": 10000 if "SFP" in p["media"] else 1000,
                  "connector": "SFPPLUS" if "SFP" in p["media"] else "RJ45",
                  **({"poe": {"enabled": p.get("poe_mode") != "off", "state": "UP" if p.get("poe_good") else "DOWN",
                              "standard": "802.3at", "type": 2}} if p.get("port_poe") else {})}
                 for p in d["port_table"]]
        return jsonify({**i_device(d), "interfaces": {"ports": ports}})

    return app


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "18443"))
    create_app().run(host="127.0.0.1", port=port)
