"""Settings screen API: read (masked), save, and test buttons."""

from flask import Blueprint, jsonify, request

from . import activity, runtime, settingsvc

bp = Blueprint("settings_api", __name__, url_prefix="/api/settings")


@bp.get("")
def get_settings():
    view = settingsvc.public_view()
    view["_smtp_ready"] = settingsvc.smtp_configured()
    return jsonify(view)


@bp.post("")
def save_settings():
    data = request.get_json(force=True)
    settingsvc.set_many(data)
    activity.log("info", "settings", "Settings saved")
    return jsonify({"ok": True})


@bp.post("/test-smtp")
def test_smtp():
    try:
        activity.send_email(
            "Dockle test email",
            "This is the test email from Dockle's settings screen. "
            "If you're reading it, email alerts are working.\n\n- Dockle",
        )
    except Exception as exc:
        activity.log("warning", "email", "SMTP test failed", str(exc))
        return jsonify({"error": f"Sending failed: {exc}"}), 400
    activity.log("info", "email", "SMTP test email sent")
    return jsonify({"ok": True, "message": "Test email sent - check the inbox."})


@bp.post("/test-runtime")
def test_runtime():
    data = request.get_json(force=True)
    engine = data.get("engine") or settingsvc.get("runtime.engine")
    socket = data.get("socket") or settingsvc.get("runtime.socket")
    from . import config
    if config.MOCK_MODE:
        return jsonify({"ok": True, "message": "Mock engine responding (dev mode)"})
    result = runtime.Runtime(engine, socket).ping()
    if result["ok"]:
        return jsonify({"ok": True,
                        "message": f"Connected: {result['engine']} {result['version']}"})
    return jsonify({"error": f"Could not reach the engine socket: {result['error']}"}), 400
