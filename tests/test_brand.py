import base64

from conftest import make_user

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 64).decode()


def test_stock_brand_is_public(client):
    cfg = client.get("/api/auth/config").get_json()
    assert cfg["brand"]["app_name"] == "VLAN Manager"
    assert cfg["brand"]["logo"]["kind"] == "default"
    page = client.get("/login").get_data(as_text=True)
    assert "window.__brand" in page and "<title>Sign in · VLAN Manager</title>" in page
    assert client.get("/favicon.svg").status_code == 200


def test_admin_renames_and_picks_an_icon(admin, client):
    r = admin.put("/api/settings/brand", json={"app_name": "Casa <Net>", "tagline": "Home lab",
                                               "logo": {"kind": "icon", "icon": "wifi", "palette": "sunset"}})
    assert r.status_code == 200, r.get_json()
    b = r.get_json()["brand"]
    assert b["app_name"] == "Casa <Net>" and b["tagline"] == "Home lab"
    assert b["logo"]["kind"] == "icon" and b["logo"]["colors"][0] == "#f97316"
    # the favicon follows the logo and is drawn on the server
    svg = client.get("/favicon.svg").get_data(as_text=True)
    assert "#f97316" in svg and "<script" not in svg
    page = client.get("/").get_data(as_text=True)
    assert "<title>Casa &lt;Net&gt;</title>" in page and "<Net>" not in page.split("window.__brand")[0]
    assert "\\u003cNet>" in page   # the inline data can't close the script tag
    assert client.get("/manifest.webmanifest").get_json()["name"] == "Casa <Net>"


def test_separate_favicon_with_custom_colors(admin, client):
    r = admin.put("/api/settings/brand", json={"favicon_same": False,
                                               "favicon": {"kind": "icon", "icon": "bolt", "palette": "custom",
                                                           "c1": "#112233", "c2": "#445566", "fg": "#ffeeaa"}})
    assert r.status_code == 200
    assert r.get_json()["brand"]["favicon"]["colors"] == ["#112233", "#445566", "#ffeeaa"]
    assert "#ffeeaa" in client.get("/favicon.svg").get_data(as_text=True)
    assert r.get_json()["brand"]["logo"]["kind"] == "default"


def test_brand_validation(admin):
    for bad in ({"logo": {"kind": "gif"}}, {"logo": {"icon": "nope"}}, {"logo": {"palette": "neon"}},
                {"logo": {"palette": "custom", "c1": "red"}}, {"logo": {"kind": "image"}}):
        assert admin.put("/api/settings/brand", json=bad).status_code == 400, bad


def test_picture_upload(admin, client):
    assert admin.put("/api/settings/brand/image/logo", json={"image": "data:image/svg+xml;base64,"
                     + base64.b64encode(b"<svg onload=alert(1)>").decode()}).status_code == 400
    assert admin.put("/api/settings/brand/image/banner", json={"image": "data:image/png;base64," + PNG}).status_code == 400
    r = admin.put("/api/settings/brand/image/logo", json={"image": "data:image/png;base64," + PNG})
    assert r.status_code == 200
    assert r.get_json()["brand"]["logo"]["kind"] == "default"   # used once saved
    b = admin.put("/api/settings/brand", json={"logo": {"kind": "image"}}).get_json()["brand"]
    src = b["logo"]["src"]
    assert src.startswith("/brand/logo?v=")
    img = client.get(src)   # public: the sign-in page shows it
    assert img.status_code == 200 and img.mimetype == "image/png"
    assert img.headers["Content-Security-Policy"] == "default-src 'none'"
    assert b["favicon"]["src"] == src
    assert client.get("/favicon.svg").status_code == 302
    assert f'rel="icon" href="{src}"' in client.get("/").get_data(as_text=True)


def test_only_admins_change_branding(admin, app):
    _, viewer = make_user(admin, app, "vera")
    assert viewer.get("/api/settings/brand").status_code == 403
    assert viewer.put("/api/settings/brand", json={"app_name": "Mine"}).status_code == 403
    assert viewer.put("/api/settings/brand/image/logo", json={"image": "data:image/png;base64," + PNG}).status_code == 403
