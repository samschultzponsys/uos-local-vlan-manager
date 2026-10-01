from conftest import login

import auth
import db


def test_first_admin_seeded_and_password_banner(app, client):
    assert app.config["ADMIN_PASSWORD"]
    r = login(client, "admin", app.config["ADMIN_PASSWORD"])
    assert r.status_code == 200
    me = client.get("/api/me").get_json()
    assert me["role"] == "superadmin" and me["initial_password"] is True


def test_unauthenticated_is_redirected_to_login(client):
    r = client.get("/")
    assert r.status_code == 302 and r.headers["Location"].startswith("/login")
    assert client.get("/api/envs").status_code == 401
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
    admin.post("/api/users", json={"username": "vic", "password": "vicpass123", "must_change": False})
    c = app.test_client()
    login(c, "vic", "vicpass123")
    assert c.get("/api/envs").status_code == 200
    assert c.get("/api/audit").status_code == 403
    assert c.get("/api/users").status_code == 403
    assert c.put("/api/envs/1/devices/x/ports/1", json={}).status_code == 403


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
        # SSO only signs in: groups never change the role an admin set here
        db.get().execute("UPDATE users SET role='supervisor' WHERE id=?", (row["id"],))
        db.get().commit()
        row3, _ = auth._oidc_user({"sub": "abc", "groups": ["vlan-admins", "authentik Admins"]})
        assert row3["role"] == "supervisor"
        # allowed groups still gate who may sign in at all
        cfg["oidc"].update(allowed_groups="vlan-users")
        db.set_json("auth", cfg)
        _, err = auth._oidc_user({"sub": "abc", "groups": ["other"]})
        assert err
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
    admin.post("/api/users", json={"username": "val", "password": "valpass123", "must_change": False})
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


def test_admin_can_rename_seeded_admin(app, admin):
    me = admin.get("/api/me").get_json()
    r = admin.put(f"/api/users/{me['id']}", json={"username": "sam", "display_name": "Sam"})
    assert r.status_code == 200 and r.get_json()["user"]["username"] == "sam"
    assert admin.get("/api/me").get_json()["username"] == "sam"   # still signed in
    c = app.test_client()
    assert login(c, "sam", app.config["ADMIN_PASSWORD"]).status_code == 200
    assert login(app.test_client(), "admin", app.config["ADMIN_PASSWORD"]).status_code == 401
    # own profile: admins may rename themselves too
    assert admin.put("/api/me/profile", json={"username": "sam2"}).status_code == 200


def test_users_edit_display_name_but_not_username(app, admin):
    admin.post("/api/users", json={"username": "tina", "password": "tinapass12", "must_change": False})
    c = app.test_client()
    login(c, "tina", "tinapass12")
    assert c.put("/api/me/profile", json={"display_name": "Tina T"}).status_code == 200
    assert c.get("/api/me").get_json()["display_name"] == "Tina T"
    assert c.put("/api/me/profile", json={"username": "boss"}).status_code == 403
    assert admin.put("/api/users/1", json={"username": "tina"}).status_code == 400   # taken


