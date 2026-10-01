from conftest import configure_unifi, make_user


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
    mesh = _dev(s, "dev-mesh")
    assert mesh["ports"] == [] and mesh["model_name"] == "U6 Lite" and mesh["clients"] == 4
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


def test_device_management_is_admin_only_by_default(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "sup7", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    assert sup.post(f"/api/envs/{eid}/devices/dev-sw8/action", json={"action": "locate"}).status_code == 403
    assert sup.post(f"/api/envs/{eid}/devices/dev-sw8/ports/6/power-cycle", json={}).status_code == 403
    assert sup.put(f"/api/envs/{eid}/devices/dev-sw8/ports/6/settings", json={"name": "x"}).status_code == 403
    # one supervisor may power-cycle cameras
    admin.put(f"/api/users/{uid}", json={"caps_grant": ["ports.poe"]})
    assert sup.post(f"/api/envs/{eid}/devices/dev-sw8/ports/6/power-cycle", json={}).status_code == 200
    assert fake.config["STATE"]["cmds"][-1] == {"cmd": "power-cycle", "mac": "aa:00:00:00:00:08", "port_idx": 6}


def test_rename_led_locate_restart_upgrade(fake, admin):
    eid = configure_unifi(admin)
    base = f"/api/envs/{eid}/devices/dev-sw24"
    assert admin.put(base, json={"name": "Core"}).status_code == 200
    assert admin.put(base, json={"led_override": "off"}).status_code == 200
    d = _fake_dev(fake, "dev-sw24")
    assert d["name"] == "Core" and d["led_override"] == "off"
    assert admin.put(base, json={"name": "  "}).status_code == 400
    for action in ("locate", "restart", "upgrade"):
        assert admin.post(base + "/action", json={"action": action}).status_code == 200
    cmds = [c["cmd"] for c in fake.config["STATE"]["cmds"]]
    assert cmds == ["set-locate", "restart", "upgrade"]
    assert _dev(_state(admin, eid, True), "dev-sw24")["locating"]
    # nothing to upgrade on the 8-port switch
    assert admin.post(f"/api/envs/{eid}/devices/dev-sw8/action", json={"action": "upgrade"}).status_code == 400
    actions = [e["action"] for e in admin.get("/api/audit").get_json()["entries"]]
    assert "device.restart" in actions and "device.upgrade" in actions


def test_port_name_and_poe_keep_vlan(fake, admin):
    eid = configure_unifi(admin)
    url = f"/api/envs/{eid}/devices/dev-sw24/ports/12/settings"   # custom tagging, no name yet
    assert admin.put(url, json={"name": "Lab bench", "poe_mode": "off"}).status_code == 200
    s = _state(admin, eid, True)
    p = _port(s, "dev-sw24", 12)
    assert p["name"] == "Lab bench" and not p["poe_enabled"]
    assert p["tagged_mode"] == "custom" and p["excluded_network_ids"] == ["net-guest"]
    # a port with no override yet keeps its VLAN when named
    assert admin.put(f"/api/envs/{eid}/devices/dev-sw24/ports/20/settings", json={"name": "Spare"}).status_code == 200
    p20 = _port(_state(admin, eid, True), "dev-sw24", 20)
    assert p20["name"] == "Spare" and p20["native_network_id"] == "net-lan"
    # clearing the name brings back the default
    admin.put(url, json={"name": ""})
    assert _port(_state(admin, eid, True), "dev-sw24", 12)["name"] == "Port 12"


def test_poe_on_protected_port_needs_confirmation(fake, admin):
    eid = configure_unifi(admin)
    r = admin.post(f"/api/envs/{eid}/devices/dev-sw8/ports/8/power-cycle", json={})
    assert r.status_code == 400   # the uplink has no PoE out
    r = admin.put(f"/api/envs/{eid}/devices/dev-sw24/ports/1/settings", json={"poe_mode": "off"})
    assert r.status_code == 409 and r.get_json()["confirm"] == "protected"
    r = admin.put(f"/api/envs/{eid}/devices/dev-sw24/ports/1/settings", json={"poe_mode": "off", "confirm_protected": True})
    assert r.status_code == 200


def test_diagnostics_download_strips_secrets(fake, admin):
    eid = configure_unifi(admin)
    _fake_dev(fake, "dev-sw8")["x_authkey"] = "s3cret"
    _fake_dev(fake, "dev-sw8")["config_network"] = {"type": "dhcp", "x_password": "hunter2"}
    r = admin.get(f"/api/admin/envs/{eid}/diagnostics")
    assert r.status_code == 200 and "attachment" in r.headers["Content-Disposition"]
    body = r.get_data(as_text=True)
    assert "s3cret" not in body and "hunter2" not in body and "USMINI" in body and "protect_devices" in body


def test_redact_helper():
    import unifi
    assert unifi.redact({"a": 1, "x_ssh_hostkey": "k", "n": [{"wpa_passphrase": "p"}]}) ==         {"a": 1, "x_ssh_hostkey": "•••", "n": [{"wpa_passphrase": "•••"}]}


def test_unifi_refusing_tagging_teaches_the_model(fake, admin):
    eid = configure_unifi(admin)
    admin.put("/api/admin/model-caps", json={"model": "USMINI", "tagged_vlans": True})   # wrong on purpose
    r = admin.put(f"/api/envs/{eid}/devices/dev-mini/ports/3", json={"native_network_id": "net-cam", "tagged_mode": "block_all"})
    body = r.get_json()
    assert r.status_code == 200 and body["native_only"] and "remembers" in body["warning"]
    entry = next(o for o in _fake_dev(fake, "dev-mini")["port_overrides"] if o["port_idx"] == 3)
    assert entry["native_networkconf_id"] == "net-cam" and "tagged_vlan_mgmt" not in entry
    assert _dev(_state(admin, eid), "dev-mini")["caps"]["tagged_vlans"] is False

