import os
import sys
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app"))
sys.path.insert(0, HERE)

_TMP = tempfile.mkdtemp(prefix="vlanmgr-test-")
os.environ["VLANMGR_DB"] = os.path.join(_TMP, "vlanmgr.db")
os.environ["VLANMGR_UPDATE_CHECK"] = "false"
for k in ("VLANMGR_NO_AUTH", "VLANMGR_FORCE_LOCAL_LOGIN", "VLANMGR_RESET_ADMIN"):
    os.environ.pop(k, None)

import db  # noqa: E402
import fake_unifi  # noqa: E402
import main  # noqa: E402
import unifi  # noqa: E402


class _Resp:
    def __init__(self, r):
        self.status_code = r.status_code
        self._r = r

    def json(self):
        return self._r.get_json()


class FakeSession:
    """Routes the UniFi client's HTTP calls into the fake controller."""
    app = None

    def __init__(self):
        self.verify = False

    def request(self, method, url, headers=None, json=None, timeout=None):
        path = "/" + url.split("://", 1)[1].split("/", 1)[1]
        c = FakeSession.app.test_client()
        return _Resp(c.open(path, method=method, headers=headers or {}, json=json))

    def get(self, url, **kw):
        return self.request("GET", url, **kw)


@pytest.fixture
def fake(monkeypatch):
    FakeSession.app = fake_unifi.create_app()
    monkeypatch.setattr(unifi.requests, "Session", FakeSession)
    monkeypatch.setattr(main.time, "sleep", lambda s: None)
    return FakeSession.app


@pytest.fixture
def app(capsys):
    db.close()
    for f in os.listdir(_TMP):
        if f.startswith("vlanmgr"):
            os.remove(os.path.join(_TMP, f))
    main.startup()
    db.close()
    out = capsys.readouterr().out
    main.app.config["ADMIN_PASSWORD"] = next(
        (line.split(":", 1)[1].strip().rstrip("║").strip() for line in out.splitlines() if "password :" in line), None)
    main.snapshot.invalidate()
    main.app.testing = True
    return main.app


@pytest.fixture
def client(app):
    return app.test_client()


def login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


@pytest.fixture
def admin(app, client):
    r = login(client, "admin", app.config["ADMIN_PASSWORD"])
    assert r.status_code == 200, r.get_json()
    return client


def configure_unifi(client):
    r = client.put("/api/settings", json={"unifi_host": "http://fake:18443", "unifi_api_key": fake_unifi.API_KEY,
                                          "unifi_site": "default"})
    assert r.status_code == 200, r.get_json()
