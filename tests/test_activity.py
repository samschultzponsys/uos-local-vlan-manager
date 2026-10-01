import db
from conftest import configure_unifi, make_user


def _override(fake, dev, idx):
    stored = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == dev)["port_overrides"]
    return next(o for o in stored if o["port_idx"] == idx)


def test_undo_puts_the_port_back(app, fake, admin):
    eid = configure_unifi(admin)
    sid, sup = make_user(admin, app, "sam", "supervisor")
    admin.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid}]})
    assert sup.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7", "tagged_mode": "block_all"}).status_code == 200
    entry = next(e for e in sup.get("/api/audit").get_json()["entries"] if e["action"] == "port.set")
    assert entry["detail"]["undo"] == {"native_network_id": "net-lan", "tagged_mode": "auto", "excluded_network_ids": []}
    r = sup.post(f"/api/audit/{entry['id']}/undo", json={})
    assert r.status_code == 200, r.get_json()
    o = _override(fake, "dev-sw8", 3)
    assert o["native_networkconf_id"] == "net-lan" and o["tagged_vlan_mgmt"] == "auto"
    log = sup.get("/api/audit").get_json()["entries"]
    assert log[0]["action"] == "port.undo" and log[0]["detail"]["undo_of"] == entry["id"]
    assert next(e for e in log if e["id"] == entry["id"])["undone_by"] == log[0]["id"]
    assert sup.post(f"/api/audit/{entry['id']}/undo", json={}).status_code == 400   # only once


def test_undo_warns_when_the_port_changed_since(app, fake, admin):
    eid = configure_unifi(admin)
    admin.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7", "tagged_mode": "block_all"})
    first = next(e for e in admin.get("/api/audit").get_json()["entries"] if e["action"] == "port.set")
    admin.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-cam", "tagged_mode": "block_all"})
    r = admin.post(f"/api/audit/{first['id']}/undo", json={})
    assert r.status_code == 409 and r.get_json()["confirm"] == "changed"
    assert admin.post(f"/api/audit/{first['id']}/undo", json={"confirm_changed": True}).status_code == 200
    assert _override(fake, "dev-sw8", 3)["native_networkconf_id"] == "net-lan"


def test_viewers_cannot_undo(app, fake, admin):
    eid = configure_unifi(admin)
    admin.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7", "tagged_mode": "block_all"})
    aid = next(e for e in admin.get("/api/audit").get_json()["entries"] if e["action"] == "port.set")["id"]
    uid, viewer = make_user(admin, app, "vic")
    assert viewer.post(f"/api/audit/{aid}/undo", json={}).status_code == 403


def test_filters_and_people(app, fake, admin):
    eid = configure_unifi(admin)
    sid, sup = make_user(admin, app, "sam", "supervisor")
    admin.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid}]})
    sup.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7", "tagged_mode": "block_all"})
    meta = admin.get("/api/audit?meta=1").get_json()
    assert {"admin", "sam"} <= set(meta["people"]) and meta["can_retention"]
    mine = admin.get("/api/audit?user=sam").get_json()["entries"]
    assert mine and all(e["username"] == "sam" for e in mine)
    ports = admin.get("/api/audit?kind=ports").get_json()["entries"]
    assert ports and all(e["action"].startswith("port.") for e in ports)
    assert admin.get("/api/audit?since=4102444800").get_json()["entries"] == []   # the year 2100
    assert admin.get("/api/audit?q=Rack%207").get_json()["entries"]
    asc = admin.get("/api/audit?order=asc&limit=2").get_json()
    assert asc["entries"][0]["id"] < asc["entries"][1]["id"] and asc["has_more"]
    # a supervisor sees only port changes in their environments, and can't set retention
    assert not sup.get("/api/audit?meta=1").get_json()["can_retention"]
    assert sup.put("/api/audit/retention", json={"days": 30}).status_code == 403


def test_retention(app, admin):
    with app.app_context():
        db.get().execute("INSERT INTO audit (ts, username, role, action) VALUES (?, 'old', 'admin', 'settings.app')",
                         (db.now() - 100 * 86400,))
        db.get().commit()
    r = admin.put("/api/audit/retention", json={"days": 90}).get_json()
    assert r["removed"] == 1
    assert admin.get("/api/audit?meta=1").get_json()["retention_days"] == 90
    assert not admin.get("/api/audit?user=old").get_json()["entries"]
    assert admin.put("/api/audit/retention", json={"days": 0}).get_json()["removed"] == 0


def test_retention_shows_the_log_size(app, admin):
    admin.put("/api/settings", json={"poll_seconds": 15})   # something in the log
    meta = admin.get("/api/audit?meta=1").get_json()
    assert isinstance(meta["entries"], list)   # the rows themselves stay as they were
    assert meta["log_count"] >= 1 and meta["log_size"] > 0 and meta["db_size"] >= meta["log_size"]
    r = admin.put("/api/audit/retention", json={"days": 365}).get_json()
    assert r["log_count"] >= 1 and r["log_size"] > 0


def test_storage_overview(app, admin):
    from conftest import make_user
    s = admin.get("/api/admin/storage").get_json()
    keys = {p["key"] for p in s["parts"]}
    assert {"files.feedback", "files.avatars", "files.brand", "files.backups"} <= keys
    assert s["total"] == sum(p["bytes"] for p in s["parts"]) and s["database"] > 0
    assert s["disk"]["total"] >= s["disk"]["free"] > 0
    uid, adm = make_user(admin, app, "ada", "admin")
    assert adm.get("/api/admin/storage").status_code == 403   # super admins only