def test_single_console_from_1_0_becomes_an_environment(app):
    import main
    d = db.connect()
    d.execute("DELETE FROM environments")
    for k, v in (("unifi_host", "https://10.0.0.1"), ("unifi_api_key", "k"), ("unifi_site", "default"),
                 ("vlan_colors", '{"net-a": "#ff0000"}')):
        d.execute("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    d.commit()
    d.close()
    main.startup()
    d = db.connect()
    env = d.execute("SELECT * FROM environments").fetchone()
    assert env["name"] == "Default" and env["host"] == "https://10.0.0.1" and env["api_key"] == "k"
    assert env["vlan_colors"] == '{"net-a": "#ff0000"}'
    assert d.execute("SELECT COUNT(*) FROM settings WHERE key LIKE 'unifi_%'").fetchone()[0] == 0
    d.close()
    db.close()


def test_pages_use_versioned_assets(app, client):
    import main
    page = client.get("/login").get_data(as_text=True)
    assert f"/static/{main.BUILD}/login.js" in page and f'content="{main.BUILD}"' in page
    r = client.get(f"/static/{main.BUILD}/ui.js")
    assert r.status_code == 200 and "immutable" in r.headers["Cache-Control"]
    assert client.get("/api/version").get_json()["build"] == main.BUILD


PNG = "data:image/png;base64," + __import__("base64").b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


def test_profile_picture_upload_and_admin_lock(app, admin):
    admin.post("/api/users", json={"username": "pic", "password": "picpass123", "must_change": False})
    c = app.test_client()
    login(c, "pic", "picpass123")
    r = c.put("/api/me/avatar", json={"image": PNG})
    assert r.status_code == 200 and r.get_json()["avatar"].startswith("/avatar/")
    img = c.get(r.get_json()["avatar"])
    assert img.status_code == 200 and img.mimetype == "image/png"
    # not an image / svg are refused
    assert c.put("/api/me/avatar", json={"image": "data:image/svg+xml;base64,PHN2Zz4="}).status_code == 400
    # an admin sets and locks it
    uid = c.get("/api/me").get_json()["id"]
    r = admin.put(f"/api/users/{uid}/avatar", json={"image": PNG, "locked": True})
    assert r.get_json()["user"]["avatar_locked"]
    assert c.put("/api/me/avatar", json={"image": PNG}).status_code == 403
    assert c.delete("/api/me/avatar", json={}).status_code == 403
    assert c.get("/api/me").get_json()["avatar_locked"]
    admin.put(f"/api/users/{uid}/avatar", json={"locked": False})
    assert c.delete("/api/me/avatar", json={}).status_code == 200
    assert c.get("/api/me").get_json()["avatar"] is None


def test_admin_can_view_as_lower_user(app, admin):
    uid = admin.post("/api/users", json={"username": "vic2", "password": "vicpass123"}).get_json()["user"]["id"]
    assert admin.post(f"/api/users/{uid}/impersonate", json={}).status_code == 200
    me = admin.get("/api/me").get_json()
    assert me["username"] == "vic2" and me["role"] == "viewer" and me["impersonator"]["username"] == "admin"
    assert admin.get("/api/users").status_code == 403                     # sees what they see
    assert admin.put("/api/me/password", json={"password": "hijack1234"}).status_code == 403
    assert admin.post("/api/impersonate/stop", json={}).status_code == 200
    assert admin.get("/api/me").get_json()["role"] == "superadmin"
    actions = [e["action"] for e in admin.get("/api/audit").get_json()["entries"]]
    assert "user.impersonate" in actions and "user.impersonate_stop" in actions
    # never another admin
    other = admin.post("/api/users", json={"username": "adm2", "password": "adm2pass12", "role": "admin"}).get_json()["user"]["id"]
    assert admin.post(f"/api/users/{other}/impersonate", json={}).status_code == 400


def test_oidc_credential_check(monkeypatch):
    class R:
        def __init__(self, err, code=400):
            self.status_code, self._err = code, err
            self.headers = {"content-type": "application/json"}

        def json(self):
            return {"error": self._err}

    calls = []

    def fake_post(url, timeout=None, data=None, auth=None):
        calls.append((auth, dict(data)))
        ok = (auth == ("cid", "right")) or (data.get("client_secret") == "right")
        return R("invalid_grant" if ok else "invalid_client", 400 if ok else 401)

    monkeypatch.setattr(auth.requests, "post", fake_post)
    good = auth.check_client("https://idp/token", "cid", "right")
    assert good["ok"] and good["suggest"] == "client_secret_basic"
    bad = auth.check_client("https://idp/token", "cid", "wrong")
    assert not bad["ok"] and "rejected" in bad["message"]


def test_cloud_console_id_from_pasted_url(monkeypatch):
    import unifi
    monkeypatch.setattr(unifi.UniFi, "cloud_consoles", lambda self: [
        {"id": "70A741:111", "hardware_id": "3be578f1-fc61-4478-926e-441311aaaf64", "name": "UOS-Nick"}])
    c = unifi.UniFi(mode="cloud", api_key="k")
    url = "https://unifi.ui.com/consoles/3be578f1-fc61-4478-926e-441311aaaf64/network/default/integrations"
    assert c.resolve_console_id(url) == "70A741:111"
    assert c.resolve_console_id("70A741:111") == "70A741:111"


def test_new_sso_user_waits_until_an_admin_sets_them_up(app, admin):
    with app.test_request_context("/"):
        cfg = auth.stored_config()
        cfg["oidc"].update(issuer="https://idp", client_id="x")
        db.set_json("auth", cfg)
        row, err = auth._oidc_user({"sub": "new1", "preferred_username": "newbie", "email": "n@x.io"})
        assert err is None and row["pending"] == 1
        db.close()
    users = admin.get("/api/users").get_json()["users"]
    u = next(x for x in users if x["username"] == "newbie")
    assert u["pending"] and admin.get("/api/me").get_json()["waiting"] == 1
    # giving access ends the wait
    admin.put(f"/api/users/{u['id']}/access", json={"envs": []})
    u = next(x for x in admin.get("/api/users").get_json()["users"] if x["username"] == "newbie")
    assert not u["pending"] and admin.get("/api/me").get_json()["waiting"] == 0


def test_precreated_user_is_matched_by_verified_email_only(app, admin):
    admin.post("/api/users", json={"username": "jane", "email": "jane@corp.io", "role": "supervisor"})
    with app.test_request_context("/"):
        cfg = auth.stored_config()
        cfg["oidc"].update(issuer="https://idp", client_id="x")
        db.set_json("auth", cfg)
        # an unverified email can't claim the account an admin made
        row, _ = auth._oidc_user({"sub": "s-unv", "preferred_username": "jd", "email": "jane@corp.io", "email_verified": False})
        assert row["username"] != "jane" and row["pending"] == 1
        row, _ = auth._oidc_user({"sub": "s-ok", "preferred_username": "jd2", "email": "Jane@Corp.io", "email_verified": True})
        assert row["username"] == "jane" and row["role"] == "supervisor" and not row["pending"]
        db.close()


def test_add_sso_person_with_just_name_email_and_role(app, admin):
    r = admin.post("/api/users", json={"sso": True, "display_name": "Pat Doe", "email": "pat.doe@corp.io", "role": "supervisor"})
    u = r.get_json()["user"]
    assert r.status_code == 200 and u["username"] == "pat.doe" and not u["has_password"] and u["role"] == "supervisor"
    assert admin.post("/api/users", json={"sso": True, "display_name": "Pat 2", "email": "PAT.DOE@corp.io"}).status_code == 400
    assert admin.post("/api/users", json={"sso": True, "display_name": "No mail"}).status_code == 400
    with app.test_request_context("/"):
        cfg = auth.stored_config()
        cfg["oidc"].update(issuer="https://idp", client_id="x")
        db.set_json("auth", cfg)
        row, _ = auth._oidc_user({"sub": "pat-sub", "preferred_username": "pdoe", "email": "pat.doe@corp.io"})
        assert row["id"] == u["id"] and not row["pending"]
        db.close()


def test_admin_set_password_must_be_changed_first(app, admin):
    uid = admin.post("/api/users", json={"username": "newb", "password": "temppass123"}).get_json()["user"]["id"]
    c = app.test_client()
    assert login(c, "newb", "temppass123").status_code == 200
    me = c.get("/api/me").get_json()
    assert me["must_change_password"]
    # nothing else works until they choose their own
    r = c.get("/api/envs")
    assert r.status_code == 403 and r.get_json()["password_change_required"]
    assert c.get("/api/feedback").status_code == 403
    assert c.put("/api/me/prefs", json={"theme": "light"}).status_code == 403
    assert c.put("/api/me/password", json={"password": "temppass123"}).status_code == 400   # not the same one
    assert c.put("/api/me/password", json={"password": "mine-now-123"}).status_code == 200
    assert not c.get("/api/me").get_json()["must_change_password"]
    assert c.get("/api/envs").status_code == 200
    # an admin resetting it again: their sessions end and the rule is back
    admin.put(f"/api/users/{uid}", json={"password": "another-temp1"})
    assert c.get("/api/envs").status_code == 401
    c2 = app.test_client()
    login(c2, "newb", "another-temp1")
    assert c2.get("/api/envs").status_code == 403
    # ...unless the admin says it needn't be changed
    admin.put(f"/api/users/{uid}", json={"password": "keep-this-12", "must_change": False})
    c3 = app.test_client()
    login(c3, "newb", "keep-this-12")
    assert c3.get("/api/envs").status_code == 200


def test_sso_user_with_a_password_links_by_verified_email(app, admin):
    import auth
    r = admin.post("/api/users", json={"sso": True, "email": "ann@corp.test", "display_name": "Ann", "password": "temppass123"})
    row = r.get_json()["user"]
    assert row["username"] == "ann" and row["sso_allowed"] and row["has_password"] and row["must_change_password"]
    with app.test_request_context():
        # an unverified email never links an account
        u, err = auth._oidc_user({"sub": "x1", "email": "ann@corp.test", "email_verified": False, "preferred_username": "ann"})
        assert u is None or u["id"] != row["id"]
        u, err = auth._oidc_user({"sub": "x2", "email": "ann@corp.test", "email_verified": True})
        assert err is None and u["id"] == row["id"] and u["oidc_sub"] == "x2"
    # password sign-in still works
    c = app.test_client()
    assert login(c, "ann", "temppass123").status_code == 200
    # the temporary password is replaced, not dropped
    assert c.put("/api/me/password", json={"remove": True}).status_code == 400
    assert c.get("/api/envs").status_code == 403


def test_first_sso_sign_in_also_requires_a_new_password(app, admin, monkeypatch):
    admin.put("/api/settings/auth", json={"oidc_enabled": True,
                                          "oidc": {"issuer": "https://idp.test", "client_id": "abc"}})
    uid = admin.post("/api/users", json={"sso": True, "email": "ben@corp.test", "password": "temppass123"}).get_json()["user"]["id"]

    class IdP:
        def authorize_access_token(self):
            return {"userinfo": {"sub": "ben-1", "email": "ben@corp.test", "email_verified": True, "groups": []}}
    monkeypatch.setattr(auth, "_ensure_oauth", lambda cfg: type("O", (), {"idp": IdP()})())
    c = app.test_client()
    assert c.get("/auth/oidc/callback?code=x&state=y").status_code == 302
    me = c.get("/api/me").get_json()
    assert me["id"] == uid and me["method"] == "oidc" and me["must_change_password"]
    assert c.get("/api/envs").status_code == 403          # nothing until the password is changed
    assert c.put("/api/me/password", json={"remove": True}).status_code == 400
    assert c.put("/api/me/password", json={"password": "bens-own-pw1"}).status_code == 200
    assert c.get("/api/envs").status_code == 200
    # both ways in work afterwards; the temporary one doesn't
    assert login(app.test_client(), "ben", "bens-own-pw1").status_code == 200
    assert login(app.test_client(), "ben", "temppass123").status_code == 401


def test_local_only_people_cannot_drop_their_password(app, admin):
    admin.post("/api/users", json={"username": "loc", "password": "temppass123"})
    c = app.test_client()
    login(c, "loc", "temppass123")
    assert c.put("/api/me/password", json={"remove": True}).status_code == 400


def test_super_admin_is_above_admins(app, admin):
    import perms
    caps = set(admin.get("/api/me").get_json()["caps"])
    assert caps == set(perms.ALL_CAPS) and "system.manage" in caps   # every ability there is
    uid = admin.post("/api/users", json={"username": "adm2", "password": "adm2pass12", "role": "admin",
                                         "must_change": False}).get_json()["user"]["id"]
    me_id = admin.get("/api/me").get_json()["id"]
    a2 = app.test_client()
    login(a2, "adm2", "adm2pass12")
    mine = set(a2.get("/api/me").get_json()["caps"])
    assert "settings.manage" in mine and "system.manage" not in mine
    # owner-level settings are the super admin's
    assert a2.get("/api/settings/integrations").status_code == 403
    assert a2.put("/api/audit/retention", json={"days": 30}).status_code == 403
    assert admin.get("/api/settings/integrations").status_code == 200
    # admins can't touch super admins or make one
    assert a2.put(f"/api/users/{me_id}", json={"display_name": "x"}).status_code == 404
    v = admin.post("/api/users", json={"username": "vic9", "password": "vicpass123", "must_change": False}).get_json()["user"]["id"]
    assert a2.put(f"/api/users/{v}", json={"role": "superadmin"}).status_code == 403
    assert "superadmin" not in a2.get("/api/users").get_json()["assignable_roles"]
    # super admins can, and the last one can't be removed
    assert a2.put(f"/api/users/{me_id}", json={"password": "taken-over-1"}).status_code == 404
    assert next(u for u in a2.get("/api/users").get_json()["users"] if u["id"] == me_id)["manageable"] is False
    # super admins can make another; the last one can't be removed, disabled or demoted
    assert admin.put(f"/api/users/{me_id}", json={"role": "admin"}).status_code == 400
    assert admin.put(f"/api/users/{uid}", json={"role": "superadmin"}).status_code == 200
    assert "system.manage" in a2.get("/api/me").get_json()["caps"]
    assert a2.put(f"/api/users/{me_id}", json={"role": "admin"}).status_code == 200   # two of them now: fine
    assert a2.delete(f"/api/users/{uid}", json={}).status_code == 400              # not yourself
    assert admin.get("/api/settings/integrations").status_code == 403              # demoted to admin


def test_super_admin_role_is_fixed(admin):
    assert admin.put("/api/roles/superadmin", json={"name": "Boss"}).status_code == 400
    assert admin.delete("/api/roles/superadmin", json={}).status_code == 400


def test_merge_a_local_and_an_sso_account(app, admin):
    import auth
    me = admin.get("/api/me").get_json()
    with app.test_request_context():
        cfg = auth.stored_config()
        cfg["oidc"].update(issuer="https://idp", client_id="x")
        db.set_json("auth", cfg)
        sso, _ = auth._oidc_user({"sub": "sam-sso", "preferred_username": "sam.s", "email": "sam@corp.test"})
    fid = None
    with app.test_request_context():
        db.get().execute("INSERT INTO feedback (kind, title, user_id, author, created_at, updated_at) VALUES ('idea','x',?,?,1,1)",
                         (sso["id"], "sam.s"))
        db.get().commit()
    # only super admins merge, and never themselves away
    assert admin.post(f"/api/users/{sso['id']}/merge", json={"from": me["id"]}).status_code == 400
    r = admin.post(f"/api/users/{me['id']}/merge", json={"from": sso["id"]})
    assert r.status_code == 200, r.get_json()
    kept = r.get_json()["user"]
    assert kept["role"] == "superadmin" and kept["sso"] and kept["has_password"] and kept["email"] == "sam@corp.test"
    users = admin.get("/api/users").get_json()["users"]
    assert not any(u["id"] == sso["id"] for u in users)
    with app.test_request_context():
        # the SSO identity now signs into the kept account
        u, err = auth._oidc_user({"sub": "sam-sso", "email": "sam@corp.test"})
        assert u["id"] == me["id"]
        assert db.get().execute("SELECT user_id FROM feedback WHERE title='x'").fetchone()[0] == me["id"]
    # and the password still works
    assert login(app.test_client(), "admin", app.config["ADMIN_PASSWORD"]).status_code == 200


def test_only_super_admins_merge(app, admin):
    from conftest import make_user
    uid, adm = make_user(admin, app, "ada", "admin")
    vid, _ = make_user(admin, app, "vin")
    assert adm.post(f"/api/users/{uid}/merge", json={"from": vid}).status_code == 403
