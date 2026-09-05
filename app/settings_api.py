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
    # Test whatever is currently on the settings screen, not just what
    # was last saved - a field typed in but not yet saved should still
    # be what gets tested. Blank fields (in particular the password,
    # left blank on purpose to keep the saved one) fall back to the
    # stored value, same as save_settings treats a blank secret.
    data = request.get_json(force=True) or {}
    keys = ["smtp.host", "smtp.port", "smtp.security", "smtp.username",
            "smtp.password", "smtp.from", "alerts.email_to"]
    override = {k: (data.get(k) or settingsvc.get(k)) for k in keys}
    try:
        activity.send_email(
            "DockUp test email",
            "This is the test email from DockUp's settings screen. "
            "If you're reading it, email alerts are working.\n\n- DockUp",
            override=override,
        )
    except Exception as exc:
        activity.log("warning", "email", "SMTP test failed", str(exc))
        return jsonify({"error": f"Sending failed: {exc}"}), 400
    # A successful test just proved these exact values work - save them
    # so a page refresh doesn't lose what was only ever typed into the
    # form, never pressed "Save settings" for. (set_many already treats
    # a blank/masked secret as "keep what's there", so this can't wipe
    # a real saved password even though override always carries a value.)
    settingsvc.set_many(override)
    activity.log("info", "email", "SMTP test email sent")
    return jsonify({"ok": True, "message": "Test email sent and settings saved - check the inbox."})


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
