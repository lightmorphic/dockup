from flask import Blueprint, jsonify, render_template, session

from . import activity

bp = Blueprint("views", __name__)


@bp.get("/")
def index():
    return render_template("app.html", csrf=session.get("csrf", ""))


@bp.get("/health")
def health():
    return jsonify({"ok": True})


@bp.get("/favicon.ico")
def favicon():
    from flask import redirect
    return redirect("/static/icons/dockle.svg", code=301)


@bp.get("/api/activity")
def api_activity():
    from flask import request
    errors_only = request.args.get("errors") == "1"
    return jsonify({"entries": activity.recent(200, errors_only)})
