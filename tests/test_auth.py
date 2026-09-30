from conftest import login

import auth
import db


def test_first_admin_seeded_and_password_banner(app, client):
    assert app.config["ADMIN_PASSWORD"]
    r = login(client, "admin", app.config["ADMIN_PASSWORD"])
    assert r.status_code == 200
    me = client.get("/api/me").get_json()
    assert me["role"] == "admin" and me["initial_password"] is True


def test_unauthenticated_is_redirected_to_login(client):
    r = client.get("/")
    assert r.status_code == 302 and r.headers["Location"].startswith("/login")
    assert client.get("/api/state").status_code == 401
    assert client.get("/login").status_code == 200
    assert client.get("/healthz").status_code == 200


def test_wrong_password_rejected(client):
    assert login(client, "admin", "nope-nope").status_code == 401
    assert login(client, "ghost", "whatever1").status_code == 401


def test_new_users_default_to_viewer(admin):
    r = admin.post("/api/users", json={"username": "alice", "password": "alicepass1"})
    assert r.status_code == 200
    assert r.get_json()["user"]["role"] == "viewer"


def test_role_gates(app, admin):
    admin.post("/api/users", json={"username": "vic", "password": "vicpass123"})
    c = app.test_client()
    login(c, "vic", "vicpass123")
    assert c.get("/api/state").status_code == 200
    assert c.get("/api/audit").status_code == 403
    assert c.get("/api/users").status_code == 403
    assert c.put("/api/devices/x/ports/1", json={}).status_code == 403


def test_last_admin_cannot_be_demoted(admin):
    me = admin.get("/api/me").get_json()
    r = admin.put(f"/api/users/{me['id']}", json={"role": "viewer"})
    assert r.status_code == 400


def test_session_cookie_lasts_30_days(app, client):
    r = login(client, "admin", app.config["ADMIN_PASSWORD"])
    cookie = r.headers["Set-Cookie"]
    assert "vlanmgr_session=" in cookie and "Max-Age=2592000" in cookie and "HttpOnly" in cookie


def test_logout_kills_session(admin):
    assert admin.post("/api/auth/logout", json={}).status_code == 200
    assert admin.get("/api/me").status_code == 401


def test_api_token_role_is_capped(app, admin):
    r = admin.post("/api/me/tokens", json={"name": "script", "role": "viewer"})
    token = r.get_json()["token"]
    c = app.test_client()
    h = {"Authorization": f"Bearer {token}"}
    assert c.get("/api/me", headers=h).get_json()["role"] == "viewer"
    assert c.get("/api/users", headers=h).status_code == 403
    assert c.get("/api/me", headers={"Authorization": "Bearer vm_bad"}).status_code == 401


def test_token_link_creates_browser_session(app, admin):
    token = admin.post("/api/me/tokens", json={"name": "tablet"}).get_json()["token"]
    c = app.test_client()
    r = c.get(f"/?token={token}")
    assert r.status_code == 302 and "token=" not in r.headers["Location"]
    assert c.get("/api/me").get_json()["method"] == "token"


def test_no_auth_requires_confirmation_and_shows_anonymous(app, admin):
    r = admin.put("/api/settings/auth", json={"no_auth": True, "anonymous_role": "viewer"})
    assert r.status_code == 409 and r.get_json()["confirm_no_auth"]
    r = admin.put("/api/settings/auth", json={"no_auth": True, "anonymous_role": "viewer",
                                              "confirm_no_auth": "I UNDERSTAND"})
    assert r.status_code == 200
    anon = app.test_client()
    me = anon.get("/api/me").get_json()
    assert me["username"] == "anonymous" and me["role"] == "viewer" and me["no_auth"]


def test_cannot_turn_off_every_sign_in_method(admin):
    r = admin.put("/api/settings/auth", json={"local_enabled": False})
    assert r.status_code == 400


