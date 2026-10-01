"""
The feedback board: bug reports and ideas from the people who use the app.

Everyone with feedback.view sees every item; feedback.submit lets them report, vote and
comment; feedback.manage sets the status and can edit or delete anything. Whoever reported,
voted on or commented on an item follows it: a status change or a new comment by someone else
marks it unseen for them until they open it.
"""

import base64
import json
import os
import re

from flask import jsonify, request, send_from_directory

import auth
import db
import perms

KINDS = ("bug", "idea")
STATUSES = ("open", "planned", "progress", "done", "wontfix")
STATUS_LABEL = {"open": "Open", "planned": "Planned", "progress": "In progress", "done": "Done", "wontfix": "Won't do"}
CLOSED = ("done", "wontfix")
MAX_IMAGE = 750 * 1024
IMAGE_SIGS = {"png": b"\x89PNG\r\n\x1a\n", "jpg": b"\xff\xd8\xff", "webp": b"RIFF"}
IMAGE_MIME = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}
CONTEXT_KEYS = ("version", "page", "env", "browser", "screen", "theme", "view", "url")

# called with (event, item, actor) after a change; integrations hook in here
listeners = []


def _deny(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


def image_dir():
    return os.path.join(db.DATA_DIR, "feedback")


def image_path(item_id):
    for ext in IMAGE_SIGS:
        p = os.path.join(image_dir(), f"{int(item_id)}.{ext}")
        if os.path.isfile(p):
            return p
    return None


def _save_image(item_id, data_url):
    m = re.match(r"^data:image/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$", data_url or "")
    if not m:
        raise ValueError("Send the screenshot as a picture")
    raw = base64.b64decode(m.group(1))
    if len(raw) > MAX_IMAGE:
        raise ValueError("That screenshot is too big")
    ext = next((e for e, sig in IMAGE_SIGS.items() if raw.startswith(sig)), None)
    if ext == "webp" and raw[8:12] != b"WEBP":
        ext = None
    if not ext:
        raise ValueError("Use a PNG, JPEG or WebP picture")
    _drop_image(item_id)
    os.makedirs(image_dir(), exist_ok=True)
    with open(os.path.join(image_dir(), f"{int(item_id)}.{ext}"), "wb") as fh:
        fh.write(raw)


def _drop_image(item_id):
    p = image_path(item_id)
    if p:
        os.remove(p)


def _who(u):
    return u.get("display_name") or u.get("username") or "?"


def _people(ids):
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    rows = db.get().execute(f"SELECT * FROM users WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
    return {r["id"]: {"id": r["id"], "name": r["display_name"] or r["username"], "avatar": auth.avatar_url(r)} for r in rows}


def _person(people, uid, fallback):
    return people.get(uid) or {"id": None, "name": fallback or "someone", "avatar": None}


def _row(item_id):
    return db.get().execute("SELECT * FROM feedback WHERE id=?", (item_id,)).fetchone()


def shape(r, u, people, votes, voted, comments, unseen):
    mine = bool(u.get("id")) and r["user_id"] == u["id"]
    return {
        "id": r["id"], "kind": r["kind"], "title": r["title"], "body": r["body"], "status": r["status"],
        "author": _person(people, r["user_id"], r["author"]), "mine": mine,
        "created_at": r["created_at"], "updated_at": r["updated_at"], "closed_at": r["closed_at"],
        "votes": votes.get(r["id"], 0), "voted": r["id"] in voted, "comments": comments.get(r["id"], 0),
        "unseen": r["id"] in unseen,
        "image": f"/api/feedback/{r['id']}/image?v={r['image']}" if r["image"] else None,
        "request": json.loads(r["request"] or "{}") or None,
        "github_url": r["github_url"] or None,
    }


def items_for(u):
    conn = db.get()
    rows = conn.execute("SELECT * FROM feedback ORDER BY updated_at DESC").fetchall()
    votes = {r[0]: r[1] for r in conn.execute("SELECT item_id, COUNT(*) FROM feedback_votes GROUP BY item_id")}
    comments = {r[0]: r[1] for r in conn.execute(
        "SELECT item_id, COUNT(*) FROM feedback_comments WHERE event='' GROUP BY item_id")}
    uid = u.get("id") or 0
    voted = {r[0] for r in conn.execute("SELECT item_id FROM feedback_votes WHERE user_id=?", (uid,))}
    unseen = {r[0] for r in conn.execute("SELECT item_id FROM feedback_unseen WHERE user_id=?", (uid,))}
    people = _people([r["user_id"] for r in rows])
    return [shape(r, u, people, votes, voted, comments, unseen) for r in rows]


def unseen_count(uid):
    if not uid:
        return 0
    return db.get().execute("SELECT COUNT(*) FROM feedback_unseen WHERE user_id=?", (uid,)).fetchone()[0]


def _followers(item_id):
    conn = db.get()
    r = _row(item_id)
    ids = {r["user_id"]} if r and r["user_id"] else set()
    ids |= {x[0] for x in conn.execute("SELECT user_id FROM feedback_votes WHERE item_id=?", (item_id,))}
    ids |= {x[0] for x in conn.execute("SELECT user_id FROM feedback_comments WHERE item_id=? AND user_id IS NOT NULL",
                                       (item_id,))}
    return ids


def _touch(item_id, actor_id, event=""):
    """Something happened on an item: bump it and tell its followers (not whoever did it)."""
    conn = db.get()
    conn.execute("UPDATE feedback SET updated_at=? WHERE id=?", (db.now(), item_id))
    for uid in _followers(item_id) - {actor_id}:
        conn.execute("INSERT OR IGNORE INTO feedback_unseen (user_id, item_id) VALUES (?,?)", (uid, item_id))


def _emit(event, item_id, u):
    r = _row(item_id)
    for fn in listeners:
        try:
            fn(event, dict(r) if r else {"id": item_id}, u)
        except Exception as e:   # an integration never breaks the board
            print(f"[feedback] {event} listener failed: {e}", flush=True)


def _can_edit(u, r):
    """Managers always; the reporter while it's still open."""
    if perms.has(u, "feedback.manage"):
        return True
    return bool(u.get("id")) and r["user_id"] == u["id"] and r["status"] == "open"


def register(app):

    @app.route("/api/feedback")
    @auth.require("feedback.view")
    def api_feedback():
        u = auth.current()
        return jsonify({"items": items_for(u), "statuses": [{"key": k, "label": STATUS_LABEL[k]} for k in STATUSES],
                        "can": {"submit": perms.has(u, "feedback.submit"), "manage": perms.has(u, "feedback.manage")}})

    @app.route("/api/feedback/<int:item_id>")
    @auth.require("feedback.view")
    def api_feedback_item(item_id):
        u = auth.current()
        r = _row(item_id)
        if not r:
            return _deny("That report is gone", 404)
        conn = db.get()
        if u.get("id"):
            conn.execute("DELETE FROM feedback_unseen WHERE user_id=? AND item_id=?", (u["id"], item_id))
            conn.commit()
        crow = conn.execute("SELECT * FROM feedback_comments WHERE item_id=? ORDER BY created_at, id", (item_id,)).fetchall()
        voters = [x[0] for x in conn.execute("SELECT user_id FROM feedback_votes WHERE item_id=?", (item_id,))]
        people = _people([r["user_id"]] + [c["user_id"] for c in crow] + voters)
        votes = {item_id: len(voters)}
        ncom = {item_id: sum(1 for c in crow if not c["event"])}
        voted = {item_id} if u.get("id") in voters else set()
        out = shape(r, u, people, votes, voted, ncom, set())
        manage = perms.has(u, "feedback.manage")
        out["comments_list"] = [{
            "id": c["id"], "author": _person(people, c["user_id"], c["author"]), "body": c["body"], "event": c["event"],
            "created_at": c["created_at"],
            "can_delete": not c["event"] and (manage or (bool(u.get("id")) and c["user_id"] == u["id"])),
        } for c in crow]
        out["voters"] = [_person(people, v, "")["name"] for v in voters]
        # browser, screen, page: for whoever handles it and the reporter
        out["context"] = json.loads(r["context"] or "{}") if (manage or out["mine"]) else None
        out["can_edit"] = _can_edit(u, r)
        out["can_delete"] = _can_edit(u, r)
        return jsonify(out)

    @app.route("/api/feedback", methods=["POST"])
    @auth.require("feedback.submit")
    def api_feedback_new():
        u = auth.current()
        data = request.get_json(silent=True) or {}
        kind = data.get("kind") if data.get("kind") in KINDS else "bug"
        title = str(data.get("title") or "").strip()[:140]
        body = str(data.get("body") or "").strip()[:8000]
        if not title:
            return _deny("Give it a short title")
        ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
        ctx = {k: str(ctx[k])[:300] for k in CONTEXT_KEYS if ctx.get(k) not in (None, "")}
        t = db.now()
        conn = db.get()
        cur = conn.execute(
            "INSERT INTO feedback (kind, title, body, status, user_id, author, created_at, updated_at, context) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (kind, title, body, "open", u.get("id") or None, _who(u), t, t, json.dumps(ctx)))
        item_id = cur.lastrowid
        if data.get("image"):
            try:
                _save_image(item_id, data["image"])
            except ValueError as e:
                conn.rollback()
                return _deny(str(e))
            conn.execute("UPDATE feedback SET image=? WHERE id=?", (t, item_id))
        if u.get("id"):   # you follow (and back) what you report
            conn.execute("INSERT OR IGNORE INTO feedback_votes (item_id, user_id) VALUES (?,?)", (item_id, u["id"]))
        conn.commit()
        auth.audit("feedback.new", f"#{item_id}", {"kind": kind, "title": title})
        _emit("new", item_id, u)
        return jsonify({"ok": True, "id": item_id})

    @app.route("/api/feedback/<int:item_id>", methods=["PUT"])
    @auth.require("feedback.view")
    def api_feedback_edit(item_id):
        u = auth.current()
        r = _row(item_id)
        if not r:
            return _deny("That report is gone", 404)
        data = request.get_json(silent=True) or {}
        manage = perms.has(u, "feedback.manage")
        conn = db.get()
        sets, event = {}, None
        if "status" in data:
            if not manage:
                return _deny("Only someone who manages feedback can change its status", 403)
            if data["status"] not in STATUSES:
                return _deny("Unknown status")
            if data["status"] != r["status"]:
                sets["status"] = data["status"]
                sets["closed_at"] = db.now() if data["status"] in CLOSED else 0
                event = f"status:{data['status']}"
        edits = {k: data[k] for k in ("title", "body", "kind") if k in data}
        if edits or "image" in data:
            if not _can_edit(u, r):
                return _deny("You can change your report while it's open", 403)
            if "title" in edits:
                t = str(edits["title"] or "").strip()[:140]
                if not t:
                    return _deny("Give it a short title")
                sets["title"] = t
            if "body" in edits:
                sets["body"] = str(edits["body"] or "").strip()[:8000]
            if "kind" in edits and edits["kind"] in KINDS:
                sets["kind"] = edits["kind"]
            if "image" in data:
                if data["image"]:
                    try:
                        _save_image(item_id, data["image"])
                    except ValueError as e:
                        return _deny(str(e))
                    sets["image"] = db.now()
                else:
                    _drop_image(item_id)
                    sets["image"] = 0
        if sets:
            conn.execute(f"UPDATE feedback SET {', '.join(f'{k}=?' for k in sets)} WHERE id=?", (*sets.values(), item_id))
        if event:
            note = str(data.get("note") or "").strip()[:2000]
            conn.execute("INSERT INTO feedback_comments (item_id, user_id, author, body, event, created_at) VALUES (?,?,?,?,?,?)",
                         (item_id, u.get("id") or None, _who(u), note, event, db.now()))
            _touch(item_id, u.get("id"))
        conn.commit()
        if sets:
            auth.audit("feedback.edit", f"#{item_id}", {k: v for k, v in sets.items() if k in ("status", "title", "kind")})
        if event:
            _emit("status", item_id, u)
        return jsonify({"ok": True})

    @app.route("/api/feedback/<int:item_id>", methods=["DELETE"])
    @auth.require("feedback.view")
    def api_feedback_delete(item_id):
        u = auth.current()
        r = _row(item_id)
        if not r:
            return _deny("That report is gone", 404)
        if not _can_edit(u, r):
            return _deny("You can delete your report while it's open", 403)
        conn = db.get()
        conn.execute("DELETE FROM feedback WHERE id=?", (item_id,))
        conn.commit()
        _drop_image(item_id)
        auth.audit("feedback.delete", f"#{item_id}", {"title": r["title"]})
        return jsonify({"ok": True})

    @app.route("/api/feedback/<int:item_id>/vote", methods=["POST"])
    @auth.require("feedback.submit")
    def api_feedback_vote(item_id):
        u = auth.current()
        if not u.get("id"):
            return _deny("Sign in to vote", 403)
        if not _row(item_id):
            return _deny("That report is gone", 404)
        conn = db.get()
        on = bool((request.get_json(silent=True) or {}).get("on", True))
        if on:
            conn.execute("INSERT OR IGNORE INTO feedback_votes (item_id, user_id) VALUES (?,?)", (item_id, u["id"]))
        else:
            conn.execute("DELETE FROM feedback_votes WHERE item_id=? AND user_id=?", (item_id, u["id"]))
        conn.commit()
        n = conn.execute("SELECT COUNT(*) FROM feedback_votes WHERE item_id=?", (item_id,)).fetchone()[0]
        return jsonify({"ok": True, "votes": n, "voted": on})

    @app.route("/api/feedback/<int:item_id>/comments", methods=["POST"])
    @auth.require("feedback.submit")
    def api_feedback_comment(item_id):
        u = auth.current()
        if not _row(item_id):
            return _deny("That report is gone", 404)
        body = str((request.get_json(silent=True) or {}).get("body") or "").strip()[:4000]
        if not body:
            return _deny("Write something first")
        conn = db.get()
        cur = conn.execute("INSERT INTO feedback_comments (item_id, user_id, author, body, created_at) VALUES (?,?,?,?,?)",
                           (item_id, u.get("id") or None, _who(u), body, db.now()))
        _touch(item_id, u.get("id"))
        conn.commit()
        _emit("comment", item_id, {**u, "comment": body})
        return jsonify({"ok": True, "id": cur.lastrowid})

    @app.route("/api/feedback/<int:item_id>/comments/<int:cid>", methods=["DELETE"])
    @auth.require("feedback.view")
    def api_feedback_comment_delete(item_id, cid):
        u = auth.current()
        c = db.get().execute("SELECT * FROM feedback_comments WHERE id=? AND item_id=?", (cid, item_id)).fetchone()
        if not c or c["event"]:
            return _deny("That comment is gone", 404)
        if not (perms.has(u, "feedback.manage") or (u.get("id") and c["user_id"] == u["id"])):
            return _deny("You can only delete your own comments", 403)
        db.get().execute("DELETE FROM feedback_comments WHERE id=?", (cid,))
        db.get().commit()
        return jsonify({"ok": True})

    @app.route("/api/feedback/<int:item_id>/image")
    @auth.require("feedback.view")
    def api_feedback_image(item_id):
        p = image_path(item_id)
        if not p:
            return _deny("No screenshot", 404)
        resp = send_from_directory(os.path.dirname(p), os.path.basename(p), mimetype=IMAGE_MIME[p.rsplit(".", 1)[1]])
        resp.headers["Cache-Control"] = "private, max-age=86400"
        resp.headers["Content-Security-Policy"] = "default-src 'none'"
        return resp
