from conftest import configure_unifi, make_user

import unifi
import versioning


def _port(state, dev_id, idx):
    dev = next(d for d in state["devices"] if d["id"] == dev_id)
    return next(p for p in dev["ports"] if p["idx"] == idx)


def _state(c, eid, refresh=False):
    return c.get(f"/api/envs/{eid}/state" + ("?refresh=1" if refresh else "")).get_json()


def _set(c, eid, dev, idx, **body):
    return c.put(f"/api/envs/{eid}/devices/{dev}/ports/{idx}", json=body)


def test_state_lists_switches_networks_and_status(fake, admin):
    eid = configure_unifi(admin)
    s = _state(admin, eid)
    assert s["error"] is None
    names = [n["name"] for n in s["networks"]]
    assert "Internet 1" not in names and "Rack System 7-.170.x" in names
    p1 = _port(s, "dev-sw8", 1)
    assert p1["up"] and p1["poe_enabled"] and p1["poe_active"] and p1["native_network_id"] == "net-rack7"
    assert p1["tagged_mode"] == "block_all" and p1["clients"][0]["mac"] == "80:d7:33:4e:28:c4"
    p4 = _port(s, "dev-sw8", 4)
    assert p4["poe_capable"] and not p4["poe_enabled"]
    p3 = _port(s, "dev-sw8", 3)
    assert p3["native_network_id"] == "net-lan" and p3["tagged_mode"] == "auto"
    assert _port(s, "dev-sw8", 7)["profile_name"] == "Camera ports"
    assert _port(s, "dev-sw8", 8)["protected"]
    assert _port(s, "dev-sw24", 1)["protected"]
    assert "Lobby AP" in _port(s, "dev-sw24", 1)["protect_reasons"][0]
    assert _port(s, "dev-sw24", 12)["excluded_network_ids"] == ["net-guest"]


