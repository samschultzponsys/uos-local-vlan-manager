import base64

from conftest import make_user

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 64).decode()


def test_everyone_can_report_vote_and_comment(admin, app):
    vid, viewer = make_user(admin, app, "vera")
    r = viewer.post("/api/feedback", json={"kind": "bug", "title": "Port 12 wrong VLAN", "body": "details",
                                          "image": PNG, "context": {"version": "3.1", "browser": "Chrome", "secret": "x"}})
    assert r.status_code == 200, r.get_json()
    fid = r.get_json()["id"]
    items = admin.get("/api/feedback").get_json()["items"]
    it = next(i for i in items if i["id"] == fid)
    assert it["votes"] == 1 and it["status"] == "open" and it["author"]["name"] == "vera" and it["image"]
    # the reporter's context is for them and whoever manages feedback
    detail = admin.get(f"/api/feedback/{fid}").get_json()
    assert detail["context"] == {"version": "3.1", "browser": "Chrome"}
    _, other = make_user(admin, app, "otto")
    assert other.get(f"/api/feedback/{fid}").get_json()["context"] is None
    assert other.get(it["image"]).status_code == 200
    assert other.post(f"/api/feedback/{fid}/vote", json={"on": True}).get_json()["votes"] == 2
    assert other.post(f"/api/feedback/{fid}/comments", json={"body": "me too"}).status_code == 200
    # only managers change the status
    assert viewer.put(f"/api/feedback/{fid}", json={"status": "done"}).status_code == 403
    assert admin.put(f"/api/feedback/{fid}", json={"status": "done", "note": "fixed"}).status_code == 200
    # followers (reporter, voters, commenters) get news; the one who acted doesn't
    assert viewer.get("/api/me").get_json()["feedback_unseen"] == 1
    assert other.get("/api/me").get_json()["feedback_unseen"] == 1
    assert admin.get("/api/me").get_json()["feedback_unseen"] == 0
    d = viewer.get(f"/api/feedback/{fid}").get_json()   # opening it clears the news
    assert d["status"] == "done" and [c["event"] for c in d["comments_list"]] == ["", "status:done"]
    assert viewer.get("/api/me").get_json()["feedback_unseen"] == 0
    # closed: the reporter can't edit or delete it any more
    assert viewer.put(f"/api/feedback/{fid}", json={"title": "x"}).status_code == 403
    assert viewer.delete(f"/api/feedback/{fid}", json={}).status_code == 403
    assert admin.delete(f"/api/feedback/{fid}", json={}).status_code == 200


def test_reporter_edits_while_open_and_validation(admin, app):
    _, viewer = make_user(admin, app, "vic")
    assert viewer.post("/api/feedback", json={"title": "  "}).status_code == 400
    bad = "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode()
    assert viewer.post("/api/feedback", json={"title": "x", "image": bad}).status_code == 400
    fid = viewer.post("/api/feedback", json={"kind": "idea", "title": "PoE budget"}).get_json()["id"]
    assert viewer.put(f"/api/feedback/{fid}", json={"title": "PoE budget per switch", "body": "watts"}).status_code == 200
    _, other = make_user(admin, app, "olga")
    assert other.put(f"/api/feedback/{fid}", json={"title": "mine now"}).status_code == 403
    assert other.delete(f"/api/feedback/{fid}", json={}).status_code == 403
    assert viewer.delete(f"/api/feedback/{fid}", json={}).status_code == 200


def test_board_can_be_taken_away_per_person(admin, app):
    uid, viewer = make_user(admin, app, "nora")
    assert viewer.get("/api/feedback").status_code == 200
    admin.put(f"/api/users/{uid}", json={"caps_deny": ["feedback.view", "feedback.submit"]})
    assert viewer.get("/api/feedback").status_code == 403
    assert viewer.post("/api/feedback", json={"title": "x"}).status_code == 403
    assert "feedback.view" not in viewer.get("/api/me").get_json()["caps"]
