from conftest import configure_unifi, make_user


def _keys(c, uid=None):
    r = c.get("/api/achievements" + (f"/{uid}" if uid else "")).get_json()
    return {a["key"] for a in r["achievements"] if a["earned_at"]}, r


def test_earned_from_what_people_do(app, fake, admin):
    eid = configure_unifi(admin)
    uid, sup = make_user(admin, app, "sam", "supervisor")
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    me = sup.get("/api/me").get_json()   # evaluating happens with /api/me
    assert "hello" in {a["key"] for a in me["achievements"]["new"]}
    got, r = _keys(sup)
    assert "first_patch" not in got
    # progress shows for counted ones; abilities they lack hide the badge
    patch = next(a for a in r["achievements"] if a["key"] == "patch_panel")
    assert patch["have"] == 0 and patch["goal"] == 10
    assert not any(a["key"] == "explorer" for a in r["achievements"])   # needs envs.manage
    sup.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7", "tagged_mode": "auto"})
    sup.put("/api/me/prefs", json={"theme": "light", "ports_view": {"fx": "faint"}})
    sup.post("/api/feedback", json={"kind": "idea", "title": "PoE budget"})
    new = {a["key"] for a in sup.get("/api/me").get_json()["achievements"]["new"]}
    assert {"first_patch", "trunk", "daylight", "mood", "squeaky_wheel", "ideas"} <= new
    assert sup.get("/api/me").get_json()["achievements"]["new"] == []   # reported once
    # an admin sees them on the person, and in the Users summary
    got, _ = _keys(admin, uid)
    assert "first_patch" in got
    people = admin.get("/api/achievements/people").get_json()
    assert people[str(uid)]["count"] >= 6 and people[str(uid)]["top"]


def test_not_visible_to_people_below(app, admin):
    uid, viewer = make_user(admin, app, "vic")
    me_id = admin.get("/api/me").get_json()["id"]
    assert viewer.get(f"/api/achievements/{me_id}").status_code == 404
    assert viewer.get("/api/achievements/people").status_code == 403


def test_can_be_turned_off(app, admin):
    assert admin.put("/api/settings/achievements", json={"enabled": False}).status_code == 200
    assert admin.get("/api/me").get_json()["achievements"] is None
    assert admin.get("/api/achievements").get_json()["enabled"] is False
    admin.put("/api/settings/achievements", json={"enabled": True})
