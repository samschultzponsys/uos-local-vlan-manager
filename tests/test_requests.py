from conftest import configure_unifi, make_user


def _viewer(admin, app, eid, name="vera", grant=("requests.ports",)):
    uid, c = make_user(admin, app, name)
    admin.put(f"/api/users/{uid}/access", json={"envs": [{"env_id": eid}]})
    admin.put(f"/api/users/{uid}", json={"caps_grant": list(grant)})
    return uid, c


def _ask(c, eid, **body):
    return c.post(f"/api/envs/{eid}/requests", json=body)


def test_viewer_requests_a_port_change_and_a_supervisor_approves(app, fake, admin):
    eid = configure_unifi(admin)
    _, vera = _viewer(admin, app, eid)
    sid, sup = make_user(admin, app, "sam", "supervisor")
    admin.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid}]})
    _, other = make_user(admin, app, "otto")   # no access to the environment
    # a viewer can't change the port, but can ask
    assert vera.put(f"/api/envs/{eid}/devices/dev-sw8/ports/3", json={"native_network_id": "net-rack7"}).status_code == 403
    r = _ask(vera, eid, type="port", device_id="dev-sw8", port_idx=3, reason="New printer",
             change={"native_network_id": "net-rack7", "tagged_mode": "block_all"})
    assert r.status_code == 200, r.get_json()
    rid = r.get_json()["id"]
    assert _ask(vera, eid, type="port", device_id="dev-sw8", port_idx=3,
                change={"native_network_id": "net-cam", "tagged_mode": "block_all"}).status_code == 409   # one per port
    # who sees it: the requester and those who could make the change - not everyone on the board
    assert [i["id"] for i in other.get("/api/feedback").get_json()["items"]] == []
    it = next(i for i in sup.get("/api/feedback").get_json()["items"] if i["id"] == rid)
    assert it["kind"] == "request" and it["can_approve"] and "Port 3" in it["title"]
    assert sup.get("/api/me").get_json()["requests_waiting"] == 1
    assert vera.post(f"/api/feedback/{rid}/approve", json={}).status_code == 403   # not your own
    assert vera.post(f"/api/feedback/{rid}/vote", json={"on": True}).status_code == 400
    r = sup.post(f"/api/feedback/{rid}/approve", json={"note": "done"})
    assert r.status_code == 200, r.get_json()
    stored = next(d for d in fake.config["STATE"]["devices"] if d["_id"] == "dev-sw8")["port_overrides"]
    assert next(o for o in stored if o["port_idx"] == 3)["native_networkconf_id"] == "net-rack7"
    d = vera.get(f"/api/feedback/{rid}").get_json()
    assert d["status"] == "done" and d["comments_list"][-1]["event"] == "status:done"
    log = admin.get("/api/audit").get_json()["entries"]
    port_set = next(e for e in log if e["action"] == "port.set")
    assert port_set["username"] == "sam" and port_set["detail"]["via"] == f"request #{rid} from vera"
    assert sup.post(f"/api/feedback/{rid}/approve", json={}).status_code == 400   # already handled


def test_requests_need_the_ability_and_respect_access(app, fake, admin):
    eid = configure_unifi(admin)
    _, plain = _viewer(admin, app, eid, "pat", grant=())
    assert _ask(plain, eid, type="port", device_id="dev-sw8", port_idx=3,
                change={"native_network_id": "net-rack7"}).status_code == 403
    _, vera = _viewer(admin, app, eid, grant=("requests.ports", "requests.poe", "requests.restart"))
    assert _ask(vera, eid, type="port", device_id="dev-sw8", port_idx=3,
                change={"native_network_id": "net-lan", "tagged_mode": "auto"}).status_code == 400   # already so
    assert _ask(vera, eid, type="poe", device_id="dev-sw8", port_idx=4).status_code == 400   # PoE off there
    rid = _ask(vera, eid, type="poe", device_id="dev-sw8", port_idx=6, reason="camera stuck").get_json()["id"]
    rid2 = _ask(vera, eid, type="restart", device_id="dev-sw24").get_json()["id"]
    # a supervisor can change ports but not power-cycle: they don't see the PoE request
    sid, sup = make_user(admin, app, "sam", "supervisor")
    admin.put(f"/api/users/{sid}/access", json={"envs": [{"env_id": eid}]})
    assert {i["id"] for i in sup.get("/api/feedback").get_json()["items"]} == set()
    assert sup.post(f"/api/feedback/{rid}/decline", json={}).status_code == 404
    # the admin approves the power-cycle (protected port confirmation passes through) and declines the restart
    r = admin.post(f"/api/feedback/{rid}/approve", json={})
    assert r.status_code == 200, r.get_json()
    assert fake.config["STATE"]["cmds"][-1] == {"cmd": "power-cycle", "mac": "aa:00:00:00:00:08", "port_idx": 6}
    assert admin.post(f"/api/feedback/{rid2}/decline", json={"note": "Not during business hours"}).status_code == 200
    d = vera.get(f"/api/feedback/{rid2}").get_json()
    assert d["status"] == "wontfix" and d["comments_list"][-1]["body"] == "Not during business hours"
    assert vera.get("/api/me").get_json()["feedback_unseen"] == 1
