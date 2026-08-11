from datetime import timedelta

from flask import Flask, jsonify, redirect, request, session, url_for

from . import config


def create_app():
    config.validate()
    config.ensure_dirs()

    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=config.SECRET_KEY,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        # Off only in mock/dev mode (plain http://localhost). In real use
        # Dockle is only reachable through Tailscale Serve's HTTPS, so the
        # cookie should never go out over plain HTTP.
        SESSION_COOKIE_SECURE=not config.MOCK_MODE,
        PERMANENT_SESSION_LIFETIME=timedelta(days=config.SESSION_DAYS),
        MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    )

    from . import db
    db.init()
    app.teardown_appcontext(db.close)

    from . import auth, backup, maintenance, settings_api, stacks, views
    app.register_blueprint(views.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(stacks.bp)
    app.register_blueprint(maintenance.bp)
    app.register_blueprint(settings_api.bp)
    app.register_blueprint(backup.bp)

    from .sockets import sock
    sock.init_app(app)

    PUBLIC = {"auth.login", "auth.setup", "views.health", "views.favicon", "static"}

    @app.before_request
    def require_login():
        endpoint = request.endpoint or ""
        if endpoint in PUBLIC or endpoint.startswith("static"):
            return None
        if not session.get("uid"):
            if request.path.startswith("/api/") or request.path.startswith("/ws/"):
                return jsonify({"error": "Not signed in"}), 401
            return redirect(url_for("auth.login"))
        # CSRF: state-changing requests must echo the session token
        if request.method in ("POST", "PUT", "DELETE") and not request.path.startswith("/ws/"):
            token = request.headers.get("X-CSRF") or request.form.get("csrf")
            if not token or token != session.get("csrf"):
                return jsonify({"error": "Session expired - reload the page"}), 403
        return None

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; "
            "script-src 'self'; connect-src 'self' ws: wss:; "
            "base-uri 'self'; frame-ancestors 'none'",
        )
        return resp

    # forms on login/setup need a CSRF token too - simple approach:
    # they're rate-limited and create the session, so the standard
    # SameSite=Lax cookie policy covers them.

    from . import backup as backup_mod
    backup_mod.start_scheduler()

    return app
