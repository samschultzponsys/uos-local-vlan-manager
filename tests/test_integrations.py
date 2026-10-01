import time

import pytest

from conftest import make_user

import integrations
import versioning


class _R:
    def __init__(self, data, status=200):
        self._d, self.status_code, self.text = data, status, str(data)
        self.content = b"x"

    def json(self):
        return self._d

    def raise_for_status(self):
        pass


def _wait(cond, secs=3):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def posts(monkeypatch):
    sent = []
    monkeypatch.setattr(integrations.requests, "post", lambda url, json=None, timeout=None: sent.append((url, json)) or _R({}))
    return sent


class FakeGitHub:
    def __init__(self):
        self.calls, self.issues, self.comments = [], {}, []

    def __call__(self, method, url, headers=None, timeout=None, json=None, params=None):
        path = url.replace(integrations.GH_API, "")
        self.calls.append((method, path, json, headers.get("Authorization")))
        if method == "GET" and path == "/repos/me/app":
            return _R({"full_name": "me/app", "private": True, "has_issues": True, "permissions": {"push": True}})
        if method == "POST" and path == "/repos/me/app/issues":
            n = len(self.issues) + 1
            self.issues[n] = {"number": n, "state": "open", "html_url": f"https://github.com/me/app/issues/{n}"}
            return _R(self.issues[n])
        if method == "POST" and path.endswith("/comments"):
            return _R({"id": 1000 + len(self.calls)})
        if method == "PATCH":
            return _R({})
        if method == "GET" and path == "/repos/me/app/issues":
            return _R(list(self.issues.values()))
        if method == "GET" and path == "/repos/me/app/issues/comments":
            return _R(self.comments)
        return _R({"message": "Not Found"}, 404)


def test_secrets_are_never_sent_back(admin):
    r = admin.put("/api/settings/integrations", json={"github": {"token": "ghp_secret", "update_repo": "me/app"},
                                                       "slack": {"enabled": True, "url": "https://hooks.slack.com/x"}})
    assert r.status_code == 200
    c = admin.get("/api/settings/integrations").get_json()
    assert c["github"]["token"] == "" and c["github"]["has_token"] and c["github"]["update_repo"] == "me/app"
    assert c["slack"]["url"] == "" and c["slack"]["has_url"]
    # saving without the secret keeps it; clear_ removes it
    admin.put("/api/settings/integrations", json={"github": {"token": "", "update_repo": "me/app"}})
    assert integrations.config()["github"]["token"] == "ghp_secret"
    admin.put("/api/settings/integrations", json={"slack": {"clear_url": True}})
    assert integrations.config()["slack"]["url"] == ""
    assert admin.put("/api/settings/integrations", json={"github": {"repo": "not a repo"}}).status_code == 400
    assert "ghp_secret" not in str(admin.get("/api/audit").get_json())


def test_only_admins(admin, app):
    _, viewer = make_user(admin, app, "vic")
    assert viewer.get("/api/settings/integrations").status_code == 403


def test_chat_channels_get_feedback_events(admin, app, posts):
    admin.put("/api/settings/integrations", json={
        "slack": {"enabled": True, "url": "https://slack.test/hook", "events": ["new", "status"]},
        "discord": {"enabled": True, "url": "https://discord.test/hook", "events": ["new"]},
        "teams": {"enabled": True, "url": "https://teams.test/hook", "events": ["status"]},
        "telegram": {"enabled": True, "bot_token": "123:abc", "chat_id": "-100", "events": ["new"]},
        "webhook": {"enabled": False, "url": "https://x.test"}})
    _, viewer = make_user(admin, app, "vera")
    fid = viewer.post("/api/feedback", json={"kind": "bug", "title": "Port <12> broken"}).get_json()["id"]
    assert _wait(lambda: len(posts) >= 3)
    urls = {u for u, _ in posts}
    assert urls == {"https://slack.test/hook", "https://discord.test/hook", "https://api.telegram.org/bot123:abc/sendMessage"}
    tg = next(p for u, p in posts if "telegram" in u)
    assert "Port &lt;12&gt; broken" in tg["text"] and tg["chat_id"] == "-100"
    assert f"/?fb={fid}" in next(p for u, p in posts if "slack" in u)["blocks"][0]["text"]["text"]
    posts.clear()
    admin.put(f"/api/feedback/{fid}", json={"status": "done", "note": "Fixed"})
    assert _wait(lambda: len(posts) >= 2)
    assert {u for u, _ in posts} == {"https://slack.test/hook", "https://teams.test/hook"}
    card = next(p for u, p in posts if "teams" in u)["attachments"][0]["content"]
    assert "Done" in card["body"][0]["text"]


def test_test_button(admin, posts):
    r = admin.post("/api/settings/integrations/test", json={"channel": "discord", "settings": {"url": "https://d.test/h"}})
    assert r.status_code == 200 and posts[-1][0] == "https://d.test/h"
    assert admin.post("/api/settings/integrations/test", json={"channel": "slack", "settings": {}}).status_code == 400