def test_oidc_needs_config_before_enabling(admin):
    r = admin.put("/api/settings/auth", json={"oidc_enabled": True})
    assert r.status_code == 400


def test_oidc_auto_login_redirects_but_login_page_is_failover(app, admin):
    r = admin.put("/api/settings/auth", json={
        "oidc_enabled": True, "oidc_auto_login": True,
        "oidc": {"issuer": "https://auth.example.com/application/o/vlan/", "client_id": "abc"},
        "oidc_button": {"text": "Sign in with Authentik", "bg": "#fd4b2d", "icon": "authentik"}})
    assert r.status_code == 200, r.get_json()
    c = app.test_client()
    r = c.get("/")
    assert r.headers["Location"].startswith("/auth/oidc/login")
    assert c.get("/login").status_code == 200
    cfg = c.get("/api/auth/config").get_json()
    assert cfg["oidc"] and cfg["button"]["text"] == "Sign in with Authentik"


def test_oidc_user_is_created_as_viewer(app):
    with app.test_request_context("/"):
        cfg = auth.stored_config()
        cfg["oidc"].update(issuer="https://idp", client_id="x")
        db.set_json("auth", cfg)
        row, err = auth._oidc_user({"sub": "abc", "preferred_username": "bob", "email": "bob@x.io"})
        assert err is None and row["role"] == "viewer" and row["username"] == "bob"
        # same sub signs into the same user
        row2, _ = auth._oidc_user({"sub": "abc", "preferred_username": "bob"})
        assert row2["id"] == row["id"]
        # group mapping, when configured, sets the role
        cfg["oidc"].update(admin_groups="vlan-admins")
        db.set_json("auth", cfg)
        row3, _ = auth._oidc_user({"sub": "abc", "groups": ["vlan-admins"]})
        assert row3["role"] == "admin"
        db.close()


def test_oidc_cannot_claim_seeded_admin(app):
    with app.test_request_context("/"):
        cfg = auth.stored_config()
        cfg["oidc"].update(issuer="https://idp", client_id="x")
        db.set_json("auth", cfg)
        row, _ = auth._oidc_user({"sub": "evil", "preferred_username": "admin"})
        assert row["username"] != "admin" and row["role"] == "viewer"
        db.close()


def test_mutations_must_be_json(admin):
    r = admin.post("/api/users", data="username=x", content_type="application/x-www-form-urlencoded")
    assert r.status_code == 415


def test_viewer_can_choose_own_token_for_link(app, admin):
    admin.post("/api/users", json={"username": "val", "password": "valpass123"})
    c = app.test_client()
    login(c, "val", "valpass123")
    r = c.post("/api/me/tokens", json={"name": "phone", "value": "my-own-phone-token-1"})
    assert r.status_code == 200 and r.get_json()["token"] == "my-own-phone-token-1"
    assert r.get_json()["link"].endswith("/?token=my-own-phone-token-1")
    # too short, and duplicates, are refused
    assert c.post("/api/me/tokens", json={"name": "x", "value": "short"}).status_code == 400
    assert admin.post("/api/me/tokens", json={"name": "y", "value": "my-own-phone-token-1"}).status_code == 400
    phone = app.test_client()
    assert phone.get("/login?token=my-own-phone-token-1").status_code == 302
    assert phone.get("/api/me").get_json()["username"] == "val"


def test_token_link_session_keeps_token_role_and_dies_on_revoke(app, admin):
    r = admin.post("/api/me/tokens", json={"name": "kiosk", "role": "viewer"}).get_json()
    tid = admin.get("/api/me/tokens").get_json()["tokens"][0]["id"]
    kiosk = app.test_client()
    kiosk.get(f"/?token={r['token']}")
    assert kiosk.get("/api/me").get_json()["role"] == "viewer"
    assert kiosk.get("/api/users").status_code == 403
    admin.delete(f"/api/me/tokens/{tid}", json={})
    assert kiosk.get("/api/me").status_code == 401
