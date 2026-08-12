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
        # Most requests are small (JSON, compose text) - 8MB covers those
        # comfortably. Uploading a stack backup with real data needs far
        # more room, handled per-request below rather than raising this
        # globally.
        MAX_CONTENT_LENGTH=8 * 1024 * 1024,
        MAX_FORM_MEMORY_SIZE=8 * 1024 * 1024,
    )

    from . import db
    db.init()
    app.teardown_appcontext(db.close)

    from . import auth, backup, hostagent_api, maintenance, settings_api, stacks, views
    app.register_blueprint(views.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(stacks.bp)
    app.register_blueprint(maintenance.bp)
    app.register_blueprint(settings_api.bp)
    app.register_blueprint(backup.bp)
    app.register_blueprint(hostagent_api.bp)

    from .sockets import sock
    sock.init_app(app)

    PUBLIC = {"auth.login", "auth.setup", "views.health", "views.favicon", "static"}

    @app.before_request
    def raise_limit_for_backup_uploads():
        # Restoring real app data needs far more room than the 8MB
        # default meant for JSON/compose bodies. Scoped to this one
        # endpoint rather than raised globally.
        if request.endpoint == "stacks.api_stack_backup_upload":
            request.max_content_length = 4 * 1024 * 1024 * 1024  # 4GB
            request.max_form_memory_size = 8 * 1024 * 1024

    @app.before_request
    def require_login():
        endpoint = request.endpoint or ""
        if endpoint in PUBLIC or endpoint.startswith("static"):
            return None
        if not session.get("uid"):
            # TEMPORARY diagnostic, round 2: the leftover-Arcane-cookie
            # theory is dead (this reproduced minutes after a full
            # browser "clear site data", so there was no old cookie left
            # to collide with). Logging exactly what came in and why it
            # failed to decode, to catch the next occurrence with real
            # evidence instead of guessing again.
            import sys
            raw_cookie = request.cookies.get("session", "")
            decode_result = "no cookie sent"
            if raw_cookie:
                serializer = app.session_interface.get_signing_serializer(app)
                try:
                    data = serializer.loads(raw_cookie)
                    decode_result = f"decoded OK, keys={list(data.keys())}"
                except Exception as exc:
                    try:
                        _valid, payload = serializer.loads_unsafe(raw_cookie)
                        payload_desc = f"unverified payload={payload!r}" if payload is not None else "payload unreadable too"
                    except Exception as exc2:
                        payload_desc = f"loads_unsafe also failed: {exc2}"
                    decode_result = f"{type(exc).__name__}: {exc} | {payload_desc}"
            print(
                f"[dockle-diag2] no session on {request.method} {request.path} - "
                f"cookie len: {len(raw_cookie)}, decode: {decode_result}, "
                f"origin: {request.headers.get('Origin', '-')}, "
                f"referer: {request.headers.get('Referer', '-')}, "
                f"cookie header raw len: {len(request.headers.get('Cookie', ''))}, "
                f"all cookie names: {list(request.cookies.keys())}, "
                f"UA: {request.headers.get('User-Agent', '?')[:80]}",
                file=sys.stderr, flush=True,
            )
            if request.path.startswith("/api/") or request.path.startswith("/ws/"):
                resp = jsonify({"error": "Not signed in"})
                resp.status_code = 401
            else:
                resp = redirect(url_for("auth.login"))
            if raw_cookie:
                resp.delete_cookie("session", path="/")
            return resp
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

    from . import updatecheck
    updatecheck.start(app)

    return app