def test_email(admin, app, monkeypatch):
    sent = []

    class SMTP:
        def __init__(self, host, port, timeout=None):
            sent.append(("connect", host, port))

        def starttls(self, context=None):
            sent.append(("starttls",))

        def login(self, u, p):
            sent.append(("login", u, p))

        def send_message(self, msg):
            sent.append(("send", msg["To"], msg["Subject"]))

        def quit(self):
            pass
    monkeypatch.setattr(integrations.smtplib, "SMTP", SMTP)
    admin.put("/api/settings/integrations", json={"email": {
        "enabled": True, "host": "smtp.test", "port": 587, "security": "starttls", "username": "bot@test", "password": "pw",
        "to": "it@test", "people": True, "events": ["new", "status"]}})
    uid, viewer = make_user(admin, app, "vera")
    admin.put(f"/api/users/{uid}", json={"email": "vera@test"})
    fid = viewer.post("/api/feedback", json={"kind": "idea", "title": "PoE budget"}).get_json()["id"]
    assert _wait(lambda: any(s[0] == "send" for s in sent))
    assert ("login", "bot@test", "pw") in sent and ("starttls",) in sent
    assert next(s for s in sent if s[0] == "send")[1] == "it@test"
    sent.clear()
    admin.put(f"/api/feedback/{fid}", json={"status": "planned"})
    assert _wait(lambda: len([s for s in sent if s[0] == "send"]) >= 2)
    assert {s[1] for s in sent if s[0] == "send"} == {"it@test", "vera@test"}   # the team, and the reporter


def test_github_issue_sync_both_ways(admin, app, monkeypatch, posts):
    gh = FakeGitHub()
    monkeypatch.setattr(integrations.requests, "request", gh)
    admin.put("/api/settings/integrations", json={"github": {"token": "tok", "sync": True, "repo": "me/app",
                                                               "kinds": ["bug"], "label": "feedback"}})
    t = admin.post("/api/settings/integrations/test", json={"channel": "github", "settings": {"repo": "me/app"}}).get_json()
    assert t["private"] and t["repo"] == "me/app"
    _, viewer = make_user(admin, app, "vera")
    fid = viewer.post("/api/feedback", json={"kind": "bug", "title": "Wrong VLAN", "body": "details"}).get_json()["id"]
    viewer.post("/api/feedback", json={"kind": "idea", "title": "Not synced"})
    assert _wait(lambda: any(c[0] == "POST" and c[1] == "/repos/me/app/issues" for c in gh.calls))
    post = next(c for c in gh.calls if c[1] == "/repos/me/app/issues")
    assert post[2]["labels"] == ["bug", "feedback"] and "vera" in post[2]["body"] and post[3] == "Bearer tok"
    assert len([c for c in gh.calls if c[1] == "/repos/me/app/issues"]) == 1   # ideas aren't synced here
    assert _wait(lambda: admin.get(f"/api/feedback/{fid}").get_json()["github_url"])
    # a comment here goes there
    viewer.post(f"/api/feedback/{fid}/comments", json={"body": "still broken"})
    assert _wait(lambda: any(c[1] == "/repos/me/app/issues/1/comments" and "still broken" in c[2]["body"] for c in gh.calls))
    # closed there (as not planned) + a new comment there -> here
    gh.issues[1].update(state="closed", state_reason="not_planned", closed_by={"login": "sam"})
    gh.comments = [{"id": 5, "issue_url": "https://api.github.com/repos/me/app/issues/1", "body": "dup of #4", "user": {"login": "sam"}}]
    r = admin.post("/api/settings/integrations/github/sync", json={}).get_json()
    assert r["status"] == 1 and r["comments"] == 1
    d = viewer.get(f"/api/feedback/{fid}").get_json()
    assert d["status"] == "wontfix" and any(c["body"] == "dup of #4" and c["author"]["name"] == "sam (GitHub)" for c in d["comments_list"])
    # the same comment isn't imported twice, and GitHub isn't told about its own change
    assert admin.post("/api/settings/integrations/github/sync", json={}).get_json()["comments"] == 0
    time.sleep(0.3)
    assert not any(c[0] == "PATCH" for c in gh.calls)


def test_update_check_uses_the_token(admin, monkeypatch):
    seen = {}

    def get(url, timeout=None, headers=None):
        seen.update(url=url, auth=headers.get("Authorization"))
        return _R({"tag_name": "v9.9", "html_url": "u", "body": ""})
    monkeypatch.setattr(versioning.requests, "get", get)
    monkeypatch.setattr(versioning, "UPDATE_ALLOWED", True)
    admin.put("/api/settings/integrations", json={"github": {"token": "tok", "update_repo": "me/private"}})
    r = admin.post("/api/version/check", json={}).get_json()
    assert seen == {"url": "https://api.github.com/repos/me/private/releases/latest", "auth": "Bearer tok"}
    assert r["update"]["latest"] == "9.9" and r["update"]["repo"] == "me/private"
