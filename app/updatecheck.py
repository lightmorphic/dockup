"""Checks every managed, running stack for a newer image every 30
minutes and records the result - never pulls automatically, just flags
it so the dashboard can show an update badge. Applying an update is
still a deliberate click on the stack's own Update button.
"""

import threading
import time

from . import activity, config, db, runtime, stacks

CHECK_INTERVAL_SECONDS = 1800


def check_all():
    stacks_list, _ = stacks.list_stacks()
    rt = runtime.current()
    con = db.connect()
    try:
        for s in stacks_list:
            if not s["managed"] or s["status"] not in ("running", "partial"):
                continue
            try:
                available = rt.check_stack_update(str(stacks.stack_dir(s["name"])), s["name"])
            except runtime.RuntimeError_ as exc:
                activity.log("warning", "update-check", f"Could not check '{s['name']}' for updates", str(exc))
                continue
            with con:
                con.execute(
                    "INSERT INTO stack_updates(name, available, checked_at) VALUES(?,?,datetime('now')) "
                    "ON CONFLICT(name) DO UPDATE SET available=excluded.available, checked_at=excluded.checked_at",
                    (s["name"], 1 if available else 0),
                )
    finally:
        con.close()


def loop(app):
    while True:
        try:
            # list_stacks()/runtime.current() read settings via flask.g,
            # which needs an active app context - there's no request here
            # since this runs on its own background thread.
            with app.app_context():
                check_all()
        except Exception as exc:  # background job - never take the app down
            activity.log("error", "update-check", "Update check pass failed", str(exc))
        time.sleep(CHECK_INTERVAL_SECONDS)


def start(app):
    if config.MOCK_MODE:
        # still useful to see badges in dev, just don't wait 30 minutes
        def _once():
            time.sleep(3)
            with app.app_context():
                check_all()
        threading.Thread(target=_once, daemon=True).start()
        return
    threading.Thread(target=loop, args=(app,), daemon=True).start()


def get_flags() -> dict:
    con = db.get()
    rows = con.execute("SELECT name, available FROM stack_updates").fetchall()
    return {r["name"]: bool(r["available"]) for r in rows}


def clear_flag(name: str):
    """Call after a stack is successfully updated/redeployed, so the
    badge doesn't sit stale until the next 30-minute check."""
    con = db.get()
    with con:
        con.execute(
            "INSERT INTO stack_updates(name, available, checked_at) VALUES(?,0,datetime('now')) "
            "ON CONFLICT(name) DO UPDATE SET available=0, checked_at=excluded.checked_at",
            (name,),
        )
