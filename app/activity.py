"""Persistent activity log. Errors are kept, highlighted in the UI, and
optionally emailed - and if email isn't fully set up, the failure to send
is itself recorded so nothing silently looks like it worked.
"""

import smtplib
import ssl
import threading
import time
from email.message import EmailMessage
from email.utils import formatdate

from . import db, settingsvc

_email_lock = threading.Lock()
_last_email_at = 0.0
EMAIL_THROTTLE_SECONDS = 300  # at most one alert email per 5 minutes


def log(level: str, category: str, message: str, detail: str = ""):
    con = db.connect()  # own connection: callable from worker threads
    try:
        with con:
            con.execute(
                "INSERT INTO activity(level, category, message, detail) VALUES(?,?,?,?)",
                (level, category, message, detail or None),
            )
            con.execute(
                "DELETE FROM activity WHERE id NOT IN "
                "(SELECT id FROM activity ORDER BY id DESC LIMIT 5000)"
            )
    finally:
        con.close()
    if level == "error":
        threading.Thread(target=_maybe_email_error, args=(category, message, detail), daemon=True).start()


def recent(limit=200, errors_only=False):
    q = "SELECT id, datetime(ts, 'localtime') AS ts, level, category, message, detail FROM activity"
    if errors_only:
        q += " WHERE level='error'"
    q += " ORDER BY id DESC LIMIT ?"
    return [dict(r) for r in db.get().execute(q, (limit,)).fetchall()]


def _maybe_email_error(category, message, detail):
    global _last_email_at
    try:
        con = db.connect()
        try:
            # read settings on our own connection (no flask context here)
            def s(key):
                default, _sec = settingsvc.SCHEMA[key]
                row = con.execute("SELECT value, encrypted FROM settings WHERE key=?", (key,)).fetchone()
                if row is None or row[0] is None:
                    return default
                from . import crypto
                return crypto.decrypt(row[0]) if row[1] else row[0]

            if s("alerts.on_error") != "1":
                return
            host, sender, to = s("smtp.host"), s("smtp.from"), s("alerts.email_to")
            if not (host and sender and to):
                return  # not configured; the settings screen says so already
            with _email_lock:
                if time.time() - _last_email_at < EMAIL_THROTTLE_SECONDS:
                    return
                _last_email_at = time.time()
            send_email(
                subject=f"Dockle error: {category}",
                body=f"{message}\n\n{detail or ''}\n\n- Dockle",
                override={
                    "smtp.host": host, "smtp.port": s("smtp.port"),
                    "smtp.security": s("smtp.security"), "smtp.username": s("smtp.username"),
                    "smtp.password": s("smtp.password"), "smtp.from": sender,
                    "alerts.email_to": to,
                },
            )
        finally:
            con.close()
    except Exception as exc:  # never let alerting take the app down
        try:
            con = db.connect()
            with con:
                con.execute(
                    "INSERT INTO activity(level, category, message, detail) VALUES(?,?,?,?)",
                    ("warning", "email", "Could not send the error alert email", str(exc)),
                )
            con.close()
        except Exception:
            pass


def send_email(subject: str, body: str, override: dict | None = None):
    """Send via configured SMTP. Raises on failure so callers can report it."""
    s = override if override is not None else settingsvc.get_many(settingsvc.SCHEMA.keys())
    host = s["smtp.host"]
    if not host:
        raise RuntimeError("SMTP is not configured")
    port = int(s["smtp.port"] or 587)
    security = s["smtp.security"]
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = s["smtp.from"]
    msg["To"] = s["alerts.email_to"]
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body)

    ctx = ssl.create_default_context()
    if security == "tls":
        server = smtplib.SMTP_SSL(host, port, timeout=15, context=ctx)
    else:
        server = smtplib.SMTP(host, port, timeout=15)
    try:
        if security == "starttls":
            server.starttls(context=ctx)
        if s["smtp.username"]:
            server.login(s["smtp.username"], s["smtp.password"])
        server.send_message(msg)
    finally:
        server.quit()
