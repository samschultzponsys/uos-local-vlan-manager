from conftest import configure_unifi, make_user


def _set(c, eid, dev, idx, **body):
    return c.put(f"/api/envs/{eid}/devices/{dev}/ports/{idx}", json=body)


def test_grant_and_deny_single_abilities(app, fake, admin):
    eid = configure_unifi(admin)
    vid, viewer = make_user(admin, app, "v1")
    sid, sup = make_user(admin, app, "s1", "supervisor")
    for uid in (vid, sid):
        admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    body = {"native_network_id": "net-cam", "tagged_mode": "block_all"}
    assert _set(viewer, eid, "dev-sw8", 3, **body).status_code == 403
    # a viewer who may change ports anyway
    admin.put(f"/api/users/{vid}", json={"caps_grant": ["ports.change"]})
    assert "ports.change" in viewer.get("/api/me").get_json()["caps"]
    assert _set(viewer, eid, "dev-sw8", 3, **body).status_code == 200
    # a supervisor who may not
    admin.put(f"/api/users/{sid}", json={"caps_deny": ["ports.change", "activity.view"]})
    assert _set(sup, eid, "dev-sw8", 4, **body).status_code == 403
    assert sup.get("/api/audit").status_code == 403
    # admin-only abilities can't be handed out
    admin.put(f"/api/users/{vid}", json={"caps_grant": ["envs.manage", "settings.manage"]})
    assert viewer.get("/api/admin/envs").status_code == 403


def test_editing_a_role_changes_everyone_in_it(app, fake, admin):
    eid = configure_unifi(admin)
    sid, sup = make_user(admin, app, "s2", "supervisor")
    admin.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid}]})
    assert sup.get("/api/audit").status_code == 200
    r = admin.put("/api/roles/supervisor", json={"name": "Technician", "caps": ["ports.change"]})
    assert r.status_code == 200 and r.get_json()["role"]["name"] == "Technician"
    assert sup.get("/api/audit").status_code == 403
    assert sup.get("/api/me").get_json()["role_name"] == "Technician"
    assert admin.put("/api/roles/admin", json={"caps": []}).status_code == 400
    assert sup.put("/api/roles/supervisor", json={"caps": ["users.view"]}).status_code == 403


def test_custom_role_manages_only_people_below(app, fake, admin):
    eid = configure_unifi(admin)
    r = admin.post("/api/roles", json={"name": "Lead tech", "level": 70, "caps": [
        "ports.change", "users.view", "users.create", "users.edit", "users.roles", "users.access", "users.view_as"]})
    assert r.status_code == 200
    key = r.get_json()["role"]["key"]
    lid, lead = make_user(admin, app, "lead", key)
    admin.put(f"/api/users/{lid}/access", json={"envs": [{"env_id": eid, "all_vlans": False,
                                                          "vlans": ["net-cam", "net-rack7"]}]})
    sid, _ = make_user(admin, app, "tech", "supervisor")
    people = {u["username"] for u in lead.get("/api/users").get_json()["users"]}
    assert "tech" in people and "admin" not in people
    # can't touch admins, can't promote to their own level or above
    assert lead.put("/api/users/1", json={"display_name": "x"}).status_code == 404
    assert lead.put(f"/api/users/{sid}", json={"role": key}).status_code == 403
    assert lead.put(f"/api/users/{sid}", json={"role": "viewer"}).status_code == 200
    # only abilities they have themselves
    assert lead.put(f"/api/users/{sid}", json={"caps_grant": ["ports.lock"]}).status_code == 403
    assert lead.put(f"/api/users/{sid}", json={"caps_grant": ["ports.change"]}).status_code == 200
    # new people get the lowest role
    new = lead.post("/api/users", json={"username": "newbie", "password": "newbiepass1", "role": key}).get_json()
    assert new["user"]["role"] == "viewer"
    # access only from their own
    assert lead.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid, "all_vlans": False,
                                                                 "vlans": ["net-iot"]}]}).status_code == 403
    assert lead.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid}]}).status_code == 200
    got = admin.get(f"/api/users/{sid}/access").get_json()["envs"][0]
    assert got["all_vlans"] is False and set(got["vlans"]) == {"net-cam", "net-rack7"}
    cat = lead.get(f"/api/admin/envs/{eid}/catalog").get_json()
    assert {n["id"] for n in cat["networks"]} == {"net-cam", "net-rack7"}
    # view as someone below
    assert lead.post(f"/api/users/{sid}/impersonate", json={}).status_code == 200
    assert lead.get("/api/me").get_json()["username"] == "tech"
    lead.post("/api/impersonate/stop", json={})
    # settings, environments and roles stay admin-only
    assert lead.get("/api/settings").status_code == 403
    assert lead.post("/api/roles", json={"name": "x"}).status_code == 403


def test_deleting_a_custom_role_moves_its_people(app, admin):
    key = admin.post("/api/roles", json={"name": "Temp", "level": 20}).get_json()["role"]["key"]
    uid, c = make_user(admin, app, "tmp", key)
    assert admin.delete("/api/roles/supervisor", json={}).status_code == 400
    assert admin.delete(f"/api/roles/{key}", json={"move_to": "viewer"}).status_code == 200
    assert c.get("/api/me").get_json()["role"] == "viewer"
