from conftest import configure_unifi, login

import unifi
import versioning


def _port(state, dev_id, idx):
    dev = next(d for d in state["devices"] if d["id"] == dev_id)
    return next(p for p in dev["ports"] if p["idx"] == idx)


def test_state_lists_switches_networks_and_status(fake, admin):
    configure_unifi(admin)
    s = admin.get("/api/state").get_json()
    assert s["error"] is None
    names = [n["name"] for n in s["networks"]]
    assert "Internet 1" not in names and "Rack System 7-.170.x" in names
    p1 = _port(s, "dev-sw8", 1)
    assert p1["up"] and p1["poe_enabled"] and p1["poe_active"] and p1["native_network_id"] == "net-rack7"
    assert p1["tagged_mode"] == "block_all" and p1["clients"][0]["mac"] == "80:d7:33:4e:28:c4"
    p4 = _port(s, "dev-sw8", 4)
    assert p4["poe_capable"] and not p4["poe_enabled"]
    # port with no override: default LAN, Allow All
    p3 = _port(s, "dev-sw8", 3)
    assert p3["native_network_id"] == "net-lan" and p3["tagged_mode"] == "auto"
    # profile attached
    assert _port(s, "dev-sw8", 7)["profile_name"] == "Camera ports"
    # uplink + the port a UniFi AP hangs off are protected
    assert _port(s, "dev-sw8", 8)["protected"]
    assert _port(s, "dev-sw24", 1)["protected"]
    assert "Lobby AP" in _port(s, "dev-sw24", 1)["protect_reasons"][0]
    assert _port(s, "dev-sw24", 12)["excluded_network_ids"] == ["net-guest"]


def test_supervisor_sets_native_vlan_block_all(app, fake, admin):
    configure_unifi(admin)
    uid = admin.post("/api/users", json={"username": "sup", "password": "suppass123"}).get_json()["user"]["id"]
    admin.put(f"/api/users/{uid}", json={"role": "supervisor"})
    c = app.test_client()
    login(c, "sup", "suppass123")
    r = c.put("/api/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7", "tagged_mode": "block_all"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["verified"]
    stored = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw8")["port_overrides"]
    p3 = next(o for o in stored if o["port_idx"] == 3)
    assert p3["native_networkconf_id"] == "net-rack7" and p3["tagged_vlan_mgmt"] == "block_all"
    # other ports' overrides survived the full-list PUT
    assert any(o["port_idx"] == 6 and o["native_networkconf_id"] == "net-cam" for o in stored)
    s = c.get("/api/state?refresh=1").get_json()
    assert _port(s, "dev-sw8", 3)["native_network_id"] == "net-rack7"
    audit = c.get("/api/audit").get_json()["entries"]
    assert audit[0]["action"] == "port.set" and audit[0]["detail"]["after"]["native"] == "Rack System 7-.170.x (700)"


def test_custom_tagging_keeps_exclusions(fake, admin):
    configure_unifi(admin)
    r = admin.put("/api/devices/dev-sw24/ports/2", json={
        "native_network_id": "net-iot", "tagged_mode": "custom",
        "excluded_network_ids": ["net-guest", "net-iot", "nope"]})
    assert r.status_code == 200
    p = _port(admin.get("/api/state?refresh=1").get_json(), "dev-sw24", 2)
    assert p["tagged_mode"] == "custom" and p["excluded_network_ids"] == ["net-guest"]


def test_protected_port_needs_admin_and_confirmation(app, fake, admin):
    configure_unifi(admin)
    body = {"native_network_id": "net-iot", "tagged_mode": "block_all"}
    r = admin.put("/api/devices/dev-sw8/ports/8", json=body)
    assert r.status_code == 409 and r.get_json()["confirm"] == "protected"
    assert admin.put("/api/devices/dev-sw8/ports/8", json={**body, "confirm_protected": True}).status_code == 200
    uid = admin.post("/api/users", json={"username": "sup2", "password": "suppass123"}).get_json()["user"]["id"]
    admin.put(f"/api/users/{uid}", json={"role": "supervisor"})
    c = app.test_client()
    login(c, "sup2", "suppass123")
    assert c.put("/api/devices/dev-sw24/ports/25", json={**body, "confirm_protected": True}).status_code == 403


def test_profile_port_needs_detach_confirmation(fake, admin):
    configure_unifi(admin)
    body = {"native_network_id": "net-iot", "tagged_mode": "block_all"}
    r = admin.put("/api/devices/dev-sw8/ports/7", json=body)
    assert r.status_code == 409 and r.get_json()["confirm"] == "profile"
    r = admin.put("/api/devices/dev-sw8/ports/7", json={**body, "detach_profile": True})
    assert r.status_code == 200 and r.get_json()["verified"]


def test_unknown_network_rejected(fake, admin):
    configure_unifi(admin)
    r = admin.put("/api/devices/dev-sw8/ports/3", json={"native_network_id": "net-wan", "tagged_mode": "block_all"})
    assert r.status_code == 400


def test_bad_api_key_reports_error(fake, admin):
    admin.put("/api/settings", json={"unifi_host": "http://fake", "unifi_api_key": "wrong"})
    s = admin.get("/api/state").get_json()
    assert "rejected the API key" in s["error"]


def test_unifi_test_endpoint_lists_sites(fake, admin):
    r = admin.post("/api/settings/unifi/test", json={"unifi_host": "http://fake", "unifi_api_key": "test-key"})
    body = r.get_json()
    assert body["ok"] and body["devices"] == 4 and {"name": "default", "desc": "Default"} in body["sites"]


def test_legacy_forward_is_written_for_old_controllers():
    dev = {"port_overrides": [{"port_idx": 1, "forward": "all", "portconf_id": "pc-all"}], "port_table": []}
    overrides, before, after = unifi.build_override(dev, 1, "a", "custom", ["b"], ["a", "b", "c"])
    assert after["forward"] == "customize" and after["tagged_networkconf_ids"] == ["c"]
    assert "portconf_id" not in after


def test_version_rolls_over_at_nine():
    assert versioning.next_version("1.0") == "1.1"
    assert versioning.next_version("1.9") == "2.0"
    assert versioning.version_key("2.0") > versioning.version_key("1.9")
    assert versioning.VERSION == versioning.CHANGELOG[0]["version"]