def test_supervisor_sets_native_vlan_block_all(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "sup", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    r = _set(sup, eid, "dev-sw8", 3, native_network_id="net-rack7", tagged_mode="block_all")
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["verified"]
    stored = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw8")["port_overrides"]
    p3 = next(o for o in stored if o["port_idx"] == 3)
    assert p3["native_networkconf_id"] == "net-rack7" and p3["tagged_vlan_mgmt"] == "block_all"
    assert any(o["port_idx"] == 6 and o["native_networkconf_id"] == "net-cam" for o in stored)
    assert _port(_state(sup, eid, True), "dev-sw8", 3)["native_network_id"] == "net-rack7"
    audit = sup.get("/api/audit").get_json()["entries"]
    assert audit[0]["action"] == "port.set" and audit[0]["detail"]["after"]["native"] == "Rack System 7-.170.x (700)"
    assert audit[0]["env_name"] == "Rack 7"


def test_custom_tagging_keeps_exclusions(fake, admin):
    eid = configure_unifi(admin)
    r = _set(admin, eid, "dev-sw24", 2, native_network_id="net-iot", tagged_mode="custom",
             excluded_network_ids=["net-guest", "net-iot", "nope"])
    assert r.status_code == 200
    p = _port(_state(admin, eid, True), "dev-sw24", 2)
    assert p["tagged_mode"] == "custom" and p["excluded_network_ids"] == ["net-guest"]


def test_protected_port_needs_admin_and_confirmation(app, fake, admin):
    eid = configure_unifi(admin)
    body = {"native_network_id": "net-iot", "tagged_mode": "block_all"}
    r = _set(admin, eid, "dev-sw8", 8, **body)
    assert r.status_code == 409 and r.get_json()["confirm"] == "protected"
    assert _set(admin, eid, "dev-sw8", 8, **body, confirm_protected=True).status_code == 200
    uid, sup = make_user(admin, app, "sup2", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    assert _set(sup, eid, "dev-sw24", 25, **body, confirm_protected=True).status_code == 403
    # an admin can let an environment's supervisors change protected ports
    admin.put(f"/api/admin/envs/{eid}", json={"supervisors_protected": True})
    assert _set(sup, eid, "dev-sw24", 25, **body).get_json()["confirm"] == "protected"
    assert _set(sup, eid, "dev-sw24", 25, **body, confirm_protected=True).status_code == 200


def test_profile_port_needs_detach_confirmation(fake, admin):
    eid = configure_unifi(admin)
    body = {"native_network_id": "net-iot", "tagged_mode": "block_all"}
    r = _set(admin, eid, "dev-sw8", 7, **body)
    assert r.status_code == 409 and r.get_json()["confirm"] == "profile"
    r = _set(admin, eid, "dev-sw8", 7, **body, detach_profile=True)
    assert r.status_code == 200 and r.get_json()["verified"]


def test_change_made_in_unifi_meanwhile_is_detected(fake, admin):
    eid = configure_unifi(admin)
    seen = _port(_state(admin, eid), "dev-sw8", 3)
    expected = {k: seen[k] for k in ("native_network_id", "tagged_mode", "excluded_network_ids")}
    # someone changes port 3 in the UniFi UI
    dev = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw8")
    dev["port_overrides"].append({"port_idx": 3, "native_networkconf_id": "net-voip", "tagged_vlan_mgmt": "block_all"})
    r = _set(admin, eid, "dev-sw8", 3, native_network_id="net-iot", tagged_mode="block_all", expected=expected)
    assert r.status_code == 409 and r.get_json()["confirm"] == "changed"
    assert r.get_json()["current"]["native"] == "VoIP (50)"
    r = _set(admin, eid, "dev-sw8", 3, native_network_id="net-iot", tagged_mode="block_all",
             expected=expected, confirm_changed=True)
    assert r.status_code == 200


def test_unknown_network_rejected(fake, admin):
    eid = configure_unifi(admin)
    assert _set(admin, eid, "dev-sw8", 3, native_network_id="net-wan", tagged_mode="block_all").status_code == 400


def test_bad_api_key_reports_error(fake, admin):
    r = admin.post("/api/admin/envs", json={"name": "Bad", "host": "http://fake", "api_key": "wrong"})
    s = _state(admin, r.get_json()["env"]["id"])
    assert "rejected the API key" in s["error"]


def test_env_test_endpoint_lists_sites_and_uses_saved_key(fake, admin):
    body = admin.post("/api/admin/envs/test", json={"host": "http://fake", "api_key": "test-key"}).get_json()
    assert body["ok"] and body["devices"] == 4 and {"name": "default", "desc": "Default"} in body["sites"]
    eid = configure_unifi(admin)
    # testing a saved environment without retyping its key
    assert admin.post("/api/admin/envs/test", json={"env_id": eid, "host": "http://fake"}).get_json()["ok"]


def test_api_key_never_leaves_the_server(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "sup3", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    for c, url in ((admin, "/api/admin/envs"), (admin, "/api/envs"), (sup, f"/api/envs/{eid}/config"),
                   (sup, "/api/envs"), (sup, f"/api/envs/{eid}/state")):
        assert "test-key" not in c.get(url).get_data(as_text=True), url
    cfg = sup.get(f"/api/envs/{eid}/config").get_json()
    assert cfg["host"] == "http://fake:18443" and cfg["api_key_set"]
    assert sup.get("/api/admin/envs").status_code == 403
    assert sup.put(f"/api/admin/envs/{eid}", json={"api_key": "x"}).status_code == 403


def test_users_only_see_their_environments(app, fake, admin):
    e1 = configure_unifi(admin, "Tech A")
    e2 = configure_unifi(admin, "Tech B")
    uid, sup = make_user(admin, app, "techa", "supervisor")
    assert sup.get("/api/envs").get_json()["envs"] == []
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": e1}]})
    assert [e["name"] for e in sup.get("/api/envs").get_json()["envs"]] == ["Tech A"]
    assert sup.get(f"/api/envs/{e2}/state").status_code == 404
    assert _set(sup, e2, "dev-sw8", 3, native_network_id="net-iot", tagged_mode="block_all").status_code == 404
    assert sup.get(f"/api/envs/{e2}/config").status_code == 404
    # supervisors only see port changes in their own environments
    _set(admin, e2, "dev-sw8", 3, native_network_id="net-iot", tagged_mode="block_all")
    assert all(e["env_name"] == "Tech A" for e in sup.get("/api/audit").get_json()["entries"])


def test_vlan_allow_list_limits_changes(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "techv", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [
        {"env_id": eid, "all_vlans": False, "vlans": ["net-rack7", "net-cam"]}]})
    s = _state(sup, eid)
    assert {n["id"] for n in s["networks"] if n["allowed"]} == {"net-rack7", "net-cam"}
    assert _set(sup, eid, "dev-sw8", 3, native_network_id="net-iot", tagged_mode="block_all").status_code == 403
    # Allow All would tag networks they can't use
    assert _set(sup, eid, "dev-sw8", 3, native_network_id="net-cam", tagged_mode="auto").status_code == 403
    # Custom never tags a network outside the list, whatever the client sends
    r = _set(sup, eid, "dev-sw8", 3, native_network_id="net-cam", tagged_mode="custom", excluded_network_ids=[])
    assert r.status_code == 200
    p = _port(_state(sup, eid, True), "dev-sw8", 3)
    assert set(p["excluded_network_ids"]) == {"net-lan", "net-iot", "net-guest", "net-voip"}


def test_device_allow_list_is_by_mac(app, fake, admin):
    eid = configure_unifi(admin)
    uid, viewer = make_user(admin, app, "viewer1")
    admin.put(f"/api/users/{uid}/access", json={"envs": [
        {"env_id": eid, "all_devices": False, "devices": ["AA:00:00:00:00:08"]}]})
    s = _state(viewer, eid)
    assert [d["id"] for d in s["devices"]] == ["dev-sw8"]
    assert viewer.get("/api/audit").status_code == 403
    assert viewer.get(f"/api/envs/{eid}/config").status_code == 403
    assert _set(viewer, eid, "dev-sw8", 3, native_network_id="net-cam", tagged_mode="block_all").status_code == 403
    # a switch that's forgotten and re-adopted gets a new id but keeps its MAC - and its access
    dev = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw8")
    dev["_id"] = "dev-sw8-readopted"
    assert [d["id"] for d in _state(viewer, eid, True)["devices"]] == ["dev-sw8-readopted"]


def test_hidden_device_cannot_be_changed(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "techd", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [
        {"env_id": eid, "all_devices": False, "devices": ["aa:00:00:00:00:08"]}]})
    assert _set(sup, eid, "dev-sw24", 2, native_network_id="net-cam", tagged_mode="block_all").status_code == 404


def test_deleting_environment_removes_access(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "techx", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    assert admin.delete(f"/api/admin/envs/{eid}", json={}).status_code == 200
    assert sup.get("/api/envs").get_json()["envs"] == []
    assert admin.get(f"/api/users/{uid}/access").get_json()["envs"] == []


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


def _lock_url(eid, dev, idx):
    return f"/api/envs/{eid}/devices/{dev}/ports/{idx}/lock"


def test_admin_lock_blocks_supervisors_and_shows_in_state(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "techl", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    _set(admin, eid, "dev-sw8", 3, native_network_id="net-rack7", tagged_mode="block_all")
    assert admin.put(_lock_url(eid, "dev-sw8", 3), json={"note": "Upstream trunk"}).status_code == 200
    assert sup.put(_lock_url(eid, "dev-sw8", 3), json={}).status_code == 403   # only admins lock
    p = _port(_state(sup, eid, True), "dev-sw8", 3)
    assert p["lock"]["note"] == "Upstream trunk" and p["lock"]["native_network_id"] == "net-rack7"
    assert p["lock"]["drift"] is False
    r = _set(sup, eid, "dev-sw8", 3, native_network_id="net-cam", tagged_mode="block_all")
    assert r.status_code == 403 and "Upstream trunk" in r.get_json()["error"]
    # admins are asked, and the lock follows their change
    assert _set(admin, eid, "dev-sw8", 3, native_network_id="net-cam", tagged_mode="block_all").get_json()["confirm"] == "locked"
    assert _set(admin, eid, "dev-sw8", 3, native_network_id="net-cam", tagged_mode="block_all",
                confirm_locked=True).status_code == 200
    p = _port(_state(admin, eid, True), "dev-sw8", 3)
    assert p["lock"]["native_network_id"] == "net-cam" and p["lock"]["note"] == "Upstream trunk"
    assert admin.delete(_lock_url(eid, "dev-sw8", 3), json={}).status_code == 200
    assert _port(_state(admin, eid, True), "dev-sw8", 3)["lock"] is None
    assert _set(sup, eid, "dev-sw8", 3, native_network_id="net-iot", tagged_mode="block_all").status_code == 200
    actions = [e["action"] for e in admin.get("/api/audit").get_json()["entries"]]
    assert "port.locked" in actions and "port.unlocked" in actions


def test_lock_drift_after_change_in_unifi_and_reapply(fake, admin):
    eid = configure_unifi(admin)
    _set(admin, eid, "dev-sw24", 2, native_network_id="net-iot", tagged_mode="custom", excluded_network_ids=["net-guest"])
    admin.put(_lock_url(eid, "dev-sw24", 2), json={})
    # someone changes it in the UniFi UI
    dev = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw24")
    o = next(o for o in dev["port_overrides"] if o["port_idx"] == 2)
    o.update(native_networkconf_id="net-lan", tagged_vlan_mgmt="auto", excluded_networkconf_ids=[])
    p = _port(_state(admin, eid, True), "dev-sw24", 2)
    assert p["lock"]["drift"] is True
    r = admin.post(_lock_url(eid, "dev-sw24", 2) + "/reapply", json={})
    assert r.status_code == 200 and r.get_json()["verified"]
    p = _port(_state(admin, eid, True), "dev-sw24", 2)
    assert p["native_network_id"] == "net-iot" and p["tagged_mode"] == "custom" and p["lock"]["drift"] is False


def test_lock_survives_readoption(fake, admin):
    eid = configure_unifi(admin)
    admin.put(_lock_url(eid, "dev-sw8", 5), json={"note": "desk phone"})
    dev = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw8")
    dev["_id"] = "dev-sw8-new"
    assert _port(_state(admin, eid, True), "dev-sw8-new", 5)["lock"]["note"] == "desk phone"
