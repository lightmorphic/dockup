"""Backups: a daily tarball of the stacks folder plus the Dockle database,
kept for a configurable number of days, restorable from the UI, plus a
download-everything zip for portability.
"""

import io
import os
import shutil
import sqlite3
import tarfile
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from . import activity, config, db, settingsvc

bp = Blueprint("backup", __name__, url_prefix="/api/backup")

_last_backup_day = None


def make_backup(reason="scheduled") -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = config.BACKUP_DIR / f"dockle-backup-{stamp}.tar.gz"
    tmp_db = config.DATA_DIR / f".backup-db-{stamp}.sqlite"
    src = db.connect()
    try:
        dst = sqlite3.connect(tmp_db)
        with dst:
            src.backup(dst)
        dst.close()
    finally:
        src.close()
    try:
        with tarfile.open(path, "w:gz") as tar:
            if config.STACKS_DIR.exists():
                tar.add(config.STACKS_DIR, arcname="stacks")
            tar.add(tmp_db, arcname="dockle.db")
    finally:
        tmp_db.unlink(missing_ok=True)
    activity.log("info", "backup", f"Backup made ({reason}): {path.name}")
    return path


def apply_retention(days: int):
    cutoff = time.time() - days * 86400
    for f in config.BACKUP_DIR.glob("dockle-backup-*.tar.gz"):
        if f.stat().st_mtime < cutoff:
            f.unlink()


def restore_backup(filename: str) -> str:
    """Restore stacks (and DB to a side file) from a named backup."""
    path = (config.BACKUP_DIR / filename).resolve()
    if path.parent != config.BACKUP_DIR.resolve() or not path.exists():
        raise ValueError("That backup file doesn't exist")
    staging = config.DATA_DIR / ".restore-staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    with tarfile.open(path, "r:gz") as tar:
        tar.extractall(staging, filter="data")
    restored = staging / "stacks"
    if not restored.exists():
        shutil.rmtree(staging)
        raise ValueError("That archive doesn't look like a Dockle backup")
    # keep the current state to one side so a restore is itself reversible
    undo = config.DATA_DIR / "pre-restore-stacks"
    if undo.exists():
        shutil.rmtree(undo)
    if config.STACKS_DIR.exists():
        shutil.copytree(config.STACKS_DIR, undo)
    for item in config.STACKS_DIR.iterdir():
        shutil.rmtree(item) if item.is_dir() else item.unlink()
    for item in restored.iterdir():
        dest = config.STACKS_DIR / item.name
        shutil.copytree(item, dest) if item.is_dir() else shutil.copy2(item, dest)
    # database from the backup is placed alongside, never swapped live
    db_copy = config.DATA_DIR / f"restored-{filename.replace('.tar.gz', '')}.sqlite"
    shutil.copy2(staging / "dockle.db", db_copy)
    shutil.rmtree(staging)
    activity.log("info", "backup",
                 f"Restored stack files from {filename}",
                 f"The previous stack files were kept at {undo}. "
                 f"The backup's database copy is at {db_copy} if ever needed.")
    return f"Stack files restored from {filename}. The previous files were kept safe in case you change your mind."


def scheduler_loop():
    global _last_backup_day
    while True:
        try:
            now = datetime.now()
            con = db.connect()
            try:
                row = con.execute("SELECT value FROM settings WHERE key='backup.hour'").fetchone()
                hour = int(row[0]) if row and row[0] else 3
                row = con.execute("SELECT value FROM settings WHERE key='backup.retention_days'").fetchone()
                keep = int(row[0]) if row and row[0] else 14
            finally:
                con.close()
            if now.hour == hour and _last_backup_day != now.date():
                _last_backup_day = now.date()
                make_backup("scheduled")
                apply_retention(keep)
        except Exception as exc:
            activity.log("error", "backup", "Scheduled backup failed", str(exc))
        time.sleep(60)


def start_scheduler():
    threading.Thread(target=scheduler_loop, daemon=True).start()


# -- API ----------------------------------------------------------------


@bp.get("/list")
def api_list():
    files = sorted(config.BACKUP_DIR.glob("dockle-backup-*.tar.gz"), reverse=True)
    return jsonify({"backups": [
        {"name": f.name, "size": f.stat().st_size,
         "made": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M")}
        for f in files
    ]})


@bp.post("/run")
def api_run():
    path = make_backup("manual")
    apply_retention(int(settingsvc.get("backup.retention_days") or 14))
    return jsonify({"ok": True, "name": path.name})


@bp.post("/restore")
def api_restore():
    name = request.get_json(force=True).get("name", "")
    try:
        message = restore_backup(name)
    except (ValueError, OSError) as exc:
        activity.log("error", "backup", "Restore failed", str(exc))
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "message": message})


@bp.get("/download/<name>")
def api_download(name):
    path = (config.BACKUP_DIR / name).resolve()
    if path.parent != config.BACKUP_DIR.resolve() or not path.exists():
        return jsonify({"error": "Not found"}), 404
    return send_file(path, as_attachment=True)


@bp.get("/export")
def api_export():
    """Everything as one zip: stacks, database, backups list - full portability."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        if config.STACKS_DIR.exists():
            for root, _dirs, files in os.walk(config.STACKS_DIR):
                for fname in files:
                    full = Path(root) / fname
                    z.write(full, Path("stacks") / full.relative_to(config.STACKS_DIR))
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        tmp_db = config.DATA_DIR / f".export-db-{stamp}.sqlite"
        src = db.connect()
        try:
            dst = sqlite3.connect(tmp_db)
            with dst:
                src.backup(dst)
            dst.close()
        finally:
            src.close()
        z.write(tmp_db, "dockle.db")
        tmp_db.unlink(missing_ok=True)
    buf.seek(0)
    activity.log("info", "backup", "Full export downloaded")
    return send_file(buf, as_attachment=True, download_name="dockle-export.zip",
                     mimetype="application/zip")
