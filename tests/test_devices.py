from conftest import configure_unifi


def _state(c, eid, refresh=False):
    return c.get(f"/api/envs/{eid}/state" + ("?refresh=1" if refresh else "")).get_json()


def _dev(state, dev_id):
    return next(d for d in state["devices"] if d["id"] == dev_id)


def _port(state, dev_id, idx):
    return next(p for p in _dev(state, dev_id)["ports"] if p["idx"] == idx)


def _fake_dev(fake, dev_id):
    return next(d for d in fake.config["STATE"]["devices"] if d["_id"] == dev_id)


def test_all_device_kinds_with_model_names_and_roles(fake, admin):
    eid = configure_unifi(admin)
    s = _state(admin, eid)
    kinds = [(d["kind"], d["model_name"]) for d in s["devices"]]
    assert kinds[0] == ("gateway", "Cloud Gateway Max")      # gateways first, then switches, then APs
    assert ("switch", "USW Flex Mini") in kinds and kinds[-1] == ("ap", "U7 Pro")
    wan = _port(s, "dev-gw", 5)
    assert wan["role"] == "wan" and wan["protected"] and "WAN port" in wan["protect_reasons"]
    up = _port(s, "dev-sw8", 8)
    assert up["role"] == "uplink" and up["peer"] == "Gateway"
    assert _port(s, "dev-sw24", 1)["role"] == "device" and _port(s, "dev-sw24", 1)["peer"] == "Lobby AP"
    assert _port(s, "dev-sw24", 3)["role"] is None
    assert _port(s, "dev-sw24", 3)["media_label"] == "RJ45 · 1 GbE"
    assert _port(s, "dev-sw24", 26)["media_label"].startswith("SFP+")
    core = _dev(s, "dev-sw24")
    assert core["upgradable"] and core["upgrade_to"] == "7.2.123" and core["cpu"] == "14.2"



def test_flex_mini_only_sets_native_vlan(fake, admin):
    eid = configure_unifi(admin)
    s = _state(admin, eid)
    assert _dev(s, "dev-mini")["caps"]["tagged_vlans"] is False
    assert _dev(s, "dev-sw8")["caps"]["tagged_vlans"] is True
    r = admin.put(f"/api/envs/{eid}/devices/dev-mini/ports/2", json={"native_network_id": "net-cam", "tagged_mode": "block_all"})
    assert r.status_code == 200 and r.get_json()["verified"]
    entry = next(o for o in _fake_dev(fake, "dev-mini")["port_overrides"] if o["port_idx"] == 2)
    assert entry["native_networkconf_id"] == "net-cam" and entry["tagged_vlan_mgmt"] == "auto"   # untouched
    log = admin.get("/api/audit").get_json()["entries"][0]
    assert "not supported" in log["detail"]["after"]["tagged"]



def test_admin_can_override_model_caps(fake, admin):
    eid = configure_unifi(admin)
    assert admin.put("/api/admin/model-caps", json={"model": "USL8LPB", "tagged_vlans": False}).status_code == 200
    s = _state(admin, eid)
    assert _dev(s, "dev-sw8")["caps"] == {"tagged_vlans": False, "tagged_vlans_builtin": True}
    admin.put("/api/admin/model-caps", json={"model": "USMINI", "tagged_vlans": True})
    admin.put("/api/admin/model-caps", json={"model": "USL8LPB", "tagged_vlans": None})
    s = _state(admin, eid)
    assert _dev(s, "dev-sw8")["caps"]["tagged_vlans"] and _dev(s, "dev-mini")["caps"]["tagged_vlans"]



def test_wan_port_cannot_be_changed(fake, admin):
    eid = configure_unifi(admin)
    r = admin.put(f"/api/envs/{eid}/devices/dev-gw/ports/5", json={"native_network_id": "net-cam", "tagged_mode": "block_all",
                                                                    "confirm_protected": True})
    assert r.status_code == 403 and "WAN" in r.get_json()["error"]


def test_network_client_counts_only_for_people_who_see_everything(app, fake, admin):
    from conftest import make_user
    eid = configure_unifi(admin)
    nets = {n["id"]: n for n in _state(admin, eid)["networks"]}
    assert nets["net-cam"]["clients"] == 3 and nets["net-guest"]["clients"] == 1
    uid, viewer = make_user(admin, app, "v18")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid, "all_devices": False, "devices": ["aa:00:00:00:00:08"]}]})
    assert all(n["clients"] is None for n in _state(viewer, eid)["networks"])


def test_display_options_are_saved_per_person(admin):
    r = admin.put("/api/me/prefs", json={"legend": {"ip": "always", "layout": "grid"}, "ports_view": {"phone": "list"}})
    assert r.status_code == 200
    prefs = admin.get("/api/me").get_json()["prefs"]
    assert prefs["legend"]["ip"] == "always" and prefs["ports_view"]["phone"] == "list"
